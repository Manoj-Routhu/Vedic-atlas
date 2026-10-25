import { ApiError } from '../src/api/errors';
import type { PiApi } from '../src/api/pi';
import { VedaApi } from '../src/api/client';
import { startLinkMonitor } from '../src/state/linkMonitor';
import { FakeTransport } from './helpers/fakeTransport';

// A Pi that has gone away: the request never answers (packets are dropped), until the caller gives up.
describe('a Pi that silently disappears must show as unreachable', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

  it('reports unreachable even though the request timeout equals the check interval (the original bug)', async () => {
    const transport = new FakeTransport(() => ({ hang: true }));
    const api = new VedaApi({ host: '192.168.1.5', port: 8000, token: 't', transport, requestTimeoutMs: 15_000 });
    const results: string[] = [];
    const appState = { currentState: 'active', addEventListener: () => ({ remove() {} }) };
    const stop = startLinkMonitor({ getApi: () => api as PiApi, onResult: (r) => results.push(r.result), intervalMs: 15_000, appState });
    for (let t = 0; t < 8; t++) { jest.advanceTimersByTime(5_000); await flush(); }   // 40 seconds
    stop();
    expect(results).toContain('unreachable');
  });
});
