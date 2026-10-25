import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { DemoApi } from '../src/api/demo';
import { ApiError } from '../src/api/errors';
import type { PiApi } from '../src/api/pi';
import { ControlView } from '../src/features/control/ControlView';
import { createControlStore } from '../src/features/control/controlStore';

const ALL = ['chat', 'control', 'vision', 'approve'];

async function open(scopes: string[] = ALL, tweak?: (api: DemoApi) => void) {
  const api = new DemoApi();
  tweak?.(api);
  const store = createControlStore({ getApi: () => api as PiApi, scopes: () => scopes });
  const onBack = jest.fn();
  const utils = await render(<ControlView store={store} scopes={scopes} link="connected" onBack={onBack} onSettings={jest.fn()} />);
  await act(async () => store.getState().refresh());
  return { api, store, onBack, ...utils };
}

describe('ControlView', () => {
  it('shows every card for a phone with full permissions', async () => {
    await open();
    for (const id of ['card-status', 'card-mic', 'card-tasks', 'card-reminders', 'card-personality', 'card-activity']) {
      expect(screen.getByTestId(id)).toBeTruthy();
    }
    expect(screen.getByLabelText(/Connection: Online/)).toBeTruthy();
    expect(screen.getByLabelText('Camera model: asleep (wakes on the first photo)')).toBeTruthy();
    expect(screen.getByLabelText('Auto-approve: Off')).toBeTruthy();
    expect(screen.getByLabelText('Veda is: Listening')).toBeTruthy();
    expect(screen.getByLabelText('Heads-up: 15 min before')).toBeTruthy();
  });

  it('a phone with only the chat permission sees tasks and personality, but none of the control cards', async () => {
    await open(['chat']);
    expect(screen.getByTestId('card-tasks')).toBeTruthy();
    expect(screen.getByTestId('card-personality')).toBeTruthy();
    expect(screen.queryByTestId('card-mic')).toBeNull();
    expect(screen.queryByTestId('card-reminders')).toBeNull();
    expect(screen.queryByTestId('card-activity')).toBeNull();
    // it may look at the persona but not change it
    expect(screen.getByRole('radio', { name: 'Persona: Assistant' }).props.accessibilityState.disabled).toBe(true);
    expect(screen.queryByLabelText(/Speaks up/)).toBeNull();
  });

  it('warns when auto-approve is on at the Pi', async () => {
    await open(ALL, (api) => jest.spyOn(api, 'autoApprove').mockResolvedValue(true));
    expect(screen.getByLabelText('Auto-approve: On: chat from the phone is paused')).toBeTruthy();
  });

  it('Mute closes the microphone, the button goes away, and the card says only the Pi can unmute', async () => {
    await open();
    expect(screen.getByText('To unmute, use the Pi. A phone can only mute.')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Mute' }));
    await act(async () => {});
    expect(screen.getByLabelText('Veda is: Not listening (muted)')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Mute' })).toBeNull();
    expect(screen.queryByRole('button', { name: /unmute/i })).toBeNull();
  });

  it('a hardware switch is explained instead', async () => {
    await open(ALL, (api) => jest.spyOn(api, 'privacy').mockResolvedValue({ muted: false, source: 'hardware', hardwareSwitch: true }));
    expect(screen.getByText('A switch on the Pi controls the microphone.')).toBeTruthy();
  });

  it('ticking a task removes it; adding one puts it in the list', async () => {
    await open();
    await fireEvent.press(screen.getByTestId('task-1'));
    await act(async () => {});
    expect(screen.queryByText('Call mum')).toBeNull();
    expect(screen.getByText('Buy milk')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add' }).props.accessibilityState.disabled).toBe(true);
    await fireEvent.changeText(screen.getByTestId('new-task'), 'Water plants');
    await fireEvent.press(screen.getByRole('button', { name: 'Add' }));
    await act(async () => {});
    expect(screen.getByText('Water plants')).toBeTruthy();
    expect(screen.getByTestId('new-task').props.value).toBe('');
  });

  it('changing the heads-up time: valid input saves, invalid input explains', async () => {
    await open();
    await fireEvent.press(screen.getByRole('button', { name: 'Change heads-up time' }));
    await fireEvent.changeText(screen.getByTestId('leads-input'), '999');
    await fireEvent.press(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText('Use up to five numbers from 1 to 120, like 15, 5.')).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('leads-input'), '30, 10');
    expect(screen.queryByText(/Use up to five numbers/)).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Save' }));
    await act(async () => {});
    expect(screen.getByLabelText('Heads-up: 30 and 10 min before')).toBeTruthy();
    expect(screen.queryByTestId('leads-input')).toBeNull();
  });

  it('picking a persona and a proactivity level', async () => {
    await open();
    expect(screen.getByRole('radio', { name: 'Persona: Friend' }).props.accessibilityState.selected).toBe(true);
    await fireEvent.press(screen.getByRole('radio', { name: 'Persona: Assistant' }));
    await act(async () => {});
    expect(screen.getByRole('radio', { name: 'Persona: Assistant' }).props.accessibilityState.selected).toBe(true);
    await fireEvent.press(screen.getByRole('radio', { name: 'Speaks up: Chatty' }));
    await act(async () => {});
    expect(screen.getByRole('radio', { name: 'Speaks up: Chatty' }).props.accessibilityState.selected).toBe(true);
  });

  it('a change that fails shows the reason, and can be dismissed', async () => {
    await open(ALL, (api) => jest.spyOn(api, 'mute').mockRejectedValue(new ApiError('forbidden')));
    await fireEvent.press(screen.getByRole('button', { name: 'Mute' }));
    await act(async () => {});
    expect(screen.getByTestId('control-error')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('control-error')).toBeNull();
  });

  it('a card the Pi refuses to this phone is hidden, not shown broken', async () => {
    await open(ALL, (api) => jest.spyOn(api, 'activity').mockRejectedValue(new ApiError('forbidden')));
    expect(screen.queryByTestId('card-activity')).toBeNull();
    expect(screen.getByTestId('card-mic')).toBeTruthy();
  });

  it('a Pi that does not answer says so', async () => {
    await open(ALL, (api) => jest.spyOn(api, 'health').mockRejectedValue(new ApiError('unreachable')));
    expect(screen.getByLabelText('Connection: Not answering')).toBeTruthy();
  });

  it('lists recent activity with what ran and how long it took', async () => {
    await open();
    expect(screen.getByLabelText('set_reminder, 400 ms')).toBeTruthy();
    expect(screen.getByLabelText('weather, 1.2 s')).toBeTruthy();
  });

  it('has a way back to Home', async () => {
    const { onBack } = await open();
    await fireEvent.press(screen.getByRole('button', { name: 'Home' }));
    expect(onBack).toHaveBeenCalled();
  });
});
