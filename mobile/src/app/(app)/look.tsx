import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Clipboard from 'expo-clipboard';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useIsFocused, useRouter } from 'expo-router';
import { useEffect } from 'react';
import { AppState, Linking, StyleSheet, Text, View } from 'react-native';
import { useStore } from 'zustand';

import { cameraRef, lookStore } from '@/features/look/lookRuntime';
import { LookView } from '@/features/look/LookView';
import { isWorking } from '@/features/look/lookStore';
import { useConnection } from '@/state/connection';
import { Button } from '@/ui/Button';
import { Screen } from '@/ui/Screen';
import type { ChipStatus } from '@/ui/StatusChip';
import { colors, font, spacing } from '@/ui/theme';

const KEEP_AWAKE_TAG = 'look';
/** How long the app may be out of view before Look stops listening and speaking. */
const LEAVE_GRACE_MS = 1500;

export default function Look() {
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const phase = useConnection((s) => s.phase);
  const link = useConnection((s) => s.link);
  const working = isWorking(useStore(lookStore, (s) => s.phase));

  // Leaving the app mid-answer stops the voice and the request; the text stays and offers to ask again.
  // A brief blip (the speech service or a system dialog taking focus for a moment) must not close the microphone,
  // so only leaving for longer counts.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sub = AppState.addEventListener('change', (state) => {
      clearTimeout(timer);
      if (state === 'active') return;
      timer = setTimeout(() => {
        if (AppState.currentState !== 'active') lookStore.getState().interrupt('the app went to the background');
      }, LEAVE_GRACE_MS);
    });
    return () => {
      clearTimeout(timer);
      sub.remove();
    };
  }, []);

  // The screen stays on while a photo is being described.
  useEffect(() => {
    if (!working) return;
    void activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => undefined);
    return () => void deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => undefined);
  }, [working]);

  // Screens under Home or Settings stay mounted, so this one must let go of the camera and the voice when it is left.
  const focused = useIsFocused();
  useEffect(() => {
    if (!focused) lookStore.getState().interrupt('you left the Look screen');
  }, [focused]);

  const granted = permission?.granted === true;
  const chip: ChipStatus = phase === 'demo' ? 'demo' : link === 'connected' ? 'connected' : link === 'unreachable' ? 'unreachable' : 'checking';

  const preview = granted ? (
    focused ? <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing="back" accessibilityLabel="Camera preview" /> : null
  ) : (
    <View style={styles.permission}>
      <Text style={styles.permissionTitle}>Veda needs the camera</Text>
      <Text style={styles.permissionBody}>Photos are described on your Pi and are never saved on this phone.</Text>
      {permission && !permission.canAskAgain ? (
        <Button label="Open settings" onPress={() => void Linking.openSettings()} />
      ) : (
        <Button label="Allow camera" onPress={() => void requestPermission()} />
      )}
    </View>
  );

  return (
    <Screen>
      <LookView
        store={lookStore}
        preview={preview}
        canShoot={granted}
        micAvailable
        link={chip}
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/home'))}
        onSettings={() => router.push('/settings')}
        onCopy={(text) => void Clipboard.setStringAsync(text)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  permission: { flex: 1, padding: spacing.xl, gap: spacing.md, justifyContent: 'center' },
  permissionTitle: { ...font.heading, color: colors.text },
  permissionBody: { ...font.body, color: colors.textSoft },
});
