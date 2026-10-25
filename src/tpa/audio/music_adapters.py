"""Music adapters: yt-dlp finds the song, mpv plays it (docs/13). Works on Linux (the Pi) and on Windows.

⚠ Egress exception. yt-dlp and mpv open their own connections to YouTube, so they do NOT pass through
AllowListedHttpClient or the egress allow-list (REQ-M-06/M-09). This is deliberate and switchable: nothing here is
built unless `music.enabled` is true in config/music.yaml and `privacy.online.enabled` is true. No user data is sent
beyond the search words. Like the `terminal` and `file_ops` skills, it is documented here and in config/music.yaml.

The two programs are installed on the device (mpv from apt / winget by the setup scripts, yt-dlp by `pip install -e .`),
never imported.
Both are run with plain `subprocess` (in a worker thread), not asyncio subprocesses, so they work whichever event loop
the server runs on.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Callable

from core.logging_config import logger
from domain.entities.music_track import Candidate
from domain.ports.music_ports import MusicError

_NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0   # no console flashing up for each child process


def _windows_install_dirs(name: str) -> list[Path]:
    """Where Windows installers put mpv without adding it to PATH. Only mpv has well-known folders."""
    if name.lower() not in ("mpv", "mpv.exe"):
        return []
    roots = [os.environ.get(v) for v in ("ProgramFiles", "ProgramFiles(x86)")]
    local = os.environ.get("LOCALAPPDATA")
    dirs = [Path(r) / sub for r in roots if r for sub in ("MPV Player", "mpv")]
    if local:
        dirs += [Path(local) / "Programs" / "mpv", Path(local) / "Microsoft" / "WinGet" / "Links"]
    return dirs


def find_program(name: str) -> str | None:
    """The program on PATH, next to this Python (a venv's Scripts/bin folder, where `pip install yt-dlp` puts it), or in
    mpv's usual Windows install folders. A full path given in config is returned as is when it exists."""
    found = shutil.which(name)
    if found:
        return found
    beside = Path(sys.executable).parent
    for candidate in (name, f"{name}.exe"):
        if (beside / candidate).exists():
            return str(beside / candidate)
    if sys.platform == "win32":
        for folder in _windows_install_dirs(name):
            if (folder / "mpv.exe").exists():
                return str(folder / "mpv.exe")
    return None


def ipc_address(pid: int, platform: str | None = None) -> str:
    """Where mpv's control channel lives: a named pipe on Windows, a Unix socket elsewhere."""
    if (platform or sys.platform) == "win32":
        return rf"\\.\pipe\veda-mpv-{pid}"
    return str(Path(tempfile.gettempdir()) / f"veda-mpv-{pid}.sock")


class YtDlpResolver:
    """`yt-dlp --flat-playlist --dump-json ytsearchN:<query>`: the top N hits as metadata only (about 2 s)."""

    def __init__(self, ytdlp_path: str = "yt-dlp", results: int = 5, timeout_sec: float = 12.0):
        self._path, self._results, self._timeout = ytdlp_path, max(1, results), timeout_sec

    def command(self, query: str) -> list[str]:
        # "--" then ONE argument that starts with "ytsearchN:": the query can never be read as an option.
        return [find_program(self._path) or self._path, "--ignore-config", "--no-warnings", "--no-playlist",
                "--flat-playlist", "--dump-json", "--", f"ytsearch{self._results}:{query}"]

    def _run(self, query: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            self.command(query), stdin=subprocess.DEVNULL, capture_output=True, timeout=self._timeout,
            creationflags=_NO_WINDOW,
        )

    async def search(self, query: str) -> list[Candidate]:
        try:
            done = await asyncio.to_thread(self._run, query)
        except FileNotFoundError:
            raise MusicError("yt-dlp not installed", "I can't play music yet because it isn't set up.")
        except subprocess.TimeoutExpired:
            raise MusicError("yt-dlp timed out", "I couldn't search for music right now.")
        if done.returncode != 0:
            logger.warning(f"[music] yt-dlp failed ({done.returncode}): {done.stderr.decode('utf-8', 'replace')[:200]!r}")
            raise MusicError("yt-dlp failed", "I couldn't search for music right now.")
        return parse_results(done.stdout.decode("utf-8", "replace"))


def parse_results(text: str) -> list[Candidate]:
    """One JSON object per line. Live streams and premieres are not songs; anything unparseable is skipped."""
    out: list[Candidate] = []
    for line in text.splitlines():
        try:
            d = json.loads(line)
        except ValueError:
            continue
        if not isinstance(d, dict) or d.get("live_status") in ("is_live", "is_upcoming"):
            continue
        url = d.get("webpage_url") or d.get("url") or (f"https://www.youtube.com/watch?v={d['id']}" if d.get("id") else "")
        duration = d.get("duration")
        out.append(Candidate(
            title=str(d.get("title") or ""), channel=str(d.get("channel") or d.get("uploader") or ""), url=str(url),
            duration_sec=float(duration) if isinstance(duration, (int, float)) else None,
        ))
    return out


class MpvPlayer:
    """mpv started per song and controlled over its JSON IPC channel. Stopping terminates the process."""

    def __init__(self, mpv_path: str = "mpv", ytdlp_path: str = "yt-dlp", ipc: str | None = None):
        self._mpv, self._ytdlp = mpv_path, ytdlp_path
        self._ipc = ipc or ipc_address(os.getpid())
        self._proc: subprocess.Popen | None = None

    @property
    def is_playing(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    def command(self, url: str) -> list[str]:
        argv = [find_program(self._mpv) or self._mpv, "--no-video", "--no-terminal", "--really-quiet", "--idle=no",
                "--force-window=no", "--ytdl=yes", "--ytdl-format=bestaudio/best", f"--input-ipc-server={self._ipc}"]
        ytdlp = find_program(self._ytdlp)
        if ytdlp:   # mpv looks yt-dlp up on PATH; a venv's copy may not be there
            argv.append(f"--script-opts=ytdl_hook-ytdl_path={ytdlp}")
        return argv + ["--", url]

    async def start(self, url: str, on_finished: Callable[[], None]) -> None:
        await self.stop()
        try:
            proc = subprocess.Popen(
                self.command(url), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                creationflags=_NO_WINDOW,
            )
        except FileNotFoundError:
            raise MusicError("mpv not installed", "I can't play music yet because it isn't set up.")
        self._proc = proc

        def watch() -> None:   # a thread: tells the service when the song ends by itself or is stopped
            proc.wait()
            try:
                on_finished()
            except Exception as e:
                logger.warning(f"[music] finish callback failed: {type(e).__name__}")

        threading.Thread(target=watch, name="MpvWatch", daemon=True).start()

    def _send(self, payload: bytes) -> None:
        """Write one command to mpv's IPC channel; mpv creates it a moment after it starts, so retry briefly."""
        deadline = time.monotonic() + 3.0
        while True:
            try:
                if sys.platform == "win32":
                    with open(self._ipc, "r+b", buffering=0) as pipe:
                        pipe.write(payload)
                else:
                    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
                        s.settimeout(2.0)
                        s.connect(self._ipc)
                        s.sendall(payload)
                return
            except OSError:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(0.1)

    async def _command(self, *cmd) -> None:
        if self.is_playing:
            await asyncio.to_thread(self._send, (json.dumps({"command": list(cmd)}) + "\n").encode())

    async def pause(self) -> None:
        await self._command("set_property", "pause", True)

    async def resume(self) -> None:
        await self._command("set_property", "pause", False)

    async def stop(self) -> None:
        proc, self._proc = self._proc, None
        if proc is not None and proc.poll() is None:
            proc.terminate()
            try:
                await asyncio.to_thread(proc.wait, 2.0)
            except subprocess.TimeoutExpired:
                proc.kill()
        if sys.platform != "win32":
            try:
                os.unlink(self._ipc)
            except OSError:
                pass
