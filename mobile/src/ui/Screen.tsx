import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors } from './theme';

type Props = {
  children: ReactNode;
  /** Sides to keep clear of the status bar / navigation bar. Android 16 draws the app edge to edge, so every screen needs this. */
  edges?: ('top' | 'bottom')[];
  style?: StyleProp<ViewStyle>;
};

export function Screen({ children, edges = ['top', 'bottom'], style }: Props) {
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[
        styles.root,
        { paddingTop: edges.includes('top') ? insets.top : 0, paddingBottom: edges.includes('bottom') ? insets.bottom : 0 },
        style,
      ]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
});
