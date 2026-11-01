"""LanguagePolicy — what language a user message is in.

Two sources, in this order:

  1. `language_of()` — deterministic, free, and exact for the script it knows
     (Devanagari/Hindi). It overrides the model so Hindi can never be mislabelled.
  2. `normalise_language()` — the label the control model wrote for its own
     turn (`ControlDecision.language`), reduced to the two supported languages:
     English and Hindi. Any other language the model names is English: this
     device does not speak it, so the reply is English.

`looks_like_text()` guards the "I didn't understand" reply so it can only fire
for something that really reads as language (not "2+2" or "ok").

Pure text logic, no I/O, no dependency on an LLM or a language-detection model.
"""

from __future__ import annotations

import re

_DEVANAGARI = range(0x0900, 0x0980)
SUPPORTED_LABELS = {"english": "English", "hindi": "Hindi"}
_LABEL_RE = re.compile(r"[A-Za-z][A-Za-z .'()-]{0,23}")
_UNKNOWN_LABELS = frozenset({"", "unknown", "none", "n/a", "other", "undetermined", "cannot tell"})
MAX_LANGUAGE_LABEL = 24


def language_of(text: str) -> str | None:
    """The deterministic answer for `text`, or None when this policy cannot name it."""
    if not text:
        return None
    has_devanagari = False
    for char in text:
        code = ord(char)
        if code in _DEVANAGARI:
            has_devanagari = True
    if has_devanagari:
        return "Hindi"
    return None


def resolve_language(message: str, claimed: str | None) -> str | None:
    """The turn's language: the script detector first, else the model's claim - but a claim of Hindi needs Devanagari.

    After a run of Hindi turns the decider sometimes tags an English message "Hindi" (measured: "what is the weather in
    Pune" came back "language":"Hindi" and the reply was translated). Speech recognition writes Hindi in Devanagari, so a
    message with none of it is English whatever the model says."""
    detected = language_of(message)
    if detected:
        return detected
    label = normalise_language(claimed)
    if label == "Hindi":
        return "English"
    return label


def normalise_language(label: str | None) -> str | None:
    """The model's label as English or Hindi, or None when it is "unknown" / not a name.

    The control model is asked for "Hindi" or "unknown". Anything that is not a short alphabetic name is
    treated as unknown so a stray token can never be pasted into a prompt. A real language name that is not
    supported ("German", "Japanese") is English: the device answers in English rather than in a language it has
    no recognition or voice for.
    """
    if not label:
        return None
    text = " ".join(str(label).strip().strip('".').split())
    if text.lower() in _UNKNOWN_LABELS:
        return None
    if len(text) > MAX_LANGUAGE_LABEL or not _LABEL_RE.fullmatch(text):
        return None
    return SUPPORTED_LABELS.get(text.lower(), "English")


def looks_like_text(text: str, min_letters: int = 8) -> bool:
    """True when the message is plausibly natural language (not maths, a number, or "ok").

    Used only to decide whether an unidentifiable message deserves "I didn't
    understand that": two alphabetic words and at least `min_letters` letters.
    Works for any script via `str.isalpha()`.
    """
    words = [word for word in (text or "").split() if any(char.isalpha() for char in word)]
    letters = sum(1 for char in text or "" if char.isalpha())
    return len(words) >= 2 and letters >= min_letters


# Languages whose own script is not Latin: text in plain ASCII letters is not in that language.
_NON_LATIN_LANGUAGES = frozenset({"hindi"})
_SENTENCE_END = re.compile(r"(?<=[.!?\u0964\u0965\u3002\uff01\uff1f])\s+")
TRANSLATE_MAX_CHARS = 120


def shorten_for_translation(text: str, max_chars: int = TRANSLATE_MAX_CHARS) -> str:
    """The first whole sentence(s) of `text` that fit in `max_chars`; a first sentence that is itself too long is cut at
    its last word boundary. Translating into Hindi costs 3-6x the tokens of English and decode runs at a fraction
    of a second per token, so a long sentence overruns the output limit and the whole translation is thrown away
    (measured: 42 English tokens -> more than 120 Hindi tokens, cut off, 0 characters kept; a 19-token sentence took 93
    tokens and worked). A short, finished translation beats a long one that never completes."""
    clean = " ".join((text or "").split())
    if len(clean) <= max_chars:
        return clean
    kept = ""
    for sentence in _SENTENCE_END.split(clean):
        candidate = f"{kept} {sentence}".strip()
        if len(candidate) > max_chars:
            break
        kept = candidate
    if kept:
        return kept
    head = clean[:max_chars + 1]
    # A first sentence that is too long: end it at the last clause boundary that fits, else at the last word.
    clause = max(head.rfind(", "), head.rfind("; "), head.rfind(" - "))
    cut = head[:clause] if clause >= 40 else head.rsplit(" ", 1)[0]
    return cut.rstrip(",;:- ") + "."


def voice_language(text: str, language: str | None) -> str | None:
    """The language to pick a TTS voice for `text`. A Hindi voice cannot read English: when the turn's
    language has its own script but the reply came out in plain Latin letters (a failed translation, a fixed English
    fallback), speak it with the default voice instead of mangling it. Anything else keeps the turn's language."""
    if not language or language.strip().lower() not in _NON_LATIN_LANGUAGES:
        return language
    letters = [char for char in (text or "") if char.isalpha()]
    if letters and all(ord(char) < 128 for char in letters):
        return None
    return language
