import { createPreferencesStore, DEFAULT_PREFERENCES, normalizePreferences, PREFS_KEY } from '../src/state/preferences';
import { memoryStorage, type KeyValueStore } from '../src/state/storage';

describe('normalizePreferences', () => {
  it('keeps good values', () => {
    expect(normalizePreferences({ speechRate: 1.2, speechPitch: 0.9, lookStyle: 'read_text', haptics: false })).toEqual({
      speechRate: 1.2, speechPitch: 0.9, lookStyle: 'read_text', haptics: false,
    });
  });

  it('falls back to the default for anything broken, one field at a time', () => {
    expect(normalizePreferences({ speechRate: 'fast', speechPitch: NaN, lookStyle: 'artistic', haptics: 'yes' })).toEqual(DEFAULT_PREFERENCES);
    expect(normalizePreferences({ speechRate: 1.3, lookStyle: 'artistic' })).toEqual({ ...DEFAULT_PREFERENCES, speechRate: 1.3 });
  });

  it('keeps speech within what the phone can sensibly do', () => {
    expect(normalizePreferences({ speechRate: 99, speechPitch: -3 })).toMatchObject({ speechRate: 2, speechPitch: 0.5 });
    expect(normalizePreferences({ speechRate: Infinity }).speechRate).toBe(1);
  });

  it.each([null, undefined, 'text', 5, []])('survives %j', (raw) => expect(normalizePreferences(raw)).toEqual(DEFAULT_PREFERENCES));

  it('a change is applied on top of the current choices', () => {
    const base = { ...DEFAULT_PREFERENCES, speechRate: 1.4, haptics: false };
    expect(normalizePreferences({ lookStyle: 'detailed' }, base)).toEqual({ ...base, lookStyle: 'detailed' });
  });
});

describe('the preferences store', () => {
  it('starts with the defaults, and loading with nothing saved keeps them', async () => {
    const store = createPreferencesStore(memoryStorage());
    expect(store.getState().loaded).toBe(false);
    await store.getState().load();
    expect(store.getState()).toMatchObject({ loaded: true, prefs: DEFAULT_PREFERENCES });
  });

  it('what was saved comes back after a restart', async () => {
    const storage = memoryStorage();
    const first = createPreferencesStore(storage);
    await first.getState().update({ speechRate: 1.2, lookStyle: 'detailed' });
    const second = createPreferencesStore(storage);
    await second.getState().load();
    expect(second.getState().prefs).toMatchObject({ speechRate: 1.2, lookStyle: 'detailed', haptics: true });
  });

  it('a corrupt saved value is ignored, not fatal', async () => {
    const store = createPreferencesStore(memoryStorage({ [PREFS_KEY]: '{not json' }));
    await store.getState().load();
    expect(store.getState().prefs).toEqual(DEFAULT_PREFERENCES);
    expect(store.getState().loaded).toBe(true);
  });

  it('a saved value with some bad fields keeps the good ones', async () => {
    const store = createPreferencesStore(memoryStorage({ [PREFS_KEY]: JSON.stringify({ speechRate: 1.1, lookStyle: 'nonsense' }) }));
    await store.getState().load();
    expect(store.getState().prefs).toEqual({ ...DEFAULT_PREFERENCES, speechRate: 1.1 });
  });

  it('an unreadable store is the same as nothing saved', async () => {
    const broken: KeyValueStore = { get: async () => { throw new Error('keystore'); }, set: async () => undefined, remove: async () => undefined };
    const store = createPreferencesStore(broken);
    await store.getState().load();
    expect(store.getState().prefs).toEqual(DEFAULT_PREFERENCES);
  });

  it('a change applies at once, even if saving it fails', async () => {
    const broken: KeyValueStore = { get: async () => null, set: async () => { throw new Error('disk full'); }, remove: async () => undefined };
    const store = createPreferencesStore(broken);
    await store.getState().update({ haptics: false });
    expect(store.getState().prefs.haptics).toBe(false);
  });

  it('out-of-range changes are clamped before they are used or saved', async () => {
    const storage = memoryStorage();
    const store = createPreferencesStore(storage);
    await store.getState().update({ speechRate: 50 });
    expect(store.getState().prefs.speechRate).toBe(2);
    expect(JSON.parse(storage.data.get(PREFS_KEY) as string).speechRate).toBe(2);
  });
});
