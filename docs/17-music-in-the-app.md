# 17. Music in the phone app

Status: **built and tested in code (Pi routes, app tab, mock Pi, 760+ tests). Not yet tried on a real phone with a real Pi.**
Builds on the music feature from the voice side (`config/music.yaml`, `service/music/`) and the app design in `16-mobile-app-design.md`.

## 1. What it is

A fourth tab, **Music**, between Veda and Control. You say or type a song name; the Pi finds it on YouTube and plays it
through **the Pi's own speaker**. The phone is only the remote control: no sound comes from the phone.

Why the Pi and not the phone:
- the voice side already plays on the Pi, and the microphone rules (below) depend on that;
- stream links from YouTube expire, and the phone would have to talk to YouTube itself;
- it keeps the app's promise: the phone talks only to your Pi, over your home Wi-Fi.

## 2. Rules that do not change

- While a song plays, **the Pi's microphone is closed** (one mic, no echo cancellation: the wake word cannot be heard through music). Any mute or unmute, Stop, the end of the song, or the time limit (5 minutes, `music.max_minutes`) opens it again.
- A song starts only after Veda has finished talking, so "Playing X." is never talked over.
- Only the search words leave the home (yt-dlp and mpv open their own connection to YouTube). Voice never does: the phone turns speech into text on the phone itself.
- Music is on only when `music.enabled` is true, `privacy.online.enabled` is true, and `mpv` and `yt-dlp` are installed.

## 3. Pi API (new, `controller/routes/music.py`)

All five need the phone's **control** permission (playing starts sound in the room, so it is not a chat permission).

| Call | Does | Answer |
|---|---|---|
| `GET /api/music/status` | what the music is doing; answers even when music is off | status |
| `POST /api/music/play` `{query}` | find the song (search happens before it answers), queue it | status, `state: "starting"` |
| `POST /api/music/stop` | stop; the mic reopens | status |
| `POST /api/music/pause` | pause the player (409 `MUSIC_NOT_PLAYING` if nothing plays) | status |
| `POST /api/music/resume` | carry on (409 as above) | status |

Status: `{available, reason, state, title, elapsed_s, limit_s, duration_s}`.
- `state`: `idle | starting | playing | paused`.
- `reason` (when `available` is false): `off` (config), `offline` (privacy mode), `tools_missing` (mpv or yt-dlp not installed).
- `elapsed_s` counts **played** time only. A pause stops the clock **and the 5-minute limit**, so pausing never costs you the song. A spoken reminder pauses the song the same way and resumes it afterwards; if you had paused it yourself, the reminder does not start it again.

Errors (shown in the app's own words, never the Pi's text): `MUSIC_UNAVAILABLE` 503, `MUSIC_NOT_FOUND` 404 (nothing matched, or the search itself failed), `MUSIC_NOT_PLAYING` 409. An empty or over-200-character query is a 422 before anything happens.

Not added: volume, seeking, a queue, picking from the search results. Not open to phones: anything else under `/api/music/`.

## 4. The screens (design: `Veda Mobile App Screens` canvas, boards 11 to 14)

1. **Ready:** "Plays on your Pi's speaker. This phone is the remote." Song box with a microphone button, a Play button, and a "Good to know" card (mic closed while playing, 5-minute stop, only the words leave home).
2. **Finding the song / Starting the song:** a spinner, the words asked, and Cancel. Cancelling while the Pi is still searching shows the idle screen at once and stops the song as soon as the Pi's late answer arrives.
3. **Playing:** the song the Pi picked, "Playing on your Pi" (or "Paused"), a bar showing time played against the stop time ("Stops by itself at 5:00", or "Ends at 4:22" when the song is shorter), Stop, Pause or Resume, and New song (opens the song box in place; a new name replaces the song). A note says the Pi's mic is closed.
4. **Not available:** tailored to the reason, with the exact thing to do on the Pi, and Check again.

The tab shows for phones paired with the control permission. Demo mode has a pretend player (no sound) that behaves the same way, so the screen can be shown without a Pi.

## 5. How it is built

Pi: `MusicService` gained `pause_by_user` / `resume_by_user`, a played-time clock, and `status()`; `controller/routes/music.py`, `schemas/music.py`, three error codes, five rows in `device_scope_policy.py`; `container.py` records why music is off.
App: `api/music.ts` + `musicClient.ts` (on `PiApi`), `features/music/` (`musicStore`, `MusicView`, runtime), `app/(app)/music.tsx`, a fourth item in `ui/TabBar.tsx`, the demo player, and three new error messages.
Tests: `tests/test_music_phone.py` (service clock, routes, permissions), `__contract__/music.contract.test.ts` (real HTTP against the mock Pi, `scripts/mock_music.py`), and unit tests for the store, client mapping, screen and routing.

## 6. Known gaps and follow-ups

- Not tried on real hardware: mpv's pause over its control channel, a real YouTube search, a Bluetooth speaker.
- The progress bar is time **played** against the stop time. If the song is longer than the limit it is cut at the limit.
- Voice input for the song name repeats the microphone code of Look and Chat. A shared helper would remove the three copies.
- `music_control` as a voice tool still offers only play and stop; pause is phone-only for now.
- Known from earlier: the keyboard covers the "Add a task" box (Control) and "Change address" (Settings).
