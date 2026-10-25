import { useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useConnection } from '@/state/connection';
import { Icon } from '@/ui/Icon';
import { Screen } from '@/ui/Screen';
import { StatusChip, type ChipStatus } from '@/ui/StatusChip';
import { Tile } from '@/ui/Tile';
import { VedaMark } from '@/ui/VedaMark';
import { colors, font, radius, spacing, touch } from '@/ui/theme';

/** Where the app opens once paired: pick what to do. Each tile appears only if this phone was allowed it. */
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
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <View style={styles.brand}>
            <VedaMark size={44} />
            <Text accessibilityRole="header" style={styles.wordmark}>
              Veda
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Settings"
            onPress={() => router.push('/settings')}
            style={({ pressed }) => [styles.gear, pressed && styles.gearPressed]}
          >
            <Icon name="settings-outline" size={24} color={colors.textSoft} />
          </Pressable>
        </View>

        <StatusChip status={chip} />
        <Text style={styles.lead}>Point the camera at something and hear what it is.</Text>

        {mayLook ? (
          <Tile
            hero
            icon="camera"
            label="Look"
            title="Look"
            subtitle="Take a photo and hear what is in it."
            hint="Opens the camera to describe things out loud"
            onPress={() => router.push('/look')}
          />
        ) : null}

        {mayChat || mayControl ? (
          <View style={styles.row}>
            {mayChat ? (
              <Tile
                icon="chatbubble-ellipses-outline"
                label="Chat with Veda"
                title="Chat"
                subtitle="Ask, and approve what Veda wants to do."
                hint="Type to Veda, and approve its actions"
                onPress={() => router.push('/chat')}
              />
            ) : null}
            {mayControl ? (
              <Tile
                icon="options-outline"
                label="Control"
                title="Control"
                subtitle="Mute, tasks, reminders, personality."
                hint="See how Veda is doing, and a few switches"
                onPress={() => router.push('/control')}
              />
            ) : null}
          </View>
        ) : null}

        {!mayLook && !mayChat && !mayControl ? (
          <Text style={styles.lead}>This phone was not given any permissions. Pair it again on your Pi to change that.</Text>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.xl, gap: spacing.lg, paddingBottom: spacing.xxl },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  brand: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  wordmark: { ...font.title, color: colors.text, letterSpacing: 0.5 },
  gear: { width: touch.button, height: touch.button, borderRadius: radius.pill, backgroundColor: colors.surfaceRaised, borderWidth: 1, borderColor: colors.hairline, alignItems: 'center', justifyContent: 'center' },
  gearPressed: { transform: [{ scale: 0.95 }], opacity: 0.9 },
  lead: { ...font.body, color: colors.textSoft },
  row: { flexDirection: 'row', gap: spacing.md },
});
