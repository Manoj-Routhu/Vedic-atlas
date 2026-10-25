import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, font, radius, spacing, touch } from './theme';

export type ButtonVariant = 'primary' | 'secondary' | 'text' | 'danger';

type Props = {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  loading?: boolean;
  disabled?: boolean;
  icon?: ReactNode;
  accessibilityHint?: string;
  testID?: string;
};

export function Button({ label, onPress, variant = 'primary', loading = false, disabled = false, icon, accessibilityHint, testID }: Props) {
  const inactive = disabled || loading;
  const palette = {
    primary: { bg: colors.accent, fg: colors.onAccent, border: colors.accent },
    secondary: { bg: 'transparent', fg: colors.text, border: colors.muted },
    text: { bg: 'transparent', fg: colors.text, border: 'transparent' },
    danger: { bg: 'transparent', fg: colors.dangerSoft, border: colors.dangerSoft },
  }[variant];

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: inactive, busy: loading }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        variant === 'primary' && !inactive && styles.glow,
        { backgroundColor: palette.bg, borderColor: palette.border, opacity: inactive ? 0.55 : pressed ? 0.9 : 1 },
        pressed && !inactive && { transform: [{ scale: 0.97 }] },
      ]}
    >
      <View style={styles.row}>
        {loading ? <ActivityIndicator color={palette.fg} /> : icon}
        <Text style={[styles.label, { color: palette.fg }]}>{label}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: touch.button,
    borderRadius: radius.pill,
    borderWidth: 2,
    paddingHorizontal: spacing.xl,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glow: { shadowColor: colors.accent, shadowOpacity: 0.4, shadowRadius: 16, shadowOffset: { width: 0, height: 4 }, elevation: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  label: { ...font.button },
});
