"""Ports for music: finding a song, and playing it. One module because they only make sense together.

The resolver and the player are different jobs (docs/13 §1): the resolver turns a name into candidates, the player owns
the playback state (start, pause, resume, stop, "it ended").
"""

from typing import Callable, Protocol, runtime_checkable

from domain.entities.music_track import Candidate


class MusicError(Exception):
    """A music request that cannot be done. `spoken` is the sentence for the user; the message is for the log."""

    def __init__(self, message: str, spoken: str):
        super().__init__(message)
        self.spoken = spoken


@runtime_checkable
class MusicResolverPort(Protocol):
    async def search(self, query: str) -> list[Candidate]:
        """The top hits for `query`, best first. Raises MusicError when the search itself fails."""
        ...


@runtime_checkable
class MusicPlayerPort(Protocol):
    @property
    def is_playing(self) -> bool:
        ...

    async def start(self, url: str, on_finished: Callable[[], None]) -> None:
        """Start playing `url`. `on_finished` is called (on any thread) when playback ends by itself or is stopped."""
        ...

    async def pause(self) -> None:
        ...

    async def resume(self) -> None:
        ...

    async def stop(self) -> None:
        """Stop and release everything. Safe to call when nothing is playing."""
        ...
