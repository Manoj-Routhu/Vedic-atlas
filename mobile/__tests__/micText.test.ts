import { inLanguage, languageName } from '../src/features/language/micText';
import { MIC_MESSAGES } from '../src/features/look/lookStore';

describe('mic messages in the chosen language', () => {
  it('English text is returned as written', () => {
    expect(inLanguage(MIC_MESSAGES.speechPackMissing, 'en')).toBe(MIC_MESSAGES.speechPackMissing);
  });

  it('Hindi chat names Hindi where the message names the speech pack', () => {
    expect(inLanguage(MIC_MESSAGES.speechPackMissing, 'hi')).toContain('offline Hindi speech');
    expect(inLanguage(MIC_MESSAGES.speechPackMissing, 'hi')).not.toContain('English');
    expect(inLanguage('download English (US).', 'hi')).toBe('download Hindi.');
    expect(inLanguage('Asking your phone to download offline English speech…', 'hi')).toBe('Asking your phone to download offline Hindi speech…');
  });

  it('messages that name no language are unchanged', () => {
    expect(inLanguage(MIC_MESSAGES.nothing, 'hi')).toBe(MIC_MESSAGES.nothing);
  });

  it('names the languages', () => {
    expect([languageName('en'), languageName('hi')]).toEqual(['English', 'Hindi']);
  });
});
