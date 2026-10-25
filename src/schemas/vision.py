"""Request/response bodies for the vision routes."""

from __future__ import annotations

from pydantic import BaseModel, Field


class AskRequest(BaseModel):
    image_id: str = Field(min_length=1, max_length=64)
    question: str | None = Field(default=None, max_length=300)   # none = just describe the photo
    style: str = "brief"   # brief | detailed | read_text (checked by the service)
    lang: str = "en"   # v1: English only (checked by the service)


class ImageResponse(BaseModel):
    image_id: str
    width: int
    height: int


class VisionStatusResponse(BaseModel):
    enabled: bool
    loaded: bool
    busy: bool
    idle_seconds: float | None = None
    model: str
