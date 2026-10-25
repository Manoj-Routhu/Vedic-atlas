import { createStore } from 'zustand/vanilla';

import { ApiError, apiErrorFromThrown, apiErrorFromVisionEvent } from '../../api/errors';
import type { VisionStyle } from '../../api/types';
import { SentenceSplitter } from '../../speech/sentences';
import { DEFAULT_TIMING, type LookDeps, type MicProblem, type Photo, type SpeechPort } from './ports';

/** idle: ready. capturing/uploading/looking: working (the shutter becomes Stop). answered: has text (maybe cut short). error: failed. */
export type Phase = 'idle' | 'capturing' | 'uploading' | 'looking' | 'answered' | 'error';

export type LookState = {
  phase: Phase;
  style: VisionStyle;
  photo: { uri: string; width: number; height: number } | null;
  /** The Pi is loading the model (the first photo takes longer). */
  waking: boolean;
  /** No text yet after a long wait. */
  slow: boolean;
  /** Completed sentences, in order (what is spoken and highlighted). */
  sentences: string[];
  /** The unfinished tail of the answer, shown but not yet spoken. */
  partial: string;
  /** Which sentence is being spoken right now. */
  speakingIndex: number | null;
  /** The answer finished normally. */
  done: boolean;
  /** Stopped because the app left the foreground: offer "Ask again". */
  interrupted: boolean;
  question: string | null;
  error: ApiError | null;
  /** The phone could not speak (for example no speech engine): the text is still shown. */
  speechUnavailable: boolean;
  /** The microphone is open (the button is held). */
  listening: boolean;
  /** What was heard so far, shown as the question chip. */
  heard: string;
  /** The mic message can be fixed by downloading the phone's offline speech: show that button. */
  micOffer: boolean;
  /** Why the last question by voice did not work, in plain words. */
  micMessage: string | null;
};

export const MIC_MESSAGES: Record<MicProblem, string> = {
  denied: 'Allow the microphone in Settings to ask questions by voice.',
  unavailable: "This phone can't turn speech into text right now. You can type your question.",
  nothing: "I didn't catch that. Hold the button, speak, then let go.",
  speechPackMissing: "This phone hasn't downloaded its offline English speech yet. Download it once over Wi-Fi. Your voice is never sent anywhere.",
};

export type LookActions = {
  capture(): Promise<void>;
  /** Cancel the request and the speech. Keeps whatever was already said. */
  stop(): void;
  /** Throw the photo and the answer away and go back to the live camera. */
  retake(): void;
  /** Pick Describe / Read text / Detailed. With a photo on screen, asks about it again in the new style. */
  setStyle(style: VisionStyle): Promise<void>;
  /** Ask about the same photo (no new upload). `null` re-describes. */
  ask(question: string | null): Promise<void>;
  hearAgain(): void;
  /** Hear one sentence again (tapping it). */
  hearSentence(index: number): void;
  /** Press and hold: open the microphone for a question about this photo. */
  startListening(): Promise<void>;
  /** Let go: the words heard become the question. */
  finishListening(): void;
  /** Close the microphone without asking. */
  cancelListening(): void;
  /** Download the offline speech language once, after the phone said it is missing. */
  downloadSpeechPack(): Promise<void>;
  /** The app went to the background: stop everything, keep the text, offer "Ask again". */
  interrupt(reason?: string): void;
};

export const isWorking = (phase: Phase) => phase === 'capturing' || phase === 'uploading' || phase === 'looking';

const INITIAL: LookState = {
  phase: 'idle', style: 'brief', photo: null, waking: false, slow: false, sentences: [], partial: '', speakingIndex: null,
  done: false, interrupted: false, question: null, error: null, speechUnavailable: false,
  listening: false, heard: '', micOffer: false, micMessage: null,
};

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done);
  });

