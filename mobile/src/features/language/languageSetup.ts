import { createStore } from 'zustand/vanilla';

import type { HindiPackStatus, LanguagePacks } from '../../speech/languagePacks';
import type { SpeechPackResult } from '../look/ports';

/** A yes/no question to the user. The app shows a system dialog; tests answer directly. */
export type Confirm = (q: { title: string; message: string; ok: string; cancel: string }) => Promise<boolean>;

export type SetupDeps = {
  packs: LanguagePacks;
  confirm: Confirm;
  /** Tell the user something and nothing else (no choice). */
  inform: (title: string, message: string) => void;
  /** Saved choices: the "Not now" memory. */
  dismissed: () => boolean;
  setDismissed: (value: boolean) => void;
};

export type LanguageState = {
  /** What the phone has for Hindi. `null`: not checked yet, or the phone would not say. */
  status: HindiPackStatus;
  /** A download is being started. */
  working: boolean;
  /** One line about the last install attempt, for the Settings screen. */
  note: string | null;
};

export type LanguageActions = {
  refresh(): Promise<HindiPackStatus>;
  /** The Hindi voice is installed (the answer to "may the speaker use it", known without waiting). */
  hindiVoiceReady(): boolean;
  /**
   * Hindi was just switched on, or the user pressed Download in Settings: ask for whatever is missing, with one dialog.
   * Forgets an earlier "Not now".
   */
  setUp(): Promise<void>;
  /**
   * A Hindi reply is on screen and the phone cannot read it aloud. Offers the voice once; "Not now" is remembered, and the
   * offer then stays in Settings only. Does nothing when the voice is there, or the phone cannot tell.
   */
  offerVoiceForReply(): Promise<void>;
};

const VOICE_TEXT = "To hear Veda in Hindi, your phone needs the Hindi voice. Android will open its voice download screen: pick Hindi there.";
const LISTEN_TEXT = 'To talk to Veda in Hindi, your phone needs the Hindi speech pack. It downloads once over Wi-Fi, and your voice is never sent anywhere.';

export function createLanguageSetup(deps: SetupDeps) {
  let askedForReply = false; // one reply offer per app session, however many Hindi sentences arrive
  let asking = false;

  return createStore<LanguageState & LanguageActions>((set, get) => {
    const installRecognition = async (): Promise<string> => {
      let result: SpeechPackResult;
      try {
        result = await deps.packs.installRecognition();
      } catch {
        return 'Your phone would not start the Hindi speech download. In the Google app: Settings, Voice, Offline speech recognition, Hindi.';
      }
      return result === 'ready'
        ? 'Hindi speech is ready.'
        : result === 'scheduled'
          ? 'The Hindi speech download will finish on Wi-Fi.'
          : "Follow your phone's download prompt for Hindi speech.";
    };

    const installVoice = async (): Promise<string> => {
      if ((await deps.packs.installVoice()) === 'opened') return 'Pick Hindi on the voice download screen, then come back.';
      deps.inform(
        'Add the Hindi voice by hand',
        "This phone has no voice download screen to open. Open Settings, search for Text-to-speech, tap the gear next to your speech engine, choose Install voice data, then Hindi.",
      );
      return 'Add the Hindi voice in your phone settings (Text-to-speech).';
    };

    return {
      status: { voice: null, recognition: null },
      working: false,
      note: null,

      async refresh() {
        const status = await deps.packs.status();
        set({ status });
        return status;
      },

      hindiVoiceReady: () => get().status.voice === true,

      async setUp() {
        if (get().working) return;
        deps.setDismissed(false);
        set({ working: true, note: null });
        try {
          const status = await get().refresh();
          const needVoice = status.voice === false;
          const needListen = status.recognition === false;
          if (!needVoice && !needListen) {
            set({ note: status.voice === null && status.recognition === null ? "Couldn't check this phone's Hindi. Hindi works if it has the voice and the speech pack." : 'Hindi is ready.' });
            return;
          }
          const parts = [needListen ? LISTEN_TEXT : '', needVoice ? VOICE_TEXT : ''].filter(Boolean);
          const title = needVoice && needListen ? 'Hindi needs two downloads' : needVoice ? 'Hindi voice needed' : 'Hindi speech needed';
          const go = await deps.confirm({ title, message: parts.join('\n\n'), ok: 'Download', cancel: 'Not now' });
          if (!go) {
            set({ note: 'Hindi is on, but the download is still needed. You can start it here any time.' });
            return;
          }
          const notes: string[] = [];
          if (needListen) notes.push(await installRecognition());
          if (needVoice) notes.push(await installVoice());
          set({ note: notes.join(' ') });
        } finally {
          set({ working: false });
        }
      },

      async offerVoiceForReply() {
        if (asking || askedForReply || deps.dismissed()) return;
        asking = true;
        try {
          const status = get().status.voice === null ? await get().refresh() : get().status;
          if (status.voice !== false) return; // there, or the phone cannot tell: do not nag
          askedForReply = true;
          const go = await deps.confirm({ title: 'Hindi voice needed', message: VOICE_TEXT, ok: 'Download', cancel: 'Not now' });
          if (!go) {
            deps.setDismissed(true);
            return;
          }
          set({ note: await installVoice() });
        } finally {
          asking = false;
        }
      },
    };
  });
}

export type LanguageSetup = ReturnType<typeof createLanguageSetup>;
