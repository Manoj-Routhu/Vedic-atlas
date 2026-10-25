import { useRouter } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { connectionStore, useConnection } from '@/state/connection';
import { Banner } from '@/ui/Banner';
import { Button } from '@/ui/Button';
import { Screen } from '@/ui/Screen';
import { colors, font, radius, spacing } from '@/ui/theme';

export default function Welcome() {
  const router = useRouter();
  const notice = useConnection((s) => s.notice);

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {notice === 'removed' ? (
          <Banner
            tone="warn"
            title="This phone was removed from Veda"
            message="Pair it again to carry on."
            onDismiss={() => connectionStore.getState().dismissNotice()}
            testID="removed-notice"
          />
        ) : null}

        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.logo}>
          <View style={styles.logoDot} />
        </View>

        <Text accessibilityRole="header" style={styles.title}>
          See and talk to Veda from your phone.
        </Text>
        <Text style={styles.body}>Point the camera at something and hear what it is. Ask Veda things. Everything stays on your home Wi-Fi.</Text>

        <View style={styles.commands}>
          <Text style={styles.commandsLabel}>First, on your Pi, run</Text>
          <Text selectable style={styles.mono}>
            {'veda server --lan\nveda pair'}
          </Text>
        </View>

        <View style={styles.actions}>
          <Button label="Scan the code on your Pi" onPress={() => router.push('/scan')} />
          <Button variant="text" label="Enter the code by hand" onPress={() => router.push('/manual')} />
          <Button
            variant="secondary"
            label="Try without a Pi"
            accessibilityHint="Opens the app with example answers. Nothing is sent anywhere."
            onPress={() => connectionStore.getState().enterDemo()}
          />
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.xl, paddingTop: spacing.xxl, gap: spacing.lg, flexGrow: 1 },
  logo: { width: 72, height: 72, borderRadius: 36, borderWidth: 4, borderColor: colors.accent, alignItems: 'center', justifyContent: 'center', marginTop: spacing.lg },
  logoDot: { width: 28, height: 28, borderRadius: 14, backgroundColor: colors.text },
  title: { fontSize: 34, lineHeight: 40, fontWeight: '700', color: colors.text, letterSpacing: -0.5 },
  body: { ...font.body, fontSize: 18, lineHeight: 27, color: colors.muted },
  commands: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.lg, gap: spacing.sm },
  commandsLabel: { ...font.label, color: colors.muted },
  mono: { fontFamily: 'monospace', fontSize: 16, lineHeight: 26, color: colors.text },
  actions: { marginTop: 'auto', paddingTop: spacing.xl, gap: spacing.md },
});
