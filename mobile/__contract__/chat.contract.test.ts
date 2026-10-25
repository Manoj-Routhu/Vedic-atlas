/**
 * The chat session driven through the real API client against the mock Pi (real chat gate and approval routes, canned replies).
 * It proves replies stream through the real framing, an approval created by chat shows up and can be decided, and that
 * auto-approve (yolo) on at the Pi pauses phone chat.
 */
import { ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { VedaApi } from '../src/api/client';
import { fetchTransport } from '../src/api/transport';
import { createChatStore } from '../src/features/chat/chatStore';

const REPO = path.resolve(__dirname, '..', '..');
const MOCK = path.join(REPO, 'scripts', 'mock_pi.py');
const PYTHON =
  process.env.VEDA_PYTHON ??
  [path.join(REPO, 'vedic-atlas-env', 'Scripts', 'python.exe'), path.join(REPO, 'vedic-atlas-env', 'bin', 'python')].find(existsSync);
const canRun = Boolean(PYTHON) && existsSync(MOCK);
const describeIfPython = canRun ? describe : describe.skip;

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

async function pairedApi(approve = false): Promise<VedaApi> {
  const { code } = (await (await fetch(`http://127.0.0.1:${port}/mock/code?approve=${approve ? 1 : 0}`, { method: 'POST' })).json()) as { code: string };
  const unpaired = new VedaApi({ host: '127.0.0.1', port, transport: fetchTransport() });
  const { token } = await unpaired.pair(code, 'Chat contract phone');
  return unpaired.withToken(token);
}

const chatOn = (api: VedaApi) => createChatStore({ getApi: () => api, makeSpeech: () => ({ enqueue: () => undefined, stop: () => undefined, isSpeaking: false }), timing: { pollBusyMs: 50, pollIdleMs: 50 } });
const yolo = (on: boolean) => fetch(`http://127.0.0.1:${port}/mock/yolo?on=${on ? 1 : 0}`, { method: 'POST' });

describeIfPython('the chat session against the real Pi routes (mock Pi)', () => {
  beforeAll(startMock, 60_000);
  afterAll(() => {
    proc?.kill();
  });

  it('a message gets a streamed reply', async () => {
    const store = chatOn(await pairedApi());
    await store.getState().send('hello');
    const s = store.getState();
    expect(s.busy).toBe(false);
    expect(s.error).toBeNull();
    expect(s.messages.map((m) => m.role)).toEqual(['user', 'veda']);
    expect(s.messages[1]?.text.length).toBeGreaterThan(0);
  });

  it('line breaks in a reply survive the stream', async () => {
    const store = chatOn(await pairedApi());
    await store.getState().send('multi');
    expect(store.getState().messages[1]?.text).toMatch(/\n/);
  });

  it('asking for an email creates an approval that the phone sees, and an approving phone can approve it', async () => {
    const store = chatOn(await pairedApi(true));
    await store.getState().send('please send an email to Priya');
    await store.getState().refreshApprovals();
    const waiting = store.getState().approvals;
    expect(waiting).toHaveLength(1);
    expect(waiting[0]?.summary.length).toBeGreaterThan(0);
    await store.getState().approve(waiting[0]?.requestId as string);
    expect(store.getState().approvals).toEqual([]);
    await store.getState().refreshApprovals();
    expect(store.getState().approvals).toEqual([]);
  });

  it('a phone that may not approve is refused by the Pi, and the request stays', async () => {
    const owner = await pairedApi(true);
    const viewer = chatOn(await pairedApi(false));
    await chatOn(owner).getState().send('please send an email to Priya');
    await viewer.getState().refreshApprovals();
    const id = viewer.getState().approvals[0]?.requestId as string;
    await viewer.getState().approve(id);
    expect(viewer.getState().error?.kind).toBe('forbidden');
    expect(viewer.getState().approvals).toHaveLength(1);
    await owner.deny(id); // tidy up
  });

  it('auto-approve on at the Pi pauses chat, and chat works again when it is turned off', async () => {
    const store = chatOn(await pairedApi());
    await yolo(true);
    await store.getState().send('hello');
    expect(store.getState().paused).toBe(true);
    expect(store.getState().messages).toEqual([]);
    await yolo(false);
    await store.getState().send('hello');
    expect(store.getState().paused).toBe(false);
    expect(store.getState().messages).toHaveLength(2);
  });

  it('polling picks up an approval that appears later', async () => {
    const api = await pairedApi(true);
    const store = chatOn(api);
    store.getState().startPolling();
    await api.chatStream('please send an email to Sam')[Symbol.asyncIterator]().next().then(() => undefined);
    for (let i = 0; i < 40 && store.getState().approvals.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    store.getState().stopPolling();
    expect(store.getState().approvals.length).toBeGreaterThan(0);
  });
});
