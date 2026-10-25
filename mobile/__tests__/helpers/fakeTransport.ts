import type { HttpRequest, HttpResponse, HttpTransport } from '../../src/api/transport';

export type Item = string | Uint8Array | { wait: number };

export type FakeReply = {
  status?: number;
  headers?: Record<string, string>;
  /** The whole body, for plain responses. */
  body?: string;
  /** The body as a stream of pieces (strings are UTF-8 encoded; `{wait}` pauses). */
  stream?: Item[];
  /** Never answer (until the request is aborted). */
  hang?: boolean;
};

const encoder = new TextEncoder();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function abortError() {
  return Object.assign(new Error('aborted'), { name: 'AbortError' });
}

/** Resolves after `ms`, or rejects with an AbortError as soon as `signal` aborts (what a real fetch does). */
function waitOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class FakeTransport implements HttpTransport {
  requests: HttpRequest[] = [];
  /** How many response bodies were closed (the stream ended, or the reader stopped early). */
  bodiesClosed = 0;
  /** Requests whose signal was aborted. */
  aborted = 0;

  constructor(private readonly handler: (req: HttpRequest, n: number) => FakeReply | Promise<FakeReply>) {}

  get last(): HttpRequest {
    return this.requests[this.requests.length - 1] as HttpRequest;
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    this.requests.push(req);
    req.signal?.addEventListener('abort', () => this.aborted++, { once: true });
    const reply = await this.handler(req, this.requests.length);
    if (reply.hang) await waitOrAbort(60_000, req.signal);

    const headers = Object.fromEntries(Object.entries(reply.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const items = reply.stream ?? (reply.body !== undefined ? [reply.body] : []);
    const self = this;
    return {
      status: reply.status ?? 200,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      text: async () => (reply.body ?? items.filter((i): i is string => typeof i === 'string').join('')),
      async *chunks() {
        try {
          for (const item of items) {
            if (typeof item === 'object' && 'wait' in item) await waitOrAbort(item.wait, req.signal);
            else yield typeof item === 'string' ? encoder.encode(item) : item;
          }
        } finally {
          self.bodiesClosed++;
        }
      },
    };
  }
}

export const json = (status: number, body: unknown, headers: Record<string, string> = {}): FakeReply => ({
  status, body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers },
});

export const sse = (...events: string[]): string => events.map((e) => `data: ${e}\n\n`).join('');

export { sleep };
