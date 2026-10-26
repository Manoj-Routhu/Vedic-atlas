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


def test_a_server_started_by_the_cli_listens_for_phones_only_when_lan_is_enabled(monkeypatch):
    from controller.cli.client import VedaClient
    from core import config as core_config

    client = VedaClient.__new__(VedaClient)
    client.server_url = "http://127.0.0.1:8000"

    class _Devices:
        lan_enabled = False

    class _Cfg:
        devices = _Devices()

    monkeypatch.setattr(core_config, "load_full_config", lambda: _Cfg())
    assert client._bind_host() == "127.0.0.1"
    _Devices.lan_enabled = True
    assert client._bind_host() == "0.0.0.0"


def test_a_server_that_is_loading_leaves_a_marker_so_veda_waits_instead_of_starting_another(monkeypatch, tmp_path):
    import os

    from controller.cli import client as client_module

    monkeypatch.setattr(client_module, "_pid_file", lambda port: tmp_path / f"veda-server-{port}.pid")
    cleanups: list[object] = []
    monkeypatch.setattr(client_module.atexit, "register", lambda fn: cleanups.append(fn))
    seen_while_starting: list[str] = []

    def fake_run(*a, **k):
        seen_while_starting.append((tmp_path / "veda-server-8123.pid").read_text())

    monkeypatch.setattr(server.uvicorn, "run", fake_run)
    assert server.cmd_server(port=8123, host="0.0.0.0") == 0
    assert seen_while_starting == [str(os.getpid())]          # in place before the models load
    assert (tmp_path / "veda-server-8123.pid").exists()
    cleanups[0]()                                              # what happens when the process exits
    assert not (tmp_path / "veda-server-8123.pid").exists()


def test_the_marker_of_another_server_is_not_removed_on_exit(monkeypatch, tmp_path):
    from controller.cli import client as client_module

    path = tmp_path / "veda-server-8124.pid"
    monkeypatch.setattr(client_module, "_pid_file", lambda port: path)
    cleanups: list[object] = []
    monkeypatch.setattr(client_module.atexit, "register", lambda fn: cleanups.append(fn))
    client_module.register_server(8124)
    path.write_text("999999")                                  # a newer server has taken over the marker
    cleanups[0]()
    assert path.read_text() == "999999"
