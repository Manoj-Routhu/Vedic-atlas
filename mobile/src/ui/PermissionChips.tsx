import { StyleSheet, Text, View } from 'react-native';

import { colors, font, radius, spacing } from './theme';

const LABELS: Record<string, string> = {
  vision: 'Use the camera',
  chat: 'Chat',
  control: 'Control',
  approve: 'Approve actions',
};
const ORDER = ['vision', 'chat', 'control', 'approve'];

/** What this phone was allowed to do when it was paired, in plain words. */
export function PermissionChips({ scopes }: { scopes: string[] }) {
  const known = ORDER.filter((s) => scopes.includes(s));
  if (known.length === 0) return <Text style={styles.none}>Nothing yet</Text>;
  return (
    <View style={styles.row} accessibilityLabel={`Allowed: ${known.map((s) => LABELS[s]).join(', ')}`} accessible>
      {known.map((s) => (
        <View key={s} style={[styles.chip, s === 'approve' && styles.strong]}>
          <Text style={[styles.text, s === 'approve' && styles.strongText]}>{LABELS[s]}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: { height: 32, paddingHorizontal: 14, borderRadius: radius.pill, backgroundColor: colors.surfaceHigh, justifyContent: 'center' },
  strong: { backgroundColor: colors.accent },
  text: { ...font.label, color: colors.text },
  strongText: { color: colors.onAccent, fontWeight: '700' },
  none: { ...font.body, color: colors.muted },
});
