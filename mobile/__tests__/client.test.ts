import { VedaApi } from '../src/api/client';
import { ApiError } from '../src/api/errors';
import type { ChatEvent, VisionEvent } from '../src/api/types';
import { FakeTransport, json, sleep, sse } from './helpers/fakeTransport';

const HOST = '192.168.1.20';
const PORT = 8000;

function api(transport: FakeTransport, opts: Partial<{ token: string | null; requestTimeoutMs: number; streamStallMs: number }> = {}) {
  return new VedaApi({ host: HOST, port: PORT, token: 'tok-123', transport, ...opts });
}

async function drain<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

async function failure(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    return e as ApiError;
  }
  throw new Error('expected a failure');
}

const tok = (text: string) => JSON.stringify({ type: 'token', text });
const DONE = JSON.stringify({ type: 'done' });
const LOADING = JSON.stringify({ type: 'status', state: 'loading' });

describe('construction', () => {
  it('refuses a host that is not on a private network, so the token can never leave the home', () => {
    const t = new FakeTransport(() => json(200, {}));
    for (const host of ['8.8.8.8', 'example.com', '192.168.1.20/x']) {
      expect(() => new VedaApi({ host, port: 8000, transport: t })).toThrow(ApiError);
    }
    expect(() => new VedaApi({ host: HOST, port: 70000, transport: t })).toThrow(ApiError);
    expect(t.requests).toHaveLength(0);
  });

  it('withToken keeps the address', async () => {
    const t = new FakeTransport(() => json(200, {}));
    await api(t, { token: null }).withToken('abc').health();
    expect(t.last.url).toBe('http://192.168.1.20:8000/api/health');
    expect(t.last.headers?.Authorization).toBe('Bearer abc');
  });
});

describe('plain requests', () => {
  it('sends the bearer token only when there is one', async () => {
    const t = new FakeTransport(() => json(200, {}));
    await api(t).health();
    expect(t.last.headers?.Authorization).toBe('Bearer tok-123');
    await api(t, { token: null }).health();
    expect(t.last.headers?.Authorization).toBeUndefined();
  });

  it('pairs without ever sending a token, and reads the result', async () => {
    const t = new FakeTransport(() => json(200, { device_id: 'a1b2c3d4', token: 'secret', scopes: ['chat', 'vision'] }));
    const r = await api(t).pair('K7M2Q9XP', 'Pixel 8');
    expect(r).toEqual({ deviceId: 'a1b2c3d4', token: 'secret', scopes: ['chat', 'vision'] });
    expect(t.last.method).toBe('POST');
    expect(t.last.url).toBe('http://192.168.1.20:8000/api/pair');
    expect(t.last.headers?.Authorization).toBeUndefined();
    expect(JSON.parse(t.last.body as string)).toEqual({ code: 'K7M2Q9XP', device_name: 'Pixel 8' });
  });

  it('a wrong pairing code is "that code did not work"', async () => {
    const t = new FakeTransport(() => json(403, { error: { code: 'PERMISSION_DENIED', message: 'pairing code is invalid or expired' } }));
    expect((await failure(api(t).pair('WRONG', 'x'))).kind).toBe('pairCodeInvalid');
  });

  it('a reply without a token is a bad response', async () => {
    const t = new FakeTransport(() => json(200, { device_id: 'x' }));
    expect((await failure(api(t).pair('K7M2Q9XP', 'x'))).kind).toBe('badResponse');
  });

  it('a reply that is not JSON is a bad response', async () => {
    const t = new FakeTransport(() => ({ status: 200, body: '<html>' }));
    expect((await failure(api(t).health())).kind).toBe('badResponse');
  });

  it('uploads the photo bytes untouched', async () => {
    const t = new FakeTransport(() => json(200, { image_id: 'img1', width: 768, height: 576 }));
    const bytes = new Uint8Array([0xff, 0xd8, 1, 2, 3]);
    const info = await api(t).putImage(bytes);
    expect(info).toEqual({ imageId: 'img1', width: 768, height: 576 });
    expect(t.last.method).toBe('PUT');
    expect(t.last.url).toBe('http://192.168.1.20:8000/api/vision/images');
    expect(t.last.headers?.['Content-Type']).toBe('image/jpeg');
    expect(t.last.body).toBe(bytes);
  });

  it('maps a rejected photo and a removed phone', async () => {
    const t1 = new FakeTransport(() => json(422, { error: { code: 'IMAGE_INVALID', message: 'Image rejected: not a readable image' } }));
    expect((await failure(api(t1).putImage(new Uint8Array(1)))).kind).toBe('photoRejected');
    const t2 = new FakeTransport(() => json(401, { error: { code: 'DEVICE_UNAUTHORIZED', message: 'a valid device token is required' } }));
    expect((await failure(api(t2).putImage(new Uint8Array(1)))).kind).toBe('unauthorized');
  });

  it('reads the vision status', async () => {
    const t = new FakeTransport(() => json(200, { enabled: true, loaded: false, busy: false, idle_seconds: null, model: 'm.gguf' }));
    expect(await api(t).visionStatus()).toEqual({ enabled: true, loaded: false, busy: false, idleSeconds: null, model: 'm.gguf' });
  });

  it('a refused connection is "cannot reach your Pi"', async () => {
    const t = new FakeTransport(() => {
      throw new TypeError('Network request failed');
    });
    expect((await failure(api(t).health())).kind).toBe('unreachable');
  });

  it('a request that never answers times out, and the connection is closed', async () => {
    const t = new FakeTransport(() => ({ hang: true }));
    const e = await failure(api(t, { requestTimeoutMs: 60 }).health());
    expect(e.kind).toBe('timeout');
    expect(t.aborted).toBe(1);
  });

  it('the caller can cancel a plain request', async () => {
    const t = new FakeTransport(() => ({ hang: true }));
    const c = new AbortController();
    const p = api(t).health(c.signal);
    setTimeout(() => c.abort(), 20);
    expect((await failure(p)).kind).toBe('cancelled');
  });
});

