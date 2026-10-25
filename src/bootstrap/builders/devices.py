"""Phone pairing: the device registry and its service. `None` when devices are disabled (every non-loopback request is then refused)."""

from __future__ import annotations

from service.devices.device_service import DeviceService


def build_devices(cfg) -> DeviceService | None:
    if not cfg.devices.enabled:
        return None
    from tpa.filestore.json_device_registry import JsonDeviceRegistry
    return DeviceService(JsonDeviceRegistry(), cfg.devices)
