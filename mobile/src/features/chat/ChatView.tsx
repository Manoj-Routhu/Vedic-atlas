import { useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type NativeScrollEvent, type NativeSyntheticEvent, type ScrollViewInstance } from 'react-native';
import { useStore } from 'zustand';

import { Banner } from '../../ui/Banner';
import { Button } from '../../ui/Button';
import { GearButton } from '../../ui/GearButton';
import { Icon } from '../../ui/Icon';
import type { ChipStatus } from '../../ui/StatusChip';
import { colors, font, radius, spacing, touch } from '../../ui/theme';
import type { ChatStore } from './chatStore';

type Props = {
  store: ChatStore;
  link: ChipStatus;
  /** This phone was allowed to approve actions when it was paired. */
  canApprove: boolean;
  onSettings: () => void;
  /** Whether the phone can turn speech into text (shows the microphone). */
  micAvailable?: boolean;
};

/** A press shorter than this is a tap (start listening, tap again to send); longer is hold-to-talk (let go to send). */
export const HOLD_MS = 450;

const NEAR_BOTTOM_PX = 80;

const STATUS: Record<ChipStatus, { text: string; dot: string }> = {
  connected: { text: 'Online', dot: colors.ok },
  checking: { text: 'Checking', dot: colors.warn },
  unreachable: { text: "Can't reach your Pi", dot: colors.danger },
  waking: { text: 'Online', dot: colors.ok },
  demo: { text: 'Demo mode', dot: colors.warn },
};

