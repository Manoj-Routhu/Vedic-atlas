"""VisionProcessManager: lazy start, safety checks, backoff, idle unload, cleanup. The logic runs against a fake child
process; real-process tests cover the pidfile sweep, the Windows kill-on-exit job and (if the model is downloaded)
the real llama-server.

Run: pytest tests/test_vision_process_manager.py
"""

import asyncio
import hashlib
import subprocess
import sys
import time
from pathlib import Path

import pytest

from core.constants import PROJECT_ROOT
from core.enums import ExceptionCode
from exceptions.exception import AppException
from schemas.config_schemas import VisionConfig
from tpa.vision import vision_process_manager as pm_module
from tpa.vision.vision_process_manager import VisionProcessManager


def run(coro):
    return asyncio.run(coro)


class FakeProc:
    def __init__(self, pid=4242, stubborn=False):
        self.pid, self.returncode, self.stubborn = pid, None, stubborn
        self.terminated = self.killed = False

    def poll(self):
        return self.returncode

    def terminate(self):
        self.terminated = True
        if not self.stubborn:
            self.returncode = 0

    def kill(self):
        self.killed = True
        self.returncode = -9

    def wait(self, timeout=None):
        if self.returncode is None:
            raise subprocess.TimeoutExpired("llama-server", timeout)
        return self.returncode

    def die(self, code=1):
        self.returncode = code


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


class Harness:
    """A manager wired to fakes, with the three model files on disk under tmp_path."""

    def __init__(self, tmp_path, **cfg_overrides):
        (tmp_path / "bin").mkdir()
        self.files = {}
        for name in ("llama-server", "model.gguf", "mmproj.gguf"):
            f = tmp_path / "bin" / name
            f.write_bytes(name.encode() * 10)
            self.files[name] = f
        cfg = dict(
            binary_path="bin/llama-server", model_path="bin/model.gguf", mmproj_path="bin/mmproj.gguf",
            min_headroom_mb=1000, startup_timeout_s=10, idle_unload_seconds=300, port=8099,
        )
        cfg.update(cfg_overrides)
        self.cfg = VisionConfig(**cfg)
        self.clock = Clock()
        self.procs: list[FakeProc] = []
        self.commands: list[list[str]] = []
        self.health_script: list[bool] = []
        self.free_mb = 5000
        self.port_busy = False
        self.sleeps: list[float] = []
        self.next_proc = lambda: FakeProc(pid=4000 + len(self.procs))
        self.manager = VisionProcessManager(
            self.cfg, root=tmp_path, spawn=self._spawn, probe_health=self._health, available_mb=lambda: self.free_mb,
            port_in_use=lambda: self.port_busy, is_our_process=lambda pid: False, clock=self.clock, sleep=self._sleep,
        )

    def _spawn(self, cmd, log_path):
        self.commands.append(cmd)
        proc = self.next_proc()
        self.procs.append(proc)
        return proc

    async def _health(self):
        return self.health_script.pop(0) if self.health_script else True

    async def _sleep(self, seconds):
        self.sleeps.append(seconds)
        self.clock.t += seconds

    async def use(self):
        async with self.manager.session() as url:
            return url


@pytest.fixture
def h(tmp_path):
    return Harness(tmp_path)


def unavailable(coro_or_call):
    with pytest.raises(AppException) as e:
        run(coro_or_call)
    assert e.value.code == ExceptionCode.VISION_UNAVAILABLE
    return e.value


# ---------- starting ----------

def test_nothing_is_loaded_until_the_first_photo(h):
    run(h.manager.start())
    assert h.procs == []
    run(h.manager.stop())


def test_first_use_starts_the_model_and_later_uses_share_it(h):
    async def go():
        url1 = await h.use()
        url2 = await h.use()
        return url1, url2

    assert run(go()) == ("http://127.0.0.1:8099", "http://127.0.0.1:8099")
    assert len(h.procs) == 1


def test_concurrent_first_uses_start_one_process(h):
    async def go():
        await asyncio.gather(h.use(), h.use(), h.use())

    run(go())
    assert len(h.procs) == 1


def test_command_line(h):
    run(h.use())
    cmd = h.commands[0]
    assert cmd[0].endswith("llama-server")
    for flag, value in (("--host", "127.0.0.1"), ("--port", "8099"), ("-np", "1"), ("--cache-ram", "0"),
                        ("--image-max-tokens", "512"), ("--reasoning", "off"), ("-c", "4096")):
        assert cmd[cmd.index(flag) + 1] == value, flag
    assert "--no-webui" in cmd and "--mmproj" in cmd and "-m" in cmd
    assert "-t" not in cmd   # threads unset: llama.cpp decides


