import { useState } from 'react';
import { StyleSheet, View, type AccessibilityActionEvent, type GestureResponderEvent, type LayoutChangeEvent } from 'react-native';

import { colors } from './theme';

type Props = {
  /** Where the song is now, in seconds. */
  value: number;
  /** The furthest place the bar reaches (the song's length, or where it stops by itself). */
  max: number;
  /** Seconds moved by one TalkBack "increase" / "decrease". */
  step: number;
  /** Read aloud with the value, such as "Position in the song". */
  label: string;
  /** The words for a value, such as "1:30 of 4:22". */
  describe: (seconds: number) => string;
  /** The finger moved: the bar shows this place, nothing is sent yet. */
  onPreview?: (seconds: number) => void;
  /** The finger lifted (or TalkBack stepped): jump here. */
  onCommit: (seconds: number) => void;
  disabled?: boolean;
  testID?: string;
};

/** The place on a bar `width` wide that a touch at `x` points to, kept inside the bar. */
export function valueAt(x: number, width: number, max: number): number {
  if (!(width > 0) || !(max > 0)) return 0;
  return Math.min(max, Math.max(0, (x / width) * max));
}

const TRACK = 6;
const THUMB = 22;
const TOUCH_HEIGHT = 44;

/**
 * A seek bar: drag the dot, or tap the bar, to choose a place; the jump is sent when the finger lifts (one request, not a
 * stream of them). Plain responder events, so it needs no native module. For TalkBack it is an adjustable control: swipe
 * up or down to move by `step`.
 */
export function Scrubber({ value, max, step, label, describe, onPreview, onCommit, disabled = false, testID }: Props) {
  const [width, setWidth] = useState(0);
  const [dragging, setDragging] = useState<number | null>(null);
  const shown = Math.min(max, Math.max(0, dragging ?? value));
  const fraction = max > 0 ? shown / max : 0;

  const at = (e: GestureResponderEvent) => valueAt(e.nativeEvent.locationX, width, max);
  const move = (e: GestureResponderEvent) => {
    const v = at(e);
    setDragging(v);
    onPreview?.(v);
  };
  const lift = (e: GestureResponderEvent) => {
    const v = at(e);
    setDragging(null);
    onCommit(v);
  };
  const accessibilityAction = (e: AccessibilityActionEvent) => {
    if (e.nativeEvent.actionName === 'increment') onCommit(Math.min(max, shown + step));
    else if (e.nativeEvent.actionName === 'decrement') onCommit(Math.max(0, shown - step));
  };

  return (
    <View
      testID={testID}
      style={styles.touch}
      onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: Math.round(max), now: Math.round(shown), text: describe(shown) }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      accessibilityState={{ disabled }}
      onAccessibilityAction={accessibilityAction}
      onStartShouldSetResponder={() => !disabled}
      onMoveShouldSetResponder={() => !disabled}
      onResponderTerminationRequest={() => false} // a scroll view around the bar must not steal the drag
      onResponderGrant={move}
      onResponderMove={move}
      onResponderRelease={lift}
      onResponderTerminate={() => setDragging(null)}
    >
      <View pointerEvents="none" style={styles.track}>
        <View style={[styles.fill, { width: `${fraction * 100}%` }]} />
      </View>
      <View pointerEvents="none" style={[styles.thumb, { left: fraction * width - THUMB / 2 }, disabled && styles.thumbOff]} />
    </View>
  );
}

const styles = StyleSheet.create({
  touch: { height: TOUCH_HEIGHT, justifyContent: 'center' },
  track: { height: TRACK, borderRadius: TRACK / 2, backgroundColor: colors.surfaceHigh, overflow: 'hidden' },
  fill: { height: TRACK, backgroundColor: colors.accent },
  thumb: { position: 'absolute', top: (TOUCH_HEIGHT - THUMB) / 2, width: THUMB, height: THUMB, borderRadius: THUMB / 2, backgroundColor: colors.accent },
  thumbOff: { opacity: 0.4 },
});
