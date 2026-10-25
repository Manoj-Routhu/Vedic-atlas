import type { Saved } from '../../state/connection';
import type { Preferences } from '../../state/preferences';

export type DiagnosticsInput = {
  appVersion: string;
  phase: 'loading' | 'unpaired' | 'paired' | 'demo';
  link: 'unknown' | 'connected' | 'unreachable';
  saved: Saved | null;
  prefs: Preferences;
};

/**
 * Plain text for "Copy diagnostics": enough to help someone work out what is wrong, and nothing private.
 * It lists fields one by one, so the token (and anything added to `Saved` later) can never end up in it by accident.
 */
export function buildDiagnostics({ appVersion, phase, link, saved, prefs }: DiagnosticsInput): string {
  const lines = [`Veda app ${appVersion} (Android)`, `Mode: ${phase}`, `Connection: ${link}`];
  if (saved) {
    lines.push(`Pi: ${saved.host}:${saved.port}`);
    lines.push(`This phone: ${saved.deviceName} (${saved.deviceId})`);
    lines.push(`Allowed: ${saved.scopes.length > 0 ? saved.scopes.join(', ') : 'nothing'}`);
  }
  lines.push(`Voice: speed ${prefs.speechRate}, pitch ${prefs.speechPitch}`);
  lines.push(`Look default: ${prefs.lookStyle}, vibration ${prefs.haptics ? 'on' : 'off'}`);
  return lines.join('\n');
}
