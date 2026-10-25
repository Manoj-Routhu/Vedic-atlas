/**
 * Contract tests: the real API client against the real wire format.
 *
 * `scripts/mock_pi.py` is started as a separate process. It runs the Pi's actual vision, device and approval routes and the
 * actual permission gate; only the model and the chat brain are scripted. The client talks to it over real HTTP with
 * Node's real `fetch`, so the stream framing the Pi produces (multi-line `data:`, `[DONE]`, JSON events) is parsed by the
 * same code the phone runs. Skipped where Python or the mock is not available.
 */
import { ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import path from 'node:path';

import { VedaApi } from '../src/api/client';
import { ApiError } from '../src/api/errors';
import { fetchTransport } from '../src/api/transport';
import { createConnectionStore, STORAGE_KEY } from '../src/state/connection';
import { memoryStorage } from '../src/state/storage';
import type { ChatEvent, VisionEvent } from '../src/api/types';

const REPO = path.resolve(__dirname, '..', '..');
const MOCK = path.join(REPO, 'scripts', 'mock_pi.py');
const PYTHON =
  process.env.VEDA_PYTHON ??
  [path.join(REPO, 'vedic-atlas-env', 'Scripts', 'python.exe'), path.join(REPO, 'vedic-atlas-env', 'bin', 'python')].find(existsSync);
const canRun = Boolean(PYTHON) && existsSync(MOCK);
const describeIfPython = canRun ? describe : describe.skip;

// A real 8x8 JPEG (the Pi decodes what it is sent, so garbage bytes would be refused).
const JPEG = Uint8Array.from(
  Buffer.from(
    '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAIAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD7/ooooA//2Q==',
    'base64',
  ),
);

type Pi = { port: number; proc: ChildProcess; codes: Record<string, string> };
let pi: Pi;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

async function startPi(extra: string[] = []): Promise<Pi> {
  const port = await freePort();
  const proc = spawn(PYTHON as string, ['-I', MOCK, '--simulate-lan', '--state-dir', mkdtempSync(path.join(tmpdir(), 'veda-contract-')), '--port', String(port), '--cold-seconds', '0.4', '--chunk-delay', '0.01', ...extra], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const codes: Record<string, string> = {};
  let stderr = '';
  proc.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`mock Pi did not start:\n${stderr}`)), 30_000);
    let buf = '';
    proc.stdout?.on('data', (d: Buffer) => {
      buf += d.toString();
      for (const line of buf.split(/\r?\n/)) {
        const m = /^(PAIRING_CODE[A-Z_]*)=(\w+)$/.exec(line.trim());
        if (m) codes[m[1] as string] = m[2] as string;
      }
      if (buf.includes('MOCK_PI_READY') && codes.PAIRING_CODE_CHAT_ONLY) {
        clearTimeout(timer);
        resolve();
      }
    });
    proc.on('exit', (c) => reject(new Error(`mock Pi exited early (${c}):\n${stderr}`)));
  });
  // wait until the server answers
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/mock/state`)).ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return { port, proc, codes };
}

const base = () => new VedaApi({ host: '127.0.0.1', port: pi.port, transport: fetchTransport() });

/** Ask the mock (local-only helper) for a fresh single-use code, then pair with it like the app does. */
async function pairedApi(opts: { approve?: boolean; scopes?: string } = {}): Promise<VedaApi> {
  const q = new URLSearchParams();
  if (opts.approve) q.set('approve', '1');
  if (opts.scopes) q.set('scopes', opts.scopes);
  const code = ((await (await fetch(`http://127.0.0.1:${pi.port}/mock/code?${q}`, { method: 'POST' })).json()) as { code: string }).code;
  const r = await base().pair(code, 'Contract test phone');
  return base().withToken(r.token);
}

async function drain<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

async function failure(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    return e as ApiError;
  }
  throw new Error('expected a failure');
}

