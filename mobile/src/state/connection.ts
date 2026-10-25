import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

import { VedaApi } from '../api/client';
import { DemoApi } from '../api/demo';
import { ApiError, apiErrorFromThrown } from '../api/errors';
import type { PiApi } from '../api/pi';
import { fetchTransport, type HttpTransport } from '../api/transport';
import { buildBaseUrl } from '../util/hostCheck';
import { normalizeCode } from '../util/qr';
import { secureStorage, type KeyValueStore } from './storage';

export const STORAGE_KEY = 'veda.connection.v1';

/** loading: reading the saved pairing. unpaired: show pairing. paired: a real Pi. demo: canned answers, nothing saved. */
export type Phase = 'loading' | 'unpaired' | 'paired' | 'demo';
export type Link = 'unknown' | 'connected' | 'unreachable';

export type Saved = { host: string; port: number; token: string; deviceId: string; deviceName: string; scopes: string[] };

export type ConnectionState = {
  phase: Phase;
  saved: Saved | null;
  link: Link;
  /** Shown once on the pairing screen after the Pi removed this phone. */
  notice: 'removed' | null;
  load(): Promise<void>;
  pair(input: { host: string; port: number; code: string; deviceName: string }): Promise<void>;
  enterDemo(): void;
  forget(reason?: 'removed'): Promise<void>;
  setLink(link: Link): void;
  /** Feed any error from an API call here: a 401 means the Pi removed this phone, a dead connection marks the link. */
  handleError(e: unknown): void;
  dismissNotice(): void;
  /** The API the screens use, or null before pairing. */
  api(): PiApi | null;
  /** Ask the Pi if it is there. Resolves with how long it took in milliseconds; throws the ApiError if not. Updates the link. */
  testConnection(): Promise<number>;
  /**
   * Point this phone at a different address for the same Pi (its address changed). The saved token is tried at the new
   * address first, and nothing is saved unless that Pi accepts it. Throws an ApiError (hostNotAllowed for a public address).
   */
  changeAddress(host: string, port: number): Promise<void>;
};

export type Deps = {
  storage: KeyValueStore;
  makeTransport: () => HttpTransport;
  makeDemo: () => PiApi;
};

const defaultDeps = (): Deps => ({ storage: secureStorage, makeTransport: () => fetchTransport(), makeDemo: () => new DemoApi() });

function parseSaved(raw: string | null): Saved | null {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Partial<Saved>;
    if (
      typeof s.host !== 'string' || typeof s.port !== 'number' || typeof s.token !== 'string' || s.token === '' ||
      typeof s.deviceId !== 'string' || typeof s.deviceName !== 'string' || !Array.isArray(s.scopes) ||
      !buildBaseUrl(s.host, s.port) // an address that is not on a private network is never trusted, even if it was saved
    ) {
      return null;
    }
    return { host: s.host, port: s.port, token: s.token, deviceId: s.deviceId, deviceName: s.deviceName, scopes: s.scopes.map(String) };
  } catch {
    return null;
  }
}

export function createConnectionStore(deps: Deps = defaultDeps()) {
  let cached: { key: string; api: PiApi } | null = null;
  let demo: PiApi | null = null;

  return createStore<ConnectionState>((set, get) => ({
    phase: 'loading',
    saved: null,
    link: 'unknown',
    notice: null,

    async load() {
      const saved = parseSaved(await deps.storage.get(STORAGE_KEY));
      if (saved) {
        set({ phase: 'paired', saved, link: 'unknown' });
      } else {
        await deps.storage.remove(STORAGE_KEY); // clears anything corrupt or unsafe
        set({ phase: 'unpaired', saved: null });
      }
    },

    async pair({ host, port, code, deviceName }) {
      const api = new VedaApi({ host, port, transport: deps.makeTransport() }); // throws ApiError('hostNotAllowed') for a public host
      const name = deviceName.trim() || 'My phone';
      const result = await api.pair(normalizeCode(code), name);
      const saved: Saved = { host: host.trim(), port, token: result.token, deviceId: result.deviceId, deviceName: name, scopes: result.scopes };
      try {
        await deps.storage.set(STORAGE_KEY, JSON.stringify(saved));
      } catch (e) {
        throw new ApiError('storage', { serverMessage: e instanceof Error ? e.message : String(e) });
      }
      cached = null;
      set({ phase: 'paired', saved, link: 'connected', notice: null });
    },

    enterDemo() {
      demo = deps.makeDemo();
      set({ phase: 'demo', saved: null, link: 'connected', notice: null });
    },

    async forget(reason) {
      await deps.storage.remove(STORAGE_KEY);
      cached = null;
      demo = null;
      set({ phase: 'unpaired', saved: null, link: 'unknown', notice: reason ?? null });
    },

    setLink(link) {
      if (get().link !== link) set({ link });
    },

    handleError(e) {
      const err = apiErrorFromThrown(e);
      if (get().phase !== 'paired') return;
      if (err.kind === 'unauthorized') void get().forget('removed');
      else if (err.kind === 'unreachable' || err.kind === 'timeout') get().setLink('unreachable');
    },

    dismissNotice() {
      set({ notice: null });
    },

    async testConnection() {
      const api = get().api();
      if (!api) throw new ApiError('unreachable');
      const started = Date.now();
      try {
        await api.health();
      } catch (e) {
        const err = apiErrorFromThrown(e);
        get().handleError(err);
        throw err;
      }
      get().setLink('connected');
      return Math.max(0, Date.now() - started);
    },

    async changeAddress(host, port) {
      const { phase, saved } = get();
      if (phase !== 'paired' || !saved) throw new ApiError('unreachable');
      const address = host.trim();
      const probe = new VedaApi({ host: address, port, token: saved.token, transport: deps.makeTransport() }); // refuses a public address
      try {
        await probe.health();
      } catch (e) {
        throw apiErrorFromThrown(e); // not saved: the old address keeps working
      }
      const next: Saved = { ...saved, host: address, port };
      try {
        await deps.storage.set(STORAGE_KEY, JSON.stringify(next));
      } catch (e) {
        throw new ApiError('storage', { serverMessage: e instanceof Error ? e.message : String(e) });
      }
      cached = null;
      set({ saved: next, link: 'connected' });
    },

    api() {
      const { phase, saved } = get();
      if (phase === 'demo') return demo;
      if (phase !== 'paired' || !saved) return null;
      const key = `${saved.host}:${saved.port}:${saved.token}`;
      if (!cached || cached.key !== key) {
        cached = { key, api: new VedaApi({ host: saved.host, port: saved.port, token: saved.token, transport: deps.makeTransport() }) };
      }
      return cached.api;
    },
  }));
}

/** The app's one connection. */
export const connectionStore = createConnectionStore();

export function useConnection<T>(selector: (s: ConnectionState) => T): T {
  return useStore(connectionStore, selector);
}
