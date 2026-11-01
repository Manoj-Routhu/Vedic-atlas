"""SessionStatePolicy — the rules for what session state may be written and how it is shown.

Pure. Time is passed in. The orchestrator (Phase 3) renders `active_line` into the *volatile*
tail of the control prompt; Phase 1 only logs it (shadow mode).
"""

import re
from datetime import datetime, timedelta
from typing import Any, Mapping

from domain.entities.session_context import SessionContext
from domain.entities.tool_manifest import ToolManifest
from domain.policies.destructive_policy import is_destructive

DEFAULT_TTL_SEC = 900
_MAX_SLOT_CHARS = 60   # keeps ACTIVE: near ~25 tokens


def is_expired(state: SessionContext, now: datetime) -> bool:
    return state.expires_at <= now


def usable_slots(args: Mapping[str, Any]) -> dict[str, Any]:
    """Drop empty values: "" / None carry no information to inherit (and "" means "home" to the place resolver)."""
    return {k: v for k, v in args.items() if v not in (None, "")}


def state_after_call(
    manifest: ToolManifest,
    args: Mapping[str, Any],
    *,
    session_id: str,
    speaker_id: str,
    now: datetime,
    ttl_sec: int = DEFAULT_TTL_SEC,
) -> SessionContext | None:
    """The state to store after a SUCCESSFUL call, or None when this call must not be remembered."""
    if is_destructive(manifest, args):
        return None
    return SessionContext(
        session_id=session_id, speaker_id=speaker_id, tool=manifest.name, slots=usable_slots(args),
        updated_at=now, expires_at=now + timedelta(seconds=ttl_sec),
    )


def _age(seconds: float) -> str:
    if seconds < 60:
        return "just now"
    return f"{int(seconds // 60)} min ago"


# ---- does this message continue the previous one? ---------------------------------------------------------------------------
# A web search is open-ended: its ACTIVE line carries a free-text query. Shown for a message that merely shares the session, the
# decider rewrote the new question into the old topic (measured: after "latest news about cricket", "tell me a joke" searched
# "latest joke about cricket", and "what is the capital of India" in Hindi searched "current prime minister of Japan").
# A real follow-up points back at something: a pronoun or "there/that/one", an opening "and / what about / also", or it is
# too short to stand alone. Words only, no model: English and Hindi (Devanagari).
_FOLLOW_UP_WORDS = frozenset({
    "it", "its", "they", "them", "their", "theirs", "he", "him", "his", "she", "her", "hers", "there", "that", "those",
    "this", "these", "one", "ones", "same", "other", "another", "again", "more", "else",
    "\u0935\u0939", "\u0935\u094b", "\u0935\u0947", "\u0909\u0928", "\u0909\u0928\u0915\u0947", "\u0909\u0928\u0915\u093e",
    "\u0909\u0938\u0915\u0947", "\u0909\u0938\u0915\u093e", "\u0909\u0938\u0947", "\u0907\u0938\u0915\u0947", "\u0907\u0938\u0915\u093e",
    "\u0907\u0938\u0947", "\u092f\u0939", "\u092f\u0947", "\u0907\u0928", "\u0935\u0939\u093e\u0901", "\u0935\u0939\u093e\u0902",
    "\u092f\u0939\u093e\u0901", "\u092f\u0939\u093e\u0902",
    # NOT "\u0914\u0930 / \u092d\u0940 / \u092b\u093f\u0930" (and / also / then): everyday conjunctions inside a stand-alone question
    # ("Delhi AND Mumbai"); they count only as an OPENER, below.
    "\u0926\u0942\u0938\u0930\u093e", "\u0926\u0942\u0938\u0930\u0947",
})
_FOLLOW_UP_OPENERS = ("and ", "also ", "what about ", "how about ", "what else", "and,", "\u0914\u0930 ", "\u092b\u093f\u0930 ")
_SHORT_WORDS = 2
# Split on whitespace and punctuation (incl. the Devanagari danda). NOT on \w: Python does not count Devanagari vowel signs as
# word characters, so "वो" would be cut into pieces.
_SPLIT = re.compile(r"[\s,.;:!?\"()\[\]\-–—।॥]+")


_LEADING_FILLERS = frozenset({"ok", "okay", "yes", "yeah", "yep", "no", "so", "well", "hey", "veda", "right", "sure", "oh", "hmm"})
_FOLLOW_UP_PHRASES = ("what about", "how about", "what else", "and then")


def continues_previous(message: str) -> bool:
    """True when `message` points back at the previous turn (see above)."""
    text = (message or "").strip().lower()
    words = [w.strip("'") for w in _SPLIT.split(text) if w.strip("'")]
    if len(words) <= _SHORT_WORDS:
        return True
    while words and words[0] in _LEADING_FILLERS:     # "ok and what about the day after" opens with a filler
        words = words[1:]
        text = text.split(None, 1)[1] if len(text.split(None, 1)) > 1 else ""
    if len(words) <= _SHORT_WORDS or text.startswith(_FOLLOW_UP_OPENERS):
        return True
    if any(phrase in text for phrase in _FOLLOW_UP_PHRASES):
        return True
    return any(word in _FOLLOW_UP_WORDS for word in words)


def active_line(state: SessionContext | None, now: datetime, message: str | None = None) -> str:
    """`ACTIVE: get_weather | place=Tokyo | 3 min ago`, or "" when there is nothing fresh to show.

    With `message`, a web-search state is shown only to a message that continues it (see `continues_previous`)."""
    if state is None or is_expired(state, now):
        return ""
    if message is not None and state.tool == "web_search" and not continues_previous(message):
        return ""
    slots = " ".join(f"{k}={str(v)[:_MAX_SLOT_CHARS]}" for k, v in state.slots.items())
    parts = [state.tool] + ([slots] if slots else []) + [_age((now - state.updated_at).total_seconds())]
    return "ACTIVE: " + " | ".join(parts)
