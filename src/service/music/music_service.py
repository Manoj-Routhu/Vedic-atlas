"""MusicService — plays one song at a time and keeps the microphone and the music from ever overlapping.

    play(query)   search -> pick the best match -> close the mic -> (wait until Veda has stopped talking) -> play
    stop(reason)  stop the player and let the mic reopen. Runs when: the song ends, the time limit passes, someone asks
                  for it, the mic is muted OR unmuted (the mute switch and /mute /unmute are the guaranteed stop), shutdown.

While music plays the microphone is held CLOSED (CaptureGate.pause_capture, source "music"), because with one mic and no
echo cancellation the wake word cannot be heard through the music. After a mute the song is gone: unmuting only reopens
the mic. A reminder that falls due pauses the music, is spoken, and the music resumes (MusicAwareSpeaker).

The first sound of a song never overlaps Veda's own reply: `play` returns at once (so the reply "Playing X." is spoken),
and the player starts in the background once the voice session is quiet.
"""

from __future__ import annotations

import asyncio
import time
from typing import Awaitable, Callable

from core.logging_config import logger, log_text
from domain.entities.music_track import MusicStatus, Track
from domain.policies.music_policy import clean_query, pick_track
from domain.ports.music_ports import MusicError, MusicPlayerPort, MusicResolverPort

SOURCE = "music"
IDLE, STARTING, PLAYING = "idle", "starting", "playing"