const text = (events: VisionEvent[]) => events.flatMap((e) => (e.type === 'token' ? [e.text] : [])).join('');

describeIfPython('the API client against the real Pi routes (mock Pi)', () => {
  beforeAll(async () => {
    pi = await startPi();
  }, 60_000);

  afterAll(() => {
    pi?.proc.kill();
  });

  it('the gate is real: nothing works without pairing', async () => {
    expect((await failure(base().health())).kind).toBe('unauthorized');
    expect((await failure(drain(base().chatStream('hi')))).kind).toBe('unauthorized');
  });

  it('pairs once; the code cannot be used twice; a wrong code is refused', async () => {
    const first = await base().pair(pi.codes.PAIRING_CODE as string, 'Phone A');
    expect(first.token.length).toBeGreaterThan(20);
    expect(first.scopes).toEqual(expect.arrayContaining(['approve', 'chat', 'control', 'vision']));
    expect((await failure(base().pair(pi.codes.PAIRING_CODE as string, 'Phone B'))).kind).toBe('pairCodeInvalid');
    expect((await failure(base().pair('WRONGCODE', 'Phone C'))).kind).toBe('pairCodeInvalid');
    await base().withToken(first.token).health(); // and the token it got works
  });

  it('a describe request: loading, then the words, then done', async () => {
    const api = await pairedApi();
    const info = await api.putImage(JPEG);
    expect(info.imageId.length).toBeGreaterThan(8);
    const events = await drain(api.askVision({ imageId: info.imageId }));
    expect(events[0]).toEqual({ type: 'status', state: 'loading' }); // the model was cold
    expect(events[events.length - 1]).toEqual({ type: 'done' });
    expect(text(events)).toContain('A red apple and a blue mug');
    expect(text(events)).toContain('12/2027');
  });

  it('a follow-up about the same photo reuses it without uploading again, and the model is warm', async () => {
    const api = await pairedApi();
    const { imageId } = await api.putImage(JPEG);
    await drain(api.askVision({ imageId })); // first use warms the model
    const events = await drain(api.askVision({ imageId, question: 'What does the label say?' }));
    expect(events[0]?.type).toBe('token'); // no loading announcement now
    expect(text(events)).toBe('The label says "Best before 12/2027."');
    const read = await drain(api.askVision({ imageId, style: 'read_text' }));
    expect(text(read)).toBe('Best before 12/2027.');
  });

  it('an unknown or expired photo is reported so the app can upload it again', async () => {
    const api = await pairedApi();
    expect((await failure(drain(api.askVision({ imageId: 'does-not-exist' })))).kind).toBe('photoExpired');
  });

  it('a file that is not a photo is refused', async () => {
    const api = await pairedApi();
    expect((await failure(api.putImage(new TextEncoder().encode('definitely not a picture')))).kind).toBe('photoRejected');
  });

  it('a second photo while one is running gets "busy" with a retry hint, then works once the first is done', async () => {
    const api = await pairedApi();
    const { imageId } = await api.putImage(JPEG);
    await drain(api.askVision({ imageId })); // warm
    const slow = api.askVision({ imageId, style: 'detailed' });
    const first = await slow.next(); // the first request now holds the single slot
    expect(first.value).toMatchObject({ type: 'token' });
    const e = await failure(drain(api.askVision({ imageId })));
    expect(e.kind).toBe('visionBusy');
    expect(e.retryAfterSeconds).toBe(5);
    await drain(slow);
    expect(text(await drain(api.askVision({ imageId })))).toContain('apple');
  });

  it('cancelling mid-answer ends quietly, and the slot comes free for the next photo', async () => {
    const api = await pairedApi();
    const { imageId } = await api.putImage(JPEG);
    await drain(api.askVision({ imageId })); // warm
    const c = new AbortController();
    const got: VisionEvent[] = [];
    for await (const e of api.askVision({ imageId, style: 'detailed' }, c.signal)) {
      got.push(e);
      if (got.length === 2) c.abort(); // Stop pressed after a couple of words
    }
    expect(got.length).toBeLessThan(10);
    expect(got.some((e) => e.type === 'done')).toBe(false);
    // the Pi notices the hang-up and frees the slot; the next photo may briefly be told it is busy
    let again: VisionEvent[] = [];
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        again = await drain(api.askVision({ imageId }));
        break;
      } catch (e) {
        expect((e as ApiError).kind).toBe('visionBusy');
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    expect(text(again)).toContain('apple');
  });

  it('a phone without the camera permission is refused, and says so', async () => {
    const api = await pairedApi({ scopes: 'chat' });
    expect((await failure(api.putImage(JPEG))).kind).toBe('forbidden');
    expect((await failure(api.visionStatus())).kind).toBe('forbidden');
  });

  it('chat streams the reply and ends on [DONE]; line breaks survive the framing', async () => {
    const api = await pairedApi();
    expect(await drain(api.chatStream('hello'))).toEqual<ChatEvent[]>([{ type: 'text', text: 'You said: hello' }, { type: 'done' }]);
    const multi = await drain(api.chatStream('multi'));
    expect(multi[0]).toEqual({ type: 'text', text: 'Here are two lines:\nLine one\nLine two' });
  });

  it('a request that needs approval shows up as pending, and only a phone allowed to approve can resolve it', async () => {
    const owner = await pairedApi({ approve: true });
    const viewer = await pairedApi();
    await drain(owner.chatStream('please send an email to Priya'));
    const pending = await viewer.pendingApprovals();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ actionName: 'send_email' });
    const id = (pending[0] as { requestId: string }).requestId;

    expect((await failure(viewer.approve(id))).kind).toBe('forbidden'); // view-only phone
    await owner.approve(id);
    expect(await viewer.pendingApprovals()).toHaveLength(0);
  });

  it('while auto-approve is on at the Pi, chat from the phone is paused with a clear reason', async () => {
    const api = await pairedApi();
    await fetch(`http://127.0.0.1:${pi.port}/mock/yolo?on=1`, { method: 'POST' });
    try {
      expect((await failure(drain(api.chatStream('hi')))).kind).toBe('autoApproveOn');
    } finally {
      await fetch(`http://127.0.0.1:${pi.port}/mock/yolo?on=0`, { method: 'POST' });
    }
    expect(await drain(api.chatStream('hi'))).toHaveLength(2); // and it recovers when turned off
  });

  it('a phone that was removed on the Pi is told so at once', async () => {
    const api = await pairedApi();
    await api.health();
    await fetch(`http://127.0.0.1:${pi.port}/mock/revoke-all`, { method: 'POST' });
    expect((await failure(api.health())).kind).toBe('unauthorized');
  });
});

