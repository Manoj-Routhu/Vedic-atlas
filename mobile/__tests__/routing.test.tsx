/**
 * The real route table, built from the files in src/app, with the real root layout and its pairing guard.
 * This is what the phone does on launch. (The first APK showed "Unmatched Route" on a fresh install because nothing lived at `/`
 * for an unpaired phone: screens tested one at a time cannot catch that, a booted router can.)
 */
import { act, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';

import { connectionStore, type ConnectionState, type Saved } from '../src/state/connection';

jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
jest.mock('expo-camera', () => ({ useCameraPermissions: () => [{ granted: false, canAskAgain: true }, jest.fn()], CameraView: () => null }));

jest.mock('expo-speech-recognition', () => ({ ExpoSpeechRecognitionModule: {} }));
jest.mock('expo-speech', () => ({ speak: jest.fn(), stop: jest.fn(async () => {}) }));
jest.mock('expo-haptics', () => ({ impactAsync: jest.fn(async () => {}), notificationAsync: jest.fn(async () => {}), ImpactFeedbackStyle: { Medium: 'm' }, NotificationFeedbackType: { Success: 's', Error: 'e' } }));
jest.mock('expo-keep-awake', () => ({ activateKeepAwakeAsync: jest.fn(async () => {}), deactivateKeepAwake: jest.fn(async () => {}) }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => {}) }));
jest.mock('expo-image-manipulator', () => ({ ImageManipulator: { manipulate: jest.fn() }, SaveFormat: { JPEG: 'jpeg' } }));
jest.mock('expo-file-system', () => ({ File: jest.fn() }));

const APP = './src/app'; // resolved against the project folder, where jest runs
const initial = connectionStore.getState();
const SAVED: Saved = { host: '192.168.1.20', port: 8000, token: 'tok', deviceId: 'a1b2c3d4', deviceName: 'Pixel 8', scopes: ['chat', 'vision'] };

/** Set the pairing state as `load()` would have found it, without touching the Keystore. */
function startAs(patch: Partial<ConnectionState>) {
  connectionStore.setState({ ...initial, load: async () => {}, ...patch }, true);
}

const WELCOME = 'See and talk to Veda from your phone.';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('launching the app', () => {
  it('a fresh install lands on the welcome screen, not "Unmatched Route"', async () => {
    startAs({ phase: 'unpaired' });
    const r = await renderRouter(APP, { initialUrl: '/' });
    await waitFor(() => expect(r.getPathname()).toBe('/welcome'));
    expect(screen.getByText(WELCOME)).toBeTruthy();
    expect(screen.queryByText('Unmatched Route')).toBeNull();
  });

  it('opening the app with the bare veda:// address (what the launcher uses) lands there too', async () => {
    startAs({ phase: 'unpaired' });
    const r = await renderRouter(APP, { initialUrl: 'veda:///' });
    await waitFor(() => expect(r.getPathname()).toBe('/welcome'));
    expect(screen.queryByText('Unmatched Route')).toBeNull();
  });

  it('a paired phone goes straight into the app', async () => {
    startAs({ phase: 'paired', saved: SAVED, link: 'connected' });
    const r = await renderRouter(APP, { initialUrl: '/' });
    await waitFor(() => expect(r.getPathname()).toBe('/home'));
    expect(screen.getByRole('button', { name: 'Look' })).toBeTruthy();
  });

  it('demo mode goes into the app, and says so', async () => {
    startAs({ phase: 'demo', saved: null, link: 'connected' });
    const r = await renderRouter(APP, { initialUrl: '/' });
    await waitFor(() => expect(r.getPathname()).toBe('/home'));
    expect(screen.getByRole('button', { name: 'Look' })).toBeTruthy();
    expect(screen.getByLabelText('Demo mode')).toBeTruthy();
  });

  it('shows nothing (the splash is still up) until it knows whether the phone is paired', async () => {
    startAs({ phase: 'loading' });
    await renderRouter(APP, { initialUrl: '/' });
    expect(screen.queryByText(WELCOME)).toBeNull();
    expect(screen.queryByText('Unmatched Route')).toBeNull();
    await act(async () => connectionStore.setState({ phase: 'unpaired' }));
    await waitFor(() => expect(screen.getByText(WELCOME)).toBeTruthy());
  });
});

describe('the pairing guard', () => {
  it('an unpaired phone cannot reach the app screen, even by address', async () => {
    startAs({ phase: 'unpaired' });
    const r = await renderRouter(APP, { initialUrl: '/look' });
    await waitFor(() => expect(r.getPathname()).not.toBe('/look'));
    expect(screen.queryByRole('button', { name: 'Take a photo' })).toBeNull();
    expect(screen.queryByText('Unmatched Route')).toBeNull();
  });

  it('a paired phone cannot be left on the pairing screens', async () => {
    startAs({ phase: 'paired', saved: SAVED, link: 'connected' });
    const r = await renderRouter(APP, { initialUrl: '/welcome' });
    await waitFor(() => expect(r.getPathname()).toBe('/home'));
    expect(screen.queryByText(WELCOME)).toBeNull();
  });

  it('pairing moves the user into the app by itself', async () => {
    startAs({ phase: 'unpaired' });
    const r = await renderRouter(APP, { initialUrl: '/welcome' });
    await waitFor(() => expect(screen.getByText(WELCOME)).toBeTruthy());
    await act(async () => connectionStore.setState({ phase: 'paired', saved: SAVED, link: 'connected' }));
    await waitFor(() => expect(r.getPathname()).toBe('/home'));
    expect(screen.getByRole('button', { name: 'Look' })).toBeTruthy();
  });

  it('being removed by the Pi (or forgetting) returns to the welcome screen', async () => {
    startAs({ phase: 'paired', saved: SAVED, link: 'connected' });
    const r = await renderRouter(APP, { initialUrl: '/' });
    await waitFor(() => expect(r.getPathname()).toBe('/home'));
    await act(async () => connectionStore.setState({ phase: 'unpaired', saved: null, notice: 'removed' }));
    await waitFor(() => expect(r.getPathname()).toBe('/welcome'));
    expect(screen.getByText('This phone was removed from Veda')).toBeTruthy();
  });

  it('the pairing screens are all reachable when unpaired', async () => {
    startAs({ phase: 'unpaired' });
    const r = await renderRouter(APP, { initialUrl: '/manual' });
    await waitFor(() => expect(r.getPathname()).toBe('/manual'));
    expect(screen.getByText('Enter the code')).toBeTruthy();
  });
});

