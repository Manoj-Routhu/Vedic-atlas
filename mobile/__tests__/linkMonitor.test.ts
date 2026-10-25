import type { AppStateStatus } from 'react-native';

import { ApiError } from '../src/api/errors';
import type { PiApi } from '../src/api/pi';
import { checkLink, startLinkMonitor, type LinkResult } from '../src/state/linkMonitor';

function fakeApi(health: (signal?: AbortSignal) => Promise<void>): PiApi {
  return { health } as unknown as PiApi;
}

/** A Pi that has gone away: never answers, and only stops when the caller aborts (what a real fetch does). */
const hangs = (signal?: AbortSignal) =>
  new Promise<void>((_, reject) => signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));

function fakeAppState(initial: AppStateStatus = 'active') {
  const listeners = new Set<(s: AppStateStatus) => void>();
  return {
    currentState: initial,
    addEventListener(_type: 'change', fn: (s: AppStateStatus) => void) {
      listeners.add(fn);
      return { remove: () => void listeners.delete(fn) };
    },
    set(s: AppStateStatus) {
      this.currentState = s;
      listeners.forEach((l) => l(s));
    },
    count: () => listeners.size,
  };
}

describe('checkLink', () => {
  it('a healthy Pi is connected', async () => {
    expect((await checkLink(fakeApi(async () => {}))).result).toBe('connected');
  });
  it('a removed phone (401) is "removed"', async () => {
    const r = await checkLink(fakeApi(async () => { throw new ApiError('unauthorized'); }));
    expect(r.result).toBe('removed');
  });
  it('an unreachable or slow Pi is "unreachable"', async () => {
    expect((await checkLink(fakeApi(async () => { throw new ApiError('unreachable'); }))).result).toBe('unreachable');
    expect((await checkLink(fakeApi(async () => { throw new ApiError('timeout'); }))).result).toBe('unreachable');
    expect((await checkLink(fakeApi(async () => { throw new TypeError('Network request failed'); }))).result).toBe('unreachable');
  });
  it('our own cancel is not a failure and not a success: it says nothing', async () => {
    expect((await checkLink(fakeApi(async () => { throw new ApiError('cancelled'); }))).result).toBe('cancelled');
  });
});

