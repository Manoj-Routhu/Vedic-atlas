"""Make a streamed model reply fit to be read aloud: no markdown marks, no list bullets, one line.

The phone speaks the text, so `**bold**`, `# headings`, backticks and "1." / "-" list markers would be read out
or break the sentence. Works on a stream: feed chunks as they arrive, call flush() at the end.
"""

from __future__ import annotations

import re

_MARKS = str.maketrans("", "", "*#`")
_BULLET = re.compile(r"^\s*(?:[-*•]|\d{1,2}[.)])\s")
_MAYBE_BULLET_START = re.compile(r"^\s*(?:[-*•]|\d{1,2}[.)]?)?\s*$")
_LINE_START_HOLD = 5   # characters held back at a line start while deciding whether they are a list marker


class SpeechCleaner:
    def __init__(self) -> None:
        self._line_start = True
        self._held = ""   # the start of the current line, until it is clear it is not a list marker
        self._last_was_space = True

    def feed(self, chunk: str) -> str:
        out: list[str] = []
        for ch in chunk.translate(_MARKS).replace("\r", ""):
            if ch == "\n":
                out.append(self._release_held())
                self._line_start = True
                ch = " "
            elif self._line_start:
                self._held += ch
                if _BULLET.match(self._held):   # a list marker: drop it
                    self._held = ""
                    self._line_start = False
                elif len(self._held) >= _LINE_START_HOLD or not _MAYBE_BULLET_START.match(self._held):
                    out.append(self._release_held())
                    self._line_start = False
                continue
            out.append(self._squash(ch))
        return "".join(out)

    def flush(self) -> str:
        return self._release_held()

    def _release_held(self) -> str:
        held, self._held = self._held, ""
        return "".join(self._squash(c) for c in held)

    def _squash(self, ch: str) -> str:
        """Collapse runs of whitespace to one space and never start with one."""
        if ch.isspace():
            if self._last_was_space:
                return ""
            self._last_was_space = True
            return " "
        self._last_was_space = False
        return ch
