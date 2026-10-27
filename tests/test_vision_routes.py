"""The vision HTTP routes: upload limits, the SSE event stream, 429 while busy, disconnect handling, phone permissions,
and that the real app registers exactly the routes the phone scope policy names.

TestClient runs a request to completion, so the cases that need true streaming (a second photo while one is running,
a client hanging up) use a real uvicorn server on a loopback port.

Run: pytest tests/test_vision_routes.py
"""

import asyncio
import io
import json
import threading
import time

import httpx
import pytest
import uvicorn
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from controller.middleware.device_auth import DeviceAuthMiddleware
from controller.routes import vision as vision_route
from domain.entities.vision import VisionStatus
from domain.policies.device_scope_policy import scope_for
from exceptions.exception import AppException
from exceptions.handlers import register_exception_handlers
from schemas.config_schemas import DevicesConfig, VisionConfig
from service.devices.device_service import DeviceService
from service.vision.vision_service import VisionService
from tpa.filestore.json_device_registry import JsonDeviceRegistry


def jpeg(size=(120, 90)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, (200, 30, 30)).save(buf, "JPEG")
    return buf.getvalue()


class FakePort:
    def __init__(self):
        self.chunks = ["A red ", "apple."]
        self.error = None
        self.loaded = True
        self.gate: threading.Event | None = None   # when set (cleared), the reply waits for it
        self.chunk_delay = 0.0
        self.yielded = 0
        self.cleanup_done = threading.Event()
        self.calls = []

    async def describe(self, image, mime, prompt, *, cancel):
        self.calls.append(prompt)
        self.cleanup_done.clear()
        try:
            if self.error is not None:
                raise self.error
            for chunk in self.chunks:
                while self.gate is not None and not self.gate.is_set():
                    if cancel.is_set():
                        return
                    await asyncio.sleep(0.01)
                if cancel.is_set():
                    return
                self.yielded += 1
                yield chunk
                await asyncio.sleep(self.chunk_delay)
        finally:
            self.cleanup_done.set()

    async def status(self):
        return VisionStatus(enabled=True, loaded=self.loaded, busy=False, idle_seconds=None, model="fake-vl")

    async def start(self):
        pass

    async def stop(self):
        pass


def make_app(port: FakePort | None, tmp_path=None, **cfg) -> FastAPI:
    app = FastAPI()
    register_exception_handlers(app)
    app.include_router(vision_route.router, prefix="/api")
    app.state.vision = VisionService(port, VisionConfig(**cfg)) if port is not None else None
    app.state.full_config = type("C", (), {"devices": DevicesConfig()})()
    if tmp_path is not None:
        app.add_middleware(DeviceAuthMiddleware)
        app.state.device_service = DeviceService(JsonDeviceRegistry(tmp_path / "devices.json"), DevicesConfig())
    return app


def events(body: str) -> list[dict]:
    return [json.loads(line[5:]) for line in body.splitlines() if line.startswith("data:")]


def upload(client, data=None) -> str:
    r = client.put("/api/vision/images", content=data or jpeg())
    assert r.status_code == 200, r.text
    return r.json()["image_id"]


@pytest.fixture
def port():
    return FakePort()


@pytest.fixture
def client(port):
    return TestClient(make_app(port))


# ---------- upload ----------

def test_upload_returns_an_id_and_the_stored_size(client):
    r = client.put("/api/vision/images", content=jpeg((120, 90)))
    assert r.status_code == 200
    body = r.json()
    assert body["image_id"] and (body["width"], body["height"]) == (120, 90)


def test_upload_that_is_not_an_image_is_422(client):
    r = client.put("/api/vision/images", content=b"definitely not a picture")
    assert r.status_code == 422 and r.json()["error"]["code"] == "IMAGE_INVALID"


def test_upload_over_the_limit_is_refused_by_content_length_alone(port):
    app = make_app(port, upload_max_bytes=1000)
    r = TestClient(app).put("/api/vision/images", content=b"x" * 5000)
    assert r.status_code == 422 and "KB" in r.json()["error"]["message"]


