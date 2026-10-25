import { ApiError, apiErrorFromResponse, apiErrorFromThrown, apiErrorFromVisionEvent, readErrorBody, type ErrorKind } from '../src/api/errors';

const headers = (h: Record<string, string> = {}) => ({ get: (n: string) => h[n.toLowerCase()] ?? null });
const err = (code: string, message: string) => JSON.stringify({ error: { code, message } });

/** Each row is a real response the Pi backend produces (tests/test_device_auth.py, test_vision_routes.py, the services). */
const cases: [string, number, string, ErrorKind][] = [
  ['no token', 401, err('DEVICE_UNAUTHORIZED', 'a device token is required'), 'unauthorized'],
  ['revoked token', 401, err('DEVICE_UNAUTHORIZED', 'a valid device token is required'), 'unauthorized'],
  ['missing scope', 403, err('DEVICE_FORBIDDEN', "this device lacks the 'chat' permission"), 'forbidden'],
  ['route not for phones', 403, err('DEVICE_FORBIDDEN', 'this device may not call that route'), 'forbidden'],
  ['cross-origin', 403, err('DEVICE_FORBIDDEN', 'cross-origin requests are not allowed'), 'forbidden'],
  ['remote access off', 403, err('DEVICE_FORBIDDEN', 'remote access is disabled'), 'remoteDisabled'],
  ['yolo on', 403, err('DEVICE_FORBIDDEN', 'auto-approve (yolo) is on; chat from the phone is paused'), 'autoApproveOn'],
  ['unknown photo', 404, err('NOT_FOUND', 'no device'), 'notFound'],
  ['expired photo', 422, err('IMAGE_INVALID', 'Image rejected: unknown or expired photo; take it again'), 'photoExpired'],
  ['not an image', 422, err('IMAGE_INVALID', 'Image rejected: not a readable image'), 'photoRejected'],
  ['too large', 422, err('IMAGE_INVALID', 'Image rejected: larger than 1024 KB'), 'photoRejected'],
  ['bad language', 422, err('VALIDATION_ERROR', "language 'hi' is not supported"), 'validation'],
  ['request validation', 422, JSON.stringify({ error: { code: 'missing', message: 'Field required - body/image_id' } }), 'validation'],
  ['too many pairing attempts', 429, err('RATE_LIMITED', 'too many wrong codes; try again later'), 'tooManyAttempts'],
  ['vision off', 503, JSON.stringify({ detail: 'vision (turned off in config/vision.yaml) not initialized' }), 'visionOff'],
  ['no memory', 503, err('VISION_UNAVAILABLE', 'Vision is unavailable: not enough free memory to load the vision model right now'), 'lowMemory'],
  ['not installed', 503, err('VISION_UNAVAILABLE', 'Vision is unavailable: the vision model is not installed on this machine'), 'modelNotReady'],
  ['model failed', 503, err('VISION_UNAVAILABLE', 'Vision is unavailable: the vision model failed'), 'modelNotReady'],
  ['backoff', 503, err('VISION_UNAVAILABLE', 'Vision is unavailable: the model failed to start recently; try again in 5 s'), 'modelNotReady'],
  ['other service down', 503, JSON.stringify({ detail: 'supervisor not initialized' }), 'server'],
  ['crash', 500, err('SYSTEM_ERROR', 'An unexpected error occurred'), 'server'],
  ['unparseable', 502, '<html>bad gateway</html>', 'server'],
];