describeIfPython('pairing through the connection store, the way the screens do it', () => {
  beforeAll(async () => {
    pi = await startPi();
  }, 60_000);
  afterAll(() => {
    pi?.proc.kill();
  });

  const mint = async (q = '') =>
    ((await (await fetch(`http://127.0.0.1:${pi.port}/mock/code${q}`, { method: 'POST' })).json()) as { code: string }).code;

  it('pairs from a typed code, saves it, works afterwards, and survives a restart', async () => {
    const storage = memoryStorage();
    const store = createConnectionStore({ storage, makeTransport: () => fetchTransport(), makeDemo: () => ({}) as never });
    await store.getState().load();
    expect(store.getState().phase).toBe('unpaired');

    await store.getState().pair({ host: '127.0.0.1', port: pi.port, code: (await mint('?approve=1')).toLowerCase(), deviceName: 'Contract phone' });
    expect(store.getState().phase).toBe('paired');
    expect(store.getState().saved?.scopes).toEqual(expect.arrayContaining(['approve', 'chat', 'control', 'vision']));
    await store.getState().api()?.health(); // the saved token really works

    const restarted = createConnectionStore({ storage, makeTransport: () => fetchTransport(), makeDemo: () => ({}) as never });
    await restarted.getState().load(); // "closing and reopening the app"
    expect(restarted.getState().phase).toBe('paired');
    await restarted.getState().api()?.health();
  });

  it('a wrong code is refused and nothing is saved', async () => {
    const storage = memoryStorage();
    const store = createConnectionStore({ storage, makeTransport: () => fetchTransport(), makeDemo: () => ({}) as never });
    await store.getState().load();
    await expect(store.getState().pair({ host: '127.0.0.1', port: pi.port, code: 'WRONGCODE', deviceName: 'x' })).rejects.toMatchObject({ kind: 'pairCodeInvalid' });
    expect(store.getState().phase).toBe('unpaired');
    expect(storage.data.has(STORAGE_KEY)).toBe(false);
  });

  it('when the Pi removes the phone, the next call sends the app back to pairing with a notice', async () => {
    const storage = memoryStorage();
    const store = createConnectionStore({ storage, makeTransport: () => fetchTransport(), makeDemo: () => ({}) as never });
    await store.getState().load();
    await store.getState().pair({ host: '127.0.0.1', port: pi.port, code: await mint(), deviceName: 'To be removed' });
    await fetch(`http://127.0.0.1:${pi.port}/mock/revoke-all`, { method: 'POST' });
    try {
      await store.getState().api()?.health();
    } catch (e) {
      store.getState().handleError(e); // what the link monitor does with the failure
    }
    await new Promise((r) => setTimeout(r, 20));
    expect(store.getState().phase).toBe('unpaired');
    expect(store.getState().notice).toBe('removed');
    expect(storage.data.has(STORAGE_KEY)).toBe(false);
  });

  it('a Pi that stops answering marks the link, but keeps the pairing', async () => {
    const storage = memoryStorage();
    const store = createConnectionStore({ storage, makeTransport: () => fetchTransport(), makeDemo: () => ({}) as never });
    await store.getState().load();
    await store.getState().pair({ host: '127.0.0.1', port: pi.port, code: await mint(), deviceName: 'Stays paired' });
    pi.proc.kill();
    await new Promise((r) => setTimeout(r, 500));
    try {
      await store.getState().api()?.health();
    } catch (e) {
      store.getState().handleError(e);
    }
    expect(store.getState().link).toBe('unreachable');
    expect(store.getState().phase).toBe('paired');
  });
});

