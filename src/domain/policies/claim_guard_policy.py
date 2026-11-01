"""SentenceClaimGuard — the claims_action backstop for a STREAMED reply. Pure.

A streamed reply is spoken as it is generated, so it cannot be vetted whole afterwards. This releases text
only in complete sentences, each checked first; the first sentence that asserts an unbacked tool action
("Task added", "It's 31 degrees") trips the guard and nothing from it onward is released.
"""

import re
from typing import Callable

# Latin . ! ? and the Devanagari danda (Hindi) end a sentence at the following whitespace; the full-width Japanese
# marks end it with no whitespace after them. Without these a Hindi/Japanese reply was held until the stream ended.
_SENTENCE_END = re.compile(r"(?<=[.!?\u0964\u0965])\s+|(?<=[\u3002\uff01\uff1f])\s*|\n+")


class SentenceClaimGuard:
    def __init__(self, is_claim: Callable[[str], bool]):
        self._is_claim = is_claim
        self._buffer = ""
        self.tripped = False
        self.released = False   # True once any text has been let through

    def _release(self, sentence: str) -> list[str]:
        if self.tripped or not sentence.strip():
            return []
        if self._is_claim(sentence):
            self.tripped = True
            return []
        self.released = True
        return [sentence]

    def feed(self, text: str) -> list[str]:
        """Add streamed text; returns the sentences now safe to release (each keeps its trailing space)."""
        if self.tripped:
            return []
        self._buffer += text
        out: list[str] = []
        while True:
            m = _SENTENCE_END.search(self._buffer)
            if m is None:
                return out
            sentence, self._buffer = self._buffer[: m.end()], self._buffer[m.end():]
            out += self._release(sentence)
            if self.tripped:
                return out

    def finish(self) -> list[str]:
        """End of stream: vet and release whatever is left."""
        if self.tripped:
            return []
        tail, self._buffer = self._buffer, ""
        return self._release(tail)