export function createLookStore(deps: LookDeps) {
  const timing = { ...DEFAULT_TIMING, ...deps.timing };
  let generation = 0; // every new run bumps it; a run that sees a different number is obsolete and must say nothing more
  let controller: AbortController | null = null;
  let photo: Photo | null = null;
  let imageId: string | null = null;
  let cueTimers: ReturnType<typeof setTimeout>[] = [];
  let spokeWaking = false;
  let speech!: SpeechPort;
  let micRun = 0; // a new press bumps it; late words from an earlier press are ignored

  const store = createStore<LookState & LookActions>((set, get) => {
    const stale = (gen: number) => gen !== generation;
    const hasText = () => get().sentences.length > 0 || get().partial !== '';

    const clearCues = () => {
      cueTimers.forEach(clearTimeout);
      cueTimers = [];
    };

    const startCues = (gen: number) => {
      clearCues();
      cueTimers.push(
        setTimeout(() => {
          if (!stale(gen) && !hasText()) speech.enqueue('Looking.');
        }, timing.lookingCueMs),
      );
      for (const ms of timing.slowCueMs) {
        cueTimers.push(
          setTimeout(() => {
            if (stale(gen) || hasText()) return;
            set({ slow: true });
            speech.enqueue('Still looking.');
          }, ms),
        );
      }
    };

    const discardPhoto = () => {
      photo?.discard();
      photo = null;
      imageId = null;
    };

    const addSentence = (text: string) => {
      const index = get().sentences.length;
      set({ sentences: [...get().sentences, text] });
      speech.enqueue(text, index);
    };

    const finish = () => {
      clearCues();
      set({ phase: 'answered', done: true, partial: '', waking: false, slow: false });
      deps.feedback.success();
    };

    const fail = (err: ApiError, gen: number) => {
      if (stale(gen) || err.kind === 'cancelled') return;
      clearCues();
      deps.onApiError?.(err);
      speech.stop();
      set({ phase: 'error', error: err, waking: false, slow: false });
      speech.enqueue(err.userMessage); // the failure is spoken too: the user may not be looking at the screen
      deps.feedback.failure();
    };

    const resetAnswer = (patch: Partial<LookState> = {}) =>
      set({ sentences: [], partial: '', speakingIndex: null, done: false, interrupted: false, error: null, waking: false, slow: false, question: null, ...patch });

    /** Stream the answer for the uploaded photo, recovering from an expired photo and from a busy model. */
    async function streamAnswer(question: string | null, gen: number, ctl: AbortController) {
      const api = deps.getApi();
      if (!api) return fail(new ApiError('unreachable'), gen);
      const splitter = new SentenceSplitter();
      let reuploaded = false;
      let busyRetried = false;
      resetAnswer({ phase: 'looking', question });

      for (;;) {
        try {
          for await (const ev of api.askVision({ imageId: imageId as string, question, style: get().style }, ctl.signal)) {
            if (stale(gen)) return;
            if (ev.type === 'status') {
              if (ev.state === 'loading') {
                set({ waking: true });
                if (!spokeWaking) {
                  spokeWaking = true;
                  speech.enqueue('Starting up. This takes a few seconds.');
                }
              }
            } else if (ev.type === 'token') {
              if (!hasText()) {
                clearCues();
                set({ waking: false, slow: false });
              }
              for (const sentence of splitter.push(ev.text)) addSentence(sentence);
              set({ partial: splitter.pending });
            } else if (ev.type === 'done') {
              for (const sentence of splitter.flush()) addSentence(sentence);
              return finish();
            } else {
              return fail(apiErrorFromVisionEvent(ev.code, ev.message), gen);
            }
          }
          if (stale(gen)) return;
          return fail(new ApiError('cutOff'), gen); // the stream ended with neither "done" nor an error
        } catch (e) {
          if (stale(gen)) return;
          const err = apiErrorFromThrown(e);

          if (err.kind === 'photoExpired' && !reuploaded && photo) {
            reuploaded = true; // the Pi forgot the photo (it keeps them 5 minutes): send it again, silently
            try {
              imageId = (await api.putImage(photo.bytes, 'image/jpeg', ctl.signal)).imageId;
            } catch (e2) {
              return fail(apiErrorFromThrown(e2), gen);
            }
            if (stale(gen)) return;
            continue;
          }
          if (err.kind === 'visionBusy' && !busyRetried) {
            busyRetried = true;
            speech.enqueue('One moment.');
            const wait = err.retryAfterSeconds !== undefined ? err.retryAfterSeconds * 1000 : timing.busyRetryDefaultMs;
            await sleep(Math.min(wait, timing.busyRetryMaxMs), ctl.signal);
            if (stale(gen)) return;
            continue;
          }
          return fail(err, gen);
        }
      }
    }

    /** Upload the photo if the Pi does not have it yet, then stream an answer. */
    async function run(question: string | null, gen: number, ctl: AbortController) {
      if (!photo) return;
      startCues(gen);
      if (!imageId) {
        set({ phase: 'uploading' });
        const api = deps.getApi();
        if (!api) return fail(new ApiError('unreachable'), gen);
        try {
          const info = await api.putImage(photo.bytes, 'image/jpeg', ctl.signal);
          if (stale(gen)) return;
          imageId = info.imageId;
        } catch (e) {
          return fail(apiErrorFromThrown(e), gen);
        }
      }
      await streamAnswer(question, gen, ctl);
    }

    /** Begin a new run: obsolete any earlier one, silence it, and hand back this run's id and cancel switch. */
    const closeMic = () => {
      if (!get().listening && !deps.recognizer) return;
      micRun++;
      if (get().listening) deps.recognizer?.cancel();
      set({ listening: false, heard: '' });
    };

    const begin = () => {
      closeMic();
      generation++;
      controller?.abort();
      speech.stop();
      clearCues();
      controller = new AbortController();
      return { gen: generation, ctl: controller };
    };

    return {
      ...INITIAL,

      async capture() {
        if (isWorking(get().phase)) return; // the shutter is "Stop" while working
        const { gen, ctl } = begin();
        discardPhoto();
        spokeWaking = false;
        resetAnswer({ phase: 'capturing', photo: null });
        deps.feedback.capture();
        let taken: Photo;
        try {
          taken = await deps.takePhoto();
        } catch {
          return fail(new ApiError('camera'), gen);
        }
        if (stale(gen)) {
          taken.discard();
          return;
        }
        photo = taken;
        set({ photo: { uri: taken.uri, width: taken.width, height: taken.height } });
        await run(null, gen, ctl);
      },

      stop() {
        closeMic();
        if (!isWorking(get().phase)) {
          speech.stop(); // already answered: just stop talking
          return;
        }
        generation++;
        controller?.abort();
        controller = null;
        clearCues();
        speech.stop();
        const s = get();
        if (s.sentences.length > 0 || s.partial !== '') {
          set({ phase: 'answered', done: false, waking: false, slow: false }); // keep what was said so far
        } else {
          discardPhoto();
          set({ ...INITIAL, style: s.style, speechUnavailable: s.speechUnavailable });
        }
      },

      retake() {
        closeMic();
        generation++;
        controller?.abort();
        controller = null;
        clearCues();
        speech.stop();
        discardPhoto();
        spokeWaking = false;
        set({ ...INITIAL, style: get().style, speechUnavailable: get().speechUnavailable });
      },

      async setStyle(style) {
        set({ style });
        const { phase } = get();
        if (photo && (phase === 'answered' || phase === 'error')) await get().ask(null);
      },

      async ask(question) {
        if (!photo || isWorking(get().phase)) return;
        const { gen, ctl } = begin();
        await run(question, gen, ctl);
      },

      hearAgain() {
        const s = get();
        if (s.phase !== 'answered') return;
        speech.stop();
        s.sentences.forEach((text, i) => speech.enqueue(text, i));
        if (s.partial) speech.enqueue(s.partial, s.sentences.length);
      },

      hearSentence(index) {
        const text = get().sentences[index];
        if (text === undefined || get().phase === 'capturing' || get().phase === 'uploading') return;
        speech.stop();
        speech.enqueue(text, index);
      },

      async startListening() {
        const recognizer = deps.recognizer;
        if (!recognizer || !photo || isWorking(get().phase) || get().listening) return;
        speech.stop(); // so the phone never hears its own voice
        const run = ++micRun;
        set({ listening: true, heard: '', micMessage: null, micOffer: false });
        const current = () => run === micRun;
        await recognizer.start({
          onPartial: (text) => current() && set({ heard: text }),
          onFinal: (text) => {
            if (!current()) return;
            const question = text.trim();
            set({ listening: false, heard: question });
            if (question === '') set({ micMessage: MIC_MESSAGES.nothing });
            else void get().ask(question);
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

      async downloadSpeechPack() {
        const download = deps.recognizer?.downloadSpeechPack;
        if (!download) return;
        set({ micOffer: false, micMessage: 'Asking your phone to download offline English speech…' });
        try {
          const result = await download.call(deps.recognizer);
          set({
            micMessage:
              result === 'ready'
                ? 'Downloaded. Tap the microphone and ask your question.'
                : result === 'scheduled'
                  ? 'The download will finish on Wi-Fi. Try the microphone again in a minute.'
                  : "Follow your phone's download prompt, then try the microphone again.",
          });
        } catch {
          set({ micMessage: 'Your phone would not start the download. Open the Google app, then Settings, Voice, Offline speech recognition, and download English (US).', micOffer: true });
        }
      },

      cancelListening() {
        closeMic();
      },

      interrupt(reason) {
        const wasListening = get().listening;
        closeMic();
        if (wasListening && reason) set({ micMessage: `The microphone was closed: ${reason}.` });
        if (!isWorking(get().phase)) {
          speech.stop();
          return;
        }
        get().stop();
        if (get().phase === 'answered') set({ interrupted: true });
      },
    };
  });

  speech = deps.makeSpeech({
    onActive: (tag) => store.setState({ speakingIndex: tag }),
    onError: () => store.setState({ speechUnavailable: true }),
  });

  return store;
}

export type LookStore = ReturnType<typeof createLookStore>;
