import { createStore } from 'zustand/vanilla';

import { ApiError, apiErrorFromThrown } from '../../api/errors';
import type { ActivityItem, PersonaInfo, PiTask, PrivacyInfo, ProactivityInfo, RemindersInfo, VisionStatus, VoiceInfo } from '../../api/types';
import type { PiApi } from '../../api/pi';

export type SectionName = 'autoApprove' | 'vision' | 'privacy' | 'voice' | 'tasks' | 'reminders' | 'persona' | 'proactivity' | 'activity';

export type ControlDeps = {
  getApi: () => PiApi | null;
  /** What this phone was allowed when it was paired. Demo mode allows everything. */
  scopes: () => string[];
  /** Told about every failure so the connection can react (a removed phone, an unreachable Pi). */
  onApiError?: (e: ApiError) => void;
  now?: () => number;
  /** How often to refresh while the screen is open. */
  refreshMs?: number;
};

export type ControlState = {
  /** How long the Pi took to answer, in milliseconds (null: not measured, or it did not answer). */
  onlineMs: number | null;
  autoApprove: boolean | null;
  vision: VisionStatus | null;
  privacy: PrivacyInfo | null;
  voice: VoiceInfo | null;
  tasks: PiTask[] | null;
  reminders: RemindersInfo | null;
  persona: PersonaInfo | null;
  proactivity: ProactivityInfo | null;
  activity: ActivityItem[] | null;
  /** Sections that could not be loaded last time (the old data, if any, stays on screen). */
  errors: Partial<Record<SectionName, ApiError>>;
  /** The first load has not finished. */
  loading: boolean;
  refreshing: boolean;
  /** The last change the user asked for that did not work. */
  actionError: ApiError | null;
};

export type ControlActions = {
  refresh(): Promise<void>;
  startPolling(): void;
  stopPolling(): void;
  /** Close the Pi's microphone. */
  mute(): Promise<void>;
  addTask(title: string): Promise<void>;
  completeTask(id: number): Promise<void>;
  setReminderLeads(minutes: number[]): Promise<void>;
  setPersona(id: string): Promise<void>;
  setProactivity(level: string): Promise<void>;
  dismissActionError(): void;
  reset(): void;
};

/** The heads-up times the Pi accepts: 1 to 120 minutes, at most five of them. */
export function parseLeadMinutes(text: string): number[] | null {
  const parts = text.split(/[,\s]+/).filter(Boolean);
  if (parts.length === 0 || parts.length > 5) return null;
  const minutes = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  if (minutes.some((m) => !(m >= 1 && m <= 120))) return null;
  return [...new Set(minutes)].sort((a, b) => b - a);
}

const MAX_TASK_TITLE = 200;

const EMPTY: ControlState = {
  onlineMs: null, autoApprove: null, vision: null, privacy: null, voice: null, tasks: null, reminders: null, persona: null,
  proactivity: null, activity: null, errors: {}, loading: true, refreshing: false, actionError: null,
};