describe('askVision', () => {
  it('sends the question and reads the whole conversation of events', async () => {
    const t = new FakeTransport(() => ({ stream: [sse(LOADING, tok('A red '), tok('apple.'), DONE)] }));
    const events = await drain(api(t).askVision({ imageId: 'img1', style: 'read_text' }));
    expect(events).toEqual<VisionEvent[]>([
      { type: 'status', state: 'loading' }, { type: 'token', text: 'A red ' }, { type: 'token', text: 'apple.' }, { type: 'done' },
    ]);
    expect(t.last.url).toBe('http://192.168.1.20:8000/api/vision/ask');
    expect(t.last.headers?.Authorization).toBe('Bearer tok-123');
    expect(JSON.parse(t.last.body as string)).toEqual({ image_id: 'img1', question: null, style: 'read_text', lang: 'en' });
  });

  it('passes a follow-up question', async () => {
    const t = new FakeTransport(() => ({ stream: [sse(DONE)] }));
    await drain(api(t).askVision({ imageId: 'img1', question: 'Is it ripe?' }));
    expect(JSON.parse(t.last.body as string)).toMatchObject({ question: 'Is it ripe?', style: 'brief' });
  });

  it('copes with events split anywhere in the byte stream, including inside a character', async () => {
    const full = new TextEncoder().encode(sse(tok('café \u{1F34E}'), DONE));
    const pieces = [...full].map((b) => new Uint8Array([b])); // one byte at a time
    const t = new FakeTransport(() => ({ stream: pieces }));
    expect(await drain(api(t).askVision({ imageId: 'x' }))).toEqual([{ type: 'token', text: 'café \u{1F34E}' }, { type: 'done' }]);
  });

  it('stops at "done" and closes the connection, ignoring anything after it', async () => {
    const t = new FakeTransport(() => ({ stream: [sse(tok('hi'), DONE, tok('ignored'))] }));
    const events = await drain(api(t).askVision({ imageId: 'x' }));
    expect(events.map((e) => e.type)).toEqual(['token', 'done']);
    expect(t.bodiesClosed).toBe(1);
  });

  it('delivers an error event from the middle of the stream and stops', async () => {
    const err = JSON.stringify({ type: 'error', code: 'VISION_UNAVAILABLE', message: 'the vision model failed' });
    const t = new FakeTransport(() => ({ stream: [sse(tok('A '), err, tok('late'))] }));
    const events = await drain(api(t).askVision({ imageId: 'x' }));
    expect(events).toEqual([{ type: 'token', text: 'A ' }, { type: 'error', code: 'VISION_UNAVAILABLE', message: 'the vision model failed' }]);
  });

  it('skips events and lines it does not understand', async () => {
    const t = new FakeTransport(() => ({
      stream: [': keep-alive\n\n' + sse('{"type":"future","x":1}', 'not json', tok('ok'), DONE)],
    }));
    expect((await drain(api(t).askVision({ imageId: 'x' }))).map((e) => e.type)).toEqual(['token', 'done']);
  });

  it('a stream that ends without "done" is cut off', async () => {
    const t = new FakeTransport(() => ({ stream: [sse(tok('A red '))] }));
    const got: VisionEvent[] = [];
    let error: unknown;
    try {
      for await (const e of api(t).askVision({ imageId: 'x' })) got.push(e);
    } catch (e) {
      error = e;
    }
    expect(got).toEqual([{ type: 'token', text: 'A red ' }]);
    expect((error as ApiError).kind).toBe('cutOff');
  });

  it('fails before the first event when the model is busy, with the retry hint', async () => {
    const t = new FakeTransport(() => json(429, { error: { code: 'VISION_BUSY', message: 'Vision is busy with another photo' } }, { 'Retry-After': '5' }));
    const e = await failure(drain(api(t).askVision({ imageId: 'x' })));
    expect(e.kind).toBe('visionBusy');
    expect(e.retryAfterSeconds).toBe(5);
  });

  it('fails before the first event when the photo has expired, so the caller can upload it again', async () => {
    const t = new FakeTransport(() => json(422, { error: { code: 'IMAGE_INVALID', message: 'Image rejected: unknown or expired photo; take it again' } }));
    expect((await failure(drain(api(t).askVision({ imageId: 'gone' })))).kind).toBe('photoExpired');
  });

  it('fails clearly when vision is off or the phone lacks the permission', async () => {
    const off = new FakeTransport(() => json(503, { detail: 'vision (turned off in config/vision.yaml) not initialized' }));
    expect((await failure(drain(api(off).askVision({ imageId: 'x' })))).kind).toBe('visionOff');
    const forbidden = new FakeTransport(() => json(403, { error: { code: 'DEVICE_FORBIDDEN', message: "this device lacks the 'vision' permission" } }));
    expect((await failure(drain(api(forbidden).askVision({ imageId: 'x' })))).kind).toBe('forbidden');
  });

  it('ends quietly when the caller cancels mid-stream, and closes the connection', async () => {
    const t = new FakeTransport(() => ({ stream: [sse(tok('one ')), { wait: 5_000 }, sse(tok('two'), DONE)] }));
    const c = new AbortController();
    const got: VisionEvent[] = [];
    for await (const e of api(t).askVision({ imageId: 'x' }, c.signal)) {
      got.push(e);
      c.abort(); // the user pressed Stop after the first words
    }
    expect(got).toEqual([{ type: 'token', text: 'one ' }]); // no error thrown, nothing after the cancel
    expect(t.bodiesClosed).toBe(1);
    expect(t.aborted).toBe(1);
  });

  it('ends quietly when cancelled before anything arrives', async () => {
    const t = new FakeTransport(() => ({ hang: true }));
    const c = new AbortController();
    setTimeout(() => c.abort(), 20);
    expect(await drain(api(t).askVision({ imageId: 'x' }, c.signal))).toEqual([]);
  });

  it('stops early and closes the connection when the caller just stops reading', async () => {
    const t = new FakeTransport(() => ({ stream: [sse(tok('a'), tok('b'), tok('c'), DONE)] }));
    const gen = api(t).askVision({ imageId: 'x' });
    await gen.next(); // read one event, then stop reading
    await gen.return(undefined);
    await sleep(10);
    expect(t.bodiesClosed).toBe(1);
    expect(t.aborted).toBe(1);
  });

  it('gives up on a stream that goes silent', async () => {
    const t = new FakeTransport(() => ({ stream: [sse(tok('a')), { wait: 5_000 }, sse(DONE)] }));
    const events: VisionEvent[] = [];
    let error: unknown;
    try {
      for await (const e of api(t, { streamStallMs: 80 }).askVision({ imageId: 'x' })) events.push(e);
    } catch (e) {
      error = e;
    }
    expect(events).toHaveLength(1);
    expect((error as ApiError).kind).toBe('timeout');
    expect(t.aborted).toBe(1);
  });

  it('waits patiently through a slow first token (a cold model) as long as the stall limit allows', async () => {
    const t = new FakeTransport(() => ({ stream: [sse(LOADING), { wait: 150 }, sse(tok('late'), DONE)] }));
    const events = await drain(api(t, { streamStallMs: 1_000 }).askVision({ imageId: 'x' }));
    expect(events.map((e) => e.type)).toEqual(['status', 'token', 'done']);
  });
});

