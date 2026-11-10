# 18. Chat filler phrases and music seeking (phone app)

Status: **BUILT AND TESTED IN CODE (2026-11-10), NOT YET TRIED ON A REAL PHONE OR PI. See section H for what was built, how it differs from this design, and what is unverified. No APK has been built.**
Builds on `16-mobile-app-design.md` (app) and `17-music-in-the-app.md` (music tab). Two small features, one document:

| # | Feature | Today | After |
|---|---|---|---|
| A | **Filler phrases in the Veda chat** | The voice says "Let me think." / "Still on it." while the model works. The phone chat shows nothing: an empty bubble with "…" until the first word arrives. | The same phrases appear in the chat bubble while Veda works, then disappear when the real reply starts. |
| B | **Seeking in Music** | The player card has a read-only time bar. No way to jump. | Drag the bar, or tap -10 s / +10 s, to move inside the song. |

Both follow the app's existing rule P2 (docs/16): "Never silent, never stuck".

---

## Part A: Filler phrases in the chat

### A1. What exists today (checked in code)

- The phrases live in `src/core/filler.py` (defaults) and `AudioConfig.filler_*` (`schemas/config_schemas.py:289-304`): first phrase after `filler_first_delay_sec` (1 s), then a "still on it" phrase every `filler_repeat_sec` (7 s), at most `filler_max_count` (3). Hindi lists exist and are used when the user spoke Devanagari.
- The **only** code that schedules them is `VoiceSession._speak_fillers` (`service/voice/voice_session.py:996`). It is tied to audio playback (speech lock, cached PCM).
- The phone talks to `POST /api/stream` (`controller/routes/stream.py`). It forwards only the supervisor's text chunks. It knows nothing about fillers, so the phone cannot show them.
- The app's `chatStream` (`mobile/src/api/client.ts:223`) treats **every** SSE `data:` line as reply text and ignores the SSE `event:` name.
- Not to be confused with `domain/policies/reply_filler_policy.py`. That is the opposite thing: it strips "let me know if you need anything else" from replies.

### A2. Options considered

| Option | How | For | Against |
|---|---|---|---|
| **1. The Pi sends them (recommended)** | `/api/stream` emits a named SSE event `filler` on the same schedule as the voice | One source of truth (config + `core/filler.py`); phone and voice behave the same; phrases are tunable in `audio.yaml`; reflects real waiting time | Small protocol addition; one refactor of the voice scheduler |
| 2. The phone invents them | Chat store shows a local phrase after 1 s of silence | No Pi change | A second copy of the phrase lists that will drift; ignores the Pi's config and the Hindi lists |

Recommendation: **option 1**.

### A3. Protocol

SSE already supports named events. A filler is one event:

```
event: filler
data: Let me think.

data: The weather in
data:  Hyderabad is...
...
data: [DONE]
```

- Plain text chunks stay exactly as they are (no `event:` line), so the text path does not change.
- `sse_encode(payload, event=None)` in `controller/sse/encoder.py` gains an optional `event` argument.
- **App side:** `ChatEvent` gains `{ type: 'filler'; text }`. `chatStream` yields it when `sse.event === 'filler'`. Any *other* named event is ignored (not shown as text), so a newer Pi can add event types without breaking the app, the same rule `parseVisionEvent` already follows.
- Old APKs would show a filler as ordinary reply text. Only this one user's phone has the app, and a rebuild is needed for these features anyway, so this is accepted.
- Hindi (decided): the Pi picks the Hindi list when the message is Devanagari, exactly as the voice does (`language_of`), so typing in Devanagari automatically gives Hindi fillers ("सोचने दीजिए।", "अभी भी लगा हूँ।"). The app just displays what it receives. Until Part G is built the phone does not **speak** Hindi fillers (A5): its voice is fixed to English (`expoSpeaker` uses `en-US`) and would garble them. With Part G they are spoken by a Hindi voice.

### A4. Pi side

One refactor, no new concept: pull the timing logic out of the voice session so both callers share it.

