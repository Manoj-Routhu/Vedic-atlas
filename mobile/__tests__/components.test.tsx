import { fireEvent, render, screen } from '@testing-library/react-native';

import { Banner } from '../src/ui/Banner';
import { Button } from '../src/ui/Button';
import { PermissionChips } from '../src/ui/PermissionChips';
import { StatusChip } from '../src/ui/StatusChip';
import { TextField } from '../src/ui/TextField';

describe('Button', () => {
  it('is a button with its label, and calls onPress', async () => {
    const onPress = jest.fn();
    await render(<Button label="Pair this phone" onPress={onPress} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Pair this phone' }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('does nothing while loading, and says it is busy', async () => {
    const onPress = jest.fn();
    await render(<Button label="Pair this phone" onPress={onPress} loading />);
    const button = screen.getByRole('button', { name: 'Pair this phone' });
    expect(button.props.accessibilityState).toMatchObject({ busy: true, disabled: true });
    await fireEvent.press(button);
    expect(onPress).not.toHaveBeenCalled();
  });

  it('does nothing when disabled', async () => {
    const onPress = jest.fn();
    await render(<Button label="Go" onPress={onPress} disabled />);
    await fireEvent.press(screen.getByRole('button', { name: 'Go' }));
    expect(onPress).not.toHaveBeenCalled();
  });
});

describe('TextField', () => {
  it('is labelled, and typing reaches the handler', async () => {
    const onChangeText = jest.fn();
    await render(<TextField label="Pi address" value="" onChangeText={onChangeText} helper="Like 192.168.1.20" />);
    expect(screen.getByText('Like 192.168.1.20')).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText('Pi address'), '192.168.1.5');
    expect(onChangeText).toHaveBeenCalledWith('192.168.1.5');
  });

  it('shows an error in place of the helper', async () => {
    await render(<TextField label="Port" value="0" onChangeText={() => {}} helper="helper text" error="Enter a port between 1 and 65535." />);
    expect(screen.getByText('Enter a port between 1 and 65535.')).toBeTruthy();
    expect(screen.queryByText('helper text')).toBeNull();
  });
});

describe('StatusChip', () => {
  it.each([
    ['connected', 'Pi connected'],
    ['checking', 'Checking your Pi'],
    ['unreachable', "Can't reach your Pi"],
    ['waking', 'Waking the camera model'],
    ['demo', 'Demo mode'],
  ] as const)('%s says "%s" in words, not only a colour', async (status, label) => {
    await render(<StatusChip status={status} />);
    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.getByLabelText(label)).toBeTruthy();
  });
});

describe('Banner', () => {
  it('reads out as one message, and an error is announced as an alert', async () => {
    await render(<Banner tone="danger" title="Can't reach your Pi" message="Is it on?" testID="b" />);
    expect(screen.getByTestId('b')).toBeTruthy();
    expect(screen.getByLabelText("Can't reach your Pi. Is it on?")).toBeTruthy();
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('can be dismissed', async () => {
    const onDismiss = jest.fn();
    await render(<Banner tone="warn" message="Pair it again." onDismiss={onDismiss} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalled();
  });
});

describe('PermissionChips', () => {
  it('lists what the phone may do, in plain words and a fixed order', async () => {
    await render(<PermissionChips scopes={['chat', 'approve', 'vision', 'control']} />);
    expect(screen.getByLabelText('Allowed: Use the camera, Chat, Control, Approve actions')).toBeTruthy();
  });

  it('shows only what was granted, and ignores scopes it does not know', async () => {
    await render(<PermissionChips scopes={['chat', 'admin']} />);
    expect(screen.getByLabelText('Allowed: Chat')).toBeTruthy();
    expect(screen.queryByText('admin')).toBeNull();
  });

  it('says so when nothing was granted', async () => {
    await render(<PermissionChips scopes={[]} />);
    expect(screen.getByText('Nothing yet')).toBeTruthy();
  });
});
