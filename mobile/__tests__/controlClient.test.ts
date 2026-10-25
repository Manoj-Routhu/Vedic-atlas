import { VedaApi } from '../src/api/client';
import { ApiError } from '../src/api/errors';
import { DemoApi } from '../src/api/demo';
import { FakeTransport, json } from './helpers/fakeTransport';

function setup(reply: Parameters<typeof json>[1], status = 200) {
  const t = new FakeTransport(() => json(status, reply));
  const api = new VedaApi({ host: '192.168.1.20', port: 8000, token: 'tok', transport: t });
  return { api, t };
}

const body = (t: FakeTransport) => JSON.parse(String(t.last.body ?? 'null'));

describe('Control calls: what is sent and how the answer is read', () => {
  it('auto-approve is read-only: a GET, true only when the Pi says so', async () => {
    const on = setup({ yolo: true });
    expect(await on.api.autoApprove()).toBe(true);
    expect(on.t.last).toMatchObject({ method: 'GET', url: 'http://192.168.1.20:8000/api/approval/yolo' });
    expect(await setup({ yolo: false }).api.autoApprove()).toBe(false);
    expect(await setup({}).api.autoApprove()).toBe(false);
  });

  it('microphone status, in the app\'s words', async () => {
    const { api, t } = setup({ muted: true, source: 'api', hardware_switch: false, since: '2026-10-25T10:00:00', egress_allow_list: [] });
    expect(await api.privacy()).toEqual({ muted: true, source: 'api', hardwareSwitch: false });
    expect(t.last).toMatchObject({ method: 'GET', url: expect.stringContaining('/api/privacy/status') });
  });

  it('mute sends muted:true and nothing else; there is no call to unmute', async () => {
    const { api, t } = setup({ muted: true, source: 'api', hardware_switch: false });
    const r = await api.mute();
    expect(t.last).toMatchObject({ method: 'POST', url: expect.stringContaining('/api/privacy/mute') });
    expect(body(t)).toEqual({ muted: true });
    expect(r.muted).toBe(true);
    expect(Object.keys(api).concat(Object.getOwnPropertyNames(Object.getPrototypeOf(api))).some((k) => /unmute/i.test(k))).toBe(false);
  });

  it('a privacy answer with no "muted" is a bad response, not a guess', async () => {
    const { api } = setup({ source: 'api' });
    await expect(api.privacy()).rejects.toMatchObject({ kind: 'badResponse' });
  });

  it('voice status', async () => {
    expect(await setup({ available: true, running: true, extra: 1 }).api.voice()).toEqual({ available: true, running: true });
    expect(await setup({ available: false, running: false, reason: 'voice session not built' }).api.voice()).toEqual({ available: false, running: false });
  });

  it('tasks: list, add, complete', async () => {
    const list = setup({ tasks: [{ id: 3, title: 'Call mum', done: false, notes: '', due_at: '2026-10-25T18:00:00' }, { id: 4, title: 'Buy milk', done: false }] });
    expect(await list.api.tasks()).toEqual([
      { id: 3, title: 'Call mum', done: false, notes: '', dueAt: '2026-10-25T18:00:00' },
      { id: 4, title: 'Buy milk', done: false, notes: '', dueAt: null },
    ]);
    expect(list.t.last).toMatchObject({ method: 'GET', url: expect.stringMatching(/\/api\/tasks$/) });

    const add = setup({ id: 9, title: 'Water plants', done: false, notes: '', due_at: null });
    expect(await add.api.addTask('Water plants')).toMatchObject({ id: 9, title: 'Water plants', done: false });
    expect(add.t.last).toMatchObject({ method: 'POST' });
    expect(body(add.t)).toEqual({ title: 'Water plants' });

    const done = setup({ status: 'completed', id: 9 });
    await done.api.completeTask(9);
    expect(done.t.last).toMatchObject({ method: 'POST', url: expect.stringContaining('/api/tasks/9/complete') });
  });

  it('a task answer without an id is a bad response', async () => {
    await expect(setup({ title: 'x' }).api.addTask('x')).rejects.toMatchObject({ kind: 'badResponse' });
  });

  it('completing a task that is already gone is "not found"', async () => {
    const { api } = setup({ detail: 'task not found' }, 404);
    await expect(api.completeTask(1)).rejects.toMatchObject({ kind: 'notFound' });
  });

  it('reminders: the status and the settings come together', async () => {
    const { api } = setup({
      running: true, last_sync_at: '2026-10-25T10:00:00', last_sync_ok: true, pending: 2, queued_to_say: 0, next_due_at: '2026-10-25T16:15:00',
      config: { enabled: true, lead_minutes: [15, 5], at_start: true, skip_all_day: true },
    });
    expect(await api.reminders()).toEqual({
      running: true, lastSyncOk: true, pending: 2, nextDueAt: '2026-10-25T16:15:00', enabled: true, leadMinutes: [15, 5], atStart: true, skipAllDay: true,
    });
  });

  it('changing the heads-up time sends only lead_minutes', async () => {
    const { api, t } = setup({ enabled: true, lead_minutes: [30], at_start: true, skip_all_day: true });
    await api.setReminderLeads([30]);
    expect(t.last).toMatchObject({ method: 'PUT', url: expect.stringContaining('/api/reminders/config') });
    expect(body(t)).toEqual({ lead_minutes: [30] });
  });

  it('a heads-up list the Pi rejects is a validation message, not a crash', async () => {
    const { api } = setup({ detail: 'lead times must be between 1 and 120 minutes' }, 422);
    await expect(api.setReminderLeads([999])).rejects.toMatchObject({ kind: 'validation' });
  });

  it('persona: the current one and the choices', async () => {
    const { api } = setup({
      state: { persona: 'friend', completed: true },
      catalog: [{ id: 'friend', label: 'Friend', tagline: 'Warm', proactivity: 'medium' }, { id: 'assistant', label: 'Assistant', tagline: 'Brief', proactivity: 'conservative' }],
    });
    const info = await api.persona();
    expect(info.current).toBe('friend');
    expect(info.options.map((o) => o.id)).toEqual(['friend', 'assistant']);
  });

  it('choosing a persona sends its id', async () => {
    const { api, t } = setup({ state: {} });
    await api.setPersona('assistant');
    expect(t.last).toMatchObject({ method: 'POST', url: expect.stringContaining('/api/persona') });
    expect(body(t)).toEqual({ persona: 'assistant' });
  });

  it('proactivity: level and the valid levels; changing sends level', async () => {
    const { api, t } = setup({ level: 'medium', valid: ['conservative', 'medium', 'chatty'] });
    expect(await api.proactivity()).toEqual({ level: 'medium', options: ['conservative', 'medium', 'chatty'] });
    await api.setProactivity('chatty');
    expect(t.last).toMatchObject({ method: 'POST', url: expect.stringContaining('/api/config/proactivity') });
    expect(body(t)).toEqual({ level: 'chatty' });
  });

  it('recent activity: tools, whether they worked, and how long; the limit is kept sensible', async () => {
    const { api, t } = setup({
      traces: [
        { id: 7, request_id: 'r', created_at: '2026-10-25T09:00:00', agent: 'main', user_message: 'x', reply: 'y', decided: 'tool', forced: false, narrated: false, total_ms: 1200,
          calls: [{ tool: 'weather', args: { city: 'Pune' }, ok: true, ms: 1100, result: 'sunny' }, { tool: 'set_reminder', args: {}, ok: false, ms: 50, result: '', error: 'x' }] },
      ],
    });
    expect(await api.activity(5)).toEqual([
      { id: 7, at: '2026-10-25T09:00:00', agent: 'main', totalMs: 1200, tools: [{ name: 'weather', ok: true, ms: 1100 }, { name: 'set_reminder', ok: false, ms: 50 }] },
    ]);
    expect(t.last.url).toContain('/api/trace?limit=5');
    await api.activity(9999);
    expect(t.last.url).toContain('limit=50');
    await api.activity(0);
    expect(t.last.url).toContain('limit=1');
  });

  it('a phone without the control permission gets "forbidden", which the screen can explain', async () => {
    const { api } = setup({ error: { code: 'DEVICE_FORBIDDEN', message: "this device lacks the 'control' permission" } }, 403);
    await expect(api.privacy()).rejects.toMatchObject({ kind: 'forbidden' });
  });

  it('an unreachable Pi is reported as such', async () => {
    const t = new FakeTransport(() => {
      throw new TypeError('Network request failed');
    });
    const api = new VedaApi({ host: '192.168.1.20', port: 8000, token: 'tok', transport: t });
    const err = await api.tasks().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).kind).toBe('unreachable');
  });
});

