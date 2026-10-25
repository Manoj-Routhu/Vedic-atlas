import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { usePairAction } from '@/features/pairing/usePairAction';
import { Banner } from '@/ui/Banner';
import { Button } from '@/ui/Button';
import { Screen } from '@/ui/Screen';
import { colors, font, radius, spacing, touch } from '@/ui/theme';
import { defaultDeviceName } from '@/util/device';
import { parsePairingUri } from '@/util/qr';

const NOT_OURS = "That isn't a Veda pairing code. Scan the one shown by `veda pair` on your Pi.";

export default function Scan() {
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const { busy, error, run } = usePairAction();
  const [hint, setHint] = useState<string | null>(null);
  const handled = useRef(false);

  const onScanned = useCallback(
    async ({ data }: { data: string }) => {
      if (handled.current) return; // the camera reports the same code many times a second
      const target = parsePairingUri(data);
      if (!target) {
        setHint(NOT_OURS);
        return;
      }
      handled.current = true;
      setHint(null);
      const ok = await run({ ...target, deviceName: defaultDeviceName() });
      if (!ok) handled.current = false; // let them try again (or scan a fresh code)
    },
    [run],
  );

  const byHand = <Button variant="text" label="Enter the code by hand" onPress={() => router.replace('/manual')} />;

  // 1) waiting for the permission state
  if (!permission) return <Screen><View style={styles.center} /></Screen>;

  // 2) no camera permission yet (or refused): explain why, and always offer the keyboard route
  if (!permission.granted) {
    return (
      <Screen>
        <View style={styles.center}>
          <Text accessibilityRole="header" style={styles.title}>
            Scan the code on your Pi
          </Text>
          <Text style={styles.body}>Veda uses the camera only to read the pairing code. Nothing is saved.</Text>
          {permission.canAskAgain ? (
            <Button label="Allow the camera" onPress={() => void requestPermission()} />
          ) : (
            <>
              <Text style={styles.body}>The camera is switched off for Veda. You can turn it on in Settings.</Text>
              <Button label="Open Settings" onPress={() => void Linking.openSettings()} />
            </>
          )}
          {byHand}
        </View>
      </Screen>
    );
  }

  // 3) scanning
  return (
    <Screen edges={['top']}>
      <View style={styles.flex}>
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={busy ? undefined : onScanned}
        />
        <View style={styles.overlay} pointerEvents="box-none">
          <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} style={styles.back}>
            <Text style={styles.backText}>‹ Back</Text>
          </Pressable>
          <View style={styles.frame} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />
          <View style={styles.panel}>
            {error ? <Banner tone="danger" message={error.userMessage} testID="scan-error" /> : null}
            {!error && hint ? <Banner tone="warn" message={hint} testID="scan-hint" /> : null}
            <Text accessibilityLiveRegion="polite" style={styles.instruction}>
              {busy ? 'Pairing…' : 'Point at the code on your Pi'}
            </Text>
            {byHand}
          </View>
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { flex: 1, padding: spacing.xl, gap: spacing.lg, justifyContent: 'center' },
  title: { fontSize: 30, lineHeight: 36, fontWeight: '700', color: colors.text },
  body: { ...font.body, color: colors.muted },
  overlay: { ...StyleSheet.absoluteFill, justifyContent: 'space-between', padding: spacing.lg },
  back: { minHeight: touch.min, justifyContent: 'center', alignSelf: 'flex-start', paddingHorizontal: spacing.md, borderRadius: radius.pill, backgroundColor: 'rgba(14,17,22,0.7)' },
  backText: { ...font.body, color: colors.text },
  frame: { alignSelf: 'center', width: 240, height: 240, borderRadius: radius.xl, borderWidth: 3, borderColor: colors.accent },
  panel: { gap: spacing.md, padding: spacing.lg, borderRadius: radius.lg, backgroundColor: 'rgba(14,17,22,0.85)' },
  instruction: { ...font.heading, color: colors.text, textAlign: 'center' },
});