```
core/filler.py            (existing: phrase lists, PhrasePicker)
service/agent/filler_schedule.py   NEW
    async def filler_phrases(reply_started: asyncio.Event, *, language, settings) -> AsyncIterator[str]
        # waits first_delay, yields a phrase, waits repeat, yields a "still" phrase... up to max_count
        # stops (returns) the moment reply_started is set
```

- `VoiceSession._speak_fillers` becomes a thin loop: `async for phrase in filler_phrases(...)`: speak it (speech lock, cached PCM stay in the voice session, unchanged behaviour).
- `stream.py` merges two things into one SSE stream: the supervisor's chunks and the filler iterator. The first supervisor chunk sets `reply_started`, which ends the fillers. Implemented with a small `asyncio.Queue` fed by two tasks, both cancelled with the existing `cancel_event` / `watch_disconnect`.
- Settings come from `AudioConfig.filler_*` through a new provider `get_filler_settings(request)` in `controller/dependencies/providers.py`. `filler_max_count: 0` turns the phone fillers off too (one switch for both).
- Fillers are **never** added to the model's history, to saved chat, or to the supervisor's context. They are display-only, so the "model copies the filler into every later reply" problem that `reply_filler_policy` exists to fight cannot happen.
- Layering (per the project conventions): schedule logic in `service/`, no I/O in it; the route only does SSE framing; no new exception code is needed.

### A5. App side

`chatStore.ts`:
- `ChatMessage` gains `filler: string | null`, the phrase currently shown while the reply is empty. The latest filler replaces the previous one.
- On `ev.type === 'filler'`: `patchMessage(replyId, { filler: ev.text })`. On the first `text` event: `filler` is cleared. On `done`/error/stop: cleared.
- **Read aloud (decided):** when "Speak replies" is on, each English filler is also spoken, because waiting is the moment the user most needs to hear that Veda is working. A filler goes through the same `SpeechQueue` as the reply (`getSpeech().enqueue(text)`), so it can never overlap the answer.
  - A filler is spoken only if nothing is being said (`!isSpeaking`); fillers are 7 s apart and about 2 s long, so they do not pile up.
  - When the first reply sentence arrives, a filler that is mid-sentence **finishes first**, then the answer follows. This is the same rule the Pi's voice uses ("a phrase already playing finishes first"). It avoids cutting a word in half.
  - Stop, reset, a new message, or leaving the screen silence them like any other speech (`speech.stop()` is already called on those paths).
  - Hindi (Devanagari) fillers are shown, and spoken by the Hindi phone voice once Part G is built and the voice is installed. Without that voice they are shown but not spoken (never read with the English voice, which garbles them).
  - "Speak replies" off means silent fillers too, one switch for everything the phone says.
- Nothing about fillers is stored: the app keeps no history (P3).

`ChatView.tsx` (the bubble at lines ~139-143 today shows `m.text || '…'`):

```
 Before                    After (while waiting)            After (reply arrives)
 +----------------+        +--------------------------+     +------------------------+
 | …              |        | Let me think.            |     | It is 31 degrees and   |
 +----------------+        |  (grey, italic, ● ● ●)   |     | sunny in Hyderabad. ▍  |
                           +--------------------------+     +------------------------+
```

- Style: muted text colour, italic, with the existing three-dot "working" mark, so it cannot be mistaken for an answer.
- Accessibility: the bubble is a polite live region, so TalkBack announces "Let me think." once and then the answer. A repeated "Still on it." is announced again, which matches what the voice does.
- Demo mode (`api/demo.ts`): the demo `chatStream` yields a filler first, so judges see it without a Pi.

### A6. Tests

- Pi: `tests/test_filler_schedule.py` (first after delay, repeat spacing, max count, stops on `reply_started`, Hindi list, count 0 = silent, never the same phrase twice in a row). Existing `tests/test_filler.py` must still pass unchanged (voice behaviour is the regression guard).
- Pi route: stream test with a slow fake supervisor: expects `event: filler` frames before the first text frame, none after it, none when the reply is fast, `[DONE]` last. Plus a disconnect test (no leaked task).
- `encoder`: framing with and without `event`.
- App: `sse`/`client` test (filler event parsed; unknown event ignored; plain text unchanged); `chatStore` test (filler shown, replaced by the next filler, cleared by first text, cleared on error and stop; English filler spoken when Speak is on, silent when off; Devanagari filler shown but not spoken; not spoken while something else is speaking; reply sentences still spoken after a filler; stop silences a filler); `chatView` test (render and live-region); contract test against the mock Pi (`scripts/mock_pi.py` emits a filler).