describe('Demo mode has the same Control, with example data', () => {
  it('lists, adds and completes tasks', async () => {
    const demo = new DemoApi();
    const before = await demo.tasks();
    expect(before.map((t) => t.title)).toEqual(['Call mum', 'Buy milk']);
    const added = await demo.addTask('Water plants');
    expect((await demo.tasks()).map((t) => t.title)).toContain('Water plants');
    await demo.completeTask(added.id);
    expect((await demo.tasks()).map((t) => t.title)).not.toContain('Water plants');
    await expect(demo.completeTask(99999)).rejects.toMatchObject({ kind: 'notFound' });
  });

  it('muting closes the microphone and nothing can open it', async () => {
    const demo = new DemoApi();
    expect((await demo.privacy()).muted).toBe(false);
    expect((await demo.mute()).muted).toBe(true);
    expect((await demo.privacy()).muted).toBe(true);
    expect((await demo.voice()).running).toBe(false);
  });

  it('settings stick', async () => {
    const demo = new DemoApi();
    await demo.setPersona('assistant');
    await demo.setProactivity('chatty');
    await demo.setReminderLeads([30, 10]);
    expect((await demo.persona()).current).toBe('assistant');
    expect((await demo.proactivity()).level).toBe('chatty');
    expect((await demo.reminders()).leadMinutes).toEqual([30, 10]);
    expect(await demo.autoApprove()).toBe(false);
    expect((await demo.activity()).length).toBeGreaterThan(0);
  });
});
