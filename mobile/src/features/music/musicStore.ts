import { createStore } from 'zustand/vanilla';

import { ApiError, apiErrorFromThrown } from '../../api/errors';
import type { PiApi } from '../../api/pi';
import type { MusicInfo } from '../../api/types';
import { MIC_MESSAGES } from '../look/lookStore';
import type { Recognizer } from '../look/ports';

export type MusicDeps = {
  getApi: () => PiApi | null;
  /** Turns the spoken song name into text. Without one the microphone is simply not offered. */
  recognizer?: Recognizer;
  /** Told about every failure so the connection can react (a removed phone, an unreachable Pi). */
  onApiError?: (e: ApiError) => void;
  now?: () => number;
  /** How often to ask the Pi what the music is doing while the screen is open. */
  refreshMs?: number;
};

export type MusicStoreState = {
  /** What the Pi last said. null until the first answer. */
  info: MusicInfo | null;
  /** When `info` arrived (ms), so the elapsed time can keep counting between answers. */
  syncedAt: number;
  /** The first answer has not arrived yet. */
  loading: boolean;
  /** The words being searched for while the request is out; null otherwise. */
  asking: string | null;
  /** A pause, resume or stop is on its way. */
  busy: boolean;
  /** The last thing the user asked for that did not work. */
  error: ApiError | null;
  /** The microphone is open. */
  listening: boolean;
  heard: string;
  micMessage: string | null;
  micOffer: boolean;
};

