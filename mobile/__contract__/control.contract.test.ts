/**
 * The Control page driven through the real API client against the mock Pi (real permission gate, real wire format).
 * It proves the pieces fit over real HTTP: each section loads, the changes take effect on the Pi, phones without the right
 * permission are refused, and a phone can close the microphone but has no way to open it.
 */
import { ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { VedaApi } from '../src/api/client';
import { fetchTransport } from '../src/api/transport';
import { createControlStore } from '../src/features/control/controlStore';

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
    ['-I', MOCK, '--simulate-lan', '--state-dir', mkdtempSync(path.join(tmpdir(), 'veda-control-')), '--port', String(port), '--cold-seconds', '0.3', '--chunk-delay', '0.01'],
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

/** A paired phone with the given permissions (a comma list; empty means the default: chat, control, vision). */
async function pairedApi(scopes = ''): Promise<VedaApi> {
  const q = scopes ? `?scopes=${scopes}` : '';
  const { code } = (await (await fetch(`http://127.0.0.1:${port}/mock/code${q}`, { method: 'POST' })).json()) as { code: string };
  const unpaired = new VedaApi({ host: '127.0.0.1', port, transport: fetchTransport() });
  const { token } = await unpaired.pair(code, 'Control contract phone');
  return unpaired.withToken(token);
}

const controlOn = (api: VedaApi, scopes: string[]) => createControlStore({ getApi: () => api, scopes: () => scopes, refreshMs: 50 });
const FULL = ['chat', 'control', 'vision'];

describeIfPython('the Control page against the real Pi routes (mock Pi)', () => {
  beforeAll(startMock, 60_000);
  afterAll(() => {
    proc?.kill();
  });

  it('one refresh loads every section for a phone with full permissions', async () => {
    const store = controlOn(await pairedApi(), FULL);
    await store.getState().refresh();
    const s = store.getState();
    expect(s.errors).toEqual({});
    expect(s.onlineMs).not.toBeNull();
    expect(s.autoApprove).toBe(false);
    expect(s.vision?.enabled).toBe(true);
    expect(s.privacy).toMatchObject({ muted: false, hardwareSwitch: false });
    expect(s.voice).toEqual({ available: true, running: true });
    expect(s.tasks?.length).toBeGreaterThan(0);
    expect(s.reminders?.enabled).toBe(true);
    expect(s.persona?.options.length).toBeGreaterThan(1);
    expect(s.proactivity?.options).toEqual(['conservative', 'medium', 'chatty']);
    expect(s.activity?.[0]?.tools.length).toBeGreaterThan(0);
  });

  it('tasks: add and complete go all the way to the Pi', async () => {
    const api = await pairedApi();
    const store = controlOn(api, FULL);
    await store.getState().refresh();
    await store.getState().addTask('Water the plants');
    expect((await api.tasks()).map((t) => t.title)).toContain('Water the plants');
    const id = (await api.tasks()).find((t) => t.title === 'Water the plants')?.id as number;
    await store.getState().completeTask(id);
    expect((await api.tasks()).map((t) => t.title)).not.toContain('Water the plants');
    expect(store.getState().actionError).toBeNull();
  });

  it('completing a task that is already gone shows an error and the list comes back right', async () => {
    const api = await pairedApi();
    const store = controlOn(api, FULL);
    await store.getState().refresh();
    const added = await api.addTask('Soon gone');
    await store.getState().refresh();
    await api.completeTask(added.id); // done elsewhere
    await store.getState().completeTask(added.id);
    expect(store.getState().actionError?.kind).toBe('notFound');
    await store.getState().refresh();
    expect(store.getState().tasks?.map((t) => t.title)).not.toContain('Soon gone');
  });

  it('muting closes the microphone on the Pi, and nothing in the client can open it again', async () => {
    const api = await pairedApi();
    const store = controlOn(api, FULL);
    await store.getState().refresh();
    await store.getState().mute();
    expect(store.getState().privacy?.muted).toBe(true);
    expect((await api.voice()).running).toBe(false);
    // the Pi refuses the routes that could unmute: the toggle, and the shutdown
    const headers = { Authorization: `Bearer ${(api as unknown as { token: string }).token}` };
    expect((await fetch(`http://127.0.0.1:${port}/api/privacy/mute/toggle`, { method: 'POST', headers })).status).toBe(403);
    expect((await fetch(`http://127.0.0.1:${port}/api/admin/shutdown`, { method: 'POST', headers })).status).toBe(403);
    // and auto-approve cannot be switched from a phone either
    expect((await fetch(`http://127.0.0.1:${port}/api/approval/yolo/on`, { method: 'POST', headers })).status).toBe(403);
  });

  it('heads-up times: a good list is saved, a bad one is refused and the old one stays', async () => {
    const api = await pairedApi();
    const store = controlOn(api, FULL);
    await store.getState().refresh();
    await store.getState().setReminderLeads([30, 10]);
    expect((await api.reminders()).leadMinutes).toEqual([30, 10]);
    await store.getState().setReminderLeads([999]);
    expect(store.getState().actionError?.kind).toBe('validation');
    await store.getState().refresh();
    expect(store.getState().reminders?.leadMinutes).toEqual([30, 10]);
  });

  it('persona and proactivity changes land on the Pi, and a persona brings its own proactivity', async () => {
    const api = await pairedApi();
    const store = controlOn(api, FULL);
    await store.getState().refresh();
    const other = store.getState().persona?.options.find((o) => o.id !== store.getState().persona?.current);
    expect(other).toBeDefined();
    await store.getState().setPersona(other?.id as string);
    expect((await api.persona()).current).toBe(other?.id);
    expect(store.getState().proactivity?.level).toBe(other?.proactivity);
    await store.getState().setProactivity('chatty');
    expect((await api.proactivity()).level).toBe('chatty');
  });

  it('a phone with only the chat permission: tasks work, control sections are not even asked for', async () => {
    const api = await pairedApi('chat');
    const store = controlOn(api, ['chat']);
    await store.getState().refresh();
    const s = store.getState();
    expect(s.tasks).not.toBeNull();
    expect(s.persona).not.toBeNull();
    expect(s.privacy).toBeNull();
    expect(s.reminders).toBeNull();
    expect(s.errors).toEqual({});
  });

  it('the Pi refuses a phone that asks for more than it was given, and the store records it as forbidden', async () => {
    const api = await pairedApi('chat');
    const store = controlOn(api, FULL); // the app believes it may, the Pi says no
    await store.getState().refresh();
    expect(store.getState().errors.privacy?.kind).toBe('forbidden');
    expect(store.getState().errors.voice?.kind).toBe('forbidden');
    expect(store.getState().errors.activity?.kind).toBe('forbidden');
    expect(store.getState().tasks).not.toBeNull();
  });

  it('polling keeps the page fresh', async () => {
    const api = await pairedApi();
    const store = controlOn(api, FULL);
    store.getState().startPolling();
    await new Promise((r) => setTimeout(r, 150));
    await api.addTask('Added from somewhere else');
    for (let i = 0; i < 40 && !store.getState().tasks?.some((t) => t.title === 'Added from somewhere else'); i++) await new Promise((r) => setTimeout(r, 50));
    store.getState().stopPolling();
    expect(store.getState().tasks?.some((t) => t.title === 'Added from somewhere else')).toBe(true);
  });
});
