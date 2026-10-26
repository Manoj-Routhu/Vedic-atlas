import { controlCalls } from './controlClient';
import { musicCalls } from './musicClient';
import type { PiApi } from './pi';
import { ApiError, apiErrorFromResponse, apiErrorFromThrown, type ResponseContext } from './errors';
import { sseEvents, type SseEvent } from './sse';
import type { HttpResponse, HttpTransport } from './transport';
import {
  parseVisionEvent,
  type ChatEvent,
  type ImageInfo,
  type PairResult,
  type PendingApproval,
  type VisionEvent,
  type VisionStatus,
  type VisionStyle,
} from './types';
import { buildBaseUrl } from '../util/hostCheck';

export type ClientOptions = {
  host: string;
  port: number;
  token?: string | null;
  transport: HttpTransport;
  /** Give up on a plain request (headers and body) after this long. */
  requestTimeoutMs?: number;
  /** Give up on a stream that has sent nothing for this long. The first photo can wait on a cold model, so this is generous. */
  streamStallMs?: number;
};

type Send = {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  json?: unknown;
  body?: Uint8Array;
  contentType?: string;
  context?: ResponseContext;
  auth?: boolean;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_STREAM_STALL_MS = 120_000;

/** Wait for `promise`, but fail with a timeout, or stop with a cancel, whichever comes first. */
function guard<T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  promise.catch(() => undefined); // if we give up on it first, its later failure must not become an unhandled rejection
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => finish(() => reject(new ApiError('cancelled')));
    const timer = setTimeout(() => finish(() => reject(new ApiError('timeout'))), ms);
    const finish = (fn: () => void) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    if (signal?.aborted) return finish(() => reject(new ApiError('cancelled')));
    signal?.addEventListener('abort', onAbort);
    promise.then(
      (v) => finish(() => resolve(v)),
      (e) => finish(() => reject(e)),
    );
  });
}

/** A signal that follows `outer` and can also be aborted by us, so we can always close the connection we opened. */
function linked(outer?: AbortSignal) {
  const controller = new AbortController();
  const relay = () => controller.abort();
  if (outer?.aborted) controller.abort();
  else outer?.addEventListener('abort', relay);
  return {
    signal: controller.signal,
    /** Abort the request (a no-op once it has finished) and stop listening to `outer`. */
    dispose: () => {
      outer?.removeEventListener('abort', relay);
      controller.abort();
    },
  };
}

export class VedaApi implements PiApi {
  readonly baseUrl: string;
  private readonly host: string;
  private readonly port: number;
  private readonly token: string | null;
  private readonly transport: HttpTransport;
  private readonly requestTimeoutMs: number;
  private readonly streamStallMs: number;

  /** Throws ApiError('hostNotAllowed') unless the host is on a private network. The token is never sent anywhere else. */
  constructor(opts: ClientOptions) {
    const base = buildBaseUrl(opts.host, opts.port);
    if (!base) throw new ApiError('hostNotAllowed');
    this.baseUrl = base;
    this.host = opts.host;
    this.port = opts.port;
    this.token = opts.token ?? null;
    this.transport = opts.transport;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.streamStallMs = opts.streamStallMs ?? DEFAULT_STREAM_STALL_MS;
  }

  withToken(token: string | null): VedaApi {
    return new VedaApi({
      host: this.host, port: this.port, token, transport: this.transport,
      requestTimeoutMs: this.requestTimeoutMs, streamStallMs: this.streamStallMs,
    });
  }

  // ---------- plain requests ----------

  async health(signal?: AbortSignal): Promise<void> {
    await this.sendJson({ method: 'GET', path: '/api/health' }, signal);
  }

  async pair(code: string, deviceName: string, signal?: AbortSignal): Promise<PairResult> {
    const r = (await this.sendJson(
      { method: 'POST', path: '/api/pair', json: { code, device_name: deviceName }, context: 'pair', auth: false },
      signal,
    )) as { device_id?: string; token?: string; scopes?: string[] } | null;
    if (typeof r?.token !== 'string' || typeof r.device_id !== 'string') throw new ApiError('badResponse');
    return { deviceId: r.device_id, token: r.token, scopes: r.scopes ?? [] };
  }

