import { hapticFeedback } from '../../platform/feedback';
import { ExpoRecognizer } from '../../speech/expoRecognizer';
import { ExpoSpeaker } from '../../speech/expoSpeaker';
import { SpeechQueue } from '../../speech/speechQueue';
import { connectionStore } from '../../state/connection';
import { preferencesStore } from '../../state/preferences';
import { createChatStore } from './chatStore';

/** The app's one chat session. It outlives the screen, so leaving and coming back keeps the conversation on screen. */
export const chatStore = createChatStore({
  getApi: () => connectionStore.getState().api(),
  makeSpeech: () => new SpeechQueue(new ExpoSpeaker('en-US', () => preferencesStore.getState().prefs)),
  recognizer: new ExpoRecognizer(),
  onApiError: (e) => connectionStore.getState().handleError(e),
  notify: (approvals) => {
    hapticFeedback.capture();
    const first = approvals[0];
    if (first) new ExpoSpeaker('en-US', () => preferencesStore.getState().prefs).speak(`Veda needs your approval. ${first.summary}`, { onStart: () => undefined, onDone: () => undefined, onError: () => undefined });
  },
});
