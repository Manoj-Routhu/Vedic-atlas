import { ApiError } from '../src/api/errors';
import { createConnectionStore, STORAGE_KEY, type Saved } from '../src/state/connection';
import { memoryStorage, type KeyValueStore } from '../src/state/storage';
import { FakeTransport, json } from './helpers/fakeTransport';

const SAVED: Saved = { host: '192.168.1.20', port: 8000, token: 'tok-abc', deviceId: 'a1b2c3d4', deviceName: 'Pixel 8', scopes: ['chat', 'vision'] };

function setup(opts: { reply?: Parameters<ConstructorParameters<typeof FakeTransport>[0]>[0] extends never ? never : unknown; storage?: KeyValueStore } = {}) {
  const storage = (opts.storage as ReturnType<typeof memoryStorage>) ?? memoryStorage();
  const transport = new FakeTransport((req) => {
    if (req.url.endsWith('/api/pair')) return json(200, { device_id: 'a1b2c3d4', token: 'tok-abc', scopes: ['chat', 'vision'] });
    return json(200, {});
  });
  const store = createConnectionStore({ storage, makeTransport: () => transport, makeDemo: () => ({}) as never });
  return { storage: storage as ReturnType<typeof memoryStorage>, transport, store };
}

describe('load', () => {
  it('starts in "loading" and becomes "unpaired" when nothing is saved', async () => {
    const { store } = setup();
    expect(store.getState().phase).toBe('loading');
    await store.getState().load();
    expect(store.getState().phase).toBe('unpaired');
    expect(store.getState().saved).toBeNull();
  });

  it('restores a saved pairing', async () => {
    const { store } = setup({ storage: memoryStorage({ [STORAGE_KEY]: JSON.stringify(SAVED) }) });
    await store.getState().load();
    expect(store.getState().phase).toBe('paired');
    expect(store.getState().saved).toEqual(SAVED);
  });

  it.each([
    ['corrupt JSON', 'not json{'],
    ['missing token', JSON.stringify({ ...SAVED, token: '' })],
    ['wrong types', JSON.stringify({ ...SAVED, port: '8000' })],
    ['no scopes list', JSON.stringify({ ...SAVED, scopes: 'chat' })],
    ['an address off the home network', JSON.stringify({ ...SAVED, host: '8.8.8.8' })],
  ])('treats %s as unpaired and wipes it', async (_label, raw) => {
    const { store, storage } = setup({ storage: memoryStorage({ [STORAGE_KEY]: raw }) });
    await store.getState().load();
    expect(store.getState().phase).toBe('unpaired');
    expect(storage.data.has(STORAGE_KEY)).toBe(false);
  });
});

describe('pair', () => {
  it('pairs, saves the token securely, and becomes paired', async () => {
    const { store, storage, transport } = setup();
    await store.getState().load();
    await store.getState().pair({ host: '192.168.1.20', port: 8000, code: 'k7m2-q9xp', deviceName: '  Pixel 8  ' });

    const s = store.getState();
    expect(s.phase).toBe('paired');
    expect(s.link).toBe('connected');
    expect(s.saved).toEqual(SAVED);
    expect(JSON.parse(storage.data.get(STORAGE_KEY) as string)).toEqual(SAVED);
    expect(JSON.parse(transport.last.body as string)).toEqual({ code: 'K7M2Q9XP', device_name: 'Pixel 8' }); // normalised and trimmed
    expect(transport.last.headers?.Authorization).toBeUndefined(); // pairing never sends a token
  });

  it('names an unnamed phone', async () => {
    const { store, transport } = setup();
    await store.getState().pair({ host: '192.168.1.20', port: 8000, code: 'K7M2Q9XP', deviceName: '   ' });
    expect(JSON.parse(transport.last.body as string).device_name).toBe('My phone');
  });

  it('refuses a public address without sending anything', async () => {
    const { store, transport } = setup();
    await expect(store.getState().pair({ host: '8.8.8.8', port: 8000, code: 'K7M2Q9XP', deviceName: 'x' })).rejects.toMatchObject({ kind: 'hostNotAllowed' });
    expect(transport.requests).toHaveLength(0);
  });

  it('a wrong code leaves everything unpaired and saves nothing', async () => {
    const storage = memoryStorage();
    const transport = new FakeTransport(() => json(403, { error: { code: 'PERMISSION_DENIED', message: 'pairing code is invalid or expired' } }));
    const store = createConnectionStore({ storage, makeTransport: () => transport, makeDemo: () => ({}) as never });
    await store.getState().load();
    await expect(store.getState().pair({ host: '192.168.1.20', port: 8000, code: 'WRONGCODE', deviceName: 'x' })).rejects.toMatchObject({ kind: 'pairCodeInvalid' });
    expect(store.getState().phase).toBe('unpaired');
    expect(storage.data.size).toBe(0);
  });

  it('a Pi that cannot be reached is reported as such', async () => {
    const transport = new FakeTransport(() => {
      throw new TypeError('Network request failed');
    });
    const store = createConnectionStore({ storage: memoryStorage(), makeTransport: () => transport, makeDemo: () => ({}) as never });
    await expect(store.getState().pair({ host: '192.168.1.20', port: 8000, code: 'K7M2Q9XP', deviceName: 'x' })).rejects.toMatchObject({ kind: 'unreachable' });
  });

  it('if the token cannot be saved, it says so instead of pretending it is paired', async () => {
    const storage: KeyValueStore = { get: async () => null, remove: async () => {}, set: async () => { throw new Error('keystore locked'); } };
    const transport = new FakeTransport(() => json(200, { device_id: 'a1', token: 't', scopes: [] }));
    const store = createConnectionStore({ storage, makeTransport: () => transport, makeDemo: () => ({}) as never });
    await store.getState().load();
    const err = await store.getState().pair({ host: '192.168.1.20', port: 8000, code: 'K7M2Q9XP', deviceName: 'x' }).catch((e) => e as ApiError);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).kind).toBe('storage');
    expect(store.getState().phase).toBe('unpaired');
  });
});

