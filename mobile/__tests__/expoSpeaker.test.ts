import { ExpoSpeaker } from '../src/speech/expoSpeaker';

const mockSpeak = jest.fn();
jest.mock('expo-speech', () => ({ speak: (...a: unknown[]) => mockSpeak(...a), stop: jest.fn(async () => {}) }));

const cb = () => ({ onStart: jest.fn(), onDone: jest.fn(), onError: jest.fn() });

beforeEach(() => mockSpeak.mockClear());

describe('ExpoSpeaker', () => {
  it('speaks English with the English voice, with the chosen rate and pitch', () => {
    new ExpoSpeaker('en-US', () => ({ speechRate: 1.2, speechPitch: 0.9 })).speak('Hello there.', cb());
    expect(mockSpeak).toHaveBeenCalledWith('Hello there.', expect.objectContaining({ language: 'en-US', rate: 1.2, pitch: 0.9 }));
  });

  it('without Hindi support (Look) nothing changes: a Devanagari sentence is spoken as before', () => {
    new ExpoSpeaker('en-US').speak('नमस्ते।', cb());
    expect(mockSpeak).toHaveBeenCalledWith('नमस्ते।', expect.objectContaining({ language: 'en-US' }));
  });

  it('with Hindi support, a Devanagari sentence uses the Hindi voice and English keeps English', () => {
    const hindi = { ready: () => true, onMissing: jest.fn() };
    const speaker = new ExpoSpeaker('en-US', undefined, hindi);
    speaker.speak('आज मौसम अच्छा है।', cb());
    speaker.speak('It is sunny.', cb());
    speaker.speak('Play बाहुबली', cb());
    expect(mockSpeak.mock.calls.map((c) => c[1].language)).toEqual(['hi-IN', 'en-US', 'hi-IN']);
    expect(hindi.onMissing).not.toHaveBeenCalled();
  });

  it('with no Hindi voice installed, the Hindi sentence is skipped (never read in English), the queue moves on, and the app is told', () => {
    const hindi = { ready: () => false, onMissing: jest.fn() };
    const callbacks = cb();
    new ExpoSpeaker('en-US', undefined, hindi).speak('आज मौसम अच्छा है।', callbacks);
    expect(mockSpeak).not.toHaveBeenCalled();
    expect(callbacks.onDone).toHaveBeenCalledTimes(1);
    expect(hindi.onMissing).toHaveBeenCalledTimes(1);
  });

  it('English is unaffected when the Hindi voice is missing', () => {
    const hindi = { ready: () => false, onMissing: jest.fn() };
    new ExpoSpeaker('en-US', undefined, hindi).speak('Still English.', cb());
    expect(mockSpeak).toHaveBeenCalledTimes(1);
    expect(hindi.onMissing).not.toHaveBeenCalled();
  });
});
