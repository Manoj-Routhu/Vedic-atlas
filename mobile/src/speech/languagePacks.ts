import { Linking } from 'react-native';
import * as Speech from 'expo-speech';
import { ExpoSpeechRecognitionModule } from 'expo-speech-recognition';

import type { SpeechPackResult } from '../features/look/ports';

/** What the phone has for Hindi. `null`: the phone would not say (old Android, no speech service), so do not guess. */
export type HindiPackStatus = { voice: boolean | null; recognition: boolean | null };

/** The Hindi language data on the phone: what is installed, and how to ask Android to install what is not. */
export interface LanguagePacks {
  status(): Promise<HindiPackStatus>;
  /** Open Android's own screen for installing text-to-speech voice data. `unavailable`: this phone has no such screen. */
  installVoice(): Promise<'opened' | 'unavailable'>;
  /** Ask the phone to download the offline Hindi speech recognizer (Android 13+; Android shows its own dialog). */
  installRecognition(): Promise<SpeechPackResult>;
}

export const HINDI_LOCALE = 'hi-IN';
const INSTALL_TTS_DATA = 'android.speech.tts.engine.INSTALL_TTS_DATA';

const isHindi = (language: string) => language.toLowerCase().replace('_', '-').startsWith('hi');

/**
 * Android never installs a language silently, so the app asks and Android does the download:
 *  - recognition (you speaking Hindi): expo-speech-recognition's offline model download, with Android's own dialog;
 *  - voice (the phone reading Hindi): expo-speech has no install call, so the system's install-voice-data screen is opened.
 */
export class ExpoLanguagePacks implements LanguagePacks {
  async status(): Promise<HindiPackStatus> {
    return { voice: await this.hasVoice(), recognition: await this.hasRecognition() };
  }

  private async hasVoice(): Promise<boolean | null> {
    try {
      const voices = await Speech.getAvailableVoicesAsync();
      return voices.some((v) => isHindi(v.language));
    } catch {
      return null;
    }
  }

  private async hasRecognition(): Promise<boolean | null> {
    try {
      const { installedLocales } = await ExpoSpeechRecognitionModule.getSupportedLocales({});
      // Android 12 and below answer with an empty list whatever is installed: that is "don't know", not "none".
      if (installedLocales.length === 0) return null;
      return installedLocales.some(isHindi);
    } catch {
      return null;
    }
  }

  async installVoice(): Promise<'opened' | 'unavailable'> {
    try {
      await Linking.sendIntent(INSTALL_TTS_DATA);
      return 'opened';
    } catch {
      return 'unavailable';
    }
  }

  async installRecognition(): Promise<SpeechPackResult> {
    const { status } = await ExpoSpeechRecognitionModule.androidTriggerOfflineModelDownload({ locale: HINDI_LOCALE });
    return status === 'download_success' ? 'ready' : status === 'download_scheduled' ? 'scheduled' : 'dialog';
  }
}
