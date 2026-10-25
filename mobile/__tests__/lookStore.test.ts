import { ApiError } from '../src/api/errors';
import type { PiApi } from '../src/api/pi';
import type { ImageInfo, VisionEvent, VisionStyle } from '../src/api/types';
import { createLookStore, type LookStore, type Phase } from '../src/features/look/lookStore';
import type { Photo, SpeechPort } from '../src/features/look/ports';
import type { QueueListener } from '../src/speech/speechQueue';

// ---------- fakes ----------

class FakeSpeech implements SpeechPort {
  spoken: { text: string; tag: number | null }[] = [];
  stops = 0;
  isSpeaking = false;
  listener: QueueListener = {};
  enqueue(text: string, tag: number | null = null) {
    this.spoken.push({ text, tag });
  }
  stop() {
    this.stops++;
  }
  get texts() {
    return this.spoken.map((s) => s.text);
  }
}

type Script = (signal?: AbortSignal) => AsyncGenerator<VisionEvent>;

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const waitAbortable = (promise: Promise<unknown>, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    promise.then(() => resolve(), reject);
  });

const tok = (text: string): VisionEvent => ({ type: 'token', text });
const DONE: VisionEvent = { type: 'done' };
const LOADING: VisionEvent = { type: 'status', state: 'loading' };

/** A script that yields the events, then ends. */
const events = (...evs: VisionEvent[]): Script =>
  async function* () {
    for (const e of evs) {
      await tick();
      yield e;
    }
  };
/** A script that fails before sending anything (an HTTP error such as busy or expired). */
const failing = (err: ApiError): Script =>
  async function* () {
    throw err;
  };
/** A script that yields `first`, then waits for `gate` before yielding `rest` (so a test can act in the middle). */
const gated = (first: VisionEvent[], gate: Promise<void>, rest: VisionEvent[]): Script =>
  async function* (signal) {
    for (const e of first) {
      await tick();
      yield e;
    }
    await waitAbortable(gate, signal);
    for (const e of rest) {
      await tick();
      yield e;
    }
  };

class FakeApi {
  uploads: Uint8Array[] = [];
  asks: { imageId: string; question: string | null; style: VisionStyle }[] = [];
  scripts: Script[] = [];
  uploadError: unknown = null;
  uploadGate: Promise<void> | null = null;
  signals: (AbortSignal | undefined)[] = [];
  private n = 0;

  async putImage(bytes: Uint8Array, _mime?: string, signal?: AbortSignal): Promise<ImageInfo> {
    this.signals.push(signal);
    if (this.uploadGate) await waitAbortable(this.uploadGate, signal);
    if (this.uploadError) throw this.uploadError;
    this.uploads.push(bytes);
    return { imageId: `img${++this.n}`, width: 768, height: 576 };
  }

  async *askVision(req: { imageId: string; question?: string | null; style?: VisionStyle }, signal?: AbortSignal): AsyncGenerator<VisionEvent> {
    this.asks.push({ imageId: req.imageId, question: req.question ?? null, style: req.style ?? 'brief' });
    this.signals.push(signal);
    const script = this.scripts.shift() ?? events(tok('Default answer.'), DONE);
    yield* script(signal);
  }
}

const SENTENCES = 'A red apple sits here. It is on a table.';

function setup(opts: { timing?: object; takePhoto?: () => Promise<Photo> } = {}) {
  const api = new FakeApi();
  const speech = new FakeSpeech();
  const discards: string[] = [];
  let photoNo = 0;
  const feedback = { capture: jest.fn(), success: jest.fn(), failure: jest.fn() };
  const onApiError = jest.fn();
  const takePhoto =
    opts.takePhoto ??
    (async (): Promise<Photo> => {
      const id = `photo${++photoNo}`;
      return { uri: `file:///${id}.jpg`, width: 768, height: 576, bytes: new Uint8Array([1, 2, 3, photoNo]), discard: () => void discards.push(id) };
    });
  const store: LookStore = createLookStore({
    getApi: () => api as unknown as PiApi,
    takePhoto,
    makeSpeech: (listener) => {
      speech.listener = listener;
      return speech;
    },
    feedback,
    onApiError,
    timing: { busyRetryDefaultMs: 5, busyRetryMaxMs: 20, ...opts.timing },
  });
  const phases: Phase[] = [store.getState().phase];
  store.subscribe((s) => {
    if (phases[phases.length - 1] !== s.phase) phases.push(s.phase);
  });
  return { api, speech, store, feedback, onApiError, discards, phases };
}

