/**
 * The app only ever talks to a device on the user's own network (docs/16 section 9). A pairing QR or a typed address
 * that points anywhere else is refused, so the device token can never be sent to a public server.
 */

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

function parseIPv4(host: string): [number, number, number, number] | null {
  const m = IPV4.exec(host);
  if (!m) return null;
  const parts: number[] = [];
  for (let i = 1; i <= 4; i++) {
    const text = m[i] as string;
    if (text.length > 1 && text.startsWith('0')) return null; // "010" is ambiguous (octal): refuse
    const n = Number(text);
    if (n > 255) return null;
    parts.push(n);
  }
  return parts as [number, number, number, number];
}

function isPrivateIPv4([a, b]: [number, number, number, number]): boolean {
  return (
    a === 10 || // 10.0.0.0/8 (also the Android emulator's 10.0.2.2)
    a === 127 || // loopback
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) // link-local
  );
}

function isPrivateIPv6(host: string): boolean {
  if (!/^[0-9a-f:.]+$/.test(host) || !host.includes(':')) return false;
  if (host === '::1') return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host); // IPv4 written inside IPv6
  if (mapped) {
    const v4 = parseIPv4(mapped[1] as string);
    return v4 !== null && isPrivateIPv4(v4);
  }
  const first = host.split(':')[0] ?? '';
  if (first === '') return false; // other "::..." forms are not addresses we recognise
  const value = parseInt(first, 16);
  if (Number.isNaN(value) || first.length > 4) return false;
  const linkLocal = value >= 0xfe80 && value <= 0xfebf; // fe80::/10
  const uniqueLocal = value >= 0xfc00 && value <= 0xfdff; // fc00::/7
  return linkLocal || uniqueLocal;
}

/** True for a private/loopback/link-local IP literal, `localhost`, or a `.local` name. Anything else is refused. */
export function isPrivateHost(raw: string): boolean {
  const host = raw.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host.length > 253) return false;
  if (/[\s/@?#\\]/.test(host)) return false; // a scheme, path, port or credentials do not belong in a host

  const v4 = parseIPv4(host);
  if (v4) return isPrivateIPv4(v4);
  if (host.includes(':')) return isPrivateIPv6(host);

  if (!HOSTNAME.test(host)) return false;
  return host === 'localhost' || (host.endsWith('.local') && host.length > '.local'.length);
}

export function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/** `http://host:port` for a host that passed `isPrivateHost` and a valid port; null otherwise. */
export function buildBaseUrl(host: string, port: number): string | null {
  if (!isPrivateHost(host) || !isValidPort(port)) return null;
  const clean = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return `http://${clean.includes(':') ? `[${clean}]` : clean}:${port}`;
}
