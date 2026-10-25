type Handler = (event: never) => void;

const handlers: Record<string, Handler> = {};
const removed: string[] = [];

jest.mock('expo-speech-recognition', () => ({
  ExpoSpeechRecognitionModule: {
    requestPermissionsAsync: jest.fn(async () => ({ granted: true })),
    isRecognitionAvailable: jest.fn(() => true),
    supportsOnDeviceRecognition: jest.fn(() => true),
    addListener: jest.fn((name: string, handler: Handler) => {
      handlers[name] = handler;
      return { remove: () => void removed.push(name) };
    }),
    start: jest.fn(),
    stop: jest.fn(),
    abort: jest.fn(),
    androidTriggerOfflineModelDownload: jest.fn(async () => ({ status: 'download_success', message: '' })),
  },
}));

import { ExpoRecognizer, problemFromError } from '../src/speech/expoRecognizer';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mockModule = require('expo-speech-recognition').ExpoSpeechRecognitionModule as Record<'requestPermissionsAsync' | 'isRecognitionAvailable' | 'start' | 'stop' | 'abort', jest.Mock>;

const fire = (name: string, event: object = {}) => (handlers[name] as unknown as (e: object) => void)(event);
const listener = () => ({ onPartial: jest.fn(), onFinal: jest.fn(), onError: jest.fn() });

beforeEach(() => {
  jest.clearAllMocks();
  removed.length = 0;
  mockModule.requestPermissionsAsync.mockResolvedValue({ granted: true });
  mockModule.isRecognitionAvailable.mockReturnValue(true);
});

describe('problemFromError', () => {
  it.each([
    ['no-speech', 'nothing'],
    ['speech-timeout', 'nothing'],
    ['not-allowed', 'denied'],
    ['service-not-allowed', 'denied'],
    ['network', 'unavailable'],
    ['language-not-supported', 'speechPackMissing'],
    ['audio-capture', 'unavailable'],
  ])('%s -> %s', (code, problem) => expect(problemFromError(code)).toBe(problem));
});

describe('ExpoRecognizer', () => {
  it.each([
    ['download_success', 'ready'],
    ['download_scheduled', 'scheduled'],
    ['opened_dialog', 'dialog'],
  ])('downloading the offline English pack: %s -> %s', async (status, result) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('expo-speech-recognition').ExpoSpeechRecognitionModule.androidTriggerOfflineModelDownload.mockResolvedValueOnce({ status, message: '' });
    await expect(new ExpoRecognizer().downloadSpeechPack()).resolves.toBe(result);
  });

  it('an end with no words reports what the speech service did, so a silent failure can be diagnosed', async () => {
    const l = listener();
    await new ExpoRecognizer().start(l);
    fire('start');
    fire('audiostart');
    fire('end');
    expect(l.onFinal).not.toHaveBeenCalled();
    expect(l.onError).toHaveBeenCalledWith('nothing', expect.stringMatching(/^start \d+ms, audio on \d+ms, end \d+ms$/));
  });

  it('asks permission, then listens in English, preferring on-device recognition', async () => {
    const l = listener();
    await new ExpoRecognizer().start(l);
    expect(mockModule.requestPermissionsAsync).toHaveBeenCalled();
    expect(mockModule.start).toHaveBeenCalledWith({ lang: 'en-US', interimResults: true, continuous: false, requiresOnDeviceRecognition: true });
  });

  it('reports the words as they come, and the last ones when it ends', async () => {
    const l = listener();
    await new ExpoRecognizer().start(l);
    fire('result', { results: [{ transcript: 'what is' }] });
    fire('result', { results: [{ transcript: 'what is this' }] });
    expect(l.onPartial).toHaveBeenLastCalledWith('what is this');
    fire('end');
    expect(l.onFinal).toHaveBeenCalledWith('what is this');
    expect(removed.sort()).toEqual(['audioend', 'audiostart', 'end', 'error', 'result', 'speechstart', 'start']); // nothing left listening
  });

  it('a refused permission is "denied" and never opens the microphone', async () => {
    mockModule.requestPermissionsAsync.mockResolvedValue({ granted: false });
    const l = listener();
    await new ExpoRecognizer().start(l);
    expect(l.onError).toHaveBeenCalledWith('denied');
    expect(mockModule.start).not.toHaveBeenCalled();
  });

  it('a phone without a recognizer is "unavailable"', async () => {
    mockModule.isRecognitionAvailable.mockReturnValue(false);
    const l = listener();
    await new ExpoRecognizer().start(l);
    expect(l.onError).toHaveBeenCalledWith('unavailable', expect.any(String));
    expect(mockModule.start).not.toHaveBeenCalled();
  });

  it('an error is translated, and the "end" that follows is not reported twice', async () => {
    const l = listener();
    await new ExpoRecognizer().start(l);
    fire('error', { error: 'no-speech' });
    expect(l.onError).toHaveBeenCalledWith('nothing', expect.stringMatching(/^error no-speech \d+ms$/));
    expect(l.onFinal).not.toHaveBeenCalled();
  });

  it('letting go while the permission dialog is open ends with no words, without starting the microphone', async () => {
    let grant: (v: { granted: boolean }) => void = () => {};
    mockModule.requestPermissionsAsync.mockReturnValue(new Promise((r) => (grant = r)));
    const l = listener();
    const rec = new ExpoRecognizer();
    const started = rec.start(l);
    rec.stop();
    grant({ granted: true });
    await started;
    expect(l.onFinal).toHaveBeenCalledWith('');
    expect(mockModule.start).not.toHaveBeenCalled();
  });

  it('cancel while the dialog is open starts nothing and reports nothing', async () => {
    let grant: (v: { granted: boolean }) => void = () => {};
    mockModule.requestPermissionsAsync.mockReturnValue(new Promise((r) => (grant = r)));
    const l = listener();
    const rec = new ExpoRecognizer();
    const started = rec.start(l);
    rec.cancel();
    grant({ granted: true });
    await started;
    expect(mockModule.start).not.toHaveBeenCalled();
    expect(l.onFinal).not.toHaveBeenCalled();
    expect(l.onError).not.toHaveBeenCalled();
  });

  it('stop ends the native recognition; cancel aborts it and drops its listeners', async () => {
    const rec = new ExpoRecognizer();
    await rec.start(listener());
    rec.stop();
    expect(mockModule.stop).toHaveBeenCalled();
    rec.cancel();
    expect(mockModule.abort).toHaveBeenCalled();
    expect(removed).toHaveLength(7);
  });
});
