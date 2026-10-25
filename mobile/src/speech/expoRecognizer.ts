import { ExpoSpeechRecognitionModule } from 'expo-speech-recognition';

import type { MicProblem, Recognizer, RecognizerListener } from '../features/look/ports';

type Subscription = { remove(): void };

/** What the Android recognizer calls its failures, in the words the user should get. */
export function problemFromError(code: string): MicProblem {
  if (code === 'no-speech' || code === 'speech-timeout') return 'nothing';
  if (code === 'not-allowed' || code === 'service-not-allowed') return 'denied';
  return 'unavailable';
}

/**
 * Speech to text on the phone (English). It prefers the on-device model, so a question never leaves the phone when the
 * phone can do it locally. The microphone is asked for the first time the button is held.
 */
export class ExpoRecognizer implements Recognizer {
  private subscriptions: Subscription[] = [];
  private heard = '';
  private stopRequested = false;
  private run = 0;
  private trace: string[] = [];
  private began = 0;

  async start(listener: RecognizerListener): Promise<void> {
    this.release();
    const run = ++this.run;
    this.stopRequested = false;
    this.heard = '';
    this.trace = [];
    this.began = Date.now();

    const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (run !== this.run) return; // cancelled while the permission dialog was open
    if (!permission.granted) return listener.onError('denied');
    if (!ExpoSpeechRecognitionModule.isRecognitionAvailable()) return listener.onError('unavailable', 'no speech service on this phone');
    if (this.stopRequested) return listener.onFinal(''); // let go before the microphone could open

    const module = ExpoSpeechRecognitionModule;
    this.subscriptions = [
      module.addListener('start', () => this.note('start')),
      module.addListener('audiostart', () => this.note('audio on')),
      module.addListener('speechstart', () => this.note('speech')),
      module.addListener('audioend', () => this.note('audio off')),
      module.addListener('result', (event) => {
        this.note(`text "${(event.results[0]?.transcript ?? '').slice(0, 12)}"`);
        this.heard = event.results[0]?.transcript ?? this.heard;
        listener.onPartial(this.heard);
      }),
      module.addListener('error', (event) => {
        this.note(`error ${event.error}${event.message ? ` ${event.message}` : ''}`);
        const detail = this.summary();
        this.release();
        listener.onError(problemFromError(event.error), detail);
      }),
      module.addListener('end', () => {
        this.note('end');
        const text = this.heard;
        const detail = this.summary();
        this.release();
        if (text.trim() === '') listener.onError('nothing', detail);
        else listener.onFinal(text);
      }),
    ];
    module.start({
      lang: 'en-US',
      interimResults: true,
      continuous: false,
      requiresOnDeviceRecognition: module.supportsOnDeviceRecognition(),
    });
  }

  stop(): void {
    this.stopRequested = true;
    if (this.subscriptions.length > 0) ExpoSpeechRecognitionModule.stop();
  }

  cancel(): void {
    this.run++;
    this.release();
    try {
      ExpoSpeechRecognitionModule.abort();
    } catch {
      // nothing was running
    }
  }

  private note(what: string) {
    this.trace.push(`${what} ${Date.now() - this.began}ms`);
  }

  /** What the speech service reported, in order, for the error banner: "start 40ms, audio on 90ms, end 130ms". */
  private summary() {
    return this.trace.join(', ').slice(0, 220);
  }

  private release() {
    this.subscriptions.forEach((s) => s.remove());
    this.subscriptions = [];
  }
}
