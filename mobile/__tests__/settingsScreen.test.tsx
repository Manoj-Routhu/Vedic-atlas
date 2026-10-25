import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { ApiError } from '../src/api/errors';
import { connectionStore, type ConnectionState } from '../src/state/connection';
import { createPreferencesStore, DEFAULT_PREFERENCES, preferencesStore } from '../src/state/preferences';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
const mockSpeak = jest.fn();
jest.mock('expo-speech', () => ({ speak: (...args: unknown[]) => mockSpeak(...args), stop: jest.fn(async () => {}) }));
const mockCopy = jest.fn(async (_text: string) => true);
jest.mock('expo-clipboard', () => ({ setStringAsync: (text: string) => mockCopy(text) }));
jest.mock('expo-secure-store', () => ({ getItemAsync: jest.fn(async () => null), setItemAsync: jest.fn(async () => {}), deleteItemAsync: jest.fn(async () => {}) }));

// the screen, imported after the mocks above
import Settings from '../src/app/(app)/settings';

const initial = connectionStore.getState();
const SAVED = { host: '192.168.1.20', port: 8000, token: 'SECRET-TOKEN-123', deviceId: 'a1b2c3d4', deviceName: 'Pixel 8', scopes: ['chat', 'control', 'vision'] };
const paired = (patch: Partial<ConnectionState> = {}) => connectionStore.setState({ ...initial, phase: 'paired', saved: SAVED, link: 'connected', ...patch }, true);

beforeEach(async () => {
  jest.clearAllMocks();
  connectionStore.setState(initial, true);
  await preferencesStore.getState().update(DEFAULT_PREFERENCES);
});

