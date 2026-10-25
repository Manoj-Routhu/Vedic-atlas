import { StyleSheet, View } from 'react-native';

import { colors } from './theme';

/** Veda's mark: a glowing amber dot inside two soft rings, like an eye opening or a sun rising. Decorative. */
export function VedaMark({ size = 44 }: { size?: number }) {
  const ring = (scale: number, alpha: number) => ({
    position: 'absolute' as const,
    width: size * scale,
    height: size * scale,
    borderRadius: (size * scale) / 2,
    borderWidth: Math.max(1.5, size / 22),
    borderColor: `rgba(245, 165, 36, ${alpha})`,
  });
  return (
    <View style={[styles.box, { width: size, height: size }]} accessible={false} importantForAccessibility="no-hide-descendants">
      <View style={ring(1, 0.22)} />
      <View style={ring(0.72, 0.5)} />
      <View style={[styles.dot, { width: size * 0.34, height: size * 0.34, borderRadius: size * 0.17 }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  box: { alignItems: 'center', justifyContent: 'center' },
  dot: { backgroundColor: colors.accent, shadowColor: colors.accent, shadowOpacity: 0.9, shadowRadius: 10, shadowOffset: { width: 0, height: 0 }, elevation: 6 },
});
