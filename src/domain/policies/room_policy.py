"""RoomPolicy — how a room reading is shown. Pure.

Two rules: a reading older than `max_age_sec` is ABSENT, never presented as current; and the sensor (a DHT11) is only
accurate to about 2 degrees, so temperature and humidity are rounded to whole numbers and never imply more precision.
"""

from __future__ import annotations

from datetime import datetime

from domain.entities.room_snapshot import RoomSnapshot


def is_fresh(snapshot: RoomSnapshot | None, now: datetime, max_age_sec: float) -> bool:
    if snapshot is None:
        return False
    age = (now - snapshot.read_at).total_seconds()
    return -60 <= age <= max_age_sec   # a clock set slightly back is tolerated; a reading from the future is not


def _ago(seconds: float) -> str:
    minutes = int(max(seconds, 0) // 60)
    return "just now" if minutes < 1 else f"{minutes} min ago"


def room_line(snapshot: RoomSnapshot | None, now: datetime, max_age_sec: float) -> str:
    """One line for the chat prompt, or "" when there is no fresh reading."""
    if not is_fresh(snapshot, now, max_age_sec):
        return ""
    ago = _ago((now - snapshot.read_at).total_seconds())
    return f"ROOM: {round(snapshot.temperature_c)}°C, {round(snapshot.humidity_pct)}% humidity ({ago})."


def room_sentence(snapshot: RoomSnapshot) -> str:
    """The tool's spoken sentence. It names the room, so it cannot be mistaken for the weather outside."""
    return f"It's {round(snapshot.temperature_c)} degrees in here, with {round(snapshot.humidity_pct)} percent humidity."
