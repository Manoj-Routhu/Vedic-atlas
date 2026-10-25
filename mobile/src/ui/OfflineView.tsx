import { useRouter } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { connectionStore, useConnection } from '../state/connection';
import { Button } from './Button';
import { GearButton } from './GearButton';
import { Icon } from './Icon';
import { Screen } from './Screen';
import { StatusChip } from './StatusChip';
import { colors, font, radius, spacing } from './theme';

/** Shown in place of the main screens while the Pi does not answer. Trying again or changing the address are the two ways out. */
export function OfflineView() {
  const router = useRouter();
  const saved = useConnection((s) => s.saved);
  const [trying, setTrying] = useState(false);
  const STEPS: ReactNode[] = [
    'The Pi is on and connected to your router.',
    'This phone is on the same Wi-Fi, not mobile data.',
    <>
      Veda is running on the Pi: <Text style={styles.mono}>veda server --lan</Text>
    </>,
  ];

  const tryAgain = async () => {
    setTrying(true);
    try {
      await connectionStore.getState().testConnection(); // a good answer marks the link connected, which brings the app back
    } catch {
      // still unreachable: the screen stays
    } finally {
      setTrying(false);
    }
  };

  return (
    <Screen>
      <View style={styles.header}>
        <StatusChip status="unreachable" />
        <GearButton onPress={() => router.push('/settings')} />
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.badge}>
          <Icon name="wifi-off" size={44} color={colors.dangerSoft} />
        </View>
        <Text accessibilityRole="header" style={styles.title}>
          {"Can't reach your Pi"}
        </Text>
        <Text style={styles.lead}>Is it switched on, and is this phone on the same Wi-Fi?</Text>
        <View style={styles.steps}>
          {STEPS.map((step, i) => (
            <View key={i} style={[styles.step, i < STEPS.length - 1 && styles.stepLine]}>
              <View style={styles.number}>
                <Text style={styles.numberText}>{i + 1}</Text>
              </View>
              <Text style={styles.stepText}>{step}</Text>
            </View>
          ))}
        </View>
      </ScrollView>
      <View style={styles.footer}>
        {saved ? (
          <Text style={styles.tried}>
            Last tried <Text style={styles.mono}>{`${saved.host}:${saved.port}`}</Text>
          </Text>
        ) : null}
        <Button label="Try again" onPress={() => void tryAgain()} loading={trying} />
        <Button variant="text" label="Change address" onPress={() => router.push('/settings')} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingLeft: spacing.lg, paddingRight: spacing.sm, paddingTop: spacing.sm },
  content: { alignItems: 'center', paddingHorizontal: 28, paddingTop: 40, gap: spacing.md },
  badge: { width: 104, height: 104, borderRadius: 52, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center', marginBottom: spacing.md },
  title: { fontSize: 30, lineHeight: 35, fontWeight: '700', color: colors.text, textAlign: 'center', letterSpacing: -0.4 },
  lead: { fontSize: 18, lineHeight: 27, color: colors.muted, textAlign: 'center' },
  steps: { alignSelf: 'stretch', marginTop: spacing.lg, borderRadius: radius.lg, backgroundColor: colors.surface },
  step: { flexDirection: 'row', alignItems: 'flex-start', gap: 14, paddingVertical: spacing.lg, paddingHorizontal: 18 },
  stepLine: { borderBottomWidth: 1, borderBottomColor: colors.border },
  number: { width: 28, height: 28, borderRadius: 14, backgroundColor: colors.surfaceHigh, alignItems: 'center', justifyContent: 'center' },
  numberText: { fontSize: 15, fontWeight: '700', color: colors.text },
  stepText: { flex: 1, fontSize: 16, lineHeight: 23, color: colors.text },
  mono: { fontFamily: 'monospace', fontSize: 14, color: colors.text },
  footer: { paddingHorizontal: spacing.xl, paddingBottom: spacing.xl, gap: 10 },
  tried: { ...font.label, fontWeight: '400', color: colors.muted, textAlign: 'center', marginBottom: spacing.xs },
});
