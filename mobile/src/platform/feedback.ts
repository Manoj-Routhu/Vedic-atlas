import * as Haptics from 'expo-haptics';

import type { Feedback } from '../features/look/ports';

import { preferencesStore } from '../state/preferences';

const safely = (fn: () => Promise<void>) => void fn().catch(() => undefined);

/** Small vibrations: a tap on the shutter, a double tap on success, a buzz on failure. They never block anything. */
export function createHapticFeedback(enabled: () => boolean): Feedback {
  const when = (fn: () => Promise<void>) => () => enabled() && safely(fn);
  return {
    capture: when(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)),
    success: when(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)),
    failure: when(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)),
  };
}

/** The app's vibration, which follows the switch in Settings. */
export const hapticFeedback = createHapticFeedback(() => preferencesStore.getState().prefs.haptics);
