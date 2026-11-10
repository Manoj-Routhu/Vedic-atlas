import { VedaApi } from '../src/api/client';
import { DemoApi } from '../src/api/demo';
import { FakeTransport, json } from './helpers/fakeTransport';

function setup(reply: Parameters<typeof json>[1], status = 200) {
  const t = new FakeTransport(() => json(status, reply));
  const api = new VedaApi({ host: '192.168.1.20', port: 8000, token: 'tok', transport: t });
  return { api, t };
}

const body = (t: FakeTransport) => JSON.parse(String(t.last.body ?? 'null'));

const PLAYING = { available: true, reason: null, state: 'playing', title: 'Tum Hi Ho - Arijit Singh', elapsed_s: 170.5, limit_s: 300, duration_s: 262 };

describe('Music calls: what is sent and how the answer is read', () => {
  it('status is a GET and is read into the app\'s words', async () => {
    const { api, t } = setup(PLAYING);
    expect(await api.musicStatus()).toEqual({
      available: true, reason: null, state: 'playing', title: 'Tum Hi Ho - Arijit Singh', elapsedS: 170.5, limitS: 300, durationS: 262, seekable: false,
    });
    expect(t.last).toMatchObject({ method: 'GET', url: 'http://192.168.1.20:8000/api/music/status' });
  });

  it('play sends the words and nothing else', async () => {
    const { api, t } = setup({ ...PLAYING, state: 'starting', elapsed_s: null });
    const r = await api.playSong('tum hi ho');
    expect(t.last).toMatchObject({ method: 'POST', url: 'http://192.168.1.20:8000/api/music/play' });
    expect(body(t)).toEqual({ query: 'tum hi ho' });
    expect(r).toMatchObject({ state: 'starting', elapsedS: null });
  });

  it('stop, pause and resume are bare POSTs', async () => {
    const { api, t } = setup(PLAYING);
    await api.stopMusic();
    expect(t.last).toMatchObject({ method: 'POST', url: expect.stringContaining('/api/music/stop') });
    await api.pauseMusic();
    expect(t.last).toMatchObject({ method: 'POST', url: expect.stringContaining('/api/music/pause') });
    await api.resumeMusic();
    expect(t.last).toMatchObject({ method: 'POST', url: expect.stringContaining('/api/music/resume') });
  });

  it('says whether the song can be jumped in; an older Pi that does not say means no', async () => {
    expect(await setup({ ...PLAYING, seekable: true }).api.musicStatus()).toMatchObject({ seekable: true });
    expect(await setup(PLAYING).api.musicStatus()).toMatchObject({ seekable: false });
    expect(await setup({ ...PLAYING, seekable: 'yes' }).api.musicStatus()).toMatchObject({ seekable: false });
    expect(await setup({ available: false, seekable: true }).api.musicStatus()).toMatchObject({ seekable: false });
  });

  it('seek sends the place in seconds and nothing else, and reads the new status', async () => {
    const { api, t } = setup({ ...PLAYING, elapsed_s: 90, seekable: true });
    const r = await api.seekMusic(90);
    expect(t.last).toMatchObject({ method: 'POST', url: 'http://192.168.1.20:8000/api/music/seek' });
    expect(body(t)).toEqual({ position_s: 90 });
    expect(r).toMatchObject({ state: 'playing', elapsedS: 90, seekable: true });
  });

  it('music that is off says why, and is never "playing"', async () => {
    const { api } = setup({ available: false, reason: 'tools_missing', state: 'playing', title: 'x' });
    expect(await api.musicStatus()).toMatchObject({ available: false, reason: 'tools_missing', state: 'idle' });
  });

  it('an unknown state or reason is made safe rather than trusted', async () => {
    expect(await setup({ available: true, state: 'dancing' }).api.musicStatus()).toMatchObject({ state: 'idle' });
    expect(await setup({ available: false, reason: 'weird' }).api.musicStatus()).toMatchObject({ reason: 'off' });
    expect(await setup({ available: true, state: 'playing', elapsed_s: -5, limit_s: 'x' }).api.musicStatus()).toMatchObject({ elapsedS: null, limitS: null });
  });

  it('an answer with no "available" is a bad response, not a guess', async () => {
    await expect(setup({ state: 'idle' }).api.musicStatus()).rejects.toMatchObject({ kind: 'badResponse' });
  });
});