describe('apiErrorFromResponse', () => {
  it.each(cases)('%s (%d) -> %s', (_label, status, body, kind) => {
    expect(apiErrorFromResponse(status, body, headers()).kind).toBe(kind);
  });

  it('a wrong pairing code is "that code did not work", but a 403 elsewhere is "not allowed"', () => {
    const body = err('PERMISSION_DENIED', 'pairing code is invalid or expired');
    expect(apiErrorFromResponse(403, body, headers(), 'pair').kind).toBe('pairCodeInvalid');
    expect(apiErrorFromResponse(403, body, headers(), 'other').kind).toBe('forbidden');
  });

  it('a busy model is a 429 with VISION_BUSY, and keeps the Retry-After', () => {
    const e = apiErrorFromResponse(429, err('VISION_BUSY', 'Vision is busy with another photo'), headers({ 'retry-after': '5' }));
    expect(e.kind).toBe('visionBusy');
    expect(e.retryAfterSeconds).toBe(5);
  });

  it('ignores a nonsense Retry-After', () => {
    expect(apiErrorFromResponse(429, err('VISION_BUSY', 'x'), headers({ 'retry-after': 'soon' })).retryAfterSeconds).toBeUndefined();
  });

  it('keeps the server wording for logs, but never shows it', () => {
    const e = apiErrorFromResponse(503, err('VISION_UNAVAILABLE', 'segfault in /secret/path'), headers());
    expect(e.serverMessage).toContain('/secret/path');
    expect(e.userMessage).not.toContain('secret');
    expect(e.message).toBe(e.userMessage);
  });
});

describe('every user message is a plain sentence', () => {
  const kinds = new Set<ErrorKind>(cases.map((c) => c[3]));
  const more: ErrorKind[] = ['unreachable', 'timeout', 'cancelled', 'hostNotAllowed', 'pairCodeInvalid', 'visionBusy', 'cutOff', 'badResponse', 'storage', 'camera'];
  it.each([...kinds, ...more])('%s', (kind) => {
    const m = new ApiError(kind).userMessage;
    expect(m.length).toBeGreaterThan(8);
    expect(m).not.toMatch(/\b(40[0-9]|50[0-9]|42[0-9]|HTTP|JSON|null|undefined|exception|stack)\b/i);
    expect(m).not.toMatch(/[A-Z]{3,}_[A-Z_]+/); // no SERVER_CODES
  });
});

describe('apiErrorFromThrown', () => {
  it('passes ApiErrors through', () => {
    const e = new ApiError('visionOff');
    expect(apiErrorFromThrown(e)).toBe(e);
  });
  it('treats an aborted request as a cancel, not a failure', () => {
    expect(apiErrorFromThrown({ name: 'AbortError' }).kind).toBe('cancelled');
  });
  it('treats anything else (a refused connection, a DNS failure) as unreachable', () => {
    const e = apiErrorFromThrown(new TypeError('Network request failed'));
    expect(e.kind).toBe('unreachable');
    expect(e.serverMessage).toBe('Network request failed');
    expect(apiErrorFromThrown('weird').kind).toBe('unreachable');
  });
});

describe('readErrorBody', () => {
  it('reads both body shapes and survives garbage', () => {
    expect(readErrorBody('{"error":{"code":"A","message":"m"}}')).toEqual({ code: 'A', message: 'm' });
    expect(readErrorBody('{"detail":"d"}')).toEqual({ code: undefined, message: 'd' });
    expect(readErrorBody('{"error":{"code":5}}')).toEqual({ code: undefined, message: '' });
    expect(readErrorBody('nope')).toEqual({ code: undefined, message: '' });
    expect(readErrorBody('')).toEqual({ code: undefined, message: '' });
  });
});

describe('apiErrorFromVisionEvent (an error inside the stream)', () => {
  it.each([
    ['VISION_UNAVAILABLE', 'not enough free memory to load the vision model right now', 'lowMemory'],
    ['VISION_UNAVAILABLE', 'Vision is unavailable: the vision model failed', 'modelNotReady'],
    ['IMAGE_INVALID', 'Image rejected: unknown or expired photo; take it again', 'photoExpired'],
    ['IMAGE_INVALID', 'Image rejected: not a readable image', 'photoRejected'],
    ['SOMETHING_ELSE', 'boom /secret/path', 'server'],
  ] as const)('%s / %s -> %s', (code, message, kind) => {
    const e = apiErrorFromVisionEvent(code, message);
    expect(e.kind).toBe(kind);
    expect(e.userMessage).not.toContain('secret');
  });
});
