import { ApiError } from '../src/api/errors';
import type { PiApi } from '../src/api/pi';
import type { ChatEvent, PendingApproval } from '../src/api/types';
import { createChatStore } from '../src/features/chat/chatStore';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const text = (t: string): ChatEvent => ({ type: 'text', text: t });
const DONE: ChatEvent = { type: 'done' };

type Script = (signal?: AbortSignal) => AsyncGenerator<ChatEvent>;
const events = (...evs: ChatEvent[]): Script =>
  async function* () {
    for (const e of evs) {
      await tick();
      yield e;
    }
  };
const failing = (err: ApiError): Script =>
  async function* () {
    await tick();
    throw err;
  };
const failAfter = (first: ChatEvent[], err: ApiError): Script =>
  async function* () {
    for (const e of first) {
      await tick();
      yield e;
    }
    throw err;
  };
const gated = (first: ChatEvent[], gate: Promise<void>, rest: ChatEvent[]): Script =>
  async function* (signal) {
    for (const e of first) {
      await tick();
      yield e;
    }
    await new Promise<void>((resolve, reject) => {
      signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      void gate.then(() => resolve());
    });
    for (const e of rest) yield e;
  };

const approval = (id: string, summary = 'Send an email to Priya'): PendingApproval => ({ requestId: id, actionName: 'send_email', ageSeconds: 3, summary });

function setup(opts: { timing?: object } = {}) {
  const sent: string[] = [];
  const scripts: Script[] = [];
  let pending: PendingApproval[] = [];
  const decisions: string[] = [];
  let approvalError: unknown = null;
  let pendingError: unknown = null;
  const api = {
    async *chatStream(message: string, signal?: AbortSignal) {
      sent.push(message);
      yield* (scripts.shift() ?? events(text('Default reply.'), DONE))(signal);
    },
    async pendingApprovals() {
      if (pendingError) throw pendingError;
      return pending;
    },
    async approve(id: string) {
      if (approvalError) throw approvalError;
      decisions.push(`approve:${id}`);
      pending = pending.filter((p) => p.requestId !== id);
    },
    async deny(id: string) {
      if (approvalError) throw approvalError;
      decisions.push(`deny:${id}`);
      pending = pending.filter((p) => p.requestId !== id);
    },
  };
  const speech = { enqueue: jest.fn(), stop: jest.fn(), isSpeaking: false };
  const onApiError = jest.fn();
  const notify = jest.fn();
  const store = createChatStore({ getApi: () => api as unknown as PiApi, makeSpeech: () => speech, onApiError, notify, timing: opts.timing as never });
  return {
    store,
    sent,
    scripts,
    speech,
    onApiError,
    notify,
    decisions,
    setPending: (p: PendingApproval[]) => (pending = p),
    failApprovals: (e: unknown) => (approvalError = e),
    failPending: (e: unknown) => (pendingError = e),
  };
}

describe('sending a message', () => {
  it('shows the message, streams the reply into one bubble, and ends not busy', async () => {
    const { store, scripts, sent } = setup();
    scripts.push(events(text('Done. '), text("I'll remind you at 6 pm."), DONE));
    await store.getState().send('  remind me to call mum at 6 ');
    const s = store.getState();
    expect(sent).toEqual(['remind me to call mum at 6']);
    expect(s.messages.map((m) => [m.role, m.text, m.streaming, m.failed])).toEqual([
      ['user', 'remind me to call mum at 6', false, false],
      ['veda', "Done. I'll remind you at 6 pm.", false, false],
    ]);
    expect(s.busy).toBe(false);
    expect(s.error).toBeNull();
  });

  it('is busy and shows a streaming bubble while the reply arrives', async () => {
    const { store, scripts } = setup();
    let release: () => void = () => {};
    scripts.push(gated([text('Working')], new Promise<void>((r) => (release = r)), [text(' on it.'), DONE]));
    const run = store.getState().send('hi');
    await new Promise((r) => setTimeout(r, 20));
    expect(store.getState().busy).toBe(true);
    expect(store.getState().messages[1]).toMatchObject({ text: 'Working', streaming: true });
    release();
    await run;
    expect(store.getState().messages[1]).toMatchObject({ text: 'Working on it.', streaming: false });
  });

  it('ignores empty messages, and a second message while one is being answered', async () => {
    const { store, scripts, sent } = setup();
    await store.getState().send('   ');
    expect(sent).toHaveLength(0);
    scripts.push(gated([], new Promise(() => {}), []));
    void store.getState().send('first');
    await tick();
    await store.getState().send('second');
    expect(sent).toEqual(['first']);
  });

  it('keeps the conversation across messages', async () => {
    const { store } = setup();
    await store.getState().send('one');
    await store.getState().send('two');
    expect(store.getState().messages.map((m) => m.text)).toEqual(['one', 'Default reply.', 'two', 'Default reply.']);
  });
});

