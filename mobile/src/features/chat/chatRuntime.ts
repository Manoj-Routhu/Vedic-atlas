import { hapticFeedback } from '../../platform/feedback';
import { ExpoRecognizer } from '../../speech/expoRecognizer';
import { ExpoSpeaker } from '../../speech/expoSpeaker';
import { localeFor } from '../../speech/locale';
import { SpeechQueue } from '../../speech/speechQueue';
import { connectionStore } from '../../state/connection';
import { preferencesStore, type Language } from '../../state/preferences';
import { languageSetup } from '../language/languageRuntime';
import { createChatStore } from './chatStore';

const language = (): Language => preferencesStore.getState().prefs.language;
/** Chat reads English and Hindi: a Devanagari sentence goes to the Hindi voice, or is skipped (and the voice offered) if it is not installed. */
const hindi = { ready: () => languageSetup.getState().hindiVoiceReady(), onMissing: () => void languageSetup.getState().offerVoiceForReply() };

/** The app's one chat session. It outlives the screen, so leaving and coming back keeps the conversation on screen. */
export const chatStore = createChatStore({
  getApi: () => connectionStore.getState().api(),
  makeSpeech: () => new SpeechQueue(new ExpoSpeaker('en-US', () => preferencesStore.getState().prefs, hindi)),
  recognizer: new ExpoRecognizer(() => localeFor(language())),
  language,
  onHindiText: () => void languageSetup.getState().offerVoiceForReply(),
  onApiError: (e) => connectionStore.getState().handleError(e),
  notify: (approvals) => {
    hapticFeedback.capture();
    const first = approvals[0];
    if (first) new ExpoSpeaker('en-US', () => preferencesStore.getState().prefs).speak(`Veda needs your approval. ${first.summary}`, { onStart: () => undefined, onDone: () => undefined, onError: () => undefined });
  },
});
