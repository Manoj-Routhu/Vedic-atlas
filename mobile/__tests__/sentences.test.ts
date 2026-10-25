import { SentenceSplitter } from '../src/speech/sentences';

/** Feed text in the given chunks and return every sentence in order, including the flushed tail. */
function split(chunks: string[], maxLength?: number): string[] {
  const s = new SentenceSplitter({ maxLength });
  const out = chunks.flatMap((c) => s.push(c));
  return [...out, ...s.flush()];
}

describe('SentenceSplitter: where a sentence ends', () => {
  it('splits on . ! and ?', () => {
    expect(split(['It is red. Is it ripe? Yes! Good.'])).toEqual(['It is red.', 'Is it ripe?', 'Yes!', 'Good.']);
  });

  it('keeps the final sentence even with no closing punctuation', () => {
    expect(split(['One. Two'])).toEqual(['One.', 'Two']);
  });

  it('does not cut decimals, versions or times', () => {
    expect(split(['It costs 12.5 dollars. Version 2.0 is out at 3.30 pm.'])).toEqual([
      'It costs 12.5 dollars.',
      'Version 2.0 is out at 3.30 pm.',
    ]);
  });

  it('does cut after a date that ends a sentence (the case from the photos)', () => {
    expect(split(['A label reads "Best before 12/2027." It is on the table.'])).toEqual([
      'A label reads "Best before 12/2027."',
      'It is on the table.',
    ]);
  });

  it.each([
    ['Mr. Rao came in. He left.', ['Mr. Rao came in.', 'He left.']],
    ['Ask Dr. Rao about it.', ['Ask Dr. Rao about it.']],
    ['Fruit, e.g. apples, is fine. Done.', ['Fruit, e.g. apples, is fine.', 'Done.']],
    ['Cats, dogs, etc. are pets. Fine.', ['Cats, dogs, etc. are pets.', 'Fine.']],
  ])('does not treat an abbreviation as the end: %s', (text, expected) => {
    expect(split([text])).toEqual(expected);
  });

  it('keeps closing quotes and brackets with their sentence', () => {
    expect(split(['He said "stop." Then (quietly.) He left.'])).toEqual(['He said "stop."', 'Then (quietly.)', 'He left.']);
  });

  it('treats "?!" and "..." as one ending', () => {
    expect(split(['Really?! Yes... Okay.'])).toEqual(['Really?!', 'Yes...', 'Okay.']);
  });

  it('ignores extra whitespace', () => {
    expect(split(['  One.   Two.  '])).toEqual(['One.', 'Two.']);
  });

  it('returns nothing for empty input', () => {
    expect(split([])).toEqual([]);
    expect(split([''])).toEqual([]);
    expect(split(['   '])).toEqual([]);
  });
});

describe('SentenceSplitter: streaming', () => {
  const text = 'A red apple sits here. It costs 12.5 dollars! "Best before 12/2027." Mr. Rao agrees? Yes. The end';
  const expected = ['A red apple sits here.', 'It costs 12.5 dollars!', '"Best before 12/2027."', 'Mr. Rao agrees?', 'Yes.', 'The end'];

  it('gives the same sentences however the stream is cut: every split point', () => {
    for (let i = 0; i <= text.length; i++) expect(split([text.slice(0, i), text.slice(i)])).toEqual(expected);
  });

  it('gives the same sentences one character at a time', () => {
    expect(split([...text])).toEqual(expected);
  });

  it('releases a sentence only when the next character proves it ended', () => {
    const s = new SentenceSplitter();
    expect(s.push('It is red.')).toEqual([]); // the full stop might still be "12.5"
    expect(s.push(' ')).toEqual(['It is red.']);
  });

  it('does not cut "12.5" when the digits arrive in separate chunks', () => {
    const s = new SentenceSplitter();
    expect([...s.push('It costs 12.'), ...s.push('5 dollars.'), ...s.push(' Fine.')]).toEqual(['It costs 12.5 dollars.']);
    expect(s.flush()).toEqual(['Fine.']);
  });

  it('exposes the unfinished tail for display, and clears it on flush', () => {
    const s = new SentenceSplitter();
    s.push('First. Second is still');
    expect(s.pending).toBe('Second is still');
    expect(s.flush()).toEqual(['Second is still']);
    expect(s.pending).toBe('');
  });

  it('can be reset', () => {
    const s = new SentenceSplitter();
    s.push('half a sen');
    s.reset();
    expect(s.flush()).toEqual([]);
  });
});

describe('SentenceSplitter: long runs without punctuation', () => {
  it('cuts at a space so speech can start, never mid-word', () => {
    const words = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
    const parts = split([words], 80);
    expect(parts.length).toBeGreaterThan(3);
    expect(parts.join(' ')).toBe(words);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(80);
    expect(parts.every((p) => /^word\d+( word\d+)*$/.test(p))).toBe(true);
  });

  it('leaves a short run alone', () => {
    expect(split(['no punctuation here at all'], 80)).toEqual(['no punctuation here at all']);
  });
});
