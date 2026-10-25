"""A Windows Job Object that kills its processes when Veda exits, however Veda exits.

Without it, a hard-killed Veda (Task Manager, crash) would leave `llama-server` running with ~2.5 GB loaded.
The job holds the child; when the last handle to the job closes - which Windows does itself when Veda's process
ends - Windows kills everything in it. Linux has no equivalent here: the pidfile sweep at the next start covers it.
"""

from __future__ import annotations

import sys

from core.logging_config import logger

_JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
_JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
_PROCESS_SET_QUOTA = 0x0100
_PROCESS_TERMINATE = 0x0001


class KillOnCloseJob:
    """Wraps one job handle. `assign(pid)` puts a process in it. Keep the object alive as long as Veda runs."""

    def __init__(self, kernel32, handle):
        self._k = kernel32
        self._handle = handle

    def assign(self, pid: int) -> bool:
        process = self._k.OpenProcess(_PROCESS_SET_QUOTA | _PROCESS_TERMINATE, False, pid)
        if not process:
            return False
        try:
            return bool(self._k.AssignProcessToJobObject(self._handle, process))
        finally:
            self._k.CloseHandle(process)

    def close(self) -> None:
        """Close the handle now (this kills the processes in the job). Normally Windows does this at exit."""
        if self._handle:
            self._k.CloseHandle(self._handle)
            self._handle = None


def create_kill_on_close_job() -> KillOnCloseJob | None:
    """A new job, or None on any failure or off Windows (the caller carries on without it)."""
    if sys.platform != "win32":
        return None
    try:
        import ctypes
        from ctypes import wintypes

        class IO_COUNTERS(ctypes.Structure):
            _fields_ = [(n, ctypes.c_ulonglong) for n in (
                "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

        class BASIC_LIMITS(ctypes.Structure):
            _fields_ = [
                ("PerProcessUserTimeLimit", ctypes.c_longlong), ("PerJobUserTimeLimit", ctypes.c_longlong),
                ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD),
            ]

        class EXTENDED_LIMITS(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", BASIC_LIMITS), ("IoInfo", IO_COUNTERS),
                ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t),
            ]

        k = ctypes.WinDLL("kernel32", use_last_error=True)
        k.CreateJobObjectW.restype = wintypes.HANDLE
        k.CreateJobObjectW.argtypes = [wintypes.LPVOID, wintypes.LPCWSTR]
        k.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD]
        k.OpenProcess.restype = wintypes.HANDLE
        k.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        k.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        k.CloseHandle.argtypes = [wintypes.HANDLE]

        handle = k.CreateJobObjectW(None, None)
        if not handle:
            return None
        info = EXTENDED_LIMITS()
        info.BasicLimitInformation.LimitFlags = _JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not k.SetInformationJobObject(handle, _JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, ctypes.byref(info), ctypes.sizeof(info)):
            k.CloseHandle(handle)
            return None
        return KillOnCloseJob(k, handle)
    except Exception as e:
        logger.warning(f"[vision] could not create the kill-on-exit job ({type(e).__name__}); the pidfile sweep still cleans up")
        return None