---

## Part B: Seeking in the music

### B1. What exists today (checked in code)

- `MpvPlayer` (`tpa/audio/music_adapters.py`) already talks to mpv over its JSON IPC channel (`pause`, `resume`). A seek is one more command: `{"command": ["seek", <seconds>, "absolute"]}`.
- `MusicService` keeps its own clock: `elapsed_s` = **played** time (a pause stops it), and a limit timer (`_arm_limit`) stops the song at `length + 15 s` (at most `max_song_minutes`, 30). Both assume time only moves forward at 1x. A seek breaks that assumption, so the clock needs a rule (B3).
- `MusicPlayerPort` has `start / pause / resume / stop` only. API has `status / play / stop / pause / resume`.
- The app's player card shows a read-only bar (`MusicView.tsx:177`), counting between Pi answers via `elapsedNow`.
- The Pi's microphone is closed while a song plays, so **seeking is phone-only**; there is no voice command for it, and none is planned.

### B2. API

One new call, same permission as the other music calls (control):

| Call | Does | Answer |
|---|---|---|
| `POST /api/music/seek` `{position_s}` | jump to that second | the music status |

Status gains one field: **`seekable`** (bool). `elapsed_s` keeps its name and now means *where in the song we are*. Until the first seek that is identical to the played time, so nothing changes for an app that never seeks.

Rules:
- `seekable` is true only while `playing` or `paused` **and** the song's length is known. A live stream or a song of unknown length is not seekable (the button and bar are disabled, with the reason shown).
- `position_s` is clamped to `0 .. min(duration, limit) - 2`, so dragging to the very end plays the last two seconds and ends normally rather than erroring.
- Negative, non-number, or over-large values: 422, before anything happens.
- Not playing (idle, starting): 409 `MUSIC_NOT_PLAYING` (reused).
- Playing but the length is unknown (a live stream): 409 `MUSIC_NOT_SEEKABLE`, "This song can't be skipped through." (added while building).
- mpv does not answer (still buffering, crashed): 502 `MUSIC_SEEK_FAILED`, with a plain app message ("Couldn't jump just now. Try again."). New `ExceptionCode` + `ErrorMessage` + a row in `exceptions/handlers.py` `_STATUS_BY_CODE`, per the conventions.
- Seeking while **paused** stays paused (position moves, clock stays stopped).
- Add `("POST", "/api/music/seek", SCOPE_CONTROL)` to `device_scope_policy.py`.

### B3. The clock rules (the part that needs care)

Two different numbers were one number until now:

| Name | Meaning | Moves on seek? | Used for |
|---|---|---|---|
| **position** (`elapsed_s` in the API) | where in the song | yes, jumps to the target | the bar and the time label |
| **played** (internal only) | seconds actually listened to | no, only moves forward at 1x | the safety cap `max_song_minutes` |

- On seek: `position := target`, `played` unchanged, and the stop timer is re-armed for `(limit - target)` seconds, where `limit` is the song's length plus the 15 s slack, as today. Without this, seeking back would make the song cut off early (the old timer counted from the start).
- The cap `max_song_minutes` (30) is checked against **played**, so jumping around cannot make a song run forever.
- Pause logic (`_sync_player`) is reused: it already freezes the clock and the timer; it just has to freeze *position* instead of the old `_elapsed_before`.
- The software clock is kept rather than asking mpv for `time-pos` after every seek. Reading mpv's answers would need a request/response channel that `MpvPlayer._send` (write-only) does not have. Cost: if mpv is stalled buffering after a seek, the shown position runs ahead until it recovers. Accepted for v1. Stated as a known gap, with the follow-up ("poll `time-pos` once after a seek and correct the clock") written down, not hidden.

