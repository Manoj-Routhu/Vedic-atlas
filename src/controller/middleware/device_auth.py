"""Device auth - the gate between the LAN and the API. Pure ASGI, fail-closed.

Rules (docs/15-vision-mobile-design.md section 9.1):
  1. Every request, loopback or not: a browser `Origin` that differs from `Host` is refused (a web page open on
     this machine must not be able to POST to /api/approval/yolo/on), and a loopback peer must use a loopback
     (or the configured) Host name (DNS rebinding).
  2. Loopback peers need no token, so the `veda` CLI and the tests are unchanged.
  3. Everyone else needs `Authorization: Bearer <device token>`, and the (method, route) must be in the device's
     scopes (domain/policies/device_scope_policy.py). Not listed = refused. With no device service (devices
     disabled) every non-loopback request is refused, so `--host 0.0.0.0` can no longer expose an open API.
  4. A phone cannot start a chat turn while yolo (auto-approve) is on: its destructive actions would never
     reach an approval prompt.

It answers with its own JSON responses: an AppException raised inside middleware bypasses the exception handlers
and would come out as a 500. Pure ASGI (not BaseHTTPMiddleware) so SSE streams pass through untouched.
"""

from __future__ import annotations

import ipaddress
from urllib.parse import urlparse

from fastapi.responses import JSONResponse

from core.enums import ExceptionCode
from core.logging_config import logger
from domain.policies.device_scope_policy import ANY_TOKEN, PUBLIC, scope_for
from schemas.schemas import AppError, AppResponse

_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})


def is_loopback(peer: str | None) -> bool:
    """True for 127.0.0.0/8, ::1 and ::ffff:127.x. Anything that is not an IP literal (e.g. a test client) is not loopback."""
    if not peer:
        return False
    try:
        ip = ipaddress.ip_address(peer)
    except ValueError:
        return False
    mapped = getattr(ip, "ipv4_mapped", None)
    return (mapped or ip).is_loopback


def _host_name(host_header: str) -> str:
    host = host_header.strip().lower()
    if host.startswith("["):   # [::1]:8000
        return host[1:].split("]", 1)[0]
    return host.rsplit(":", 1)[0] if host.count(":") == 1 else host


def _reject(status: int, code: ExceptionCode, message: str) -> JSONResponse:
    body = AppResponse(error=AppError(code=code.value, message=message)).model_dump(mode="json", exclude_none=True)
    return JSONResponse(status_code=status, content=body)


class DeviceAuthMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
        peer = (scope.get("client") or (None, None))[0]
        method, path = scope["method"], scope["path"]
        app_state = scope["app"].state if "app" in scope else None

        failure = self._browser_guard(headers, peer, app_state)
        if failure is None and not is_loopback(peer):
            failure = self._authenticate(scope, headers, method, path, app_state)
        if failure is not None:
            logger.warning(f"[device_auth] {failure.status_code} {method} {path} from {peer}")
            await failure(scope, receive, send)
            return
        await self.app(scope, receive, send)

    @staticmethod
    def _browser_guard(headers: dict, peer: str | None, app_state) -> JSONResponse | None:
        host_header = headers.get("host", "")
        origin = headers.get("origin")
        if origin is not None and urlparse(origin).netloc.lower() != host_header.strip().lower():
            return _reject(403, ExceptionCode.DEVICE_FORBIDDEN, "cross-origin requests are not allowed")
        if is_loopback(peer):
            allowed = set(_LOOPBACK_HOSTS)
            cfg = getattr(app_state, "full_config", None)
            advertised = getattr(getattr(cfg, "devices", None), "advertise_host", None)
            if advertised:
                allowed.add(advertised.lower())
            if _host_name(host_header) not in allowed:
                return _reject(403, ExceptionCode.DEVICE_FORBIDDEN, "unexpected Host header")
        return None

    @staticmethod
    def _authenticate(scope, headers: dict, method: str, path: str, app_state) -> JSONResponse | None:
        service = getattr(app_state, "device_service", None)
        if service is None:
            return _reject(403, ExceptionCode.DEVICE_FORBIDDEN, "remote access is disabled")

        needed = scope_for(method, path)
        if needed == PUBLIC:
            return None
        if needed is None:
            # Not listed for phones. Say "forbidden" only to a caller that proved who it is; an anonymous
            # caller learns nothing about which routes exist.
            token = _bearer(headers)
            if token is None or service.authenticate(token) is None:
                return _reject(401, ExceptionCode.DEVICE_UNAUTHORIZED, "a device token is required")
            return _reject(403, ExceptionCode.DEVICE_FORBIDDEN, "this device may not call that route")

        token = _bearer(headers)
        device = service.authenticate(token) if token else None
        if device is None:
            return _reject(401, ExceptionCode.DEVICE_UNAUTHORIZED, "a valid device token is required")
        if needed != ANY_TOKEN and needed not in device.scopes:
            return _reject(403, ExceptionCode.DEVICE_FORBIDDEN, f"this device lacks the '{needed}' permission")

        if method == "POST" and path.rstrip("/") == "/api/stream":
            broker = getattr(app_state, "approval_broker", None)
            if broker is not None and broker.is_yolo():
                return _reject(403, ExceptionCode.DEVICE_FORBIDDEN, "auto-approve (yolo) is on; chat from the phone is paused")

        scope.setdefault("state", {})["device_id"] = device.id
        return None


def _bearer(headers: dict) -> str | None:
    value = headers.get("authorization", "")
    scheme, _, token = value.partition(" ")
    return token.strip() or None if scheme.lower() == "bearer" else None
