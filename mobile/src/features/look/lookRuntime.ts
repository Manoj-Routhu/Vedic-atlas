import type { CameraView } from 'expo-camera';
import { createRef } from 'react';

import { preparePhoto } from '../../camera/photoPipeline';
import { hapticFeedback } from '../../platform/feedback';
import { ExpoRecognizer } from '../../speech/expoRecognizer';
import { ExpoSpeaker } from '../../speech/expoSpeaker';
import { SpeechQueue } from '../../speech/speechQueue';
import { connectionStore } from '../../state/connection';
import { preferencesStore } from '../../state/preferences';
import { createLookStore } from './lookStore';

/** The live camera the Look screen mounts; the store takes the photo through it. */
export const cameraRef = createRef<CameraView>();

/** The app's one Look session. It outlives the screen, so opening Settings and coming back keeps the photo and answer. */
export const lookStore = createLookStore({
  getApi: () => connectionStore.getState().api(),
  takePhoto: async () => {
    const camera = cameraRef.current;
    if (!camera) throw new Error('camera not ready');
    const raw = await camera.takePictureAsync({ quality: 0.9, shutterSound: false });
    return preparePhoto(raw);
  },
  makeSpeech: (listener) => new SpeechQueue(new ExpoSpeaker('en-US', () => preferencesStore.getState().prefs), listener),
  recognizer: new ExpoRecognizer(),
  feedback: hapticFeedback,
  onApiError: (e) => connectionStore.getState().handleError(e),
});

// The mode Look starts in follows Settings: once the saved choice is read, and whenever it is changed.
preferencesStore.subscribe((state, previous) => {
  if (state.prefs.lookStyle !== previous.prefs.lookStyle) lookStore.setState({ style: state.prefs.lookStyle });
});
