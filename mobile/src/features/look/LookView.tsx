import { useRef, useState, type ReactNode } from 'react';
import { Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useStore } from 'zustand';

import type { VisionStyle } from '../../api/types';
import { Banner } from '../../ui/Banner';
import { Button } from '../../ui/Button';
import { StatusChip, type ChipStatus } from '../../ui/StatusChip';
import { colors, font, radius, spacing, touch } from '../../ui/theme';
import { isWorking, type LookStore } from './lookStore';

const MODES: { style: VisionStyle; label: string }[] = [
  { style: 'brief', label: 'Describe' },
  { style: 'read_text', label: 'Read text' },
  { style: 'detailed', label: 'Detailed' },
];

type Props = {
  store: LookStore;
  /** The live camera (or a card asking for permission) shown while no photo is on screen. */
  preview: ReactNode;
  /** True when there is a camera to shoot with; the shutter is disabled otherwise. */
  canShoot: boolean;
  link: ChipStatus;
  /** Whether the phone can turn speech into text (shows the microphone). */
  micAvailable?: boolean;
  onBack: () => void;
  onSettings: () => void;
  onCopy: (text: string) => void;
};

/** A press shorter than this is a tap (start listening, tap again to stop); longer is hold-to-talk (let go to ask). */
export const HOLD_MS = 450;

