import Constants from 'expo-constants';
import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { apiErrorFromThrown } from '@/api/errors';
import type { VisionStyle } from '@/api/types';
import { buildDiagnostics } from '@/features/settings/diagnostics';
import { ExpoSpeaker } from '@/speech/expoSpeaker';
import { connectionStore, useConnection } from '@/state/connection';
import { preferencesStore, usePreferences } from '@/state/preferences';
import { Banner } from '@/ui/Banner';
import { Button } from '@/ui/Button';
import { Chips } from '@/ui/Chips';
import { PermissionChips } from '@/ui/PermissionChips';
import { Screen } from '@/ui/Screen';
import { StatusChip, type ChipStatus } from '@/ui/StatusChip';
import { colors, font, radius, spacing, touch } from '@/ui/theme';

const RATES = [
  { value: 0.85, label: 'Slower' },
  { value: 1, label: 'Normal' },
  { value: 1.2, label: 'Faster' },
];
const PITCHES = [
  { value: 0.9, label: 'Lower' },
  { value: 1, label: 'Normal' },
  { value: 1.1, label: 'Higher' },
];
const MODES: { value: VisionStyle; label: string }[] = [
  { value: 'brief', label: 'Describe' },
  { value: 'read_text', label: 'Read text' },
  { value: 'detailed', label: 'Detailed' },
];

/** The value in `options` closest to `current`, so a saved 1.0000001 still shows "Normal". */
const nearest = (options: { value: number }[], current: number) =>
  options.reduce((best, o) => (Math.abs(o.value - current) < Math.abs(best.value - current) ? o : best)).value;

