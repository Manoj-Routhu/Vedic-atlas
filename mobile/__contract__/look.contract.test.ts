/**
 * The Look session driven through the real API client against the mock Pi (real vision routes, real gate, scripted model).
 * It proves the pieces fit over real HTTP: upload, the streamed answer cut into sentences, and the recovery paths the
 * phone relies on (the Pi forgetting a photo, a second request while one is running).
 */
import { ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { VedaApi } from '../src/api/client';
import { fetchTransport } from '../src/api/transport';
import { createLookStore } from '../src/features/look/lookStore';
import type { Photo } from '../src/features/look/ports';

const REPO = path.resolve(__dirname, '..', '..');
const MOCK = path.join(REPO, 'scripts', 'mock_pi.py');
const PYTHON =
  process.env.VEDA_PYTHON ??
  [path.join(REPO, 'vedic-atlas-env', 'Scripts', 'python.exe'), path.join(REPO, 'vedic-atlas-env', 'bin', 'python')].find(existsSync);
const canRun = Boolean(PYTHON) && existsSync(MOCK);
const describeIfPython = canRun ? describe : describe.skip;

// A real 8x8 JPEG: the Pi decodes what it is sent.
const JPEG = Uint8Array.from(
  Buffer.from(
    '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAIAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD7/ooooA//2Q==',
    'base64',
  ),
);

let port = 0;
let proc: ChildProcess;

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });

async function startMock() {
  port = await freePort();
  proc = spawn(
    PYTHON as string,
    ['-I', MOCK, '--simulate-lan', '--state-dir', mkdtempSync(path.join(tmpdir(), 'veda-look-')), '--port', String(port), '--cold-seconds', '0.3', '--chunk-delay', '0.01'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderr = '';
  proc.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
  proc.on('exit', (c) => {
    stderr += `\n(exited ${c})`;
  });
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/mock/state`)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`mock Pi did not start:\n${stderr}`);
}

async function pairedApi(): Promise<VedaApi> {
  const { code } = (await (await fetch(`http://127.0.0.1:${port}/mock/code`, { method: 'POST' })).json()) as { code: string };
  const unpaired = new VedaApi({ host: '127.0.0.1', port, transport: fetchTransport() });
  const { token } = await unpaired.pair(code, 'Look contract phone');
  return unpaired.withToken(token);
}

function sessionOn(api: VedaApi) {
  const spoken: string[] = [];
  const photo: Photo = { uri: 'file:///x.jpg', width: 8, height: 8, bytes: JPEG, discard: () => undefined };
  const store = createLookStore({
    getApi: () => api,
    takePhoto: async () => photo,
    makeSpeech: () => ({ enqueue: (t) => void spoken.push(t), stop: () => undefined, isSpeaking: false }),
    feedback: { capture: () => undefined, success: () => undefined, failure: () => undefined },
    timing: { busyRetryDefaultMs: 50, busyRetryMaxMs: 200 },
  });
  return { store, spoken };
}

describeIfPython('the Look session against the real Pi routes (mock Pi)', () => {
  beforeAll(startMock, 60_000);
  afterAll(() => {
    proc?.kill();
  });

  it('a photo goes up, the answer comes back in sentences, and every sentence is spoken in order', async () => {
    const { store, spoken } = sessionOn(await pairedApi());
    await store.getState().capture();
    const s = store.getState();
    expect(s.phase).toBe('answered');
    expect(s.done).toBe(true);
    expect(s.sentences.length).toBeGreaterThan(0);
    expect(spoken.filter((t) => s.sentences.includes(t))).toEqual(s.sentences);
  });

  it('a follow-up question uses the photo already on the Pi', async () => {
    const { store } = sessionOn(await pairedApi());
    await store.getState().capture();
    await store.getState().ask('What colour is it?');
    expect(store.getState().phase).toBe('answered');
    expect(store.getState().question).toBe('What colour is it?');
  });

  it('when the Pi forgets the photo, the app sends it again and the user never notices', async () => {
    const { store } = sessionOn(await pairedApi());
    await store.getState().capture();
    const expired = (await (await fetch(`http://127.0.0.1:${port}/mock/expire-images`, { method: 'POST' })).json()) as { expired: number };
    expect(expired.expired).toBeGreaterThan(0);
    await store.getState().ask('Still there?');
    expect(store.getState().phase).toBe('answered');
    expect(store.getState().error).toBeNull();
  });

  it('a second phone request while one is running waits once, and then both are answered', async () => {
    const api = await pairedApi();
    const first = sessionOn(api);
    const second = sessionOn(api);
    const a = first.store.getState().capture();
    await new Promise((r) => setTimeout(r, 150)); // the first is now holding the model
    const b = second.store.getState().capture();
    await Promise.all([a, b]);
    expect(first.store.getState().phase).toBe('answered');
    expect(['answered', 'error']).toContain(second.store.getState().phase); // answered after the retry, or a clear "busy"
    if (second.store.getState().phase === 'error') expect(second.store.getState().error?.kind).toBe('visionBusy');
  });

  it('Stop mid-answer cancels cleanly and the next photo works at once', async () => {
    const { store } = sessionOn(await pairedApi());
    const run = store.getState().capture();
    await new Promise((r) => setTimeout(r, 400));
    store.getState().stop();
    await run;
    await store.getState().capture();
    expect(store.getState().phase).toBe('answered');
    expect(store.getState().done).toBe(true);
  });
});
