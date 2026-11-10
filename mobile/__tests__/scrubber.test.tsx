import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { Scrubber, valueAt } from '../src/ui/Scrubber';

describe('valueAt: the place a touch points to', () => {
  it.each([
    [0, 300, 240, 0],
    [150, 300, 240, 120],
    [300, 300, 240, 240],
    [-20, 300, 240, 0], // dragged off the left end
    [999, 300, 240, 240], // dragged off the right end
  ])('x %s on a bar %s wide holding %s s is %s s', (x, width, max, expected) => expect(valueAt(x, width, max)).toBe(expected));

  it('is 0 before the bar has a width, or for an empty bar', () => {
    expect(valueAt(10, 0, 240)).toBe(0);
    expect(valueAt(10, 300, 0)).toBe(0);
  });
});

async function setup(patch: Partial<React.ComponentProps<typeof Scrubber>> = {}) {
  const onPreview = jest.fn();
  const onCommit = jest.fn();
  await render(
    <Scrubber
      testID="bar"
      value={60}
      max={240}
      step={10}
      label="Position in the song"
      describe={(v) => `${v} of 240`}
      onPreview={onPreview}
      onCommit={onCommit}
      {...patch}
    />,
  );
  const bar = screen.getByTestId('bar');
  await fireEvent(bar, 'layout', { nativeEvent: { layout: { width: 300, height: 44, x: 0, y: 0 } } });
  return { bar, onPreview, onCommit };
}

const touch = (x: number) => ({ nativeEvent: { locationX: x } });

describe('Scrubber', () => {
  it('shows the value to a screen reader as an adjustable control', async () => {
    const { bar } = await setup();
    expect(bar.props.accessibilityRole).toBe('adjustable');
    expect(bar.props.accessibilityLabel).toBe('Position in the song');
    expect(bar.props.accessibilityValue).toEqual({ min: 0, max: 240, now: 60, text: '60 of 240' });
  });

  it('a drag previews while the finger moves and sends ONE jump when it lifts', async () => {
    const { bar, onPreview, onCommit } = await setup();
    await fireEvent(bar, 'responderGrant', touch(75));
    await fireEvent(bar, 'responderMove', touch(150));
    await fireEvent(bar, 'responderMove', touch(225));
    expect(onPreview.mock.calls.map((c) => c[0])).toEqual([60, 120, 180]);
    expect(onCommit).not.toHaveBeenCalled();
    await fireEvent(bar, 'responderRelease', touch(225));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(180);
  });

  it('a tap on the bar jumps to that place', async () => {
    const { bar, onCommit } = await setup();
    await fireEvent(bar, 'responderGrant', touch(300));
    await fireEvent(bar, 'responderRelease', touch(300));
    expect(onCommit).toHaveBeenCalledWith(240);
  });

  it('shows the dragged place while dragging, then goes back to the value it is given', async () => {
    const { bar } = await setup();
    await fireEvent(bar, 'responderGrant', touch(150));
    expect(screen.getByTestId('bar').props.accessibilityValue.now).toBe(120);
    await fireEvent(bar, 'responderTerminate', touch(150)); // the touch was taken away: no jump, back to the song's place
    expect(screen.getByTestId('bar').props.accessibilityValue.now).toBe(60);
  });

  it('refuses to be taken over by a scroll view while a finger is on it', async () => {
    const { bar } = await setup();
    expect(bar.props.onResponderTerminationRequest()).toBe(false);
  });

  it('TalkBack increase and decrease move by the step, and stay inside the bar', async () => {
    const { bar, onCommit } = await setup();
    await act(async () => bar.props.onAccessibilityAction({ nativeEvent: { actionName: 'increment' } }));
    await act(async () => bar.props.onAccessibilityAction({ nativeEvent: { actionName: 'decrement' } }));
    expect(onCommit.mock.calls.map((c) => c[0])).toEqual([70, 50]);
    const edge = await setup({ value: 235, onCommit: jest.fn() });
    expect(edge.bar).toBeTruthy();
  });

  it('a disabled bar does not take touches', async () => {
    const { bar } = await setup({ disabled: true });
    expect(bar.props.onStartShouldSetResponder()).toBe(false);
    expect(bar.props.accessibilityState).toEqual({ disabled: true });
  });

  it('keeps the value inside 0..max even if given one outside', async () => {
    const { bar } = await setup({ value: 999 });
    expect(bar.props.accessibilityValue.now).toBe(240);
  });
});
