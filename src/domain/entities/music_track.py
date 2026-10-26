"""Candidate / Track — a search hit for a song, and the one chosen to play. Pure data."""

from dataclasses import dataclass


@dataclass(frozen=True)
class Candidate:
    title: str
    channel: str
    url: str                       # what the player is given
    duration_sec: float | None     # None for a live stream or when unknown


@dataclass(frozen=True)
class Track:
    title: str                     # as it will be spoken: cleaned, without "(Official Video)" decoration
    url: str
    duration_sec: float | None = None
