import type { Language } from '../state/preferences';

/** The recognizer's locale for the language chosen in Settings. */
export const localeFor = (language: Language) => (language === 'hi' ? 'hi-IN' : 'en-US');
