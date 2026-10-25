import { buildBaseUrl, isPrivateHost, isValidPort } from '../src/util/hostCheck';

describe('isPrivateHost: addresses on the home network are accepted', () => {
  it.each([
    '192.168.1.20', '192.168.0.1', '10.0.0.5', '10.0.2.2', '172.16.0.1', '172.31.255.254',
    '169.254.10.10', '127.0.0.1', 'localhost', 'LOCALHOST', 'veda.local', 'raspberrypi.local', 'my-pi.local',
    '::1', '[::1]', 'fe80::1', 'fe80::a00:27ff:fe4e:66a1', 'fd12:3456:789a::1', 'fc00::1', '::ffff:192.168.1.5',
  ])('%s', (host) => {
    expect(isPrivateHost(host)).toBe(true);
  });
});

describe('isPrivateHost: anything else is refused, so a token is never sent off the home network', () => {
  it.each([
    '8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '192.169.1.1', '11.0.0.1', '100.64.0.1', '169.253.1.1',
    'example.com', 'pi.example.com', 'local', '.local', 'veda.local.evil.com', 'localhost.evil.com',
    '2001:4860:4860::8888', 'fec0::1', '::', '::ffff:8.8.8.8', 'fe80',
    '', '   ', '192.168.1.1/admin', 'http://192.168.1.1', '192.168.1.1:8000', 'user@192.168.1.1', '192.168.1.1?x=1',
    '256.1.1.1', '192.168.1', '192.168.1.1.1', '010.0.0.1', '192.168.001.1', '1e1.0.0.1',
  ])('%j', (host) => {
    expect(isPrivateHost(host)).toBe(false);
  });

  it('refuses absurdly long names', () => {
    expect(isPrivateHost('a'.repeat(300) + '.local')).toBe(false);
  });
});

describe('ports and base URLs', () => {
  it.each([1, 80, 8000, 65535])('%d is a valid port', (p) => expect(isValidPort(p)).toBe(true));
  it.each([0, -1, 65536, 80.5, NaN])('%p is not', (p) => expect(isValidPort(p)).toBe(false));

  it('builds the base URL', () => {
    expect(buildBaseUrl('192.168.1.20', 8000)).toBe('http://192.168.1.20:8000');
    expect(buildBaseUrl(' Veda.LOCAL ', 8000)).toBe('http://veda.local:8000');
    expect(buildBaseUrl('::1', 8000)).toBe('http://[::1]:8000');
  });

  it('returns null for a public host or a bad port', () => {
    expect(buildBaseUrl('8.8.8.8', 8000)).toBeNull();
    expect(buildBaseUrl('192.168.1.20', 0)).toBeNull();
  });
});
