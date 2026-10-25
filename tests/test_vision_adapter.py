"""LlamaServerVisionAdapter against a small real HTTP server that behaves like llama-server (SSE replies, /slots,
a busy period that outlasts a disconnect), plus - where the model is downloaded - the real llama-server end to end.

Run: pytest tests/test_vision_adapter.py
"""

import asyncio
import io
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from PIL import Image, ImageDraw

from core.constants import PROJECT_ROOT
from core.enums import ExceptionCode
from domain.entities.vision import VisionStatus
from exceptions.exception import AppException
from schemas.config_schemas import VisionConfig
from service.vision.vision_service import VisionService
from tpa.vision.llama_server_adapter import LlamaServerVisionAdapter


def run(coro):
    return asyncio.run(coro)


# ---------- a stand-in llama-server ----------

class FakeLlama:
    def __init__(self):
        self.chunks = ["A red ", "apple ", "on a table."]
        self.chunk_delay = 0.0
        self.first_delay = 0.0
        self.status_code = 200
        self.error_after = None   # emit an {"error": ...} event after this many chunks
        self.busy_after_disconnect = 0.0   # seconds /slots keeps reporting busy once the client has gone
        self.slots_status = 200
        self.stall = False   # accept the request and never answer
        self.requests: list[dict] = []
        self.slots_calls = 0
        self.disconnected = threading.Event()
        self._busy_until = 0.0
        self.processing = False
        outer = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.0"

            def log_message(self, *a):
                pass

            def do_GET(self):
                if self.path == "/slots":
                    outer.slots_calls += 1
                    if outer.slots_status != 200:
                        self.send_response(outer.slots_status)
                        self.end_headers()
                        return
                    busy = outer.processing or time.monotonic() < outer._busy_until
                    body = json.dumps([{"id": 0, "is_processing": busy}]).encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(body)
                else:
                    self.send_response(404)
                    self.end_headers()

            def do_POST(self):
                length = int(self.headers["Content-Length"])
                outer.requests.append(json.loads(self.rfile.read(length)))
                if outer.status_code != 200:
                    self.send_response(outer.status_code)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(b'{"error": {"message": "bad image"}}')
                    return
                outer.processing = True
                try:
                    if outer.stall:
                        time.sleep(30)
                        return
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.end_headers()
                    time.sleep(outer.first_delay)
                    for i, text in enumerate(outer.chunks):
                        if outer.error_after is not None and i == outer.error_after:
                            self.wfile.write(b'data: {"error": {"message": "boom /secret/path"}}\n\n')
                            self.wfile.flush()
                            return
                        event = {"choices": [{"delta": {"content": text}}]}
                        self.wfile.write(f"data: {json.dumps(event)}\n\n".encode())
                        self.wfile.flush()
                        time.sleep(outer.chunk_delay)
                    self.wfile.write(b'data: {"choices": [{"delta": {}, "finish_reason": "stop"}]}\n\ndata: [DONE]\n\n')
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError, OSError):
                    outer.disconnected.set()
                    outer._busy_until = time.monotonic() + outer.busy_after_disconnect
                finally:
                    outer.processing = False

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class FakeManager:
    def __init__(self, base_url):
        self.base_url = base_url
        self.sessions_open = 0
        self.max_sessions_open = 0
        self.started = self.stopped = False
        self.resets = 0

    def session(self):
        outer = self

        class _S:
            async def __aenter__(self):
                outer.sessions_open += 1
                outer.max_sessions_open = max(outer.max_sessions_open, outer.sessions_open)
                return outer.base_url

            async def __aexit__(self, *exc):
                outer.sessions_open -= 1

        return _S()

    async def status(self):
        return VisionStatus(enabled=True, loaded=True, busy=False, idle_seconds=1.0, model="fake")

    async def reset(self):
        self.resets += 1

    async def start(self):
        self.started = True

    async def stop(self):
        self.stopped = True


@pytest.fixture
def llama():
    server = FakeLlama()
    yield server
    server.close()


def make(llama, **cfg):
    manager = FakeManager(f"http://127.0.0.1:{llama.port}")
    cfg.setdefault("request_timeout_s", 10)
    return LlamaServerVisionAdapter(manager, VisionConfig(**cfg)), manager


async def collect(adapter, cancel=None, prompt="describe") -> list[str]:
    out = []
    stream = adapter.describe(b"\xff\xd8fake-jpeg-bytes", "image/jpeg", prompt, cancel=cancel or asyncio.Event())
    try:
        async for chunk in stream:
            out.append(chunk)
    finally:
        await stream.aclose()
    return out


# ---------- the happy path ----------

def test_streams_the_reply_in_order(llama):
    adapter, _ = make(llama)
    assert run(collect(adapter)) == ["A red ", "apple ", "on a table."]


