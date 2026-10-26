/**
 * The Music tab driven through the real API client against the mock Pi (real permission gate, real routes, real MusicService
 * with a fake player). It proves the pieces fit over real HTTP: a song is found and named, pause stops the clock, stop gives
 * the microphone back, and a phone without the control permission is refused.
 */
import { ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { VedaApi } from '../src/api/client';
import { fetchTransport } from '../src/api/transport';
import { createMusicStore } from '../src/features/music/musicStore';

const REPO = path.resolve(__dirname, '..', '..');
const MOCK = path.join(REPO, 'scripts', 'mock_pi.py');
const PYTHON =
  process.env.VEDA_PYTHON ??
  [path.join(REPO, 'vedic-atlas-env', 'Scripts', 'python.exe'), path.join(REPO, 'vedic-atlas-env', 'bin', 'python')].find(existsSync);
const canRun = Boolean(PYTHON) && existsSync(MOCK);
const describeIfPython = canRun ? describe : describe.skip;

type Mock = { port: number; proc: ChildProcess };

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });

async function startMock(extra: string[] = []): Promise<Mock> {
  const port = await freePort();
  const proc = spawn(
    PYTHON as string,
    ['-I', MOCK, '--simulate-lan', '--state-dir', mkdtempSync(path.join(tmpdir(), 'veda-music-')), '--port', String(port), '--cold-seconds', '0.3', ...extra],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderr = '';
  proc.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
  proc.on('exit', (c) => {
    stderr += `\n(exited ${c})`;
  });
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/mock/state`)).ok) return { port, proc };
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`mock Pi did not start:\n${stderr}`);
}

async function pairedApi(mock: Mock, scopes = ''): Promise<VedaApi> {
  const q = scopes ? `?scopes=${scopes}` : '';
  const { code } = (await (await fetch(`http://127.0.0.1:${mock.port}/mock/code${q}`, { method: 'POST' })).json()) as { code: string };
  const unpaired = new VedaApi({ host: '127.0.0.1', port: mock.port, transport: fetchTransport() });
  const { token } = await unpaired.pair(code, 'Music contract phone');
  return unpaired.withToken(token);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  for (let i = 0; i < 50; i++) {
    const v = await read();
    if (ok(v)) return v;
    await sleep(50);
  }
  throw new Error('never got there');
}

describeIfPython('the Music tab against the real Pi routes (mock Pi)', () => {
  let mock: Mock;
  beforeAll(async () => {
    mock = await startMock();
  }, 60_000);
  afterAll(() => {
    mock?.proc.kill();
  });

  it('starts idle, finds and names a song, and gives the microphone back on stop', async () => {
    const api = await pairedApi(mock);
    expect(await api.musicStatus()).toMatchObject({ available: true, state: 'idle', title: null });
    const queued = await api.playSong('tum hi ho');
    expect(queued.title).toBe('Tum Hi Ho - Mock Artist');
    const playing = await until(() => api.musicStatus(), (s) => s.state === 'playing');
    expect(playing).toMatchObject({ limitS: 300, durationS: 240 });
    expect(playing.elapsedS).not.toBeNull();
    expect((await api.stopMusic()).state).toBe('idle');
  });

  it('pause freezes the clock and resume carries on', async () => {
    const api = await pairedApi(mock);
    await api.playSong('shape of you');
    await until(() => api.musicStatus(), (s) => s.state === 'playing');
    await sleep(150);
    const paused = await api.pauseMusic();
    expect(paused.state).toBe('paused');
    await sleep(300);
    expect((await api.musicStatus()).elapsedS).toBe(paused.elapsedS);
    expect((await api.resumeMusic()).state).toBe('playing');
    await api.stopMusic();
  });

  it('a song that is not found is "I could not find that song", and nothing starts', async () => {
    const api = await pairedApi(mock);
    await expect(api.playSong('zzz nothing')).rejects.toMatchObject({ kind: 'songNotFound' });
    expect((await api.musicStatus()).state).toBe('idle');
  });

  it('pause with nothing playing is "nothing is playing"', async () => {
    const api = await pairedApi(mock);
    await api.stopMusic();
    await expect(api.pauseMusic()).rejects.toMatchObject({ kind: 'nothingPlaying' });
    await expect(api.resumeMusic()).rejects.toMatchObject({ kind: 'nothingPlaying' });
  });

  it('a phone without the control permission is refused every music call', async () => {
    const api = await pairedApi(mock, 'chat,vision');
    await expect(api.musicStatus()).rejects.toMatchObject({ kind: 'forbidden' });
    await expect(api.playSong('anything')).rejects.toMatchObject({ kind: 'forbidden' });
    await expect(api.stopMusic()).rejects.toMatchObject({ kind: 'forbidden' });
  });

  it('the store drives it: asking shows the words, then the song the Pi picked, then idle after Stop', async () => {
    const api = await pairedApi(mock);
    const store = createMusicStore({ getApi: () => api, refreshMs: 50 });
    await store.getState().refresh();
    expect(store.getState().info?.state).toBe('idle');
    const asked = store.getState().play('despacito');
    expect(store.getState().asking).toBe('despacito');
    await asked;
    expect(store.getState().asking).toBeNull();
    expect(store.getState().info?.title).toBe('Despacito - Mock Artist');
    await store.getState().stop();
    expect(store.getState().info?.state).toBe('idle');
    expect(store.getState().error).toBeNull();
  });
});

describeIfPython('music that is not set up on the Pi', () => {
  let mock: Mock;
  beforeAll(async () => {
    mock = await startMock(['--music-off', 'tools_missing']);
  }, 60_000);
  afterAll(() => {
    mock?.proc.kill();
  });

  it('status still answers, with the reason; playing says music is off', async () => {
    const api = await pairedApi(mock);
    expect(await api.musicStatus()).toMatchObject({ available: false, reason: 'tools_missing', state: 'idle' });
    await expect(api.playSong('anything')).rejects.toMatchObject({ kind: 'musicOff' });
  });
});
