import type { ApiError } from '../../api/errors';
import type { PiApi } from '../../api/pi';
import type { PendingApproval } from '../../api/types';
import type { Recognizer, SpeechPort } from '../look/ports';

export type ChatTiming = {
  /** How often to look for approvals while a reply is being written. */
  pollBusyMs: number;
  /** ... and otherwise. */
  pollIdleMs: number;
};

export const DEFAULT_CHAT_TIMING: ChatTiming = { pollBusyMs: 2_000, pollIdleMs: 10_000 };

export type ChatDeps = {
  getApi: () => PiApi | null;
  /** Created the first time the voice is needed. */
  makeSpeech: () => SpeechPort;
  /** Turns the user's spoken message into text. Without one the microphone is simply not offered. */
  recognizer?: Recognizer;
  /** Told about every failure so the connection can react (a removed phone, an unreachable Pi). */
  onApiError?: (e: ApiError) => void;
  /** New approvals have appeared: say so out loud and vibrate (the screen is in front). */
  notify?: (approvals: PendingApproval[]) => void;
  timing?: Partial<ChatTiming>;
};
