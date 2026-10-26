"""MusicPolicy — which search result is the song the user asked for, and how it is announced. Pure.

The search order is YouTube's, and its top hit is usually right, but not always: a karaoke version, a cover or a
different song with a similar name can come first. So the top results are re-ranked by how many of the query's words the
title (or channel) contains, with a penalty for the versions people rarely mean. Ties keep YouTube's order, and when
nothing matches well the top hit is played anyway: the reply names it, so a wrong pick is heard at once.

Nothing here reads the user's message to choose an action; it only matches the model's own `query` against titles.
"""

from __future__ import annotations

import re
from typing import Sequence

from domain.entities.music_track import Candidate, Track
from domain.policies.mail_policy import clean_text

MAX_QUERY_CHARS = 100
MIN_SONG_SEC = 45
MAX_SONG_SEC = 15 * 60          # compilations and hour-long mixes are not "a song"
_TITLE_CHARS = 80
_WORDS = re.compile(r"\w+", re.UNICODE)
_FILLER = frozenset({"play", "song", "songs", "music", "the", "a", "an", "by", "from", "some", "me", "please", "track",
                     "video", "audio", "full", "official", "lyrics", "lyrical", "hd", "of", "movie", "film"})
# Versions people rarely mean. Only penalised when the query itself does not ask for them.
_UNWANTED = frozenset({"karaoke", "cover", "reaction", "remix", "slowed", "reverb", "8d", "instrumental", "tutorial",
                       "lesson", "mashup", "nightcore", "parody"})
_DECORATION = re.compile(r"\s*[\(\[][^)\]]*(official|video|audio|lyric|hd|4k|full song)[^)\]]*[\)\]]", re.IGNORECASE)


def clean_query(query: str | None) -> str:
    """One line, no control characters, bounded: it becomes part of a search string."""
    return clean_text(query or "", MAX_QUERY_CHARS)


def _tokens(text: str) -> list[str]:
    return [w for w in _WORDS.findall((text or "").lower()) if w not in _FILLER]


def score(query: str, candidate: Candidate, position: int) -> float:
    wanted = _tokens(query)
    if not wanted:
        return -position * 0.01
    have = set(_tokens(candidate.title)) | set(_tokens(candidate.channel))
    matched = sum(1 for w in wanted if w in have) / len(wanted)
    asked_for = set(_WORDS.findall(query.lower()))
    unwanted = sum(1 for w in _UNWANTED if w in set(_WORDS.findall(candidate.title.lower())) and w not in asked_for)
    return matched - 0.4 * unwanted - 0.01 * position


def _is_a_song(c: Candidate) -> bool:
    return c.duration_sec is not None and MIN_SONG_SEC <= c.duration_sec <= MAX_SONG_SEC


_LEADING_LABEL = re.compile(r"^\s*(full video|full song|video song|official video|video|lyrical|8k|4k|hd)\s*[:\-]\s*", re.IGNORECASE)


def spoken_title(title: str) -> str:
    """Short enough to say aloud: no "Full Video:" label, no "(Official Video)", and only the first two " | " parts
    ("Chikiri Chikiri | Peddi | Ram Charan | ..." is spoken as "Chikiri Chikiri, Peddi")."""
    cleaned = _DECORATION.sub("", clean_text(title, _TITLE_CHARS * 3))
    cleaned = _LEADING_LABEL.sub("", cleaned)
    parts = [p.strip(" -") for p in re.split(r"\s*\|\s*", cleaned) if p.strip(" -|")]
    return clean_text(", ".join(parts[:2]), _TITLE_CHARS) or "that song"


def pick_track(query: str, candidates: Sequence[Candidate]) -> Track | None:
    """The best match for `query` among the search hits, or None when there are none."""
    hits = [c for c in candidates if c.url]
    if not hits:
        return None
    songs = [(i, c) for i, c in enumerate(hits) if _is_a_song(c)] or list(enumerate(hits))
    _, best = max(songs, key=lambda ic: score(query, ic[1], ic[0]))
    return Track(title=spoken_title(best.title), url=best.url, duration_sec=best.duration_sec)
