"""get_room_temperature — the temperature and humidity of the user's own room, from the room sensor.

Reads the latest snapshot held in memory, NEVER the hardware: a sensor read takes ~2 s and fails now and then, so it must
not sit in a turn's critical path. No fresh snapshot means a clean failure, never an old reading passed off as current."""

from __future__ import annotations

from datetime import datetime
from typing import Callable

from domain.entities.agent_context import AgentContext
from domain.entities.skill_result import SkillResult
from domain.entities.tool_manifest import ToolManifest
from domain.policies.room_policy import is_fresh, room_sentence
from service.sensing.room_state import RoomState
from service.skills.manifest_skill import ManifestSkill

UNAVAILABLE = "I can't read the room sensor right now."


class RoomTemperatureSkill(ManifestSkill):
    what = "read the room sensor"

    def __init__(self, manifest: ToolManifest, state: RoomState, max_age_sec: float,
                 now: Callable[[], datetime] = datetime.now, **kw):
        super().__init__(manifest, **kw)
        self._state, self._max_age, self._now = state, max_age_sec, now

    async def run(self, ctx: AgentContext, **_) -> SkillResult:
        snapshot = self._state.get()
        if not is_fresh(snapshot, self._now(), self._max_age):
            return self._fail("no fresh room reading", UNAVAILABLE)
        text = room_sentence(snapshot)
        return self._ok(text, text)
