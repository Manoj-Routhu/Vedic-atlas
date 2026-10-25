import { isPrivateHost, isValidPort } from './hostCheck';

export type PairingTarget = { host: string; port: number; code: string };

/** Pairing codes are typed and read aloud: ignore case, dashes and spaces ("k7m2-q9xp" is "K7M2Q9XP"). */
export function normalizeCode(input: string): string {
  return input.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

/** "K7M2Q9XP" -> "K7M2-Q9XP" for display. */
export function formatCode(code: string): string {
  const c = normalizeCode(code);
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
}

function decode(value: string): string | null {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return null;
  }
}

/**
 * Reads `veda://pair?host=192.168.1.20&port=8000&code=K7M2-Q9XP` (what `veda pair` prints and encodes in the QR).
 * Returns null for anything else, including a host that is not on a private network.
 */
export function parsePairingUri(text: string): PairingTarget | null {
  const m = /^veda:\/\/pair\?(.+)$/i.exec(text.trim());
  if (!m) return null;

  const params: Record<string, string> = {};
  for (const pair of (m[1] as string).split('&')) {
    const eq = pair.indexOf('=');
    if (eq < 1) continue;
    const key = decode(pair.slice(0, eq));
    const value = decode(pair.slice(eq + 1));
    if (key === null || value === null) return null;
    params[key] = value;
  }

  const host = (params.host ?? '').trim();
  const port = Number(params.port);
  const code = normalizeCode(params.code ?? '');
  if (!isPrivateHost(host) || !isValidPort(port) || !/^[A-Z0-9]{6,16}$/.test(code)) return null;
  return { host, port, code };
}
