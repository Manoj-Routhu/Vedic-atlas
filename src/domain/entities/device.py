"""A paired phone: who it is, what it may call, and the hash of its token (never the token)."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

SCOPE_VISION = "vision"
SCOPE_CHAT = "chat"
SCOPE_CONTROL = "control"
SCOPE_APPROVE = "approve"
ALL_SCOPES = frozenset({SCOPE_VISION, SCOPE_CHAT, SCOPE_CONTROL, SCOPE_APPROVE})


@dataclass
class Device:
    id: str
    name: str
    scopes: frozenset[str]
    token_hash: str   # sha256 hex of the bearer token; the token itself is shown once, at pairing
    created_at: datetime
    last_seen: datetime | None = field(default=None)
