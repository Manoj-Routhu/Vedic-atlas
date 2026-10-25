"""Vision value objects. Plain data: no I/O, and nothing from memory, conversation or agents."""

from __future__ import annotations

from dataclasses import dataclass

STYLES = ("brief", "detailed", "read_text")
LANGUAGES = ("en",)   # v1 is English only; Hindi/Telugu are deferred (docs/15-vision-mobile-design.md section 6.6)


@dataclass(frozen=True)
class VisionStatus:
    enabled: bool
    loaded: bool   # the model process is up and answered /health
    busy: bool   # a request is in flight
    idle_seconds: float | None   # since the last request finished; None if never used
    model: str


@dataclass(frozen=True)
class ImageInfo:
    image_id: str
    width: int
    height: int
