"""DeviceRegistryPort - where paired devices are kept. Single owner: the server process."""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from domain.entities.device import Device


@runtime_checkable
class DeviceRegistryPort(Protocol):
    def add(self, device: Device) -> None: ...

    def get_by_token_hash(self, token_hash: str) -> Device | None: ...

    def list(self) -> list[Device]: ...

    def remove(self, device_id: str) -> bool:
        """True if a device was removed. Takes effect on the next request."""
        ...

    def touch(self, device_id: str) -> None:
        """Record that the device was just seen (may be persisted lazily)."""
        ...