// ---------- the normal flow ----------

describe('a photo, start to finish', () => {
  it('captures, uploads, streams, speaks each sentence as it completes, and ends answered', async () => {
    const { api, speech, store, feedback, phases } = setup();
    api.scripts.push(events(tok('A red apple '), tok('sits here. It is '), tok('on a table.'), DONE));

    await store.getState().capture();

    const s = store.getState();
    expect(phases).toEqual(['idle', 'capturing', 'uploading', 'looking', 'answered']);
    expect(s.sentences).toEqual(['A red apple sits here.', 'It is on a table.']);
    expect(s.done).toBe(true);
    expect(s.partial).toBe('');
    expect(s.photo).toEqual({ uri: 'file:///photo1.jpg', width: 768, height: 576 });
    expect(speech.spoken).toEqual([
      { text: 'A red apple sits here.', tag: 0 },
      { text: 'It is on a table.', tag: 1 },
    ]);
    expect(api.uploads).toEqual([new Uint8Array([1, 2, 3, 1])]);
    expect(api.asks).toEqual([{ imageId: 'img1', question: null, style: 'brief' }]);
    expect(feedback.capture).toHaveBeenCalledTimes(1);
    expect(feedback.success).toHaveBeenCalledTimes(1);
    expect(feedback.failure).not.toHaveBeenCalled();
  });

  it('starts speaking while the answer is still arriving', async () => {
    const { api, speech, store } = setup();
    let release: () => void = () => {};
    api.scripts.push(gated([tok('First sentence here. Second is ')], new Promise<void>((r) => (release = r)), [tok('coming.'), DONE]));

    const run = store.getState().capture();
    await new Promise((r) => setTimeout(r, 30));

    expect(store.getState().phase).toBe('looking');
    expect(speech.texts).toEqual(['First sentence here.']); // spoken already
    expect(store.getState().partial).toBe('Second is'); // shown, not yet spoken
    release();
    await run;
    expect(speech.texts).toEqual(['First sentence here.', 'Second is coming.']);
  });

  it('says "starting up" once when the model is waking, and shows it', async () => {
    const { api, speech, store } = setup();
    api.scripts.push(events(LOADING, tok('Hello there.'), DONE));
    const seen: boolean[] = [];
    store.subscribe((s) => seen.push(s.waking));
    await store.getState().capture();
    expect(speech.texts).toEqual(['Starting up. This takes a few seconds.', 'Hello there.']);
    expect(seen).toContain(true);
    expect(store.getState().waking).toBe(false); // cleared once words arrive
  });

  it('tracks which sentence is being spoken, and when speech cannot work', async () => {
    const { speech, store } = setup();
    await store.getState().capture();
    speech.listener.onActive?.(0);
    expect(store.getState().speakingIndex).toBe(0);
    speech.listener.onActive?.(null);
    expect(store.getState().speakingIndex).toBeNull();
    speech.listener.onError?.(new Error('no engine'));
    expect(store.getState().speechUnavailable).toBe(true);
  });

  it('a new photo discards the previous one and starts clean', async () => {
    const { store, discards, api } = setup();
    await store.getState().capture();
    await store.getState().capture();
    expect(discards).toEqual(['photo1']);
    expect(store.getState().photo?.uri).toBe('file:///photo2.jpg');
    expect(api.uploads).toHaveLength(2);
    expect(store.getState().sentences).toEqual(['Default answer.']);
  });

  it('ignores the shutter while it is already working (the shutter is Stop then)', async () => {
    const { api, store } = setup();
    api.uploadGate = new Promise(() => {});
    void store.getState().capture();
    await tick();
    await tick();
    expect(store.getState().phase).toBe('uploading');
    await store.getState().capture();
    expect(api.signals).toHaveLength(1);
  });
});

