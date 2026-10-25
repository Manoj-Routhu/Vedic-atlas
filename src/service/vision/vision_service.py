"""VisionService - photo in, spoken-ready description out. Knows nothing about memory, chat or agents.

Two steps, matching the HTTP API: `store_image` checks and shrinks an uploaded photo and keeps it in memory for a
few minutes (so follow-up questions need no re-upload); `ask` runs one question about a stored photo and streams the
reply. One photo is processed at a time: `ask` reserves the slot before it returns, so the route can answer 429
before it sends any stream headers, and the slot is freed when the stream ends, fails or is closed.

Images exist only in this process's memory. They are re-encoded (which drops EXIF/GPS), never written to disk and never logged.
"""

from __future__ import annotations

import asyncio
import io
import secrets
import time
from typing import AsyncIterator, Callable

from PIL import Image, ImageOps, UnidentifiedImageError

from core.enums import ErrorMessage, ExceptionCode
from core.logging_config import logger
from domain.entities.vision import LANGUAGES, STYLES, ImageInfo, VisionStatus
from domain.ports.vision_port import VisionPort
from exceptions.exception import AppException
from schemas.config_schemas import VisionConfig
from service.vision.prompts import build_prompt
from service.vision.text_cleaner import SpeechCleaner

_ALLOWED_FORMATS = {"JPEG", "PNG", "WEBP"}
_MAX_PIXELS = 48_000_000   # decoded size limit (about 7000 x 7000): a small file can still expand into gigabytes
_JPEG_QUALITY = 85
_NAME = "VisionService"
_LEASE_S = 15.0   # a reserved slot whose stream never starts (client vanished) is taken back after this long


def _invalid(detail: str) -> AppException:
    return AppException(_NAME, ExceptionCode.IMAGE_INVALID, ErrorMessage.IMAGE_INVALID, detail=detail)


def _normalise(data: bytes, max_edge: int) -> tuple[bytes, int, int]:
    """Check the upload is a real image, apply its rotation, shrink it, and re-encode as JPEG (blocking: call in a thread)."""
    try:
        with Image.open(io.BytesIO(data)) as img:
            if img.format not in _ALLOWED_FORMATS:
                raise _invalid("only JPEG, PNG and WebP photos are supported")
            width, height = img.size   # read from the header, before any pixels are decoded
            if width < 1 or height < 1 or width * height > _MAX_PIXELS:
                raise _invalid("image dimensions are too large")
            img = ImageOps.exif_transpose(img)
            if img.mode != "RGB":
                flat = Image.new("RGB", img.size, (255, 255, 255))   # transparency becomes white, not black
                rgba = img.convert("RGBA")
                flat.paste(rgba, mask=rgba.getchannel("A"))
                img = flat
            img.thumbnail((max_edge, max_edge), Image.Resampling.LANCZOS)
            out = io.BytesIO()
            img.save(out, "JPEG", quality=_JPEG_QUALITY)   # no exif argument: location and camera data are dropped
            return out.getvalue(), img.width, img.height
    except AppException:
        raise
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError):
        raise _invalid("not a readable image") from None


class VisionStream:
    """The reply stream of one `ask`. Always `aclose()` it (or exhaust it): that is what frees the single slot."""

    def __init__(self, chunks: AsyncIterator[str], on_release: Callable[["VisionStream"], None], created_at: float):
        self._chunks = chunks
        self._on_release = on_release
        self._released = False
        self.created_at = created_at
        self.started = False

    def _release(self) -> None:
        if not self._released:
            self._released = True
            self._on_release(self)

    def __aiter__(self) -> "VisionStream":
        return self

    async def __anext__(self) -> str:
        self.started = True
        try:
            return await self._chunks.__anext__()
        except BaseException:   # includes StopAsyncIteration: the stream is over either way
            self._release()
            raise

    async def aclose(self) -> None:
        try:
            close = getattr(self._chunks, "aclose", None)
            if close is not None:
                await close()
        finally:
            self._release()


