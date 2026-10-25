"""Phone pairing and the LAN gate (docs/15-vision-mobile-design.md section 9).

Covers the pure scope policy, DeviceService (codes, lockout, revoke), the JSON registry, and DeviceAuthMiddleware
driven through a small FastAPI app that mimics the real routes. Starlette's TestClient reports its peer as
"testclient" (not an IP, so not loopback); tests that need a loopback or LAN peer pass `client=(ip, port)`.

Run: pytest tests/test_device_auth.py
"""

from datetime import datetime

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from controller.middleware.device_auth import DeviceAuthMiddleware, is_loopback
from controller.routes import devices as devices_route
from core.enums import ExceptionCode
from domain.policies.device_scope_policy import ANY_TOKEN, PUBLIC, scope_for
from exceptions.exception import AppException
from exceptions.handlers import register_exception_handlers
from schemas.config_schemas import DevicesConfig
from service.devices.device_service import DeviceService, hash_token
from tpa.filestore.json_device_registry import JsonDeviceRegistry


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
def service(tmp_path, clock):
    return DeviceService(JsonDeviceRegistry(tmp_path / "devices.json"), DevicesConfig(), clock=clock)


def _pair(service, scopes=None, allow_approve=False, source="192.168.1.20"):
    code = service.create_code(scopes, allow_approve).code
    device, token = service.redeem(code, "Pixel", source)
    return device, token


# ---------- scope policy ----------

@pytest.mark.parametrize("method,path,scope", [
    ("POST", "/api/stream", "chat"),
    ("POST", "/api/approval/abc123/approve", "approve"),
    ("POST", "/api/approval/abc123/deny", "approve"),
    ("GET", "/api/approval/pending", "chat"),
    ("GET", "/api/approval/yolo", "control"),
    ("POST", "/api/privacy/mute", "control"),
    ("PUT", "/api/vision/images", "vision"),
    ("POST", "/api/pair", PUBLIC),
    ("GET", "/api/health", ANY_TOKEN),
    ("GET", "/api/tasks/", "chat"),   # trailing slash tolerated
])
def test_scope_for_listed_routes(method, path, scope):
    assert scope_for(method, path) == scope


@pytest.mark.parametrize("method,path", [
    ("POST", "/api/admin/shutdown"),
    ("POST", "/api/approval/yolo/on"),
    ("POST", "/api/approval/yolo/off"),
    ("POST", "/api/privacy/mute/toggle"),
    ("GET", "/api/knowledge"),
    ("DELETE", "/api/knowledge/0"),
    ("POST", "/api/speakers/enroll/start"),
    ("POST", "/api/google/reload"),
    ("GET", "/api/lookup/health"),
    ("POST", "/api/devices/pairing-code"),
    ("GET", "/api/devices"),
    ("DELETE", "/api/devices/abc"),
    ("GET", "/docs"),
    ("GET", "/openapi.json"),
    ("GET", "/"),
    ("GET", "/api/approval/abc/approve"),   # wrong method
    ("POST", "/api/approval/yolo/approve/extra"),   # extra segment is not a template match
    ("POST", "/api/approval"),
])
def test_scope_for_unlisted_routes_is_denied(method, path):
    assert scope_for(method, path) is None


# ---------- loopback detection ----------

@pytest.mark.parametrize("peer,expected", [
    ("127.0.0.1", True), ("127.5.5.5", True), ("::1", True), ("::ffff:127.0.0.1", True),
    ("192.168.1.9", False), ("10.0.0.2", False), ("testclient", False), ("", False), (None, False),
])
def test_is_loopback(peer, expected):
    assert is_loopback(peer) is expected


# ---------- DeviceService ----------

def test_code_redeems_once(service):
    device, token = _pair(service)
    assert service.authenticate(token).id == device.id
    code = service.create_code().code
    service.redeem(code, "a", "1.1.1.1")
    with pytest.raises(AppException) as e:
        service.redeem(code, "b", "1.1.1.1")   # single use
    assert e.value.code == ExceptionCode.PERMISSION_DENIED


