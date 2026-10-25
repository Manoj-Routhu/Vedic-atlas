import { DemoApi, demoAnswer } from '../src/api/demo';
import { ApiError } from '../src/api/errors';
import type { ChatEvent, VisionEvent } from '../src/api/types';

const fast = () => new DemoApi({ coldMs: 0, wordMs: 0 });

async function drain<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const e of gen) out.push(e);
  return out;
}
const words = (events: VisionEvent[]) => events.flatMap((e) => (e.type === 'token' ? [e.text] : [])).join('');

describe('demoAnswer', () => {
  it('describes by style', () => {
    expect(demoAnswer('brief')).toContain('red apple');
    expect(demoAnswer('read_text')).toBe('Best before 12/2027.');
    expect(demoAnswer('detailed').split('. ').length).toBeGreaterThan(3);
  });
  it('answers follow-ups, and admits when it cannot tell', () => {
    expect(demoAnswer('brief', 'What does the label say?')).toContain('12/2027');
    expect(demoAnswer('brief', 'is it ripe')).toContain('ripe');
    expect(demoAnswer('brief', 'what colour is the mug')).toContain('blue');
    expect(demoAnswer('brief', 'who painted this?')).toContain("can't tell");
  });
});

describe('DemoApi', () => {
  it('behaves like the Pi: loading on the first photo only, then words, then done', async () => {
    const api = fast();
    const { imageId } = await api.putImage();
    const first = await drain(api.askVision({ imageId }));
    expect(first[0]).toEqual({ type: 'status', state: 'loading' });
    expect(first[first.length - 1]).toEqual({ type: 'done' });
    expect(words(first)).toContain('red apple');

    const second = await drain(api.askVision({ imageId, question: 'What does the label say?' }));
    expect(second[0]?.type).toBe('token'); // warm now
    expect(words(second)).toContain('12/2027');
    expect((await api.visionStatus()).loaded).toBe(true);
  });

  it('knows nothing about a photo it was not given, like an expired one', async () => {
    const api = fast();
    await expect(drain(api.askVision({ imageId: 'nope' }))).rejects.toBeInstanceOf(ApiError);
    await expect(drain(api.askVision({ imageId: 'nope' }))).rejects.toMatchObject({ kind: 'photoExpired' });
  });

  it('stops when cancelled', async () => {
    const api = new DemoApi({ coldMs: 0, wordMs: 5 });
    const { imageId } = await api.putImage();
    const c = new AbortController();
    const got: VisionEvent[] = [];
    for await (const e of api.askVision({ imageId, style: 'detailed' }, c.signal)) {
      got.push(e);
      if (got.length === 2) c.abort();
    }
    expect(got.length).toBeLessThan(6);
    expect(got.some((e) => e.type === 'done')).toBe(false);
  });

  it('chats, and an email request creates a pending approval that can be approved', async () => {
    const api = fast();
    const hello = await drain(api.chatStream('hello'));
    expect(hello[hello.length - 1]).toEqual<ChatEvent>({ type: 'done' });
    expect(hello.map((e) => (e.type === 'text' ? e.text : '')).join('')).toContain('demo mode');

    expect(await api.pendingApprovals()).toEqual([]);
    await drain(api.chatStream('please send an email to Priya'));
    const pending = await api.pendingApprovals();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.summary).toContain('send an email');
    await api.approve((pending[0] as { requestId: string }).requestId);
    expect(await api.pendingApprovals()).toEqual([]);
  });

  it('denying also clears it', async () => {
    const api = fast();
    await drain(api.chatStream('send an email'));
    const [p] = await api.pendingApprovals();
    await api.deny((p as { requestId: string }).requestId);
    expect(await api.pendingApprovals()).toEqual([]);
  });

  it('is honest that it is a demo', async () => {
    const reply = (await drain(fast().chatStream('what is the weather'))).map((e) => (e.type === 'text' ? e.text : '')).join('');
    expect(reply.toLowerCase()).toContain('demo');
  });
});
