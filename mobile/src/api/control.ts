import type { ActivityItem, PersonaInfo, PiTask, PrivacyInfo, ProactivityInfo, RemindersInfo, VoiceInfo } from './types';

/**
 * The Control tab's calls. A phone may use these only if it was paired with the matching permission (control, or chat for
 * tasks). The Pi refuses everything else, and has no "unmute" a phone could call: that is deliberate.
 */
export interface ControlApi {
  /** Is auto-approve (yolo) on? A phone can read this but never change it. */
  autoApprove(signal?: AbortSignal): Promise<boolean>;
  privacy(signal?: AbortSignal): Promise<PrivacyInfo>;
  /** Close the Pi's microphone. There is no way to open it again from a phone. */
  mute(signal?: AbortSignal): Promise<PrivacyInfo>;
  voice(signal?: AbortSignal): Promise<VoiceInfo>;

  tasks(signal?: AbortSignal): Promise<PiTask[]>;
  addTask(title: string, signal?: AbortSignal): Promise<PiTask>;
  completeTask(id: number, signal?: AbortSignal): Promise<void>;

  reminders(signal?: AbortSignal): Promise<RemindersInfo>;
  setReminderLeads(minutes: number[], signal?: AbortSignal): Promise<void>;

  persona(signal?: AbortSignal): Promise<PersonaInfo>;
  setPersona(id: string, signal?: AbortSignal): Promise<void>;
  proactivity(signal?: AbortSignal): Promise<ProactivityInfo>;
  setProactivity(level: string, signal?: AbortSignal): Promise<void>;

  activity(limit?: number, signal?: AbortSignal): Promise<ActivityItem[]>;
}
