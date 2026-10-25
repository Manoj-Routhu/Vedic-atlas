"""music_control — play a song by name, or stop the music.

The model supplies only `action` and the words of `query`; finding the right track is the music service's job
(search, then a match against the titles). Every reply is a template: it names the song so a wrong pick is heard at once.
"""

from __future__ import annotations

from domain.entities.agent_context import AgentContext
from domain.entities.skill_result import SkillResult
from domain.entities.tool_manifest import ToolManifest
from domain.ports.music_ports import MusicError
from service.music.music_service import MusicService
from service.skills.manifest_skill import ManifestSkill

ACTIONS = ("play", "stop")


class MusicSkill(ManifestSkill):
    what = "play music"

    def __init__(self, manifest: ToolManifest, music: MusicService, **kw):
        super().__init__(manifest, **kw)
        self._music = music

    async def run(self, ctx: AgentContext, action: str = "", query: str = "", **_) -> SkillResult:
        action = (action or "").lower()
        if action not in ACTIONS:
            return self._fail(f"invalid action {action!r}", "I can play a song or stop the music.")
        if action == "stop":
            stopped = await self._music.stop("asked")
            text = "Stopped the music." if stopped else "Nothing is playing."
            return self._ok(text, text)
        try:
            track = await self._music.play(query)
        except MusicError as e:
            return self._fail(str(e), e.spoken)
        text = f"Playing {track.title}."
        return self._ok(text, text)
