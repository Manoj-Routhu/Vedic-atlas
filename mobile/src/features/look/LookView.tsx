import { useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useStore } from 'zustand';

import type { VisionStyle } from '../../api/types';
import { Banner } from '../../ui/Banner';
import { Button } from '../../ui/Button';
import { GearButton } from '../../ui/GearButton';
import { Icon } from '../../ui/Icon';
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
  onSettings: () => void;
  onCopy: (text: string) => void;
};

/** A press shorter than this is a tap (start listening, tap again to stop); longer is hold-to-talk (let go to ask). */
export const HOLD_MS = 450;

/** The corners of the viewfinder, drawn over the live camera. */
function Corners() {
  return (
    <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={StyleSheet.absoluteFill}>
      <View style={[styles.corner, styles.topLeft]} />
      <View style={[styles.corner, styles.topRight]} />
      <View style={[styles.corner, styles.bottomLeft]} />
      <View style={[styles.corner, styles.bottomRight]} />
    </View>
  );
}

/** What is under a button, in words. */
const Caption = ({ children, strong = false }: { children: string; strong?: boolean }) => <Text style={[styles.caption, strong && styles.captionStrong]}>{children}</Text>;

/** The Look screen: live camera or frozen photo, the answer as it is spoken, and one big shutter that becomes Stop. */
export function LookView({ store, preview, canShoot, link, micAvailable = false, onSettings, onCopy }: Props) {
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

  // Before there is anything to read the photo fills the stage; once an answer starts it shrinks to make room for it.
  const compact = hasAnswer || (Boolean(s.photo) && (s.phase === 'answered' || s.error !== null || typing));
  const answered = compact;
  const waiting = Boolean(s.photo) && working && !hasAnswer;
  const message = s.phase === 'capturing' ? 'Taking the photo…' : s.phase === 'uploading' ? 'Sending to your Pi…' : s.waking ? 'Waking up the camera model. The first photo takes a little longer.' : s.slow ? 'Still looking…' : null;
  const side = answered ? 72 : touch.mic;
  const ring = answered ? 72 : touch.shutter;

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <View style={styles.header}>
        <StatusChip status={chip} />
        <GearButton onPress={onSettings} />
      </View>

      {s.speechUnavailable ? <Banner tone="warn" message="This phone can't speak right now. The answer is shown here." /> : null}

      <View style={[styles.stage, compact && styles.stageCompact]}>
        {s.photo ? (
          <Image source={{ uri: s.photo.uri }} style={styles.photo} resizeMode="cover" accessibilityLabel="The photo you took" />
        ) : (
          <>
            {preview}
            {canShoot ? (
              <>
                <Corners />
                <View pointerEvents="none" style={styles.hint}>
                  <Text style={styles.hintTitle}>Point at something</Text>
                  <Text style={styles.hintBody}>{"Tap the shutter and I'll tell you what I see."}</Text>
                </View>
              </>
            ) : null}
          </>
        )}
        {waiting ? (
          <View style={styles.looking} accessibilityLiveRegion="polite">
            <ActivityIndicator size="large" color={colors.accent} />
            <Text style={styles.lookingTitle}>Looking…</Text>
            {message ? <Text style={styles.lookingBody}>{message}</Text> : null}
          </View>
        ) : null}
      </View>

      <View style={[styles.modes, working && styles.modesOff]} accessibilityRole="radiogroup">
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

      {compact ? (
        <ScrollView style={styles.answerBox} contentContainerStyle={styles.answerContent} keyboardShouldPersistTaps="handled">
          {questionText ? (
            <View style={[styles.question, s.listening && styles.questionLive]} accessibilityLiveRegion="polite" testID="question">
              <Text style={styles.questionText}>{questionText}</Text>
            </View>
          ) : null}
          {s.phase === 'looking' && !hasAnswer ? (
            <Text style={styles.status} accessibilityLiveRegion="polite">
              {s.slow ? 'Still looking…' : 'Looking…'}
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
          {s.error ? <Banner tone="danger" message={s.error.userMessage} testID="look-error" /> : null}

          {hasAnswer && !working ? (
            <View style={styles.actions}>
              <Pressable accessibilityRole="button" accessibilityLabel="Hear again" onPress={s.hearAgain} style={styles.action}>
                <Icon name="volume-2" size={20} color={colors.muted} />
                <Text style={styles.actionText}>Hear again</Text>
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel="Copy" onPress={() => onCopy(fullText)} style={styles.action}>
                <Icon name="copy" size={20} color={colors.muted} />
                <Text style={styles.actionText}>Copy</Text>
              </Pressable>
            </View>
          ) : null}
          {canAsk && !typing ? <Button variant="text" label="Type a question" onPress={() => setTyping(true)} /> : null}
          {s.error && s.photo && !working ? <Button variant="secondary" label="Try again" onPress={() => void s.ask(s.question)} /> : null}
        </ScrollView>
      ) : null}

      {s.micMessage ? <Banner tone="warn" message={s.micMessage} action={s.micOffer ? { label: 'Download offline speech', onPress: () => void s.downloadSpeechPack() } : undefined} onDismiss={() => store.setState({ micMessage: null })} testID="mic-message" /> : null}
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
          <View style={[styles.slot, { width: side + 12 }]}>
            {micAvailable && canAsk ? (
              <>
                <Pressable
                  testID="mic"
                  accessibilityRole="button"
                  accessibilityLabel={s.listening ? 'Stop listening' : 'Ask about this'}
                  accessibilityHint="Tap, speak your question, and pause. Or hold, speak, and let go."
                  accessibilityActions={[{ name: 'activate' }]}
                  onAccessibilityAction={() => (s.listening ? s.finishListening() : void s.startListening())}
                  onPressIn={micPressIn}
                  onPressOut={micPressOut}
                  style={[styles.side, { width: side, height: side, borderRadius: side / 2 }, (answered || s.listening) && styles.sideLive]}
                >
                  <Icon name="mic" size={answered ? 30 : 28} color={answered || s.listening ? colors.onAccent : colors.text} />
                </Pressable>
                <Caption strong={answered}>{answered ? 'Hold to ask' : 'Ask'}</Caption>
              </>
            ) : null}
          </View>

          <View style={styles.slot}>
            <Pressable
              testID="shutter"
              accessibilityRole="button"
              accessibilityLabel={working ? 'Stop' : 'Take a photo'}
              accessibilityHint={working ? undefined : 'Takes a picture and describes it out loud'}
              accessibilityState={{ disabled: !working && !canShoot }}
              disabled={!working && !canShoot}
              onPress={() => (working ? s.stop() : void s.capture())}
              style={[styles.shutter, { width: ring, height: ring, borderRadius: ring / 2 }, !working && !canShoot && styles.shutterOff]}
            >
              <View style={working ? styles.stopSquare : [styles.disc, { width: ring - 24, height: ring - 24, borderRadius: (ring - 24) / 2 }]} />
            </Pressable>
            <Caption>{working ? 'Stop' : answered ? 'New photo' : 'Take photo'}</Caption>
          </View>

          <View style={[styles.slot, { width: side + 12 }]}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Retake"
              accessibilityState={{ disabled: !s.photo }}
              disabled={!s.photo}
              onPress={s.retake}
              style={[styles.side, { width: side, height: side, borderRadius: side / 2 }, !s.photo && styles.sideOff]}
            >
              <Icon name="rotate-ccw" size={28} color={colors.text} />
            </Pressable>
            <Caption>Retake</Caption>
          </View>
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

const CORNER = { position: 'absolute', width: 36, height: 36, borderColor: colors.text, opacity: 0.85 } as const;

const styles = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: spacing.lg, gap: spacing.md },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: spacing.sm, marginRight: -spacing.sm },
  stage: { flex: 1, borderRadius: 28, overflow: 'hidden', backgroundColor: colors.surface },
  stageCompact: { flex: 0, height: 168, borderRadius: 24 },
  photo: { flex: 1 },
  corner: CORNER,
  topLeft: { left: 20, top: 20, borderLeftWidth: 3, borderTopWidth: 3, borderTopLeftRadius: 14 },
  topRight: { right: 20, top: 20, borderRightWidth: 3, borderTopWidth: 3, borderTopRightRadius: 14 },
  bottomLeft: { left: 20, bottom: 20, borderLeftWidth: 3, borderBottomWidth: 3, borderBottomLeftRadius: 14 },
  bottomRight: { right: 20, bottom: 20, borderRightWidth: 3, borderBottomWidth: 3, borderBottomRightRadius: 14 },
  hint: { position: 'absolute', left: 36, right: 36, bottom: 36, alignItems: 'center', paddingVertical: spacing.md, paddingHorizontal: spacing.lg, borderRadius: radius.lg, backgroundColor: 'rgba(14, 17, 22, 0.62)' },
  hintTitle: { fontSize: 20, lineHeight: 26, fontWeight: '600', color: colors.text },
  hintBody: { ...font.label, fontWeight: '400', color: colors.textSoft, textAlign: 'center' },
  looking: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(14, 17, 22, 0.72)', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 40, gap: spacing.md },
  lookingTitle: { fontSize: 28, lineHeight: 34, fontWeight: '700', color: colors.text },
  lookingBody: { ...font.body, color: colors.textSoft, textAlign: 'center' },
  modes: { flexDirection: 'row', gap: 4, padding: 4, borderRadius: 28, backgroundColor: colors.surface },
  modesOff: { opacity: 0.5 },
  mode: { flex: 1, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  modeOn: { backgroundColor: colors.accent },
  modeText: { fontSize: 15, fontWeight: '600', color: colors.text },
  modeTextOn: { fontWeight: '700', color: colors.onAccent },
  answerBox: { flex: 1, minHeight: 0 },
  answerContent: { gap: 14, paddingTop: spacing.xs, paddingBottom: spacing.md },
  status: { ...font.body, color: colors.muted },
  answer: { ...font.answer, color: colors.textSoft },
  speaking: { backgroundColor: colors.highlight, color: colors.text },
  note: { ...font.caption, color: colors.muted },
  actions: { flexDirection: 'row', gap: 4, marginLeft: -12 },
  action: { minHeight: touch.min, paddingHorizontal: 14, borderRadius: 24, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  actionText: { fontSize: 15, fontWeight: '600', color: colors.muted },
  bar: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', paddingHorizontal: spacing.sm, paddingBottom: spacing.sm },
  slot: { alignItems: 'center', gap: 6 },
  side: { backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' },
  sideLive: { backgroundColor: colors.accent },
  sideOff: { opacity: 0.45 },
  caption: { fontSize: 13, color: colors.muted },
  captionStrong: { fontWeight: '600', color: colors.text },
  question: { alignSelf: 'flex-end', maxWidth: 280, backgroundColor: colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, borderBottomLeftRadius: 20, borderBottomRightRadius: 6, paddingHorizontal: spacing.lg, paddingVertical: 10 },
  questionLive: { borderWidth: 2, borderColor: colors.accent },
  questionText: { fontSize: 16, lineHeight: 22, color: colors.text },
  typeBar: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingBottom: spacing.md },
  input: { flex: 1, minHeight: touch.button, borderRadius: radius.pill, backgroundColor: colors.surface, color: colors.text, paddingHorizontal: spacing.lg, ...font.body },
  shutter: { borderWidth: 4, borderColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  shutterOff: { opacity: 0.4 },
  disc: { backgroundColor: colors.text },
  stopSquare: { width: 30, height: 30, borderRadius: 7, backgroundColor: colors.text },
});
