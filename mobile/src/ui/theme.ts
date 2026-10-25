/** Design tokens for the Veda app. Dark only for v1 (docs/16-mobile-app-design.md section 5). */

export const colors = {
  bg: '#0E1116',
  surface: '#171B22',
  surfaceHigh: '#232A33',
  border: '#232A33',
  text: '#E8EAED',
  textSoft: '#C9CFD6',
  muted: '#9AA3AE',
  accent: '#F5A524',
  onAccent: '#0E1116',
  ok: '#3DD68C',
  warn: '#F5A524',
  danger: '#FF5D5D',
  dangerSoft: '#FF8A8A',
  // banners: a tinted ground with a matching border (never a coloured left stripe)
  warnGround: '#1E1A12',
  warnBorder: '#5A4318',
  dangerGround: '#2A1717',
  dangerBorder: '#6B2B2B',
  highlight: 'rgba(245, 165, 36, 0.2)',
} as const;

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

export const radius = { sm: 12, md: 16, lg: 20, xl: 28, pill: 999 } as const;

/** Minimum sizes (dp). Android asks for 48; we use more where a mis-tap is costly. */
export const touch = { min: 48, button: 56, mic: 64, micLarge: 72, shutter: 88 } as const;

export const font = {
  title: { fontSize: 26, lineHeight: 32, fontWeight: '700' },
  heading: { fontSize: 20, lineHeight: 26, fontWeight: '700' },
  answer: { fontSize: 20, lineHeight: 29, fontWeight: '400' },
  body: { fontSize: 17, lineHeight: 25, fontWeight: '400' },
  button: { fontSize: 17, lineHeight: 22, fontWeight: '700' },
  label: { fontSize: 14, lineHeight: 20, fontWeight: '600' },
  caption: { fontSize: 13, lineHeight: 18, fontWeight: '400' },
  mono: { fontSize: 15, lineHeight: 22, fontWeight: '500' },
} as const;

export type ColorName = keyof typeof colors;