// ---------- waiting cues ----------

describe('cues while waiting', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  /** Start a capture whose upload never finishes, so only the cue timers matter. */
  async function stuck() {
    const ctx = setup();
    ctx.api.uploadGate = new Promise(() => {});
    void ctx.store.getState().capture();
    await jest.advanceTimersByTimeAsync(0);
    return ctx;
  }

  it('says "Looking." once after 1.2 s, and "Still looking." at 12 s and 30 s, showing it on screen', async () => {
    const { speech, store } = await stuck();
    await jest.advanceTimersByTimeAsync(1_199);
    expect(speech.texts).toEqual([]);
    await jest.advanceTimersByTimeAsync(2);
    expect(speech.texts).toEqual(['Looking.']);
    expect(store.getState().slow).toBe(false);
    await jest.advanceTimersByTimeAsync(11_000);
    expect(speech.texts).toEqual(['Looking.', 'Still looking.']);
    expect(store.getState().slow).toBe(true);
    await jest.advanceTimersByTimeAsync(18_000);
    expect(speech.texts).toEqual(['Looking.', 'Still looking.', 'Still looking.']);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(speech.texts).toHaveLength(3); // no more after that
  });

  it('says nothing if the answer arrives first', async () => {
    const { api, speech, store } = setup();
    api.scripts.push(events(tok('Quick answer.'), DONE));
    const run = store.getState().capture();
    await jest.advanceTimersByTimeAsync(10);
    await run;
    await jest.advanceTimersByTimeAsync(60_000);
    expect(speech.texts).toEqual(['Quick answer.']);
  });

  it('stops cueing as soon as words arrive', async () => {
    const { api, speech, store } = setup();
    api.scripts.push(
      (async function* () {
        await new Promise((r) => setTimeout(r, 5_000));
        yield tok('Late but here. ');
        await new Promise((r) => setTimeout(r, 60_000));
        yield DONE;
      }) as Script,
    );
    void store.getState().capture();
    await jest.advanceTimersByTimeAsync(5_100);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(speech.texts.filter((t) => t === 'Still looking.')).toHaveLength(0);
    expect(store.getState().slow).toBe(false);
  });

  it('stops cueing when stopped', async () => {
    const { speech, store } = await stuck();
    store.getState().stop();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(speech.texts).toEqual([]);
  });
});

// ---------- recovery ----------

describe('recovering quietly', () => {
  it('sends the photo again when the Pi has forgotten it, without bothering the user', async () => {
    const { api, speech, store } = setup();
    api.scripts.push(failing(new ApiError('photoExpired')), events(tok('Worked after all.'), DONE));
    await store.getState().capture();
    expect(api.uploads).toHaveLength(2); // uploaded again
    expect(api.asks.map((a) => a.imageId)).toEqual(['img1', 'img2']);
    expect(store.getState().phase).toBe('answered');
    expect(speech.texts).toEqual(['Worked after all.']); // nothing said about it
  });

  it('gives up if it is forgotten twice in a row', async () => {
    const { api, store } = setup();
    api.scripts.push(failing(new ApiError('photoExpired')), failing(new ApiError('photoExpired')));
    await store.getState().capture();
    expect(store.getState().phase).toBe('error');
    expect(store.getState().error?.kind).toBe('photoExpired');
    expect(api.uploads).toHaveLength(2);
  });

  it('waits and retries once when the model is busy, saying "One moment."', async () => {
    const { api, speech, store } = setup();
    api.scripts.push(failing(new ApiError('visionBusy', { retryAfterSeconds: 0.005 })), events(tok('Got it.'), DONE));
    await store.getState().capture();
    expect(api.asks).toHaveLength(2);
    expect(store.getState().phase).toBe('answered');
    expect(speech.texts).toEqual(['One moment.', 'Got it.']);
  });

  it('a busy model twice is reported, not retried forever', async () => {
    const { api, store } = setup();
    api.scripts.push(failing(new ApiError('visionBusy', { retryAfterSeconds: 0 })), failing(new ApiError('visionBusy', { retryAfterSeconds: 0 })));
    await store.getState().capture();
    expect(api.asks).toHaveLength(2);
    expect(store.getState().error?.kind).toBe('visionBusy');
  });

  it('caps a long Retry-After', async () => {
    const { api, store } = setup({ timing: { busyRetryMaxMs: 15 } });
    api.scripts.push(failing(new ApiError('visionBusy', { retryAfterSeconds: 3600 })), events(tok('Done.'), DONE));
    const began = Date.now();
    await store.getState().capture();
    expect(Date.now() - began).toBeLessThan(1_000);
    expect(store.getState().phase).toBe('answered');
  });
});

