import * as Speech from 'expo-speech';

import { hasDevanagari } from './script';
import type { SpeakCallbacks, Speaker } from './speechQueue';

export type VoiceSettings = { speechRate: number; speechPitch: number };

/** Hindi speech is opt-in per speaker (Look has none): is the phone's Hindi voice installed, and what to do when it is not. */
export type HindiSupport = { ready: () => boolean; onMissing: () => void };

export const HINDI_VOICE = 'hi-IN';

/**
 * Android text-to-speech through expo-speech. Its native queue plays utterances back to back without gaps.
 * `voice` is read at each sentence, so a change in Settings applies to the very next one.
 *
 * With `hindi` given, a sentence in Devanagari is spoken by the Hindi voice (the Pi picks its voice the same way). If that
 * voice is not installed the sentence is skipped, never read by the English voice, which would garble it; the text stays on
 * screen and `onMissing` lets the app offer the download.
 */
export class ExpoSpeaker implements Speaker {
  constructor(
    private readonly language = 'en-US',
    private readonly voice?: () => VoiceSettings,
    private readonly hindi?: HindiSupport,
  ) {}

  speak(text: string, cb: SpeakCallbacks) {
    let language = this.language;
    if (this.hindi && hasDevanagari(text)) {
      if (!this.hindi.ready()) {
        this.hindi.onMissing();
        cb.onDone(); // nothing to say aloud; the queue moves on
        return;
      }
      language = HINDI_VOICE;
    }
    const settings = this.voice?.();
    Speech.speak(text, {
      language,
      ...(settings ? { rate: settings.speechRate, pitch: settings.speechPitch } : {}),
      onStart: cb.onStart,
      onDone: cb.onDone,
      onStopped: cb.onDone,
      onError: cb.onError,
    });
  }

  stop() {
    void Speech.stop().catch(() => undefined);
  }
}
