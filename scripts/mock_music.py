"""Music for the mock Pi: the REAL MusicService and routes, with a fake search and a fake player (no mpv, no YouTube, no sound).

So the phone app meets the real wire format and the real pause / clock / time-limit behaviour.
Searches: any words find "<Words> - Mock Artist" (about 4 minutes long); words containing "zzz" find nothing.
"""

from __future__ import annotations

from domain.entities.music_track import Candidate
from service.music.music_service import MusicService


class _Gate:
    def __init__(self) -> None:
        self.closed = 0

    def pause_capture(self, source: str) -> None:
        self.closed += 1

    def resume_capture(self, source: str) -> None:
        self.closed -= 1


class _Resolver:
    async def search(self, query: str) -> list[Candidate]:
        if "zzz" in query.lower():
            return []
        return [Candidate(f"{query.title()} - Mock Artist", "Mock Channel", "https://mock.invalid/song", 240.0)]


class _Player:
    def __init__(self) -> None:
        self.is_playing = False

    async def start(self, url, on_finished) -> None:
        self.is_playing = True

    async def pause(self) -> None:
        pass

    async def resume(self) -> None:
        pass

    async def stop(self) -> None:
        self.is_playing = False


def make_music(max_seconds: float = 300.0) -> MusicService:
    return MusicService(_Resolver(), _Player(), _Gate(), max_seconds=max_seconds)
