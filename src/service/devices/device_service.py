"""DeviceService - pairing codes, device tokens and lockout. Knows nothing about memory, agents or vision.

Flow: `veda pair` asks the server for a one-time code (loopback only), the phone redeems it once for a bearer
token, and from then on every non-loopback request is checked against the registry by controller/middleware.
Only a sha256 of the token is stored. Wrong codes are rate-limited per source address, and there is a global cap
so one noisy host on the LAN cannot grind through the 40-bit code space or lock everyone else out for long.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
import time
import uuid
from collections import deque
from dataclasses import dataclass
from datetime import datetime
from typing import Callable, Iterable

from core.enums import ExceptionCode
from core.logging_config import logger
from domain.entities.device import ALL_SCOPES, SCOPE_APPROVE, Device
from domain.ports.device_registry_port import DeviceRegistryPort
from exceptions.exception import AppException
from schemas.config_schemas import DevicesConfig

_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"   # no 0/O/1/I: read aloud or typed without mistakes
_CODE_LENGTH = 8   # 32^8 = 40 bits
_MAX_ACTIVE_CODES = 5
_NAME_MAX = 40


@dataclass(frozen=True)
class PairingCode:
    code: str
    expires_at: float
    scopes: frozenset[str]


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _normalise(code: str) -> str:
    return "".join(ch for ch in code.upper() if ch.isalnum())


class DeviceService:
    def __init__(self, registry: DeviceRegistryPort, cfg: DevicesConfig, clock: Callable[[], float] = time.time):
        self._registry = registry
        self._cfg = cfg
        self._clock = clock
        self._codes: dict[str, PairingCode] = {}
        self._failures: dict[str, tuple[int, float]] = {}   # source -> (wrong codes so far, locked_until)
        self._attempts: deque[float] = deque()   # every redemption attempt, for the global hourly cap

    # --- pairing ---

    def create_code(self, scopes: Iterable[str] | None = None, allow_approve: bool = False) -> PairingCode:
        granted = set(scopes) if scopes is not None else set(self._cfg.default_scopes)
        granted.discard(SCOPE_APPROVE)   # approve is never implied: only the explicit flag grants it
        if allow_approve:
            granted.add(SCOPE_APPROVE)
        unknown = granted - ALL_SCOPES
        if unknown:
            raise AppException("DeviceService", ExceptionCode.VALIDATION_ERROR, message=f"unknown scope(s): {sorted(unknown)}")
        now = self._clock()
        self._codes = {c: p for c, p in self._codes.items() if p.expires_at > now}
        while len(self._codes) >= _MAX_ACTIVE_CODES:
            self._codes.pop(min(self._codes, key=lambda c: self._codes[c].expires_at))
        code = "".join(secrets.choice(_CODE_ALPHABET) for _ in range(_CODE_LENGTH))
        pairing = PairingCode(code=code, expires_at=now + self._cfg.pairing_code_ttl_s, scopes=frozenset(granted))
        self._codes[code] = pairing
        return pairing

    def redeem(self, code: str, device_name: str, source: str) -> tuple[Device, str]:
        """Exchange a one-time code for a device and its token (shown to the phone once)."""
        now = self._clock()
        self._check_not_locked(source, now)
        while self._attempts and self._attempts[0] <= now - 3600:
            self._attempts.popleft()
        if len(self._attempts) >= self._cfg.pairing_global_per_hour:
            raise AppException("DeviceService", ExceptionCode.RATE_LIMITED, message="too many pairing attempts; try again later")
        self._attempts.append(now)

        pairing = self._match(_normalise(code), now)
        if pairing is None:
            self._record_failure(source, now)
            raise AppException("DeviceService", ExceptionCode.PERMISSION_DENIED, message="pairing code is invalid or expired")

        self._failures.pop(source, None)
        del self._codes[pairing.code]   # single use
        token = secrets.token_urlsafe(32)
        device = Device(
            id=uuid.uuid4().hex[:8], name=(device_name or "").strip()[:_NAME_MAX] or "phone",
            scopes=pairing.scopes, token_hash=hash_token(token), created_at=datetime.now(),
        )
        self._registry.add(device)
        logger.info(f"[devices] paired {device.id} ({device.name!r}) scopes={sorted(device.scopes)}")
        return device, token

    def _match(self, code: str, now: float) -> PairingCode | None:
        found = None
        for stored, pairing in self._codes.items():   # compare every code: no early exit to time
            if hmac.compare_digest(stored, code) and pairing.expires_at > now:
                found = pairing
        return found

    def _check_not_locked(self, source: str, now: float) -> None:
        _, locked_until = self._failures.get(source, (0, 0.0))
        if locked_until > now:
            raise AppException("DeviceService", ExceptionCode.RATE_LIMITED, message="too many wrong codes; try again later")

    def _record_failure(self, source: str, now: float) -> None:
        count, _ = self._failures.get(source, (0, 0.0))
        count += 1
        if count >= self._cfg.pairing_max_attempts:
            logger.warning(f"[devices] pairing locked for {source} after {count} wrong codes")
            self._failures[source] = (0, now + self._cfg.pairing_lock_s)
        else:
            self._failures[source] = (count, 0.0)

    # --- using and managing devices ---

    def authenticate(self, token: str) -> Device | None:
        device = self._registry.get_by_token_hash(hash_token(token))
        if device is not None:
            self._registry.touch(device.id)
        return device

    def list_devices(self) -> list[Device]:
        return self._registry.list()

    def revoke(self, device_id: str) -> bool:
        removed = self._registry.remove(device_id)
        if removed:
            logger.info(f"[devices] revoked {device_id}")
        return removed