  async putImage(bytes: Uint8Array, mime = 'image/jpeg', signal?: AbortSignal): Promise<ImageInfo> {
    const r = (await this.sendJson(
      { method: 'PUT', path: '/api/vision/images', body: bytes, contentType: mime },
      signal,
    )) as { image_id?: string; width?: number; height?: number } | null;
    if (typeof r?.image_id !== 'string') throw new ApiError('badResponse');
    return { imageId: r.image_id, width: r.width ?? 0, height: r.height ?? 0 };
  }

  async visionStatus(signal?: AbortSignal): Promise<VisionStatus> {
    const r = (await this.sendJson({ method: 'GET', path: '/api/vision/status' }, signal)) as {
      enabled: boolean; loaded: boolean; busy: boolean; idle_seconds: number | null; model: string;
    } | null;
    if (!r) throw new ApiError('badResponse');
    return { enabled: r.enabled, loaded: r.loaded, busy: r.busy, idleSeconds: r.idle_seconds ?? null, model: r.model };
  }

  // ---------- approvals ----------

  async pendingApprovals(signal?: AbortSignal): Promise<PendingApproval[]> {
    const r = (await this.sendJson({ method: 'GET', path: '/api/approval/pending' }, signal)) as {
      pending?: { request_id: string; action_name: string; age_sec: number; summary: string }[];
    } | null;
    return (r?.pending ?? []).map((p) => ({ requestId: p.request_id, actionName: p.action_name, ageSeconds: p.age_sec, summary: p.summary }));
  }

  /** Needs the `approve` permission, which a phone only has if it was paired with `veda pair --allow-approve`. */
  async approve(requestId: string, signal?: AbortSignal): Promise<void> {
    await this.sendJson({ method: 'POST', path: `/api/approval/${encodeURIComponent(requestId)}/approve` }, signal);
  }

  async deny(requestId: string, signal?: AbortSignal): Promise<void> {
    await this.sendJson({ method: 'POST', path: `/api/approval/${encodeURIComponent(requestId)}/deny` }, signal);
  }

  // ---------- control (mapped in controlClient.ts) ----------

  private readonly control = controlCalls((req, signal) => this.sendJson(req, signal));
  autoApprove = (signal?: AbortSignal) => this.control.autoApprove(signal);
  privacy = (signal?: AbortSignal) => this.control.privacy(signal);
  mute = (signal?: AbortSignal) => this.control.mute(signal);
  voice = (signal?: AbortSignal) => this.control.voice(signal);
  tasks = (signal?: AbortSignal) => this.control.tasks(signal);
  addTask = (title: string, signal?: AbortSignal) => this.control.addTask(title, signal);
  completeTask = (id: number, signal?: AbortSignal) => this.control.completeTask(id, signal);
  reminders = (signal?: AbortSignal) => this.control.reminders(signal);
  setReminderLeads = (minutes: number[], signal?: AbortSignal) => this.control.setReminderLeads(minutes, signal);
  persona = (signal?: AbortSignal) => this.control.persona(signal);
  setPersona = (id: string, signal?: AbortSignal) => this.control.setPersona(id, signal);
  proactivity = (signal?: AbortSignal) => this.control.proactivity(signal);
  setProactivity = (level: string, signal?: AbortSignal) => this.control.setProactivity(level, signal);
  activity = (limit?: number, signal?: AbortSignal) => this.control.activity(limit, signal);

  // ---------- music (mapped in musicClient.ts) ----------

  private readonly music = musicCalls((req, signal) => this.sendJson(req, signal));
  musicStatus = (signal?: AbortSignal) => this.music.musicStatus(signal);
  playSong = (query: string, signal?: AbortSignal) => this.music.playSong(query, signal);
  stopMusic = (signal?: AbortSignal) => this.music.stopMusic(signal);
  pauseMusic = (signal?: AbortSignal) => this.music.pauseMusic(signal);
  resumeMusic = (signal?: AbortSignal) => this.music.resumeMusic(signal);

  // ---------- streams ----------

