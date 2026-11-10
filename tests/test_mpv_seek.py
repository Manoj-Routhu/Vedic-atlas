"""MpvPlayer.seek writes exactly mpv's JSON-IPC seek command, and only to a running player.

Run: pytest tests/test_mpv_seek.py
"""

from __future__ import annotations

import asyncio
import json

from tpa.audio.music_adapters import MpvPlayer


class _Alive:
    """Stands in for the mpv process: still running."""

    def poll(self):
        return None


def _player(sent: list[bytes]) -> MpvPlayer:
    player = MpvPlayer(ipc="test-channel")
    player._send = sent.append   # what would be written to mpv's channel
    return player


def test_seek_sends_an_absolute_seek_in_mpv_json_ipc():
    sent: list[bytes] = []
    player = _player(sent)
    player._proc = _Alive()
    asyncio.run(player.seek(83.5))
    assert len(sent) == 1 and sent[0].endswith(b"\n")
    assert json.loads(sent[0]) == {"command": ["seek", 83.5, "absolute"]}


def test_seek_with_no_player_running_sends_nothing():
    sent: list[bytes] = []
    asyncio.run(_player(sent).seek(10))
    assert sent == []
