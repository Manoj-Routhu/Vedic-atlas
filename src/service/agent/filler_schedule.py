"""When to say an "I'm working on it" phrase while the model works.

One schedule, two users: the voice loop speaks each phrase, the phone's /api/stream sends each as an SSE `filler` event.
Only the timing lives here (no audio, no HTTP): a phrase is due `first_delay_sec` after the question, then one from the
"still" list every `repeat_sec`, `max_count` in all, and none once the reply has started.

The phrases themselves are in core/filler.py and the config (AudioConfig.filler_*).
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, AsyncIterator, Sequence

from core.filler import PhrasePicker


@dataclass(frozen=True)
class FillerSettings:
    """The filler lists and timing, as configured (AudioConfig.filler_*)."""

    phrases: tuple[str, ...]
    still_phrases: tuple[str, ...]
    phrases_hi: tuple[str, ...]
    still_phrases_hi: tuple[str, ...]
    first_delay_sec: float
    repeat_sec: float
    max_count: int

    @classmethod
    def from_audio(cls, audio: Any) -> "FillerSettings":
        return cls(
            phrases=tuple(audio.filler_phrases),
            still_phrases=tuple(audio.filler_still_phrases),
            phrases_hi=tuple(audio.filler_phrases_hi),
            still_phrases_hi=tuple(audio.filler_still_phrases_hi),
            first_delay_sec=audio.filler_first_delay_sec,
            repeat_sec=audio.filler_repeat_sec,
            max_count=audio.filler_max_count,
        )

    def phrases_for(self, hindi: bool) -> tuple[Sequence[str], Sequence[str]]:
        """(first phrases, later phrases) for the language of the turn. An empty "still" list falls back to the first one."""
        first, later = (self.phrases_hi, self.still_phrases_hi) if hindi else (self.phrases, self.still_phrases)
        return first, later or first


async def filler_phrases(
    reply_started: asyncio.Event,
    *,
    first: Sequence[str],
    later: Sequence[str],
    first_delay_sec: float,
    repeat_sec: float,
    max_count: int,
) -> AsyncIterator[str]:
    """Yield each phrase when it is due; return as soon as `reply_started` is set.

    The wait for the next phrase starts when the caller asks for it, so a caller that is busy saying a phrase (the voice
    loop waits for the audio to finish) gets the next one `repeat_sec` after it is done. Never the same phrase twice in a
    row (PhrasePicker).
    """
    first_picker, later_picker = PhrasePicker(first), PhrasePicker(later)
    for count in range(max_count):
        delay = first_delay_sec if count == 0 else repeat_sec
        try:
            await asyncio.wait_for(reply_started.wait(), timeout=delay)
            return   # the reply began first
        except asyncio.TimeoutError:
            pass
        phrase = (first_picker if count == 0 else later_picker).pick()
        if not phrase:
            return
        yield phrase
