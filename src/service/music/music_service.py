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

from core.logging_config import logger
from domain.entities.music_track import Track
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
        is_busy: Callable[[], bool] | None = None,
        quiet_for_sec: float = 1.0,
        quiet_timeout_sec: float = 30.0,
        poll_sec: float = 0.25,
    ):
        self._resolver, self._player, self._gate = resolver, player, gate
        self._max_seconds = max_seconds
        self._is_busy = is_busy                 # the voice session's "speaking / in a turn" probe; None = no voice
        self._quiet_for, self._quiet_timeout, self._poll = quiet_for_sec, quiet_timeout_sec, poll_sec
        self._state = IDLE
        self._track: Track | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._start_task: asyncio.Task | None = None
        self._limit: asyncio.TimerHandle | None = None
        self._paused_for_speech = False

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
        logger.info(f"[music] chosen {track.title!r} for {text!r} ({len(candidates)} hit(s)); starts when Veda is quiet")
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
        if was != IDLE:
            logger.info(f"[music] stopped ({reason}); the microphone may reopen")
            self._gate.resume_capture(SOURCE)

    async def _begin(self, track: Track) -> None:
        try:
            await self._wait_until_quiet()
            await self._player.start(track.url, self._on_finished)
            self._state = PLAYING
            self._arm_limit()
            logger.info(f"[music] playing {track.title!r} (limit {self._max_seconds:.0f}s)")
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

    def _arm_limit(self) -> None:
        if self._loop is None or self._max_seconds <= 0:
            return
        self._limit = self._loop.call_later(self._max_seconds, lambda: asyncio.ensure_future(self.stop("time limit")))

    # ---- events from outside ------------------------------------------------------------------------------------

    def _on_finished(self) -> None:
        """The player says the song ended (or was stopped). May be called from any thread."""
        if self._loop is not None and self._state == PLAYING:
            asyncio.run_coroutine_threadsafe(self.stop("finished"), self._loop)

    def on_mute_change(self, muted: bool) -> None:
        """CaptureGate listener: ANY mute or unmute ends the music. Runs on the thread that made the change."""
        if self.active and self._loop is not None:
            asyncio.run_coroutine_threadsafe(self.stop("muted" if muted else "unmuted"), self._loop)

    # ---- a reminder is about to be spoken -----------------------------------------------------------------------

    async def pause(self) -> None:
        if self._state == PLAYING and not self._paused_for_speech:
            try:
                await self._player.pause()
                self._paused_for_speech = True
            except Exception as e:
                logger.warning(f"[music] could not pause: {type(e).__name__}")

    async def resume(self) -> None:
        if self._state == PLAYING and self._paused_for_speech:
            self._paused_for_speech = False
            try:
                await self._player.resume()
            except Exception as e:
                logger.warning(f"[music] could not resume: {type(e).__name__}")


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