// ---------- failures ----------

describe('when something goes wrong', () => {
  it('a failed upload is reported, spoken, and nothing is asked', async () => {
    const { api, speech, store, feedback, onApiError } = setup();
    api.uploadError = new ApiError('unreachable');
    await store.getState().capture();
    const s = store.getState();
    expect(s.phase).toBe('error');
    expect(s.error?.kind).toBe('unreachable');
    expect(api.asks).toHaveLength(0);
    expect(speech.texts).toContain("Can't reach your Pi. Is it on, and is this phone on the same Wi-Fi?");
    expect(feedback.failure).toHaveBeenCalledTimes(1);
    expect(onApiError).toHaveBeenCalledWith(expect.objectContaining({ kind: 'unreachable' }));
  });

  it('being removed by the Pi is passed on so the connection can react', async () => {
    const { api, store, onApiError } = setup();
    api.uploadError = new ApiError('unauthorized');
    await store.getState().capture();
    expect(onApiError).toHaveBeenCalledWith(expect.objectContaining({ kind: 'unauthorized' }));
  });

  it('a camera that fails is "I could not take the photo", and nothing is uploaded', async () => {
    const { api, store } = setup({ takePhoto: async () => { throw new Error('camera busy'); } });
    await store.getState().capture();
    expect(store.getState().error?.kind).toBe('camera');
    expect(store.getState().photo).toBeNull();
    expect(api.uploads).toHaveLength(0);
  });

  it('an error inside the stream keeps the words already said, and says what happened', async () => {
    const { api, speech, store } = setup();
    const err: VisionEvent = { type: 'error', code: 'VISION_UNAVAILABLE', message: 'not enough free memory to load the vision model right now' };
    api.scripts.push(events(tok('A red apple. It is '), err));
    await store.getState().capture();
    const s = store.getState();
    expect(s.phase).toBe('error');
    expect(s.error?.kind).toBe('lowMemory');
    expect(s.sentences).toEqual(['A red apple.']); // what was said stays on screen
    expect(speech.texts).toContain('Your Pi is short of memory right now. Try again in a minute.');
  });

  it('a stream that just ends is "cut off", and keeps the text', async () => {
    const { api, store } = setup();
    api.scripts.push(events(tok('Half an ans')));
    await store.getState().capture();
    expect(store.getState().error?.kind).toBe('cutOff');
  });

  it('a Pi that is off for vision gets a clear message', async () => {
    const { api, store } = setup();
    api.scripts.push(failing(new ApiError('visionOff')));
    await store.getState().capture();
    expect(store.getState().error?.userMessage).toBe('Camera description is switched off on your Pi.');
  });

  it('after an error, taking a new photo works', async () => {
    const { api, store } = setup();
    api.uploadError = new ApiError('unreachable');
    await store.getState().capture();
    api.uploadError = null;
    await store.getState().capture();
    expect(store.getState().phase).toBe('answered');
    expect(store.getState().error).toBeNull();
  });
});

// ---------- stop, retake, interrupt ----------

