import { AppState } from 'react-native';

import { ApiError, apiErrorFromThrown } from '../api/errors';
import type { PiApi } from '../api/pi';

export type LinkResult = 'connected' | 'unreachable' | 'removed';

/** One health check, turned into what the status chip needs. 'cancelled' means we stopped it ourselves: say nothing. */
export async function checkLink(api: PiApi, signal?: AbortSignal): Promise<{ result: LinkResult | 'cancelled'; error?: unknown }> {
  try {
    await api.health(signal);
    return { result: 'connected' };
  } catch (e) {
    const err = apiErrorFromThrown(e);
    if (err.kind === 'unauthorized') return { result: 'removed', error: err };
    if (err.kind === 'cancelled') return { result: 'cancelled' };
    return { result: 'unreachable', error: err };
  }
}

type AppStateLike = {
  currentState: string | null | undefined;
  addEventListener(type: 'change', fn: (s: string) => void): { remove(): void };
};

export type MonitorOptions = {
  getApi: () => PiApi | null;
  onResult: (r: { result: LinkResult; error?: unknown }) => void;
  /** How often to check while the app is in front. */
  intervalMs?: number;
  /**
   * How long one check may take before the Pi counts as unreachable. Keep it well under `intervalMs`: a Pi that has gone away
   * often answers with silence, not an error, so the timeout is the only way we ever find out.
   */
  checkTimeoutMs?: number;
  /** Injected for tests. */
  appState?: AppStateLike;
};

/**
 * Check the Pi now and then, but only while the app is in front: no timer and no network use in the background.
 * Coming back to the foreground checks at once. A tick that finds the previous check still running does nothing (it never
 * cancels it), and a check that takes longer than `checkTimeoutMs` is reported as unreachable. Returns a function that stops it.
 */
export function startLinkMonitor({
  getApi,
  onResult,
  intervalMs = 15_000,
  checkTimeoutMs = 6_000,
  appState = AppState as unknown as AppStateLike,
}: MonitorOptions): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight: AbortController | null = null;
  let stopped = false;

  const run = async () => {
    const api = getApi();
    if (!api || stopped || inFlight) return;
    const controller = new AbortController();
    inFlight = controller;
    let timedOut = false;
    const limit = setTimeout(() => {
      if (controller.signal.aborted) return; // already dropped (the app went to the background): not a timeout
      timedOut = true;
      controller.abort();
    }, checkTimeoutMs);
    try {
      const r = await checkLink(api, controller.signal);
      if (stopped) return;
      if (timedOut) onResult({ result: 'unreachable', error: new ApiError('timeout') });
      else if (r.result !== 'cancelled') onResult({ result: r.result, error: r.error });
    } finally {
      clearTimeout(limit);
      if (inFlight === controller) inFlight = null;
    }
  };
  const begin = () => {
    if (timer) return;
    void run();
    timer = setInterval(() => void run(), intervalMs);
  };
  const pause = () => {
    if (timer) clearInterval(timer);
    timer = null;
    inFlight?.abort(); // the app went to the background: drop the check, and report nothing
  };

  if (appState.currentState === 'active') begin();
  const sub = appState.addEventListener('change', (s) => (s === 'active' ? begin() : pause()));

  return () => {
    stopped = true;
    pause();
    sub.remove();
  };
}
