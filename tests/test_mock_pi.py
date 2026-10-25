"""scripts/mock_pi.py is what the phone app is built against, so it must keep working as the real routes change.

It reuses the real vision, device and approval routes and the real DeviceAuthMiddleware; only the model and the chat
brain are scripted. These tests drive it the way the app does.

Run: pytest tests/test_mock_pi.py
"""

import importlib.util
import io
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("mock_pi", ROOT / "scripts" / "mock_pi.py")
mock_pi = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mock_pi)


def jpeg() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (64, 48), (200, 30, 30)).save(buf, "JPEG")
    return buf.getvalue()


def events(text: str) -> list[dict]:
    return [json.loads(line[5:]) for line in text.splitlines() if line.startswith("data:")]


@pytest.fixture
def pi(tmp_path):
    app = mock_pi.create_app(state_dir=tmp_path, cold_seconds=0.1, chunk_delay=0.0, simulate_lan=True)
    # `with` keeps ONE event loop alive for the whole test, like a real server: a pending approval is a background task
    # that Starlette's per-request loop would otherwise cancel as soon as the request returned.
    with TestClient(app, base_url="http://pi.local:8000") as client:
        yield app, client


def pair(app, client, **kwargs) -> dict:
    code = app.state.device_service.create_code(**kwargs).code
    r = client.post("/api/pair", json={"code": code, "device_name": "test phone"})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


def test_the_gate_is_real_without_a_token_nothing_works(pi):
    _, client = pi
    assert client.get("/api/health").status_code == 401
    assert client.post("/api/stream", json={"message": "hi"}).status_code == 401


def test_pairing_then_vision_end_to_end(pi):
    app, client = pi
    auth = pair(app, client)
    assert client.get("/api/health", headers=auth).status_code == 200

    up = client.put("/api/vision/images", content=jpeg(), headers=auth)
    assert up.status_code == 200
    image_id = up.json()["image_id"]

    r = client.post("/api/vision/ask", json={"image_id": image_id}, headers=auth)
    evs = events(r.text)
    assert evs[0] == {"type": "status", "state": "loading"}   # first photo: the model is "waking up"
    assert "".join(e["text"] for e in evs if e["type"] == "token").startswith("A red apple")
    assert evs[-1] == {"type": "done"}

    again = events(client.post("/api/vision/ask", json={"image_id": image_id, "question": "What does the label say?"}, headers=auth).text)
    assert again[0]["type"] == "token"   # warm now: no loading announcement
    assert "12/2027" in "".join(e["text"] for e in again if e["type"] == "token")


def test_a_phone_without_the_vision_permission_is_refused(pi):
    app, client = pi
    auth = pair(app, client, scopes=["chat"])
    assert client.put("/api/vision/images", content=jpeg(), headers=auth).status_code == 403


def test_chat_streams_and_an_email_request_creates_a_real_pending_approval(pi):
    app, client = pi
    auth = pair(app, client, allow_approve=True)
    r = client.post("/api/stream", json={"message": "hello"}, headers=auth)
    assert "You said: hello" in r.text and r.text.rstrip().endswith("data: [DONE]")

    client.post("/api/stream", json={"message": "please send an email"}, headers=auth)
    pending = client.get("/api/approval/pending", headers=auth).json()["pending"]
    assert len(pending) == 1 and pending[0]["action_name"] == "send_email"

    request_id = pending[0]["request_id"]
    assert client.post(f"/api/approval/{request_id}/approve", headers=auth).status_code == 200


def test_approving_needs_the_approve_permission(pi):
    app, client = pi
    owner = pair(app, client, allow_approve=True)
    viewer = pair(app, client)   # chat, vision, control: no approve
    client.post("/api/stream", json={"message": "send an email"}, headers=owner)
    request_id = client.get("/api/approval/pending", headers=viewer).json()["pending"][0]["request_id"]
    assert client.post(f"/api/approval/{request_id}/approve", headers=viewer).status_code == 403
    assert client.post(f"/api/approval/{request_id}/approve", headers=owner).status_code == 200


def test_yolo_pauses_phone_chat(pi):
    app, client = pi
    auth = pair(app, client)
    app.state.approval_broker.set_yolo(True)
    r = client.post("/api/stream", json={"message": "hi"}, headers=auth)
    assert r.status_code == 403 and "yolo" in r.json()["error"]["message"]


@pytest.mark.parametrize("good", ["0.0.0.0", "127.0.0.1", "192.168.1.5", "::1", "localhost", " 0.0.0.0 "])
def test_the_listen_address_is_accepted(good):
    assert mock_pi.check_host(good) == good.strip()


@pytest.mark.parametrize("bad", ["0.0.0.0.", "0.0.0.0,", "192.168.1", "example.com", "", "0.0.0.0 8000", "http://0.0.0.0"])
def test_a_mistyped_listen_address_is_refused_with_advice(bad):
    import argparse

    with pytest.raises(argparse.ArgumentTypeError) as e:
        mock_pi.check_host(bad)
    assert "not an IP address" in str(e.value) and "0.0.0.0" in str(e.value)


def test_paired_phones_survive_a_restart_of_the_mock(tmp_path):
    first = mock_pi.create_app(state_dir=tmp_path, simulate_lan=True)
    with TestClient(first, base_url="http://pi.local:8000") as client:
        auth = pair(first, client)
        assert client.get("/api/health", headers=auth).status_code == 200
    restarted = mock_pi.create_app(state_dir=tmp_path, simulate_lan=True)   # "Ctrl+C and run it again"
    with TestClient(restarted, base_url="http://pi.local:8000") as client:
        assert client.get("/api/health", headers=auth).status_code == 200