describe('stopping', () => {
  it('Stop mid-answer keeps what was said, cancels the request and the speech, and ignores anything that arrives later', async () => {
    const { api, speech, store } = setup();
    let release: () => void = () => {};
    api.scripts.push(gated([tok('First sentence here. ')], new Promise<void>((r) => (release = r)), [tok('Too late. '), DONE]));
    const run = store.getState().capture();
    await new Promise((r) => setTimeout(r, 30));
    expect(store.getState().sentences).toEqual(['First sentence here.']);

    store.getState().stop();
    release();
    await run;
    await tick();

    const s = store.getState();
    expect(s.phase).toBe('answered');
    expect(s.done).toBe(false);
    expect(s.sentences).toEqual(['First sentence here.']);
    expect(speech.stops).toBeGreaterThan(0);
    expect(api.signals[api.signals.length - 1]?.aborted).toBe(true);
    expect(speech.texts).not.toContain('Too late.');
  });

  it('Stop before any words goes back to the camera and throws the photo away', async () => {
    const { api, store, discards } = setup();
    api.scripts.push(gated([], new Promise(() => {}), []));
    const run = store.getState().capture();
    await new Promise((r) => setTimeout(r, 30));
    store.getState().stop();
    await run;
    expect(store.getState().phase).toBe('idle');
    expect(store.getState().photo).toBeNull();
    expect(discards).toEqual(['photo1']);
  });

  it('Stop during the upload cancels the upload', async () => {
    const { api, store } = setup();
    api.uploadGate = new Promise(() => {});
    const run = store.getState().capture();
    await tick();
    await tick();
    store.getState().stop();
    await run;
    expect(api.signals[0]?.aborted).toBe(true);
    expect(store.getState().phase).toBe('idle');
    expect(api.asks).toHaveLength(0);
  });

  it('Stop when already answered only stops the voice', async () => {
    const { speech, store } = setup();
    await store.getState().capture();
    store.getState().stop();
    expect(speech.stops).toBeGreaterThan(0);
    expect(store.getState().phase).toBe('answered');
    expect(store.getState().sentences).toHaveLength(1);
  });

  it('Retake clears everything, silences the speech and deletes the photo', async () => {
    const { store, speech, discards } = setup();
    await store.getState().setStyle('detailed');
    await store.getState().capture();
    const stopsBefore = speech.stops;
    store.getState().retake();
    const s = store.getState();
    expect(s.phase).toBe('idle');
    expect(s.photo).toBeNull();
    expect(s.sentences).toEqual([]);
    expect(s.style).toBe('detailed'); // the chosen mode is remembered
    expect(speech.stops).toBeGreaterThan(stopsBefore);
    expect(discards).toEqual(['photo1']);
  });

  it('Retake in the middle of a run: nothing from that run appears afterwards', async () => {
    const { api, store } = setup();
    let release: () => void = () => {};
    api.scripts.push(gated([tok('Early words. ')], new Promise<void>((r) => (release = r)), [tok('Late words. '), DONE]));
    const run = store.getState().capture();
    await new Promise((r) => setTimeout(r, 30));
    store.getState().retake();
    release();
    await run;
    await tick();
    expect(store.getState().sentences).toEqual([]);
    expect(store.getState().phase).toBe('idle');
  });

  it('a photo that finishes capturing after Retake is discarded and never uploaded', async () => {
    let finish: (p: Photo) => void = () => {};
    const discards: string[] = [];
    const { api, store } = setup({ takePhoto: () => new Promise<Photo>((r) => (finish = r)) });
    const run = store.getState().capture();
    store.getState().retake();
    finish({ uri: 'late', width: 1, height: 1, bytes: new Uint8Array(1), discard: () => void discards.push('late') });
    await run;
    expect(discards).toEqual(['late']);
    expect(api.uploads).toHaveLength(0);
  });

  it('leaving the app mid-answer stops it, keeps the text, and offers to ask again', async () => {
    const { api, store } = setup();
    api.scripts.push(gated([tok('Some words. ')], new Promise(() => {}), []));
    void store.getState().capture();
    await new Promise((r) => setTimeout(r, 30));
    store.getState().interrupt();
    const s = store.getState();
    expect(s.phase).toBe('answered');
    expect(s.interrupted).toBe(true);
    expect(s.sentences).toEqual(['Some words.']);
  });

  it('leaving the app when nothing is happening changes nothing', async () => {
    const { store } = setup();
    store.getState().interrupt();
    expect(store.getState().phase).toBe('idle');
    expect(store.getState().interrupted).toBe(false);
  });
});

