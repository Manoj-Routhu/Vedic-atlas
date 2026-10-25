import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, font, radius, spacing, touch } from './theme';

export type ChipOption<T extends string | number> = { value: T; label: string };

type Props<T extends string | number> = {
  /** Read aloud with each option, such as "Speed: Faster". */
  label: string;
  options: ChipOption<T>[];
  selected: T | null;
  onSelect: (value: T) => void;
  disabled?: boolean;
};

/** A row of choices where exactly one is picked (a radio group made of pills). */
export function Chips<T extends string | number>({ label, options, selected, onSelect, disabled = false }: Props<T>) {
  return (
    <View style={styles.row} accessibilityRole="radiogroup">
      {options.map((o) => {
        const on = o.value === selected;
        return (
          <Pressable
            key={String(o.value)}
            accessibilityRole="radio"
            accessibilityLabel={`${label}: ${o.label}`}
            accessibilityState={{ selected: on, disabled }}
            disabled={disabled}
            onPress={() => onSelect(o.value)}
            style={[styles.chip, on && styles.on]}
          >
            <Text style={[styles.text, on && styles.textOn]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: { minHeight: touch.min, paddingHorizontal: spacing.lg, borderRadius: radius.pill, backgroundColor: colors.surfaceHigh, alignItems: 'center', justifyContent: 'center' },
  on: { backgroundColor: colors.accent },
  text: { ...font.label, color: colors.text },
  textOn: { color: colors.onAccent },
});
