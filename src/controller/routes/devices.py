"""Phone pairing and device management.

  POST   /api/pair                  - the phone redeems a one-time code for its token (public, rate-limited)
  POST   /api/devices/pairing-code  - `veda pair` asks for a code        (loopback only)
  GET    /api/devices               - `veda devices list`                (loopback only)
  DELETE /api/devices/{id}          - `veda devices revoke <id>`         (loopback only)

The CLI runs in another process than the server, so it manages devices through these routes rather than by
editing data/devices.json: a revoked token must stop working on the next request, not after a restart.
The loopback-only routes are not in the phone scope table, and each also checks the peer itself.
"""

from __future__ import annotations

import os

from fastapi import APIRouter, Depends, Request

from controller.dependencies.providers import get_device_service
from controller.middleware.device_auth import is_loopback
from core.enums import ExceptionCode
from exceptions.exception import AppException
from schemas.devices import DeviceOut, PairingCodeRequest, PairingCodeResponse, PairRequest, PairResponse
from service.devices.device_service import DeviceService
from service.devices.network import lan_address

router = APIRouter()


def _require_loopback(request: Request) -> None:
    peer = request.client.host if request.client else None
    if not is_loopback(peer):
        raise AppException("devices", ExceptionCode.DEVICE_FORBIDDEN, message="this route is local-only")


@router.post("/pair", response_model=PairResponse)
async def pair(req: PairRequest, request: Request, service: DeviceService = Depends(get_device_service)):
    source = request.client.host if request.client else "unknown"
    device, token = service.redeem(req.code, req.device_name, source)
    return PairResponse(device_id=device.id, token=token, scopes=sorted(device.scopes))


@router.post("/devices/pairing-code", response_model=PairingCodeResponse)
async def pairing_code(req: PairingCodeRequest, request: Request, service: DeviceService = Depends(get_device_service)):
    _require_loopback(request)
    pairing = service.create_code(req.scopes, req.allow_approve)
    cfg = request.app.state.full_config.devices
    server = request.scope.get("server") or ("127.0.0.1", 8000)
    return PairingCodeResponse(
        code=pairing.code, expires_in_s=cfg.pairing_code_ttl_s, scopes=sorted(pairing.scopes),
        host=cfg.advertise_host or lan_address(), port=int(server[1]),
        bind_host=os.environ.get("VEDA_BIND_HOST", "127.0.0.1"),
    )


@router.get("/devices", response_model=list[DeviceOut])
async def list_devices(request: Request, service: DeviceService = Depends(get_device_service)):
    _require_loopback(request)
    return [
        DeviceOut(
            id=d.id, name=d.name, scopes=sorted(d.scopes), created_at=d.created_at.isoformat(timespec="seconds"),
            last_seen=d.last_seen.isoformat(timespec="seconds") if d.last_seen else None,
        )
        for d in service.list_devices()
    ]


@router.delete("/devices/{device_id}")
async def revoke_device(device_id: str, request: Request, service: DeviceService = Depends(get_device_service)):
    _require_loopback(request)
    if not service.revoke(device_id):
        raise AppException("devices", ExceptionCode.NOT_FOUND, message=f"no device {device_id!r}")
    return {"revoked": device_id}
