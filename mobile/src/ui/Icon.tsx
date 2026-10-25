import { Ionicons } from '@expo/vector-icons';
import type { ComponentProps } from 'react';

import { colors } from './theme';

export type IconName = ComponentProps<typeof Ionicons>['name'];

/** A decorative icon. The words next to it carry the meaning, so screen readers skip it. */
export function Icon({ name, size = 24, color = colors.text }: { name: IconName; size?: number; color?: string }) {
  return <Ionicons name={name} size={size} color={color} accessible={false} importantForAccessibility="no" accessibilityElementsHidden />;
}