def test_request_has_the_image_first_then_the_prompt(llama):
    adapter, _ = make(llama, max_new_tokens=77)
    run(collect(adapter, prompt="What is this?"))
    body = llama.requests[0]
    assert body["stream"] is True and body["max_tokens"] == 77
    content = body["messages"][0]["content"]
    assert content[0]["type"] == "image_url" and content[0]["image_url"]["url"].startswith("data:image/jpeg;base64,")
    assert content[1] == {"type": "text", "text": "What is this?"}


def test_the_model_stays_held_open_for_the_whole_request(llama):
    adapter, manager = make(llama)
    llama.chunk_delay = 0.05

    async def go():
        stream = adapter.describe(b"x", "image/jpeg", "p", cancel=asyncio.Event())
        await stream.__anext__()
        assert manager.sessions_open == 1   # no idle unload mid-reply
        async for _ in stream:
            pass
        assert manager.sessions_open == 0

    run(go())


def test_empty_and_reasoning_deltas_are_skipped(llama):
    llama.chunks = ["", "Hello ", ""]
    adapter, _ = make(llama)
    assert run(collect(adapter)) == ["Hello "]


def test_a_normal_finish_does_not_poll_slots(llama):
    adapter, _ = make(llama)
    run(collect(adapter))
    assert llama.slots_calls == 0


def test_status_start_stop_are_the_managers(llama):
    adapter, manager = make(llama)

    async def go():
        await adapter.start()
        assert (await adapter.status()).model == "fake"
        await adapter.stop()

    run(go())
    assert manager.started and manager.stopped


# ---------- errors ----------

def test_a_rejected_image_is_an_image_error(llama):
    llama.status_code = 400
    adapter, _ = make(llama)
    with pytest.raises(AppException) as e:
        run(collect(adapter))
    assert e.value.code == ExceptionCode.IMAGE_INVALID


def test_a_server_error_is_a_vision_error(llama):
    llama.status_code = 500
    adapter, _ = make(llama)
    with pytest.raises(AppException) as e:
        run(collect(adapter))
    assert e.value.code == ExceptionCode.VISION_UNAVAILABLE


def test_an_error_mid_stream_is_a_vision_error_without_leaking_internals(llama):
    llama.error_after = 1
    adapter, _ = make(llama)
    with pytest.raises(AppException) as e:
        run(collect(adapter))
    assert e.value.code == ExceptionCode.VISION_UNAVAILABLE and "secret" not in e.value.message


def test_a_dead_server_is_a_vision_error(llama):
    adapter, _ = make(llama)
    llama.close()
    with pytest.raises(AppException) as e:
        run(collect(adapter))
    assert e.value.code == ExceptionCode.VISION_UNAVAILABLE


def test_a_stalled_server_times_out_and_is_restarted_not_waited_for(llama):
    llama.stall = True
    adapter, manager = make(llama, request_timeout_s=1)
    began = time.monotonic()
    with pytest.raises(AppException) as e:
        run(collect(adapter))
    assert e.value.code == ExceptionCode.VISION_UNAVAILABLE and "too long" in e.value.message
    assert time.monotonic() - began < 5   # did not sit out the stuck request
    assert manager.resets == 1 and llama.slots_calls == 0


def test_a_dead_server_does_not_trigger_a_restart_or_an_idle_wait(llama):
    adapter, manager = make(llama)
    llama.close()
    with pytest.raises(AppException):
        run(collect(adapter))
    assert manager.resets == 0 and llama.slots_calls == 0


def test_only_loopback_servers_are_ever_called():
    class Manager(FakeManager):
        pass

    adapter = LlamaServerVisionAdapter(Manager("http://192.168.1.5:8081"), VisionConfig())
    with pytest.raises(AppException) as e:
        run(collect(adapter))
    assert e.value.code == ExceptionCode.VISION_UNAVAILABLE and "this machine" in e.value.message


# ---------- cancelling ----------

def test_cancel_stops_the_stream_and_the_server_sees_the_disconnect(llama):
    llama.chunks = [f"word{i} " for i in range(200)]
    llama.chunk_delay = 0.02
    adapter, _ = make(llama)
    cancel = asyncio.Event()

    async def go():
        got = []
        stream = adapter.describe(b"x", "image/jpeg", "p", cancel=cancel)
        async for chunk in stream:
            got.append(chunk)
            if len(got) == 3:
                cancel.set()
        await stream.aclose()
        return got

    got = run(go())
    assert 3 <= len(got) < 20
    assert llama.disconnected.wait(timeout=3)   # llama-server was told to stop generating


def test_after_a_cancel_the_adapter_waits_until_the_model_is_idle(llama):
    """Image encoding cannot be interrupted: the old photo is still being processed after the client left."""
    llama.chunks = [f"w{i} " for i in range(500)]
    llama.chunk_delay = 0.02
    llama.busy_after_disconnect = 0.8
    adapter, _ = make(llama)
    cancel = asyncio.Event()

    async def go():
        stream = adapter.describe(b"x", "image/jpeg", "p", cancel=cancel)
        await stream.__anext__()
        cancel.set()
        began = time.monotonic()
        async for _ in stream:
            pass
        await stream.aclose()
        return time.monotonic() - began

    waited = run(go())
    assert waited >= 0.6, f"returned after {waited:.2f}s, while the model was still busy"
    assert llama.slots_calls >= 2


