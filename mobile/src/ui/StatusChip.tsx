import { StyleSheet, Text, View } from 'react-native';

import { colors, font, radius, spacing } from './theme';

export type ChipStatus = 'connected' | 'checking' | 'unreachable' | 'waking' | 'demo';

const TEXT: Record<ChipStatus, { label: string; dot: string }> = {
  connected: { label: 'Pi connected', dot: colors.ok },
  checking: { label: 'Checking your Pi', dot: colors.warn },
  unreachable: { label: "Can't reach your Pi", dot: colors.danger },
  waking: { label: 'Waking the camera model', dot: colors.warn },
  demo: { label: 'Demo mode', dot: colors.warn },
};

/** The connection state, always as words as well as a colour. Announced politely when it changes. */
export function StatusChip({ status }: { status: ChipStatus }) {
  const { label, dot } = TEXT[status];
  return (
    <View style={styles.chip} accessible accessibilityRole="text" accessibilityLabel={label} accessibilityLiveRegion="polite">
      <View style={[styles.dot, { backgroundColor: dot }]} />
      <Text style={styles.label}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    height: 32,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.hairline,
  },
  dot: { width: 9, height: 9, borderRadius: 5 },
  label: { ...font.label, color: colors.text },
});
