import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert, Linking } from 'react-native';

import { ApiError } from '../src/api/errors';
import { connectionStore, type ConnectionState } from '../src/state/connection';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn() };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);

let mockPermission: { granted: boolean; canAskAgain: boolean } | null = null;
const mockRequestPermission = jest.fn();
let mockCameraProps: { onBarcodeScanned?: (r: { data: string }) => void } = {};
jest.mock('expo-camera', () => ({
  useCameraPermissions: () => [mockPermission, mockRequestPermission],
  CameraView: (props: typeof mockCameraProps) => {
    mockCameraProps = props;
    return null;
  },
}));

// the screens, imported after the mocks above
import Settings from '../src/app/(app)/settings';
import Manual from '../src/app/(pair)/manual';
import Scan from '../src/app/(pair)/scan';
import Welcome from '../src/app/(pair)/welcome';

const initial = connectionStore.getState();
const withStore = (patch: Partial<ConnectionState>) => connectionStore.setState({ ...initial, ...patch }, true);

beforeEach(() => {
  jest.clearAllMocks();
  mockPermission = null;
  mockCameraProps = {};
  connectionStore.setState(initial, true);
});

describe('Welcome', () => {
  it('explains what to do on the Pi and offers the three ways in', async () => {
    withStore({ phase: 'unpaired' });
    await render(<Welcome />);
    expect(screen.getByRole('header', { name: 'See and talk to Veda from your phone.' })).toBeTruthy();
    expect(screen.getByText(/veda server --lan/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Scan the code on your Pi' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Enter the code by hand' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try without a Pi' })).toBeTruthy();
  });

  it('goes to the scanner, the form, and demo mode', async () => {
    const enterDemo = jest.fn();
    withStore({ phase: 'unpaired', enterDemo });
    await render(<Welcome />);
    await fireEvent.press(screen.getByRole('button', { name: 'Scan the code on your Pi' }));
    expect(mockRouter.push).toHaveBeenCalledWith('/scan');
    await fireEvent.press(screen.getByRole('button', { name: 'Enter the code by hand' }));
    expect(mockRouter.push).toHaveBeenCalledWith('/manual');
    await fireEvent.press(screen.getByRole('button', { name: 'Try without a Pi' }));
    expect(enterDemo).toHaveBeenCalled();
  });

  it('says once that the Pi removed this phone, and the notice can be dismissed', async () => {
    const dismissNotice = jest.fn();
    withStore({ phase: 'unpaired', notice: 'removed', dismissNotice });
    await render(<Welcome />);
    expect(screen.getByTestId('removed-notice')).toBeTruthy();
    expect(screen.getByText('This phone was removed from Veda')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Dismiss' }));
    expect(dismissNotice).toHaveBeenCalled();
  });

  it('shows no notice normally', async () => {
    withStore({ phase: 'unpaired', notice: null });
    await render(<Welcome />);
    expect(screen.queryByTestId('removed-notice')).toBeNull();
  });
});

describe('Manual pairing form', () => {
  const type = async (testID: string, text: string) => fireEvent.changeText(screen.getByTestId(testID), text);

  it('asks for what is missing, and sends nothing', async () => {
    const pair = jest.fn();
    withStore({ phase: 'unpaired', pair });
    await render(<Manual />);
    await fireEvent.press(screen.getByTestId('pair-submit'));
    expect(screen.getByText('Enter the code shown on your Pi.')).toBeTruthy();
    expect(screen.getByText("Enter your Pi's address, like 192.168.1.20.")).toBeTruthy();
    expect(pair).not.toHaveBeenCalled();
  });

  it('refuses an address off the home network, with advice', async () => {
    const pair = jest.fn();
    withStore({ phase: 'unpaired', pair });
    await render(<Manual />);
    await type('field-code', 'K7M2Q9XP');
    await type('field-host', 'example.com');
    await fireEvent.press(screen.getByTestId('pair-submit'));
    expect(screen.getByText(/isn't an address on your home network/)).toBeTruthy();
    expect(pair).not.toHaveBeenCalled();
  });

  it('pairs with a tidied-up version of what was typed', async () => {
    const pair = jest.fn().mockResolvedValue(undefined);
    withStore({ phase: 'unpaired', pair });
    await render(<Manual />);
    await type('field-code', 'k7m2-q9xp');
    await type('field-host', ' 192.168.1.20 ');
    await type('field-name', 'Praveen phone');
    await fireEvent.press(screen.getByTestId('pair-submit'));
    await waitFor(() => expect(pair).toHaveBeenCalledTimes(1));
    expect(pair).toHaveBeenCalledWith({ code: 'K7M2Q9XP', host: '192.168.1.20', port: 8000, deviceName: 'Praveen phone' });
  });

  it('shows the Pi\'s answer in plain words when the code is wrong, and clears it when you edit', async () => {
    const pair = jest.fn().mockRejectedValue(new ApiError('pairCodeInvalid'));
    withStore({ phase: 'unpaired', pair });
    await render(<Manual />);
    await type('field-code', 'WRONGCODE');
    await type('field-host', '192.168.1.20');
    await fireEvent.press(screen.getByTestId('pair-submit'));
    await waitFor(() => expect(screen.getByTestId('pair-error')).toBeTruthy());
    expect(screen.getByText("That code didn't work. Codes last 2 minutes. Run `veda pair` again.")).toBeTruthy();
    await type('field-code', 'WRONGCODE2');
    expect(screen.queryByTestId('pair-error')).toBeNull();
  });

  it('says when it cannot reach the Pi', async () => {
    const pair = jest.fn().mockRejectedValue(new TypeError('Network request failed'));
    withStore({ phase: 'unpaired', pair });
    await render(<Manual />);
    await type('field-code', 'K7M2Q9XP');
    await type('field-host', '192.168.1.20');
    await fireEvent.press(screen.getByTestId('pair-submit'));
    await waitFor(() => expect(screen.getByText("Can't reach your Pi. Is it on, and is this phone on the same Wi-Fi?")).toBeTruthy());
  });

  it('shows it is working while pairing, and cannot be pressed twice', async () => {
    let finish: () => void = () => {};
    const pair = jest.fn(() => new Promise<void>((r) => (finish = r)));
    withStore({ phase: 'unpaired', pair });
    await render(<Manual />);
    await type('field-code', 'K7M2Q9XP');
    await type('field-host', '192.168.1.20');
    // not awaited: the handler is still waiting for the Pi, which is the point of this test
    void fireEvent.press(screen.getByTestId('pair-submit'));
    await waitFor(() => expect(screen.getByTestId('pair-submit').props.accessibilityState).toMatchObject({ busy: true }));
    void fireEvent.press(screen.getByTestId('pair-submit'));
    expect(pair).toHaveBeenCalledTimes(1);
    await act(async () => finish());
  });
});

describe('Scan screen', () => {
  it('waits quietly while the permission state is unknown', async () => {
    mockPermission = null;
    await render(<Scan />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('explains why it needs the camera and offers to ask, and the keyboard route', async () => {
    mockPermission = { granted: false, canAskAgain: true };
    await render(<Scan />);
    expect(screen.getByText(/only to read the pairing code/)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Allow the camera' }));
    expect(mockRequestPermission).toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: 'Enter the code by hand' }));
    expect(mockRouter.replace).toHaveBeenCalledWith('/manual');
  });

  it('when the camera was refused for good, points to Settings', async () => {
    const open = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
    mockPermission = { granted: false, canAskAgain: false };
    await render(<Scan />);
    expect(screen.queryByRole('button', { name: 'Allow the camera' })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Open Settings' }));
    expect(open).toHaveBeenCalled();
  });

  it('pairs straight away from a scanned code, once, however many times the camera reports it', async () => {
    const pair = jest.fn().mockResolvedValue(undefined);
    withStore({ phase: 'unpaired', pair });
    mockPermission = { granted: true, canAskAgain: true };
    await render(<Scan />);
    const qr = 'veda://pair?host=192.168.1.20&port=8000&code=K7M2Q9XP';
    await act(async () => {
      mockCameraProps.onBarcodeScanned?.({ data: qr });
      mockCameraProps.onBarcodeScanned?.({ data: qr });
      mockCameraProps.onBarcodeScanned?.({ data: qr });
    });
    await waitFor(() => expect(pair).toHaveBeenCalledTimes(1));
    expect(pair).toHaveBeenCalledWith({ host: '192.168.1.20', port: 8000, code: 'K7M2Q9XP', deviceName: 'My phone' });
  });

  it('ignores a QR code that is not ours, and says so', async () => {
    const pair = jest.fn();
    withStore({ phase: 'unpaired', pair });
    mockPermission = { granted: true, canAskAgain: true };
    await render(<Scan />);
    await act(async () => mockCameraProps.onBarcodeScanned?.({ data: 'https://example.com/promo' }));
    expect(screen.getByTestId('scan-hint')).toBeTruthy();
    expect(pair).not.toHaveBeenCalled();
  });

  it('refuses a Veda code that points off the home network', async () => {
    const pair = jest.fn();
    withStore({ phase: 'unpaired', pair });
    mockPermission = { granted: true, canAskAgain: true };
    await render(<Scan />);
    await act(async () => mockCameraProps.onBarcodeScanned?.({ data: 'veda://pair?host=8.8.8.8&port=8000&code=K7M2Q9XP' }));
    expect(pair).not.toHaveBeenCalled();
    expect(screen.getByTestId('scan-hint')).toBeTruthy();
  });

  it('shows why pairing failed, and lets the same camera try again', async () => {
    const pair = jest.fn().mockRejectedValueOnce(new ApiError('pairCodeInvalid')).mockResolvedValueOnce(undefined);
    withStore({ phase: 'unpaired', pair });
    mockPermission = { granted: true, canAskAgain: true };
    await render(<Scan />);
    const qr = 'veda://pair?host=192.168.1.20&port=8000&code=K7M2Q9XP';
    await act(async () => mockCameraProps.onBarcodeScanned?.({ data: qr }));
    await waitFor(() => expect(screen.getByTestId('scan-error')).toBeTruthy());
    await act(async () => mockCameraProps.onBarcodeScanned?.({ data: qr }));
    await waitFor(() => expect(pair).toHaveBeenCalledTimes(2));
  });
});

describe('Settings screen', () => {
  const saved = { host: '192.168.1.20', port: 8000, token: 'tok', deviceId: 'a1b2c3d4', deviceName: 'Pixel 8', scopes: ['chat', 'vision', 'approve'] };

  it('shows what this phone is paired with, in plain words', async () => {
    withStore({ phase: 'paired', saved, link: 'connected' });
    await render(<Settings />);
    expect(screen.getByLabelText('This phone: Pixel 8')).toBeTruthy();
    expect(screen.getByLabelText('Device id: a1b2c3d4')).toBeTruthy();
    expect(screen.getByLabelText('Pi address: 192.168.1.20:8000')).toBeTruthy();
    expect(screen.getByLabelText('Allowed: Use the camera, Chat, Approve actions')).toBeTruthy();
    expect(screen.queryByTestId('unreachable-banner')).toBeNull();
  });

  it('never shows the token', async () => {
    withStore({ phase: 'paired', saved, link: 'connected' });
    await render(<Settings />);
    expect(screen.queryByText(/tok/)).toBeNull();
  });

  it('says when the Pi cannot be reached', async () => {
    withStore({ phase: 'paired', saved, link: 'unreachable' });
    await render(<Settings />);
    expect(screen.getByText('Is it on, and is this phone on the same Wi-Fi?')).toBeTruthy(); // the banner says what to check
    expect(screen.getByTestId('unreachable-banner')).toBeTruthy();
  });

  it('asks before forgetting, and tells you the command to remove the phone on the Pi', async () => {
    const forget = jest.fn().mockResolvedValue(undefined);
    withStore({ phase: 'paired', saved, link: 'connected', forget });
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    await render(<Settings />);
    await fireEvent.press(screen.getByRole('button', { name: 'Forget this Pi' }));

    expect(alert).toHaveBeenCalledTimes(1);
    const [title, message, buttons] = alert.mock.calls[0] as [string, string, { text: string; onPress?: () => void }[]];
    expect(title).toBe('Forget this Pi?');
    expect(message).toContain('veda devices revoke a1b2c3d4');
    expect(forget).not.toHaveBeenCalled(); // nothing happens until they confirm
    buttons.find((b) => b.text === 'Forget')?.onPress?.();
    expect(forget).toHaveBeenCalledTimes(1);
  });

  it('in demo mode, says the answers are examples and offers to leave', async () => {
    const forget = jest.fn().mockResolvedValue(undefined);
    withStore({ phase: 'demo', saved: null, link: 'connected', forget });
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    await render(<Settings />);
    expect(screen.getByText('Example answers')).toBeTruthy();
    expect(screen.queryByTestId('pairing-card')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Leave demo mode' }));
    const [, , buttons] = alert.mock.calls[0] as [string, string, { text: string; onPress?: () => void }[]];
    buttons.find((b) => b.text === 'Leave')?.onPress?.();
    expect(forget).toHaveBeenCalled();
  });
});
