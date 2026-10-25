import { buildDiagnostics } from '../src/features/settings/diagnostics';
import type { Saved } from '../src/state/connection';
import { DEFAULT_PREFERENCES } from '../src/state/preferences';

const SAVED: Saved = { host: '192.168.1.20', port: 8000, token: 'SECRET-TOKEN-123', deviceId: 'a1b2c3d4', deviceName: 'Pixel 8', scopes: ['chat', 'vision'] };

describe('buildDiagnostics', () => {
  it('describes the app, the connection and the phone', () => {
    const text = buildDiagnostics({ appVersion: '0.1.0', phase: 'paired', link: 'connected', saved: SAVED, prefs: DEFAULT_PREFERENCES });
    expect(text).toBe(
      [
        'Veda app 0.1.0 (Android)',
        'Mode: paired',
        'Connection: connected',
        'Pi: 192.168.1.20:8000',
        'This phone: Pixel 8 (a1b2c3d4)',
        'Allowed: chat, vision',
        'Voice: speed 1, pitch 1',
        'Look default: brief, vibration on',
      ].join('\n'),
    );
  });

  it('never contains the token, whatever is in the saved pairing', () => {
    const text = buildDiagnostics({ appVersion: '0.1.0', phase: 'paired', link: 'unreachable', saved: { ...SAVED, extra: 'x' } as Saved, prefs: DEFAULT_PREFERENCES });
    expect(text).not.toContain('SECRET-TOKEN-123');
    expect(text).not.toMatch(/token|bearer|password/i);
  });

  it('works in demo mode and when nothing is allowed', () => {
    const demo = buildDiagnostics({ appVersion: '0.1.0', phase: 'demo', link: 'connected', saved: null, prefs: { ...DEFAULT_PREFERENCES, haptics: false } });
    expect(demo).toContain('Mode: demo');
    expect(demo).not.toContain('Pi:');
    expect(demo).toContain('vibration off');
    expect(buildDiagnostics({ appVersion: '0.1.0', phase: 'paired', link: 'unknown', saved: { ...SAVED, scopes: [] }, prefs: DEFAULT_PREFERENCES })).toContain('Allowed: nothing');
  });
});