export type MusicActions = {
  refresh(): Promise<void>;
  startPolling(): void;
  stopPolling(): void;
  /** Find the song and queue it on the Pi. */
  play(query: string): Promise<void>;
  /** Give up on a song that is still being found or has not started. */
  cancelAsk(): void;
  stop(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  dismissError(): void;
  startListening(): Promise<void>;
  finishListening(): void;
  cancelListening(): void;
  downloadSpeechPack(): Promise<void>;
  /** The screen or app was left: close the microphone, saying why if it was open. */
  interrupt(reason?: string): void;
  reset(): void;
};

const INITIAL: MusicStoreState = {
  info: null, syncedAt: 0, loading: true, asking: null, busy: false, error: null,
  listening: false, heard: '', micMessage: null, micOffer: false,
};

/** Seconds played so far, counting on from the last answer while the song is playing. */
export function elapsedNow(s: Pick<MusicStoreState, 'info' | 'syncedAt'>, now: number): number | null {
  const info = s.info;
  if (!info || info.elapsedS === null) return null;
  if (info.state !== 'playing') return info.elapsedS;
  return info.elapsedS + Math.max(0, now - s.syncedAt) / 1000;
}

export function createMusicStore(deps: MusicDeps) {
  const now = deps.now ?? Date.now;
  const refreshMs = deps.refreshMs ?? 2_000;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let polling = false;
  let run = 0; // a new play (or a cancel) bumps it, so a late answer for an older ask is recognised
  let micRun = 0; // a new press bumps it; late words from an earlier press are ignored

  return createStore<MusicStoreState & MusicActions>((set, get) => {
    const report = (e: unknown): ApiError => {
      const err = apiErrorFromThrown(e);
      if (err.kind !== 'cancelled') deps.onApiError?.(err);
      return err;
    };

    const learn = (info: MusicInfo) => set({ info, syncedAt: now(), loading: false });

    async function refresh() {
      const api = deps.getApi();
      if (!api) return;
      try {
        learn(await api.musicStatus());
      } catch (e) {
        report(e); // a dead link or a removed phone is handled by the connection; what is on screen stays as it was
        set({ loading: false });
      }
    }

    const schedule = () => {
      if (!polling) return;
      pollTimer = setTimeout(async () => {
        await refresh();
        schedule();
      }, refreshMs);
    };

    /** A command that changes the music: send it, show the Pi's answer, and put any failure into words. */
    async function command(send: (api: PiApi) => Promise<MusicInfo>) {
      const api = deps.getApi();
      if (!api || get().busy) return;
      set({ busy: true, error: null });
      try {
        learn(await send(api));
      } catch (e) {
        const err = report(e);
        if (err.kind !== 'cancelled') set({ error: err });
        await refresh(); // e.g. "nothing is playing": the song ended a moment ago
      } finally {
        set({ busy: false });
      }
    }

    const closeMic = () => {
      if (!get().listening) return;
      micRun++;
      deps.recognizer?.cancel();
      set({ listening: false, heard: '' });
    };

    return {
      ...INITIAL,

      refresh,

      startPolling() {
        if (polling) return;
        polling = true;
        void refresh().then(schedule);
      },

      stopPolling() {
        polling = false;
        if (pollTimer) clearTimeout(pollTimer);
        pollTimer = null;
      },

      async play(query) {
        const words = query.trim();
        const api = deps.getApi();
        if (!words || get().asking !== null) return;
        const mine = ++run;
        if (!api) {
          set({ error: new ApiError('unreachable') });
          return;
        }
        set({ asking: words, error: null });
        try {
          const info = await api.playSong(words);
          if (mine !== run) {
            // cancelled while the Pi was still searching: the song is queued now, so take it back
            await api.stopMusic().catch(() => undefined);
            return;
          }
          learn(info);
        } catch (e) {
          if (mine !== run) return;
          const err = report(e);
          if (err.kind !== 'cancelled') set({ error: err });
        } finally {
          if (mine === run) set({ asking: null });
        }
      },

      cancelAsk() {
        run++;
        set({ asking: null });
        if (get().info?.state === 'starting') void get().stop();
      },

      stop: () => command((api) => api.stopMusic()),
      pause: () => command((api) => api.pauseMusic()),
      resume: () => command((api) => api.resumeMusic()),

      dismissError() {
        set({ error: null });
      },

      async startListening() {
        const recognizer = deps.recognizer;
        if (!recognizer || get().asking !== null || get().listening) return;
        const run_ = ++micRun;
        set({ listening: true, heard: '', micMessage: null, micOffer: false });
        const current = () => run_ === micRun;
        await recognizer.start({
          onPartial: (text) => current() && set({ heard: text }),
          onFinal: (text) => {
            if (!current()) return;
            const name = text.trim();
            set({ listening: false, heard: '' });
            if (name === '') set({ micMessage: MIC_MESSAGES.nothing });
            else void get().play(name);
          },
          onError: (problem, detail) => {
            if (!current()) return;
            const why = detail && problem !== 'speechPackMissing' ? ` (${detail})` : '';
            set({ listening: false, heard: '', micMessage: MIC_MESSAGES[problem] + why, micOffer: problem === 'speechPackMissing' && Boolean(deps.recognizer?.downloadSpeechPack) });
          },
        });
      },

      finishListening() {
        if (get().listening) deps.recognizer?.stop();
      },

      cancelListening() {
        closeMic();
      },

      async downloadSpeechPack() {
        const download = deps.recognizer?.downloadSpeechPack;
        if (!download) return;
        set({ micOffer: false, micMessage: 'Asking your phone to download offline English speech…' });
        try {
          const result = await download.call(deps.recognizer);
          set({
            micMessage:
              result === 'ready'
                ? 'Downloaded. Tap the microphone and say the song.'
                : result === 'scheduled'
                  ? 'The download will finish on Wi-Fi. Try the microphone again in a minute.'
                  : "Follow your phone's download prompt, then try the microphone again.",
          });
        } catch {
          set({ micMessage: 'Your phone would not start the download. Open the Google app, then Settings, Voice, Offline speech recognition, and download English (US).', micOffer: true });
        }
      },

      interrupt(reason) {
        const wasListening = get().listening;
        closeMic();
        if (wasListening && reason) set({ micMessage: `The microphone was closed: ${reason}.` });
      },

      reset() {
        get().stopPolling();
        closeMic();
        run++;
        set({ ...INITIAL });
      },
    };
  });
}

export type MusicStore = ReturnType<typeof createMusicStore>;
