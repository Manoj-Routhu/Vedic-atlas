"""LlamaServerVisionAdapter - VisionPort over a local llama-server (OpenAI-style /v1/chat/completions).

Streams the model's reply as text chunks. Raw httpx on purpose: the egress-guarded client in tpa/online cannot stream,
and this adapter only ever talks to a loopback address (checked again here, on top of the config validator).

Cancelling closes the HTTP stream, which makes llama-server stop generating - but it cannot interrupt the image
encoding that happens first. So after any early exit the adapter waits for `/slots` to report idle before returning;
VisionService frees its one-photo-at-a-time slot only after that, so a cancelled photo can never be followed by a new
one while the model is still busy with the old.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import ipaddress
import json
import time
from typing import AsyncIterator
from urllib.parse import urlparse

import httpx

from core.enums import ErrorMessage, ExceptionCode
from core.logging_config import logger
from domain.entities.vision import VisionStatus
from exceptions.exception import AppException
from schemas.config_schemas import VisionConfig
from tpa.vision.vision_process_manager import VisionProcessManager

_NAME = "LlamaServerVisionAdapter"
_TEMPERATURE = 0.2   # factual description, not creative writing
_IDLE_POLL_S = 0.1
_IDLE_WAIT_MAX_S = 60.0


class _Stalled(AppException):
    """The model stopped producing output. It is stuck, so it gets restarted rather than waited for."""


class _Gone(AppException):
    """The model server is not there (crashed or refused the connection): nothing left to wait for."""


def _unavailable(detail: str, kind: type[AppException] = AppException) -> AppException:
    return kind(_NAME, ExceptionCode.VISION_UNAVAILABLE, ErrorMessage.VISION_UNAVAILABLE, detail=detail)


def _require_loopback(base_url: str) -> None:
    host = (urlparse(base_url).hostname or "").strip("[]")
    try:
        ok = ipaddress.ip_address(host).is_loopback
    except ValueError:
        ok = False
    if not ok:
        raise _unavailable("the vision model server must be on this machine")


class LlamaServerVisionAdapter:
    def __init__(self, manager: VisionProcessManager, cfg: VisionConfig):
        self._manager = manager
        self._cfg = cfg

    # --- VisionPort ---

    async def describe(self, image: bytes, mime: str, prompt: str, *, cancel: asyncio.Event) -> AsyncIterator[str]:
        data_uri = f"data:{mime};base64," + (await asyncio.to_thread(base64.b64encode, image)).decode("ascii")
        body = {
            "stream": True, "max_tokens": self._cfg.max_new_tokens, "temperature": _TEMPERATURE,
            "messages": [{"role": "user", "content": [   # image first, then the question: what Qwen-VL expects
                {"type": "image_url", "image_url": {"url": data_uri}},
                {"type": "text", "text": prompt},
            ]}],
        }
        async with self._manager.session() as base_url:
            _require_loopback(base_url)
            timeout = httpx.Timeout(self._cfg.request_timeout_s, connect=5.0)
            async with httpx.AsyncClient(timeout=timeout) as client:
                finished = stalled = gone = False
                try:
                    # aclosing: if our consumer stops early, the HTTP stream is closed HERE (before the idle wait below),
                    # not whenever the garbage collector gets to the inner generator.
                    async with contextlib.aclosing(self._stream(client, base_url, body, cancel)) as chunks:
                        async for chunk in chunks:
                            yield chunk
                    finished = not cancel.is_set()
                except _Stalled:
                    stalled = True
                    raise
                except _Gone:
                    gone = True
                    raise
                finally:
                    if stalled:
                        await self._manager.reset()   # stuck: stop it; the next photo reloads it
                    elif not finished and not gone:
                        await self._wait_until_idle(client, base_url)

    async def status(self) -> VisionStatus:
        return await self._manager.status()

    async def start(self) -> None:
        await self._manager.start()

    async def stop(self) -> None:
        await self._manager.stop()

    # --- streaming ---

    async def _stream(self, client: httpx.AsyncClient, base_url: str, body: dict, cancel: asyncio.Event) -> AsyncIterator[str]:
        began = time.perf_counter()
        first_token_at: float | None = None
        tokens = 0
        deadline = began + self._cfg.request_timeout_s
        cancel_wait = asyncio.ensure_future(cancel.wait())
        try:
            async with client.stream("POST", f"{base_url}/v1/chat/completions", json=body) as resp:
                if resp.status_code != 200:
                    await resp.aread()
                    self._raise_for_status(resp)
                lines = resp.aiter_lines().__aiter__()
                while True:
                    next_line = asyncio.ensure_future(lines.__anext__())
                    done, _ = await asyncio.wait({next_line, cancel_wait}, timeout=max(0.0, deadline - time.perf_counter()),
                                                 return_when=asyncio.FIRST_COMPLETED)
                    if next_line not in done:
                        next_line.cancel()
                        await asyncio.gather(next_line, return_exceptions=True)
                        if cancel_wait in done:
                            return
                        logger.error(f"[vision] no complete reply within {self._cfg.request_timeout_s}s; giving up")
                        raise _unavailable("the vision model took too long to answer", _Stalled)
                    try:
                        line = next_line.result()
                    except StopAsyncIteration:
                        break
                    delta = self._parse_line(line)
                    if delta is _DONE:
                        break
                    if delta:
                        if first_token_at is None:
                            first_token_at = time.perf_counter()
                        tokens += 1
                        yield delta
        except httpx.TimeoutException:
            logger.error("[vision] the model server stopped answering")
            raise _unavailable("the vision model took too long to answer", _Stalled) from None
        except httpx.HTTPError as e:
            logger.error(f"[vision] could not talk to the model server: {type(e).__name__}")
            raise _unavailable("the vision model is not responding", _Gone) from None
        finally:
            cancel_wait.cancel()
            await asyncio.gather(cancel_wait, return_exceptions=True)
            if first_token_at is not None:
                total = time.perf_counter() - began
                logger.info(f"[vision] reply: first token {first_token_at - began:.1f}s, total {total:.1f}s, {tokens} chunks")

    @staticmethod
    def _raise_for_status(resp: httpx.Response) -> None:
        logger.error(f"[vision] model server answered HTTP {resp.status_code}: {resp.text[:200]}")
        if 400 <= resp.status_code < 500:
            raise AppException(_NAME, ExceptionCode.IMAGE_INVALID, ErrorMessage.IMAGE_INVALID,
                               detail="the vision model could not read the image")
        raise _unavailable("the vision model failed")

    @staticmethod
    def _parse_line(line: str):
        """One SSE line -> text to say, '' to skip, or _DONE. Reasoning deltas and keep-alives are skipped."""
        if not line.startswith("data:"):
            return ""
        payload = line[5:].strip()
        if payload == "[DONE]":
            return _DONE
        try:
            event = json.loads(payload)
        except ValueError:
            return ""
        if "error" in event:
            logger.error(f"[vision] model server reported an error: {str(event['error'])[:200]}")
            raise _unavailable("the vision model failed")
        choices = event.get("choices") or []
        if not choices:
            return ""
        return (choices[0].get("delta") or {}).get("content") or ""

    # --- idle ---

    async def _wait_until_idle(self, client: httpx.AsyncClient, base_url: str) -> None:
        """Block until llama-server has no slot processing (the abandoned photo is fully finished with)."""
        deadline = time.perf_counter() + _IDLE_WAIT_MAX_S
        while time.perf_counter() < deadline:
            try:
                resp = await client.get(f"{base_url}/slots", timeout=5.0)
            except httpx.HTTPError:
                return   # the server is gone: nothing left to wait for
            if resp.status_code != 200:
                return   # slot monitoring unavailable in this build: do not wait forever
            try:
                if not any(slot.get("is_processing") for slot in resp.json()):
                    return
            except (ValueError, AttributeError, TypeError):
                return
            await asyncio.sleep(_IDLE_POLL_S)
        logger.warning(f"[vision] the model was still busy {_IDLE_WAIT_MAX_S:.0f}s after a cancelled photo")


_DONE = object()