def test_code_expires(service, clock):
    code = service.create_code().code
    clock.t += DevicesConfig().pairing_code_ttl_s + 1
    with pytest.raises(AppException):
        service.redeem(code, "late", "1.1.1.1")


def test_code_is_case_and_dash_insensitive(service):
    code = service.create_code().code
    service.redeem(f"{code[:4].lower()}-{code[4:].lower()}", "typed", "1.1.1.1")


def test_default_scopes_never_include_approve(service):
    device, _ = _pair(service)
    assert device.scopes == frozenset({"vision", "chat", "control"})


def test_approve_only_with_explicit_flag(service):
    plain, _ = _pair(service, scopes=["chat", "approve"])   # asking for it via scopes is not enough
    assert "approve" not in plain.scopes
    allowed, _ = _pair(service, allow_approve=True)
    assert "approve" in allowed.scopes


def test_unknown_scope_rejected(service):
    with pytest.raises(AppException) as e:
        service.create_code(["chat", "root"])
    assert e.value.code == ExceptionCode.VALIDATION_ERROR


def test_wrong_codes_lock_the_source_not_everyone(service, clock):
    good = service.create_code().code
    for _ in range(DevicesConfig().pairing_max_attempts):
        with pytest.raises(AppException):
            service.redeem("WRONGCDE", "x", "9.9.9.9")
    with pytest.raises(AppException) as e:
        service.redeem(good, "x", "9.9.9.9")   # locked, even with the right code
    assert e.value.code == ExceptionCode.RATE_LIMITED
    service.redeem(good, "x", "192.168.1.20")   # another host is unaffected
    clock.t += DevicesConfig().pairing_lock_s + 1


def test_lock_lifts_after_the_window(service, clock):
    for _ in range(DevicesConfig().pairing_max_attempts):
        with pytest.raises(AppException):
            service.redeem("WRONGCDE", "x", "9.9.9.9")
    clock.t += DevicesConfig().pairing_lock_s + 1
    service.redeem(service.create_code().code, "x", "9.9.9.9")


def test_global_hourly_cap(tmp_path, clock):
    cfg = DevicesConfig(pairing_global_per_hour=3, pairing_max_attempts=100)
    svc = DeviceService(JsonDeviceRegistry(tmp_path / "d.json"), cfg, clock=clock)
    for i in range(3):
        with pytest.raises(AppException):
            svc.redeem("WRONGCDE", "x", f"10.0.0.{i}")
    with pytest.raises(AppException) as e:
        svc.redeem(svc.create_code().code, "x", "10.0.0.99")
    assert e.value.code == ExceptionCode.RATE_LIMITED


def test_revoke_is_immediate(service):
    device, token = _pair(service)
    assert service.revoke(device.id) is True
    assert service.authenticate(token) is None
    assert service.revoke(device.id) is False


def test_registry_stores_only_a_hash(service, tmp_path):
    _, token = _pair(service)
    assert token not in (tmp_path / "devices.json").read_text(encoding="utf-8")
    assert hash_token(token) in (tmp_path / "devices.json").read_text(encoding="utf-8")


def test_registry_survives_restart_and_fails_closed_on_corruption(tmp_path):
    path = tmp_path / "devices.json"
    reg = JsonDeviceRegistry(path)
    svc = DeviceService(reg, DevicesConfig())
    device, token = _pair(svc)
    again = DeviceService(JsonDeviceRegistry(path), DevicesConfig())
    assert again.authenticate(token).id == device.id
    path.write_text("{ not json", encoding="utf-8")
    assert DeviceService(JsonDeviceRegistry(path), DevicesConfig()).authenticate(token) is None


# ---------- middleware, through a mini app that mirrors the real routes ----------

class _Broker:
    def __init__(self):
        self.yolo = False
        self.resolved = []

    def is_yolo(self):
        return self.yolo