export function createControlStore(deps: ControlDeps) {
  const now = deps.now ?? Date.now;
  const refreshMs = deps.refreshMs ?? 10_000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let polling = false;
  let inFlight: Promise<void> | null = null;
  let generation = 0; // bumped by reset(), so a refresh that finishes afterwards is ignored

  return createStore<ControlState & ControlActions>((set, get) => {
    const has = (scope: string) => deps.scopes().includes(scope);

    const report = (e: unknown): ApiError => {
      const err = apiErrorFromThrown(e);
      if (err.kind !== 'cancelled') deps.onApiError?.(err);
      return err;
    };

    async function doRefresh() {
      const api = deps.getApi();
      if (!api) {
        set({ loading: false });
        return;
      }
      const gen = generation;
      set({ refreshing: true });

      const errors: ControlState['errors'] = {};
      const patch: Partial<ControlState> = {};
      let reported = false;
      const take = async <T>(name: SectionName, allowed: boolean, load: () => Promise<T>, put: (value: T) => void) => {
        if (!allowed) return;
        try {
          put(await load());
        } catch (e) {
          const err = apiErrorFromThrown(e);
          if (err.kind === 'cancelled') return;
          errors[name] = err;
          if (!reported && (err.kind === 'unreachable' || err.kind === 'timeout' || err.kind === 'unauthorized')) {
            reported = true;
            report(err); // one report per refresh is enough for the connection to react
          }
        }
      };

      const started = now();
      await Promise.all([
        take('autoApprove', has('control'), () => api.autoApprove(), (v) => (patch.autoApprove = v)),
        take('vision', has('vision'), () => api.visionStatus(), (v) => (patch.vision = v)),
        take('privacy', has('control'), () => api.privacy(), (v) => (patch.privacy = v)),
        take('voice', has('control'), () => api.voice(), (v) => (patch.voice = v)),
        take('tasks', has('chat'), () => api.tasks(), (v) => (patch.tasks = v)),
        take('reminders', has('control'), () => api.reminders(), (v) => (patch.reminders = v)),
        take('persona', has('chat'), () => api.persona(), (v) => (patch.persona = v)),
        take('proactivity', has('control'), () => api.proactivity(), (v) => (patch.proactivity = v)),
        take('activity', has('control'), () => api.activity(5), (v) => (patch.activity = v)),
        (async () => {
          try {
            await api.health();
            patch.onlineMs = Math.max(0, now() - started);
          } catch (e) {
            const err = apiErrorFromThrown(e);
            if (err.kind !== 'cancelled') patch.onlineMs = null;
          }
        })(),
      ]);

      if (gen !== generation) return;
      set({ ...patch, errors, loading: false, refreshing: false });
    }

    const refresh = () => (inFlight ??= doRefresh().finally(() => (inFlight = null)));

    const schedule = () => {
      if (!polling) return;
      timer = setTimeout(async () => {
        await refresh();
        schedule();
      }, refreshMs);
    };

    /** Run a change; on failure remember why, and re-read the Pi so the screen shows what is really true. */
    async function change(work: (api: PiApi) => Promise<void>, rollback?: () => void) {
      const api = deps.getApi();
      if (!api) return;
      set({ actionError: null });
      try {
        await work(api);
      } catch (e) {
        const err = report(e);
        rollback?.();
        if (err.kind !== 'cancelled') set({ actionError: err });
        void refresh();
      }
    }

    return {
      ...EMPTY,

      refresh,

      startPolling() {
        if (polling) return;
        polling = true;
        void refresh().then(schedule);
      },

      stopPolling() {
        polling = false;
        if (timer) clearTimeout(timer);
        timer = null;
      },

      async mute() {
        await change(async (api) => set({ privacy: await api.mute() }));
      },

      async addTask(title) {
        const text = title.trim().slice(0, MAX_TASK_TITLE);
        if (!text) return;
        await change(async (api) => {
          const task = await api.addTask(text);
          set({ tasks: [...(get().tasks ?? []), task] });
        });
      },

      async completeTask(id) {
        const before = get().tasks;
        set({ tasks: (before ?? []).filter((t) => t.id !== id) });
        await change((api) => api.completeTask(id), () => set({ tasks: before }));
      },

      async setReminderLeads(minutes) {
        await change(async (api) => {
          await api.setReminderLeads(minutes);
          const current = get().reminders;
          if (current) set({ reminders: { ...current, leadMinutes: minutes } });
          void refresh();
        });
      },

      async setPersona(id) {
        const before = get().persona;
        if (before) set({ persona: { ...before, current: id } });
        await change(async (api) => {
          await api.setPersona(id);
          // a persona carries its own proactivity level, so read both again
          const [persona, proactivity] = await Promise.all([api.persona(), api.proactivity()]);
          set({ persona, proactivity });
        }, () => set({ persona: before }));
      },

      async setProactivity(level) {
        const before = get().proactivity;
        if (before) set({ proactivity: { ...before, level } });
        await change((api) => api.setProactivity(level), () => set({ proactivity: before }));
      },

      dismissActionError() {
        set({ actionError: null });
      },

      reset() {
        generation++;
        get().stopPolling();
        set({ ...EMPTY });
      },
    };
  });
}

export type ControlStore = ReturnType<typeof createControlStore>;