  /**
   * Ask about a stored photo. Yields status/token events and ends after `done` or `error`.
   * Throws ApiError before the first event for things like a busy model (429) or an expired photo (422).
   * If `signal` aborts, the stream just ends quietly. Stopping the iteration early closes the connection.
   */
  async *askVision(
    req: { imageId: string; question?: string | null; style?: VisionStyle },
    signal?: AbortSignal,
  ): AsyncGenerator<VisionEvent> {
    const link = linked(signal);
    try {
      const res = await this.openStream(
        { method: 'POST', path: '/api/vision/ask', json: { image_id: req.imageId, question: req.question || null, style: req.style ?? 'brief', lang: 'en' } },
        link.signal, signal,
      );
      let finished = false;
      for await (const sse of this.events(res, signal)) {
        const event = parseVisionEvent(sse.data);
        if (!event) continue; // a newer Pi may send events this app does not know
        yield event;
        if (event.type === 'done' || event.type === 'error') {
          finished = true;
          return;
        }
      }
      if (!finished && !signal?.aborted) throw new ApiError('cutOff');
    } catch (e) {
      const err = apiErrorFromThrown(e);
      if (err.kind === 'cancelled') return;
      throw err;
    } finally {
      link.dispose();
    }
  }

  /** Chat with Veda. Yields text chunks and a final `done`. The phone sends only the message: never system context. */
  async *chatStream(message: string, signal?: AbortSignal, sessionId?: string): AsyncGenerator<ChatEvent> {
    const link = linked(signal);
    try {
      const res = await this.openStream(
        { method: 'POST', path: '/api/stream', json: sessionId ? { message, session_id: sessionId } : { message } },
        link.signal, signal,
      );
      let finished = false;
      for await (const sse of this.events(res, signal)) {
        if (sse.data === '[DONE]') {
          finished = true;
          yield { type: 'done' };
          return;
        }
        if (sse.data !== '') yield { type: 'text', text: sse.data };
      }
      if (!finished && !signal?.aborted) throw new ApiError('cutOff');
    } catch (e) {
      const err = apiErrorFromThrown(e);
      if (err.kind === 'cancelled') return;
      throw err;
    } finally {
      link.dispose();
    }
  }

  // ---------- plumbing ----------

  private headers(s: Send): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.token && s.auth !== false) h.Authorization = `Bearer ${this.token}`;
    if (s.json !== undefined) h['Content-Type'] = 'application/json';
    if (s.contentType) h['Content-Type'] = s.contentType;
    return h;
  }

  /** Send the request and return the response if it succeeded; throw the matching ApiError if it did not. */
  private async open(s: Send, netSignal: AbortSignal): Promise<HttpResponse> {
    const body = s.json !== undefined ? JSON.stringify(s.json) : s.body;
    const res = await this.transport.request({
      method: s.method, url: this.baseUrl + s.path, headers: this.headers(s), body, signal: netSignal,
    });
    if (res.status < 200 || res.status >= 300) {
      throw apiErrorFromResponse(res.status, await res.text().catch(() => ''), res.headers, s.context);
    }
    return res;
  }

  /** A request whose whole answer is small JSON: one overall timeout, and the connection is closed on any failure. */
  private async sendJson(s: Send, outer?: AbortSignal): Promise<unknown> {
    const link = linked(outer);
    try {
      const work = (async () => {
        const res = await this.open(s, link.signal);
        const text = await res.text();
        if (text === '') return null;
        try {
          return JSON.parse(text) as unknown;
        } catch {
          throw new ApiError('badResponse');
        }
      })();
      return await guard(work, this.requestTimeoutMs, outer);
    } catch (e) {
      throw apiErrorFromThrown(e);
    } finally {
      link.dispose();
    }
  }

  /** A request answered with a stream: the timeout covers only getting the response to start. */
  private async openStream(s: Send, netSignal: AbortSignal, outer?: AbortSignal): Promise<HttpResponse> {
    return guard(this.open(s, netSignal), this.requestTimeoutMs, outer);
  }

  private async *events(res: HttpResponse, outer?: AbortSignal): AsyncGenerator<SseEvent> {
    const iterator = sseEvents(res.chunks())[Symbol.asyncIterator]();
    try {
      for (;;) {
        const next = await guard(iterator.next(), this.streamStallMs, outer);
        if (next.done) return;
        yield next.value;
      }
    } finally {
      // Closes the body when we stop early. If the reader is mid-wait it rejects (with the abort that got us here);
      // nobody is waiting for that, so it must be swallowed or it surfaces as an unhandled rejection.
      void Promise.resolve(iterator.return?.(undefined)).catch(() => undefined);
    }
  }
}