// ---------- modes, follow-ups, replay ----------

describe('asking again about the same photo', () => {
  it('changing the mode with a photo on screen re-asks in the new style, without uploading again', async () => {
    const { api, store } = setup();
    await store.getState().capture();
    api.scripts.push(events(tok('Best before 12/2027.'), DONE));
    await store.getState().setStyle('read_text');
    expect(api.uploads).toHaveLength(1);
    expect(api.asks.map((a) => [a.imageId, a.style])).toEqual([['img1', 'brief'], ['img1', 'read_text']]);
    expect(store.getState().sentences).toEqual(['Best before 12/2027.']);
  });

  it('changing the mode with no photo just remembers it', async () => {
    const { api, store } = setup();
    await store.getState().setStyle('detailed');
    expect(store.getState().style).toBe('detailed');
    expect(api.asks).toHaveLength(0);
  });

  it('the next photo uses the chosen mode', async () => {
    const { api, store } = setup();
    await store.getState().setStyle('read_text');
    await store.getState().capture();
    expect(api.asks[0]?.style).toBe('read_text');
  });

  it('a follow-up question reuses the photo', async () => {
    const { api, store } = setup();
    await store.getState().capture();
    api.scripts.push(events(tok('The label says "Best before 12/2027."'), DONE));
    await store.getState().ask('What does the label say?');
    expect(api.uploads).toHaveLength(1);
    expect(api.asks[1]).toEqual({ imageId: 'img1', question: 'What does the label say?', style: 'brief' });
    expect(store.getState().question).toBe('What does the label say?');
    expect(store.getState().sentences).toEqual(['The label says "Best before 12/2027."']);
  });

  it('a follow-up works even after the Pi forgot the photo (the app still has it)', async () => {
    const { api, store } = setup();
    await store.getState().capture();
    api.scripts.push(failing(new ApiError('photoExpired')), events(tok('Still fine.'), DONE));
    await store.getState().ask('Is it ripe?');
    expect(api.uploads).toHaveLength(2);
    expect(store.getState().phase).toBe('answered');
  });

  it('asking with no photo does nothing', async () => {
    const { api, store } = setup();
    await store.getState().ask('Anything?');
    expect(api.asks).toHaveLength(0);
    expect(store.getState().phase).toBe('idle');
  });

  it('can retry after an error with the same photo', async () => {
    const { api, store } = setup();
    api.scripts.push(failing(new ApiError('modelNotReady')));
    await store.getState().capture();
    expect(store.getState().phase).toBe('error');
    await store.getState().ask(null);
    expect(store.getState().phase).toBe('answered');
    expect(api.uploads).toHaveLength(1);
  });
});

describe('hearing the answer again', () => {
  it('speaks every sentence again with its position, after silencing anything still going', async () => {
    const { api, speech, store } = setup();
    api.scripts.push(events(tok(SENTENCES), DONE));
    await store.getState().capture();
    speech.spoken.length = 0;
    const stops = speech.stops;
    store.getState().hearAgain();
    expect(speech.stops).toBeGreaterThan(stops);
    expect(speech.spoken).toEqual([
      { text: 'A red apple sits here.', tag: 0 },
      { text: 'It is on a table.', tag: 1 },
    ]);
  });

  it('does nothing before there is an answer', async () => {
    const { speech, store } = setup();
    store.getState().hearAgain();
    expect(speech.spoken).toHaveLength(0);
  });
});
