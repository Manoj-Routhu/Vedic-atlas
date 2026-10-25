import { useRouter } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { DEFAULT_PORT, validatePairForm, type PairErrors } from '@/features/pairing/validate';
import { usePairAction } from '@/features/pairing/usePairAction';
import { Banner } from '@/ui/Banner';
import { Button } from '@/ui/Button';
import { Screen } from '@/ui/Screen';
import { TextField } from '@/ui/TextField';
import { colors, font, spacing, touch } from '@/ui/theme';
import { defaultDeviceName } from '@/util/device';

export default function Manual() {
  const router = useRouter();
  const { busy, error, run, clearError } = usePairAction();
  const [code, setCode] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState(DEFAULT_PORT);
  const [name, setName] = useState(defaultDeviceName());
  const [errors, setErrors] = useState<PairErrors>({});

  const submit = async () => {
    const result = validatePairForm({ code, host, port, name });
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    await run(result.value);
  };
  const edited = <T,>(set: (v: T) => void, field?: keyof PairErrors) => (v: T) => {
    set(v);
    if (error) clearError();
    if (field && errors[field]) setErrors((e) => ({ ...e, [field]: undefined }));
  };

  return (
    <Screen>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.flex}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} style={styles.back}>
            <Text style={styles.backText}>‹ Back</Text>
          </Pressable>

          <Text accessibilityRole="header" style={styles.title}>
            Enter the code
          </Text>
          <Text style={styles.body}>
            Run <Text style={styles.mono}>veda pair</Text> on your Pi. The code works for 2 minutes.
          </Text>

          {error ? <Banner tone="danger" message={error.userMessage} testID="pair-error" /> : null}

          <View style={styles.form}>
            <TextField
              testID="field-code"
              label="Pairing code"
              mono
              value={code}
              onChangeText={edited(setCode, 'code')}
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={20}
              error={errors.code}
            />
            <TextField
              testID="field-host"
              label="Pi address"
              value={host}
              onChangeText={edited(setHost, 'host')}
              keyboardType="url"
              autoCapitalize="none"
              autoCorrect={false}
              helper="Shown by `veda pair`, like 192.168.1.20"
              error={errors.host}
            />
            <TextField testID="field-port" label="Port" value={port} onChangeText={edited(setPort, 'port')} keyboardType="number-pad" maxLength={5} error={errors.port} />
            <TextField
              testID="field-name"
              label="Name this phone"
              value={name}
              onChangeText={edited(setName)}
              maxLength={40}
              helper="Shown on the Pi when you list paired phones."
            />
          </View>

          <Text style={styles.note}>Make sure this phone is on the same Wi-Fi as your Pi.</Text>
          <Button label="Pair this phone" onPress={submit} loading={busy} testID="pair-submit" />
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: spacing.xl, gap: spacing.lg },
  back: { minHeight: touch.min, justifyContent: 'center', alignSelf: 'flex-start' },
  backText: { ...font.body, color: colors.text },
  title: { fontSize: 32, lineHeight: 38, fontWeight: '700', color: colors.text },
  body: { ...font.body, color: colors.muted },
  mono: { fontFamily: 'monospace', color: colors.text },
  form: { gap: spacing.lg, marginTop: spacing.sm },
  note: { ...font.label, fontWeight: '400', color: colors.muted, textAlign: 'center' },
});