/** The Look screen: live camera or frozen photo, the answer as it is spoken, and one big shutter that becomes Stop. */
export function LookView({ store, preview, canShoot, link, micAvailable = false, onBack, onSettings, onCopy }: Props) {
  const s = useStore(store);
  const working = isWorking(s.phase);
  const hasAnswer = s.sentences.length > 0 || s.partial !== '';
  const chip: ChipStatus = s.waking ? 'waking' : link;
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState('');
  const canAsk = Boolean(s.photo) && !working;
  const questionText = s.listening ? s.heard || 'Listening…' : s.question;
  const pressedAt = useRef(0);
  const micPressIn = () => {
    if (s.listening) return s.finishListening(); // second tap of tap-to-talk
    pressedAt.current = Date.now();
    void s.startListening();
  };
  const micPressOut = () => {
    if (s.listening && Date.now() - pressedAt.current >= HOLD_MS) s.finishListening(); // held: let go asks. A tap keeps listening.
  };
  const send = () => {
    const q = typed.trim();
    if (!q) return;
    setTyped('');
    setTyping(false);
    void s.ask(q);
  };
  const fullText = [...s.sentences, s.partial].filter(Boolean).join(' ');

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" accessibilityLabel="Home" onPress={onBack} style={styles.back} hitSlop={8}>
          <Text style={styles.backText}>‹ Home</Text>
        </Pressable>
        <StatusChip status={chip} />
        <Pressable accessibilityRole="button" accessibilityLabel="Settings" onPress={onSettings} style={styles.gear} hitSlop={8}>
          <Text style={styles.gearText}>⚙</Text>
        </Pressable>
      </View>

      <View style={[styles.stage, typing && styles.stageCompact]}>
        {s.photo ? (
          <Image source={{ uri: s.photo.uri }} style={styles.photo} resizeMode="cover" accessibilityLabel="The photo you took" />
        ) : (
          preview
        )}
      </View>

      <View style={styles.modes} accessibilityRole="radiogroup">
        {MODES.map((m) => {
          const selected = s.style === m.style;
          return (
            <Pressable
              key={m.style}
              accessibilityRole="radio"
              accessibilityLabel={m.label}
              accessibilityState={{ selected, disabled: working }}
              disabled={working}
              onPress={() => void s.setStyle(m.style)}
              style={[styles.mode, selected && styles.modeOn]}
            >
              <Text style={[styles.modeText, selected && styles.modeTextOn]}>{m.label}</Text>
            </Pressable>
          );
        })}
      </View>

      <ScrollView style={styles.answerBox} contentContainerStyle={styles.answerContent} keyboardShouldPersistTaps="handled">
        {questionText ? (
          <View style={[styles.question, s.listening && styles.questionLive]} accessibilityLiveRegion="polite" testID="question">
            <Text style={styles.questionText}>{questionText}</Text>
          </View>
        ) : null}
        {s.phase === 'capturing' ? <Text style={styles.status}>Taking the photo…</Text> : null}
        {s.phase === 'uploading' ? <Text style={styles.status}>Sending to your Pi…</Text> : null}
        {s.phase === 'looking' && !hasAnswer ? (
          <Text style={styles.status} accessibilityLiveRegion="polite">
            {s.waking ? 'Starting up. This takes a few seconds.' : s.slow ? 'Still looking…' : 'Looking…'}
          </Text>
        ) : null}

        {hasAnswer ? (
          <Text style={styles.answer} accessibilityLiveRegion="polite" testID="answer">
            {s.sentences.map((sentence, i) => (
              <Text key={i} onPress={() => s.hearSentence(i)} style={s.speakingIndex === i ? styles.speaking : undefined}>
                {sentence}{' '}
              </Text>
            ))}
            {s.partial}
          </Text>
        ) : null}

        {s.phase === 'answered' && !s.done ? <Text style={styles.note}>{s.interrupted ? 'Paused when you left the app.' : 'Stopped.'}</Text> : null}
        {s.speechUnavailable ? <Banner tone="warn" message="This phone can't speak right now. The answer is shown here." /> : null}
        {s.error ? <Banner tone="danger" message={s.error.userMessage} testID="look-error" /> : null}

        {hasAnswer && !working ? (
          <View style={styles.actions}>
            <Button variant="secondary" label="Hear again" onPress={s.hearAgain} />
            <Button variant="secondary" label="Copy" onPress={() => onCopy(fullText)} />
          </View>
        ) : null}
        {canAsk && !typing ? <Button variant="text" label="Type a question" onPress={() => setTyping(true)} /> : null}
        {s.error && s.photo && !working ? <Button variant="secondary" label="Try again" onPress={() => void s.ask(s.question)} /> : null}
      </ScrollView>

      {s.micMessage ? <Banner tone="warn" message={s.micMessage} onDismiss={() => store.setState({ micMessage: null })} testID="mic-message" /> : null}
      {canAsk && typing ? (
        <View style={styles.typeBar}>
          <TextInput
            testID="typed-question"
            accessibilityLabel="Your question"
            placeholder="Ask about this photo"
            placeholderTextColor={colors.muted}
            value={typed}
            onChangeText={setTyped}
            onSubmitEditing={send}
            returnKeyType="send"
            autoFocus
            style={styles.input}
          />
          <Button label="Ask" onPress={send} disabled={typed.trim() === ''} />
          <Button variant="text" label="Cancel" onPress={() => { setTyped(''); setTyping(false); }} />
        </View>
      ) : (
      <View style={styles.bar}>
        {s.photo && !working ? <Button variant="text" label="Retake" onPress={s.retake} /> : <View style={styles.barSide} />}
        <Pressable
          testID="shutter"
          accessibilityRole="button"
          accessibilityLabel={working ? 'Stop' : 'Take a photo'}
          accessibilityHint={working ? undefined : 'Takes a picture and describes it out loud'}
          accessibilityState={{ disabled: !working && !canShoot }}
          disabled={!working && !canShoot}
          onPress={() => (working ? s.stop() : void s.capture())}
          style={[styles.shutter, working && styles.shutterStop, !working && !canShoot && styles.shutterOff]}
        >
          <View style={working ? styles.stopSquare : styles.ring} />
        </Pressable>
        {micAvailable && canAsk ? (
          <View style={styles.barSide}>
            <Pressable
              testID="mic"
              accessibilityRole="button"
              accessibilityLabel={s.listening ? 'Stop listening' : 'Ask about this'}
              accessibilityHint="Tap, speak your question, and pause. Or hold, speak, and let go."
              accessibilityActions={[{ name: 'activate' }]}
              onAccessibilityAction={() => (s.listening ? s.finishListening() : void s.startListening())}
              onPressIn={micPressIn}
              onPressOut={micPressOut}
              style={[styles.mic, s.listening && styles.micLive]}
            >
              <Text style={styles.micGlyph}>🎤</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.barSide} />
        )}
      </View>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: spacing.lg, gap: spacing.md },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: spacing.sm },
  back: { minHeight: touch.min, justifyContent: 'center', paddingRight: spacing.sm },
  backText: { ...font.button, color: colors.text },
  gear: { width: touch.min, height: touch.min, alignItems: 'center', justifyContent: 'center' },
  gearText: { fontSize: 26, color: colors.text },
  stage: { aspectRatio: 4 / 3, borderRadius: radius.lg, overflow: 'hidden', backgroundColor: colors.surface },
  stageCompact: { aspectRatio: undefined, height: 96 },
  photo: { flex: 1 },
  modes: { flexDirection: 'row', gap: spacing.sm },
  mode: { flex: 1, minHeight: touch.min, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface },
  modeOn: { backgroundColor: colors.accent },
  modeText: { ...font.label, color: colors.text },
  modeTextOn: { color: colors.onAccent },
  answerBox: { flex: 1 },
  answerContent: { gap: spacing.md, paddingBottom: spacing.md },
  status: { ...font.body, color: colors.muted },
  answer: { ...font.answer, color: colors.text },
  speaking: { backgroundColor: colors.highlight },
  note: { ...font.caption, color: colors.muted },
  actions: { flexDirection: 'row', gap: spacing.md },
  bar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingBottom: spacing.md },
  barSide: { width: 96, alignItems: 'flex-end' },
  mic: { width: touch.mic, height: touch.mic, borderRadius: touch.mic / 2, backgroundColor: colors.surfaceHigh, alignItems: 'center', justifyContent: 'center' },
  micLive: { backgroundColor: colors.accent },
  micGlyph: { fontSize: 28 },
  question: { alignSelf: 'flex-start', backgroundColor: colors.surfaceHigh, borderRadius: radius.lg, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  questionLive: { borderWidth: 2, borderColor: colors.accent },
  questionText: { ...font.body, color: colors.text },
  typeBar: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingBottom: spacing.md },
  input: { flex: 1, minHeight: touch.button, borderRadius: radius.pill, backgroundColor: colors.surface, color: colors.text, paddingHorizontal: spacing.lg, ...font.body },
  shutter: { width: touch.shutter, height: touch.shutter, borderRadius: touch.shutter / 2, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  shutterStop: { backgroundColor: colors.dangerSoft },
  shutterOff: { opacity: 0.4 },
  ring: { width: 64, height: 64, borderRadius: 32, borderWidth: 4, borderColor: colors.onAccent },
  stopSquare: { width: 30, height: 30, borderRadius: 6, backgroundColor: colors.onAccent },
});