describe('Settings: your Pi', () => {
  it('Test connection shows how fast the Pi answered', async () => {
    paired({ testConnection: jest.fn().mockResolvedValue(41) });
    await render(<Settings />);
    await fireEvent.press(screen.getByRole('button', { name: 'Test connection' }));
    await act(async () => {});
    expect(screen.getByTestId('test-result')).toHaveTextContent('Your Pi answered in 41 ms.');
  });

  it('Test connection says why when the Pi does not answer', async () => {
    paired({ testConnection: jest.fn().mockRejectedValue(new ApiError('unreachable')) });
    await render(<Settings />);
    await fireEvent.press(screen.getByRole('button', { name: 'Test connection' }));
    await act(async () => {});
    expect(screen.getByTestId('test-result')).toHaveTextContent(/Can't reach your Pi/);
  });

  it('changing the address: shows the current one, saves the new one, and closes the form', async () => {
    const changeAddress = jest.fn().mockResolvedValue(undefined);
    paired({ changeAddress });
    await render(<Settings />);
    await fireEvent.press(screen.getByRole('button', { name: 'Change address' }));
    expect(screen.getByTestId('address-host').props.value).toBe('192.168.1.20');
    expect(screen.getByTestId('address-port').props.value).toBe('8000');
    await fireEvent.changeText(screen.getByTestId('address-host'), '192.168.1.77');
    await fireEvent.changeText(screen.getByTestId('address-port'), '8001');
    await fireEvent.press(screen.getByRole('button', { name: 'Save address' }));
    await act(async () => {});
    expect(changeAddress).toHaveBeenCalledWith('192.168.1.77', 8001);
    expect(screen.queryByTestId('address-host')).toBeNull();
  });

  it('an address that is refused keeps the form open and explains', async () => {
    paired({ changeAddress: jest.fn().mockRejectedValue(new ApiError('hostNotAllowed')) });
    await render(<Settings />);
    await fireEvent.press(screen.getByRole('button', { name: 'Change address' }));
    await fireEvent.changeText(screen.getByTestId('address-host'), '8.8.8.8');
    await fireEvent.press(screen.getByRole('button', { name: 'Save address' }));
    await act(async () => {});
    expect(screen.getByTestId('address-error')).toHaveTextContent(/isn't on your home network/);
    expect(screen.getByTestId('address-host')).toBeTruthy();
  });

  it('a port that is not a number never reaches the connection', async () => {
    const changeAddress = jest.fn();
    paired({ changeAddress });
    await render(<Settings />);
    await fireEvent.press(screen.getByRole('button', { name: 'Change address' }));
    await fireEvent.changeText(screen.getByTestId('address-port'), 'eight');
    await fireEvent.press(screen.getByRole('button', { name: 'Save address' }));
    expect(changeAddress).not.toHaveBeenCalled();
    expect(screen.getByTestId('address-error')).toHaveTextContent('The port is a number, like 8000.');
  });

  it('Cancel closes the form without changing anything', async () => {
    const changeAddress = jest.fn();
    paired({ changeAddress });
    await render(<Settings />);
    await fireEvent.press(screen.getByRole('button', { name: 'Change address' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('address-host')).toBeNull();
    expect(changeAddress).not.toHaveBeenCalled();
  });

  it('demo mode has no Pi section, but still has voice, look and about', async () => {
    connectionStore.setState({ ...initial, phase: 'demo', saved: null, link: 'connected' }, true);
    await render(<Settings />);
    expect(screen.queryByTestId('pairing-card')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Test connection' })).toBeNull();
    expect(screen.getByRole('radio', { name: 'Speed: Faster' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy diagnostics' })).toBeTruthy();
  });
});

describe('Settings: voice and look', () => {
  it('speed and pitch show the current choice and change it', async () => {
    paired();
    await render(<Settings />);
    expect(screen.getByRole('radio', { name: 'Speed: Normal' }).props.accessibilityState.selected).toBe(true);
    await fireEvent.press(screen.getByRole('radio', { name: 'Speed: Faster' }));
    await fireEvent.press(screen.getByRole('radio', { name: 'Pitch: Lower' }));
    await act(async () => {});
    expect(preferencesStore.getState().prefs).toMatchObject({ speechRate: 1.2, speechPitch: 0.9 });
    expect(screen.getByRole('radio', { name: 'Speed: Faster' }).props.accessibilityState.selected).toBe(true);
    expect(screen.getByRole('radio', { name: 'Pitch: Lower' }).props.accessibilityState.selected).toBe(true);
  });

  it('Hear a sample speaks with the chosen speed and pitch', async () => {
    paired();
    await preferencesStore.getState().update({ speechRate: 1.2, speechPitch: 0.9 });
    await render(<Settings />);
    await fireEvent.press(screen.getByRole('button', { name: 'Hear a sample' }));
    expect(mockSpeak).toHaveBeenCalledWith('This is how I will sound.', expect.objectContaining({ rate: 1.2, pitch: 0.9, language: 'en-US' }));
  });

  it('the Look mode and vibration switch change the saved choices', async () => {
    paired();
    await render(<Settings />);
    expect(screen.getByRole('radio', { name: 'Starts in: Describe' }).props.accessibilityState.selected).toBe(true);
    await fireEvent.press(screen.getByRole('radio', { name: 'Starts in: Read text' }));
    await fireEvent.press(screen.getByRole('switch', { name: 'Vibration' }));
    await act(async () => {});
    expect(preferencesStore.getState().prefs).toMatchObject({ lookStyle: 'read_text', haptics: false });
    expect(screen.getByRole('switch', { name: 'Vibration' }).props.accessibilityState.checked).toBe(false);
  });
});

describe('Settings: privacy and about', () => {
  it('explains where photos go in plain words', async () => {
    paired();
    await render(<Settings />);
    expect(screen.getByText(/Photos go only to your Pi, over your home Wi-Fi/)).toBeTruthy();
  });

  it('Copy diagnostics copies details that never include the pairing secret', async () => {
    paired();
    await render(<Settings />);
    await fireEvent.press(screen.getByRole('button', { name: 'Copy diagnostics' }));
    await act(async () => {});
    expect(mockCopy).toHaveBeenCalledTimes(1);
    const text = String((mockCopy.mock.calls[0] as unknown[])[0]);
    expect(text).toContain('Pi: 192.168.1.20:8000');
    expect(text).toContain('a1b2c3d4');
    expect(text).not.toContain('SECRET-TOKEN-123');
    expect(screen.getByText('Copied.')).toBeTruthy();
  });

  it('the pairing secret is nowhere on screen', async () => {
    paired();
    await render(<Settings />);
    expect(screen.queryByText(/SECRET/)).toBeNull();
    expect(screen.queryByText(/tok/i)).toBeNull();
  });
});

describe('what the preferences do elsewhere', () => {
  it('a fresh store starts from the defaults, so a first launch sounds normal', () => {
    expect(createPreferencesStore().getState().prefs).toEqual(DEFAULT_PREFERENCES);
  });
});
