import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, font, radius, spacing, touch } from './theme';

type Props = {
  tone: 'warn' | 'danger' | 'info';
  title?: string;
  message: string;
  /** If given, a "Dismiss" control is shown. */
  onDismiss?: () => void;
  testID?: string;
};

const TONES = {
  warn: { bg: colors.warnGround, border: colors.warnBorder, fg: colors.textSoft },
  danger: { bg: colors.dangerGround, border: colors.dangerBorder, fg: colors.textSoft },
  info: { bg: colors.surface, border: colors.border, fg: colors.textSoft },
};

export function Banner({ tone, title, message, onDismiss, testID }: Props) {
  const t = TONES[tone];
  return (
    <View
      testID={testID}
      accessible
      accessibilityRole={tone === 'danger' ? 'alert' : 'text'}
      accessibilityLabel={title ? `${title}. ${message}` : message}
      style={[styles.box, { backgroundColor: t.bg, borderColor: t.border }]}
    >
      <View style={styles.body}>
        {title ? <Text style={styles.title}>{title}</Text> : null}
        <Text style={[styles.message, { color: t.fg }]}>{message}</Text>
      </View>
      {onDismiss ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Dismiss" onPress={onDismiss} style={styles.dismiss}>
          <Text style={styles.dismissText}>Dismiss</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderRadius: radius.lg, borderWidth: 1, padding: spacing.lg, gap: spacing.sm },
  body: { gap: spacing.xs },
  title: { ...font.body, fontWeight: '700', color: colors.text },
  message: { ...font.body },
  dismiss: { minHeight: touch.min, justifyContent: 'center', alignSelf: 'flex-start' },
  dismissText: { ...font.label, color: colors.accent },
});
