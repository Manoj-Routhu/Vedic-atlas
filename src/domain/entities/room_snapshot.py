"""RoomSnapshot — the latest reading of the sensor in the user's own room. Latest value only: no history."""

from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True)
class RoomSnapshot:
    temperature_c: float
    humidity_pct: float
    read_at: datetime
