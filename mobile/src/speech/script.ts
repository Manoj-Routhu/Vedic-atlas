/** Which script a piece of text is written in. The Pi picks its voice the same way (domain/policies/language_policy.py). */

const DEVANAGARI = /[ऀ-ॿ]/;

/** True when the text has any Devanagari (Hindi) character. */
export function hasDevanagari(text: string): boolean {
  return DEVANAGARI.test(text);
}