### B4. Pi side

```
domain/ports/music_ports.py    MusicPlayerPort: + async def seek(self, position_s: float) -> None
tpa/audio/music_adapters.py    MpvPlayer.seek -> self._command("seek", position_s, "absolute")
service/music/music_service.py MusicService.seek(position_s) -> bool  (+ position/played split, re-arm timer)
schemas/music.py               SeekRequest {position_s: float}; MusicStatusResponse + seekable
controller/routes/music.py     POST /music/seek
core/enums.py, exceptions/handlers.py    MUSIC_SEEK_FAILED
device_scope_policy.py         one new row
```

`MusicPlayerPort` is `runtime_checkable`; the test fakes for it need the new method too.

### B5. App side

**Screen** (`MusicView.tsx`, player card):

```
   Now playing
   Kun Faya Kun
   ● Playing on your Pi

   0:42 ──────●──────────────────── 4:22      <- drag the dot, or tap the bar
                                  Ends at 4:22

        (⏪10)   ( ⏸ )   (10⏩)                   <- skip buttons around Pause
        Stop                    New song
```

- **Scrubber:** built in plain React Native (`PanResponder` + `Pressable`), **no new native dependency**. This avoids a native module and a dev build for a single widget (docs/16 and `AGENTS.md`: prefer what Expo already ships). While dragging, the time label shows the target. The seek is sent on **release**, not during the drag (one request, not fifty).
- **-10 s / +10 s buttons:** one tap = 10 s. Taps within 400 ms are added together and sent as one seek (five quick taps = +50 s, one request). This is the main control for one-handed use and for TalkBack.
- **No snap-back:** after release the bar holds the target until the Pi's answer arrives, then continues counting from the answer. Same `syncedAt` mechanism as `elapsedNow`.
- **Not seekable** (`seekable: false`): bar and skip buttons are disabled and a small note says "This one can't be skipped (no known length)".
- **TalkBack:** the bar is `accessibilityRole="adjustable"` with `increment` / `decrement` actions (+/-10 s) and a value like "0:42 of 4:22". The existing "Time until the song stops by itself" label becomes "Position in the song".
- Seek is available only while the song is `playing` or `paused`; hidden while "Finding the song" / "Starting".

**Store** (`musicStore.ts`): `seekTo(seconds)`, `skip(deltaSeconds)` (with the 400 ms merge), a `seeking` flag, error mapping for `MUSIC_SEEK_FAILED` and 409 in `api/errors.ts` (plain-words messages, P5).

**Client** (`api/music.ts`, `musicClient.ts`, `pi.ts` interface): `seek(positionS)`; `MusicInfo` gains `seekable`. `parseMusic` treats a missing `seekable` as `false`, so an older Pi still works (bar just stays read-only).

**Demo mode**: the pretend player supports seeking, so it can be shown without a Pi. **Mock Pi** (`scripts/mock_music.py`): add the endpoint.

### B6. Tests

- Pi service: seek moves position; played does not; timer re-armed (seek back near the end does not stop early; seek forward past the limit is clamped); seek while paused keeps the clock frozen; seek while idle/starting returns False; the played cap still fires after repeated back-seeks; unknown length is not seekable; reminder-pause and user-pause still behave (existing tests unchanged and passing).
- Pi route: 200 and status; 409 when idle; 422 on bad input; 502 on a player that raises; 403 for a phone without control permission (`tests/test_music_phone.py`).
- Player: `MpvPlayer.seek` sends exactly the expected IPC JSON (fake pipe).
- App: store (drag release sends once, skips merge, holds target until answer, error shows plain message); view (disabled when not seekable; adjustable actions); client mapping (`seekable` missing = false); contract test against `mock_music.py`; routing test untouched (no new route).

---

## C. Build order and what stays unverified

Each stage ends with all tests green; nothing is built before approval.