def _make_app(service, broker=None, advertise_host=None):
    app = FastAPI()
    register_exception_handlers(app)
    app.add_middleware(DeviceAuthMiddleware)
    app.state.device_service = service
    app.state.approval_broker = broker or _Broker()
    app.state.full_config = type("C", (), {"devices": DevicesConfig(advertise_host=advertise_host)})()

    @app.post("/api/stream")
    async def _stream(request: Request):
        return {"device_id": getattr(request.state, "device_id", None)}

    @app.post("/api/approval/{rid}/approve")
    async def _approve(rid: str):
        return {"ok": True}

    @app.post("/api/approval/yolo/on")
    async def _yolo_on():
        return {"yolo": True}

    @app.post("/api/admin/shutdown")
    async def _shutdown():
        return {"bye": True}

    @app.get("/api/health")
    async def _health():
        return {"ok": True}

    app.include_router(devices_route.router, prefix="/api")
    return app


def _client(app, ip="192.168.1.20", host="pi.local:8000", **kw):
    return TestClient(app, client=(ip, 50000), base_url=f"http://{host}", **kw)


def _auth(token):
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def app(service):
    return _make_app(service)


def test_lan_request_without_token_is_401(app):
    r = _client(app).post("/api/stream")
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "DEVICE_UNAUTHORIZED"   # a real JSON body, not a 500


def test_bad_token_is_401(app):
    assert _client(app).post("/api/stream", headers=_auth("nope")).status_code == 401


def test_good_token_reaches_the_route_and_sets_device_id(app, service):
    device, token = _pair(service)
    r = _client(app).post("/api/stream", headers=_auth(token))
    assert r.status_code == 200
    assert r.json() == {"device_id": device.id}


def test_missing_scope_is_403(app, service):
    _, token = _pair(service)   # no approve scope
    r = _client(app).post("/api/approval/abc/approve", headers=_auth(token))
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "DEVICE_FORBIDDEN"


def test_approve_scope_allows_approval(app, service):
    _, token = _pair(service, allow_approve=True)
    assert _client(app).post("/api/approval/abc/approve", headers=_auth(token)).status_code == 200


@pytest.mark.parametrize("path", ["/api/approval/yolo/on", "/api/admin/shutdown", "/api/devices", "/docs"])
def test_unlisted_routes_are_403_for_a_valid_device_and_401_without(app, service, path):
    _, token = _pair(service, allow_approve=True)
    method = "GET" if path in ("/api/devices", "/docs") else "POST"
    assert _client(app).request(method, path, headers=_auth(token)).status_code == 403
    assert _client(app).request(method, path).status_code == 401   # an anonymous caller learns nothing


def test_revoked_token_stops_working_at_once(app, service):
    device, token = _pair(service)
    assert _client(app).post("/api/stream", headers=_auth(token)).status_code == 200
    service.revoke(device.id)
    assert _client(app).post("/api/stream", headers=_auth(token)).status_code == 401


def test_health_needs_a_token_but_any_scope(app, service):
    _, token = _pair(service, scopes=["vision"])
    assert _client(app).get("/api/health").status_code == 401
    assert _client(app).get("/api/health", headers=_auth(token)).status_code == 200


def test_chat_is_paused_while_yolo_is_on(service):
    broker = _Broker()
    app = _make_app(service, broker)
    _, token = _pair(service)
    broker.yolo = True
    r = _client(app).post("/api/stream", headers=_auth(token))
    assert r.status_code == 403
    assert "yolo" in r.json()["error"]["message"]


def test_loopback_needs_no_token(app):
    c = _client(app, ip="127.0.0.1", host="127.0.0.1:8000")
    assert c.post("/api/admin/shutdown").status_code == 200
    assert c.post("/api/approval/yolo/on").status_code == 200