def test_upload_over_the_limit_without_a_content_length_is_still_refused(port):
    app = make_app(port, upload_max_bytes=1000)

    def chunks():
        for _ in range(10):
            yield b"x" * 500   # a generator body goes out chunked: no Content-Length

    r = TestClient(app).put("/api/vision/images", content=chunks())
    assert r.status_code == 422


def test_empty_upload_is_422(client):
    assert client.put("/api/vision/images", content=b"").status_code == 422


# ---------- ask ----------

def test_ask_streams_tokens_then_done(client):
    image_id = upload(client)
    r = client.post("/api/vision/ask", json={"image_id": image_id})
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/event-stream")
    assert events(r.text) == [{"type": "token", "text": "A red "}, {"type": "token", "text": "apple."}, {"type": "done"}]


def test_a_cold_model_announces_loading_first(port, client):
    port.loaded = False
    r = client.post("/api/vision/ask", json={"image_id": upload(client)})
    assert events(r.text)[0] == {"type": "status", "state": "loading"}


def test_a_quiet_model_gets_keepalive_events_so_the_app_does_not_give_up(port, client, monkeypatch):
    # The app drops a stream after 120 s without an event; a first photo on the Pi can be quiet for longer than that.
    from controller.routes import vision as vision_routes

    monkeypatch.setattr(vision_routes, "_KEEPALIVE_S", 0.05)
    port.chunk_delay = 0.3
    evs = events(client.post("/api/vision/ask", json={"image_id": upload(client)}).text)
    assert {"type": "status", "state": "working"} in evs
    assert [e["text"] for e in evs if e["type"] == "token"] == ["A red ", "apple."]   # the reply is untouched
    assert evs[-1] == {"type": "done"}


def test_a_follow_up_question_reaches_the_model(port, client):
    image_id = upload(client)
    client.post("/api/vision/ask", json={"image_id": image_id, "question": "Is it ripe?"})
    assert "Is it ripe?" in port.calls[0]


@pytest.mark.parametrize("payload,code", [
    ({"image_id": "nope"}, "IMAGE_INVALID"),
    ({"image_id": "x", "lang": "hi"}, "VALIDATION_ERROR"),
])
def test_bad_ask_requests_are_refused_before_streaming(client, payload, code):
    if payload["image_id"] == "x":
        payload = {**payload, "image_id": upload(client)}
    r = client.post("/api/vision/ask", json=payload)
    assert r.status_code == 422 and r.json()["error"]["code"] == code


def test_unknown_style_is_422(client):
    r = client.post("/api/vision/ask", json={"image_id": upload(client), "style": "poetic"})
    assert r.status_code == 422


def test_ask_body_is_validated(client):
    assert client.post("/api/vision/ask", json={}).status_code == 422
    assert client.post("/api/vision/ask", json={"image_id": "a", "question": "q" * 301}).status_code == 422


def test_a_backend_failure_becomes_an_error_event_and_frees_the_slot(port, client):
    image_id = upload(client)
    port.error = RuntimeError("segfault in /secret/path")
    r = client.post("/api/vision/ask", json={"image_id": image_id})
    assert r.status_code == 200   # the stream had already started
    last = events(r.text)[-1]
    assert last["type"] == "error" and last["code"] == "VISION_UNAVAILABLE" and "secret" not in json.dumps(last)
    port.error = None
    again = client.post("/api/vision/ask", json={"image_id": image_id})
    assert events(again.text)[-1] == {"type": "done"}   # not stuck busy


def test_a_known_backend_error_keeps_its_message(port, client):
    port.error = AppException("adapter", "VISION_UNAVAILABLE", message="not enough free memory to load the vision model right now")
    r = client.post("/api/vision/ask", json={"image_id": upload(client)})
    assert "not enough free memory" in events(r.text)[-1]["message"]


# ---------- status and the disabled case ----------

def test_status(client):
    r = client.get("/api/vision/status")
    assert r.status_code == 200 and r.json() == {"enabled": True, "loaded": True, "busy": False, "idle_seconds": None, "model": "fake-vl"}


def test_everything_is_503_when_vision_is_off():
    c = TestClient(make_app(None))
    assert c.get("/api/vision/status").status_code == 503
    assert c.put("/api/vision/images", content=jpeg()).status_code == 503
    assert c.post("/api/vision/ask", json={"image_id": "a"}).status_code == 503