1. **Pi: filler schedule** extracted, voice behaviour unchanged (existing tests), then the `event: filler` in `/api/stream`.
2. **App: filler in chat** (client, store, view, demo, mock Pi, tests).
3. **Pi: seek** (port, adapter, service clock, route, scope row, error code).
4. **App: seek UI** (client, store, scrubber, skip buttons, a11y, demo, mock Pi, tests).
5. Update docs 16/17 (status, the "Not added: seeking" line in 17 section 3), then **an APK is built only after telling you first** (standing rule).

**Not provable on a laptop, will be called out as unverified until tried on the real Pi and phone:** mpv's `seek` on a YouTube stream (speed, behaviour while buffering), the drag feel and hit sizes on a real screen, TalkBack actions, `expo/fetch` delivering the named `filler` event promptly on Android.

## D. Out of scope (deliberately)

Voice "skip ahead" (the Pi's microphone is closed during music), a queue, volume, seeking inside live streams, speaking Hindi fillers on the phone (its voice is English-only in v1), saving anything.

## E. Decisions (answered by the user)

- **Q1. Read fillers aloud on the phone?** **Yes.** Waiting is when the user most needs to know Veda is working. Rules in A5: spoken only when "Speak replies" is on, English only, never over the answer, a filler already speaking finishes before the reply.
- **Q2. Skip size.** **10 seconds.**
- **Q3. Hindi fillers.** **Appear automatically** when the user types Devanagari (shown in the bubble). Not spoken by the phone (English voice only).

## F. Approval

- [x] Option 1: the Pi sends fillers as `event: filler`
- [x] Q1 (read aloud), Q2 (10 s), Q3 (Hindi shown automatically)
- [x] Part G (Hindi phone voice + automatic language-pack pop-up): Q4 (Settings only) and Q5 (Look unchanged) answered
- [x] Final go-ahead to build, in the order in section C (Part G after stage 2). Given 2026-11-10.

---

## G. Hindi phone voice and the language-pack pop-up

Requested after the first approval. It changes what the phone **says** and **hears**, so it sits beside the fillers (Part A).

### G1. What the English "automatic" download really was

- It was the **speech-recognition** pack (the phone turning your voice into text), not the voice that reads replies.
- It was **not silent**. The app showed a "Download offline speech" button; tapping it called `androidTriggerOfflineModelDownload({ locale: 'en-US' })` (`speech/expoRecognizer.ts`), and **Android** showed its own download dialog.
- Android never lets an app install a language pack silently. So "automatic" for Hindi means: the **app notices** the pack is missing, **pops up** a clear question, and **one tap** hands over to Android, which does the download. That is the best that is possible, and it is what English did.

### G2. Hindi needs two separate packs

| Pack | Needed for | How the app detects it is missing | How the app starts the install |
|---|---|---|---|
| **Speech recognition `hi-IN`** | you speaking Hindi to the mic | `getSupportedLocales()` lists `installedLocales` (Android 13+). On Android 12 and below that list is empty, so detect the failure `language-not-supported` instead (as English does today) | `androidTriggerOfflineModelDownload({ locale: 'hi-IN' })`, the existing code with the locale as a parameter. Android 13+ only; answers `ready`, `scheduled` or `dialog` |
| **Text-to-speech Hindi voice** | the phone reading Hindi aloud (replies and fillers) | `Speech.getAvailableVoicesAsync()` has a voice whose `language` starts with `hi` | `expo-speech` has **no install call**. Open Android's own screen with `Linking.sendIntent('android.speech.tts.engine.INSTALL_TTS_DATA')`; the user taps Hindi there. If that intent is refused, show the manual path (Settings > Text-to-speech > the engine's gear > Install voice data > Hindi) |

### G3. The pop-up

A native dialog (`Alert.alert`) in plain words, shown at most once per reason until the user changes something:

```
   Hindi voice needed
   To hear Veda in Hindi, your phone needs the Hindi voice.
   It downloads from Google, about 20-30 MB.      (size to be confirmed on the phone)
   [ Not now ]                       [ Download ]
```

