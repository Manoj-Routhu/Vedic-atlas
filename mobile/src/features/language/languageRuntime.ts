import { useStore } from 'zustand';
import { Alert, AppState } from 'react-native';

import { ExpoLanguagePacks } from '../../speech/languagePacks';
import { preferencesStore } from '../../state/preferences';
import { createLanguageSetup, type Confirm, type LanguageActions, type LanguageState } from './languageSetup';

const confirm: Confirm = ({ title, message, ok, cancel }) =>
  new Promise<boolean>((resolve) => {
    Alert.alert(title, message, [{ text: cancel, style: 'cancel', onPress: () => resolve(false) }, { text: ok, onPress: () => resolve(true) }], {
      cancelable: true,
      onDismiss: () => resolve(false),
    });
  });

/** What the phone has for Hindi, and the dialogs that ask for it. One for the whole app. */
export const languageSetup = createLanguageSetup({
  packs: new ExpoLanguagePacks(),
  confirm,
  inform: (title, message) => Alert.alert(title, message),
  dismissed: () => preferencesStore.getState().prefs.hindiOfferDismissed,
  setDismissed: (value) => void preferencesStore.getState().update({ hindiOfferDismissed: value }),
});

// What is installed changes while the user is on Android's download screens: look again when the app comes back.
AppState.addEventListener('change', (state) => {
  if (state === 'active') void languageSetup.getState().refresh();
});

export function useLanguageSetup<T>(selector: (s: LanguageState & LanguageActions) => T): T {
  return useStore(languageSetup, selector);
}
