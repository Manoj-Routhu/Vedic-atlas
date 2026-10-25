"""VisionProcessManager - owns the `llama-server` child that runs the vision model.

  * Lazy: nothing is loaded until the first photo (`session()`), and the model is stopped again after
    `idle_unload_seconds` without one, so vision costs no RAM while unused.
  * Safe to start: refuses when the binary or model is missing or altered, when free memory is below
    `min_headroom_mb` (so loading it can't push the main model out), or when the port is already taken.
  * Contained: a start that fails backs off (5 s, 10 s, ... 2 min) instead of being retried on every request;
    a child that dies is noticed and restarted on the next photo.
  * No orphans: the child is killed when Veda exits (a Job Object on Windows), a pidfile lets the next start
    clean up after a hard kill, and on Linux it is first in line for the out-of-memory killer so a squeeze costs
    the photo, not Veda.

Everything the outside world touches (spawning, health probe, free memory, clock) can be replaced, so the
logic is tested without a real model; one slow test drives the real binary.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import os
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import AsyncIterator, Awaitable, Callable

import httpx

from core.constants import PROJECT_ROOT
from core.enums import ErrorMessage, ExceptionCode
from core.logging_config import logger
from domain.entities.vision import VisionStatus
from exceptions.exception import AppException
from schemas.config_schemas import VisionConfig
from tpa.vision.windows_job import KillOnCloseJob, create_kill_on_close_job

_NAME = "VisionProcessManager"
_BACKOFF_FIRST_S = 5.0
_BACKOFF_MAX_S = 120.0
_STOP_GRACE_S = 5.0
_HEALTH_POLL_S = 0.25


def _unavailable(detail: str) -> AppException:
    return AppException(_NAME, ExceptionCode.VISION_UNAVAILABLE, ErrorMessage.VISION_UNAVAILABLE, detail=detail)


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


class VisionProcessManager:
    def __init__(
        self,
        cfg: VisionConfig,
        *,
        root: Path = PROJECT_ROOT,
        spawn: Callable[[list[str], Path], "subprocess.Popen"] | None = None,
        probe_health: Callable[[], Awaitable[bool]] | None = None,
        available_mb: Callable[[], int] | None = None,
        port_in_use: Callable[[], bool] | None = None,
        is_our_process: Callable[[int], bool] | None = None,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ):
        self._cfg = cfg
        self._root = Path(root)
        self._spawn = spawn or self._spawn_real
        self._probe_health = probe_health or self._probe_health_real
        self._available_mb = available_mb or self._available_mb_real
        self._port_in_use = port_in_use or self._port_in_use_real
        self._is_our_process = is_our_process or self._is_our_process_real
        self._clock = clock
        self._sleep = sleep

        self._proc = None
        self._loaded = False
        self._in_use = 0
        self._last_used: float | None = None
        self._lock = asyncio.Lock()
        self._verified = False
        self._failures = 0
        self._retry_at = 0.0
        self._idle_task: asyncio.Task | None = None
        self._job: KillOnCloseJob | None = None
        self._pidfile = self._root / "data" / "vision-server.pid"
        self._logfile = self._pidfile.with_name("vision-server.log")

    # --- public ---

    @property
    def base_url(self) -> str:
        host = f"[{self._cfg.host}]" if ":" in self._cfg.host else self._cfg.host
        return f"http://{host}:{self._cfg.port}"

    async def start(self) -> None:
        """Clean up after a hard-killed Veda and begin watching for idleness. Does not load the model."""
        self._sweep_orphan()
        self._log_installation()
        if self._idle_task is None:
            self._idle_task = asyncio.get_running_loop().create_task(self._idle_loop())

    async def stop(self) -> None:
        task, self._idle_task = self._idle_task, None
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        async with self._lock:
            await self._terminate()
        if self._job is not None:
            self._job = None   # dropping our reference; the child is already gone

    async def reset(self) -> None:
        """Stop the model process because it is stuck. Unlike `stop()` this keeps the idle watcher; the next
        photo starts a fresh process (a stall is not a failed start, so there is no backoff)."""
        async with self._lock:
            await self._terminate()

    @contextlib.asynccontextmanager
    async def session(self) -> AsyncIterator[str]:
        """Make sure the model is running and hold it open (no idle unload) while the caller uses `base_url`."""
        await self._ensure_running()
        self._in_use += 1
        try:
            yield self.base_url
        finally:
            self._in_use -= 1
            self._last_used = self._clock()

    async def status(self) -> VisionStatus:
        idle = None if self._last_used is None else max(0.0, self._clock() - self._last_used)
        return VisionStatus(
            enabled=True, loaded=self._alive() and self._loaded, busy=self._in_use > 0,
            idle_seconds=None if self._in_use else idle, model=Path(self._cfg.model_path).name,
        )

    def _log_installation(self) -> None:
        missing = [label for label, p in (("llama-server (vision.binary_path)", self._resolve(self._cfg.binary_path)),
                                          ("model (vision.model_path)", self._resolve(self._cfg.model_path)),
                                          ("mmproj (vision.mmproj_path)", self._resolve(self._cfg.mmproj_path)))
                   if p is None or not p.is_file()]
        if missing:
            logger.warning(f"[vision] enabled, but not installed: {', '.join(missing)}. Photos will be refused until it is "
                           "(see config/vision.yaml; VEDA_DEVICE=laptop|pi picks the per-machine paths)")
        else:
            logger.info(f"[vision] ready (model loads on the first photo, unloads after {self._cfg.idle_unload_seconds}s idle)")

    # --- starting ---

    def _alive(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    async def _ensure_running(self) -> None:
        async with self._lock:
            if self._alive():
                return
            if self._proc is not None:   # it was running and is gone: crashed or killed from outside
                logger.warning(f"[vision] the model process exited (code {self._proc.poll()}); it will be restarted")
                self._forget_process()
            now = self._clock()
            if now < self._retry_at:
                raise _unavailable(f"the model failed to start recently; try again in {int(self._retry_at - now) + 1} s")
            await self._check_preconditions()
            try:
                await self._start_process()
            except AppException:
                self._failures += 1
                self._retry_at = self._clock() + min(_BACKOFF_FIRST_S * 2 ** (self._failures - 1), _BACKOFF_MAX_S)
                raise
            self._failures = 0
            self._retry_at = 0.0

    def _resolve(self, path: str | None) -> Path | None:
        if not path:
            return None
        p = Path(path)
        return p if p.is_absolute() else self._root / p

    async def _check_preconditions(self) -> None:
        """Cheap checks that need no backoff: they fail the same way until someone fixes the setup."""
        binary, model, mmproj = (self._resolve(p) for p in (self._cfg.binary_path, self._cfg.model_path, self._cfg.mmproj_path))
        for label, p in (("llama-server", binary), ("model", model), ("mmproj", mmproj)):
            if p is None or not p.is_file():
                logger.error(f"[vision] {label} not found at {p}; see config/vision.yaml and config/hardware/")
                raise _unavailable("the vision model is not installed on this machine")
        if not self._verified:
            for p, expected in ((model, self._cfg.model_sha256), (mmproj, self._cfg.mmproj_sha256)):
                if expected and await asyncio.to_thread(_sha256, p) != expected.lower():
                    logger.error(f"[vision] {p.name} does not match its configured SHA-256")
                    raise _unavailable("the vision model files failed their integrity check")
            self._verified = True
        free = self._available_mb()
        if free < self._cfg.min_headroom_mb:
            logger.warning(f"[vision] {free} MB free, {self._cfg.min_headroom_mb} MB needed; not loading the model")
            raise _unavailable("not enough free memory to load the vision model right now")
        if self._port_in_use():
            logger.error(f"[vision] port {self._cfg.port} is already in use; not starting a second server")
            raise _unavailable("the vision model's port is already in use")

    def _command(self) -> list[str]:
        c = self._cfg
        cmd = [
            str(self._resolve(c.binary_path)), "-m", str(self._resolve(c.model_path)), "--mmproj", str(self._resolve(c.mmproj_path)),
            "--host", c.host, "--port", str(c.port), "-c", str(c.n_ctx), "-np", "1",
            "--cache-ram", "0",   # the build's default is 8 GiB of host prompt cache
            "--image-max-tokens", str(c.image_max_tokens), "--reasoning", "off", "--no-webui",
        ]
        if c.n_threads:
            cmd += ["-t", str(c.n_threads)]
        return cmd

    async def _start_process(self) -> None:
        self._pidfile.parent.mkdir(parents=True, exist_ok=True)
        logger.info(f"[vision] starting the model (threads={self._cfg.n_threads}, ctx={self._cfg.n_ctx})")
        try:
            self._proc = self._spawn(self._command(), self._logfile)
        except OSError as e:
            logger.error(f"[vision] could not start llama-server: {e}")
            raise _unavailable("the vision model could not be started") from None
        self._pidfile.write_text(str(self._proc.pid), encoding="utf-8")

        deadline = self._clock() + self._cfg.startup_timeout_s
        began = self._clock()
        while True:
            if self._proc.poll() is not None:
                logger.error(f"[vision] llama-server exited during startup (code {self._proc.poll()}):\n{self._log_tail()}")
                self._forget_process()
                raise _unavailable("the vision model exited while starting")
            if await self._probe_health():
                break
            if self._clock() >= deadline:
                logger.error(f"[vision] llama-server not healthy after {self._cfg.startup_timeout_s}s:\n{self._log_tail()}")
                await self._terminate()
                raise _unavailable("the vision model took too long to start")
            await self._sleep(_HEALTH_POLL_S)
        self._loaded = True
        self._last_used = self._clock()
        logger.info(f"[vision] model ready in {self._clock() - began:.1f}s (pid {self._proc.pid})")

    # --- stopping ---

    async def _terminate(self) -> None:
        proc = self._proc
        if proc is None:
            self._forget_process()
            return
        if proc.poll() is None:
            proc.terminate()
            try:
                await asyncio.to_thread(proc.wait, _STOP_GRACE_S)
            except subprocess.TimeoutExpired:
                proc.kill()
                await asyncio.to_thread(proc.wait, _STOP_GRACE_S)
        self._forget_process()
        logger.info("[vision] model stopped")

    def _forget_process(self) -> None:
        self._proc = None
        self._loaded = False
        with contextlib.suppress(OSError):
            self._pidfile.unlink()

    async def _idle_loop(self) -> None:
        interval = max(1.0, min(30.0, self._cfg.idle_unload_seconds / 4))
        while True:
            await asyncio.sleep(interval)
            try:
                await self._maybe_unload()
            except Exception as e:   # the watcher must never die
                logger.warning(f"[vision] idle check failed: {type(e).__name__}: {e}")

    async def _maybe_unload(self) -> bool:
        """Stop the model if it has been idle long enough. Returns True if it was stopped."""
        async with self._lock:
            if self._proc is None:
                return False
            if not self._alive():
                self._forget_process()   # died on its own; free the pidfile and state
                return False
            if self._in_use or self._last_used is None:
                return False
            if self._clock() - self._last_used < self._cfg.idle_unload_seconds:
                return False
            logger.info(f"[vision] idle for {self._cfg.idle_unload_seconds}s; unloading the model")
            await self._terminate()
            return True

    # --- leftovers from a previous run ---

    def _sweep_orphan(self) -> None:
        try:
            pid = int(self._pidfile.read_text(encoding="utf-8").strip())
        except (OSError, ValueError):
            return
        try:
            if self._is_our_process(pid):
                import psutil

                logger.warning(f"[vision] stopping a model process left over from a previous run (pid {pid})")
                proc = psutil.Process(pid)
                proc.terminate()
                try:
                    proc.wait(_STOP_GRACE_S)
                except psutil.TimeoutExpired:
                    proc.kill()
        except Exception as e:
            logger.warning(f"[vision] could not clean up the old model process: {type(e).__name__}: {e}")
        finally:
            with contextlib.suppress(OSError):
                self._pidfile.unlink()

    def _is_our_process_real(self, pid: int) -> bool:
        """Only ever stop something that is recognisably our llama-server (a pid can be reused by anything else)."""
        import psutil

        try:
            proc = psutil.Process(pid)
            cmd = " ".join(proc.cmdline()).lower()
            return "llama-server" in proc.name().lower() and Path(self._cfg.model_path).name.lower() in cmd
        except psutil.Error:
            return False

    # --- real-world defaults ---

    def _spawn_real(self, cmd: list[str], log_path: Path):
        log_path.parent.mkdir(parents=True, exist_ok=True)
        kwargs: dict = {"stdin": subprocess.DEVNULL}
        log = open(log_path, "wb")
        kwargs["stdout"] = log
        kwargs["stderr"] = subprocess.STDOUT
        if sys.platform == "win32":
            # CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | BELOW_NORMAL_PRIORITY_CLASS: no console window, isolated from
            # our Ctrl-C, and the voice loop wins CPU contention.
            kwargs["creationflags"] = 0x08000000 | 0x00000200 | 0x00004000
        else:
            kwargs["start_new_session"] = True
            kwargs["preexec_fn"] = lambda: os.nice(5)
        try:
            proc = subprocess.Popen(cmd, **kwargs)
        finally:
            log.close()
        if sys.platform == "win32":
            if self._job is None:
                self._job = create_kill_on_close_job()
            if self._job is None or not self._job.assign(proc.pid):
                logger.warning("[vision] the model is not tied to Veda's lifetime (job object unavailable)")
        else:
            try:   # first victim of the out-of-memory killer: losing a photo beats losing Veda
                Path(f"/proc/{proc.pid}/oom_score_adj").write_text("1000", encoding="utf-8")
            except OSError:
                logger.warning("[vision] could not set oom_score_adj for the model process")
        return proc

    async def _probe_health_real(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=2.0) as client:
                return (await client.get(f"{self.base_url}/health")).status_code == 200
        except httpx.HTTPError:
            return False

    @staticmethod
    def _available_mb_real() -> int:
        import psutil

        return int(psutil.virtual_memory().available // (1024 * 1024))

    def _port_in_use_real(self) -> bool:
        try:
            with socket.create_connection((self._cfg.host, self._cfg.port), timeout=0.5):
                return True
        except OSError:
            return False

    def _log_tail(self, lines: int = 8) -> str:
        try:
            return "\n".join(self._logfile.read_text(encoding="utf-8", errors="replace").splitlines()[-lines:])
        except OSError:
            return "(no log)"
