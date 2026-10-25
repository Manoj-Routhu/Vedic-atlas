import { Feather } from '@expo/vector-icons';
import type { ComponentProps } from 'react';

import { colors } from './theme';

export type IconName = ComponentProps<typeof Feather>['name'];

/** A decorative line icon. The words next to it carry the meaning, so screen readers skip it. */
export function Icon({ name, size = 24, color = colors.text }: { name: IconName; size?: number; color?: string }) {
  return <Feather name={name} size={size} color={color} accessible={false} importantForAccessibility="no" accessibilityElementsHidden />;
}
