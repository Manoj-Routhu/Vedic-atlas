"""VisionPort - the only way the service layer reaches an image-understanding model.

Separate from InferencePort on purpose: vision is its own thread of the system (own process, own
limits, no shared locks, no memory or conversation). Every implementation must talk to a model on
this machine only (loopback), like InferencePort.
"""

from __future__ import annotations

import asyncio
from typing import AsyncIterator, Protocol, runtime_checkable

from domain.entities.vision import VisionStatus


@runtime_checkable
class VisionPort(Protocol):
    def describe(self, image: bytes, mime: str, prompt: str, *, cancel: asyncio.Event) -> AsyncIterator[str]:
        """Stream the model's reply to `prompt` about `image` as text chunks.

        Starts the model first if it is not running (raising AppException VISION_UNAVAILABLE when it
        cannot, e.g. not enough free memory). Stops early once `cancel` is set.
        """
        ...

    async def status(self) -> VisionStatus: ...

    async def start(self) -> None:
        """Prepare to serve (watchers, pidfile cleanup). Does NOT load the model: that happens on first use."""
        ...

    async def stop(self) -> None:
        """Stop the model process and release everything. Safe to call twice."""
        ...