class VisionService:
    def __init__(self, port: VisionPort, cfg: VisionConfig, clock: Callable[[], float] = time.monotonic):
        self._port = port
        self._cfg = cfg
        self._clock = clock
        self._images: dict[str, tuple[bytes, float, int, int]] = {}   # id -> (jpeg, expires_at, width, height)
        self._busy = False
        self._current: VisionStream | None = None

    @property
    def max_upload_bytes(self) -> int:
        return self._cfg.upload_max_bytes

    # --- photos ---

    async def store_image(self, data: bytes) -> ImageInfo:
        if not data:
            raise _invalid("empty upload")
        if len(data) > self._cfg.upload_max_bytes:
            raise _invalid(f"larger than {self._cfg.upload_max_bytes // 1024} KB")
        jpeg, width, height = await asyncio.to_thread(_normalise, data, self._cfg.image_max_edge_px)
        self._evict_expired()
        while len(self._images) >= self._cfg.image_cache_max:
            self._images.pop(min(self._images, key=lambda k: self._images[k][1]))   # drop the oldest
        image_id = secrets.token_urlsafe(12)
        self._images[image_id] = (jpeg, self._clock() + self._cfg.image_cache_ttl_s, width, height)
        return ImageInfo(image_id=image_id, width=width, height=height)

    def _get_image(self, image_id: str) -> bytes:
        self._evict_expired()
        entry = self._images.get(image_id)
        if entry is None:
            raise _invalid("unknown or expired photo; take it again")
        return entry[0]

    def _evict_expired(self) -> None:
        now = self._clock()
        for key in [k for k, v in self._images.items() if v[1] <= now]:
            del self._images[key]

    # --- questions ---

    async def ask(self, image_id: str, *, question: str | None = None, style: str = "brief", lang: str = "en",
                  cancel: asyncio.Event | None = None) -> VisionStream:
        """Reserve the slot and return the reply stream. Raises at once (before any streaming) on a bad request or when busy."""
        if lang not in LANGUAGES:
            raise AppException(_NAME, ExceptionCode.VALIDATION_ERROR, message=f"language {lang!r} is not supported; use one of {LANGUAGES}")
        if style not in STYLES:
            raise AppException(_NAME, ExceptionCode.VALIDATION_ERROR, message=f"style {style!r} is not supported; use one of {STYLES}")
        image = self._get_image(image_id)
        prompt = build_prompt(style, question)
        if self._busy and self._current is not None and not self._current.started                 and self._clock() - self._current.created_at > _LEASE_S:
            logger.warning("[vision] taking back a reserved slot whose stream never started")
            self._current = None
            self._busy = False
        if self._busy:
            raise AppException(_NAME, ExceptionCode.VISION_BUSY, ErrorMessage.VISION_BUSY)
        self._busy = True
        cancel = cancel or asyncio.Event()
        self._current = VisionStream(self._reply(image, prompt, cancel), self._release_for, self._clock())
        return self._current

    def _release_for(self, stream: VisionStream) -> None:
        """Free the slot - but only if `stream` still owns it (a taken-back stream closing late must not free a newer one)."""
        if self._current is stream:
            self._current = None
            self._busy = False

    async def _reply(self, image: bytes, prompt: str, cancel: asyncio.Event) -> AsyncIterator[str]:
        cleaner = SpeechCleaner()
        chunks = self._port.describe(image, "image/jpeg", prompt, cancel=cancel)
        try:
            async for chunk in chunks:
                if cancel.is_set():
                    break
                text = cleaner.feed(chunk)
                if text:
                    yield text
            tail = cleaner.flush()
            if tail and not cancel.is_set():
                yield tail
        except AppException:
            raise
        except asyncio.CancelledError:
            raise
        except Exception as e:   # a backend failure must not escape as an unhandled error (rule I5)
            logger.error(f"[vision] backend failed: {type(e).__name__}: {e}")
            raise AppException(_NAME, ExceptionCode.VISION_UNAVAILABLE, ErrorMessage.VISION_UNAVAILABLE,
                               detail="the vision model failed") from None
        finally:
            close = getattr(chunks, "aclose", None)   # lets the backend finish its own cleanup before the slot is freed
            if close is not None:
                await close()

    # --- passthroughs ---

    async def status(self) -> VisionStatus:
        return await self._port.status()

    async def start(self) -> None:
        await self._port.start()

    async def stop(self) -> None:
        self._images.clear()
        await self._port.stop()
