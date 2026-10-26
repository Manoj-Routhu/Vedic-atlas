import { Stack } from 'expo-router';

import { useLinkMonitor } from '@/state/useLinkMonitor';
import { colors } from '@/ui/theme';

// Look, Veda and Control are the three places in the app (switched with the bar at the bottom of each); Settings opens over them.
export const unstable_settings = { anchor: 'look' };

export default function AppLayout() {
  useLinkMonitor(); // keeps the "Pi connected" chip honest while a real Pi is paired
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg }, animation: 'fade' }} />;
}
