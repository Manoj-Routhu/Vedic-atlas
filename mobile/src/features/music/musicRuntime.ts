import { ExpoRecognizer } from '../../speech/expoRecognizer';
import { localeFor } from '../../speech/locale';
import { connectionStore } from '../../state/connection';
import { preferencesStore } from '../../state/preferences';
import { createMusicStore } from './musicStore';

const language = () => preferencesStore.getState().prefs.language;

/** The app's one Music session. It outlives the screen, so switching tabs and coming back keeps what was on screen. */
export const musicStore = createMusicStore({
  getApi: () => connectionStore.getState().api(),
  recognizer: new ExpoRecognizer(() => localeFor(language())),
  language,
  onApiError: (e) => connectionStore.getState().handleError(e),
});
