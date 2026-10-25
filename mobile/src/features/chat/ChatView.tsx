import { useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type NativeScrollEvent, type NativeSyntheticEvent, type ScrollViewInstance } from 'react-native';
import { useStore } from 'zustand';

import { Banner } from '../../ui/Banner';
import { Button } from '../../ui/Button';
import { StatusChip, type ChipStatus } from '../../ui/StatusChip';
import { colors, font, radius, spacing, touch } from '../../ui/theme';
import type { ChatStore } from './chatStore';

type Props = {
  store: ChatStore;
  link: ChipStatus;
  /** This phone was allowed to approve actions when it was paired. */
  canApprove: boolean;
  onBack: () => void;
  onSettings: () => void;
};

const NEAR_BOTTOM_PX = 80;

/** Talk to Veda by typing: replies stream in, approvals wait at the top, and the speaker reads replies aloud if on. */
export function ChatView({ store, link, canApprove, onBack, onSettings }: Props) {
  const s = useStore(store);
  const [draft, setDraft] = useState('');
  const list = useRef<ScrollViewInstance>(null);
  const stickToBottom = useRef(true);

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

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" accessibilityLabel="Home" onPress={onBack} style={styles.back} hitSlop={8}>
          <Text style={styles.backText}>‹ Home</Text>
        </Pressable>
        <StatusChip status={link} />
        <Pressable accessibilityRole="button" accessibilityLabel="Settings" onPress={onSettings} style={styles.gear} hitSlop={8}>
          <Text style={styles.gearText}>⚙</Text>
        </Pressable>
      </View>

      {s.approvals.map((a) => (
        <View key={a.requestId} style={styles.approval} testID={`approval-${a.requestId}`} accessibilityLiveRegion="polite">
          <Text style={styles.approvalTitle}>Veda wants your OK</Text>
          <Text style={styles.approvalText}>{a.summary}</Text>
          {canApprove ? (
            <View style={styles.approvalButtons}>
              <View style={styles.flex}>
                <Button variant="secondary" label="Deny" onPress={() => void s.deny(a.requestId)} disabled={s.deciding !== null} />
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
        <Banner tone="warn" title="Chat is paused" message="Auto-approve is on at the Pi, so chat from the phone is paused. Turn it off on the Pi to chat here." testID="paused" />
      ) : null}

      <ScrollView
        ref={list}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        onScroll={onScroll}
        scrollEventThrottle={64}
        onContentSizeChange={() => stickToBottom.current && list.current?.scrollToEnd({ animated: false })}
        keyboardShouldPersistTaps="handled"
      >
        {s.messages.length === 0 && !s.paused ? <Text style={styles.empty}>Ask Veda anything, or tell it what to do.</Text> : null}
        {s.messages.map((m) => (
          <View key={m.id} style={[styles.bubble, m.role === 'user' ? styles.mine : styles.theirs, m.failed && styles.failed]} testID={`message-${m.role}`}>
            <Text style={styles.who}>{m.role === 'user' ? 'You' : 'Veda'}</Text>
            <Text style={styles.text} selectable accessibilityLiveRegion={m.role === 'veda' ? 'polite' : undefined}>
              {m.text || (m.streaming ? '…' : '')}
            </Text>
          </View>
        ))}
        {s.error && !s.paused ? <Banner tone="danger" message={s.error.userMessage} testID="chat-error" /> : null}
      </ScrollView>

      <View style={styles.composer}>
        <TextInput
          testID="chat-input"
          accessibilityLabel="Message to Veda"
          placeholder={s.paused ? 'Paused' : 'Type a message'}
          placeholderTextColor={colors.muted}
          editable={!s.paused}
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={send}
          returnKeyType="send"
          multiline
          style={styles.input}
        />
        <Pressable
          testID="speaker"
          accessibilityRole="switch"
          accessibilityLabel="Read replies aloud"
          accessibilityState={{ checked: s.speak }}
          onPress={() => s.setSpeak(!s.speak)}
          style={[styles.round, s.speak && styles.roundOn]}
        >
          <Text style={styles.glyph}>{s.speak ? '🔊' : '🔈'}</Text>
        </Pressable>
        {s.busy ? (
          <Pressable testID="stop" accessibilityRole="button" accessibilityLabel="Stop" onPress={s.stop} style={[styles.round, styles.stop]}>
            <View style={styles.stopSquare} />
          </Pressable>
        ) : (
          <Pressable
            testID="send"
            accessibilityRole="button"
            accessibilityLabel="Send"
            accessibilityState={{ disabled: draft.trim() === '' || s.paused }}
            disabled={draft.trim() === '' || s.paused}
            onPress={send}
            style={[styles.round, styles.send, (draft.trim() === '' || s.paused) && styles.off]}
          >
            <Text style={styles.sendGlyph}>➤</Text>
          </Pressable>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: spacing.lg, gap: spacing.md },
  flex: { flex: 1 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: spacing.sm },
  back: { minHeight: touch.min, justifyContent: 'center', paddingRight: spacing.sm },
  backText: { ...font.button, color: colors.text },
  gear: { width: touch.min, height: touch.min, alignItems: 'center', justifyContent: 'center' },
  gearText: { fontSize: 26, color: colors.text },
  approval: { backgroundColor: colors.warnGround, borderColor: colors.warnBorder, borderWidth: 1, borderRadius: radius.lg, padding: spacing.lg, gap: spacing.sm },
  approvalTitle: { ...font.label, color: colors.warn },
  approvalText: { ...font.body, color: colors.text },
  approvalNote: { ...font.caption, color: colors.textSoft },
  approvalButtons: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.sm },
  list: { flex: 1 },
  listContent: { gap: spacing.md, paddingVertical: spacing.sm },
  empty: { ...font.body, color: colors.muted, paddingTop: spacing.xl },
  bubble: { maxWidth: '88%', borderRadius: radius.lg, paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: 2 },
  mine: { alignSelf: 'flex-end', backgroundColor: colors.surfaceHigh },
  theirs: { alignSelf: 'flex-start', backgroundColor: colors.surface },
  failed: { borderWidth: 1, borderColor: colors.dangerBorder },
  who: { ...font.caption, color: colors.muted },
  text: { ...font.body, color: colors.text },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm, paddingBottom: spacing.md },
  input: { flex: 1, minHeight: touch.button, maxHeight: 120, borderRadius: radius.xl, backgroundColor: colors.surface, color: colors.text, paddingHorizontal: spacing.lg, paddingVertical: spacing.md, ...font.body },
  round: { width: touch.button, height: touch.button, borderRadius: touch.button / 2, backgroundColor: colors.surfaceHigh, alignItems: 'center', justifyContent: 'center' },
  roundOn: { backgroundColor: colors.accent },
  send: { backgroundColor: colors.accent },
  stop: { backgroundColor: colors.dangerSoft },
  off: { opacity: 0.4 },
  glyph: { fontSize: 24 },
  sendGlyph: { fontSize: 22, color: colors.onAccent },
  stopSquare: { width: 22, height: 22, borderRadius: 5, backgroundColor: colors.onAccent },
});
