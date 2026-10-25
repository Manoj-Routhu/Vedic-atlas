import { formatCode, normalizeCode, parsePairingUri } from '../src/util/qr';

describe('normalizeCode / formatCode', () => {
  it('ignores case, dashes and spaces', () => {
    expect(normalizeCode('k7m2-q9xp')).toBe('K7M2Q9XP');
    expect(normalizeCode(' K7M2 Q9XP ')).toBe('K7M2Q9XP');
  });
  it('formats an 8-character code for display', () => {
    expect(formatCode('k7m2q9xp')).toBe('K7M2-Q9XP');
    expect(formatCode('ab12')).toBe('AB12');
  });
});

describe('parsePairingUri', () => {
  it('reads what `veda pair` prints', () => {
    expect(parsePairingUri('veda://pair?host=192.168.1.20&port=8000&code=K7M2Q9XP')).toEqual({
      host: '192.168.1.20', port: 8000, code: 'K7M2Q9XP',
    });
  });

  it('accepts a dashed code, a hostname, extra whitespace and any order', () => {
    expect(parsePairingUri('  veda://pair?code=k7m2-q9xp&port=8123&host=veda.local \n')).toEqual({
      host: 'veda.local', port: 8123, code: 'K7M2Q9XP',
    });
  });

  it('decodes percent-escapes', () => {
    expect(parsePairingUri('veda://pair?host=192.168.1.20&port=8000&code=K7M2%2DQ9XP')?.code).toBe('K7M2Q9XP');
  });

  it.each([
    ['not our scheme', 'https://pair?host=192.168.1.20&port=8000&code=K7M2Q9XP'],
    ['another action', 'veda://login?host=192.168.1.20&port=8000&code=K7M2Q9XP'],
    ['plain text', 'hello'],
    ['empty', ''],
    ['a public host', 'veda://pair?host=8.8.8.8&port=8000&code=K7M2Q9XP'],
    ['a public name', 'veda://pair?host=evil.example.com&port=8000&code=K7M2Q9XP'],
    ['a host with a path', 'veda://pair?host=192.168.1.20%2Fx&port=8000&code=K7M2Q9XP'],
    ['no host', 'veda://pair?port=8000&code=K7M2Q9XP'],
    ['no port', 'veda://pair?host=192.168.1.20&code=K7M2Q9XP'],
    ['a bad port', 'veda://pair?host=192.168.1.20&port=99999&code=K7M2Q9XP'],
    ['a non-numeric port', 'veda://pair?host=192.168.1.20&port=abc&code=K7M2Q9XP'],
    ['no code', 'veda://pair?host=192.168.1.20&port=8000'],
    ['a too-short code', 'veda://pair?host=192.168.1.20&port=8000&code=AB'],
    ['a broken escape', 'veda://pair?host=192.168.1.20&port=8000&code=%E0%A4%A'],
  ])('refuses %s', (_label, text) => {
    expect(parsePairingUri(text)).toBeNull();
  });
});