def test_threads_are_passed_when_configured(tmp_path):
    h = Harness(tmp_path, n_threads=3)
    run(h.use())
    assert h.commands[0][h.commands[0].index("-t") + 1] == "3"


def test_waits_until_the_server_reports_healthy(h):
    h.health_script = [False, False, False, True]
    run(h.use())
    assert len(h.sleeps) == 3


def test_ipv6_loopback_url_is_bracketed(tmp_path):
    h = Harness(tmp_path, host="::1")
    assert h.manager.base_url == "http://[::1]:8099"


def test_pidfile_is_written_and_removed(tmp_path):
    h = Harness(tmp_path)
    run(h.use())
    pidfile = tmp_path / "data" / "vision-server.pid"
    assert pidfile.read_text() == str(h.procs[0].pid)
    run(h.manager.stop())
    assert not pidfile.exists()


# ---------- refusing to start ----------

@pytest.mark.parametrize("missing", ["llama-server", "model.gguf", "mmproj.gguf"])
def test_missing_file_is_unavailable_without_backoff(tmp_path, missing):
    h = Harness(tmp_path)
    h.files[missing].unlink()
    err = unavailable(h.use())
    assert "not installed" in err.message and str(tmp_path) not in err.message   # no paths leaked to the phone
    assert h.procs == []
    h.files[missing].write_bytes(b"x")
    run(h.use())   # fixed: works at once, no backoff to wait out
    assert len(h.procs) == 1


def test_unconfigured_binary_is_unavailable(tmp_path):
    h = Harness(tmp_path, binary_path=None)
    unavailable(h.use())


def test_checksum_mismatch_is_refused(tmp_path):
    h = Harness(tmp_path, model_sha256="0" * 64)
    err = unavailable(h.use())
    assert "integrity" in err.message and h.procs == []


def test_matching_checksum_is_accepted_and_checked_only_once(tmp_path, monkeypatch):
    good = hashlib.sha256(b"model.gguf" * 10).hexdigest()
    h = Harness(tmp_path, model_sha256=good)
    calls = []
    real = pm_module._sha256
    monkeypatch.setattr(pm_module, "_sha256", lambda p: calls.append(p) or real(p))
    run(h.use())
    h.procs[0].die()
    run(h.use())   # restart after a crash
    assert len(calls) == 1 and len(h.procs) == 2


def test_not_enough_free_memory_is_refused_then_allowed_when_freed(h):
    h.free_mb = 200
    err = unavailable(h.use())
    assert "memory" in err.message and h.procs == []
    h.free_mb = 4000
    run(h.use())   # no backoff for a memory refusal
    assert len(h.procs) == 1


def test_port_already_in_use_is_refused(h):
    h.port_busy = True
    err = unavailable(h.use())
    assert "port" in err.message and h.procs == []


# ---------- failing to start: backoff ----------

def test_exit_during_startup_fails_cleans_up_and_backs_off(h):
    h.next_proc = lambda: (lambda p: (p.die(3), p)[1])(FakeProc(pid=4000 + len(h.procs)))
    h.health_script = [False]
    unavailable(h.use())
    assert not (Path(h.cfg.model_path).parent / "x").exists()
    err = unavailable(h.use())   # inside the backoff window
    assert "try again in" in err.message and len(h.procs) == 1   # did not even try
    h.clock.t += 6
    h.next_proc = lambda: FakeProc(pid=5000)
    run(h.use())   # window over: works
    assert len(h.procs) == 2


def test_backoff_doubles_up_to_a_cap(h):
    h.health_script = [False] * 1000
    h.cfg.startup_timeout_s = 1
    waits = []
    for _ in range(8):
        unavailable(h.use())
        waits.append(h.manager._retry_at - h.clock.t)
        h.clock.t = h.manager._retry_at   # wait it out
    assert waits[:4] == [pytest.approx(5), pytest.approx(10), pytest.approx(20), pytest.approx(40)]
    assert max(waits) <= 120.001 and waits[-1] == pytest.approx(120)


def test_startup_timeout_kills_the_process(h):
    h.health_script = [False] * 10_000
    h.cfg.startup_timeout_s = 2
    err = unavailable(h.use())
    assert "too long" in err.message
    assert h.procs[0].terminated and h.procs[0].returncode is not None


def test_a_crash_after_running_is_restarted_on_the_next_use(h):
    run(h.use())
    h.procs[0].die(139)
    run(h.use())
    assert len(h.procs) == 2 and h.procs[1].poll() is None


# ---------- idle unload ----------

