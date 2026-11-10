import { ExpoLanguagePacks } from '../src/speech/languagePacks';

const mockVoices = jest.fn();
jest.mock('expo-speech', () => ({ getAvailableVoicesAsync: () => mockVoices() }));
const mockLocales = jest.fn();
const mockDownload = jest.fn();
jest.mock('expo-speech-recognition', () => ({
  ExpoSpeechRecognitionModule: { getSupportedLocales: (o: unknown) => mockLocales(o), androidTriggerOfflineModelDownload: (o: unknown) => mockDownload(o) },
}));
const mockSendIntent = jest.fn();
jest.mock('react-native', () => ({ Linking: { sendIntent: (...a: unknown[]) => mockSendIntent(...a) } }));

const voice = (language: string) => ({ identifier: language, name: language, quality: 'Default', language });
beforeEach(() => jest.clearAllMocks());

describe('Hindi language packs', () => {
  it('the voice is installed when the phone lists a Hindi voice, in any spelling', async () => {
    mockLocales.mockResolvedValue({ locales: [], installedLocales: ['en-US'] });
    mockVoices.mockResolvedValue([voice('en-US'), voice('hi-IN')]);
    expect((await new ExpoLanguagePacks().status()).voice).toBe(true);
    mockVoices.mockResolvedValue([voice('hi_IN')]);
    expect((await new ExpoLanguagePacks().status()).voice).toBe(true);
    mockVoices.mockResolvedValue([voice('en-US'), voice('de-DE')]);
    expect((await new ExpoLanguagePacks().status()).voice).toBe(false);
  });

  it('listening is installed when hi-IN is among the offline locales', async () => {
    mockVoices.mockResolvedValue([]);
    mockLocales.mockResolvedValue({ locales: ['hi-IN'], installedLocales: ['en-US', 'hi-IN'] });
    expect((await new ExpoLanguagePacks().status()).recognition).toBe(true);
    mockLocales.mockResolvedValue({ locales: ['hi-IN'], installedLocales: ['en-US'] });
    expect((await new ExpoLanguagePacks().status()).recognition).toBe(false);
  });

  it('an empty list (Android 12 and below) or an error is "cannot tell", never "missing"', async () => {
    mockVoices.mockRejectedValue(new Error('no engine'));
    mockLocales.mockResolvedValue({ locales: [], installedLocales: [] });
    expect(await new ExpoLanguagePacks().status()).toEqual({ voice: null, recognition: null });
    mockLocales.mockRejectedValue(new Error('package_not_found'));
    expect((await new ExpoLanguagePacks().status()).recognition).toBeNull();
  });

  it("installing the voice opens Android's voice-data screen, and says when the phone has none", async () => {
    mockSendIntent.mockResolvedValue(undefined);
    expect(await new ExpoLanguagePacks().installVoice()).toBe('opened');
    expect(mockSendIntent).toHaveBeenCalledWith('android.speech.tts.engine.INSTALL_TTS_DATA');
    mockSendIntent.mockRejectedValue(new Error('ActivityNotFound'));
    expect(await new ExpoLanguagePacks().installVoice()).toBe('unavailable');
  });

  it('installing the speech pack asks for hi-IN and maps the answer', async () => {
    for (const [status, expected] of [['download_success', 'ready'], ['download_scheduled', 'scheduled'], ['opened_dialog', 'dialog']] as const) {
      mockDownload.mockResolvedValue({ status, message: '' });
      expect(await new ExpoLanguagePacks().installRecognition()).toBe(expected);
      expect(mockDownload).toHaveBeenLastCalledWith({ locale: 'hi-IN' });
    }
  });
});
