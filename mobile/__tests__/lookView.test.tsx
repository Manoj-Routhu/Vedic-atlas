import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { ApiError } from '../src/api/errors';
import { LookView } from '../src/features/look/LookView';
import { createLookStore, type LookStore } from '../src/features/look/lookStore';
import type { Photo } from '../src/features/look/ports';

const feedback = { capture: jest.fn(), success: jest.fn(), failure: jest.fn() };

function makeStore(askVision: () => AsyncGenerator<unknown>) {
  const api = {
    putImage: async () => ({ imageId: 'i1', width: 1, height: 1 }),
    askVision,
  };
  const speech = { enqueue: jest.fn(), stop: jest.fn(), isSpeaking: false };
  const photo: Photo = { uri: 'file:///p.jpg', width: 768, height: 576, bytes: new Uint8Array(1), discard: jest.fn() };
  const store = createLookStore({
    getApi: () => api as never,
    takePhoto: async () => photo,
    makeSpeech: () => speech,
    feedback,
  });
  return { store, speech };
}

const answer = (...texts: string[]) =>
  async function* () {
    for (const text of texts) yield { type: 'token', text };
    yield { type: 'done' };
  };

const open = (store: LookStore, extra: Partial<React.ComponentProps<typeof LookView>> = {}) =>
  render(
    <LookView
      store={store}
      preview={<Text>live camera</Text>}
      canShoot
      link="connected"
      onBack={jest.fn()}
      onSettings={jest.fn()}
      onCopy={jest.fn()}
      {...extra}
    />,
  );

beforeEach(() => jest.clearAllMocks());

describe('LookView', () => {
  it('starts on the live camera with the shutter ready and "Describe" chosen', async () => {
    const { store } = makeStore(answer('x.'));
    await open(store);
    expect(screen.getByText('live camera')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Take a photo' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Describe', selected: true })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retake' })).toBeNull();
  });

  it('the shutter does nothing while the camera is not allowed', async () => {
    const { store } = makeStore(answer('x.'));
    await open(store, { canShoot: false });
    expect(screen.getByRole('button', { name: 'Take a photo' }).props.accessibilityState.disabled).toBe(true);
  });

  it('taking a photo freezes it, shows the answer, and offers Hear again, Copy and Retake', async () => {
    const { store } = makeStore(answer('A red apple. ', 'It is on a table.'));
    const onCopy = jest.fn();
    await open(store, { onCopy });
    await fireEvent.press(screen.getByRole('button', { name: 'Take a photo' }));
    await act(async () => {});
    expect(screen.queryByText('live camera')).toBeNull();
    expect(screen.getByLabelText('The photo you took')).toBeTruthy();
    expect(screen.getByTestId('answer')).toHaveTextContent('A red apple. It is on a table.');
    await fireEvent.press(screen.getByRole('button', { name: 'Copy' }));
    expect(onCopy).toHaveBeenCalledWith('A red apple. It is on a table.');
    await fireEvent.press(screen.getByRole('button', { name: 'Retake' }));
    expect(screen.getByText('live camera')).toBeTruthy();
    expect(screen.queryByTestId('answer')).toBeNull();
  });

  it('while working the shutter reads "Stop" and the mode chips are disabled', async () => {
    const never = async function* () {
      await new Promise(() => {});
      yield { type: 'done' };
    };
    const { store } = makeStore(never);
    await open(store);
    await fireEvent.press(screen.getByRole('button', { name: 'Take a photo' }));
    await act(async () => {});
    expect(screen.getByText('Looking…')).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Read text' }).props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(screen.getByRole('button', { name: 'Stop' }));
    expect(screen.getByRole('button', { name: 'Take a photo' })).toBeTruthy();
  });

  it('choosing "Read text" with a photo on screen asks again in that mode', async () => {
    const asked: string[] = [];
    const { store } = makeStore(async function* (...args: unknown[]) {
      asked.push((args[0] as { style: string }).style);
      yield { type: 'token', text: 'Hi.' };
      yield { type: 'done' };
    } as never);
    await open(store);
    await fireEvent.press(screen.getByRole('button', { name: 'Take a photo' }));
    await act(async () => {});
    await fireEvent.press(screen.getByRole('radio', { name: 'Read text' }));
    await act(async () => {});
    expect(asked).toEqual(['brief', 'read_text']);
    expect(screen.getByRole('radio', { name: 'Read text', selected: true })).toBeTruthy();
  });

  it('a failure shows the plain message and "Try again" asks about the same photo', async () => {
    let calls = 0;
    const { store } = makeStore(async function* () {
      if (calls++ === 0) throw new ApiError('modelNotReady');
      yield { type: 'token', text: 'Fixed.' };
      yield { type: 'done' };
    });
    await open(store);
    await fireEvent.press(screen.getByRole('button', { name: 'Take a photo' }));
    await act(async () => {});
    expect(screen.getByTestId('look-error')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    await act(async () => {});
    expect(screen.queryByTestId('look-error')).toBeNull();
    expect(screen.getByTestId('answer')).toHaveTextContent('Fixed.');
  });

  it('shows the Settings gear and the connection status; "waking" replaces it while the model loads', async () => {
    const onSettings = jest.fn();
    const { store } = makeStore(answer('x.'));
    await open(store, { onSettings, link: 'unreachable' });
    expect(screen.getByLabelText("Can't reach your Pi")).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Settings' }));
    expect(onSettings).toHaveBeenCalled();
    await act(async () => store.setState({ waking: true }));
    expect(screen.getByLabelText('Waking the camera model')).toBeTruthy();
  });

  it('says so when the phone cannot speak, and after being paused by leaving the app', async () => {
    const { store } = makeStore(answer('Some words. More'));
    await open(store);
    await act(async () => store.setState({ speechUnavailable: true }));
    expect(screen.getByText(/can't speak right now/)).toBeTruthy();
    await act(async () => store.setState({ phase: 'answered', sentences: ['Some words.'], done: false, interrupted: true }));
    expect(screen.getByText('Paused when you left the app.')).toBeTruthy();
  });
});