describe('chatStream', () => {
  it('sends only the message: never prompt text or a voice flag', async () => {
    const t = new FakeTransport(() => ({ stream: ['data: hi\n\ndata: [DONE]\n\n'] }));
    await drain(api(t).chatStream('hello'));
    expect(t.last.url).toBe('http://192.168.1.20:8000/api/stream');
    expect(JSON.parse(t.last.body as string)).toEqual({ message: 'hello' });
    await drain(api(t).chatStream('hello', undefined, 'sess1'));
    expect(JSON.parse(t.last.body as string)).toEqual({ message: 'hello', session_id: 'sess1' });
    expect(t.last.body as string).not.toMatch(/system_context|from_voice/);
  });

  it('streams text, keeps line breaks as the Pi frames them, and finishes on [DONE]', async () => {
    const t = new FakeTransport(() => ({ stream: ['data: Sure.\n\ndata: Line one\ndata: line two\n\ndata: [DONE]\n\n'] }));
    expect(await drain(api(t).chatStream('hi'))).toEqual<ChatEvent[]>([
      { type: 'text', text: 'Sure.' }, { type: 'text', text: 'Line one\nline two' }, { type: 'done' },
    ]);
  });

  it('is paused with a clear message while auto-approve is on at the Pi', async () => {
    const t = new FakeTransport(() => json(403, { error: { code: 'DEVICE_FORBIDDEN', message: 'auto-approve (yolo) is on; chat from the phone is paused' } }));
    expect((await failure(drain(api(t).chatStream('hi')))).kind).toBe('autoApproveOn');
  });

  it('reports a cut-off answer', async () => {
    const t = new FakeTransport(() => ({ stream: ['data: part\n\n'] }));
    const got: ChatEvent[] = [];
    let error: unknown;
    try {
      for await (const e of api(t).chatStream('hi')) got.push(e);
    } catch (e) {
      error = e;
    }
    expect(got).toEqual([{ type: 'text', text: 'part' }]);
    expect((error as ApiError).kind).toBe('cutOff');
  });

  it('ends quietly on cancel', async () => {
    const t = new FakeTransport(() => ({ stream: ['data: one\n\n', { wait: 5_000 }, 'data: [DONE]\n\n'] }));
    const c = new AbortController();
    const got: ChatEvent[] = [];
    for await (const e of api(t).chatStream('hi', c.signal)) {
      got.push(e);
      c.abort();
    }
    expect(got).toEqual([{ type: 'text', text: 'one' }]);
  });
});
