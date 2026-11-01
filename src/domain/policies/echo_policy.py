"""EchoPolicy — did the model hand the user's own message back instead of answering?

Small quantized models fall into "continue the input" mode: a short statement in the user's language comes
back nearly verbatim, sometimes with a word completed. This is a reply filter, not a language detector and
not a paraphrase check: only near-identity counts. Pure text logic, no I/O.

Normalisation keeps every combining mark (Devanagari/Telugu matras are Unicode category Mn, not punctuation)
and drops only whitespace runs and punctuation, so "आज मेरा जन्मदिन है?" and "आज मेरा जन्मदिन है" compare equal.
"""

from __future__ import annotations

import unicodedata
from difflib import SequenceMatcher

DEFAULT_THRESHOLD = 0.85
_MIN_CONTAINMENT_CHARS = 12   # a one-word reply must not count as an echo of a longer message

# What to say when the model echoed twice. A controlled sentence, never the user's own words; English is the
# fallback for a language this table does not cover.
_FALLBACK_REPLIES = {
    "english": "Sorry, I couldn't answer that. Could you say it another way?",
    "hindi": "माफ़ कीजिए, मैं इसका जवाब नहीं दे पाई।",
}


def fallback_reply(language: str | None) -> str:
    """The fixed sentence for a turn that could not be answered, in the turn's language when known."""
    return _FALLBACK_REPLIES.get((language or "").strip().lower(), _FALLBACK_REPLIES["english"])


def _normalise(text: str) -> str:
    out: list[str] = []
    for char in (text or "").casefold():
        if char.isspace():
            out.append(" ")
        elif unicodedata.category(char).startswith("P"):
            continue
        else:
            out.append(char)
    return " ".join("".join(out).split())


def is_exact_echo(reply: str, user_message: str) -> bool:
    """True when `reply` IS the user's message: equal, or one contains the other (the model "continued the input")."""
    replied, asked = _normalise(reply), _normalise(user_message)
    if not replied or not asked:
        return False
    if replied == asked:
        return True
    return (
        len(replied) >= _MIN_CONTAINMENT_CHARS
        and len(asked) >= _MIN_CONTAINMENT_CHARS
        and (replied in asked or asked in replied)
    )


def is_echo(reply: str, user_message: str, threshold: float = DEFAULT_THRESHOLD) -> bool:
    """True when `reply` is essentially `user_message` (equal, contained, or >= `threshold` similar)."""
    if is_exact_echo(reply, user_message):
        return True
    replied, asked = _normalise(reply), _normalise(user_message)
    if not replied or not asked:
        return False
    return SequenceMatcher(None, replied, asked).ratio() >= threshold


class EchoHold:
    """Judges a streamed reply sentence by sentence: did the model hand the user's message back?

    A first sentence that only RESEMBLES the message (the Hindi "me too" after "I like reading books") is a normal
    way to start a real answer, so it is held, not judged. If a different sentence follows, the reply was an answer
    and both are released; if the reply ends (or only more echo follows), it was an echo. An identical or continued
    copy of the message is still an echo at once, so the user never hears their own words back."""

    def __init__(self, user_message: str, threshold: float = DEFAULT_THRESHOLD):
        self._user = user_message
        self._threshold = threshold
        self._first = True
        self._held: str | None = None

    @property
    def pending(self) -> bool:
        """A similar-looking first sentence is still waiting for the sentence that decides it."""
        return self._held is not None

    def feed(self, sentence: str) -> tuple[list[str], bool]:
        """(sentences to release now, whether the reply is an echo)."""
        if self._held is not None:
            held, self._held = self._held, None
            if is_echo(sentence, self._user, self._threshold):
                return [], True
            return [held, sentence], False
        if self._first:
            self._first = False
            if is_exact_echo(sentence, self._user):
                return [], True
            if is_echo(sentence, self._user, self._threshold):
                self._held = sentence
                return [], False
        return [sentence], False
