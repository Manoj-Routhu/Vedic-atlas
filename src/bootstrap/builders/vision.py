"""Phone-camera vision: the model process manager, its adapter and the service. `None` when vision is switched off."""

from __future__ import annotations

from service.vision.vision_service import VisionService


def build_vision(cfg) -> VisionService | None:
    if not cfg.vision.enabled:
        return None
    from tpa.vision.llama_server_adapter import LlamaServerVisionAdapter
    from tpa.vision.vision_process_manager import VisionProcessManager

    manager = VisionProcessManager(cfg.vision)
    return VisionService(LlamaServerVisionAdapter(manager, cfg.vision), cfg.vision)
