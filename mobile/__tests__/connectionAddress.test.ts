import { createConnectionStore, STORAGE_KEY, type Saved } from '../src/state/connection';
import { memoryStorage, type KeyValueStore } from '../src/state/storage';
import { FakeTransport, json } from './helpers/fakeTransport';

const SAVED: Saved = { host: '192.168.1.20', port: 8000, token: 'tok-abc', deviceId: 'a1b2c3d4', deviceName: 'Pixel 8', scopes: ['chat', 'vision'] };

type Handler = ConstructorParameters<typeof FakeTransport>[0];

async function pairedStore(handler: Handler, storage: KeyValueStore = memoryStorage({ [STORAGE_KEY]: JSON.stringify(SAVED) })) {
  const transport = new FakeTransport(handler);
  const store = createConnectionStore({ storage, makeTransport: () => transport, makeDemo: () => ({}) as never });
  await store.getState().load();
  return { store, transport, storage: storage as ReturnType<typeof memoryStorage> };
}

describe('testConnection', () => {
  it('reports how long the Pi took and marks the link connected', async () => {
    const { store, transport } = await pairedStore(() => json(200, { status: 'ok' }));
    store.getState().setLink('unreachable');
    const ms = await store.getState().testConnection();
    expect(ms).toBeGreaterThanOrEqual(0);
    expect(store.getState().link).toBe('connected');
    expect(transport.last.url).toBe('http://192.168.1.20:8000/api/health');
    expect(transport.last.headers?.Authorization).toBe('Bearer tok-abc');
  });

  it('a Pi that does not answer is an error, and the link says so', async () => {
    const { store } = await pairedStore(() => {
      throw new TypeError('Network request failed');
    });
    await expect(store.getState().testConnection()).rejects.toMatchObject({ kind: 'unreachable' });
    expect(store.getState().link).toBe('unreachable');
  });

  it('a phone the Pi has removed is told so and forgets the pairing', async () => {
    const { store } = await pairedStore(() => json(401, { error: { code: 'DEVICE_UNAUTHORIZED', message: 'a valid device token is required' } }));
    await expect(store.getState().testConnection()).rejects.toMatchObject({ kind: 'unauthorized' });
    expect(store.getState().phase).toBe('unpaired');
    expect(store.getState().notice).toBe('removed');
  });

  it('with no pairing there is nothing to test', async () => {
    const store = createConnectionStore({ storage: memoryStorage(), makeTransport: () => new FakeTransport(() => json(200, {})), makeDemo: () => ({}) as never });
    await store.getState().load();
    await expect(store.getState().testConnection()).rejects.toMatchObject({ kind: 'unreachable' });
  });
});

describe('changeAddress', () => {
  it('tries the saved token at the new address, and saves the new address only when that Pi accepts it', async () => {
    const { store, transport, storage } = await pairedStore(() => json(200, { status: 'ok' }));
    await store.getState().changeAddress('  192.168.1.77 ', 8001);
    expect(transport.last.url).toBe('http://192.168.1.77:8001/api/health');
    expect(transport.last.headers?.Authorization).toBe('Bearer tok-abc');
    expect(store.getState().saved).toEqual({ ...SAVED, host: '192.168.1.77', port: 8001 });
    expect(JSON.parse(storage.data.get(STORAGE_KEY) as string)).toMatchObject({ host: '192.168.1.77', port: 8001, token: 'tok-abc' });
    expect(store.getState().link).toBe('connected');
  });

  it('later calls go to the new address', async () => {
    const { store, transport } = await pairedStore(() => json(200, {}));
    await store.getState().changeAddress('192.168.1.77', 8001);
    await store.getState().api()?.health();
    expect(transport.last.url).toBe('http://192.168.1.77:8001/api/health');
  });

  it('an address nothing answers at is refused, and the old one stays', async () => {
    const { store, storage } = await pairedStore((req) => {
      if (req.url.includes('192.168.1.77')) throw new TypeError('Network request failed');
      return json(200, {});
    });
    await expect(store.getState().changeAddress('192.168.1.77', 8000)).rejects.toMatchObject({ kind: 'unreachable' });
    expect(store.getState().saved).toEqual(SAVED);
    expect(JSON.parse(storage.data.get(STORAGE_KEY) as string).host).toBe('192.168.1.20');
  });

  it('an address that is another Pi (it does not know this phone) is refused, and the pairing is not wiped', async () => {
    const { store } = await pairedStore((req) =>
      req.url.includes('192.168.1.77') ? json(401, { error: { code: 'DEVICE_UNAUTHORIZED', message: 'a valid device token is required' } }) : json(200, {}),
    );
    await expect(store.getState().changeAddress('192.168.1.77', 8000)).rejects.toMatchObject({ kind: 'unauthorized' });
    expect(store.getState().phase).toBe('paired');
    expect(store.getState().saved).toEqual(SAVED);
  });

  it.each(['8.8.8.8', 'example.com', '192.168.1.5/x', ''])('%j is not on the home network, so the token is never sent there', async (host) => {
    const { store, transport } = await pairedStore(() => json(200, {}));
    const before = transport.requests.length;
    await expect(store.getState().changeAddress(host, 8000)).rejects.toMatchObject({ kind: 'hostNotAllowed' });
    expect(transport.requests.length).toBe(before);
    expect(store.getState().saved).toEqual(SAVED);
  });

  it('a port that is not a port is refused', async () => {
    const { store } = await pairedStore(() => json(200, {}));
    await expect(store.getState().changeAddress('192.168.1.77', 70000)).rejects.toMatchObject({ kind: 'hostNotAllowed' });
  });

  it('if the new address cannot be saved the phone keeps using the old one', async () => {
    const failing: KeyValueStore = {
      get: async () => JSON.stringify(SAVED),
      set: async () => {
        throw new Error('keystore locked');
      },
      remove: async () => undefined,
    };
    const { store } = await pairedStore(() => json(200, {}), failing);
    await expect(store.getState().changeAddress('192.168.1.77', 8001)).rejects.toMatchObject({ kind: 'storage' });
    expect(store.getState().saved).toEqual(SAVED);
  });

  it('is only for a paired phone', async () => {
    const store = createConnectionStore({ storage: memoryStorage(), makeTransport: () => new FakeTransport(() => json(200, {})), makeDemo: () => ({}) as never });
    await store.getState().load();
    await expect(store.getState().changeAddress('192.168.1.77', 8000)).rejects.toBeDefined();
  });
});
