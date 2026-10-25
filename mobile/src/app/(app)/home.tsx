import { useRouter } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { useConnection } from '@/state/connection';
import { Button } from '@/ui/Button';
import { Screen } from '@/ui/Screen';
import { StatusChip, type ChipStatus } from '@/ui/StatusChip';
import { colors, font, spacing } from '@/ui/theme';

/** Where the app opens once paired: pick what to do. Each button appears only if this phone was allowed it. */
export default function Home() {
  const router = useRouter();
  const phase = useConnection((s) => s.phase);
  const link = useConnection((s) => s.link);
  const scopes = useConnection((s) => s.saved?.scopes);
  const mayLook = phase === 'demo' || scopes?.includes('vision') === true;
  const mayChat = phase === 'demo' || scopes?.includes('chat') === true;
  const mayControl = phase === 'demo' || scopes?.includes('control') === true;
  const chip: ChipStatus = phase === 'demo' ? 'demo' : link === 'connected' ? 'connected' : link === 'unreachable' ? 'unreachable' : 'checking';

  return (
    <Screen>
      <View style={styles.content}>
        <StatusChip status={chip} />
        <Text accessibilityRole="header" style={styles.title}>
          Veda
        </Text>
        <Text style={styles.body}>Point the camera at something and hear what it is.</Text>
        {mayLook ? <Button label="Look" onPress={() => router.push('/look')} accessibilityHint="Opens the camera to describe things out loud" /> : null}
        {mayChat ? <Button label="Chat with Veda" onPress={() => router.push('/chat')} accessibilityHint="Type to Veda, and approve its actions" /> : null}
        {mayControl ? <Button label="Control" onPress={() => router.push('/control')} accessibilityHint="See how Veda is doing, and a few switches" /> : null}
        {!mayLook && !mayChat && !mayControl ? <Text style={styles.body}>This phone was not given any permissions. Pair it again on your Pi to change that.</Text> : null}
        <Button variant="secondary" label="Settings" onPress={() => router.push('/settings')} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.xl, gap: spacing.lg },
  title: { ...font.title, color: colors.text },
  body: { ...font.body, color: colors.textSoft },
});