def test_model_is_unloaded_only_after_the_idle_time(h):
    run(h.use())
    h.clock.t += 299
    assert run(h.manager._maybe_unload()) is False and h.procs[0].poll() is None
    h.clock.t += 2
    assert run(h.manager._maybe_unload()) is True
    assert h.procs[0].terminated
    run(h.use())   # comes back on demand
    assert len(h.procs) == 2


def test_idle_timer_restarts_after_each_use(h):
    run(h.use())
    h.clock.t += 250
    run(h.use())   # a new photo
    h.clock.t += 250
    assert run(h.manager._maybe_unload()) is False   # 250 s since the last photo, not 500
    h.clock.t += 60
    assert run(h.manager._maybe_unload()) is True


def test_model_is_never_unloaded_mid_request(h):
    async def go():
        async with h.manager.session():
            h.clock.t += 10_000
            assert await h.manager._maybe_unload() is False
        assert await h.manager._maybe_unload() is False   # the clock restarts when the request ends
        h.clock.t += 301
        assert await h.manager._maybe_unload() is True

    run(go())


def test_idle_check_notices_a_dead_process_and_clears_it(h, tmp_path):
    run(h.use())
    h.procs[0].die()
    assert run(h.manager._maybe_unload()) is False
    assert not (tmp_path / "data" / "vision-server.pid").exists()


# ---------- stopping ----------

def test_stop_is_graceful_and_safe_twice(h):
    run(h.use())
    run(h.manager.stop())
    run(h.manager.stop())
    assert h.procs[0].terminated and not h.procs[0].killed


def test_a_process_that_ignores_terminate_is_killed(h, monkeypatch):
    monkeypatch.setattr(pm_module, "_STOP_GRACE_S", 0.01)
    h.next_proc = lambda: FakeProc(pid=4999, stubborn=True)
    run(h.use())
    run(h.manager.stop())
    assert h.procs[0].killed


def test_idle_watcher_starts_and_stops_with_the_manager(h):
    async def go():
        await h.manager.start()
        await h.manager.start()   # idempotent
        assert h.manager._idle_task is not None
        await h.manager.stop()
        assert h.manager._idle_task is None

    run(go())


# ---------- status ----------

def test_status_over_a_lifecycle(h):
    async def go():
        s = await h.manager.status()
        assert (s.loaded, s.busy, s.idle_seconds) == (False, False, None)
        async with h.manager.session():
            s = await h.manager.status()
            assert (s.loaded, s.busy, s.idle_seconds) == (True, True, None)
        h.clock.t += 42
        s = await h.manager.status()
        assert (s.loaded, s.busy) == (True, False) and s.idle_seconds == pytest.approx(42)
        assert s.model == "model.gguf"

    run(go())


# ---------- leftovers from a previous run (real processes) ----------

def _sleeper() -> subprocess.Popen:
    return subprocess.Popen([sys.executable, "-I", "-c", "import time; time.sleep(120)"])


def test_sweep_stops_a_leftover_process_that_is_ours(tmp_path):
    h = Harness(tmp_path)
    child = _sleeper()
    try:
        (tmp_path / "data").mkdir()
        (tmp_path / "data" / "vision-server.pid").write_text(str(child.pid))
        h.manager._is_our_process = lambda pid: pid == child.pid
        run(h.manager.start())
        child.wait(timeout=10)   # it was stopped
        assert not (tmp_path / "data" / "vision-server.pid").exists()
    finally:
        child.kill()
        run(h.manager.stop())


def test_sweep_leaves_an_unrelated_process_alone_but_clears_the_pidfile(tmp_path):
    """The pid may have been reused by something else entirely."""
    h = Harness(tmp_path)
    child = _sleeper()
    try:
        (tmp_path / "data").mkdir()
        (tmp_path / "data" / "vision-server.pid").write_text(str(child.pid))
        run(h.manager.start())   # is_our_process says no
        assert child.poll() is None
        assert not (tmp_path / "data" / "vision-server.pid").exists()
    finally:
        child.kill()
        run(h.manager.stop())


def test_sweep_ignores_a_garbage_pidfile(tmp_path):
    h = Harness(tmp_path)
    (tmp_path / "data").mkdir()
    (tmp_path / "data" / "vision-server.pid").write_text("not a pid")
    run(h.manager.start())
    run(h.manager.stop())


def test_the_real_ownership_check_rejects_a_python_process(tmp_path):
    h = Harness(tmp_path)
    child = _sleeper()
    try:
        assert VisionProcessManager._is_our_process_real(h.manager, child.pid) is False
        assert VisionProcessManager._is_our_process_real(h.manager, 2**22 + 12345) is False   # no such pid
    finally:
        child.kill()


# ---------- Windows: the child dies with Veda ----------

