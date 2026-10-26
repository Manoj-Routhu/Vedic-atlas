/** Shapes of what the Pi sends. The vision events are the JSON inside the SSE `data:` lines (docs/15 section 6.4). */

export type VisionEvent =
  | { type: 'status'; state: string }
  | { type: 'token'; text: string }
  | { type: 'done' }
  | { type: 'error'; code: string; message: string };

/** Chat chunks are plain text in `data:` lines; the Pi ends the stream with `[DONE]`. */
export type ChatEvent = { type: 'text'; text: string } | { type: 'done' };

export type PairResult = { deviceId: string; token: string; scopes: string[] };
export type ImageInfo = { imageId: string; width: number; height: number };
export type VisionStatus = { enabled: boolean; loaded: boolean; busy: boolean; idleSeconds: number | null; model: string };

export type PendingApproval = { requestId: string; actionName: string; ageSeconds: number; summary: string };

export type VisionStyle = 'brief' | 'detailed' | 'read_text';

/** Returns null for anything that is not a known event, so a newer Pi can add event types without breaking the app. */
export function parseVisionEvent(data: string): VisionEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const e = raw as Record<string, unknown>;
  switch (e.type) {
    case 'status':
      return typeof e.state === 'string' ? { type: 'status', state: e.state } : null;
    case 'token':
      return typeof e.text === 'string' ? { type: 'token', text: e.text } : null;
    case 'done':
      return { type: 'done' };
    case 'error':
      return typeof e.code === 'string' && typeof e.message === 'string'
        ? { type: 'error', code: e.code, message: e.message }
        : null;
    default:
      return null;
  }
}

// ---------- Control (docs/16 section 4.4) ----------

export type PiTask = { id: number; title: string; done: boolean; notes: string; dueAt: string | null };

export type RemindersInfo = {
  /** The reminder service is running. */
  running: boolean;
  /** The last calendar check worked (null: not checked yet). */
  lastSyncOk: boolean | null;
  pending: number;
  nextDueAt: string | null;
  enabled: boolean;
  leadMinutes: number[];
  atStart: boolean;
  skipAllDay: boolean;
};

export type PrivacyInfo = {
  /** The Pi's microphone is closed. */
  muted: boolean;
  /** Who closed it, such as "api" or "hardware". */
  source: string;
  /** A physical switch controls it, so software cannot change it. */
  hardwareSwitch: boolean;
};

export type VoiceInfo = { available: boolean; running: boolean };

export type PersonaOption = { id: string; label: string; tagline: string; proactivity: string };
export type PersonaInfo = { current: string | null; options: PersonaOption[] };
export type ProactivityInfo = { level: string; options: string[] };

/** One thing Veda did for a request, for the "Recent activity" list. */
export type ActivityItem = { id: number; at: string; agent: string; totalMs: number; tools: { name: string; ok: boolean; ms: number }[] };

// ---------- Music (docs/17-music-in-the-app.md) ----------

export type MusicState = 'idle' | 'starting' | 'playing' | 'paused';
/** Why music is not available on the Pi: switched off in config, the Pi is in offline mode, or mpv / yt-dlp are not installed. */
export type MusicOffReason = 'off' | 'offline' | 'tools_missing';

export type MusicInfo = {
  available: boolean;
  reason: MusicOffReason | null;
  state: MusicState;
  /** The song the Pi picked, as it is spoken. */
  title: string | null;
  /** Seconds actually played (a pause does not count). Only while playing or paused. */
  elapsedS: number | null;
  /** The song stops by itself at this many seconds played. */
  limitS: number | null;
  /** The song's own length, when known. */
  durationS: number | null;
};