describe('the app screens', () => {
  it('Home opens Look and Settings, and each has a way back to Home', async () => {
    startAs({ phase: 'paired', saved: SAVED, link: 'connected' });
    const r = await renderRouter(APP, { initialUrl: '/' });
    await waitFor(() => expect(r.getPathname()).toBe('/home'));

    await fireEvent.press(screen.getByRole('button', { name: 'Look' }));
    await waitFor(() => expect(r.getPathname()).toBe('/look'));
    expect(screen.getByRole('button', { name: 'Take a photo' })).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Home' }));
    await waitFor(() => expect(r.getPathname()).toBe('/home'));

    await fireEvent.press(screen.getByRole('button', { name: 'Settings' }));
    await waitFor(() => expect(r.getPathname()).toBe('/settings'));
    expect(screen.getByLabelText('This phone: Pixel 8')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(r.getPathname()).toBe('/home'));
  });

  it('opening Look directly still has a way home', async () => {
    startAs({ phase: 'paired', saved: SAVED, link: 'connected' });
    const r = await renderRouter(APP, { initialUrl: '/look' });
    await waitFor(() => expect(r.getPathname()).toBe('/look'));
    await fireEvent.press(screen.getByRole('button', { name: 'Home' }));
    await waitFor(() => expect(r.getPathname()).toBe('/home'));
  });

  it('Look and Settings are not reachable by an unpaired phone', async () => {
    for (const url of ['/look', '/settings', '/home']) {
      startAs({ phase: 'unpaired' });
      const r = await renderRouter(APP, { initialUrl: url });
      await waitFor(() => expect(r.getPathname()).not.toBe(url));
      expect(screen.queryByText('Unmatched Route')).toBeNull();
    }
  });
});

describe('chat and the permissions on Home', () => {
  it('a phone with chat and camera permission sees both buttons, and Chat opens with a way back', async () => {
    startAs({ phase: 'paired', saved: SAVED, link: 'connected' });
    const r = await renderRouter(APP, { initialUrl: '/home' });
    await waitFor(() => expect(r.getPathname()).toBe('/home'));
    expect(screen.getByRole('button', { name: 'Look' })).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Chat with Veda' }));
    await waitFor(() => expect(r.getPathname()).toBe('/chat'));
    expect(screen.getByLabelText('Message to Veda')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Home' }));
    await waitFor(() => expect(r.getPathname()).toBe('/home'));
  });

  it('a phone paired without the camera or chat permission is not offered them', async () => {
    startAs({ phase: 'paired', saved: { ...SAVED, scopes: ['chat'] }, link: 'connected' });
    await renderRouter(APP, { initialUrl: '/home' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Chat with Veda' })).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Look' })).toBeNull();
  });

  it('a phone with no permissions is told how to fix that', async () => {
    startAs({ phase: 'paired', saved: { ...SAVED, scopes: [] }, link: 'connected' });
    await renderRouter(APP, { initialUrl: '/home' });
    await waitFor(() => expect(screen.getByText(/not given any permissions/)).toBeTruthy());
  });

  it('Chat is not reachable by an unpaired phone', async () => {
    startAs({ phase: 'unpaired' });
    const r = await renderRouter(APP, { initialUrl: '/chat' });
    await waitFor(() => expect(r.getPathname()).not.toBe('/chat'));
  });
});

describe('Control', () => {
  it('Home offers Control to a phone with the control permission, and it opens with a way back', async () => {
    startAs({ phase: 'paired', saved: { ...SAVED, scopes: ['chat', 'control', 'vision'] }, link: 'connected' });
    const r = await renderRouter(APP, { initialUrl: '/home' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Control' })).toBeTruthy());
    await fireEvent.press(screen.getByRole('button', { name: 'Control' }));
    await waitFor(() => expect(r.getPathname()).toBe('/control'));
    await fireEvent.press(screen.getByRole('button', { name: 'Home' }));
    await waitFor(() => expect(r.getPathname()).toBe('/home'));
  });

  it('a phone without the control permission is not offered it', async () => {
    startAs({ phase: 'paired', saved: { ...SAVED, scopes: ['chat'] }, link: 'connected' });
    await renderRouter(APP, { initialUrl: '/home' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Chat with Veda' })).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Control' })).toBeNull();
  });

  it('Control is not reachable by an unpaired phone', async () => {
    startAs({ phase: 'unpaired' });
    const r = await renderRouter(APP, { initialUrl: '/control' });
    await waitFor(() => expect(r.getPathname()).not.toBe('/control'));
  });

  it('demo mode shows Control with example data', async () => {
    startAs({ phase: 'demo', saved: null, link: 'connected' });
    const r = await renderRouter(APP, { initialUrl: '/home' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Control' })).toBeTruthy());
    await fireEvent.press(screen.getByRole('button', { name: 'Control' }));
    await waitFor(() => expect(r.getPathname()).toBe('/control'));
  });
});
