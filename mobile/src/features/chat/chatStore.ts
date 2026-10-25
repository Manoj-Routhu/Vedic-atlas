import { createStore } from 'zustand/vanilla';

import { ApiError, apiErrorFromThrown } from '../../api/errors';
import type { PendingApproval } from '../../api/types';
import { SentenceSplitter } from '../../speech/sentences';
import type { SpeechPort } from '../look/ports';
import type { ChatDeps } from './ports';
import { DEFAULT_CHAT_TIMING } from './ports';

export type ChatMessage = {
  id: number;
  role: 'user' | 'veda';
  text: string;
  /** Veda is still writing this reply. */
  streaming: boolean;
  /** The reply could not be completed; the text is what arrived before it failed. */
  failed: boolean;
};

export type ChatState = {
  messages: ChatMessage[];
  /** A message is being answered. */
  busy: boolean;
  /** The Pi has auto-approve on, so it refuses phone chat. */
  paused: boolean;
  error: ApiError | null;
  /** Speak replies aloud. */
  speak: boolean;
  approvals: PendingApproval[];
  /** An approval is being sent. */
  deciding: string | null;
};

export type ChatActions = {
  send(text: string): Promise<void>;
  /** Stop waiting for the reply, keeping what has arrived. */
  stop(): void;
  setSpeak(on: boolean): void;
  refreshApprovals(): Promise<void>;
  approve(requestId: string): Promise<void>;
  deny(requestId: string): Promise<void>;
  /** Start checking for approvals (while the chat screen is in front). */
  startPolling(): void;
  stopPolling(): void;
  /** Forget the conversation on screen and silence the voice (the Pi keeps its own history). */
  reset(): void;
};

const INITIAL: ChatState = { messages: [], busy: false, paused: false, error: null, speak: false, approvals: [], deciding: null };

export function createChatStore(deps: ChatDeps) {
  const timing = { ...DEFAULT_CHAT_TIMING, ...deps.timing };
  let controller: AbortController | null = null;
  let generation = 0;
  let nextId = 1;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let polling = false;
  let announced = new Set<string>();
  let speech: SpeechPort | null = null;
  const getSpeech = () => (speech ??= deps.makeSpeech());

  return createStore<ChatState & ChatActions>((set, get) => {
    const patchMessage = (id: number, patch: Partial<ChatMessage>) =>
      set({ messages: get().messages.map((m) => (m.id === id ? { ...m, ...patch } : m)) });

    const report = (e: unknown): ApiError => {
      const err = apiErrorFromThrown(e);
      if (err.kind !== 'cancelled') deps.onApiError?.(err);
      return err;
    };

    async function checkApprovals() {
      const api = deps.getApi();
      if (!api) return;
      try {
        const pending = await api.pendingApprovals();
        const fresh = pending.filter((p) => !announced.has(p.requestId));
        fresh.forEach((p) => announced.add(p.requestId));
        set({ approvals: pending });
        if (fresh.length > 0) deps.notify?.(fresh);
      } catch (e) {
        report(e); // a dead link or a removed phone is handled by the connection; the banner just stays as it was
      }
    }

    const schedule = () => {
      if (!polling) return;
      pollTimer = setTimeout(async () => {
        await checkApprovals();
        schedule();
      }, get().busy ? timing.pollBusyMs : timing.pollIdleMs);
    };

    return {
      ...INITIAL,

      async send(text) {
        const message = text.trim();
        if (!message || get().busy) return;
        const api = deps.getApi();
        const gen = ++generation;
        controller?.abort();
        const ctl = (controller = new AbortController());
        const replyId = nextId + 1;
        set({
          messages: [
            ...get().messages,
            { id: nextId, role: 'user', text: message, streaming: false, failed: false },
            { id: replyId, role: 'veda', text: '', streaming: true, failed: false },
          ],
          busy: true,
          error: null,
          paused: false,
        });
        nextId += 2;
        if (get().speak) getSpeech().stop();

        const splitter = new SentenceSplitter();
        const say = (sentences: string[]) => get().speak && sentences.forEach((s) => getSpeech().enqueue(s));
        const stale = () => gen !== generation;

        if (!api) {
          patchMessage(replyId, { streaming: false, failed: true });
          set({ busy: false, error: new ApiError('unreachable') });
          return;
        }
        try {
          let text = '';
          for await (const ev of api.chatStream(message, ctl.signal)) {
            if (stale()) return;
            if (ev.type === 'text') {
              text += ev.text;
              patchMessage(replyId, { text });
              say(splitter.push(ev.text));
            } else {
              break;
            }
          }
          if (stale()) return;
          say(splitter.flush());
          patchMessage(replyId, { streaming: false });
          set({ busy: false });
        } catch (e) {
          if (stale()) return;
          const err = report(e);
          if (err.kind === 'cancelled') return;
          const partial = get().messages.find((m) => m.id === replyId)?.text ?? '';
          if (err.kind === 'autoApproveOn') {
            // the Pi refused the whole message: take it back out and explain, instead of leaving an empty reply
            set({ messages: get().messages.filter((m) => m.id !== replyId && m.id !== replyId - 1), paused: true, busy: false, error: err });
            return;
          }
          if (partial === '') patchMessage(replyId, { text: err.userMessage, streaming: false, failed: true });
          else patchMessage(replyId, { streaming: false, failed: true });
          set({ busy: false, error: err });
        }
      },

      stop() {
        if (!get().busy) {
          speech?.stop();
          return;
        }
        generation++;
        controller?.abort();
        controller = null;
        speech?.stop();
        set({ messages: get().messages.map((m) => (m.streaming ? { ...m, streaming: false } : m)), busy: false });
      },

      setSpeak(on) {
        set({ speak: on });
        if (!on) speech?.stop();
      },

      refreshApprovals: checkApprovals,

      async approve(requestId) {
        await decide(requestId, 'approve');
      },
      async deny(requestId) {
        await decide(requestId, 'deny');
      },

      startPolling() {
        if (polling) return;
        polling = true;
        void checkApprovals().then(schedule);
      },

      stopPolling() {
        polling = false;
        if (pollTimer) clearTimeout(pollTimer);
        pollTimer = null;
      },

      reset() {
        generation++;
        controller?.abort();
        controller = null;
        speech?.stop();
        announced = new Set();
        set({ ...INITIAL, speak: get().speak });
      },
    };

    async function decide(requestId: string, action: 'approve' | 'deny') {
      const api = deps.getApi();
      if (!api || get().deciding) return;
      set({ deciding: requestId, error: null });
      try {
        if (action === 'approve') await api.approve(requestId);
        else await api.deny(requestId);
        set({ approvals: get().approvals.filter((a) => a.requestId !== requestId) });
      } catch (e) {
        const err = report(e);
        if (err.kind !== 'cancelled') set({ error: err });
        await checkApprovals(); // it may have been decided already, on the Pi or by another phone
      } finally {
        set({ deciding: null });
      }
    }
  });
}

export type ChatStore = ReturnType<typeof createChatStore>;