@pytest.mark.skipif(sys.platform != "win32", reason="Windows Job Objects")
def test_job_object_kills_its_processes_when_closed():
    from tpa.vision.windows_job import create_kill_on_close_job

    job = create_kill_on_close_job()
    assert job is not None
    child = _sleeper()
    try:
        assert job.assign(child.pid)
        assert child.poll() is None
        job.close()   # what Windows does for us when Veda's process ends
        child.wait(timeout=10)
    finally:
        child.kill()


@pytest.mark.skipif(sys.platform != "win32", reason="Windows Job Objects")
def test_a_process_in_the_job_dies_when_the_owner_is_hard_killed(tmp_path):
    script = tmp_path / "owner.py"
    script.write_text(
        "import os, subprocess, sys, time\n"
        f"sys.path.insert(0, {str(PROJECT_ROOT / 'src')!r})\n"
        "from tpa.vision.windows_job import create_kill_on_close_job\n"
        "job = create_kill_on_close_job()\n"
        "child = subprocess.Popen([sys.executable, '-I', '-c', 'import time; time.sleep(120)'])\n"
        "assert job.assign(child.pid)\n"
        "print(child.pid, flush=True)\n"
        "os._exit(1)\n",   # a hard kill: no cleanup code runs
        encoding="utf-8",
    )
    out = subprocess.run([sys.executable, "-I", str(script)], capture_output=True, text=True, timeout=30)
    pid = int(out.stdout.strip())
    import psutil

    deadline = time.time() + 10
    while psutil.pid_exists(pid) and time.time() < deadline:
        time.sleep(0.2)
    assert not psutil.pid_exists(pid), "the child outlived its owner"


# ---------- the real llama-server (slow; runs only where the binary and model are downloaded) ----------

_BIN = PROJECT_ROOT / "data/tools/llama-b11716-win-cpu-x64/llama-server.exe"
_MODEL = PROJECT_ROOT / "data/models/vision/Qwen3VL-2B-Instruct-Q4_K_M.gguf"
_MMPROJ = PROJECT_ROOT / "data/models/vision/mmproj-Qwen3VL-2B-Instruct-Q8_0.gguf"
_real_available = _BIN.exists() and _MODEL.exists() and _MMPROJ.exists()


def _real_cfg(**kw) -> VisionConfig:
    return VisionConfig(binary_path=str(_BIN), model_path=str(_MODEL), mmproj_path=str(_MMPROJ), port=8091, n_threads=4,
                        min_headroom_mb=1500, **kw)


@pytest.mark.skipif(not _real_available, reason="llama-server and the model are not downloaded here")
def test_real_llama_server_lifecycle(tmp_path):
    import httpx
    import psutil

    async def go():
        manager = VisionProcessManager(_real_cfg(), root=tmp_path)
        await manager.start()
        async with manager.session() as url:
            assert httpx.get(f"{url}/health", timeout=5).status_code == 200
            assert httpx.get(f"{url}/props", timeout=5).json()["modalities"]["vision"] is True
            pid = manager._proc.pid
            assert (await manager.status()).loaded
        await manager.stop()
        return pid

    pid = run(go())
    assert not psutil.pid_exists(pid)
    assert not (tmp_path / "data" / "vision-server.pid").exists()


@pytest.mark.skipif(not _real_available or sys.platform != "win32", reason="needs the real model on Windows")
def test_real_llama_server_dies_with_a_hard_killed_owner(tmp_path):
    script = tmp_path / "owner.py"
    script.write_text(
        "import asyncio, os, sys\n"
        f"sys.path.insert(0, {str(PROJECT_ROOT / 'src')!r})\n"
        "from schemas.config_schemas import VisionConfig\n"
        "from tpa.vision.vision_process_manager import VisionProcessManager\n"
        f"cfg = VisionConfig(binary_path={str(_BIN)!r}, model_path={str(_MODEL)!r}, mmproj_path={str(_MMPROJ)!r}, port=8092, n_threads=4, min_headroom_mb=1500)\n"
        "async def main():\n"
        f"    m = VisionProcessManager(cfg, root=__import__('pathlib').Path({str(tmp_path)!r}))\n"
        "    async with m.session():\n"
        "        print(m._proc.pid, flush=True)\n"
        "        os._exit(1)\n"   # hard kill with the model loaded
        "asyncio.run(main())\n",
        encoding="utf-8",
    )
    out = subprocess.run([sys.executable, "-I", str(script)], capture_output=True, text=True, timeout=120)
    pid = int(out.stdout.strip().splitlines()[-1])
    import psutil

    deadline = time.time() + 15
    while psutil.pid_exists(pid) and time.time() < deadline:
        time.sleep(0.3)
    assert not psutil.pid_exists(pid), "llama-server outlived the hard-killed Veda"
