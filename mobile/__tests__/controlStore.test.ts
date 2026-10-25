import { DemoApi } from '../src/api/demo';
import { ApiError } from '../src/api/errors';
import type { PiApi } from '../src/api/pi';
import { createControlStore, parseLeadMinutes } from '../src/features/control/controlStore';

const ALL = ['chat', 'control', 'vision', 'approve'];

function setup(scopes: string[] = ALL, opts: { refreshMs?: number } = {}) {
  const api = new DemoApi();
  const onApiError = jest.fn();
  let clock = 1_000;
  const store = createControlStore({
    getApi: () => api as PiApi,
    scopes: () => scopes,
    onApiError,
    now: () => (clock += 25),
    refreshMs: opts.refreshMs,
  });
  return { api, store, onApiError };
}

describe('loading the page', () => {
  it('starts loading, and one refresh fills every section the phone may see', async () => {
    const { store } = setup();
    expect(store.getState().loading).toBe(true);
    await store.getState().refresh();
    const s = store.getState();
    expect(s.loading).toBe(false);
    expect(s.refreshing).toBe(false);
    expect(s.onlineMs).toBeGreaterThan(0);
    expect(s.autoApprove).toBe(false);
    expect(s.vision?.model).toBe('demo');
    expect(s.privacy?.muted).toBe(false);
    expect(s.voice?.running).toBe(true);
    expect(s.tasks?.map((t) => t.title)).toEqual(['Call mum', 'Buy milk']);
    expect(s.reminders?.leadMinutes).toEqual([15]);
    expect(s.persona?.current).toBe('friend');
    expect(s.proactivity?.level).toBe('medium');
    expect(s.activity?.length).toBeGreaterThan(0);
    expect(s.errors).toEqual({});
  });

  it('only asks for what the phone is allowed: no control permission, no control calls', async () => {
    const { store, api } = setup(['chat']);
    const privacy = jest.spyOn(api, 'privacy');
    const reminders = jest.spyOn(api, 'reminders');
    await store.getState().refresh();
    expect(privacy).not.toHaveBeenCalled();
    expect(reminders).not.toHaveBeenCalled();
    expect(store.getState().privacy).toBeNull();
    expect(store.getState().tasks).not.toBeNull(); // tasks are a chat permission
  });

  it('a section that fails keeps its old data and the others still load', async () => {
    const { store, api } = setup();
    await store.getState().refresh();
    jest.spyOn(api, 'tasks').mockRejectedValue(new ApiError('server'));
    await api.mute();
    await store.getState().refresh();
    const s = store.getState();
    expect(s.errors.tasks?.kind).toBe('server');
    expect(s.tasks?.length).toBe(2); // old list stays
    expect(s.privacy?.muted).toBe(true); // others updated
    expect(s.errors.privacy).toBeUndefined();
  });

  it('a dead connection is reported once per refresh, not once per section', async () => {
    const { store, api, onApiError } = setup();
    for (const method of ['autoApprove', 'visionStatus', 'privacy', 'voice', 'tasks', 'reminders', 'persona', 'proactivity', 'activity', 'health'] as const) {
      jest.spyOn(api, method as never).mockRejectedValue(new ApiError('unreachable') as never);
    }
    await store.getState().refresh();
    expect(onApiError).toHaveBeenCalledTimes(1);
    expect(store.getState().onlineMs).toBeNull();
    expect(store.getState().loading).toBe(false);
  });

  it('being removed by the Pi is passed on', async () => {
    const { store, api, onApiError } = setup();
    jest.spyOn(api, 'privacy').mockRejectedValue(new ApiError('unauthorized'));
    await store.getState().refresh();
    expect(onApiError).toHaveBeenCalledWith(expect.objectContaining({ kind: 'unauthorized' }));
  });

  it('a "forbidden" section is recorded so the screen can hide it, without alarming the connection', async () => {
    const { store, api, onApiError } = setup();
    jest.spyOn(api, 'activity').mockRejectedValue(new ApiError('forbidden'));
    await store.getState().refresh();
    expect(store.getState().errors.activity?.kind).toBe('forbidden');
    expect(onApiError).not.toHaveBeenCalled();
  });

  it('overlapping refreshes share one run', async () => {
    const { store, api } = setup();
    const spy = jest.spyOn(api, 'privacy');
    await Promise.all([store.getState().refresh(), store.getState().refresh(), store.getState().refresh()]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('with no connection it just stops loading', async () => {
    const store = createControlStore({ getApi: () => null, scopes: () => ALL });
    await store.getState().refresh();
    expect(store.getState().loading).toBe(false);
  });
});

describe('the microphone', () => {
  it('mute closes the Pi\'s microphone and shows it', async () => {
    const { store } = setup();
    await store.getState().refresh();
    await store.getState().mute();
    expect(store.getState().privacy?.muted).toBe(true);
    expect(store.getState().actionError).toBeNull();
  });

  it('a mute that fails is explained, and the screen re-reads the truth', async () => {
    const { store, api } = setup();
    await store.getState().refresh();
    jest.spyOn(api, 'mute').mockRejectedValue(new ApiError('forbidden'));
    await store.getState().mute();
    expect(store.getState().actionError?.kind).toBe('forbidden');
    expect(store.getState().privacy?.muted).toBe(false);
  });
});

describe('tasks', () => {
  it('adds a task (trimmed) to the list', async () => {
    const { store } = setup();
    await store.getState().refresh();
    await store.getState().addTask('  Water plants  ');
    expect(store.getState().tasks?.map((t) => t.title)).toEqual(['Call mum', 'Buy milk', 'Water plants']);
  });

  it('ignores an empty title, and cuts a very long one', async () => {
    const { store, api } = setup();
    await store.getState().refresh();
    const spy = jest.spyOn(api, 'addTask');
    await store.getState().addTask('   ');
    expect(spy).not.toHaveBeenCalled();
    await store.getState().addTask('x'.repeat(500));
    expect(spy).toHaveBeenCalledWith('x'.repeat(200));
  });

  it('completing removes it at once', async () => {
    const { store } = setup();
    await store.getState().refresh();
    const done = store.getState().completeTask(1);
    expect(store.getState().tasks?.map((t) => t.id)).toEqual([2]); // before the Pi has even answered
    await done;
    expect(store.getState().tasks?.map((t) => t.id)).toEqual([2]);
  });

  it('a completion that fails puts the task back, says why, and the next read decides', async () => {
    const { store, api } = setup();
    await store.getState().refresh();
    jest.spyOn(api, 'completeTask').mockRejectedValue(new ApiError('unreachable'));
    await store.getState().completeTask(1);
    expect(store.getState().tasks?.map((t) => t.id)).toEqual([1, 2]);
    expect(store.getState().actionError?.kind).toBe('unreachable');
  });
});

describe('reminders, persona and proactivity', () => {
  it('changes the heads-up times', async () => {
    const { store } = setup();
    await store.getState().refresh();
    await store.getState().setReminderLeads([30, 10]);
    expect(store.getState().reminders?.leadMinutes).toEqual([30, 10]);
  });

  it('a heads-up the Pi refuses is reported and the old setting stays', async () => {
    const { store, api } = setup();
    await store.getState().refresh();
    jest.spyOn(api, 'setReminderLeads').mockRejectedValue(new ApiError('validation'));
    await store.getState().setReminderLeads([999]);
    expect(store.getState().actionError?.kind).toBe('validation');
    expect(store.getState().reminders?.leadMinutes).toEqual([15]);
  });

  it('choosing a persona shows it at once and reads proactivity again (a persona carries its own)', async () => {
    const { store, api } = setup();
    await store.getState().refresh();
    const proactivity = jest.spyOn(api, 'proactivity');
    const pending = store.getState().setPersona('assistant');
    expect(store.getState().persona?.current).toBe('assistant');
    await pending;
    expect(proactivity).toHaveBeenCalled();
  });

  it('a persona that fails goes back to the old one', async () => {
    const { store, api } = setup();
    await store.getState().refresh();
    jest.spyOn(api, 'setPersona').mockRejectedValue(new ApiError('forbidden'));
    await store.getState().setPersona('assistant');
    expect(store.getState().persona?.current).toBe('friend');
    expect(store.getState().actionError?.kind).toBe('forbidden');
  });

  it('proactivity changes, and goes back if it fails', async () => {
    const { store, api } = setup();
    await store.getState().refresh();
    await store.getState().setProactivity('chatty');
    expect(store.getState().proactivity?.level).toBe('chatty');
    jest.spyOn(api, 'setProactivity').mockRejectedValue(new ApiError('server'));
    await store.getState().setProactivity('conservative');
    expect(store.getState().proactivity?.level).toBe('chatty');
  });

  it('an error can be dismissed', async () => {
    const { store, api } = setup();
    await store.getState().refresh();
    jest.spyOn(api, 'mute').mockRejectedValue(new ApiError('server'));
    await store.getState().mute();
    store.getState().dismissActionError();
    expect(store.getState().actionError).toBeNull();
  });
});

describe('parseLeadMinutes', () => {
  it.each([
    ['15', [15]],
    ['15, 5', [15, 5]],
    ['5 15 30', [30, 15, 5]],
    ['10,10,5', [10, 5]],
    ['  120 ', [120]],
  ])('%j -> %j', (text, expected) => expect(parseLeadMinutes(text)).toEqual(expected));

  it.each(['', '  ', '0', '121', '-5', '1.5', 'soon', '5, x', '1 2 3 4 5 6'])('%j is not accepted', (text) => expect(parseLeadMinutes(text)).toBeNull());
});

describe('refreshing on its own', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('loads at once, then every 10 s, and stops when asked', async () => {
    const { store, api } = setup(ALL, { refreshMs: 10_000 });
    const spy = jest.spyOn(api, 'privacy');
    store.getState().startPolling();
    await jest.advanceTimersByTimeAsync(0);
    expect(spy).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(spy).toHaveBeenCalledTimes(2);
    store.getState().stopPolling();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('starting twice does not double the refreshes', async () => {
    const { store, api } = setup(ALL, { refreshMs: 10_000 });
    const spy = jest.spyOn(api, 'privacy');
    store.getState().startPolling();
    store.getState().startPolling();
    await jest.advanceTimersByTimeAsync(0);
    expect(spy).toHaveBeenCalledTimes(1);
    store.getState().stopPolling();
  });

  it('reset clears everything and ignores a refresh that finishes afterwards', async () => {
    const { store } = setup();
    const running = store.getState().refresh();
    store.getState().reset();
    await running;
    expect(store.getState().tasks).toBeNull();
    expect(store.getState().loading).toBe(true);
  });
});