describe('using the pairing', () => {
  it('api() sends the saved token to the saved address, and is reused', async () => {
    const { store, transport } = setup({ storage: memoryStorage({ [STORAGE_KEY]: JSON.stringify(SAVED) }) });
    await store.getState().load();
    const api = store.getState().api();
    expect(api).not.toBeNull();
    await api?.health();
    expect(transport.last.url).toBe('http://192.168.1.20:8000/api/health');
    expect(transport.last.headers?.Authorization).toBe('Bearer tok-abc');
    expect(store.getState().api()).toBe(api);
  });

  it('api() is null until paired', async () => {
    const { store } = setup();
    await store.getState().load();
    expect(store.getState().api()).toBeNull();
  });

  it('forget wipes the saved pairing and returns to unpaired', async () => {
    const { store, storage } = setup({ storage: memoryStorage({ [STORAGE_KEY]: JSON.stringify(SAVED) }) });
    await store.getState().load();
    await store.getState().forget();
    expect(store.getState().phase).toBe('unpaired');
    expect(store.getState().api()).toBeNull();
    expect(storage.data.size).toBe(0);
    expect(store.getState().notice).toBeNull();
  });
});

describe('handleError', () => {
  async function paired() {
    const ctx = setup({ storage: memoryStorage({ [STORAGE_KEY]: JSON.stringify(SAVED) }) });
    await ctx.store.getState().load();
    return ctx;
  }

  it('a 401 means the Pi removed this phone: forget it and say so once', async () => {
    const { store, storage } = await paired();
    store.getState().handleError(new ApiError('unauthorized'));
    await new Promise((r) => setTimeout(r, 0));
    expect(store.getState().phase).toBe('unpaired');
    expect(store.getState().notice).toBe('removed');
    expect(storage.data.size).toBe(0);
    store.getState().dismissNotice();
    expect(store.getState().notice).toBeNull();
  });

  it('a dead connection only marks the link, and keeps the pairing', async () => {
    const { store } = await paired();
    store.getState().setLink('connected');
    store.getState().handleError(new ApiError('unreachable'));
    expect(store.getState().link).toBe('unreachable');
    expect(store.getState().phase).toBe('paired');
    store.getState().handleError(new ApiError('timeout'));
    expect(store.getState().link).toBe('unreachable');
  });

  it('other errors change nothing', async () => {
    const { store } = await paired();
    store.getState().setLink('connected');
    for (const kind of ['visionBusy', 'forbidden', 'photoRejected', 'server'] as const) store.getState().handleError(new ApiError(kind));
    expect(store.getState().link).toBe('connected');
    expect(store.getState().phase).toBe('paired');
  });

  it('is ignored in demo mode and when unpaired', async () => {
    const { store } = setup();
    await store.getState().load();
    store.getState().handleError(new ApiError('unauthorized'));
    expect(store.getState().notice).toBeNull();
    store.getState().enterDemo();
    store.getState().handleError(new ApiError('unreachable'));
    expect(store.getState().link).toBe('connected');
  });
});

describe('demo mode', () => {
  it('works without a Pi, saves nothing, and is gone after a restart', async () => {
    const storage = memoryStorage();
    const demoApi = { health: async () => {} } as never;
    const store = createConnectionStore({ storage, makeTransport: () => new FakeTransport(() => json(200, {})), makeDemo: () => demoApi });
    await store.getState().load();
    store.getState().enterDemo();
    expect(store.getState().phase).toBe('demo');
    expect(store.getState().api()).toBe(demoApi);
    expect(storage.data.size).toBe(0);

    const restarted = createConnectionStore({ storage, makeTransport: () => new FakeTransport(() => json(200, {})), makeDemo: () => demoApi });
    await restarted.getState().load();
    expect(restarted.getState().phase).toBe('unpaired');
  });

  it('leaving demo mode returns to pairing', async () => {
    const { store } = setup();
    await store.getState().load();
    store.getState().enterDemo();
    await store.getState().forget();
    expect(store.getState().phase).toBe('unpaired');
    expect(store.getState().api()).toBeNull();
  });
});
