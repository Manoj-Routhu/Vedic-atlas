import { Stack } from 'expo-router';

import { colors } from '@/ui/theme';

export const unstable_settings = { initialRouteName: 'welcome' };

export default function PairLayout() {
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }} />;
}
