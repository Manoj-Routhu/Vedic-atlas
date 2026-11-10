import { ApiError } from '../src/api/errors';
import type { PiApi } from '../src/api/pi';
import type { MusicInfo } from '../src/api/types';
import type { Recognizer, RecognizerListener } from '../src/features/look/ports';
import { MIC_MESSAGES } from '../src/features/look/lookStore';
import { createMusicStore, elapsedNow } from '../src/features/music/musicStore';

const info = (patch: Partial<MusicInfo> = {}): MusicInfo => ({
  available: true, reason: null, state: 'idle', title: null, elapsedS: null, limitS: null, durationS: null, seekable: false, ...patch,
});
const playing = (patch: Partial<MusicInfo> = {}) => info({ state: 'playing', title: 'Tum Hi Ho - Arijit Singh', elapsedS: 10, limitS: 300, durationS: 262, ...patch });

class FakeApi {
  status = info();
  calls: string[] = [];
  playGate: Promise<void> | null = null;
  failWith: ApiError | null = null;

  async musicStatus() {
    this.calls.push('status');
    return this.status;
  }
  async playSong(query: string) {
    this.calls.push(`play:${query}`);
    if (this.playGate) await this.playGate;
    if (this.failWith) throw this.failWith;
    this.status = info({ state: 'starting', title: 'Tum Hi Ho - Arijit Singh', limitS: 300 });
    return this.status;
  }
  async stopMusic() {
    this.calls.push('stop');
    this.status = info();
    return this.status;
  }
  async pauseMusic() {
    this.calls.push('pause');
    if (this.failWith) throw this.failWith;
    this.status = { ...this.status, state: 'paused' };
    return this.status;
  }
  async resumeMusic() {
    this.calls.push('resume');
    this.status = { ...this.status, state: 'playing' };
    return this.status;
  }
  seeks: number[] = [];
  seekGate: Promise<void> | null = null;
  async seekMusic(positionS: number) {
    this.calls.push(`seek:${positionS}`);
    this.seeks.push(positionS);
    if (this.seekGate) await this.seekGate;
    if (this.failWith) throw this.failWith;
    this.status = { ...this.status, elapsedS: positionS };
    return this.status;
  }
}

class FakeRecognizer implements Recognizer {
  listener: RecognizerListener | null = null;
  stops = 0;
  cancels = 0;
  downloads = 0;
  async start(l: RecognizerListener) {
    this.listener = l;
  }
  stop() {
    this.stops++;
  }
  cancel() {
    this.cancels++;
  }
  async downloadSpeechPack() {
    this.downloads++;
    return 'ready' as const;
  }
}

function setup(opts: { now?: () => number } = {}) {
  const api = new FakeApi();
  const recognizer = new FakeRecognizer();
  const errors: ApiError[] = [];
  const store = createMusicStore({ getApi: () => api as unknown as PiApi, recognizer, onApiError: (e) => errors.push(e), refreshMs: 20, now: opts.now, skipMergeMs: 30 });
  return { api, recognizer, store, errors };
}

describe('what the Pi says', () => {
  it('refresh shows the Pi\'s answer and ends the first loading', async () => {
    const { store, api } = setup();
    expect(store.getState().loading).toBe(true);
    api.status = playing();
    await store.getState().refresh();
    expect(store.getState().info?.title).toBe('Tum Hi Ho - Arijit Singh');
    expect(store.getState().loading).toBe(false);
  });

  it('a Pi that does not answer leaves what was on screen and tells the connection', async () => {
    const { store, api, errors } = setup();
    api.status = playing();
    await store.getState().refresh();
    api.musicStatus = async () => {
      throw new ApiError('unreachable');
    };
    await store.getState().refresh();
    expect(store.getState().info?.state).toBe('playing');
    expect(errors.map((e) => e.kind)).toEqual(['unreachable']);
  });

  it('polling asks again and again until it is stopped', async () => {
    const { store, api } = setup();
    store.getState().startPolling();
    await new Promise((r) => setTimeout(r, 90));
    store.getState().stopPolling();
    const n = api.calls.filter((c) => c === 'status').length;
    expect(n).toBeGreaterThanOrEqual(3);
    await new Promise((r) => setTimeout(r, 60));
    expect(api.calls.filter((c) => c === 'status').length).toBe(n);
  });

  it('the clock counts on between answers only while the song is playing', () => {
    const base = { syncedAt: 1_000 };
    expect(elapsedNow({ ...base, info: playing({ elapsedS: 10 }) }, 4_000)).toBe(13);
    expect(elapsedNow({ ...base, info: playing({ state: 'paused', elapsedS: 10 }) }, 4_000)).toBe(10);
    expect(elapsedNow({ ...base, info: info() }, 4_000)).toBeNull();
    expect(elapsedNow({ ...base, info: null }, 4_000)).toBeNull();
  });
});