class MusicService:
    def __init__(
        self,
        resolver: MusicResolverPort,
        player: MusicPlayerPort,
        gate,
        *,
        max_seconds: float = 300.0,
        max_song_seconds: float = 1800.0,
        end_grace_sec: float = 15.0,
        is_busy: Callable[[], bool] | None = None,
        quiet_for_sec: float = 1.0,
        quiet_timeout_sec: float = 30.0,
        poll_sec: float = 0.25,
    ):
        self._resolver, self._player, self._gate = resolver, player, gate
        self._max_seconds = max_seconds                  # backstop for a song whose length is not known (a live stream)
        self._max_song_seconds = max(max_song_seconds, max_seconds)   # the longest a song of KNOWN length may play
        self._end_grace = end_grace_sec                  # slack past the song's end: the player's own end-of-file stops it
        self._limit_s = max_seconds                      # the limit of the song now playing (see _limit_for)
        self._is_busy = is_busy                 # the voice session's "speaking / in a turn" probe; None = no voice
        self._quiet_for, self._quiet_timeout, self._poll = quiet_for_sec, quiet_timeout_sec, poll_sec
        self._state = IDLE
        self._track: Track | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._start_task: asyncio.Task | None = None
        self._limit: asyncio.TimerHandle | None = None
        self._paused_for_speech = False     # a reminder is being spoken over the song
        self._user_paused = False           # the phone (or anyone) pressed Pause
        self._player_paused = False         # what the player was last told
        self._position_before = 0.0         # where in the song the current stretch began (a seek moves it)
        self._played_before = 0.0           # seconds listened to before the current stretch (never goes back: the safety cap)
        self._stretch_start: float | None = None   # when the current stretch began; None while paused

    # ---- lifecycle ----------------------------------------------------------------------------------------------

    def start(self) -> None:
        """Remember the event loop: the mute switch reports from another thread."""
        self._loop = asyncio.get_running_loop()

    async def shutdown(self) -> None:
        await self.stop("shutdown")

    # ---- state --------------------------------------------------------------------------------------------------

    @property
    def active(self) -> bool:
        return self._state != IDLE

    @property
    def is_playing(self) -> bool:
        return self._state == PLAYING

    @property
    def track(self) -> Track | None:
        return self._track

    def _running(self) -> float:
        """Seconds since the current stretch began; 0 while paused."""
        return time.monotonic() - self._stretch_start if self._stretch_start is not None else 0.0

    @property
    def elapsed_s(self) -> float | None:
        """Where in the song we are: time spent paused is not counted and a seek moves it. None unless playing or paused."""
        if self._state != PLAYING:
            return None
        return self._position_before + self._running()

    @property
    def seekable(self) -> bool:
        """The phone may jump around in this song: it is playing (or paused) and its length is known."""
        return self._state == PLAYING and self._track is not None and bool(self._track.duration_sec and self._track.duration_sec > 0)

    def status(self) -> MusicStatus:
        if self._state == IDLE or self._track is None:
            return MusicStatus("idle")
        if self._state == STARTING:
            return MusicStatus("starting", title=self._track.title, limit_s=self._limit_for(self._track) or None, duration_s=self._track.duration_sec)
        return MusicStatus(
            "paused" if self._user_paused else "playing", title=self._track.title, elapsed_s=self.elapsed_s,
            limit_s=self._limit_s or None, duration_s=self._track.duration_sec, seekable=self.seekable,
        )

    def _limit_for(self, track: Track) -> float:
        """Seconds of play after which the song is stopped. A song of known length plays to its end (plus a little slack, so
        a rounded length cannot cut the last notes; the player's own end-of-file normally stops it first), up to
        `max_song_seconds`. A song of unknown length (a live stream never ends) stops at `max_seconds`. 0 = no limit."""
        if self._max_seconds <= 0:
            return 0.0
        length = track.duration_sec
        if length and length > 0:
            return min(length + self._end_grace, self._max_song_seconds)
        return self._max_seconds

    # ---- play / stop --------------------------------------------------------------------------------------------

    async def play(self, query: str) -> Track:
        """Find the song and arrange for it to play. Raises MusicError (with a sentence to speak) when it cannot."""
        text = clean_query(query)
        if not text:
            raise MusicError("empty query", "What song should I play?")
        if self.active:
            await self.stop("replaced")
        candidates = await self._resolver.search(text)
        track = pick_track(text, candidates)
        if track is None:
            raise MusicError(f"no result for {text!r}", "I couldn't find that song.")
        self._gate.pause_capture(SOURCE)            # the mic closes now and stays closed until the music is gone
        self._state, self._track = STARTING, track
        self._start_task = asyncio.create_task(self._begin(track), name="MusicStart")
        logger.info(f"[music] chosen {log_text(track.title)} for {log_text(text)} ({len(candidates)} hit(s)); starts when Veda is quiet")
        return track

    async def stop(self, reason: str = "stop") -> bool:
        """Stop whatever is playing (or about to). False when nothing was."""
        if not self.active:
            return False
        task, self._start_task = self._start_task, None
        if task is not None and task is not asyncio.current_task() and not task.done():
            task.cancel()
        try:
            await self._player.stop()
        except Exception as e:
            logger.warning(f"[music] player did not stop cleanly: {type(e).__name__}: {e}")
        self._release(reason)
        return True

    def _release(self, reason: str) -> None:
        if self._limit is not None:
            self._limit.cancel()
            self._limit = None
        was = self._state
        self._state, self._track, self._paused_for_speech = IDLE, None, False
        self._user_paused = self._player_paused = False
        self._position_before = self._played_before = 0.0
        self._stretch_start = None
        if was != IDLE:
            logger.info(f"[music] stopped ({reason}); the microphone may reopen")
            self._gate.resume_capture(SOURCE)

    async def _begin(self, track: Track) -> None:
        try:
            await self._wait_until_quiet()
            await self._player.start(track.url, self._on_finished)
            self._state = PLAYING
            self._position_before = self._played_before = 0.0
            self._stretch_start = time.monotonic()
            self._limit_s = self._limit_for(track)
            self._rearm()
            logger.info(
                f"[music] playing {log_text(track.title)} (length "
                f"{'unknown' if not track.duration_sec else f'{track.duration_sec:.0f}s'}, limit {self._limit_s:.0f}s)"
            )
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.error(f"[music] could not start playback: {type(e).__name__}: {e}")
            self._start_task = None
            try:
                await self._player.stop()
            except Exception:
                pass
            self._release("start failed")

    async def _wait_until_quiet(self) -> None:
        """Veda's own reply ("Playing X.") must finish before the first notes. Without a voice session: no wait."""
        if self._is_busy is None:
            return
        deadline = time.monotonic() + self._quiet_timeout
        quiet_since: float | None = None
        while time.monotonic() < deadline:
            if self._is_busy():
                quiet_since = None
            else:
                now = time.monotonic()
                quiet_since = now if quiet_since is None else quiet_since
                if now - quiet_since >= self._quiet_for:
                    return
            await asyncio.sleep(self._poll)
        logger.warning("[music] Veda stayed busy; starting anyway")

    def _arm_limit(self, seconds: float) -> None:
        if self._limit is not None:
            self._limit.cancel()
            self._limit = None
        if self._loop is None or self._limit_s <= 0:
            return
        self._limit = self._loop.call_later(max(seconds, 0.0), lambda: asyncio.ensure_future(self.stop("time limit")))

    def _rearm(self) -> None:
        """Stop at whichever comes first: the song's end (its limit, measured in position) or the cap on time listened.
        Without a seek the two are the same clock."""
        if self._limit_s <= 0:
            self._arm_limit(0.0)
            return
        position = self._position_before + self._running()
        played = self._played_before + self._running()
        self._arm_limit(min(self._limit_s - position, self._max_song_seconds - played))

    # ---- events from outside ------------------------------------------------------------------------------------

    def _on_finished(self) -> None:
        """The player says the song ended (or was stopped). May be called from any thread."""
        if self._loop is not None and self._state == PLAYING:
            asyncio.run_coroutine_threadsafe(self.stop("finished"), self._loop)

    def on_mute_change(self, muted: bool) -> None:
        """CaptureGate listener: ANY mute or unmute ends the music. Runs on the thread that made the change."""
        if self.active and self._loop is not None:
            asyncio.run_coroutine_threadsafe(self.stop("muted" if muted else "unmuted"), self._loop)

    # ---- pausing: for a spoken reminder, or because the phone asked --------------------------------------------

    async def _sync_player(self) -> bool:
        """Make the player match what is wanted (paused if a reminder is speaking OR the user paused). False if it failed."""
        want = self._paused_for_speech or self._user_paused
        if self._state != PLAYING or want == self._player_paused:
            return True
        try:
            await (self._player.pause() if want else self._player.resume())
        except Exception as e:
            logger.warning(f"[music] could not {'pause' if want else 'resume'}: {type(e).__name__}")
            return False
        self._player_paused = want
        now = time.monotonic()
        if want:   # the clock and the time limit stand still while it is paused
            if self._stretch_start is not None:
                self._position_before += now - self._stretch_start
                self._played_before += now - self._stretch_start
                self._stretch_start = None
            if self._limit is not None:
                self._limit.cancel()
                self._limit = None
        else:
            self._stretch_start = now
            self._rearm()
        return True

    async def pause(self) -> None:
        """Pause for a spoken reminder (MusicAwareSpeaker)."""
        if self._state == PLAYING and not self._paused_for_speech:
            self._paused_for_speech = True
            if not await self._sync_player():
                self._paused_for_speech = False

    async def resume(self) -> None:
        if self._state == PLAYING and self._paused_for_speech:
            self._paused_for_speech = False
            await self._sync_player()

    async def pause_by_user(self) -> bool:
        """The phone pressed Pause. False when no song is playing (or the player would not pause)."""
        if self._state != PLAYING:
            return False
        self._user_paused = True
        if not await self._sync_player():
            self._user_paused = False
            return False
        return True

    async def resume_by_user(self) -> bool:
        """The phone pressed Play again. False when no song is playing."""
        if self._state != PLAYING:
            return False
        self._user_paused = False
        await self._sync_player()
        return True

    # ---- seeking: the phone jumps to another place in the song ---------------------------------------------------

    def _seek_ceiling(self) -> float:
        """The furthest place to jump to: two seconds before the stop point, so dragging to the very end plays the last
        moments and lets the song finish by itself instead of being cut."""
        end = self._track.duration_sec if self._track and self._track.duration_sec else 0.0
        if self._limit_s > 0:
            end = min(end, self._limit_s)
        return max(0.0, end - 2.0)

    async def seek(self, position_s: float) -> bool:
        """Jump to `position_s` seconds into the song (clamped to the song). False when this song cannot be jumped in:
        nothing is playing, or its length is unknown (a live stream). Raises MusicError when the player would not do it;
        the position is then unchanged.

        The shown position moves to the target and counts on from there; the time LISTENED to does not rewind, and the stop
        timer is set again from the new place, so jumping back never cuts a song short and jumping around never lets it
        run past the cap on listening time."""
        if not self.seekable:
            return False
        target = min(max(float(position_s), 0.0), self._seek_ceiling())
        try:
            await self._player.seek(target)
        except Exception as e:
            logger.warning(f"[music] could not seek: {type(e).__name__}: {e}")
            raise MusicError(f"seek failed: {type(e).__name__}", "Couldn't jump just now. Try again.") from e
        if self._state != PLAYING:   # stopped while the player was busy
            return False
        now = time.monotonic()
        if self._stretch_start is not None:
            self._played_before += now - self._stretch_start
            self._stretch_start = now
        self._position_before = target
        if self._stretch_start is not None:   # paused: no timer runs, and none is started
            self._rearm()
        return True


class MusicAwareSpeaker:
    """Wraps the reminder speaker: music pauses while a reminder is spoken, then continues. The announcer is unchanged."""

    def __init__(self, inner, music: MusicService):
        self._inner, self._music = inner, music

    def available(self) -> bool:
        return self._inner.available()

    def is_busy(self) -> bool:
        return self._inner.is_busy()

    async def announce(self, text: str) -> bool:
        if not self._music.is_playing:
            return await self._inner.announce(text)
        await self._music.pause()
        try:
            return await self._inner.announce(text)
        finally:
            await self._music.resume()
