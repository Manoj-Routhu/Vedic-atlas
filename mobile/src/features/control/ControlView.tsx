import { useState, type ReactNode } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useStore } from 'zustand';

import { Banner } from '../../ui/Banner';
import { Button } from '../../ui/Button';
import { StatusChip, type ChipStatus } from '../../ui/StatusChip';
import { colors, font, radius, spacing, touch } from '../../ui/theme';
import { describeCameraModel, describeLeads, formatDuration, formatWhen } from './format';
import { parseLeadMinutes, type ControlStore } from './controlStore';

type Props = {
  store: ControlStore;
  /** What this phone was allowed when paired. Cards the phone may not use are not shown. */
  scopes: string[];
  link: ChipStatus;
  onBack: () => void;
  onSettings: () => void;
};

/** A glanceable page about the Pi with a few safe switches. A phone can close the microphone but never open it. */
export function ControlView({ store, scopes, link, onBack, onSettings }: Props) {
  const s = useStore(store);
  const mayControl = scopes.includes('control');
  const mayChat = scopes.includes('chat');
  const [newTask, setNewTask] = useState('');
  const [leadsText, setLeadsText] = useState('');
  const [editingLeads, setEditingLeads] = useState(false);
  const [leadsProblem, setLeadsProblem] = useState(false);

  const addTask = () => {
    const title = newTask.trim();
    if (!title) return;
    setNewTask('');
    void s.addTask(title);
  };

  const saveLeads = () => {
    const minutes = parseLeadMinutes(leadsText);
    if (!minutes) return setLeadsProblem(true);
    setLeadsProblem(false);
    setEditingLeads(false);
    void s.setReminderLeads(minutes);
  };

  const hidden = (name: keyof typeof s.errors) => s.errors[name]?.kind === 'forbidden';

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" accessibilityLabel="Home" onPress={onBack} style={styles.back} hitSlop={8}>
          <Text style={styles.backText}>‹ Home</Text>
        </Pressable>
        <StatusChip status={link} />
        <Pressable accessibilityRole="button" accessibilityLabel="Settings" onPress={onSettings} style={styles.gear} hitSlop={8}>
          <Text style={styles.gearText}>⚙</Text>
        </Pressable>
      </View>

      <ScrollView
        style={styles.flex}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={s.refreshing && !s.loading} onRefresh={() => void s.refresh()} tintColor={colors.accent} />}
      >
        <Text accessibilityRole="header" style={styles.title}>
          Control
        </Text>

        {s.actionError ? <Banner tone="danger" message={s.actionError.userMessage} onDismiss={s.dismissActionError} testID="control-error" /> : null}
        {s.loading ? <Text style={styles.muted}>Loading…</Text> : null}

        <Card title="Veda" testID="card-status">
          <Row label="Connection" value={s.onlineMs === null ? (s.loading ? '…' : 'Not answering') : `Online · ${formatDuration(s.onlineMs)}`} />
          {s.vision && !hidden('vision') ? <Row label="Camera model" value={describeCameraModel(s.vision)} /> : null}
          {mayControl && s.autoApprove !== null ? (
            <Row label="Auto-approve" value={s.autoApprove ? 'On: chat from the phone is paused' : 'Off'} warn={s.autoApprove} />
          ) : null}
        </Card>

        {mayControl && s.privacy && !hidden('privacy') ? (
          <Card title="Microphone" testID="card-mic">
            <Row label="Veda is" value={s.privacy.muted ? 'Not listening (muted)' : 'Listening'} />
            {!s.privacy.muted ? <Button variant="secondary" label="Mute" onPress={() => void s.mute()} accessibilityHint="Closes the Pi's microphone" /> : null}
            <Text style={styles.note}>
              {s.privacy.hardwareSwitch ? 'A switch on the Pi controls the microphone.' : 'To unmute, use the Pi. A phone can only mute.'}
            </Text>
          </Card>
        ) : null}

        {mayChat && s.tasks && !hidden('tasks') ? (
          <Card title="Tasks" testID="card-tasks">
            {s.tasks.length === 0 ? <Text style={styles.muted}>Nothing to do.</Text> : null}
            {s.tasks.map((t) => (
              <Pressable
                key={t.id}
                testID={`task-${t.id}`}
                accessibilityRole="checkbox"
                accessibilityLabel={t.title}
                accessibilityState={{ checked: false }}
                accessibilityHint="Marks it done"
                onPress={() => void s.completeTask(t.id)}
                style={styles.task}
              >
                <View style={styles.box} />
                <Text style={styles.taskText}>{t.title}</Text>
                {t.dueAt ? <Text style={styles.muted}>{formatWhen(t.dueAt)}</Text> : null}
              </Pressable>
            ))}
            <View style={styles.addRow}>
              <TextInput
                testID="new-task"
                accessibilityLabel="Add a task"
                placeholder="Add a task"
                placeholderTextColor={colors.muted}
                value={newTask}
                onChangeText={setNewTask}
                onSubmitEditing={addTask}
                returnKeyType="done"
                style={styles.input}
              />
              <Button label="Add" onPress={addTask} disabled={newTask.trim() === ''} />
            </View>
          </Card>
        ) : null}

        {mayControl && s.reminders && !hidden('reminders') ? (
          <Card title="Reminders" testID="card-reminders">
            <Row label="Next" value={s.reminders.nextDueAt ? formatWhen(s.reminders.nextDueAt) : 'Nothing coming up'} />
            <Row label="Heads-up" value={s.reminders.enabled ? describeLeads(s.reminders.leadMinutes) : 'Off'} />
            {s.reminders.lastSyncOk === false ? <Text style={styles.note}>The calendar could not be checked last time.</Text> : null}
            {editingLeads ? (
              <View style={styles.addRow}>
                <TextInput
                  testID="leads-input"
                  accessibilityLabel="Minutes before, separated by commas"
                  placeholder="15, 5"
                  placeholderTextColor={colors.muted}
                  value={leadsText}
                  onChangeText={(t) => {
                    setLeadsText(t);
                    setLeadsProblem(false);
                  }}
                  onSubmitEditing={saveLeads}
                  keyboardType="numbers-and-punctuation"
                  style={styles.input}
                />
                <Button label="Save" onPress={saveLeads} />
              </View>
            ) : (
              <Button
                variant="text"
                label="Change heads-up time"
                onPress={() => {
                  setLeadsText(s.reminders?.leadMinutes.join(', ') ?? '');
                  setEditingLeads(true);
                }}
              />
            )}
            {leadsProblem ? <Text style={styles.problem}>Use up to five numbers from 1 to 120, like 15, 5.</Text> : null}
          </Card>
        ) : null}

        {(s.persona && !hidden('persona')) || (mayControl && s.proactivity && !hidden('proactivity')) ? (
          <Card title="Personality" testID="card-personality">
            {s.persona && !hidden('persona') ? (
              <Choice
                label="Persona"
                options={s.persona.options.map((o) => ({ id: o.id, text: o.label }))}
                current={s.persona.current}
                onPick={mayControl ? (id) => void s.setPersona(id) : undefined}
              />
            ) : null}
            {mayControl && s.proactivity && !hidden('proactivity') ? (
              <Choice
                label="Speaks up"
                options={s.proactivity.options.map((o) => ({ id: o, text: o[0]?.toUpperCase() + o.slice(1) }))}
                current={s.proactivity.level}
                onPick={(id) => void s.setProactivity(id)}
              />
            ) : null}
          </Card>
        ) : null}

        {mayControl && s.activity && !hidden('activity') ? (
          <Card title="Recent activity" testID="card-activity">
            {s.activity.length === 0 ? <Text style={styles.muted}>Nothing yet.</Text> : null}
            {s.activity.map((a) => (
              <View key={a.id} style={styles.activity} accessible accessibilityLabel={`${a.tools.map((t) => t.name).join(', ') || 'chat'}, ${formatDuration(a.totalMs)}`}>
                <Text style={styles.taskText}>{a.tools.map((t) => (t.ok ? t.name : `${t.name} (failed)`)).join(', ') || 'chat only'}</Text>
                <Text style={styles.muted}>{formatDuration(a.totalMs)}</Text>
              </View>
            ))}
          </Card>
        ) : null}

        <Text style={styles.note}>Shutdown, auto-approve, unmuting, saved memories and device management are done on the Pi itself.</Text>
      </ScrollView>
    </View>
  );
}

