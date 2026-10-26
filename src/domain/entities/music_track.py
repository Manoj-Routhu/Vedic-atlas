"""Candidate / Track — a search hit for a song, and the one chosen to play. Pure data."""

from dataclasses import dataclass


@dataclass(frozen=True)
class Candidate:
    title: str
    channel: str
    url: str                       # what the player is given
    duration_sec: float | None     # None for a live stream or when unknown


@dataclass(frozen=True)
class MusicStatus:
    """What the music is doing right now (for the phone). `state`: idle | starting | playing | paused."""

    state: str
    title: str | None = None
    elapsed_s: float | None = None     # seconds actually played (a pause does not count); None unless playing or paused
    limit_s: float | None = None       # the song stops by itself when elapsed_s reaches this
    duration_s: float | None = None    # the song's own length, when known


@dataclass(frozen=True)
class Track:
    title: str                     # as it will be spoken: cleaned, without "(Official Video)" decoration
    url: str
    duration_sec: float | None = None
