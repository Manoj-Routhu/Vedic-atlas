"""Short, simple "I'm working on it" phrases, picked at random.

Used by the voice loop (spoken while the model works) and the CLI (a changing word next to the spinner). Plain words
only. The picker never returns the same phrase twice in a row.
"""

from __future__ import annotations

import random
from typing import Sequence

# Spoken first, a second or so after the question.
FILLER_PHRASES: tuple[str, ...] = (
    "Let me think.",
    "One moment.",
    "Hmm, let me see.",
    "Thinking.",
    "Just a sec.",
    "Checking.",
    "Looking into it.",
    "Give me a moment.",
    "Let me check.",
    "Okay, working on it.",
)

# Spoken when the wait is long and a second or third phrase is needed.
FILLER_STILL_PHRASES: tuple[str, ...] = (
    "Still on it.",
    "Almost there.",
    "Still working on it.",
    "Just a bit more.",
)

# The same, for a Hindi turn (spoken by the Hindi voice). Short, plain, in Devanagari.
HINDI_FILLER_PHRASES: tuple[str, ...] = (
    "सोचने दीजिए।",
    "एक पल।",
    "हम्म, देखता हूँ।",
    "एक सेकंड।",
    "देख रहा हूँ।",
    "ज़रा रुकिए।",
    "चेक कर रहा हूँ।",
    "ठीक है, देखता हूँ।",
)

HINDI_FILLER_STILL_PHRASES: tuple[str, ...] = (
    "अभी भी लगा हूँ।",
    "बस थोड़ा और।",
    "लगभग हो गया।",
    "थोड़ा और समय दीजिए।",
)

# CLI spinner words (no punctuation; the spinner adds the dots).
CLI_STATUS_WORDS: tuple[str, ...] = (
    "Thinking",
    "Checking",
    "Looking into it",
    "Working on it",
    "One moment",
    "Just a sec",
    "Hmm",
)


class PhrasePicker:
    """Random choice from a list that skips the phrase it returned last."""

    def __init__(self, phrases: Sequence[str], rng: random.Random | None = None):
        self._phrases = [p for p in phrases if p and p.strip()]
        self._rng = rng or random.Random()
        self._last: str | None = None

    def pick(self) -> str:
        if not self._phrases:
            return ""
        choices = [p for p in self._phrases if p != self._last] or self._phrases
        self._last = self._rng.choice(choices)
        return self._last
