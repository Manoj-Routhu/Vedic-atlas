import { ApiError } from './errors';
import type { PiApi } from './pi';
import type {
  ActivityItem, ChatEvent, ImageInfo, PendingApproval, PersonaInfo, PiTask, PrivacyInfo, ProactivityInfo, RemindersInfo,
  VisionEvent, VisionStatus, VisionStyle, VoiceInfo,
} from './types';

/**
 * "Try without a Pi": the same interface as the real thing, answering with fixed example text and no network. For people
 * without the hardware (and for judges). The screens show a clear "Demo" label; nothing here pretends to look at the photo.
 */

const DESCRIPTION = 'A red apple and a blue mug sit on a brown table. A white label in front reads "Best before 12/2027."';
const DETAILED =
  'A shiny red apple with a small green leaf sits on the left. Next to it is a blue mug with a round handle. ' +
  'Both rest on a wooden table in warm light. In front of them is a white paper label. ' +
  'It reads "Best before 12/2027" in dark letters.';

export function demoAnswer(style: VisionStyle, question?: string | null): string {
  const q = (question ?? '').trim().toLowerCase();
  if (q) {
    if (/label|say|text|date|read/.test(q)) return 'The label says "Best before 12/2027."';
    if (/ripe|fresh/.test(q)) return 'It looks ripe to me.';
    if (/colou?r/.test(q)) return 'The apple is red and the mug is blue.';
    return "I can't tell from this photo.";
  }
  if (style === 'read_text') return 'Best before 12/2027.';
  if (style === 'detailed') return DETAILED;
  return DESCRIPTION;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (ms <= 0 || signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', done);
      clearTimeout(t);
      resolve();
    }
    signal?.addEventListener('abort', done);
  });

export type DemoOptions = {
  /** How long the first photo "wakes the model", like the real thing. */
  coldMs?: number;
  /** Pause between words of an answer. */
  wordMs?: number;
};

export class DemoApi implements PiApi {
  private readonly coldMs: number;
  private readonly wordMs: number;
  private warm = false;
  private images = new Set<string>();
  private counter = 0;
  private approvals: PendingApproval[] = [];
  private muted = false;
  private taskList: PiTask[] = [
    { id: 1, title: 'Call mum', done: false, notes: '', dueAt: null },
    { id: 2, title: 'Buy milk', done: false, notes: '', dueAt: null },
  ];
  private persona_ = 'friend';
  private proactivity_ = 'medium';
  private leads = [15];

  constructor(opts: DemoOptions = {}) {
    this.coldMs = opts.coldMs ?? 1500;
    this.wordMs = opts.wordMs ?? 70;
  }

  async health(): Promise<void> {}

  async visionStatus(): Promise<VisionStatus> {
    return { enabled: true, loaded: this.warm, busy: false, idleSeconds: null, model: 'demo' };
  }

  async putImage(): Promise<ImageInfo> {
    const imageId = `demo-${++this.counter}`;
    this.images.add(imageId);
    return { imageId, width: 768, height: 576 };
  }

  async *askVision(req: { imageId: string; question?: string | null; style?: VisionStyle }, signal?: AbortSignal): AsyncGenerator<VisionEvent> {
    if (!this.images.has(req.imageId)) throw new ApiError('photoExpired');
    if (!this.warm) {
      yield { type: 'status', state: 'loading' };
      await sleep(this.coldMs, signal);
      if (signal?.aborted) return;
      this.warm = true;
    }
    const words = demoAnswer(req.style ?? 'brief', req.question).split(' ');
    for (let i = 0; i < words.length; i++) {
      if (signal?.aborted) return;
      await sleep(this.wordMs, signal);
      if (signal?.aborted) return;
      yield { type: 'token', text: words[i] + (i < words.length - 1 ? ' ' : '') };
    }
    yield { type: 'done' };
  }

  async *chatStream(message: string, signal?: AbortSignal): AsyncGenerator<ChatEvent> {
    const lower = message.toLowerCase();
    let reply: string;
    if (lower.includes('email') && lower.includes('send')) {
      this.approvals = [{ requestId: `demo-approval-${++this.counter}`, actionName: 'send_email', ageSeconds: 0, summary: 'Veda wants to send an email to Priya: "Running late, be there by 7." Approve?' }];
      reply = "I can send that. I need your OK first, it's waiting.";
    } else if (/hello|hi\b|hey/.test(lower)) {
      reply = "Hello! This is demo mode, so I'm answering with examples. Pair with your Pi to talk to the real Veda.";
    } else {
      reply = "That's a demo answer. Pair with your Pi to get a real one.";
    }
    for (const word of reply.split(' ')) {
      if (signal?.aborted) return;
      await sleep(this.wordMs, signal);
      yield { type: 'text', text: word + ' ' };
    }
    if (!signal?.aborted) yield { type: 'done' };
  }

  // ---------- control: example data, kept in memory ----------

  async autoApprove(): Promise<boolean> {
    return false;
  }

  async privacy(): Promise<PrivacyInfo> {
    return { muted: this.muted, source: 'api', hardwareSwitch: false };
  }

  async mute(): Promise<PrivacyInfo> {
    this.muted = true;
    return this.privacy();
  }

  async voice(): Promise<VoiceInfo> {
    return { available: true, running: !this.muted };
  }

  async tasks(): Promise<PiTask[]> {
    return this.taskList.filter((t) => !t.done).map((t) => ({ ...t }));
  }

  async addTask(title: string): Promise<PiTask> {
    const task: PiTask = { id: ++this.counter + 100, title, done: false, notes: '', dueAt: null };
    this.taskList.push(task);
    return { ...task };
  }

  async completeTask(id: number): Promise<void> {
    const task = this.taskList.find((t) => t.id === id);
    if (!task) throw new ApiError('notFound');
    task.done = true;
  }

  async reminders(): Promise<RemindersInfo> {
    return { running: true, lastSyncOk: true, pending: 1, nextDueAt: null, enabled: true, leadMinutes: [...this.leads], atStart: true, skipAllDay: true };
  }

  async setReminderLeads(minutes: number[]): Promise<void> {
    this.leads = [...minutes];
  }

  async persona(): Promise<PersonaInfo> {
    return {
      current: this.persona_,
      options: [
        { id: 'friend', label: 'Friend', tagline: 'Warm and chatty', proactivity: 'medium' },
        { id: 'assistant', label: 'Assistant', tagline: 'Short and to the point', proactivity: 'conservative' },
      ],
    };
  }

  async setPersona(id: string): Promise<void> {
    this.persona_ = id;
  }

  async proactivity(): Promise<ProactivityInfo> {
    return { level: this.proactivity_, options: ['conservative', 'medium', 'chatty'] };
  }

  async setProactivity(level: string): Promise<void> {
    this.proactivity_ = level;
  }

  async activity(): Promise<ActivityItem[]> {
    return [
      { id: 2, at: '2026-10-25T09:30:00', agent: 'demo', totalMs: 400, tools: [{ name: 'set_reminder', ok: true, ms: 400 }] },
      { id: 1, at: '2026-10-25T09:00:00', agent: 'demo', totalMs: 1200, tools: [{ name: 'weather', ok: true, ms: 1200 }] },
    ];
  }

  async pendingApprovals(): Promise<PendingApproval[]> {
    return [...this.approvals];
  }

  async approve(requestId: string): Promise<void> {
    this.approvals = this.approvals.filter((a) => a.requestId !== requestId);
  }

  async deny(requestId: string): Promise<void> {
    this.approvals = this.approvals.filter((a) => a.requestId !== requestId);
  }
}