describe('Music failures, in plain words', () => {
  const err = (status: number, code: string, message = '') => setup({ error: { code, message } }, status).api;

  it('404 with MUSIC_NOT_FOUND is "could not find that song"; any other 404 stays "not found"', async () => {
    await expect(err(404, 'MUSIC_NOT_FOUND', "I couldn't find that song.").playSong('x')).rejects.toMatchObject({ kind: 'songNotFound' });
    await expect(err(404, 'OTHER').playSong('x')).rejects.toMatchObject({ kind: 'notFound' });
  });

  it('409 MUSIC_NOT_PLAYING is "nothing is playing"', async () => {
    await expect(err(409, 'MUSIC_NOT_PLAYING').pauseMusic()).rejects.toMatchObject({ kind: 'nothingPlaying' });
  });

  it('409 MUSIC_NOT_SEEKABLE and 502 MUSIC_SEEK_FAILED are said in plain words', async () => {
    await expect(err(409, 'MUSIC_NOT_SEEKABLE').seekMusic(5)).rejects.toMatchObject({ kind: 'notSeekable' });
    await expect(err(502, 'MUSIC_SEEK_FAILED', "Couldn't jump just now. Try again.").seekMusic(5)).rejects.toMatchObject({ kind: 'seekFailed' });
    await expect(err(409, 'MUSIC_NOT_PLAYING').seekMusic(5)).rejects.toMatchObject({ kind: 'nothingPlaying' });
  });

  it('503 MUSIC_UNAVAILABLE is "music is not available", not a vision or memory problem', async () => {
    await expect(err(503, 'MUSIC_UNAVAILABLE', 'Music is unavailable: tools_missing').playSong('x')).rejects.toMatchObject({ kind: 'musicOff' });
  });

  it('the Pi\'s own wording is kept for logs but never becomes the message', async () => {
    try {
      await err(404, 'MUSIC_NOT_FOUND', 'some internal detail').playSong('x');
    } catch (e) {
      expect((e as Error).message).not.toContain('internal');
    }
  });
});

describe('the demo behaves like the real thing', () => {
  it('plays, pauses with the clock stopped, resumes, and stops', async () => {
    const demo = new DemoApi();
    expect((await demo.musicStatus()).state).toBe('idle');
    const started = await demo.playSong('tum hi ho');
    expect(started).toMatchObject({ state: 'playing', title: 'tum hi ho (demo)', limitS: 255, durationS: 240, seekable: true });
    const paused = await demo.pauseMusic();
    await new Promise((r) => setTimeout(r, 30));
    expect((await demo.musicStatus()).elapsedS).toBe(paused.elapsedS);
    expect((await demo.resumeMusic()).state).toBe('playing');
    expect((await demo.stopMusic()).state).toBe('idle');
    await expect(demo.pauseMusic()).rejects.toMatchObject({ kind: 'nothingPlaying' });
  });

  it('jumps in the pretend song, stays inside it, and keeps a pause paused', async () => {
    const demo = new DemoApi();
    await expect(demo.seekMusic(30)).rejects.toMatchObject({ kind: 'nothingPlaying' });
    await demo.playSong('tum hi ho');
    expect((await demo.seekMusic(120)).elapsedS).toBeGreaterThanOrEqual(120);
    expect((await demo.seekMusic(-5)).elapsedS).toBeLessThan(1);
    expect((await demo.seekMusic(9_999)).elapsedS).toBeGreaterThanOrEqual(238);
    await demo.pauseMusic();
    const paused = await demo.seekMusic(60);
    await new Promise((r) => setTimeout(r, 30));
    expect(paused).toMatchObject({ state: 'paused', elapsedS: 60 });
    expect((await demo.musicStatus()).elapsedS).toBe(60);
  });
});