describe('playing a song', () => {
  it('shows the words while the Pi searches, then the song it picked', async () => {
    const { store, api } = setup();
    let release: () => void = () => undefined;
    api.playGate = new Promise((r) => (release = r));
    const p = store.getState().play('  tum hi ho ');
    expect(store.getState().asking).toBe('tum hi ho');
    release();
    await p;
    expect(api.calls).toContain('play:tum hi ho');
    expect(store.getState().asking).toBeNull();
    expect(store.getState().info).toMatchObject({ state: 'starting', title: 'Tum Hi Ho - Arijit Singh' });
  });

  it('empty words do nothing, and a second ask while one is out is ignored', async () => {
    const { store, api } = setup();
    await store.getState().play('   ');
    expect(api.calls).toEqual([]);
    let release: () => void = () => undefined;
    api.playGate = new Promise((r) => (release = r));
    const first = store.getState().play('one');
    void store.getState().play('two');
    release();
    await first;
    expect(api.calls.filter((c) => c.startsWith('play'))).toEqual(['play:one']);
  });

  it('a song that is not found is an error the screen can show, and nothing is left asking', async () => {
    const { store, api } = setup();
    api.failWith = new ApiError('songNotFound');
    await store.getState().play('zzz');
    expect(store.getState().error?.kind).toBe('songNotFound');
    expect(store.getState().asking).toBeNull();
    store.getState().dismissError();
    expect(store.getState().error).toBeNull();
  });

  it('cancelling while the Pi is still searching takes the song back once the Pi answers', async () => {
    const { store, api } = setup();
    let release: () => void = () => undefined;
    api.playGate = new Promise((r) => (release = r));
    const p = store.getState().play('tum hi ho');
    store.getState().cancelAsk();
    expect(store.getState().asking).toBeNull();      // the screen is back at once
    release();
    await p;
    expect(api.calls).toEqual(['play:tum hi ho', 'stop']); // the queued song is stopped
    expect(store.getState().info).toBeNull();              // and the late answer is not shown
  });

  it('cancelling a song that is queued but not started stops it', async () => {
    const { store, api } = setup();
    await store.getState().play('tum hi ho');
    store.getState().cancelAsk();
    await new Promise((r) => setTimeout(r, 0));
    expect(api.calls).toContain('stop');
    expect(store.getState().info?.state).toBe('idle');
  });
});

describe('pause, resume, stop', () => {
  it('each sends one command and shows the Pi\'s answer', async () => {
    const { store, api } = setup();
    api.status = playing();
    await store.getState().refresh();
    await store.getState().pause();
    expect(store.getState().info?.state).toBe('paused');
    await store.getState().resume();
    expect(store.getState().info?.state).toBe('playing');
    await store.getState().stop();
    expect(store.getState().info?.state).toBe('idle');
    expect(api.calls.filter((c) => c !== 'status')).toEqual(['pause', 'resume', 'stop']);
  });

  it('"nothing is playing" is shown, and the screen is brought up to date', async () => {
    const { store, api } = setup();
    api.status = info(); // the song ended a moment ago
    api.failWith = new ApiError('nothingPlaying');
    await store.getState().pause();
    expect(store.getState().error?.kind).toBe('nothingPlaying');
    expect(store.getState().info?.state).toBe('idle');
    expect(store.getState().busy).toBe(false);
  });
});

describe('saying the song', () => {
  it('opens the microphone, shows the words, and plays what was heard', async () => {
    const { store, recognizer, api } = setup();
    await store.getState().startListening();
    expect(store.getState().listening).toBe(true);
    recognizer.listener?.onPartial('tum hi');
    expect(store.getState().heard).toBe('tum hi');
    recognizer.listener?.onFinal('tum hi ho');
    await new Promise((r) => setTimeout(r, 0));
    expect(store.getState().listening).toBe(false);
    expect(api.calls).toContain('play:tum hi ho');
  });

  it('hearing nothing plays nothing and says so', async () => {
    const { store, recognizer, api } = setup();
    await store.getState().startListening();
    recognizer.listener?.onFinal('  ');
    expect(api.calls).toEqual([]);
    expect(store.getState().micMessage).toBe(MIC_MESSAGES.nothing);
  });

  it('a missing speech pack offers the download', async () => {
    const { store, recognizer } = setup();
    await store.getState().startListening();
    recognizer.listener?.onError('speechPackMissing');
    expect(store.getState().micOffer).toBe(true);
    await store.getState().downloadSpeechPack();
    expect(recognizer.downloads).toBe(1);
    expect(store.getState().micMessage).toMatch(/^Downloaded/);
  });

  it('leaving closes the microphone with the reason, and words that arrive late are ignored', async () => {
    const { store, recognizer, api } = setup();
    await store.getState().startListening();
    const late = recognizer.listener;
    store.getState().interrupt('you left Music');
    expect(recognizer.cancels).toBe(1);
    expect(store.getState().micMessage).toBe('The microphone was closed: you left Music.');
    late?.onFinal('too late');
    expect(api.calls).toEqual([]);
  });

  it('reset forgets everything (the Pi was forgotten or removed)', async () => {
    const { store, api } = setup();
    api.status = playing();
    await store.getState().refresh();
    store.getState().reset();
    expect(store.getState().info).toBeNull();
    expect(store.getState().loading).toBe(true);
  });
});

