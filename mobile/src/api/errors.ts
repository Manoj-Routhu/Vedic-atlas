/**
 * Every way talking to the Pi can fail, turned into one `ApiError` with a `kind` the screens switch on and a plain,
 * one-sentence `userMessage` (docs/16 section 4.6). Server error codes and HTTP statuses never reach the user.
 */

export type ErrorKind =
  | 'unreachable'
  | 'timeout'
  | 'cancelled'
  | 'hostNotAllowed'
  | 'unauthorized'
  | 'forbidden'
  | 'remoteDisabled'
  | 'autoApproveOn'
  | 'pairCodeInvalid'
  | 'tooManyAttempts'
  | 'visionBusy'
  | 'visionOff'
  | 'lowMemory'
  | 'modelNotReady'
  | 'photoRejected'
  | 'photoExpired'
  | 'validation'
  | 'songNotFound'
  | 'musicOff'
  | 'nothingPlaying'
  | 'notFound'
  | 'server'
  | 'cutOff'
  | 'badResponse'
  | 'storage'
  | 'camera';

const MESSAGES: Record<ErrorKind, string> = {
  unreachable: "Can't reach your Pi. Is it on, and is this phone on the same Wi-Fi?",
  timeout: 'Your Pi took too long to answer.',
  cancelled: 'Cancelled.',
  hostNotAllowed: "That address isn't on your home network, so nothing will be sent to it.",
  unauthorized: 'This phone was removed from Veda. Pair it again.',
  forbidden: "This phone isn't allowed to do that. Change it with `veda pair` on your Pi.",
  remoteDisabled: 'Phone access is switched off on your Pi.',
  autoApproveOn: 'Auto-approve is on at the Pi, so chat from the phone is paused.',
  pairCodeInvalid: "That code didn't work. Codes last 2 minutes. Run `veda pair` again.",
  tooManyAttempts: 'Too many wrong codes. Wait 5 minutes and try again.',
  visionBusy: 'The camera model is busy. One moment.',
  visionOff: 'Camera description is switched off on your Pi.',
  lowMemory: 'Your Pi is short of memory right now. Try again in a minute.',
  modelNotReady: "The camera model isn't ready on your Pi.",
  photoRejected: "I couldn't read that photo. Try again.",
  photoExpired: 'That photo is no longer on the Pi.',
  validation: "Something in that request wasn't valid.",
  songNotFound: "I couldn't find that song, or the music search didn't answer. Try again, and add the artist.",
  musicOff: "Music isn't available on your Pi.",
  nothingPlaying: 'Nothing is playing.',
  notFound: "The Pi couldn't find that.",
  server: 'Your Pi had a problem. Try again.',
  cutOff: 'The answer was cut off.',
  badResponse: "The Pi sent something I didn't understand.",
  storage: "I couldn't save the pairing on this phone. Try again.",
  camera: "I couldn't take the photo. Try again.",
};

export class ApiError extends Error {
  readonly kind: ErrorKind;
  readonly status: number | undefined;
  readonly code: string | undefined;
  /** What the server said, for logs and diagnostics only: never shown to the user. */
  readonly serverMessage: string | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(kind: ErrorKind, details: { status?: number; code?: string; serverMessage?: string; retryAfterSeconds?: number } = {}) {
    super(MESSAGES[kind]);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = details.status;
    this.code = details.code;
    this.serverMessage = details.serverMessage;
    this.retryAfterSeconds = details.retryAfterSeconds;
  }

  /** The sentence to show or speak. */
  get userMessage(): string {
    return MESSAGES[this.kind];
  }
}

export type ResponseContext = 'pair' | 'other';

/** The error body is either {error: {code, message}} (the Pi's own) or {detail: "..."} (FastAPI's). Anything else is ignored. */
export function readErrorBody(text: string): { code: string | undefined; message: string } {
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    const error = body.error as Record<string, unknown> | undefined;
    if (error && typeof error === 'object') {
      return {
        code: typeof error.code === 'string' ? error.code : undefined,
        message: typeof error.message === 'string' ? error.message : '',
      };
    }
    if (typeof body.detail === 'string') return { code: undefined, message: body.detail };
  } catch {
    // not JSON
  }
  return { code: undefined, message: '' };
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Build the ApiError for a non-success HTTP response. */
export function apiErrorFromResponse(
  status: number,
  bodyText: string,
  headers: { get(name: string): string | null },
  context: ResponseContext = 'other',
): ApiError {
  const { code, message } = readErrorBody(bodyText);
  const lower = message.toLowerCase();
  const details = { status, code, serverMessage: message || undefined };

  if (status === 401) return new ApiError('unauthorized', details);
  if (status === 403) {
    if (lower.includes('auto-approve') || lower.includes('yolo')) return new ApiError('autoApproveOn', details);
    if (lower.includes('remote access is disabled')) return new ApiError('remoteDisabled', details);
    if (context === 'pair' && code === 'PERMISSION_DENIED') return new ApiError('pairCodeInvalid', details);
    return new ApiError('forbidden', details);
  }
  if (status === 404) return new ApiError(code === 'MUSIC_NOT_FOUND' ? 'songNotFound' : 'notFound', details);
  if (status === 409 && code === 'MUSIC_NOT_PLAYING') return new ApiError('nothingPlaying', details);
  if (status === 422) {
    if (code === 'IMAGE_INVALID') return new ApiError(lower.includes('expired') ? 'photoExpired' : 'photoRejected', details);
    return new ApiError('validation', details);
  }
  if (status === 429) {
    if (code === 'VISION_BUSY') return new ApiError('visionBusy', { ...details, retryAfterSeconds: parseRetryAfter(headers.get('retry-after')) });
    return new ApiError('tooManyAttempts', details);
  }
  if (status === 503) {
    if (code === 'MUSIC_UNAVAILABLE') return new ApiError('musicOff', details);
    if (lower.includes('not initialized') && lower.includes('vision')) return new ApiError('visionOff', details);
    if (lower.includes('memory')) return new ApiError('lowMemory', details);
    if (code === 'VISION_UNAVAILABLE') return new ApiError('modelNotReady', details);
    return new ApiError('server', details);
  }
  return new ApiError('server', details);
}

/**
 * An error that arrives INSIDE a vision stream ({type: 'error', code, message}) rather than as an HTTP status: the answer had
 * already started when the model failed. The Pi's wording is kept for logs only, like every other server message.
 */
export function apiErrorFromVisionEvent(code: string, message: string): ApiError {
  const lower = message.toLowerCase();
  const details = { code, serverMessage: message || undefined };
  if (code === 'VISION_UNAVAILABLE') return new ApiError(lower.includes('memory') ? 'lowMemory' : 'modelNotReady', details);
  if (code === 'IMAGE_INVALID') return new ApiError(lower.includes('expired') ? 'photoExpired' : 'photoRejected', details);
  return new ApiError('server', details);
}

/** Wrap anything thrown by the network layer. An aborted request is a cancel, not a failure. */
export function apiErrorFromThrown(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  const name = (e as { name?: string } | null)?.name;
  if (name === 'AbortError') return new ApiError('cancelled');
  if (name === 'TimeoutError') return new ApiError('timeout');
  return new ApiError('unreachable', { serverMessage: e instanceof Error ? e.message : String(e) });
}
