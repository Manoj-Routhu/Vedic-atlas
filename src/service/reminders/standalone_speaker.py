"""StandaloneSpeaker — speaks a reminder when there is no voice loop (voice disabled, or its wake word could not start).

The voice session normally speaks reminders. Without it the reminder was only printed, so a due reminder made no sound. This
is the same TTS voice and the same speaker, minus the microphone: nothing here listens. It implements the three methods the
announcer needs, so the announcer is unchanged.

It speaks one reminder at a time and answers "busy" while one is playing; the announcer then keeps the reminder and tries
again, exactly as it does when the voice loop is busy. When the voice loop IS running it is used instead of this class, so
a reminder still waits for a reply in progress to finish.
"""

from __future__ import annotations

import asyncio

from core.logging_config import logger


class StandaloneSpeaker:
    def __init__(self, tts, playback, wait_timeout_sec: float = 45.0):
        self._tts = tts
        self._playback = playback
        self._wait_timeout = wait_timeout_sec
        self._speaking = False

    def available(self) -> bool:
        return True

    def is_busy(self) -> bool:
        return self._speaking

    async def announce(self, text: str) -> bool:
        """Speak `text` unless another reminder is being spoken right now (False = busy, try again)."""
        if self._speaking:
            return False
        self._speaking = True
        try:
            self._playback.start()   # idempotent: one playback thread, started on first use
            spoke = False
            async for pcm in self._tts.synthesize(text):
                if pcm:
                    self._playback.play_pcm(pcm, self._tts.sample_rate)
                    spoke = True
            if spoke:
                finished = await asyncio.to_thread(self._playback.wait_done, self._wait_timeout)
                if not finished:
                    logger.warning("[reminders] spoken reminder did not finish within the timeout")
            else:
                logger.warning("[reminders] the voice produced no audio for a reminder")
            return True
        finally:
            self._speaking = False

    def stop(self) -> None:
        try:
            self._playback.stop()
        except Exception:
            pass
