import type { ApiError } from '../../api/errors';
import type { PiApi } from '../../api/pi';
import type { QueueListener } from '../../speech/speechQueue';

/** A photo ready to send: already resized, with its bytes in memory. `discard` deletes the file; nothing keeps photos around. */
export type Photo = { uri: string; width: number; height: number; bytes: Uint8Array; discard: () => void };

export type SpeechPort = {
  enqueue(text: string, tag?: number | null): void;
  stop(): void;
  readonly isSpeaking: boolean;
};

/** `speechPackMissing`: the phone can recognise English on its own, but has not downloaded that offline language yet. */
export type MicProblem = 'denied' | 'unavailable' | 'nothing' | 'speechPackMissing';

/** What asking the phone to download the offline language led to. */
export type SpeechPackResult = 'ready' | 'scheduled' | 'dialog';

export type RecognizerListener = {
  /** The words heard so far (changes while the user is still speaking). */
  onPartial(text: string): void;
  /** Recognition ended: everything that was heard, possibly empty. Called once. */
  onFinal(text: string): void;
  /** `detail` is the speech service's own wording, kept for diagnosis. */
  onError(problem: MicProblem, detail?: string): void;
};

/** Speech to text on the phone. `stop` ends listening and leads to `onFinal`; `cancel` drops everything quietly. */
export type Recognizer = {
  start(listener: RecognizerListener): Promise<void>;
  stop(): void;
  cancel(): void;
  /** Ask the phone to download the offline language once (needs Wi-Fi; no voice is sent). Absent where it cannot be done. */
  downloadSpeechPack?(): Promise<SpeechPackResult>;
};

/** Small physical confirmations (vibration). Never required for the flow to work. */
export type Feedback = { capture(): void; success(): void; failure(): void };

export type Timing = {
  /** After this long without any answer text, say "Looking." once. */
  lookingCueMs: number;
  /** At each of these, say "Still looking." and show it on screen. */
  slowCueMs: number[];
  /** How long to wait before the one retry when the model is busy, if the Pi did not say. */
  busyRetryDefaultMs: number;
  busyRetryMaxMs: number;
};

export const DEFAULT_TIMING: Timing = {
  lookingCueMs: 1_200,
  slowCueMs: [12_000, 30_000],
  busyRetryDefaultMs: 5_000,
  busyRetryMaxMs: 10_000,
};

export type LookDeps = {
  getApi: () => PiApi | null;
  takePhoto: () => Promise<Photo>;
  makeSpeech: (listener: QueueListener) => SpeechPort;
  /** Turns the user's spoken question into text. Without one the microphone is simply not offered. */
  recognizer?: Recognizer;
  feedback: Feedback;
  /** Told about every failure, so the connection can react (a removed phone, an unreachable Pi). */
  onApiError?: (e: ApiError) => void;
  timing?: Partial<Timing>;
};