/** Who this phone is paired with and what it may do, how it sounds, what Look starts with, and how to leave. Reached from the gear. */
export default function Settings() {
  const router = useRouter();
  const phase = useConnection((s) => s.phase);
  const saved = useConnection((s) => s.saved);
  const link = useConnection((s) => s.link);
  const prefs = usePreferences((s) => s.prefs);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const [host, setHost] = useState('');
  const [port, setPort] = useState('');
  const [saving, setSaving] = useState(false);
  const [addressError, setAddressError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const chip: ChipStatus = phase === 'demo' ? 'demo' : link === 'connected' ? 'connected' : link === 'unreachable' ? 'unreachable' : 'checking';
  const paired = phase === 'paired' && saved !== null;
  const version = Constants.expoConfig?.version ?? 'dev';

  const forget = () =>
    Alert.alert(
      phase === 'demo' ? 'Leave demo mode?' : 'Forget this Pi?',
      phase === 'demo'
        ? 'You can pair with your Pi any time.'
        : `This phone will forget your Pi. To remove it completely, also run "veda devices revoke ${saved?.deviceId ?? ''}" on your Pi.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: phase === 'demo' ? 'Leave' : 'Forget', style: 'destructive', onPress: () => void connectionStore.getState().forget() },
      ],
    );

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const ms = await connectionStore.getState().testConnection();
      setTestResult({ ok: true, text: `Your Pi answered in ${ms} ms.` });
    } catch (e) {
      setTestResult({ ok: false, text: apiErrorFromThrown(e).userMessage });
    } finally {
      setTesting(false);
    }
  };

  const startEditing = () => {
    setHost(saved?.host ?? '');
    setPort(String(saved?.port ?? 8000));
    setAddressError(null);
    setEditing(true);
  };

  const saveAddress = async () => {
    const portNumber = Number(port);
    if (!Number.isInteger(portNumber)) return setAddressError('The port is a number, like 8000.');
    setSaving(true);
    setAddressError(null);
    try {
      await connectionStore.getState().changeAddress(host, portNumber);
      setEditing(false);
      setTestResult(null);
    } catch (e) {
      setAddressError(apiErrorFromThrown(e).userMessage);
    } finally {
      setSaving(false);
    }
  };

  const copyDiagnostics = async () => {
    await Clipboard.setStringAsync(buildDiagnostics({ appVersion: version, phase, link, saved, prefs }));
    setCopied(true);
  };

  const sample = () => {
    const speaker = new ExpoSpeaker('en-US', () => preferencesStore.getState().prefs);
    speaker.stop();
    speaker.speak('This is how I will sound.', { onStart: () => undefined, onDone: () => undefined, onError: () => undefined });
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Button variant="text" label="Back" onPress={() => (router.canGoBack() ? router.back() : router.replace('/home'))} />
        <StatusChip status={chip} />
        <Text accessibilityRole="header" style={styles.title}>
          {phase === 'demo' ? 'Trying Veda' : 'Settings'}
        </Text>

        {chip === 'unreachable' ? (
          <Banner tone="danger" message="Is it on, and is this phone on the same Wi-Fi?" testID="unreachable-banner" />
        ) : null}

        {phase === 'demo' ? (
          <Banner tone="warn" title="Example answers" message="Nothing here comes from a real Pi, and nothing is sent anywhere." />
        ) : saved ? (
          <Section title="Your Pi" testID="pairing-card">
            <Row label="This phone" value={saved.deviceName} />
            <Row label="Device id" value={saved.deviceId} mono />
            <Row label="Pi address" value={`${saved.host}:${saved.port}`} mono />
            <Text style={styles.cardLabel}>This phone may</Text>
            <PermissionChips scopes={saved.scopes} />

            <Button variant="secondary" label="Test connection" onPress={() => void test()} loading={testing} />
            {testResult ? <Banner tone={testResult.ok ? 'warn' : 'danger'} message={testResult.text} testID="test-result" /> : null}

            {editing ? (
              <View style={styles.form}>
                <Text style={styles.cardLabel}>If the address of your Pi changed, enter the new one. The same pairing is kept.</Text>
                <TextInput
                  testID="address-host"
                  accessibilityLabel="Pi address"
                  value={host}
                  onChangeText={setHost}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  placeholder="192.168.1.20"
                  placeholderTextColor={colors.muted}
                  style={styles.input}
                />
                <TextInput
                  testID="address-port"
                  accessibilityLabel="Port"
                  value={port}
                  onChangeText={setPort}
                  keyboardType="number-pad"
                  placeholder="8000"
                  placeholderTextColor={colors.muted}
                  style={styles.input}
                />
                {addressError ? <Text style={styles.problem} testID="address-error">{addressError}</Text> : null}
                <View style={styles.buttons}>
                  <View style={styles.flex}>
                    <Button variant="secondary" label="Cancel" onPress={() => setEditing(false)} />
                  </View>
                  <View style={styles.flex}>
                    <Button label="Save address" onPress={() => void saveAddress()} loading={saving} />
                  </View>
                </View>
              </View>
            ) : paired ? (
              <Button variant="text" label="Change address" onPress={startEditing} />
            ) : null}
          </Section>
        ) : null}

        <Section title="Voice">
          <Text style={styles.cardLabel}>Speed</Text>
          <Chips label="Speed" options={RATES} selected={nearest(RATES, prefs.speechRate)} onSelect={(v) => void preferencesStore.getState().update({ speechRate: v })} />
          <Text style={styles.cardLabel}>Pitch</Text>
          <Chips label="Pitch" options={PITCHES} selected={nearest(PITCHES, prefs.speechPitch)} onSelect={(v) => void preferencesStore.getState().update({ speechPitch: v })} />
          <Button variant="secondary" label="Hear a sample" onPress={sample} />
        </Section>

        <Section title="Look">
          <Text style={styles.cardLabel}>Starts in</Text>
          <Chips label="Starts in" options={MODES} selected={prefs.lookStyle} onSelect={(v) => void preferencesStore.getState().update({ lookStyle: v })} />
          <Pressable
            accessibilityRole="switch"
            accessibilityLabel="Vibration"
            accessibilityState={{ checked: prefs.haptics }}
            onPress={() => void preferencesStore.getState().update({ haptics: !prefs.haptics })}
            style={styles.switchRow}
          >
            <Text style={styles.switchText}>Vibration</Text>
            <View style={[styles.track, prefs.haptics && styles.trackOn]}>
              <View style={[styles.knob, prefs.haptics && styles.knobOn]} />
            </View>
          </Pressable>
        </Section>

        <Section title="Privacy">
          <Text style={styles.body}>
            Photos go only to your Pi, over your home Wi-Fi, and are described there. This phone does not keep them. Questions you speak are turned into text on this phone.
          </Text>
        </Section>

        <Section title="About">
          <Row label="App version" value={version} />
          <Button variant="secondary" label="Copy diagnostics" onPress={() => void copyDiagnostics()} accessibilityHint="Copies details that help find a problem. It never includes your pairing secret or photos." />
          {copied ? <Text style={styles.cardLabel} accessibilityLiveRegion="polite">Copied.</Text> : null}
        </Section>

        <Button variant="danger" label={phase === 'demo' ? 'Leave demo mode' : 'Forget this Pi'} onPress={forget} />
      </ScrollView>
    </Screen>
  );
}

function Section({ title, children, testID }: { title: string; children: React.ReactNode; testID?: string }) {
  return (
    <View style={styles.card} testID={testID}>
      <Text accessibilityRole="header" style={styles.cardTitle}>
        {title}
      </Text>
      {children}
    </View>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={styles.row} accessible accessibilityLabel={`${label}: ${value}`}>
      <Text style={styles.cardLabel}>{label}</Text>
      <Text style={[styles.value, mono && styles.mono]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.xl, gap: spacing.lg, paddingBottom: spacing.xxl },
  flex: { flex: 1 },
  title: { ...font.title, color: colors.text },
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.lg, gap: spacing.md },
  cardTitle: { ...font.heading, color: colors.text },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: spacing.md },
  cardLabel: { ...font.label, color: colors.muted },
  body: { ...font.body, color: colors.textSoft },
  value: { ...font.body, color: colors.text, flexShrink: 1, textAlign: 'right' },
  mono: { fontFamily: 'monospace', fontSize: 15 },
  form: { gap: spacing.md },
  input: { minHeight: touch.button, borderRadius: radius.pill, backgroundColor: colors.surfaceHigh, color: colors.text, paddingHorizontal: spacing.lg, ...font.body },
  problem: { ...font.caption, color: colors.dangerSoft },
  buttons: { flexDirection: 'row', gap: spacing.md },
  switchRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: touch.min },
  switchText: { ...font.body, color: colors.text },
  track: { width: 52, height: 30, borderRadius: 15, backgroundColor: colors.surfaceHigh, justifyContent: 'center', padding: 3 },
  trackOn: { backgroundColor: colors.accent },
  knob: { width: 24, height: 24, borderRadius: 12, backgroundColor: colors.muted },
  knobOn: { backgroundColor: colors.onAccent, alignSelf: 'flex-end' },
});
