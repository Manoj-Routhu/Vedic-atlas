import { useId } from 'react';
import { StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';

import { colors, font, radius, spacing } from './theme';

type Props = Pick<TextInputProps, 'value' | 'onChangeText' | 'keyboardType' | 'autoCapitalize' | 'autoCorrect' | 'maxLength' | 'returnKeyType' | 'onSubmitEditing' | 'editable'> & {
  label: string;
  helper?: string;
  error?: string | null;
  /** Large monospaced text, for the pairing code. */
  mono?: boolean;
  testID?: string;
};

export function TextField({ label, helper, error, mono = false, testID, ...input }: Props) {
  const id = useId();
  return (
    <View style={styles.wrap}>
      <Text nativeID={id} style={styles.label}>
        {label}
      </Text>
      <TextInput
        testID={testID}
        accessibilityLabel={label}
        accessibilityHint={error ?? helper}
        aria-invalid={Boolean(error)}
        placeholderTextColor={colors.muted}
        selectionColor={colors.accent}
        style={[styles.input, mono && styles.mono, error ? styles.inputError : null]}
        {...input}
      />
      {error ? (
        <Text accessibilityLiveRegion="polite" style={styles.error}>
          {error}
        </Text>
      ) : helper ? (
        <Text style={styles.helper}>{helper}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.sm },
  label: { ...font.label, color: colors.text, fontSize: 15 },
  input: {
    minHeight: 56,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    backgroundColor: colors.surface,
    color: colors.text,
    fontSize: 17,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  mono: { fontFamily: 'monospace', fontSize: 26, letterSpacing: 3, minHeight: 64 },
  inputError: { borderColor: colors.dangerSoft },
  error: { ...font.label, color: colors.dangerSoft },
  helper: { ...font.label, fontWeight: '400', color: colors.muted },
});
