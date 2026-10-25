"""A stand-in for the Pi, for developing and testing the phone app without the model or the full Veda server.

What is REAL: the vision routes and VisionService, the device pairing routes and DeviceService, the approval routes and
ApprovalBroker, and the DeviceAuthMiddleware that gates them. What is FAKE: the vision model (scripted answers, with a
cold-start delay like the real one) and the chat brain (canned replies). So the phone app meets the real wire format,
the real error responses and the real permission rules.

Run:   vedic-atlas-env/Scripts/python.exe scripts/mock_pi.py --host 0.0.0.0
It prints a pairing code to type into the app (and a veda://pair link). Codes last 10 minutes here.
Paired phones are remembered between restarts (see --state-dir), like the real Pi: stop and restart it and the phone stays paired.

Chat tries: "hello" (echo), "multi" (a reply with line breaks), "send an email" (creates a real pending approval).
Admin helpers (loopback only):  GET /mock/state   POST /mock/code?approve=1   POST /mock/revoke-all   POST /mock/yolo?on=1   POST /mock/expire-images
"""

from __future__ import annotations

import argparse
import asyncio
import ipaddress
import socket
import sys
import tempfile
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))
HERE = str(Path(__file__).resolve().parent)
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from fastapi import FastAPI, Request  # noqa: E402

from controller.middleware.device_auth import DeviceAuthMiddleware, is_loopback  # noqa: E402
from controller.routes import approval as approval_route  # noqa: E402
from controller.routes import devices as devices_route  # noqa: E402
from controller.routes import vision as vision_route  # noqa: E402
from mock_control import MockControlState, make_control_router  # noqa: E402
from controller.sse.encoder import sse_encode  # noqa: E402
from controller.sse.stream_adapter import sse_response  # noqa: E402
from domain.entities.vision import VisionStatus  # noqa: E402
from exceptions.exception import AppException  # noqa: E402
from exceptions.handlers import register_exception_handlers  # noqa: E402
from schemas.chat import StreamRequest  # noqa: E402
from schemas.config_schemas import DevicesConfig, VisionConfig  # noqa: E402
from service.approval.approval_broker import ApprovalBroker  # noqa: E402
from service.devices.device_service import DeviceService  # noqa: E402
from service.sensing.event_bus import EventBus  # noqa: E402
from service.vision.vision_service import VisionService  # noqa: E402
from tpa.filestore.json_device_registry import JsonDeviceRegistry  # noqa: E402

DESCRIPTION = 'A red apple and a blue mug sit on a brown table. A white label in front reads "Best before 12/2027."'
DETAILED = (
    "A shiny red apple with a small green leaf sits on the left. Next to it is a blue mug with a round handle. "
    "Both rest on a wooden table in warm light. In front of them is a white paper label. "
    'It reads "Best before 12/2027" in dark letters. The background is plain and out of focus.'
)


class ScriptedModel:
    """Stands in for the vision model. The first photo waits `cold_seconds` (the real model loads on demand)."""

    def __init__(self, cold_seconds: float, chunk_delay: float, fail_after: int | None, memory_error: bool):
        self.cold_seconds, self.chunk_delay = cold_seconds, chunk_delay
        self.fail_after, self.memory_error = fail_after, memory_error
        self.loaded = False

    def _answer(self, prompt: str) -> str:
        if "Question:" in prompt:
            q = prompt.split("Question:", 1)[1].strip().lower()
            if "label" in q or "say" in q or "text" in q or "date" in q:
                return 'The label says "Best before 12/2027."'
            if "ripe" in q:
                return "It looks ripe to me."
            if "colour" in q or "color" in q:
                return "The apple is red and the mug is blue."
            return "I can't tell from this photo."
        if "Read out all the text" in prompt:
            return "Best before 12/2027."
        if "at most six short sentences" in prompt:
            return DETAILED
        return DESCRIPTION

    async def describe(self, image: bytes, mime: str, prompt: str, *, cancel: asyncio.Event):
        if self.memory_error:
            raise AppException("mock", "VISION_UNAVAILABLE", message="not enough free memory to load the vision model right now")
        if not self.loaded:
            waited = 0.0
            while waited < self.cold_seconds and not cancel.is_set():
                await asyncio.sleep(0.05)
                waited += 0.05
            self.loaded = True
        words = self._answer(prompt).split(" ")
        for i, word in enumerate(words):
            if cancel.is_set():
                return
            await asyncio.sleep(self.chunk_delay)
            yield word + (" " if i < len(words) - 1 else "")
            if self.fail_after is not None and i + 1 == self.fail_after:
                raise RuntimeError("scripted failure")

    async def status(self) -> VisionStatus:
        return VisionStatus(enabled=True, loaded=self.loaded, busy=False, idle_seconds=None, model="mock-qwen3-vl-2b")

    async def start(self) -> None:
        pass

    async def stop(self) -> None:
        pass