describe('startLinkMonitor', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const flush = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };

  it('checks at once, then every interval, only while the app is in front', async () => {
    const health = jest.fn(async () => {});
    const appState = fakeAppState('active');
    const results: LinkResult[] = [];
    const stop = startLinkMonitor({ getApi: () => fakeApi(health), onResult: (r) => results.push(r.result), intervalMs: 1000, appState });

    await flush();
    expect(health).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1000);
    await flush();
    expect(health).toHaveBeenCalledTimes(2);

    appState.set('background'); // no timer and no network use in the background
    jest.advanceTimersByTime(10_000);
    await flush();
    expect(health).toHaveBeenCalledTimes(2);

    appState.set('active'); // coming back checks straight away
    await flush();
    expect(health).toHaveBeenCalledTimes(3);
    expect(results).toEqual(['connected', 'connected', 'connected']);

    stop();
    jest.advanceTimersByTime(10_000);
    await flush();
    expect(health).toHaveBeenCalledTimes(3);
    expect(appState.count()).toBe(0);
  });

  it('does not start when the app begins in the background', async () => {
    const health = jest.fn(async () => {});
    const appState = fakeAppState('background');
    const stop = startLinkMonitor({ getApi: () => fakeApi(health), onResult: () => {}, intervalMs: 1000, appState });
    jest.advanceTimersByTime(5000);
    await flush();
    expect(health).not.toHaveBeenCalled();
    appState.set('active');
    await flush();
    expect(health).toHaveBeenCalledTimes(1);
    stop();
  });

  it('does nothing while there is no API (not paired yet)', async () => {
    const onResult = jest.fn();
    const stop = startLinkMonitor({ getApi: () => null, onResult, intervalMs: 1000, appState: fakeAppState() });
    jest.advanceTimersByTime(5000);
    await flush();
    expect(onResult).not.toHaveBeenCalled();
    stop();
  });

  it('reports a Pi that goes away and comes back', async () => {
    let up = true;
    const health = jest.fn(async () => {
      if (!up) throw new ApiError('unreachable');
    });
    const results: LinkResult[] = [];
    const stop = startLinkMonitor({ getApi: () => fakeApi(health), onResult: (r) => results.push(r.result), intervalMs: 1000, appState: fakeAppState() });
    await flush();
    up = false;
    jest.advanceTimersByTime(1000);
    await flush();
    up = true;
    jest.advanceTimersByTime(1000);
    await flush();
    expect(results).toEqual(['connected', 'unreachable', 'connected']);
    stop();
  });

  it('a Pi that goes silent is reported unreachable once the check times out', async () => {
    const results: LinkResult[] = [];
    const stop = startLinkMonitor({ getApi: () => fakeApi(hangs), onResult: (r) => results.push(r.result), intervalMs: 15_000, checkTimeoutMs: 6_000, appState: fakeAppState() });
    await flush();
    jest.advanceTimersByTime(5_999);
    await flush();
    expect(results).toEqual([]); // not yet
    jest.advanceTimersByTime(2);
    await flush();
    expect(results).toEqual(['unreachable']);
    stop();
  });

  it('keeps reporting unreachable on every cycle while the Pi stays away, and recovers when it returns', async () => {
    let up = false;
    const health = jest.fn((signal?: AbortSignal) => (up ? Promise.resolve() : hangs(signal)));
    const results: LinkResult[] = [];
    const stop = startLinkMonitor({ getApi: () => fakeApi(health), onResult: (r) => results.push(r.result), intervalMs: 15_000, checkTimeoutMs: 6_000, appState: fakeAppState() });
    for (let t = 0; t < 12; t++) await jest.advanceTimersByTimeAsync(5_000); // 60 s, letting promises settle between timers like a real clock
    expect(results.length).toBeGreaterThanOrEqual(4);
    expect(new Set(results)).toEqual(new Set(['unreachable']));
    up = true;
    await jest.advanceTimersByTimeAsync(15_000);
    expect(results[results.length - 1]).toBe('connected');
    stop();
  });

  it('a slow check is not cancelled by the next tick: the tick skips, and the answer still arrives', async () => {
    let answer: () => void = () => {};
    const health = jest.fn(() => new Promise<void>((r) => (answer = r)));
    const results: LinkResult[] = [];
    const stop = startLinkMonitor({ getApi: () => fakeApi(health), onResult: (r) => results.push(r.result), intervalMs: 1_000, checkTimeoutMs: 5_000, appState: fakeAppState() });
    await flush();
    jest.advanceTimersByTime(3_000); // three ticks while the first check is still waiting
    await flush();
    expect(health).toHaveBeenCalledTimes(1);
    answer();
    await flush();
    expect(results).toEqual(['connected']);
    stop();
  });

  it('going to the background drops a pending check without reporting anything', async () => {
    const appState = fakeAppState('active');
    const results: LinkResult[] = [];
    const stop = startLinkMonitor({ getApi: () => fakeApi(hangs), onResult: (r) => results.push(r.result), intervalMs: 15_000, checkTimeoutMs: 6_000, appState });
    await flush();
    appState.set('background');
    jest.advanceTimersByTime(60_000);
    await flush();
    expect(results).toEqual([]);
    stop();
  });

  it('ignores a result that arrives after it was stopped', async () => {
    let finish: () => void = () => {};
    const health = jest.fn(() => new Promise<void>((r) => (finish = r)));
    const onResult = jest.fn();
    const stop = startLinkMonitor({ getApi: () => fakeApi(health), onResult, intervalMs: 1000, appState: fakeAppState() });
    await flush();
    stop();
    finish();
    await flush();
    expect(onResult).not.toHaveBeenCalled();
  });
});
