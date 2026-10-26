"""RoomSensor — polls the room driver every few minutes and keeps the latest reading in RoomState.

A DHT11 read takes ~2 s and fails now and then, so it happens here, off the event loop and off any turn's path. A failed
read is logged and skipped: the last reading simply ages out (RoomPolicy treats an old one as absent)."""

from __future__ import annotations

import asyncio
from datetime import datetime
from typing import Callable, Protocol

from core.logging_config import logger
from domain.entities.room_snapshot import RoomSnapshot
from service.sensing.room_state import RoomState
from service.sensing.sensor_registry import BaseSensor


class RoomDriver(Protocol):
    def read(self) -> tuple[float, float]:
        """(temperature in Celsius, relative humidity in percent). Blocking. Raises when the sensor gave no reading."""
        ...


class RoomSensor(BaseSensor):
    def __init__(
        self, driver: RoomDriver, state: RoomState, poll_interval: float = 300.0,
        now: Callable[[], datetime] = datetime.now,
    ):
        super().__init__(poll_interval=poll_interval)
        self._driver = driver
        self._state = state
        self._now = now

    async def _poll_and_publish(self) -> None:
        try:
            temperature, humidity = await asyncio.to_thread(self._driver.read)
        except Exception as e:   # intermittent by nature; never raise into the loop
            logger.warning(f"[room] sensor read failed: {type(e).__name__}: {e}")
            return
        self._state.set(RoomSnapshot(float(temperature), float(humidity), self._now()))
