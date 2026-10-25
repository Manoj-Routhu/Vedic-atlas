import { validatePairForm } from '../src/features/pairing/validate';

const good = { code: 'k7m2-q9xp', host: '192.168.1.20', port: '8000', name: '  Pixel 8 ' };

describe('validatePairForm', () => {
  it('accepts a good form, and tidies it', () => {
    expect(validatePairForm(good)).toEqual({
      ok: true,
      value: { code: 'K7M2Q9XP', host: '192.168.1.20', port: 8000, deviceName: 'Pixel 8' },
    });
  });

  it('defaults an empty port to 8000 and allows an empty name', () => {
    const r = validatePairForm({ ...good, port: '  ', name: '' });
    expect(r).toMatchObject({ ok: true, value: { port: 8000, deviceName: '' } });
  });

  it('accepts a .local name', () => {
    expect(validatePairForm({ ...good, host: ' Raspberrypi.local ' })).toMatchObject({ ok: true, value: { host: 'Raspberrypi.local' } });
  });

  it('tells you what to type when something is missing', () => {
    const r = validatePairForm({ code: '', host: '', port: '8000', name: '' });
    expect(r).toEqual({
      ok: false,
      errors: { code: 'Enter the code shown on your Pi.', host: "Enter your Pi's address, like 192.168.1.20." },
    });
  });

  it('refuses a code that is too short', () => {
    const r = validatePairForm({ ...good, code: 'AB-12' });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors.code).toMatch(/too short/);
  });

  it.each(['8.8.8.8', 'example.com', 'http://192.168.1.20', '192.168.1.20:8000'])('refuses %s as an address, with advice', (host) => {
    const r = validatePairForm({ ...good, host });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors.host).toMatch(/home network/);
  });

  it.each(['0', '70000', 'abc', '80.5', '-1', '8 000'])('refuses port %j', (port) => {
    const r = validatePairForm({ ...good, port });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors.port).toMatch(/between 1 and 65535/);
  });

  it('reports every problem at once', () => {
    const r = validatePairForm({ code: 'x', host: 'example.com', port: '0', name: '' });
    expect(!r.ok && Object.keys(r.errors).sort()).toEqual(['code', 'host', 'port']);
  });
});