describe('speaking replies', () => {
  it('is silent by default', async () => {
    const { store, speech } = setup();
    await store.getState().send('hi');
    expect(speech.enqueue).not.toHaveBeenCalled();
  });

  it('with the speaker on, speaks each sentence as it completes', async () => {
    const { store, scripts, speech } = setup();
    store.getState().setSpeak(true);
    scripts.push(events(text('First one. Second '), text('one. Third'), DONE));
    await store.getState().send('hi');
    expect(speech.enqueue.mock.calls.map((c) => c[0])).toEqual(['First one.', 'Second one.', 'Third']);
  });

  it('turning the speaker off silences it', async () => {
    const { store, speech } = setup();
    store.getState().setSpeak(true);
    await store.getState().send('hi'); // creates the voice
    store.getState().setSpeak(false);
    expect(speech.stop).toHaveBeenCalled();
  });
});

describe('when something goes wrong', () => {
  it('an unreachable Pi puts the reason in the reply bubble and tells the connection', async () => {
    const { store, scripts, onApiError } = setup();
    scripts.push(failing(new ApiError('unreachable')));
    await store.getState().send('hi');
    const s = store.getState();
    expect(s.messages[1]).toMatchObject({ failed: true, streaming: false });
    expect(s.messages[1]?.text).toContain("Can't reach your Pi");
    expect(s.error?.kind).toBe('unreachable');
    expect(s.busy).toBe(false);
    expect(onApiError).toHaveBeenCalledWith(expect.objectContaining({ kind: 'unreachable' }));
  });

  it('a reply cut off half-way keeps what arrived and marks it failed', async () => {
    const { store, scripts } = setup();
    scripts.push(failAfter([text('Half of an ans')], new ApiError('unreachable')));
    await store.getState().send('hi');
    expect(store.getState().messages[1]).toMatchObject({ text: 'Half of an ans', failed: true, streaming: false });
  });

  it('auto-approve on at the Pi pauses chat: the message is taken back out and nothing is left empty', async () => {
    const { store, scripts } = setup();
    scripts.push(failing(new ApiError('autoApproveOn')));
    await store.getState().send('send an email');
    const s = store.getState();
    expect(s.paused).toBe(true);
    expect(s.messages).toEqual([]);
    expect(s.error?.kind).toBe('autoApproveOn');
  });

  it('trying again after the pause is cleared works', async () => {
    const { store, scripts } = setup();
    scripts.push(failing(new ApiError('autoApproveOn')));
    await store.getState().send('hi');
    await store.getState().send('hi again');
    expect(store.getState().paused).toBe(false);
    expect(store.getState().messages.map((m) => m.text)).toEqual(['hi again', 'Default reply.']);
  });

  it('a phone without the chat permission is told so', async () => {
    const { store, scripts } = setup();
    scripts.push(failing(new ApiError('forbidden')));
    await store.getState().send('hi');
    expect(store.getState().error?.kind).toBe('forbidden');
  });

  it('being removed by the Pi is passed on', async () => {
    const { store, scripts, onApiError } = setup();
    scripts.push(failing(new ApiError('unauthorized')));
    await store.getState().send('hi');
    expect(onApiError).toHaveBeenCalledWith(expect.objectContaining({ kind: 'unauthorized' }));
  });
});

describe('stopping and clearing', () => {
  it('Stop keeps the words already shown, cancels the request, and ignores anything later', async () => {
    const { store, scripts, speech } = setup();
    store.getState().setSpeak(true);
    let release: () => void = () => {};
    scripts.push(gated([text('Partial ')], new Promise<void>((r) => (release = r)), [text('LATE'), DONE]));
    const run = store.getState().send('hi');
    await new Promise((r) => setTimeout(r, 20));
    store.getState().stop();
    release();
    await run;
    await tick();
    const s = store.getState();
    expect(s.busy).toBe(false);
    expect(s.messages[1]).toMatchObject({ text: 'Partial ', streaming: false, failed: false });
    expect(speech.stop).toHaveBeenCalled();
  });

  it('Stop with nothing running only silences the voice', async () => {
    const { store } = setup();
    store.getState().stop();
    expect(store.getState().busy).toBe(false);
  });

  it('reset clears the conversation, keeps the speaker choice, and drops a running reply', async () => {
    const { store, scripts } = setup();
    store.getState().setSpeak(true);
    scripts.push(gated([text('x')], new Promise(() => {}), []));
    void store.getState().send('hi');
    await new Promise((r) => setTimeout(r, 20));
    store.getState().reset();
    expect(store.getState().messages).toEqual([]);
    expect(store.getState().busy).toBe(false);
    expect(store.getState().speak).toBe(true);
  });
});

