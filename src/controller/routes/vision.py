"""Vision HTTP API - a phone photo in, a description streamed back.

  PUT  /api/vision/images   raw JPEG/PNG/WebP body  -> {image_id, width, height}   (stored in memory for a few minutes)
  POST /api/vision/ask      {image_id, question?, style?, lang?} -> SSE stream of JSON events
  GET  /api/vision/status   {enabled, loaded, busy, idle_seconds, model}

Two requests rather than one multipart upload: no multipart spooling to disk, a plain streaming body for the app, and
follow-up questions about the same photo without uploading it again.

SSE events are JSON in `data:` lines: {"type": "status", "state": "loading"} (the model is being started, the first
reply takes a while), {"type": "token", "text": ...}, {"type": "done"}, {"type": "error", "code": ..., "message": ...}.
A second photo while one is running gets 429 with Retry-After before any stream starts.
"""

from __future__ import annotations

import asyncio
import contextlib
import json

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from controller.dependencies.providers import get_vision_service
from controller.sse.encoder import sse_encode
from controller.sse.stream_adapter import sse_response, watch_disconnect
from core.enums import ErrorMessage, ExceptionCode
from core.logging_config import logger
from exceptions.exception import AppException
from schemas.schemas import AppError, AppResponse
from schemas.vision import AskRequest, ImageResponse, VisionStatusResponse
from service.vision.vision_service import VisionService

router = APIRouter()

_RETRY_AFTER_S = "5"


def _event(**fields) -> str:
    return sse_encode(json.dumps(fields, ensure_ascii=False))


def _too_large(limit: int) -> AppException:
    return AppException("vision", ExceptionCode.IMAGE_INVALID, ErrorMessage.IMAGE_INVALID, detail=f"larger than {limit // 1024} KB")


@router.put("/vision/images", response_model=ImageResponse)
async def put_image(request: Request, service: VisionService = Depends(get_vision_service)):
    limit = service.max_upload_bytes
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > limit:
        raise _too_large(limit)   # refused before a byte of the body is read
    body = bytearray()
    async for chunk in request.stream():
        body += chunk
        if len(body) > limit:   # a body without (or with a lying) Content-Length
            raise _too_large(limit)
    info = await service.store_image(bytes(body))
    return ImageResponse(image_id=info.image_id, width=info.width, height=info.height)


@router.post("/vision/ask")
async def ask(req: AskRequest, request: Request, service: VisionService = Depends(get_vision_service)):
    cancel = asyncio.Event()
    try:
        stream = await service.ask(req.image_id, question=req.question, style=req.style, lang=req.lang, cancel=cancel)
    except AppException as e:
        if e.code == ExceptionCode.VISION_BUSY:
            body = AppResponse(error=AppError(code=e.code, message=e.message)).model_dump(mode="json", exclude_none=True)
            return JSONResponse(status_code=429, content=body, headers={"Retry-After": _RETRY_AFTER_S})
        raise
    # From here the slot is ours until the stream is closed; the generator below always closes it.
    try:
        loading = not (await service.status()).loaded
    except Exception:
        loading = False

    async def events():
        watcher = asyncio.create_task(watch_disconnect(request, cancel))
        try:
            if loading:
                yield _event(type="status", state="loading")
            async for text in stream:
                if cancel.is_set():
                    break
                yield _event(type="token", text=text)
            if not cancel.is_set():
                yield _event(type="done")
        except AppException as e:
            yield _event(type="error", code=str(e.code), message=e.message)
        except Exception as e:   # never let an unexpected failure drop the connection without a word
            logger.error(f"[vision] stream failed: {type(e).__name__}: {e}")
            yield _event(type="error", code=ExceptionCode.VISION_UNAVAILABLE.value, message="the vision model failed")
        finally:
            cancel.set()
            watcher.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await watcher
            await stream.aclose()   # frees the one-photo-at-a-time slot, after the model has really stopped

    return sse_response(events())


@router.get("/vision/status", response_model=VisionStatusResponse)
async def vision_status(service: VisionService = Depends(get_vision_service)):
    s = await service.status()
    return VisionStatusResponse(enabled=s.enabled, loaded=s.loaded, busy=s.busy, idle_seconds=s.idle_seconds, model=s.model)
