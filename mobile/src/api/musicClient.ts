import { ApiError } from './errors';
import type { JsonSender } from './controlClient';
import type { MusicApi } from './music';
import type { MusicInfo, MusicOffReason, MusicState } from './types';

const STATES: MusicState[] = ['idle', 'starting', 'playing', 'paused'];
const REASONS: MusicOffReason[] = ['off', 'offline', 'tools_missing'];

type RawMusic = {
  available?: boolean;
  reason?: string | null;
  state?: string;
  title?: string | null;
  elapsed_s?: number | null;
  limit_s?: number | null;
  duration_s?: number | null;
};

const number = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

function toMusic(raw: unknown): MusicInfo {
  const r = raw as RawMusic | null;
  if (!r || typeof r.available !== 'boolean') throw new ApiError('badResponse');
  const state = STATES.includes(r.state as MusicState) ? (r.state as MusicState) : 'idle';
  const reason = REASONS.includes(r.reason as MusicOffReason) ? (r.reason as MusicOffReason) : null;
  return {
    available: r.available,
    reason: r.available ? null : (reason ?? 'off'),
    state: r.available ? state : 'idle',
    title: typeof r.title === 'string' && r.title !== '' ? r.title : null,
    elapsedS: number(r.elapsed_s),
    limitS: number(r.limit_s),
    durationS: number(r.duration_s),
  };
}

/** Maps the Pi's /api/music endpoints onto the app's types. `VedaApi` delegates to this; it holds no connection itself. */
export function musicCalls(send: JsonSender): MusicApi {
  return {
    async musicStatus(signal) {
      return toMusic(await send({ method: 'GET', path: '/api/music/status' }, signal));
    },
    async playSong(query, signal) {
      return toMusic(await send({ method: 'POST', path: '/api/music/play', json: { query } }, signal));
    },
    async stopMusic(signal) {
      return toMusic(await send({ method: 'POST', path: '/api/music/stop' }, signal));
    },
    async pauseMusic(signal) {
      return toMusic(await send({ method: 'POST', path: '/api/music/pause' }, signal));
    },
    async resumeMusic(signal) {
      return toMusic(await send({ method: 'POST', path: '/api/music/resume' }, signal));
    },
  };
}