function Card({ title, children, testID }: { title: string; children: ReactNode; testID?: string }) {
  return (
    <View style={styles.card} testID={testID}>
      <Text accessibilityRole="header" style={styles.cardTitle}>
        {title}
      </Text>
      {children}
    </View>
  );
}

function Row({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <View style={styles.row} accessible accessibilityLabel={`${label}: ${value}`}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, warn && styles.warn]}>{value}</Text>
    </View>
  );
}

function Choice({ label, options, current, onPick }: { label: string; options: { id: string; text: string }[]; current: string | null; onPick?: (id: string) => void }) {
  return (
    <View style={styles.choice}>
      <Text style={styles.rowLabel}>{label}</Text>
      <View style={styles.chips} accessibilityRole="radiogroup">
        {options.map((o) => {
          const selected = o.id === current;
          return (
            <Pressable
              key={o.id}
              accessibilityRole="radio"
              accessibilityLabel={`${label}: ${o.text}`}
              accessibilityState={{ selected, disabled: !onPick }}
              disabled={!onPick}
              onPress={() => onPick?.(o.id)}
              style={[styles.chip, selected && styles.chipOn]}
            >
              <Text style={[styles.chipText, selected && styles.chipTextOn]}>{o.text}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: spacing.lg },
  flex: { flex: 1 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: spacing.sm },
  back: { minHeight: touch.min, justifyContent: 'center', paddingRight: spacing.sm },
  backText: { ...font.button, color: colors.text },
  gear: { width: touch.min, height: touch.min, alignItems: 'center', justifyContent: 'center' },
  gearText: { fontSize: 26, color: colors.text },
  content: { gap: spacing.lg, paddingVertical: spacing.md, paddingBottom: spacing.xxl },
  title: { ...font.title, color: colors.text },
  muted: { ...font.body, color: colors.muted },
  note: { ...font.caption, color: colors.muted },
  problem: { ...font.caption, color: colors.dangerSoft },
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.lg, gap: spacing.md },
  cardTitle: { ...font.heading, color: colors.text },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: spacing.md },
  rowLabel: { ...font.label, color: colors.muted },
  rowValue: { ...font.body, color: colors.text, flexShrink: 1, textAlign: 'right' },
  warn: { color: colors.warn },
  task: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: touch.min },
  box: { width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: colors.muted },
  taskText: { ...font.body, color: colors.text, flex: 1 },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  input: { flex: 1, minHeight: touch.button, borderRadius: radius.pill, backgroundColor: colors.surfaceHigh, color: colors.text, paddingHorizontal: spacing.lg, ...font.body },
  activity: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md, minHeight: 32, alignItems: 'center' },
  choice: { gap: spacing.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: { minHeight: touch.min, paddingHorizontal: spacing.lg, borderRadius: radius.pill, backgroundColor: colors.surfaceHigh, alignItems: 'center', justifyContent: 'center' },
  chipOn: { backgroundColor: colors.accent },
  chipText: { ...font.label, color: colors.text },
  chipTextOn: { color: colors.onAccent },
});
