import { SplashScreen, Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { connectionStore, useConnection } from '@/state/connection';
import { preferencesStore } from '@/state/preferences';
import { colors } from '@/ui/theme';

SplashScreen.preventAutoHideAsync(); // keep the splash up until we know whether this phone is already paired

export default function RootLayout() {
  const phase = useConnection((s) => s.phase);

  useEffect(() => {
    void connectionStore.getState().load();
    void preferencesStore.getState().load();
  }, []);

  useEffect(() => {
    if (phase !== 'loading') SplashScreen.hide();
  }, [phase]);

  if (phase === 'loading') return null;
  const inApp = phase === 'paired' || phase === 'demo';

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg }, animation: 'fade' }}>
        <Stack.Protected guard={!inApp}>
          <Stack.Screen name="(pair)" />
        </Stack.Protected>
        <Stack.Protected guard={inApp}>
          <Stack.Screen name="(app)" />
        </Stack.Protected>
      </Stack>
    </SafeAreaProvider>
  );
}
