/**
 * The one seam between the app and the network. The API client talks to an `HttpTransport`; production wraps `fetch`
 * (on Android in Expo SDK 58 the global `fetch` is `expo/fetch`, which can stream a response body), and tests pass a fake.
 */

export type HttpRequest = {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  signal?: AbortSignal;
};

export interface HttpResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  /** The body as it arrives. Stopping the iteration early closes the connection. */
  chunks(): AsyncIterable<Uint8Array>;
}

export interface HttpTransport {
  request(req: HttpRequest): Promise<HttpResponse>;
}

type FetchLike = (url: string, init: Record<string, unknown>) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
  body: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> | void } } | null;
}>;

export function fetchTransport(fetchImpl?: FetchLike): HttpTransport {
  const doFetch = (fetchImpl ?? (globalThis.fetch as unknown as FetchLike)).bind(globalThis);
  return {
    async request(req) {
      const res = await doFetch(req.url, { method: req.method, headers: req.headers, body: req.body, signal: req.signal });
      return {
        status: res.status,
        headers: res.headers,
        text: () => res.text(),
        async *chunks() {
          if (!res.body) {
            yield new Uint8Array(await res.arrayBuffer());
            return;
          }
          const reader = res.body.getReader();
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) return;
              if (value) yield value;
            }
          } finally {
            try {
              await reader.cancel(); // closes the connection if the caller stopped early; harmless after the end
            } catch {
              // already closed
            }
          }
        },
      };
    },
  };
}
