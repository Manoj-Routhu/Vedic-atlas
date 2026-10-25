"""Which API calls a paired phone may make: exact (method, route template) -> scope. Default deny.

Pure policy, no I/O. Matching is exact on method and path shape, never by prefix: a prefix rule for
`/api/approval/` would also let a phone reach `/api/approval/yolo/on`.

Routes that are not listed here (shutdown, yolo on/off, unmute/toggle, saved memory, speaker enrolment,
Google sign-in, device management, /docs ...) are reachable from loopback only. See
docs/15-vision-mobile-design.md section 9.3 for the reasoning behind each row.
"""

from __future__ import annotations

import re

from domain.entities.device import SCOPE_APPROVE, SCOPE_CHAT, SCOPE_CONTROL, SCOPE_VISION

ANY_TOKEN = "*"   # any valid device token, whatever its scopes
PUBLIC = "public"   # no token at all (pairing itself)

_RULES: tuple[tuple[str, str, str], ...] = (
    ("POST", "/api/pair", PUBLIC),
    ("GET", "/api/health", ANY_TOKEN),
    # chat
    ("POST", "/api/stream", SCOPE_CHAT),
    ("GET", "/api/approval/pending", SCOPE_CHAT),
    ("GET", "/api/tasks", SCOPE_CHAT),
    ("POST", "/api/tasks", SCOPE_CHAT),
    ("POST", "/api/tasks/{id}/complete", SCOPE_CHAT),
    ("GET", "/api/reminders/status", SCOPE_CHAT),
    ("GET", "/api/reminders/recent", SCOPE_CHAT),
    ("GET", "/api/persona", SCOPE_CHAT),
    # approve (opt-in per device)
    ("POST", "/api/approval/{id}/approve", SCOPE_APPROVE),
    ("POST", "/api/approval/{id}/deny", SCOPE_APPROVE),
    # control
    ("GET", "/api/status", SCOPE_CONTROL),
    ("GET", "/api/governance/audit/stats", SCOPE_CONTROL),
    ("GET", "/api/approval/yolo", SCOPE_CONTROL),
    ("GET", "/api/config/proactivity", SCOPE_CONTROL),
    ("POST", "/api/config/proactivity", SCOPE_CONTROL),
    ("GET", "/api/voice/status", SCOPE_CONTROL),
    ("GET", "/api/privacy/status", SCOPE_CONTROL),
    ("POST", "/api/privacy/mute", SCOPE_CONTROL),   # mute only; unmute and toggle are loopback-only
    ("GET", "/api/trace", SCOPE_CONTROL),
    ("POST", "/api/persona", SCOPE_CONTROL),
    ("GET", "/api/reminders/config", SCOPE_CONTROL),
    ("PUT", "/api/reminders/config", SCOPE_CONTROL),
    # vision
    ("PUT", "/api/vision/images", SCOPE_VISION),
    ("POST", "/api/vision/ask", SCOPE_VISION),
    ("GET", "/api/vision/status", SCOPE_VISION),
)


def _compile(template: str) -> re.Pattern[str]:
    return re.compile("^" + re.sub(r"\{[a-z_]+\}", r"[^/]+", template) + "$")


_COMPILED = tuple((method, _compile(path), scope) for method, path, scope in _RULES)

# Streaming a chat turn from a phone: these request fields are ignored (they are prompt-injection and
# voice-pipeline switches that only a local caller should set).
DEVICE_STRIPPED_STREAM_FIELDS = ("system_context", "from_voice")


def scope_for(method: str, path: str) -> str | None:
    """The scope a phone needs for this call, ANY_TOKEN / PUBLIC, or None = not allowed for phones."""
    path = path.rstrip("/") or "/"
    method = method.upper()
    for rule_method, pattern, scope in _COMPILED:
        if rule_method == method and pattern.match(path):
            return scope
    return None