describe('approvals', () => {
  it('shows what is waiting for approval, and announces each new request once', async () => {
    const { store, setPending, notify } = setup();
    setPending([approval('a1')]);
    await store.getState().refreshApprovals();
    await store.getState().refreshApprovals();
    expect(store.getState().approvals).toHaveLength(1);
    expect(notify).toHaveBeenCalledTimes(1);
    setPending([approval('a1'), approval('a2', 'Delete a file')]);
    await store.getState().refreshApprovals();
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[1]?.[0]).toEqual([approval('a2', 'Delete a file')]);
  });

  it('approving sends it and takes the card away', async () => {
    const { store, setPending, decisions } = setup();
    setPending([approval('a1')]);
    await store.getState().refreshApprovals();
    await store.getState().approve('a1');
    expect(decisions).toEqual(['approve:a1']);
    expect(store.getState().approvals).toEqual([]);
    expect(store.getState().deciding).toBeNull();
  });

  it('denying sends the denial', async () => {
    const { store, setPending, decisions } = setup();
    setPending([approval('a1')]);
    await store.getState().refreshApprovals();
    await store.getState().deny('a1');
    expect(decisions).toEqual(['deny:a1']);
    expect(store.getState().approvals).toEqual([]);
  });

  it('a phone that may not approve gets a clear error and the card stays (the Pi still shows it)', async () => {
    const { store, setPending, failApprovals } = setup();
    setPending([approval('a1')]);
    await store.getState().refreshApprovals();
    failApprovals(new ApiError('forbidden'));
    await store.getState().approve('a1');
    expect(store.getState().error?.kind).toBe('forbidden');
    expect(store.getState().approvals).toHaveLength(1);
    expect(store.getState().deciding).toBeNull();
  });

  it('a request already decided elsewhere disappears on the refresh that follows', async () => {
    const { store, setPending, failApprovals } = setup();
    setPending([approval('a1')]);
    await store.getState().refreshApprovals();
    setPending([]); // decided on the Pi
    failApprovals(new ApiError('notFound'));
    await store.getState().approve('a1');
    expect(store.getState().approvals).toEqual([]);
  });

  it('a failed check leaves the banner as it was and tells the connection', async () => {
    const { store, setPending, failPending, onApiError } = setup();
    setPending([approval('a1')]);
    await store.getState().refreshApprovals();
    failPending(new ApiError('unreachable'));
    await store.getState().refreshApprovals();
    expect(store.getState().approvals).toHaveLength(1);
    expect(onApiError).toHaveBeenCalled();
  });

  it('only one decision at a time', async () => {
    const { store, setPending, decisions } = setup();
    setPending([approval('a1'), approval('a2')]);
    await store.getState().refreshApprovals();
    await Promise.all([store.getState().approve('a1'), store.getState().approve('a2')]);
    expect(decisions).toEqual(['approve:a1']);
  });
});

describe('polling for approvals', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('checks at once, then every 10 s when idle, and stops when asked', async () => {
    const { store, setPending } = setup();
    setPending([approval('x')]);
    store.getState().startPolling();
    await jest.advanceTimersByTimeAsync(0);
    expect(store.getState().approvals).toHaveLength(1);
    setPending([]);
    await jest.advanceTimersByTimeAsync(9_000);
    expect(store.getState().approvals).toHaveLength(1); // not yet
    await jest.advanceTimersByTimeAsync(1_500);
    expect(store.getState().approvals).toHaveLength(0);
    setPending([approval('y')]);
    store.getState().stopPolling();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(store.getState().approvals).toHaveLength(0); // no more checks
  });

  it('checks faster while a reply is being written', async () => {
    const { store, scripts, setPending } = setup();
    scripts.push(gated([], new Promise(() => {}), []));
    store.getState().startPolling();
    await jest.advanceTimersByTimeAsync(0);
    void store.getState().send('hi');
    await jest.advanceTimersByTimeAsync(10_500); // the idle wait already scheduled finishes first
    setPending([approval('q')]);
    await jest.advanceTimersByTimeAsync(2_100);
    expect(store.getState().approvals).toHaveLength(1);
    store.getState().stopPolling();
  });

  it('starting twice does not double the checks', async () => {
    const { store, setPending, notify } = setup();
    setPending([approval('z')]);
    store.getState().startPolling();
    store.getState().startPolling();
    await jest.advanceTimersByTimeAsync(0);
    expect(notify).toHaveBeenCalledTimes(1);
    store.getState().stopPolling();
  });
});
