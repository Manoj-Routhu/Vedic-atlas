import type { ControlApi } from './control';
import { ApiError } from './errors';
import type { ActivityItem, PersonaInfo, PiTask, PrivacyInfo, ProactivityInfo, RemindersInfo, VoiceInfo } from './types';

/** The one thing the control calls need from the client: send a small JSON request and give back the parsed answer. */
export type JsonSender = (req: { method: 'GET' | 'POST' | 'PUT'; path: string; json?: unknown }, signal?: AbortSignal) => Promise<unknown>;

type RawTask = { id: number; title: string; done?: boolean; notes?: string; due_at?: string | null };

const toTask = (t: RawTask): PiTask => ({ id: t.id, title: t.title, done: t.done === true, notes: t.notes ?? '', dueAt: t.due_at ?? null });

function toPrivacy(raw: unknown): PrivacyInfo {
  const r = raw as { muted?: boolean; source?: string; hardware_switch?: boolean } | null;
  if (!r || typeof r.muted !== 'boolean') throw new ApiError('badResponse');
  return { muted: r.muted, source: r.source ?? '', hardwareSwitch: r.hardware_switch === true };
}

/** Maps the Pi's Control endpoints onto the app's types. `VedaApi` delegates to this; it holds no connection itself. */
export function controlCalls(send: JsonSender): ControlApi {
  return {
    async autoApprove(signal) {
      const r = (await send({ method: 'GET', path: '/api/approval/yolo' }, signal)) as { yolo?: boolean } | null;
      return r?.yolo === true;
    },

    async privacy(signal) {
      return toPrivacy(await send({ method: 'GET', path: '/api/privacy/status' }, signal));
    },

    async mute(signal) {
      return toPrivacy(await send({ method: 'POST', path: '/api/privacy/mute', json: { muted: true } }, signal));
    },

    async voice(signal): Promise<VoiceInfo> {
      const r = (await send({ method: 'GET', path: '/api/voice/status' }, signal)) as { available?: boolean; running?: boolean } | null;
      return { available: r?.available === true, running: r?.running === true };
    },

    async tasks(signal) {
      const r = (await send({ method: 'GET', path: '/api/tasks' }, signal)) as { tasks?: RawTask[] } | null;
      return (r?.tasks ?? []).map(toTask);
    },

    async addTask(title, signal) {
      const r = (await send({ method: 'POST', path: '/api/tasks', json: { title } }, signal)) as RawTask | null;
      if (!r || typeof r.id !== 'number') throw new ApiError('badResponse');
      return toTask(r);
    },

    async completeTask(id, signal) {
      await send({ method: 'POST', path: `/api/tasks/${encodeURIComponent(String(id))}/complete` }, signal);
    },

    async reminders(signal): Promise<RemindersInfo> {
      const r = (await send({ method: 'GET', path: '/api/reminders/status' }, signal)) as {
        running?: boolean;
        last_sync_ok?: boolean | null;
        pending?: number;
        next_due_at?: string | null;
        config?: { enabled?: boolean; lead_minutes?: number[]; at_start?: boolean; skip_all_day?: boolean };
      } | null;
      if (!r) throw new ApiError('badResponse');
      const c = r.config ?? {};
      return {
        running: r.running === true,
        lastSyncOk: r.last_sync_ok ?? null,
        pending: r.pending ?? 0,
        nextDueAt: r.next_due_at ?? null,
        enabled: c.enabled === true,
        leadMinutes: c.lead_minutes ?? [],
        atStart: c.at_start === true,
        skipAllDay: c.skip_all_day === true,
      };
    },

    async setReminderLeads(minutes, signal) {
      await send({ method: 'PUT', path: '/api/reminders/config', json: { lead_minutes: minutes } }, signal);
    },

    async persona(signal): Promise<PersonaInfo> {
      const r = (await send({ method: 'GET', path: '/api/persona' }, signal)) as {
        state?: { persona?: string | null };
        catalog?: { id: string; label: string; tagline: string; proactivity: string }[];
      } | null;
      return {
        current: r?.state?.persona ?? null,
        options: (r?.catalog ?? []).map((p) => ({ id: p.id, label: p.label, tagline: p.tagline, proactivity: p.proactivity })),
      };
    },

    async setPersona(id, signal) {
      await send({ method: 'POST', path: '/api/persona', json: { persona: id } }, signal);
    },

    async proactivity(signal): Promise<ProactivityInfo> {
      const r = (await send({ method: 'GET', path: '/api/config/proactivity' }, signal)) as { level?: string; valid?: string[] } | null;
      return { level: r?.level ?? '', options: r?.valid ?? [] };
    },

    async setProactivity(level, signal) {
      await send({ method: 'POST', path: '/api/config/proactivity', json: { level } }, signal);
    },

    async activity(limit = 5, signal): Promise<ActivityItem[]> {
      const n = Math.max(1, Math.min(50, Math.floor(limit)));
      const r = (await send({ method: 'GET', path: `/api/trace?limit=${n}` }, signal)) as {
        traces?: { id: number; created_at: string; agent: string; total_ms: number; calls?: { tool: string; ok: boolean; ms: number }[] }[];
      } | null;
      return (r?.traces ?? []).map((t) => ({
        id: t.id,
        at: t.created_at,
        agent: t.agent,
        totalMs: t.total_ms,
        tools: (t.calls ?? []).map((c) => ({ name: c.tool, ok: c.ok, ms: c.ms })),
      }));
    },
  };
}