It appears in two situations:
1. **When the user turns Hindi on** (Settings > Language, G5): both packs are checked; the pop-up lists only what is missing (one dialog, up to two downloads one after the other).
2. **When Veda replies in Devanagari and there is no Hindi voice** (for example the user typed Hindi without turning the setting on): the text is shown as usual, and a one-time pop-up offers the voice. "Not now" is remembered on the phone, so it does not nag; the offer stays reachable in Settings.

After "Download", the app shows the existing banner style: "Downloading… we will tell you when it is ready", then re-checks (on app return to foreground) and says "Hindi voice is ready" or what to do.

### G4. Speaking: the right voice per sentence

- `ExpoSpeaker.speak` picks the language **per sentence**: Devanagari characters mean `hi-IN`, anything else `en-US`. This is the same rule the Pi uses for its own voice (`voice_language` in the voice session), so the phone and the Pi agree.
- The ports (`SpeechPort`, `Speaker`) do not change, so the queue, the highlight and the filler rule in A5 keep working. A mixed reply ("Play बाहुबली") is spoken sentence by sentence in the matching voice.
- If the Hindi voice is not installed, a Hindi sentence is **skipped silently** (text stays on screen) and the pop-up in G3 is offered. It is never read with the English voice.

### G5. Listening: which language the mic hears

Speech recognition cannot guess the language, so the user picks it:
- New setting **Language: English / हिन्दी** in Settings (default English), kept in `preferences.ts`.
- `ExpoRecognizer` takes its `lang` from that setting (`en-US` or `hi-IN`) instead of the fixed `'en-US'`, and `requiresOnDeviceRecognition` is only used when that locale is installed.
- **Look stays English whatever the setting says.** The vision model failed Hindi on both sizes tested (docs/15, docs/16), so a Hindi question there would be answered badly. Chat and Music use the chosen language.
- The Pi needs no change for chat: the supervisor already answers in the language it is asked in, and Hindi fillers already exist (A3).

### G6. Files

```
mobile/src/speech/expoSpeaker.ts        language per sentence; skip Hindi when no voice
mobile/src/speech/expoRecognizer.ts     lang from the setting; downloadSpeechPack(locale)
mobile/src/speech/languagePacks.ts      NEW: detect (voices, installedLocales), install (recognition, TTS intent)
mobile/src/speech/script.ts             NEW: "is this Devanagari?" (pure, shared by the speaker and the pop-up rule)
mobile/src/features/settings/*          Language row, "Hindi voice" status line with a Download button
mobile/src/features/chat, music         pop-up trigger (G3.2), mic language
mobile/src/features/look                unchanged on purpose (English only)
mobile/src/features/settings/preferences.ts   language, hindiOfferDismissed
```

### G7. Tests

`script` (Devanagari / Latin / mixed / digits / empty); `expoSpeaker` (voice chosen per sentence, Hindi skipped when absent, English unaffected); `languagePacks` (detect with and without the voice, with empty `installedLocales` on old Android, install call per pack, intent refused falls back to instructions); store tests for the pop-up (shown once, "Not now" remembered, not shown when the voice exists, shown again after the setting is toggled off and on); settings screen test; the Look screen keeps `en-US` when Hindi is chosen.

### G8. Not provable on a laptop (will be called out as unverified until tried on the phone)

- Whether the user's phone (a Samsung, so its default speech engine may be Samsung's, not Google's) lists Hindi voices before they are installed, and which screen `INSTALL_TTS_DATA` opens there.
- Whether `getSupportedLocales` returns `hi-IN` as installed after the download, and the real download size.
- How good the offline Hindi recognizer is for short questions and song names.
- That the pop-up does not appear twice when the Pi replies in Hindi while a download is running.

### G9. Decisions (answered by the user)

- **Q4. Mic language switch: Settings row only.** No chip on the Chat or Music mic.
- **Q5. Look is not changed.** It stays English whatever the setting says, and no Look file is touched.

### G10. Build order

Part G is built right after stage 2 (fillers in the app), because the fillers are the first thing the Hindi voice speaks: G4 (speaker + `script`), then `languagePacks` and the pop-up, then the setting and the mic language, then the music seek stages. Docs 16 ("English only in v1") and 17 get a status note when it ships. An APK is built only after telling you first.

---

