import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useStore } from 'zustand';

import type { MusicOffReason } from '../../api/types';
import { Banner } from '../../ui/Banner';
import { Button } from '../../ui/Button';
import { GearButton } from '../../ui/GearButton';
import { Icon, type IconName } from '../../ui/Icon';
import { colors, font, radius, spacing, touch } from '../../ui/theme';
import { elapsedNow, type MusicStore } from './musicStore';

type Props = {
  store: MusicStore;
  onSettings: () => void;
  /** Whether the phone can turn speech into text (shows the microphone). */
  micAvailable?: boolean;
};

/** A press shorter than this is a tap (start listening, tap again to stop); longer is hold-to-talk (let go to play). */
export const HOLD_MS = 450;

/** 170 seconds -> "2:50". */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const OFF_STEPS: Record<MusicOffReason, { title: string; steps: string[] }> = {
  tools_missing: {
    title: "Music isn't set up on this Pi",
    steps: ['Install the player on the Pi: sudo apt install mpv', "Restart Veda: veda --restart"],
  },
  off: {
    title: 'Music is switched off on this Pi',
    steps: ['Turn it on in config/music.yaml (enabled: true) on the Pi', 'Restart Veda: veda --restart'],
  },
  offline: {
    title: "This Pi is in offline mode",
    steps: ['Music looks songs up online. Allow online lookups in config/privacy.yaml on the Pi', 'Restart Veda: veda --restart'],
  },
};

