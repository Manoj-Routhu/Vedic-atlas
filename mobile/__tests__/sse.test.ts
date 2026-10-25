import { SseParser, sseEvents, type SseEvent } from '../src/api/sse';
import { parseVisionEvent } from '../src/api/types';

function parseAll(text: string): SseEvent[] {
  const p = new SseParser();
  return p.push(text);
}

describe('SseParser', () => {
  it('parses one event', () => {
    expect(parseAll('data: hello\n\n')).toEqual([{ event: null, data: 'hello' }]);
  });

  it('joins multi-line data with a newline and drops one leading space (the Pi frames line breaks this way)', () => {
    expect(parseAll('data: line one\ndata: line two\ndata: \ndata:  indented\n\n')).toEqual([
      { event: null, data: 'line one\nline two\n\n indented' },
    ]);
  });

  it('reads the event name', () => {
    expect(parseAll('event: ping\ndata: x\n\n')).toEqual([{ event: 'ping', data: 'x' }]);
  });

  it('ignores comments and unknown fields', () => {
    expect(parseAll(': keep-alive\nid: 7\nretry: 1000\ndata: ok\n\n')).toEqual([{ event: null, data: 'ok' }]);
  });

  it('does not emit an event with no data, and does not leak an event name into the next one', () => {
    expect(parseAll('event: lonely\n\ndata: next\n\n')).toEqual([{ event: null, data: 'next' }]);
  });

  it('accepts \\r\\n and bare \\r line endings', () => {
    expect(parseAll('data: a\r\n\r\ndata: b\r\rdata: c\n\n')).toEqual([
      { event: null, data: 'a' }, { event: null, data: 'b' }, { event: null, data: 'c' },
    ]);
  });

  it('handles a field without a colon as an empty value', () => {
    expect(parseAll('data\n\n')).toEqual([{ event: null, data: '' }]);
  });

  it('drops a byte-order mark', () => {
    expect(parseAll('﻿data: x\n\n')).toEqual([{ event: null, data: 'x' }]);
  });

  it('discards an event that was cut off before its blank line', () => {
    const p = new SseParser();
    expect(p.push('data: complete\n\ndata: cut off')).toEqual([{ event: null, data: 'complete' }]);
  });

  const stream = 'data: first\n\n: ping\n\ndata: a\ndata: b\n\nevent: x\ndata: {"type":"done"}\n\ndata: [DONE]\n\n';
  const expected: SseEvent[] = [
    { event: null, data: 'first' },
    { event: null, data: 'a\nb' },
    { event: 'x', data: '{"type":"done"}' },
    { event: null, data: '[DONE]' },
  ];

  it('gives the same events however the stream is cut: every split point', () => {
    for (let i = 0; i <= stream.length; i++) {
      const p = new SseParser();
      const got = [...p.push(stream.slice(0, i)), ...p.push(stream.slice(i))];
      expect(got).toEqual(expected);
    }
  });

  it('gives the same events one character at a time', () => {
    const p = new SseParser();
    const got = [...stream].flatMap((c) => p.push(c));
    expect(got).toEqual(expected);
  });

  it('copes with \\r\\n split between chunks', () => {
    const p = new SseParser();
    const got = [...p.push('data: x\r'), ...p.push('\n'), ...p.push('\r'), ...p.push('\n')];
    expect(got).toEqual([{ event: null, data: 'x' }]);
  });
});

async function* bytes(parts: (Uint8Array | string)[]): AsyncGenerator<Uint8Array | string> {
  for (const p of parts) yield p;
}

async function collect(chunks: AsyncIterable<Uint8Array | string>): Promise<SseEvent[]> {
  const out: SseEvent[] = [];
  for await (const e of sseEvents(chunks)) out.push(e);
  return out;
}

describe('sseEvents (bytes to events)', () => {
  it('decodes a multi-byte character split across chunks', () => {
    const all = new TextEncoder().encode('data: café ☕ \u{1F34E}\n\n');
    // split inside the 2-byte e-acute, the 3-byte coffee cup and the 4-byte apple
    const cuts = [10, 14, 18];
    const parts: Uint8Array[] = [];
    let last = 0;
    for (const c of [...cuts, all.length]) {
      parts.push(all.slice(last, c));
      last = c;
    }
    return expect(collect(bytes(parts))).resolves.toEqual([{ event: null, data: 'café ☕ \u{1F34E}' }]);
  });

  it('accepts text chunks too', () => {
    return expect(collect(bytes(['data: a\n', '\ndata: b\n\n']))).resolves.toEqual([
      { event: null, data: 'a' }, { event: null, data: 'b' },
    ]);
  });

  it('yields nothing for an empty stream', () => {
    return expect(collect(bytes([]))).resolves.toEqual([]);
  });
});

describe('parseVisionEvent', () => {
  it('reads the four event types the Pi sends', () => {
    expect(parseVisionEvent('{"type":"status","state":"loading"}')).toEqual({ type: 'status', state: 'loading' });
    expect(parseVisionEvent('{"type":"token","text":"A red "}')).toEqual({ type: 'token', text: 'A red ' });
    expect(parseVisionEvent('{"type":"done"}')).toEqual({ type: 'done' });
    expect(parseVisionEvent('{"type":"error","code":"VISION_UNAVAILABLE","message":"x"}')).toEqual({
      type: 'error', code: 'VISION_UNAVAILABLE', message: 'x',
    });
  });

  it('returns null for unknown types, wrong shapes and non-JSON, so a newer Pi cannot break the app', () => {
    for (const bad of ['{"type":"future"}', '{"type":"token"}', '{"type":"token","text":5}', '{"type":"error","code":"x"}',
      '[]', '5', 'null', 'not json', '']) {
      expect(parseVisionEvent(bad)).toBeNull();
    }
  });
});