class SimulateLan:
    """Make every request look like it comes from a phone on the Wi-Fi, even when the phone is the same machine.

    The real gate trusts loopback and demands a token from everyone else; without this, a test on one computer could
    never exercise the token and permission rules. `/mock/*` keeps its real peer so the admin helpers stay loopback-only.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and not scope["path"].startswith("/mock/"):
            scope = {**scope, "client": ("192.168.1.50", 50000)}
        await self.app(scope, receive, send)


def create_app(
    *,
    state_dir: Path | None = None,
    cold_seconds: float = 2.0,
    chunk_delay: float = 0.08,
    fail_after: int | None = None,
    memory_error: bool = False,
    vision_enabled: bool = True,
    simulate_lan: bool = False,
    code_ttl_s: int = 600,
) -> FastAPI:
    state_dir = Path(state_dir or tempfile.mkdtemp(prefix="mock-pi-"))
    app = FastAPI(title="Mock Pi")
    register_exception_handlers(app)

    devices_cfg = DevicesConfig(pairing_code_ttl_s=code_ttl_s, pairing_max_attempts=5, pairing_global_per_hour=1000)
    service = DeviceService(JsonDeviceRegistry(state_dir / "devices.json"), devices_cfg)
    model = ScriptedModel(cold_seconds, chunk_delay, fail_after, memory_error)
    broker = ApprovalBroker(bus=EventBus())

    app.state.device_service = service
    app.state.approval_broker = broker
    app.state.full_config = type("Cfg", (), {"devices": devices_cfg})()
    app.state.vision = VisionService(model, VisionConfig(enabled=True)) if vision_enabled else None
    app.state.model = model
    app.state.pending_tasks = []

    @app.get("/api/health")
    async def health():
        return {"status": "ok", "mock": True}

    @app.post("/api/stream")
    async def stream(req: StreamRequest):
        text = req.message.strip()
        lower = text.lower()
        if "email" in lower and "send" in lower:
            task = asyncio.create_task(broker.request_approval("send_email", {"to": "Priya", "body": "Running late"}, "mock"))
            app.state.pending_tasks.append(task)
            chunks = ["I can send that. ", "I need your OK first, it's waiting."]
        elif "multi" in lower:
            chunks = ["Here are two lines:\nLine one\nLine two"]
        else:
            chunks = [f"You said: {text}"]

        async def gen():
            for chunk in chunks:
                yield sse_encode(chunk)
                await asyncio.sleep(0.02)
            yield sse_encode("[DONE]")

        return sse_response(gen())

    app.include_router(devices_route.router, prefix="/api")
    app.include_router(vision_route.router, prefix="/api")
    app.include_router(approval_route.router, prefix="/api")
    app.include_router(make_control_router(MockControlState()), prefix="/api")

    def _local_only(request: Request) -> None:
        if not is_loopback(request.client.host if request.client else None):
            raise AppException("mock", "DEVICE_FORBIDDEN", message="mock admin routes are local-only")

    @app.get("/mock/state")
    async def mock_state(request: Request):
        _local_only(request)
        return {"loaded": model.loaded, "devices": len(service.list_devices()), "yolo": broker.is_yolo()}

    @app.post("/mock/code")
    async def mock_code(request: Request, approve: int = 0, scopes: str | None = None):
        """A fresh single-use pairing code. `scopes` is a comma list (default: chat, control, vision)."""
        _local_only(request)
        wanted = [s for s in (scopes or "").split(",") if s] or None
        return {"code": service.create_code(wanted, bool(approve)).code}

    @app.post("/mock/revoke-all")
    async def mock_revoke_all(request: Request):
        _local_only(request)
        ids = [d.id for d in service.list_devices()]
        for device_id in ids:
            service.revoke(device_id)
        return {"revoked": len(ids)}

    @app.post("/mock/expire-images")
    async def mock_expire_images(request: Request):
        """Make the Pi forget every uploaded photo, as if the 5-minute cache had run out (to test the app's silent re-upload)."""
        _local_only(request)
        vision = app.state.vision
        count = len(vision._images) if vision is not None else 0
        if vision is not None:
            vision._images.clear()
        return {"expired": count}

    @app.post("/mock/yolo")
    async def mock_yolo(request: Request, on: int = 1):
        _local_only(request)
        broker.set_yolo(bool(on))
        return {"yolo": broker.is_yolo()}

    app.add_middleware(DeviceAuthMiddleware)
    if simulate_lan:
        app.add_middleware(SimulateLan)   # outermost: runs before the gate
    return app


def check_host(value: str) -> str:
    """The address to listen on: an IP address or `localhost`. Anything else is almost always a typo, e.g. a full stop
    copied after the address ("0.0.0.0."), which would otherwise surface as a baffling name-lookup failure."""
    host = value.strip()
    if host == "localhost":
        return host
    try:
        ipaddress.ip_address(host)
    except ValueError:
        raise argparse.ArgumentTypeError(
            f"{value!r} is not an IP address. Use 0.0.0.0 to let a phone connect, or 127.0.0.1 for this computer only "
            "(check there is no full stop or space after it)."
        ) from None
    return host


def lan_address() -> str:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--host", type=check_host, default="127.0.0.1", help="use 0.0.0.0 to let a phone on the Wi-Fi connect")
    p.add_argument(
        "--port", type=int, default=8765,
        help="not 8000: your real Veda server uses that, and on Windows a more specific listener (127.0.0.1) wins over this one for local traffic",
    )
    p.add_argument("--cold-seconds", type=float, default=2.0, help="how long the first photo waits, like the real model loading")
    p.add_argument("--chunk-delay", type=float, default=0.08, help="seconds between words of an answer")
    p.add_argument("--fail-after", type=int, default=None, help="make the model fail after this many words (tests the error path)")
    p.add_argument("--memory-error", action="store_true", help="make every photo fail as if the Pi were out of memory")
    p.add_argument("--vision-off", action="store_true", help="vision switched off, as in the default config")
    p.add_argument("--simulate-lan", action="store_true", help="treat every request as a phone on the Wi-Fi (for tests on one machine)")
    p.add_argument("--code-ttl", type=int, default=600, help="seconds a pairing code stays valid")
    p.add_argument(
        "--state-dir", type=Path, default=Path(tempfile.gettempdir()) / "veda-mock-pi",
        help="where paired phones are remembered, so a restart keeps them paired (delete the folder to start fresh)",
    )
    a = p.parse_args()

    app = create_app(
        state_dir=a.state_dir, cold_seconds=a.cold_seconds, chunk_delay=a.chunk_delay, fail_after=a.fail_after, memory_error=a.memory_error,
        vision_enabled=not a.vision_off, simulate_lan=a.simulate_lan, code_ttl_s=a.code_ttl,
    )
    service: DeviceService = app.state.device_service
    full = service.create_code(allow_approve=True).code
    no_approve = service.create_code().code
    chat_only = service.create_code(["chat"]).code
    host = lan_address() if a.host == "0.0.0.0" else a.host
    print(f"MOCK_PI_READY port={a.port}", flush=True)
    print(f"PAIRING_CODE={full}", flush=True)
    print(f"PAIRING_CODE_NO_APPROVE={no_approve}", flush=True)
    print(f"PAIRING_CODE_CHAT_ONLY={chat_only}", flush=True)
    print(f"Open the app and pair with  {host}:{a.port}  code {full}", flush=True)
    print(f"  or scan/open  veda://pair?host={host}&port={a.port}&code={full}", flush=True)

    import uvicorn

    uvicorn.run(app, host=a.host, port=a.port, log_level="warning", access_log=False)


if __name__ == "__main__":
    main()
