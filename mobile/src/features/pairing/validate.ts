import { isPrivateHost, isValidPort } from '../../util/hostCheck';
import { normalizeCode } from '../../util/qr';

export type PairForm = { code: string; host: string; port: string; name: string };
export type PairInput = { code: string; host: string; port: number; deviceName: string };
export type PairErrors = Partial<Record<'code' | 'host' | 'port', string>>;

export const DEFAULT_PORT = '8000';

/** Check what the user typed before anything is sent. Messages say what to do, not what went wrong internally. */
export function validatePairForm(f: PairForm): { ok: true; value: PairInput } | { ok: false; errors: PairErrors } {
  const errors: PairErrors = {};

  const code = normalizeCode(f.code);
  if (code === '') errors.code = 'Enter the code shown on your Pi.';
  else if (!/^[A-Z0-9]{6,16}$/.test(code)) errors.code = 'That code looks too short. It has 8 letters and numbers.';

  const host = f.host.trim();
  if (host === '') errors.host = "Enter your Pi's address, like 192.168.1.20.";
  else if (!isPrivateHost(host)) errors.host = "That isn't an address on your home network. Use one like 192.168.1.20 or raspberrypi.local.";

  const portText = f.port.trim() === '' ? DEFAULT_PORT : f.port.trim();
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || !isValidPort(port)) errors.port = 'Enter a port between 1 and 65535.';

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { code, host, port, deviceName: f.name.trim() } };
}
