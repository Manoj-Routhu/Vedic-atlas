import * as Speech from 'expo-speech';

import type { SpeakCallbacks, Speaker } from './speechQueue';

export type VoiceSettings = { speechRate: number; speechPitch: number };

/**
 * Android text-to-speech through expo-speech. Its native queue plays utterances back to back without gaps.
 * `voice` is read at each sentence, so a change in Settings applies to the very next one.
 */
export class ExpoSpeaker implements Speaker {
  constructor(
    private readonly language = 'en-US',
    private readonly voice?: () => VoiceSettings,
  ) {}

  speak(text: string, cb: SpeakCallbacks) {
    const settings = this.voice?.();
    Speech.speak(text, {
      language: this.language,
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
