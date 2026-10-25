import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

import type { VisionStyle } from '../api/types';
import { secureStorage, type KeyValueStore } from './storage';

export const PREFS_KEY = 'veda.prefs.v1';

export type Preferences = {
  /** 1 is normal. */
  speechRate: number;
  speechPitch: number;
  /** The mode chosen on the Look screen when the app opens. */
  lookStyle: VisionStyle;
  /** Small vibrations on the shutter, on success and on failure. */
  haptics: boolean;
};

export const DEFAULT_PREFERENCES: Preferences = { speechRate: 1, speechPitch: 1, lookStyle: 'brief', haptics: true };

export const RATE_RANGE = { min: 0.5, max: 2 } as const;
export const PITCH_RANGE = { min: 0.5, max: 2 } as const;

const STYLES: VisionStyle[] = ['brief', 'detailed', 'read_text'];
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/** Turn anything read from storage (or a partial change) into valid preferences. Unknown or broken values fall back to the default. */
export function normalizePreferences(raw: unknown, base: Preferences = DEFAULT_PREFERENCES): Preferences {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const number = (v: unknown, fallback: number, min: number, max: number) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, min, max) : fallback);
  return {
    speechRate: number(r.speechRate, base.speechRate, RATE_RANGE.min, RATE_RANGE.max),
    speechPitch: number(r.speechPitch, base.speechPitch, PITCH_RANGE.min, PITCH_RANGE.max),
    lookStyle: STYLES.includes(r.lookStyle as VisionStyle) ? (r.lookStyle as VisionStyle) : base.lookStyle,
    haptics: typeof r.haptics === 'boolean' ? r.haptics : base.haptics,
  };
}

export type PreferencesState = {
  prefs: Preferences;
  /** Saved choices have been read (until then the defaults are in use). */
  loaded: boolean;
  load(): Promise<void>;
  update(change: Partial<Preferences>): Promise<void>;
};

export function createPreferencesStore(storage: KeyValueStore = secureStorage) {
  return createStore<PreferencesState>((set, get) => ({
    prefs: DEFAULT_PREFERENCES,
    loaded: false,

    async load() {
      let saved: unknown = null;
      try {
        const text = await storage.get(PREFS_KEY);
        saved = text ? JSON.parse(text) : null;
      } catch {
        saved = null; // unreadable or corrupt: start from the defaults
      }
      set({ prefs: normalizePreferences(saved), loaded: true });
    },

    async update(change) {
      const prefs = normalizePreferences(change, get().prefs);
      set({ prefs });
      try {
        await storage.set(PREFS_KEY, JSON.stringify(prefs));
      } catch {
        // the choice still applies until the app closes; losing the saved copy is not worth an error
      }
    },
  }));
}

/** The app's one set of preferences. */
export const preferencesStore = createPreferencesStore();

export function usePreferences<T>(selector: (s: PreferencesState) => T): T {
  return useStore(preferencesStore, selector);
}