/** Talk to Veda by typing or speaking: replies stream in, approvals wait at the top, and the speaker reads replies aloud if on. */
export function ChatView({ store, link, canApprove, onSettings, micAvailable = false }: Props) {
  const s = useStore(store);
  const [draft, setDraft] = useState('');
  const list = useRef<ScrollViewInstance>(null);
  const stickToBottom = useRef(true);
  const pressedAt = useRef(0);

  const micPressIn = () => {
    if (s.listening) return s.finishListening(); // second tap of tap-to-talk
    pressedAt.current = Date.now();
    void s.startListening();
  };
  const micPressOut = () => {
    if (s.listening && Date.now() - pressedAt.current >= HOLD_MS) s.finishListening(); // held: let go sends. A tap keeps listening.
  };

  const send = () => {
    const text = draft.trim();
    if (!text || s.busy || s.paused) return;
    setDraft('');
    stickToBottom.current = true;
    void s.send(text);
  };

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    stickToBottom.current = contentSize.height - (contentOffset.y + layoutMeasurement.height) < NEAR_BOTTOM_PX;
  };

  const status = s.paused ? { text: 'Chat paused', dot: colors.warn } : STATUS[link];
  const empty = draft.trim() === '';
  const showMic = micAvailable && !s.paused && empty;

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <View style={styles.header}>
        <View style={styles.title}>
          <Text accessibilityRole="header" style={styles.name}>
            Veda
          </Text>
          <View style={[styles.dot, { backgroundColor: status.dot }]} />
          <Text style={styles.status} accessibilityLiveRegion="polite">
            {status.text}
          </Text>
        </View>
        <GearButton onPress={onSettings} />
      </View>

      {s.approvals.map((a) => (
        <View key={a.requestId} style={styles.approval} testID={`approval-${a.requestId}`} accessibilityLiveRegion="polite">
          <View style={styles.approvalHead}>
            <View style={styles.badge}>
              <Icon name="shield" size={22} color={colors.onAccent} />
            </View>
            <Text style={styles.approvalTitle}>Veda wants your OK</Text>
          </View>
          <Text style={styles.approvalText}>{a.summary}</Text>
          {canApprove ? (
            <View style={styles.approvalButtons}>
              <View style={styles.flex}>
                <Button variant="danger" label="Deny" onPress={() => void s.deny(a.requestId)} disabled={s.deciding !== null} />
              </View>
              <View style={styles.flex}>
                <Button label="Approve" onPress={() => void s.approve(a.requestId)} loading={s.deciding === a.requestId} disabled={s.deciding !== null} />
              </View>
            </View>
          ) : (
            <Text style={styles.approvalNote}>Approve it on the Pi.</Text>
          )}
        </View>
      ))}

      {s.paused ? (
        <View style={styles.paused} testID="paused" accessible accessibilityRole="alert" accessibilityLabel="Chat is paused. Auto-approve is on at the Pi, so chat from the phone is paused. Turn it off on the Pi to chat here.">
          <View style={[styles.badge, styles.pausedBadge]}>
            <Icon name="alert-triangle" size={22} color={colors.onAccent} />
          </View>
          <View style={styles.flex}>
            <Text style={styles.approvalTitle}>Auto-approve is on at the Pi</Text>
            <Text style={styles.pausedText}>Chat from the phone is paused, so nothing can run without asking you. Turn auto-approve off at the Pi to carry on.</Text>
          </View>
        </View>
      ) : null}

      <ScrollView
        ref={list}
        style={[styles.list, s.paused && styles.listPaused]}
        contentContainerStyle={styles.listContent}
        onScroll={onScroll}
        scrollEventThrottle={64}
        onContentSizeChange={() => stickToBottom.current && list.current?.scrollToEnd({ animated: false })}
        keyboardShouldPersistTaps="handled"
      >
        {s.messages.length === 0 && !s.paused ? <Text style={styles.empty}>Ask Veda anything, or tell it what to do.</Text> : null}
        {s.messages.map((m) =>
          m.role === 'user' ? (
            <View key={m.id} style={[styles.mine, m.failed && styles.failed]} testID="message-user">
              <Text style={styles.text} selectable>
                {m.text}
              </Text>
            </View>
          ) : (
            <View key={m.id} style={[styles.theirs, m.failed && styles.failedText]} testID="message-veda">
              <Text style={styles.who}>Veda</Text>
              <Text style={styles.reply} selectable accessibilityLiveRegion="polite">
                {m.text || (m.streaming ? '…' : '')}
                {m.streaming && m.text ? <Text style={styles.cursor}>{' ▍'}</Text> : null}
              </Text>
            </View>
          ),
        )}
        {s.error && !s.paused ? <Banner tone="danger" message={s.error.userMessage} testID="chat-error" /> : null}
      </ScrollView>

      {s.micMessage ? (
        <Banner
          tone="warn"
          message={s.micMessage}
          action={s.micOffer ? { label: 'Download offline speech', onPress: () => void s.downloadSpeechPack() } : undefined}
          onDismiss={() => store.setState({ micMessage: null })}
          testID="mic-message"
        />
      ) : null}

      <View style={styles.composer}>
        <TextInput
          testID="chat-input"
          accessibilityLabel="Message to Veda"
          placeholder={s.paused ? 'Paused' : s.listening ? 'Listening…' : 'Type a message'}
          placeholderTextColor={colors.muted}
          editable={!s.paused && !s.listening}
          value={s.listening ? s.heard : draft}
          onChangeText={setDraft}
          onSubmitEditing={send}
          returnKeyType="send"
          multiline
          style={[styles.input, s.paused && styles.off]}
        />
        <Pressable
          testID="speaker"
          accessibilityRole="switch"
          accessibilityLabel="Read replies aloud"
          accessibilityState={{ checked: s.speak, disabled: s.paused }}
          disabled={s.paused}
          onPress={() => s.setSpeak(!s.speak)}
          style={[styles.round, s.paused && styles.off]}
        >
          <Icon name={s.speak ? 'volume-2' : 'volume-x'} size={24} color={s.speak ? colors.accent : colors.muted} />
        </Pressable>
        {s.busy ? (
          <Pressable testID="stop" accessibilityRole="button" accessibilityLabel="Stop" onPress={s.stop} style={[styles.big, styles.stop]}>
            <View style={styles.stopSquare} />
          </Pressable>
        ) : showMic ? (
          <Pressable
            testID="mic"
            accessibilityRole="button"
            accessibilityLabel={s.listening ? 'Stop listening' : 'Speak to Veda'}
            accessibilityHint="Tap and speak, tap again to send. Or hold, speak, and let go."
            accessibilityActions={[{ name: 'activate' }]}
            onAccessibilityAction={() => (s.listening ? s.finishListening() : void s.startListening())}
            onPressIn={micPressIn}
            onPressOut={micPressOut}
            style={[styles.big, s.listening && styles.bigLive]}
          >
            <Icon name="mic" size={26} color={colors.onAccent} />
          </Pressable>
        ) : (
          <Pressable
            testID="send"
            accessibilityRole="button"
            accessibilityLabel="Send"
            accessibilityState={{ disabled: empty || s.paused }}
            disabled={empty || s.paused}
            onPress={send}
            style={[styles.big, (empty || s.paused) && styles.bigOff]}
          >
            <Icon name="send" size={24} color={colors.onAccent} />
          </Pressable>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: spacing.lg, gap: spacing.md },
  flex: { flex: 1 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: spacing.sm, paddingLeft: 4, marginRight: -spacing.sm },
  title: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  name: { fontSize: 26, lineHeight: 32, fontWeight: '700', color: colors.text, letterSpacing: -0.3 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  status: { ...font.label, fontWeight: '400', color: colors.muted },
  approval: { backgroundColor: colors.warnGround, borderColor: colors.warnBorder, borderWidth: 1, borderRadius: radius.lg, padding: spacing.lg, gap: spacing.sm },
  approvalHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  badge: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  approvalTitle: { ...font.body, fontWeight: '700', color: colors.text, flexShrink: 1 },
  approvalText: { fontSize: 16, lineHeight: 24, color: colors.textSoft },
  approvalNote: { ...font.caption, color: colors.textSoft },
  approvalButtons: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.sm },
  paused: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md, backgroundColor: colors.dangerGround, borderColor: colors.dangerBorder, borderWidth: 1, borderRadius: radius.lg, padding: spacing.lg },
  pausedBadge: { backgroundColor: colors.dangerSoft },
  pausedText: { marginTop: 6, fontSize: 16, lineHeight: 24, color: '#E6D2D2' },
  list: { flex: 1 },
  listPaused: { opacity: 0.45 },
  listContent: { flexGrow: 1, justifyContent: 'flex-end', gap: 14, paddingVertical: spacing.sm },
  empty: { ...font.body, color: colors.muted, paddingTop: spacing.xl },
  mine: { alignSelf: 'flex-end', maxWidth: 280, backgroundColor: colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, borderBottomLeftRadius: 20, borderBottomRightRadius: 6, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  theirs: { maxWidth: 320, gap: 4 },
  failed: { borderWidth: 1, borderColor: colors.dangerBorder },
  failedText: { opacity: 0.85 },
  who: { fontSize: 13, fontWeight: '700', color: colors.accent },
  text: { ...font.body, color: colors.text },
  reply: { fontSize: 17, lineHeight: 26, color: colors.text },
  cursor: { color: colors.accent },
  composer: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingBottom: spacing.md },
  input: { flex: 1, minHeight: 52, maxHeight: 120, borderRadius: 26, backgroundColor: colors.surface, color: colors.text, paddingHorizontal: 20, paddingVertical: spacing.md, ...font.body },
  round: { width: 52, height: 52, borderRadius: 26, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' },
  big: { width: touch.button, height: touch.button, borderRadius: touch.button / 2, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  bigLive: { borderWidth: 3, borderColor: colors.text },
  bigOff: { opacity: 0.4 },
  off: { opacity: 0.6 },
  stop: { backgroundColor: colors.dangerSoft },
  stopSquare: { width: 22, height: 22, borderRadius: 5, backgroundColor: colors.onAccent },
});