/** The Music tab. The sound comes from the Pi's speaker; this screen is the remote. */
export function MusicView({ store, onSettings, micAvailable = false }: Props) {
  const s = useStore(store);
  const [draft, setDraft] = useState('');
  const [picking, setPicking] = useState(false);
  const [tick, setTick] = useState(() => Date.now());
  const pressedAt = useRef(0);
  const info = s.info;
  const state = info?.state ?? 'idle';
  const active = state === 'playing' || state === 'paused';

  // the clock keeps counting between the Pi's answers while a song plays
  useEffect(() => {
    if (state !== 'playing') return;
    const t = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [state]);

  const micPressIn = () => {
    if (s.listening) return s.finishListening(); // second tap of tap-to-talk
    pressedAt.current = Date.now();
    void s.startListening();
  };
  const micPressOut = () => {
    if (s.listening && Date.now() - pressedAt.current >= HOLD_MS) s.finishListening(); // held: let go plays. A tap keeps listening.
  };
  const play = () => {
    const words = draft.trim();
    if (!words) return;
    setDraft('');
    setPicking(false);
    void s.play(words);
  };

  const playCard = (
    <View style={styles.card} testID="play-card">
      <Text accessibilityRole="header" style={styles.cardTitle}>
        Play a song
      </Text>
      <View style={styles.inputRow}>
        <TextInput
          testID="song-input"
          accessibilityLabel="Song name"
          placeholder={s.listening ? 'Listening…' : 'Song name, like Tum Hi Ho'}
          placeholderTextColor={colors.muted}
          value={s.listening ? s.heard : draft}
          editable={!s.listening}
          onChangeText={setDraft}
          onSubmitEditing={play}
          returnKeyType="search"
          style={styles.input}
        />
        {micAvailable ? (
          <Pressable
            testID="mic"
            accessibilityRole="button"
            accessibilityLabel={s.listening ? 'Stop listening' : 'Say the song name'}
            accessibilityHint="Tap and say the song, then pause. Or hold, say it, and let go."
            accessibilityActions={[{ name: 'activate' }]}
            onAccessibilityAction={() => (s.listening ? s.finishListening() : void s.startListening())}
            onPressIn={micPressIn}
            onPressOut={micPressOut}
            style={[styles.micButton, s.listening && styles.micLive]}
          >
            <Icon name="mic" size={26} color={s.listening ? colors.onAccent : colors.text} />
          </Pressable>
        ) : null}
      </View>
      <Button label="Play" onPress={play} disabled={draft.trim() === '' || s.listening} icon={<Icon name="play" size={22} color={colors.onAccent} />} />
      <Text style={styles.helper}>Say or type the name. Veda picks the best match from YouTube and tells you which song it chose.</Text>
    </View>
  );

  let body;
  if (!info) {
    body = <Text style={styles.status}>{s.loading ? 'Checking your Pi…' : "Couldn't check the music on your Pi."}</Text>;
  } else if (!info.available) {
    const off = OFF_STEPS[info.reason ?? 'off'];
    body = (
      <View style={styles.center} testID="music-unavailable">
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.bigBadge}>
          <Icon name="music" size={44} color={colors.muted} />
        </View>
        <Text accessibilityRole="header" style={styles.bigTitle}>
          {off.title}
        </Text>
        <Text style={styles.bigLead}>Veda needs a player on the Pi, and permission to look songs up online.</Text>
        <View style={styles.steps}>
          {off.steps.map((step, i) => (
            <View key={step} style={[styles.step, i < off.steps.length - 1 && styles.stepLine]}>
              <View style={styles.number}>
                <Text style={styles.numberText}>{i + 1}</Text>
              </View>
              <Text style={styles.stepText}>{step}</Text>
            </View>
          ))}
        </View>
        <Button label="Check again" onPress={() => void s.refresh()} />
      </View>
    );
  } else if (s.asking !== null || state === 'starting') {
    body = (
      <View style={styles.searching} testID="music-searching" accessibilityLiveRegion="polite">
        <ActivityIndicator size="large" color={colors.accent} />
        <Text accessibilityRole="header" style={styles.bigTitle}>
          {s.asking !== null ? 'Finding the song…' : 'Starting the song…'}
        </Text>
        <Text style={styles.query}>{s.asking ?? info.title}</Text>
        <Text style={styles.bigLead}>{"It starts on your Pi's speaker as soon as Veda has finished talking."}</Text>
        <Button variant="secondary" label="Cancel" onPress={s.cancelAsk} />
      </View>
    );
  } else if (active) {
    const elapsed = elapsedNow(s, tick) ?? 0;
    const limit = info.limitS;
    const total = limit !== null ? (info.durationS !== null ? Math.min(info.durationS, limit) : limit) : null;
    const ends = limit !== null && info.durationS !== null && info.durationS < limit ? `Ends at ${clock(info.durationS)}` : limit !== null ? `Stops by itself at ${clock(limit)}` : '';
    const paused = state === 'paused';
    body = (
      <>
        <View style={styles.playerCard} testID="now-playing">
          <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.ring}>
            <Icon name="music" size={48} color={colors.accent} />
          </View>
          <Text style={styles.nowLabel}>Now playing</Text>
          <Text accessibilityRole="header" style={styles.songTitle}>
            {info.title}
          </Text>
          <View style={styles.badge} accessible accessibilityLabel={paused ? 'Paused' : 'Playing on your Pi'}>
            <View style={[styles.dot, { backgroundColor: paused ? colors.accent : colors.ok }]} />
            <Text style={styles.badgeText}>{paused ? 'Paused' : 'Playing on your Pi'}</Text>
          </View>
          {total !== null ? (
            <View style={styles.progressWrap}>
              <View
                style={styles.track}
                accessible
                accessibilityRole="progressbar"
                accessibilityLabel="Time until the song stops by itself"
                accessibilityValue={{ min: 0, max: Math.round(total), now: Math.round(Math.min(elapsed, total)) }}
              >
                <View style={[styles.fill, { width: `${Math.min(100, (elapsed / total) * 100)}%` }]} />
              </View>
              <View style={styles.timeRow}>
                <Text style={styles.time}>{clock(elapsed)}</Text>
                <Text style={styles.time}>{ends}</Text>
              </View>
            </View>
          ) : null}
        </View>

        <View style={styles.controls}>
          <View style={styles.control}>
            <Pressable accessibilityRole="button" accessibilityLabel="Stop the music" disabled={s.busy} onPress={() => void s.stop()} style={[styles.side, s.busy && styles.dim]}>
              <Icon name="square" size={26} color={colors.text} />
            </Pressable>
            <Text style={styles.caption}>Stop</Text>
          </View>
          <View style={styles.control}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={paused ? 'Resume' : 'Pause'}
              disabled={s.busy}
              onPress={() => void (paused ? s.resume() : s.pause())}
              style={[styles.main, s.busy && styles.dim]}
            >
              <Icon name={paused ? 'play' : 'pause'} size={36} color={colors.onAccent} />
            </Pressable>
            <Text style={styles.captionStrong}>{paused ? 'Resume' : 'Pause'}</Text>
          </View>
          <View style={styles.control}>
            <Pressable accessibilityRole="button" accessibilityLabel="Play a different song" onPress={() => setPicking((p) => !p)} style={[styles.side, picking && styles.sideOn]}>
              <Icon name="search" size={26} color={picking ? colors.onAccent : colors.text} />
            </Pressable>
            <Text style={styles.caption}>New song</Text>
          </View>
        </View>

        {picking ? (
          playCard
        ) : (
          <View style={styles.notice} accessible>
            <Icon name="mic-off" size={22} color={colors.accent} />
            <Text style={styles.noticeText}>{"Veda's microphone is closed while the song plays. Stop it, or mute and unmute on the Pi, to talk to Veda again."}</Text>
          </View>
        )}
      </>
    );
  } else {
    body = (
      <>
        {playCard}
        <View style={styles.card}>
          <Text accessibilityRole="header" style={styles.cardTitle}>
            Good to know
          </Text>
          <Fact icon="mic-off" text="Veda's microphone is closed while a song plays. Stop the song to talk to it again." />
          <Fact icon="clock" text={`A song stops by itself after ${info.limitS ? Math.round(info.limitS / 60) : 5} minutes.`} />
          <Fact icon="globe" text="Only the words you give leave your home, to find the song. Your voice never does." />
        </View>
      </>
    );
  }

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <View style={styles.header}>
        <Text accessibilityRole="header" style={styles.title}>
          Music
        </Text>
        <GearButton onPress={onSettings} />
      </View>

      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {info?.available !== false ? (
          <View style={styles.where} accessible accessibilityLabel="Plays on your Pi's speaker. This phone is the remote; no sound comes from it.">
            <Icon name="volume-2" size={22} color={colors.ok} />
            <Text style={styles.whereText}>
              <Text style={styles.whereStrong}>{"Plays on your Pi's speaker."}</Text> This phone is the remote; no sound comes from it.
            </Text>
          </View>
        ) : null}
        {s.error ? <Banner tone="danger" message={s.error.userMessage} onDismiss={s.dismissError} testID="music-error" /> : null}
        {s.micMessage ? (
          <Banner
            tone="warn"
            message={s.micMessage}
            action={s.micOffer ? { label: 'Download offline speech', onPress: () => void s.downloadSpeechPack() } : undefined}
            onDismiss={() => store.setState({ micMessage: null })}
            testID="mic-message"
          />
        ) : null}
        {body}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Fact({ icon, text }: { icon: IconName; text: string }) {
  return (
    <View style={styles.fact}>
      <Icon name={icon} size={22} color={colors.accent} />
      <Text style={styles.factText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: spacing.lg },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: spacing.sm, paddingLeft: 4, marginRight: -spacing.sm },
  title: { fontSize: 26, lineHeight: 32, fontWeight: '700', color: colors.text, letterSpacing: -0.3 },
  content: { gap: spacing.md, paddingTop: spacing.xs, paddingBottom: spacing.xl },
  status: { ...font.body, color: colors.muted, paddingTop: spacing.xl, textAlign: 'center' },
  where: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12, paddingHorizontal: spacing.lg, borderRadius: radius.lg, backgroundColor: colors.surface },
  whereText: { flex: 1, fontSize: 16, lineHeight: 22, color: colors.muted },
  whereStrong: { fontWeight: '700', color: colors.text },
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, paddingVertical: spacing.lg, paddingHorizontal: 18, gap: spacing.md },
  cardTitle: { fontSize: 15, lineHeight: 20, fontWeight: '600', color: colors.muted },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  input: { flex: 1, minHeight: touch.button, borderRadius: 28, backgroundColor: colors.surfaceHigh, color: colors.text, paddingHorizontal: 20, ...font.body },
  micButton: { width: touch.button, height: touch.button, borderRadius: touch.button / 2, backgroundColor: colors.surfaceHigh, alignItems: 'center', justifyContent: 'center' },
  micLive: { backgroundColor: colors.accent },
  helper: { ...font.label, fontWeight: '400', color: colors.muted },
  fact: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  factText: { flex: 1, fontSize: 16, lineHeight: 22, color: colors.text },
  center: { alignItems: 'center', gap: spacing.md, paddingTop: spacing.lg },
  bigBadge: { width: 104, height: 104, borderRadius: 52, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center', marginBottom: spacing.sm },
  bigTitle: { fontSize: 26, lineHeight: 32, fontWeight: '700', color: colors.text, textAlign: 'center', letterSpacing: -0.3 },
  bigLead: { fontSize: 17, lineHeight: 25, color: colors.muted, textAlign: 'center' },
  steps: { alignSelf: 'stretch', borderRadius: radius.lg, backgroundColor: colors.surface },
  step: { flexDirection: 'row', alignItems: 'flex-start', gap: 14, paddingVertical: spacing.lg, paddingHorizontal: 18 },
  stepLine: { borderBottomWidth: 1, borderBottomColor: colors.border },
  number: { width: 28, height: 28, borderRadius: 14, backgroundColor: colors.surfaceHigh, alignItems: 'center', justifyContent: 'center' },
  numberText: { fontSize: 15, fontWeight: '700', color: colors.text },
  stepText: { flex: 1, fontSize: 16, lineHeight: 23, color: colors.text },
  searching: { alignItems: 'center', gap: spacing.md, paddingTop: spacing.xl, paddingHorizontal: spacing.md, paddingBottom: spacing.lg, borderRadius: 28, backgroundColor: colors.surface },
  query: { fontSize: 18, lineHeight: 25, color: colors.text, textAlign: 'center' },
  playerCard: { alignItems: 'center', padding: spacing.xl, paddingTop: spacing.xxl, borderRadius: 28, backgroundColor: colors.surface },
  ring: { width: 112, height: 112, borderRadius: 56, borderWidth: 4, borderColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  nowLabel: { ...font.label, color: colors.muted, marginTop: spacing.xl },
  songTitle: { fontSize: 26, lineHeight: 31, fontWeight: '700', color: colors.text, textAlign: 'center', marginTop: 6, letterSpacing: -0.3 },
  badge: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, height: 32, paddingHorizontal: 14, borderRadius: 16, backgroundColor: colors.bg, marginTop: 14 },
  badgeText: { ...font.label, color: colors.text },
  dot: { width: 8, height: 8, borderRadius: 4 },
  progressWrap: { alignSelf: 'stretch', marginTop: 28 },
  track: { height: 6, borderRadius: 3, backgroundColor: colors.surfaceHigh, overflow: 'hidden' },
  fill: { height: 6, backgroundColor: colors.accent },
  timeRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.sm },
  time: { ...font.caption, color: colors.muted },
  controls: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'center', gap: 28, paddingTop: spacing.sm },
  control: { alignItems: 'center', gap: 6 },
  side: { width: 64, height: 64, borderRadius: 32, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' },
  sideOn: { backgroundColor: colors.accent },
  main: { width: 88, height: 88, borderRadius: 44, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  dim: { opacity: 0.5 },
  caption: { fontSize: 13, color: colors.muted },
  captionStrong: { fontSize: 13, fontWeight: '600', color: colors.text },
  notice: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md, padding: 14, paddingHorizontal: spacing.lg, borderRadius: radius.lg, backgroundColor: colors.warnGround, borderWidth: 1, borderColor: colors.warnBorder },
  noticeText: { flex: 1, fontSize: 15, lineHeight: 22, color: '#D6DAE0' },
});
