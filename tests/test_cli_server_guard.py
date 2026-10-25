"""`veda server` must not start a second server: each one would load every model into memory again."""

from __future__ import annotations

import socket

from controller.cli import server


def _listening() -> tuple[socket.socket, int]:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    sock.listen()
    return sock, sock.getsockname()[1]


def test_a_port_with_a_listener_is_in_use():
    sock, port = _listening()
    try:
        assert server.port_in_use(port) is True
    finally:
        sock.close()


def test_a_free_port_is_not_in_use():
    sock, port = _listening()
    sock.close()
    assert server.port_in_use(port) is False


def test_a_second_server_is_refused_before_anything_starts(monkeypatch):
    sock, port = _listening()
    started: list[object] = []
    monkeypatch.setattr(server.uvicorn, "run", lambda *a, **k: started.append((a, k)))
    try:
        assert server.cmd_server(port=port, host="0.0.0.0") == 1
    finally:
        sock.close()
    assert started == []


def test_a_free_port_starts_the_server(monkeypatch):
    sock, port = _listening()
    sock.close()
    started: list[object] = []
    monkeypatch.setattr(server.uvicorn, "run", lambda *a, **k: started.append((a, k)))
    assert server.cmd_server(port=port, host="127.0.0.1") == 0
    assert len(started) == 1
