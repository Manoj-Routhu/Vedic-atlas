import { describeCameraModel, describeLeads, formatDuration, formatWhen } from '../src/features/control/format';

describe('formatDuration', () => {
  it.each([
    [0, '0 ms'],
    [38, '38 ms'],
    [999.6, '1000 ms'],
    [1200, '1.2 s'],
    [9990, '10.0 s'],
    [75_000, '75 s'],
  ])('%d -> %s', (ms, text) => expect(formatDuration(ms)).toBe(text));

  it('says nothing for nonsense', () => {
    expect(formatDuration(-1)).toBe('');
    expect(formatDuration(NaN)).toBe('');
  });
});

describe('formatWhen', () => {
  const now = new Date(2026, 9, 25, 12, 0); // Sunday 25 Oct 2026, local time
  it('today, tomorrow, this week, and later', () => {
    expect(formatWhen(new Date(2026, 9, 25, 16, 30).toISOString(), now)).toBe('Today 4:30 pm');
    expect(formatWhen(new Date(2026, 9, 26, 9, 0).toISOString(), now)).toBe('Tomorrow 9:00 am');
    expect(formatWhen(new Date(2026, 9, 29, 9, 0).toISOString(), now)).toMatch(/^Thu 9:00 am$/);
    expect(formatWhen(new Date(2026, 10, 12, 18, 15).toISOString(), now)).toBe('12 Nov 6:15 pm');
  });
  it('nothing to show', () => {
    expect(formatWhen(null, now)).toBe('');
    expect(formatWhen('not a date', now)).toBe('');
  });
});

describe('describeLeads', () => {
  it.each([
    [[], 'No heads-up'],
    [[15], '15 min before'],
    [[30, 10], '30 and 10 min before'],
    [[30, 15, 5], '30, 15 and 5 min before'],
  ])('%j -> %s', (m, text) => expect(describeLeads(m)).toBe(text));
});

describe('describeCameraModel', () => {
  it('off, working, ready, asleep', () => {
    expect(describeCameraModel({ enabled: false, loaded: false, busy: false })).toBe('off');
    expect(describeCameraModel({ enabled: true, loaded: true, busy: true })).toBe('working');
    expect(describeCameraModel({ enabled: true, loaded: true, busy: false })).toBe('ready');
    expect(describeCameraModel({ enabled: true, loaded: false, busy: false })).toMatch(/asleep/);
  });
});
