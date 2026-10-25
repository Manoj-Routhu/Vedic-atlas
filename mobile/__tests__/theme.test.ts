import { colors, touch } from '../src/ui/theme';
import { contrastRatio } from '../src/util/contrast';

describe('contrastRatio', () => {
  it('matches the WCAG reference values', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 1);
    expect(contrastRatio('#777777', '#FFFFFF')).toBeCloseTo(4.48, 1);
    expect(contrastRatio('#fff', '#fff')).toBeCloseTo(1, 5);
  });

  it('is symmetric', () => {
    expect(contrastRatio('#123456', '#fedcba')).toBeCloseTo(contrastRatio('#fedcba', '#123456'), 10);
  });

  it('rejects things that are not hex colours', () => {
    expect(() => contrastRatio('rgba(0,0,0,.5)', '#fff')).toThrow();
  });
});

describe('the dark palette meets WCAG AA (4.5:1) for text', () => {
  // [foreground, background]: every pairing the screens actually use
  const pairs: [keyof typeof colors, keyof typeof colors][] = [
    ['text', 'bg'], ['text', 'surface'], ['text', 'surfaceHigh'],
    ['textSoft', 'bg'], ['textSoft', 'surface'],
    ['muted', 'bg'], ['muted', 'surface'], ['muted', 'surfaceHigh'],
    ['accent', 'bg'], ['accent', 'surface'],
    ['onAccent', 'accent'],
    ['danger', 'bg'], ['danger', 'surface'],
    ['dangerSoft', 'bg'], ['dangerSoft', 'surface'], ['dangerSoft', 'dangerGround'],
    ['text', 'warnGround'], ['textSoft', 'warnGround'], ['text', 'dangerGround'], ['textSoft', 'dangerGround'],
    ['ok', 'bg'], ['ok', 'surface'],
    ['warn', 'bg'], ['warn', 'surface'],
  ];

  it.each(pairs)('%s on %s', (fg, bg) => {
    expect(contrastRatio(colors[fg], colors[bg])).toBeGreaterThanOrEqual(4.5);
  });
});

describe('touch targets', () => {
  it('are at least the Android minimum of 48 dp', () => {
    for (const size of Object.values(touch)) expect(size).toBeGreaterThanOrEqual(48);
  });
});