def test_a_model_failure_mid_answer_arrives_as_an_error_event(tmp_path):
    app = mock_pi.create_app(state_dir=tmp_path, cold_seconds=0, chunk_delay=0, fail_after=3, simulate_lan=True)
    client = TestClient(app, base_url="http://pi.local:8000")
    auth = pair(app, client)
    image_id = client.put("/api/vision/images", content=jpeg(), headers=auth).json()["image_id"]
    evs = events(client.post("/api/vision/ask", json={"image_id": image_id}, headers=auth).text)
    assert evs[-1]["type"] == "error" and evs[-1]["code"] == "VISION_UNAVAILABLE"


def test_vision_off_is_a_503(tmp_path):
    app = mock_pi.create_app(state_dir=tmp_path, vision_enabled=False, simulate_lan=True)
    client = TestClient(app, base_url="http://pi.local:8000")
    auth = pair(app, client)
    assert client.get("/api/vision/status", headers=auth).status_code == 503


def test_admin_helpers_are_local_only_and_work(tmp_path):
    app = mock_pi.create_app(state_dir=tmp_path, simulate_lan=True)
    local = TestClient(app, client=("127.0.0.1", 5000), base_url="http://127.0.0.1:8000")
    phone = TestClient(app, base_url="http://pi.local:8000")
    auth = pair(app, phone)
    assert phone.get("/api/health", headers=auth).status_code == 200
    assert local.post("/mock/revoke-all").json() == {"revoked": 1}
    assert phone.get("/api/health", headers=auth).status_code == 401   # revoked: takes effect at once


# ---------- Control endpoints (Stage 7) ----------

def test_control_routes_need_the_control_permission(pi):
    app, client = pi
    chat_only = pair(app, client, scopes=["chat"])
    assert client.get("/api/privacy/status", headers=chat_only).status_code == 403
    assert client.get("/api/reminders/status", headers=chat_only).status_code == 200   # chat may read reminders
    assert client.get("/api/tasks", headers=chat_only).status_code == 200              # and manage tasks
    control = pair(app, client, scopes=["control"])
    assert client.get("/api/privacy/status", headers=control).status_code == 200
    assert client.get("/api/tasks", headers=control).status_code == 403                # tasks are a chat permission


def test_a_phone_can_mute_the_microphone_but_has_no_way_to_unmute_it(pi):
    app, client = pi
    auth = pair(app, client)
    assert client.get("/api/privacy/status", headers=auth).json()["muted"] is False
    assert client.post("/api/privacy/mute", json={"muted": True}, headers=auth).json()["muted"] is True
    assert client.get("/api/voice/status", headers=auth).json()["running"] is False
    # the toggle (which could unmute) is not a phone route, and neither is the shutdown
    assert client.post("/api/privacy/mute/toggle", headers=auth).status_code == 403
    assert client.post("/api/admin/shutdown", headers=auth).status_code == 403


def test_tasks_can_be_listed_added_and_completed(pi):
    app, client = pi
    auth = pair(app, client)
    first = client.get("/api/tasks", headers=auth).json()["tasks"]
    assert [t["title"] for t in first] == ["Call mum", "Buy milk"]
    added = client.post("/api/tasks", json={"title": "Water plants"}, headers=auth).json()
    assert added["title"] == "Water plants" and added["done"] is False
    assert client.post(f"/api/tasks/{added['id']}/complete", headers=auth).status_code == 200
    assert "Water plants" not in [t["title"] for t in client.get("/api/tasks", headers=auth).json()["tasks"]]
    assert client.post(f"/api/tasks/{added['id']}/complete", headers=auth).status_code == 404


def test_reminder_lead_times_are_validated(pi):
    app, client = pi
    auth = pair(app, client)
    ok = client.put("/api/reminders/config", json={"lead_minutes": [30, 10]}, headers=auth)
    assert ok.status_code == 200 and ok.json()["lead_minutes"] == [30, 10]
    assert client.get("/api/reminders/status", headers=auth).json()["config"]["lead_minutes"] == [30, 10]
    assert client.put("/api/reminders/config", json={"lead_minutes": [999]}, headers=auth).status_code == 422


def test_persona_and_proactivity_can_be_changed(pi):
    app, client = pi
    auth = pair(app, client)
    catalog = client.get("/api/persona", headers=auth).json()["catalog"]
    other = next(p for p in catalog if p["id"] != "friend")
    assert client.post("/api/persona", json={"persona": other["id"]}, headers=auth).status_code == 200
    assert client.get("/api/persona", headers=auth).json()["state"]["persona"] == other["id"]
    assert client.post("/api/config/proactivity", json={"level": "chatty"}, headers=auth).json()["level"] == "chatty"
    assert client.post("/api/config/proactivity", json={"level": "shouting"}, headers=auth).status_code == 400


def test_recent_activity_and_auto_approve_state_are_readable(pi):
    app, client = pi
    auth = pair(app, client)
    traces = client.get("/api/trace?limit=2", headers=auth).json()["traces"]
    assert len(traces) == 2 and traces[0]["calls"][0]["tool"]
    assert client.get("/api/approval/yolo", headers=auth).json() == {"yolo": False}
    assert client.post("/api/approval/yolo/on", headers=auth).status_code == 403   # a phone can read it but never change it
