/**
 * Cuts a streamed reply into sentences so speech can start as soon as the first one is complete, not after the whole answer.
 *
 * A sentence ends at . ! ? or an ellipsis, optionally followed by closing quotes or brackets, and only once the NEXT character
 * proves it (whitespace), so "12.5 percent" and "version 2.0" are not cut and a full stop that is still arriving is not
 * mistaken for the end. Common abbreviations ("Mr.", "e.g.") do not end a sentence. A very long run with no punctuation is
 * cut at a space so a rambling reply cannot keep the listener waiting. `flush()` returns whatever is left at the end.
 */

const ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'vs', 'etc', 'e.g', 'i.e', 'approx', 'no', 'fig']);
const CLOSERS = new Set(['"', "'", ')', ']', '”', '’']);

export type SplitterOptions = {
  /** Cut an unpunctuated run at a space once it is this long. */
  maxLength?: number;
};

export class SentenceSplitter {
  private buffer = '';
  private readonly maxLength: number;

  constructor(opts: SplitterOptions = {}) {
    this.maxLength = opts.maxLength ?? 180;
  }

  /** Add streamed text; returns the sentences it completed, trimmed, in order. */
  push(chunk: string): string[] {
    this.buffer += chunk;
    const out: string[] = [];
    let from = 0;

    for (let i = 0; i < this.buffer.length; i++) {
      if (!this.isTerminator(i)) continue;
      let end = i;
      while (end + 1 < this.buffer.length && this.isTerminator(end + 1)) end++; // "?!" or "..."
      while (end + 1 < this.buffer.length && CLOSERS.has(this.buffer[end + 1] as string)) end++;
      const next = this.buffer[end + 1];
      if (next === undefined) break; // the next character has not arrived: cannot tell yet
      if (!/\s/.test(next)) {
        i = end; // "12.5", "e.g.x": not a boundary
        continue;
      }
      if (this.isAbbreviation(from, i)) {
        i = end;
        continue;
      }
      const sentence = this.buffer.slice(from, end + 1).trim();
      if (sentence) out.push(sentence);
      from = end + 1;
      i = end;
    }

    this.buffer = this.buffer.slice(from);

    // a very long run with no sentence end: cut at the last space so speech can start
    while (this.buffer.length > this.maxLength) {
      const cut = this.buffer.lastIndexOf(' ', this.maxLength);
      if (cut <= 0) break;
      out.push(this.buffer.slice(0, cut).trim());
      this.buffer = this.buffer.slice(cut + 1);
    }
    return out;
  }

  /** The text still waiting for its sentence to end (shown on screen, not yet spoken). */
  get pending(): string {
    return this.buffer.trim();
  }

  /** The reply is over: whatever is left is the last sentence. */
  flush(): string[] {
    const rest = this.buffer.trim();
    this.buffer = '';
    return rest ? [rest] : [];
  }

  reset(): void {
    this.buffer = '';
  }

  private isTerminator(i: number): boolean {
    const c = this.buffer[i];
    return c === '.' || c === '!' || c === '?' || c === '…';
  }

  private isAbbreviation(from: number, dot: number): boolean {
    if (this.buffer[dot] !== '.') return false;
    const word = this.buffer.slice(from, dot).split(/\s+/).pop()?.toLowerCase().replace(/^[("'“]+/, '') ?? '';
    return ABBREVIATIONS.has(word);
  }
}
