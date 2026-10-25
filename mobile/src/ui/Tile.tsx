import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon, type IconName } from './Icon';
import { colors, font, radius, spacing } from './theme';

type Props = {
  /** What a screen reader says (may be longer than the visible title). */
  label: string;
  title: string;
  subtitle: string;
  icon: IconName;
  onPress: () => void;
  /** The big, glowing tile for the main action. */
  hero?: boolean;
  hint?: string;
  testID?: string;
};

/** A large tappable card with an icon: the way into a part of the app. */
export function Tile({ label, title, subtitle, icon, onPress, hero = false, hint, testID }: Props) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      onPress={onPress}
      style={({ pressed }) => [styles.base, hero ? styles.hero : styles.small, pressed && styles.pressed]}
    >
      <View style={[styles.badge, hero && styles.badgeHero]}>
        <Icon name={icon} size={hero ? 34 : 26} color={hero ? colors.onAccent : colors.accent} />
      </View>
      <View style={styles.text}>
        <Text style={[hero ? styles.heroTitle : styles.title]}>{title}</Text>
        <Text style={[styles.subtitle, hero && styles.heroSubtitle]}>{subtitle}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { borderRadius: radius.xl, borderWidth: 1, gap: spacing.lg },
  hero: {
    backgroundColor: colors.accentSoft,
    borderColor: colors.accentBorder,
    padding: spacing.xl,
    minHeight: 190,
    justifyContent: 'space-between',
    shadowColor: colors.accent,
    shadowOpacity: 0.35,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  small: { flex: 1, backgroundColor: colors.surfaceRaised, borderColor: colors.hairline, padding: spacing.lg, minHeight: 148, justifyContent: 'space-between' },
  pressed: { transform: [{ scale: 0.97 }], opacity: 0.92 },
  badge: { width: 52, height: 52, borderRadius: 26, backgroundColor: colors.accentSoft, alignItems: 'center', justifyContent: 'center' },
  badgeHero: { width: 68, height: 68, borderRadius: 34, backgroundColor: colors.accent },
  text: { gap: spacing.xs },
  heroTitle: { ...font.display, color: colors.text },
  title: { ...font.heading, color: colors.text },
  subtitle: { ...font.caption, color: colors.muted },
  heroSubtitle: { ...font.body, color: colors.textSoft },
});
