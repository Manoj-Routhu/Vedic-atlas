import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useConnection } from '../state/connection';
import { Icon, type IconName } from './Icon';
import { colors, font } from './theme';

export type TabName = 'look' | 'chat' | 'control';

export const BAR_HEIGHT = 72;

const TABS: { name: TabName; label: string; icon: IconName; scope: string }[] = [
  { name: 'look', label: 'Look', icon: 'eye', scope: 'vision' },
  { name: 'chat', label: 'Veda', icon: 'message-circle', scope: 'chat' },
  { name: 'control', label: 'Control', icon: 'sliders', scope: 'control' },
];

/** The three places in the app. A phone sees only the ones it was allowed when it was paired. */
export function TabBar({ current }: { current: TabName }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const phase = useConnection((s) => s.phase);
  const scopes = useConnection((s) => s.saved?.scopes);
  const shown = TABS.filter((t) => phase === 'demo' || scopes?.includes(t.scope) === true);

  return (
    <View accessibilityRole="tablist" style={[styles.bar, { paddingBottom: insets.bottom, height: BAR_HEIGHT + insets.bottom }]}>
      {shown.map((t) => {
        const on = t.name === current;
        return (
          <Pressable
            key={t.name}
            accessibilityRole="tab"
            accessibilityLabel={t.label}
            accessibilityState={{ selected: on }}
            onPress={() => (on ? undefined : router.replace(`/${t.name}`))}
            style={styles.tab}
          >
            <Icon name={t.icon} size={24} color={on ? colors.accent : colors.muted} />
            <Text style={[styles.label, on && styles.labelOn]}>{t.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.bg },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 4 },
  label: { ...font.caption, fontWeight: '600', color: colors.muted },
  labelOn: { color: colors.accent, fontWeight: '700' },
});