const seekable = (patch: Partial<MusicInfo> = {}) => playing({ seekable: true, elapsedS: 100, limitS: 277, durationS: 262, ...patch });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('jumping around in the song', () => {
  async function ready(patch: Partial<MusicInfo> = {}) {
    const ctx = setup({ now: () => 1_000 });
    ctx.api.status = seekable(patch);
    await ctx.store.getState().refresh();
    return ctx;
  }

  it('seekTo sends the place once, shows it at once, and then takes the answer from the Pi', async () => {
    const { store, api } = await ready();
    let release: () => void = () => {};
    api.seekGate = new Promise<void>((r) => (release = r));
    store.getState().seekTo(30);
    await wait(0);
    expect(store.getState().seekTarget).toBe(30); // the bar is already there while the Pi is still answering
    expect(api.seeks).toEqual([30]);
    release();
    await wait(0);
    expect(store.getState().seekTarget).toBeNull();
    expect(store.getState().info?.elapsedS).toBe(30);
  });

  it('keeps the place inside the song, two seconds short of where it stops', async () => {
    const { store, api } = await ready();
    store.getState().seekTo(-20);
    await wait(0);
    store.getState().seekTo(9_999);
    await wait(0);
    expect(api.seeks).toEqual([0, 260]);
  });

  it('with a stop point before the end of the song the place stays before the stop point', async () => {
    const { store, api } = await ready({ durationS: 600, limitS: 100 });
    store.getState().seekTo(500);
    await wait(0);
    expect(api.seeks).toEqual([98]);
  });

  it('quick taps on skip are added up and sent as ONE jump', async () => {
    const { store, api } = await ready({ elapsedS: 100 });
    store.getState().skip(10);
    store.getState().skip(10);
    store.getState().skip(10);
    expect(store.getState().seekTarget).toBe(130); // 100 s now (the test clock is frozen), plus three taps of 10
    expect(api.seeks).toEqual([]);                 // nothing sent while the taps are still arriving
    await wait(80);
    expect(api.seeks).toEqual([130]);
    expect(store.getState().seekTarget).toBeNull();
  });

  it('skipping back and forth cancels out, and a long run of taps stops at the ends', async () => {
    const { store, api } = await ready({ elapsedS: 5 });
    store.getState().skip(-10);
    expect(store.getState().seekTarget).toBe(0);
    store.getState().skip(10);
    expect(store.getState().seekTarget).toBe(10);
    await wait(80);
    expect(api.seeks).toEqual([10]);
  });

  it('dragging after a skip uses the dragged place, not the taps', async () => {
    const { store, api } = await ready();
    store.getState().skip(10);
    store.getState().seekTo(50);
    await wait(80);
    expect(api.seeks).toEqual([50]);
  });

  it('does nothing when the song cannot be jumped in, when nothing plays, or for a bad number', async () => {
    const live = await ready({ seekable: false, durationS: null });
    live.store.getState().seekTo(30);
    live.store.getState().skip(10);
    const idle = setup();
    idle.store.getState().seekTo(30);
    const ok = await ready();
    ok.store.getState().seekTo(Number.NaN);
    ok.store.getState().skip(Number.POSITIVE_INFINITY);
    await wait(80);
    expect([live.api.seeks, idle.api.seeks, ok.api.seeks]).toEqual([[], [], []]);
    expect(live.store.getState().seekTarget).toBeNull();
  });

  it('works while paused', async () => {
    const { store, api } = await ready({ state: 'paused' });
    store.getState().seekTo(40);
    await wait(0);
    expect(api.seeks).toEqual([40]);
  });

  it('a jump the Pi refuses says so in plain words and the bar goes back to the real place', async () => {
    const { store, api, errors } = await ready();
    api.failWith = new ApiError('seekFailed');
    store.getState().seekTo(30);
    await wait(10);
    expect(store.getState().error?.userMessage).toBe("Couldn't jump just now. Try again.");
    expect(store.getState().seekTarget).toBeNull();
    expect(errors.map((e) => e.kind)).toEqual(['seekFailed']);
  });

  it('taps still being added up when the song ends send nothing', async () => {
    const { store, api } = await ready();
    store.getState().skip(10);
    api.status = info();
    await store.getState().refresh();
    await wait(80);
    expect(api.seeks).toEqual([]);
    expect(store.getState().seekTarget).toBeNull();
  });

  it('reset forgets taps that were waiting', async () => {
    const { store, api } = await ready();
    store.getState().skip(10);
    store.getState().reset();
    await wait(80);
    expect(api.seeks).toEqual([]);
    expect(store.getState().seekTarget).toBeNull();
  });
});
