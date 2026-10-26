import { ExpoRecognizer } from '../../speech/expoRecognizer';
import { connectionStore } from '../../state/connection';
import { createMusicStore } from './musicStore';

/** The app's one Music session. It outlives the screen, so switching tabs and coming back keeps what was on screen. */
export const musicStore = createMusicStore({
  getApi: () => connectionStore.getState().api(),
  recognizer: new ExpoRecognizer(),
  onApiError: (e) => connectionStore.getState().handleError(e),
});
