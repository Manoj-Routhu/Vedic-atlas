/**
 * Speaks sentences one after another and tells the screen which one is being spoken.
 *
 * It sits on a `Speaker` (Android's text-to-speech in the app, a fake in tests). The speaker queues utterances itself, which
 * is gapless; this class adds what the screen needs: a tag per sentence for the highlight, "is anything still being said",
 * and a stop that really stops (callbacks from an utterance that was stopped are ignored).
 */

export type SpeakCallbacks = {
  onStart: () => void;
  onDone: () => void;
  onError: (error: unknown) => void;
};

export interface Speaker {
  speak(text: string, callbacks: SpeakCallbacks): void;
  /** Interrupt the current utterance and drop everything queued. */
  stop(): void;
}

export type QueueListener = {
  /** The sentence with this tag has started being spoken (null: nothing is being spoken now). */
  onActive?: (tag: number | null) => void;
  /** Everything queued has been spoken (or failed), and nothing is pending. */
  onIdle?: () => void;
  /** An utterance failed (for example no speech engine is installed). The text is still on screen. */
  onError?: (error: unknown) => void;
};

export class SpeechQueue {
  private pendingCount = 0;
  private generation = 0;
  private activeTag: number | null = null;

  constructor(private readonly speaker: Speaker, private readonly listener: QueueListener = {}) {}

  get isSpeaking(): boolean {
    return this.pendingCount > 0;
  }

  /** Queue one sentence. `tag` identifies it in `onActive` (the screen uses the sentence's position). */
  enqueue(text: string, tag: number | null = null): void {
    const spoken = text.trim();
    if (!spoken) return;
    const mine = this.generation;
    this.pendingCount++;
    let finished = false;
    const finish = () => {
      if (finished || mine !== this.generation) return; // stopped meanwhile: stale callback
      finished = true;
      this.pendingCount = Math.max(0, this.pendingCount - 1);
      if (this.activeTag === tag) {
        this.activeTag = null;
        this.listener.onActive?.(null);
      }
      if (this.pendingCount === 0) this.listener.onIdle?.();
    };
    this.speaker.speak(spoken, {
      onStart: () => {
        if (mine !== this.generation) return;
        this.activeTag = tag;
        this.listener.onActive?.(tag);
      },
      onDone: finish,
      onError: (e) => {
        if (mine !== this.generation) return;
        this.listener.onError?.(e);
        finish();
      },
    });
  }

  /** Stop speaking now and forget everything queued. Safe to call when idle. */
  stop(): void {
    if (this.pendingCount === 0 && this.activeTag === null) return;
    this.generation++;
    this.pendingCount = 0;
    this.speaker.stop();
    if (this.activeTag !== null) {
      this.activeTag = null;
      this.listener.onActive?.(null);
    }
  }
}