def test_cancel_before_the_first_token_also_waits_for_idle(llama):
    llama.first_delay = 1.0
    llama.busy_after_disconnect = 0.5
    adapter, _ = make(llama)
    cancel = asyncio.Event()

    async def go():
        loop = asyncio.get_running_loop()
        loop.call_later(0.2, cancel.set)
        began = time.monotonic()
        out = await collect(adapter, cancel)
        return out, time.monotonic() - began

    out, elapsed = run(go())
    assert out == []
    assert 0.4 < elapsed < 5   # left promptly, then waited out the busy period


def test_missing_slot_monitoring_does_not_hang(llama):
    llama.chunks = [f"w{i} " for i in range(500)]
    llama.chunk_delay = 0.02
    llama.slots_status = 404
    adapter, _ = make(llama)
    cancel = asyncio.Event()

    async def go():
        stream = adapter.describe(b"x", "image/jpeg", "p", cancel=cancel)
        await stream.__anext__()
        cancel.set()
        began = time.monotonic()
        async for _ in stream:
            pass
        await stream.aclose()
        return time.monotonic() - began

    assert run(go()) < 3


def test_through_the_service_a_cancelled_photo_blocks_the_next_one_until_idle(llama):
    llama.chunks = [f"w{i} " for i in range(500)]
    llama.chunk_delay = 0.02
    llama.busy_after_disconnect = 0.6
    adapter, _ = make(llama, upload_max_bytes=1_000_000)
    service = VisionService(adapter, VisionConfig())
    buf = io.BytesIO()
    Image.new("RGB", (64, 64), (10, 120, 10)).save(buf, "JPEG")

    async def go():
        image_id = (await service.store_image(buf.getvalue())).image_id
        cancel = asyncio.Event()
        stream = await service.ask(image_id, cancel=cancel)
        await stream.__anext__()
        cancel.set()
        async for _ in stream:
            pass
        await stream.aclose()
        # the slot is free only now, and the model really is idle:
        assert llama.processing is False
        llama.chunks = ["Done."]
        again = await service.ask(image_id)
        return [c async for c in again]

    assert run(go()) == ["Done."]


# ---------- the real model (slow; only where llama-server and the model are downloaded) ----------

_BIN = PROJECT_ROOT / "data/tools/llama-b11716-win-cpu-x64/llama-server.exe"
_MODEL = PROJECT_ROOT / "data/models/vision/Qwen3VL-2B-Instruct-Q4_K_M.gguf"
_MMPROJ = PROJECT_ROOT / "data/models/vision/mmproj-Qwen3VL-2B-Instruct-Q8_0.gguf"
_real = _BIN.exists() and _MODEL.exists() and _MMPROJ.exists() and sys.platform == "win32"


def _photo() -> bytes:
    img = Image.new("RGB", (768, 576), (222, 200, 160))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 400, 768, 576], fill=(150, 105, 60))
    d.ellipse([120, 220, 330, 430], fill=(200, 30, 30))
    d.rectangle([450, 250, 600, 420], fill=(40, 90, 190))
    d.rectangle([300, 470, 560, 540], fill=(250, 250, 245))
    d.text((318, 488), "BEST BEFORE 12/2027", fill=(20, 20, 20))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=85)
    return buf.getvalue()


@pytest.mark.skipif(not _real, reason="llama-server and the model are not downloaded here")
def test_real_model_describes_a_photo_and_survives_a_cancel(tmp_path):
    from tpa.vision.vision_process_manager import VisionProcessManager

    cfg = VisionConfig(binary_path=str(_BIN), model_path=str(_MODEL), mmproj_path=str(_MMPROJ), port=8093, n_threads=4,
                       min_headroom_mb=1500, max_new_tokens=120, request_timeout_s=120)

    async def go():
        manager = VisionProcessManager(cfg, root=tmp_path)
        service = VisionService(LlamaServerVisionAdapter(manager, cfg), cfg)
        await service.start()
        try:
            image_id = (await service.store_image(_photo())).image_id

            stream = await service.ask(image_id, style="brief")
            text = "".join([c async for c in stream]).strip()
            assert any(w in text.lower() for w in ("apple", "red")), text
            assert "*" not in text and "\n" not in text

            ocr = await service.ask(image_id, question="What does the label say?")
            label = "".join([c async for c in ocr])
            assert "12/2027" in label, label

            cancel = asyncio.Event()   # cancel a long answer part-way, then ask again at once
            long = await service.ask(image_id, style="detailed", cancel=cancel)
            await long.__anext__()
            cancel.set()
            async for _ in long:
                pass
            await long.aclose()
            began = time.monotonic()
            again = await service.ask(image_id, question="What colour is the round fruit?")
            answer = "".join([c async for c in again])
            assert "red" in answer.lower(), answer
            return time.monotonic() - began
        finally:
            await service.stop()

    elapsed = run(go())
    assert elapsed < 60
