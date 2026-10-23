"""OS-specific system control and desktop notifier."""

from __future__ import annotations

import platform

_IS_WINDOWS = platform.system() == "Windows"


def build_system_control():
    if _IS_WINDOWS:
        from tpa.system.windows_system_adapter import WindowsSystemAdapter
        return WindowsSystemAdapter()
    from tpa.system.linux_system_adapter import LinuxSystemAdapter
    return LinuxSystemAdapter()


def build_notifier():
    """Best-effort desktop notifier. `None` (no notifications) on any other platform."""
    if not _IS_WINDOWS:
        return None
    from tpa.notifications.desktop_notifier import DesktopNotifier
    return DesktopNotifier()
