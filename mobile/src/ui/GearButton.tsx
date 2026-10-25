import { Pressable, StyleSheet } from 'react-native';

import { Icon } from './Icon';
import { colors, touch } from './theme';

/** The Settings button at the top right of every main screen. */
export function GearButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="Settings" onPress={onPress} hitSlop={4} style={({ pressed }) => [styles.button, pressed && styles.pressed]}>
      <Icon name="settings" size={24} color={colors.text} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { width: touch.min, height: touch.min, borderRadius: touch.min / 2, alignItems: 'center', justifyContent: 'center' },
  pressed: { backgroundColor: colors.surface },
});