def test_loopback_ipv6_and_mapped_need_no_token(app):
    assert _client(app, ip="::1", host="[::1]:8000").post("/api/admin/shutdown").status_code == 200
    assert _client(app, ip="::ffff:127.0.0.1", host="127.0.0.1:8000").post("/api/admin/shutdown").status_code == 200


def test_cross_origin_browser_request_is_refused_even_on_loopback(app):
    c = _client(app, ip="127.0.0.1", host="127.0.0.1:8000")
    r = c.post("/api/approval/yolo/on", headers={"Origin": "https://evil.example"})
    assert r.status_code == 403


def test_same_origin_is_fine(app):
    c = _client(app, ip="127.0.0.1", host="127.0.0.1:8000")
    assert c.post("/api/admin/shutdown", headers={"Origin": "http://127.0.0.1:8000"}).status_code == 200


def test_dns_rebinding_host_is_refused_on_loopback(app):
    c = _client(app, ip="127.0.0.1", host="attacker.example:8000")
    assert c.post("/api/admin/shutdown").status_code == 403


def test_advertise_host_is_allowed_on_loopback(service):
    app = _make_app(service, advertise_host="pi.local")
    assert _client(app, ip="127.0.0.1", host="pi.local:8000").post("/api/admin/shutdown").status_code == 200


def test_no_device_service_refuses_every_remote_request():
    app = _make_app(None)
    assert _client(app).get("/api/health").status_code == 403
    assert _client(app, ip="127.0.0.1", host="127.0.0.1:8000").get("/api/health").status_code == 200   # local still works


# ---------- pairing routes ----------

def test_full_pairing_flow_over_http(app):
    local = _client(app, ip="127.0.0.1", host="127.0.0.1:8000")
    info = local.post("/api/devices/pairing-code", json={}).json()
    assert info["scopes"] == ["chat", "control", "vision"]
    phone = _client(app)
    paired = phone.post("/api/pair", json={"code": info["code"], "device_name": "Pixel 8"})
    assert paired.status_code == 200
    token = paired.json()["token"]
    assert phone.post("/api/stream", headers=_auth(token)).status_code == 200

    listed = local.get("/api/devices").json()
    assert [d["name"] for d in listed] == ["Pixel 8"]
    assert "token" not in listed[0] and "token_hash" not in listed[0]

    assert local.delete(f"/api/devices/{listed[0]['id']}").status_code == 200
    assert phone.post("/api/stream", headers=_auth(token)).status_code == 401
    assert local.delete(f"/api/devices/{listed[0]['id']}").status_code == 404


def test_wrong_pairing_code_is_403_then_429(app):
    phone = _client(app)
    assert phone.post("/api/pair", json={"code": "WRONGCDE"}).status_code == 403
    for _ in range(DevicesConfig().pairing_max_attempts):
        phone.post("/api/pair", json={"code": "WRONGCDE"})
    assert phone.post("/api/pair", json={"code": "WRONGCDE"}).status_code == 429


def test_a_phone_cannot_mint_codes_or_list_devices(app, service):
    _, token = _pair(service, allow_approve=True)
    phone = _client(app)
    assert phone.post("/api/devices/pairing-code", json={"allow_approve": True}, headers=_auth(token)).status_code == 403
    assert phone.get("/api/devices", headers=_auth(token)).status_code == 403


def test_route_itself_refuses_non_loopback_even_if_middleware_were_bypassed(service):
    app = FastAPI()
    register_exception_handlers(app)   # no middleware on purpose
    app.state.device_service = service
    app.state.full_config = type("C", (), {"devices": DevicesConfig()})()
    app.include_router(devices_route.router, prefix="/api")
    r = TestClient(app, client=("192.168.1.20", 5000)).post("/api/devices/pairing-code", json={})
    assert r.status_code == 403


def test_device_last_seen_is_recorded(app, service):
    device, token = _pair(service)
    _client(app).post("/api/stream", headers=_auth(token))
    seen = service.list_devices()[0].last_seen
    assert isinstance(seen, datetime)
