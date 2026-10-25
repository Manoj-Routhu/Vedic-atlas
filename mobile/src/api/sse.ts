/**
 * Server-Sent Events parsing, per the WHATWG spec: lines end in \n, \r or \r\n (a \r\n may be split across network chunks),
 * a blank line ends an event, `data:` lines of one event are joined with \n, a single space after the colon is dropped,
 * lines starting with ":" are comments (keep-alives), and an event cut off before its blank line is discarded.
 */

export type SseEvent = { event: string | null; data: string };

export class SseParser {
  private buffer = '';
  private dataLines: string[] = [];
  private eventName: string | null = null;
  private first = true;

  /** Feed decoded text; returns the events completed by it. */
  push(chunk: string): SseEvent[] {
    if (this.first && chunk.length > 0) {
      this.first = false;
      if (chunk.charCodeAt(0) === 0xfeff) chunk = chunk.slice(1); // byte-order mark
    }
    this.buffer += chunk;
    const events: SseEvent[] = [];

    let start = 0;
    let i = 0;
    while (i < this.buffer.length) {
      const ch = this.buffer[i];
      if (ch !== '\n' && ch !== '\r') {
        i++;
        continue;
      }
      if (ch === '\r' && i + 1 === this.buffer.length) break; // might be the first half of \r\n: wait for more
      const line = this.buffer.slice(start, i);
      i += ch === '\r' && this.buffer[i + 1] === '\n' ? 2 : 1;
      start = i;
      const done = this.line(line);
      if (done) events.push(done);
    }
    this.buffer = this.buffer.slice(start);
    return events;
  }

  private line(line: string): SseEvent | null {
    if (line === '') {
      if (this.dataLines.length === 0) {
        this.eventName = null;
        return null;
      }
      const event = { event: this.eventName, data: this.dataLines.join('\n') };
      this.dataLines = [];
      this.eventName = null;
      return event;
    }
    if (line.startsWith(':')) return null;

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'data') this.dataLines.push(value);
    else if (field === 'event') this.eventName = value;
    // `id` and `retry` are not used by the Pi
    return null;
  }
}

/** Decode a byte stream (e.g. a fetch body) into SSE events. UTF-8 characters split across chunks are handled. */
export async function* sseEvents(chunks: AsyncIterable<Uint8Array | string>): AsyncGenerator<SseEvent> {
  const parser = new SseParser();
  const decoder = new TextDecoder('utf-8');
  for await (const chunk of chunks) {
    const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    for (const event of parser.push(text)) yield event;
  }
  const tail = decoder.decode(); // flush a character that was waiting for its last byte
  if (tail) for (const event of parser.push(tail)) yield event;
}
