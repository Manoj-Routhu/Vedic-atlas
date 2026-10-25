"""Every subcommand must be run as a command, not sent to Veda as a chat message (`veda pair` once was)."""

from __future__ import annotations

import pytest

from controller.cli import __main__ as cli


def test_every_registered_subcommand_is_recognised():
    names = cli._subcommand_names(cli._build_parser())
    assert {"pair", "devices", "server", "approve", "login"} <= names


@pytest.mark.parametrize("command", ["pair", "devices"])
def test_phone_commands_run_their_handler_instead_of_chatting(monkeypatch, command):
    called: dict[str, object] = {}
    monkeypatch.setattr(cli, "_handle_default_chat", lambda ns, text: called.setdefault("chat", text) and 0)
    handler = "_handle_pair" if command == "pair" else "_handle_devices"

    def fake(args):
        called["handler"] = command
        return 0

    parser_builder = cli._build_parser

    def build():
        parser = parser_builder()
        for action in parser._actions:
            if hasattr(action, "choices") and isinstance(action.choices, dict) and command in action.choices:
                action.choices[command].set_defaults(func=fake)
        return parser

    monkeypatch.setattr(cli, "_build_parser", build)
    assert cli.main([command]) == 0
    assert called == {"handler": command}, f"{handler} was not used"
