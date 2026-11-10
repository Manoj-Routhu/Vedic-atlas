import type { HindiPackStatus, LanguagePacks } from '../src/speech/languagePacks';
import { createLanguageSetup } from '../src/features/language/languageSetup';

type Question = { title: string; message: string; ok: string; cancel: string };

function setup(
  status: HindiPackStatus,
  opts: { answer?: boolean; dismissed?: boolean; voiceScreen?: 'opened' | 'unavailable'; recognition?: 'ready' | 'scheduled' | 'dialog' | 'throw' } = {},
) {
  let current = status;
  let dismissed = opts.dismissed ?? false;
  const packs = {
    status: jest.fn(async () => current),
    installVoice: jest.fn(async () => opts.voiceScreen ?? 'opened'),
    installRecognition: jest.fn(async () => {
      if (opts.recognition === 'throw') throw new Error('no');
      return opts.recognition ?? 'dialog';
    }),
  } satisfies LanguagePacks;
  const confirm = jest.fn(async (_q: Question) => opts.answer ?? true);
  const inform = jest.fn();
  const store = createLanguageSetup({ packs, confirm, inform, dismissed: () => dismissed, setDismissed: (v) => (dismissed = v) });
  return { store, packs, confirm, inform, isDismissed: () => dismissed, install: (s: HindiPackStatus) => (current = s) };
}

const MISSING: HindiPackStatus = { voice: false, recognition: false };

describe('turning Hindi on (setUp)', () => {
  it('asks once, listing both downloads, then starts both', async () => {
    const t = setup(MISSING);
    await t.store.getState().setUp();
    expect(t.confirm).toHaveBeenCalledTimes(1);
    const q = t.confirm.mock.calls[0]?.[0];
    expect(q?.title).toBe('Hindi needs two downloads');
    expect(q?.message).toMatch(/Hindi speech pack/);
    expect(q?.message).toMatch(/Hindi voice/);
    expect(t.packs.installRecognition).toHaveBeenCalledTimes(1);
    expect(t.packs.installVoice).toHaveBeenCalledTimes(1);
    expect(t.store.getState().working).toBe(false);
  });

  it('asks only for what is missing', async () => {
    const voiceOnly = setup({ voice: false, recognition: true });
    await voiceOnly.store.getState().setUp();
    expect(voiceOnly.confirm.mock.calls[0]?.[0].title).toBe('Hindi voice needed');
    expect(voiceOnly.packs.installRecognition).not.toHaveBeenCalled();
    expect(voiceOnly.packs.installVoice).toHaveBeenCalled();

    const listenOnly = setup({ voice: true, recognition: false });
    await listenOnly.store.getState().setUp();
    expect(listenOnly.confirm.mock.calls[0]?.[0].title).toBe('Hindi speech needed');
    expect(listenOnly.packs.installVoice).not.toHaveBeenCalled();
  });

  it('does not ask when Hindi is ready, and says so', async () => {
    const t = setup({ voice: true, recognition: true });
    await t.store.getState().setUp();
    expect(t.confirm).not.toHaveBeenCalled();
    expect(t.store.getState().note).toBe('Hindi is ready.');
  });

  it('does not guess when the phone cannot tell, and does not ask', async () => {
    const t = setup({ voice: null, recognition: null });
    await t.store.getState().setUp();
    expect(t.confirm).not.toHaveBeenCalled();
    expect(t.store.getState().note).toMatch(/Couldn't check/);
  });

  it('"Not now" downloads nothing and leaves the way back in Settings', async () => {
    const t = setup(MISSING, { answer: false });
    await t.store.getState().setUp();
    expect(t.packs.installRecognition).not.toHaveBeenCalled();
    expect(t.packs.installVoice).not.toHaveBeenCalled();
    expect(t.store.getState().note).toMatch(/start it here any time/);
  });

  it('a failed speech download is explained in plain words and the voice is still offered', async () => {
    const t = setup(MISSING, { recognition: 'throw' });
    await t.store.getState().setUp();
    expect(t.store.getState().note).toMatch(/would not start the Hindi speech download/);
    expect(t.packs.installVoice).toHaveBeenCalled();
  });

  it('a phone with no voice screen gets the by-hand steps', async () => {
    const t = setup({ voice: false, recognition: true }, { voiceScreen: 'unavailable' });
    await t.store.getState().setUp();
    expect(t.inform).toHaveBeenCalledWith('Add the Hindi voice by hand', expect.stringMatching(/Install voice data/));
  });

  it('forgets an earlier "Not now"', async () => {
    const t = setup(MISSING, { dismissed: true });
    await t.store.getState().setUp();
    expect(t.isDismissed()).toBe(false);
  });

  it('ignores a second press while it is working', async () => {
    const t = setup(MISSING);
    await Promise.all([t.store.getState().setUp(), t.store.getState().setUp()]);
    expect(t.confirm).toHaveBeenCalledTimes(1);
  });
});

describe('a Hindi reply with no Hindi voice (offerVoiceForReply)', () => {
  it('offers the voice, and downloads it on Download', async () => {
    const t = setup(MISSING);
    await t.store.getState().offerVoiceForReply();
    expect(t.confirm).toHaveBeenCalledTimes(1);
    expect(t.confirm.mock.calls[0]?.[0]).toMatchObject({ title: 'Hindi voice needed', ok: 'Download', cancel: 'Not now' });
    expect(t.packs.installVoice).toHaveBeenCalled();
    expect(t.packs.installRecognition).not.toHaveBeenCalled();
  });

  it('asks only once per app session, however many Hindi sentences arrive', async () => {
    const t = setup(MISSING);
    await Promise.all([t.store.getState().offerVoiceForReply(), t.store.getState().offerVoiceForReply(), t.store.getState().offerVoiceForReply()]);
    await t.store.getState().offerVoiceForReply();
    expect(t.confirm).toHaveBeenCalledTimes(1);
  });

  it('"Not now" is remembered and never asked again on its own', async () => {
    const t = setup(MISSING, { answer: false });
    await t.store.getState().offerVoiceForReply();
    expect(t.isDismissed()).toBe(true);
    const later = setup(MISSING, { dismissed: true });
    await later.store.getState().offerVoiceForReply();
    expect(later.confirm).not.toHaveBeenCalled();
  });

  it('does not ask when the voice is installed, or when the phone cannot tell', async () => {
    const has = setup({ voice: true, recognition: null });
    await has.store.getState().offerVoiceForReply();
    const unknown = setup({ voice: null, recognition: null });
    await unknown.store.getState().offerVoiceForReply();
    expect(has.confirm).not.toHaveBeenCalled();
    expect(unknown.confirm).not.toHaveBeenCalled();
  });

  it('the speaker may use the voice only once it is known to be installed, and sees a finished download on refresh', async () => {
    const t = setup(MISSING);
    expect(t.store.getState().hindiVoiceReady()).toBe(false); // not checked yet
    await t.store.getState().refresh();
    expect(t.store.getState().hindiVoiceReady()).toBe(false);
    t.install({ voice: true, recognition: true });
    await t.store.getState().refresh();
    expect(t.store.getState().hindiVoiceReady()).toBe(true);
  });
});
