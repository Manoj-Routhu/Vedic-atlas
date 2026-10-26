"""`veda server` subcommand — runs the FastAPI app via uvicorn.

Donor: veda/cli/server.py, adapted to the new composition root
(`bootstrap.app:app` instead of `veda.app:app`) and config split
(`core.config.load_full_config().app.port` instead of `veda.config.load_config().port`).
"""

from __future__ import annotations

import os
import socket

import uvicorn

from controller.cli.client import register_server
from core.config import load_full_config
from core.constants import PROJECT_NAME, VERSION
from core.logging_config import logger


def _listener_description(port: int) -> str:
    """Who is listening on `port`, in words ("process 1234 (python.exe)"), or a generic phrase when that cannot be found."""
    try:
        import psutil

        for conn in psutil.net_connections(kind="inet"):
            if conn.status == psutil.CONN_LISTEN and conn.laddr and conn.laddr.port == port and conn.pid:
                return f"process {conn.pid} ({psutil.Process(conn.pid).name()})"
    except Exception:  # noqa: BLE001 - only used to make the message more helpful
        pass
    return "another program"


def port_in_use(port: int) -> bool:
    """True when something already accepts connections on this machine at `port`.

    Connecting is used rather than trying to bind: on Windows a second server can bind 0.0.0.0 while 127.0.0.1 is taken,
    and then the phone and the terminal end up talking to two different servers.
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(0.5)
        return probe.connect_ex(("127.0.0.1", port)) == 0


def cmd_server(*, port: int | None = None, host: str = "127.0.0.1") -> int:
    cfg = load_full_config()
    use_port = port or cfg.app.port
    if port_in_use(use_port):
        # Refuse before any model is loaded: a second server would hold its own copy of every model in memory.
        logger.error(
            f"Veda is already running on port {use_port} ({_listener_description(use_port)}). "
            f"Not starting a second one: it would load every model again. Stop that one first, or use its address."
        )
        return 1
    register_server(use_port)   # so a `veda` typed while the models load waits for this server instead of starting another
    logger.info(f"{PROJECT_NAME} v{VERSION} - Personal AI Assistant")
    logger.info(f"Starting on http://{host}:{use_port}")
    if host not in ("127.0.0.1", "localhost", "::1"):
        logger.warning("Listening beyond this machine: only paired phones (`veda pair`) are let in; the API is not open")
    os.environ["VEDA_BIND_HOST"] = host   # read by /api/devices/pairing-code so `veda pair` can warn when nothing can reach us
    uvicorn.run("bootstrap.app:app", host=host, port=use_port, log_level="warning", reload=False, access_log=False)
    return 0