# ---------- phone permissions ----------

def _phone(tmp_path, scopes):
    app = make_app(FakePort(), tmp_path)
    service = app.state.device_service
    code = service.create_code(scopes).code
    _, token = service.redeem(code, "Pixel", "192.168.1.20")
    client = TestClient(app, client=("192.168.1.20", 50000), base_url="http://pi.local:8000")
    return client, {"Authorization": f"Bearer {token}"}


def test_a_phone_with_the_vision_scope_can_use_all_three_routes(tmp_path):
    client, auth = _phone(tmp_path, ["vision"])
    assert client.get("/api/vision/status", headers=auth).status_code == 200
    r = client.put("/api/vision/images", content=jpeg(), headers=auth)
    assert r.status_code == 200
    ask = client.post("/api/vision/ask", json={"image_id": r.json()["image_id"]}, headers=auth)
    assert events(ask.text)[-1] == {"type": "done"}


def test_a_phone_without_the_vision_scope_is_refused(tmp_path):
    client, auth = _phone(tmp_path, ["chat", "control"])
    assert client.get("/api/vision/status", headers=auth).status_code == 403
    assert client.put("/api/vision/images", content=jpeg(), headers=auth).status_code == 403
    assert client.post("/api/vision/ask", json={"image_id": "a"}, headers=auth).status_code == 403


def test_an_unauthenticated_lan_request_is_401(tmp_path):
    client, _ = _phone(tmp_path, ["vision"])
    assert client.put("/api/vision/images", content=jpeg()).status_code == 401


def test_the_real_app_registers_the_routes_the_phone_policy_names():
    import sys
    from pathlib import Path

    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
    from bootstrap.app import app as real_app

    paths = real_app.openapi()["paths"]
    found = {(m.upper(), p) for p, methods in paths.items() if "/vision/" in p for m in methods}
    assert found == {("PUT", "/api/vision/images"), ("POST", "/api/vision/ask"), ("GET", "/api/vision/status")}
    for method, path in found:
        assert scope_for(method, path) == "vision", (method, path)


# ---------- real streaming (a live local server) ----------

class LiveServer:
    def __init__(self, app):
        self.server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=0, log_level="error", access_log=False))
        self.thread = threading.Thread(target=self.server.run, daemon=True)
        self.thread.start()
        deadline = time.time() + 10
        while not self.server.started and time.time() < deadline:
            time.sleep(0.02)
        assert self.server.started
        self.url = "http://127.0.0.1:%d" % self.server.servers[0].sockets[0].getsockname()[1]

    def close(self):
        self.server.should_exit = True
        self.thread.join(timeout=10)


@pytest.fixture
def live(port):
    server = LiveServer(make_app(port))
    yield server
    server.close()


def _stream_events(client, url, image_id):
    with client.stream("POST", f"{url}/api/vision/ask", json={"image_id": image_id}) as r:
        for line in r.iter_lines():
            if line.startswith("data:"):
                yield json.loads(line[5:])


def test_a_second_photo_while_one_runs_gets_429_with_retry_after(live, port):
    port.gate = threading.Event()   # the first reply waits
    with httpx.Client(timeout=10) as http:
        image_id = http.put(f"{live.url}/api/vision/images", content=jpeg()).json()["image_id"]
        first = threading.Thread(target=lambda: list(_stream_events(http, live.url, image_id)), daemon=True)
        first.start()
        time.sleep(0.5)   # let it start and reserve the slot
        r = httpx.post(f"{live.url}/api/vision/ask", json={"image_id": image_id}, timeout=10)
        assert r.status_code == 429 and r.headers["retry-after"] == "5"
        assert r.json()["error"]["code"] == "VISION_BUSY"
        port.gate.set()
        first.join(timeout=10)
        again = list(_stream_events(http, live.url, image_id))
        assert again[-1] == {"type": "done"}   # free again