## H. What was built (2026-11-10)

Built in the order: Pi filler schedule, app fillers, Hindi phone voice, Pi seek, app seek. All tests green except the ones listed below, which failed before this work.

### H1. Differences from the design above

| Design said | Built |
|---|---|
| Skip buttons flank Pause | They are a row of two pills ("10 s" with a rewind icon, "10 s" with a fast-forward icon) **under the bar**, because five round buttons do not fit in one row on a phone |
| 409 `MUSIC_NOT_PLAYING` for an unseekable song | Added `MUSIC_NOT_SEEKABLE` (409) so a live stream is not told "No song is playing" |
| Hindi pop-up shows the download size | It does not: the size is unknown until tried on the phone, and Android shows it in its own dialog |
| Hindi pack status in Settings | Added the status lines, a "Download Hindi" button, and a one-line result note |
| (not mentioned) | The sentence splitter now ends a sentence at the Hindi danda (। ॥); without it a Hindi reply would only be spoken at the very end |
| (not mentioned) | `ExpoRecognizer` / `ExpoSpeaker` take Hindi as an opt-in argument, and Look passes none, so **no Look file changed** and Look still listens and speaks English only |

### H2. Where the code is

- **Fillers, Pi:** `service/agent/filler_schedule.py` (shared by `voice_session.py` and `controller/routes/stream.py`), `controller/sse/encoder.py` (`event=`), `providers.get_filler_settings`.
- **Fillers, app:** `api/client.ts` (named events), `chatStore.ts` (`filler`, spoken when Speak is on), `ChatView.tsx`.
- **Hindi:** `speech/languagePacks.ts`, `speech/script.ts`, `speech/locale.ts`, `speech/expoSpeaker.ts`, `features/language/` (`languageSetup`, `languageRuntime`, `micText`), the Language section of `settings.tsx`, `state/preferences.ts` (`language`, `hindiOfferDismissed`).
- **Seek, Pi:** `music_service.py` (position vs played clock, `seek`), `music_ports.py` + `music_adapters.py` (`seek`), `controller/routes/music.py` (`POST /api/music/seek`), `schemas/music.py`, `core/enums.py` + `exceptions/handlers.py` (two codes), `device_scope_policy.py`.
- **Seek, app:** `ui/Scrubber.tsx`, `musicStore.ts` (`seekTo`, `skip`, 400 ms merge), `MusicView.tsx`, `api/musicClient.ts`, `api/demo.ts`.

### H3. Tests

Pi: `tests/test_filler_schedule.py`, `test_music_seek.py`, `test_mpv_seek.py`; `test_music_phone.py` updated. App: 785 unit tests and 50 contract tests (against the mock Pi over real HTTP). Type check and lint are clean.

Failing before this work and still failing (not caused by it): `test_music.py::test_the_song_waits_until_veda_has_stopped_talking...`, `test_control_stage.py::test_static_control_prompt_fits...`, the training-pipeline and real-llama vision tests (Windows blocks `llama.dll`), and `tests/test_prompt_cache_pin.py` cannot load for the same reason. `lookMic.test.tsx` ("offers the microphone only once there is a photo") sometimes times out at 5 s on a loaded machine; it is a Look test and Look was not touched.

### H4. Not proven, to check on the phone and the Pi

1. mpv's `seek` on a real YouTube stream: speed, and what happens while it is buffering. The Pi's clock is a software clock, so after a seek it can run ahead of mpv if mpv stalls (known gap; the follow-up is to read mpv's `time-pos` once after a seek).
2. Whether the Samsung phone lists Hindi voices before they are installed, which screen `INSTALL_TTS_DATA` opens there, whether `getSupportedLocales` reports `hi-IN` after the download, the real download sizes, and how good offline Hindi recognition is for short questions.
3. That `expo/fetch` delivers the named `filler` event promptly on Android, and that the phone speaks it before the first word of the reply.
4. The feel of dragging the bar and the size of the skip buttons on a real screen, and TalkBack's increase/decrease.
5. An old APK talking to the new Pi shows a filler as ordinary reply text (accepted).

