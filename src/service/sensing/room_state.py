"""RoomState — the latest room reading, held in memory. Passive context, deliberately not on the event bus (that is for
proactive announcements). One writer (the sensor), many readers (the chat prompt and the room tool)."""

from __future__ import annotations

from domain.entities.room_snapshot import RoomSnapshot


class RoomState:
    def __init__(self) -> None:
        self._snapshot: RoomSnapshot | None = None

    def get(self) -> RoomSnapshot | None:
        return self._snapshot

    def set(self, snapshot: RoomSnapshot) -> None:
        self._snapshot = snapshot
