"""Request/response bodies for the music routes."""

from __future__ import annotations

from pydantic import BaseModel, Field


class PlayRequest(BaseModel):
    query: str = Field(min_length=1, max_length=200)   # the words of the song; the service cleans and bounds them


class MusicStatusResponse(BaseModel):
    available: bool
    reason: str | None = None   # when not available: off | offline | tools_missing
    state: str = "idle"   # idle | starting | playing | paused
    title: str | None = None
    elapsed_s: float | None = None
    limit_s: float | None = None
    duration_s: float | None = None
