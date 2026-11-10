import type { Language } from '../../state/preferences';

/** The name of a language as the mic messages say it. */
export const languageName = (language: Language) => (language === 'hi' ? 'Hindi' : 'English');

/**
 * The mic messages (written once, for English, in Look's store) name the language of the offline speech pack. Chat and Music
 * can listen in Hindi, so they say the language they are actually listening for. English text is returned unchanged.
 */
export function inLanguage(message: string, language: Language): string {
  return language === 'hi' ? message.replace('English (US)', 'Hindi').replace(/English/g, 'Hindi') : message;
}
