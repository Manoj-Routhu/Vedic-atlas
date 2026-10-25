import { Stack } from 'expo-router';

import { useLinkMonitor } from '@/state/useLinkMonitor';
import { colors } from '@/ui/theme';

export default function AppLayout() {
  useLinkMonitor(); // keeps the "Pi connected" chip honest while a real Pi is paired
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }} />;
}