def test_hanging_up_cancels_the_model_and_frees_the_slot(live, port):
    port.chunks = [f"w{i} " for i in range(500)]
    port.chunk_delay = 0.02
    with httpx.Client(timeout=10) as http:
        image_id = http.put(f"{live.url}/api/vision/images", content=jpeg()).json()["image_id"]
        with http.stream("POST", f"{live.url}/api/vision/ask", json={"image_id": image_id}) as r:
            lines = r.iter_lines()
            first = next(line for line in lines if line.startswith("data:"))
            assert json.loads(first[5:])["type"] == "token"
        # the connection is closed here, mid-reply
        assert port.cleanup_done.wait(timeout=5), "the model was never told to stop"
        assert port.yielded < 100, "the model kept generating after the client left"
        port.chunks = ["Done."]
        deadline = time.time() + 5
        status = None
        while time.time() < deadline:   # the slot comes free once the server has noticed and cleaned up
            r = httpx.post(f"{live.url}/api/vision/ask", json={"image_id": image_id}, timeout=10)
            status = r.status_code
            if status == 200:
                break
            time.sleep(0.1)
        assert status == 200, "the slot stayed busy after the client left"


# ---------- the real model, through the real routes (slow; only where llama-server and the model are downloaded) ----------

import contextlib  # noqa: E402
import sys  # noqa: E402

from PIL import ImageDraw  # noqa: E402

from core.constants import PROJECT_ROOT  # noqa: E402

_BIN = PROJECT_ROOT / "data/tools/llama-b11716-win-cpu-x64/llama-server.exe"
_MODEL = PROJECT_ROOT / "data/models/vision/Qwen3VL-2B-Instruct-Q4_K_M.gguf"
_MMPROJ = PROJECT_ROOT / "data/models/vision/mmproj-Qwen3VL-2B-Instruct-Q8_0.gguf"


@pytest.mark.skipif(not (_BIN.exists() and _MODEL.exists() and _MMPROJ.exists() and sys.platform == "win32"),
                    reason="llama-server and the model are not downloaded here")
def test_a_photo_goes_through_the_routes_to_the_real_model_and_back(tmp_path):
    from tpa.vision.llama_server_adapter import LlamaServerVisionAdapter
    from tpa.vision.vision_process_manager import VisionProcessManager

    cfg = VisionConfig(binary_path=str(_BIN), model_path=str(_MODEL), mmproj_path=str(_MMPROJ), port=8094, n_threads=4,
                       min_headroom_mb=1500, max_new_tokens=100, request_timeout_s=120)
    service = VisionService(LlamaServerVisionAdapter(VisionProcessManager(cfg, root=tmp_path), cfg), cfg)

    @contextlib.asynccontextmanager
    async def lifespan(app):   # what bootstrap/lifespan.py does: start at boot, stop (kills the model) at shutdown
        await service.start()
        yield
        await service.stop()

    app = FastAPI(lifespan=lifespan)
    register_exception_handlers(app)
    app.include_router(vision_route.router, prefix="/api")
    app.state.vision = service

    img = Image.new("RGB", (768, 576), (222, 200, 160))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 400, 768, 576], fill=(150, 105, 60))
    d.ellipse([120, 220, 330, 430], fill=(200, 30, 30))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=85)

    server = LiveServer(app)
    try:
        with httpx.Client(timeout=120) as http:
            assert http.get(f"{server.url}/api/vision/status").json()["loaded"] is False   # nothing loaded before the first photo
            image_id = http.put(f"{server.url}/api/vision/images", content=buf.getvalue()).json()["image_id"]
            got = list(_stream_events(http, server.url, image_id))
            assert got[0] == {"type": "status", "state": "loading"} and got[-1] == {"type": "done"}
            text = "".join(e["text"] for e in got if e["type"] == "token").lower()
            assert "apple" in text or "red" in text, text
            assert http.get(f"{server.url}/api/vision/status").json()["loaded"] is True
            again = list(_stream_events(http, server.url, image_id))   # warm: no loading announcement
            assert again[0]["type"] == "token"
    finally:
        server.close()   # runs the app's shutdown, which stops llama-server

    import psutil
    assert not [p for p in psutil.process_iter(["name", "cmdline"])
                if "llama-server" in (p.info["name"] or "").lower() and "8094" in " ".join(p.info["cmdline"] or [])]
