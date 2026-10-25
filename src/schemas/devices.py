"""Request/response bodies for the device (phone pairing) routes."""

from __future__ import annotations

from pydantic import BaseModel, Field


class PairingCodeRequest(BaseModel):
    scopes: list[str] | None = None   # None = devices.default_scopes
    allow_approve: bool = False


class PairingCodeResponse(BaseModel):
    code: str
    expires_in_s: int
    scopes: list[str]
    host: str   # what the phone should connect to
    port: int
    bind_host: str   # what this server is actually listening on; loopback means no phone can reach it


class PairRequest(BaseModel):
    code: str = Field(min_length=1, max_length=32)
    device_name: str = Field(default="", max_length=80)


class PairResponse(BaseModel):
    device_id: str
    token: str   # shown once
    scopes: list[str]


class DeviceOut(BaseModel):
    id: str
    name: str
    scopes: list[str]
    created_at: str
    last_seen: str | None = None
