import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { connectionStore } from '../src/state/connection';
import { DEFAULT_PREFERENCES, preferencesStore } from '../src/state/preferences';

jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true }) }));
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
jest.mock('expo-speech', () => ({ speak: jest.fn(), stop: jest.fn(async () => {}) }));
jest.mock('expo-speech-recognition', () => ({ ExpoSpeechRecognitionModule: {} }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));
jest.mock('expo-secure-store', () => ({ getItemAsync: jest.fn(async () => null), setItemAsync: jest.fn(async () => {}), deleteItemAsync: jest.fn(async () => {}) }));

// A real language setup on fake packs, so the screen's wiring is tested end to end without the phone.
jest.mock('../src/features/language/languageRuntime', () => {
  const { useStore } = require('zustand');
  const { createLanguageSetup } = require('../src/features/language/languageSetup');
  const fake = {
    status: { voice: false, recognition: false } as { voice: boolean | null; recognition: boolean | null },
    confirm: jest.fn(async (_q?: unknown) => true),
  };
  const packs = {
    status: jest.fn(async () => fake.status),
    installVoice: jest.fn(async () => 'opened'),
    installRecognition: jest.fn(async () => 'dialog'),
  };
  const languageSetup = createLanguageSetup({ packs, confirm: (q: unknown) => fake.confirm(q), inform: jest.fn(), dismissed: () => false, setDismissed: jest.fn() });
  return { languageSetup, useLanguageSetup: (selector: unknown) => useStore(languageSetup, selector), __fake: fake, __packs: packs };
});

import Settings from '../src/app/(app)/settings';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const runtime = require('../src/features/language/languageRuntime') as { languageSetup: { setState: (s: object) => void }; __fake: { status: object; confirm: jest.Mock }; __packs: Record<string, jest.Mock> };

const initial = connectionStore.getState();
const SAVED = { host: '192.168.1.20', port: 8000, token: 'T', deviceId: 'a1b2c3d4', deviceName: 'Pixel 8', scopes: ['chat', 'control', 'vision'] };

beforeEach(async () => {
  jest.clearAllMocks();
  connectionStore.setState({ ...initial, phase: 'paired', saved: SAVED, link: 'connected' }, true);
  await preferencesStore.getState().update(DEFAULT_PREFERENCES);
  runtime.__fake.status = { voice: false, recognition: false };
  runtime.__fake.confirm.mockResolvedValue(true);
  runtime.languageSetup.setState({ status: { voice: null, recognition: null }, working: false, note: null });
});

const open = async () => {
  await render(<Settings />);
  await act(async () => {});
};

describe('Settings: Language', () => {
  it('starts on English, says Look stays English, and shows no Hindi download while nothing is missing or chosen', async () => {
    runtime.__fake.status = { voice: true, recognition: true };
    await open();
    expect(screen.getByRole('radio', { name: 'Language: English' }).props.accessibilityState.selected).toBe(true);
    expect(screen.getByText('Look always uses English.')).toBeTruthy();
    expect(screen.queryByTestId('hindi-status')).toBeNull();
  });

  it('choosing Hindi saves it and shows one dialog for what the phone is missing, then starts the downloads', async () => {
    await open();
    await fireEvent.press(screen.getByRole('radio', { name: 'Language: हिन्दी' }));
    await act(async () => {});
    expect(preferencesStore.getState().prefs.language).toBe('hi');
    expect(runtime.__fake.confirm).toHaveBeenCalledTimes(1);
    expect(runtime.__fake.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Hindi needs two downloads', ok: 'Download', cancel: 'Not now' }));
    expect(runtime.__packs.installRecognition).toHaveBeenCalledTimes(1);
    expect(runtime.__packs.installVoice).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('hindi-status')).toBeTruthy();
  });

  it('shows what is installed, and "Download Hindi" starts the same flow again after a "Not now"', async () => {
    runtime.__fake.confirm.mockResolvedValueOnce(false);
    await open();
    await fireEvent.press(screen.getByRole('radio', { name: 'Language: हिन्दी' }));
    await act(async () => {});
    expect(screen.getByText('Hindi voice (the phone reads Hindi aloud): not downloaded yet')).toBeTruthy();
    expect(screen.getByText('Hindi speech (you speak Hindi): not downloaded yet')).toBeTruthy();
    expect(runtime.__packs.installVoice).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: 'Download Hindi' }));
    await act(async () => {});
    expect(runtime.__fake.confirm).toHaveBeenCalledTimes(2);
    expect(runtime.__packs.installVoice).toHaveBeenCalledTimes(1);
  });

  it('with Hindi already on the phone, choosing Hindi shows no dialog and says it is ready', async () => {
    runtime.__fake.status = { voice: true, recognition: true };
    await open();
    await fireEvent.press(screen.getByRole('radio', { name: 'Language: हिन्दी' }));
    await act(async () => {});
    expect(runtime.__fake.confirm).not.toHaveBeenCalled();
    expect(screen.getByText('Hindi is ready.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Download Hindi' })).toBeNull();
  });

  it('switching back to English asks for nothing', async () => {
    await preferencesStore.getState().update({ language: 'hi' });
    runtime.__fake.status = { voice: true, recognition: true };
    await open();
    await fireEvent.press(screen.getByRole('radio', { name: 'Language: English' }));
    await act(async () => {});
    expect(preferencesStore.getState().prefs.language).toBe('en');
    expect(runtime.__fake.confirm).not.toHaveBeenCalled();
  });
});