describeIfPython('error paths the real model can take', () => {
  it('vision switched off on the Pi', async () => {
    pi = await startPi(['--vision-off']);
    try {
      const api = await pairedApi();
      expect((await failure(api.visionStatus())).kind).toBe('visionOff');
      expect((await failure(api.putImage(JPEG))).kind).toBe('visionOff');
    } finally {
      pi.proc.kill();
    }
  }, 60_000);

  it('a model that fails part-way gives an error event, not a hang', async () => {
    pi = await startPi(['--fail-after', '3']);
    try {
      const api = await pairedApi();
      const { imageId } = await api.putImage(JPEG);
      const events = await drain(api.askVision({ imageId }));
      const last = events[events.length - 1];
      expect(last).toMatchObject({ type: 'error', code: 'VISION_UNAVAILABLE' });
      expect(JSON.stringify(last)).not.toContain('scripted failure'); // internals are not leaked to the phone
    } finally {
      pi.proc.kill();
    }
  }, 60_000);

  it('a Pi out of memory is reported as such', async () => {
    pi = await startPi(['--memory-error']);
    try {
      const api = await pairedApi();
      const { imageId } = await api.putImage(JPEG);
      const events = await drain(api.askVision({ imageId }));
      expect(events[events.length - 1]).toMatchObject({ type: 'error' });
      expect((events[events.length - 1] as { message: string }).message).toContain('memory');
    } finally {
      pi.proc.kill();
    }
  }, 60_000);
});
