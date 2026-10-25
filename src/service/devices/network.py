"""The address a phone should use to reach this machine."""

from __future__ import annotations

import socket


def lan_address() -> str:
    """The IP of the interface that routes to the local network ("127.0.0.1" if there is none).

    A UDP "connect" only picks the outgoing interface; it sends no packet, so nothing leaves the machine.
    """
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
