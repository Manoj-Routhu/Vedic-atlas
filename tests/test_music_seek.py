"""Jumping around in a song from the phone: the clock rules (position moves, time listened does not), the stop timer after a
jump, which songs can be jumped in, and POST /api/music/seek.

Run: pytest tests/test_music_seek.py
"""

from __future__ import annotations

import asyncio

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from controller.routes import music as music_route
from domain.entities.music_track import Candidate
from domain.ports.music_ports import MusicError
from exceptions.handlers import register_exception_handlers
from test_music_phone import Resolver, make, run, settle

LIVE = [Candidate("Live radio", "", "https://x/live", None)]


async def playing(resolver=None, **kw):
    music, player, gate = make(resolver, **kw)
    music.start()
    await music.play("tum hi ho")
    await settle(music)
    return music, player, gate


def test_a_seek_moves_the_position_and_it_keeps_counting_from_there():
    async def go():
        music, player, _ = await playing(max_seconds=300)
        assert await music.seek(120) is True
        assert player.seeks == [120]
        first = music.status().elapsed_s
        assert 120 <= first < 121
        await asyncio.sleep(0.1)
        assert music.status().elapsed_s > first
        await music.stop("asked")

    run(go)


def test_the_target_is_clamped_to_the_song_and_the_very_end_is_two_seconds_short_of_the_stop_point():
    async def go():
        music, player, _ = await playing(max_seconds=300)   # 262 s long, stops at 277
        await music.seek(-50)
        await music.seek(10_000)
        assert player.seeks == [0.0, 260.0]                 # the song's own length minus 2 s
        await music.stop("asked")

    run(go)


def test_a_song_cut_by_the_ceiling_cannot_be_jumped_past_the_ceiling():
    async def go():
        music, player, _ = await playing(max_seconds=100, max_song_seconds=100)   # 262 s song, stops at 100
        await music.seek(5_000)
        assert player.seeks == [98.0]
        await music.stop("asked")

    run(go)


def test_the_time_listened_does_not_rewind_but_the_position_does():
    async def go():
        music, _, _ = await playing(max_seconds=300)
        await music.seek(200)
        await asyncio.sleep(0.1)
        await music.seek(10)
        assert music._played_before >= 0.05                         # still counted (Windows' clock is coarse)
        assert music.status().elapsed_s < 11                        # but the song is back near the start
        await music.stop("asked")

    run(go)


def test_jumping_back_does_not_cut_the_song_short_and_the_stop_timer_follows_the_new_place():
    async def go():
        music, _, _ = await playing(max_seconds=300)
        loop = asyncio.get_running_loop()
        await music.seek(200)
        assert music._limit.when() - loop.time() == pytest.approx(277 - 200, abs=1)   # 77 s to its end
        await music.seek(0)
        assert music._limit.when() - loop.time() == pytest.approx(277, abs=1)         # the whole song again
        await music.stop("asked")

    run(go)


def test_jumping_around_cannot_run_past_the_cap_on_time_listened():
    async def go():
        music, _, _ = await playing(max_seconds=100, max_song_seconds=270)   # cap 270 s listened; the song's end is at 270 too
        await asyncio.sleep(0.3)
        await music.seek(0)                                         # back to the start after 0.3 s listened
        remaining = music._limit.when() - asyncio.get_running_loop().time()
        assert remaining == pytest.approx(270 - 0.3, abs=0.2)       # the cap on listening wins over the 270 s to the end
        await music.stop("asked")

    run(go)


def test_a_seek_while_paused_moves_the_position_and_keeps_the_clock_and_timer_stopped():
    async def go():
        music, player, _ = await playing(max_seconds=300)
        await music.pause_by_user()
        assert await music.seek(100) is True
        assert music._limit is None and music.status().state == "paused"
        frozen = music.status().elapsed_s
        assert frozen == 100
        await asyncio.sleep(0.1)
        assert music.status().elapsed_s == frozen
        await music.resume_by_user()
        await asyncio.sleep(0.05)
        assert music.status().elapsed_s > 100 and music._limit is not None
        await music.stop("asked")

    run(go)


def test_a_song_of_unknown_length_cannot_be_jumped_in():
    async def go():
        music, player, _ = await playing(Resolver(LIVE), max_seconds=300)
        assert music.status().seekable is False
        assert await music.seek(30) is False and player.seeks == []
        await music.stop("asked")

    run(go)


def test_nothing_to_jump_in_when_idle_or_still_starting():
    async def go():
        music, player, _ = make()
        music.start()
        assert await music.seek(10) is False
        await music.play("tum hi ho")
        if music.status().state == "starting":
            assert music.status().seekable is False and await music.seek(10) is False
        await music.stop("asked")
        assert player.seeks == []

    run(go)


def test_a_player_that_will_not_jump_raises_a_sentence_for_the_screen_and_leaves_the_position_alone():
    async def go():
        music, player, _ = await playing(max_seconds=300)
        player.fail_seek = True
        await asyncio.sleep(0.05)
        before = music.status().elapsed_s
        with pytest.raises(MusicError) as e:
            await music.seek(100)
        assert e.value.spoken == "Couldn't jump just now. Try again."
        assert music.status().elapsed_s - before < 1
        await music.stop("asked")

    run(go)


def test_status_says_when_a_song_can_be_jumped_in():
    async def go():
        music, _, _ = await playing(max_seconds=300)
        assert music.status().seekable is True
        await music.pause_by_user()
        assert music.status().seekable is True
        await music.stop("asked")
        assert music.status().seekable is False

    run(go)


# ---- the route ----------------------------------------------------------------------------------------------------


def _app(music):
    app = FastAPI()
    register_exception_handlers(app)
    app.include_router(music_route.router, prefix="/api")
    app.state.music, app.state.music_off_reason = music, None
    return app


def _play(client):
    assert client.post("/api/music/play", json={"query": "tum hi ho"}).status_code == 200
    for _ in range(300):
        if client.get("/api/music/status").json()["state"] == "playing":
            return
        asyncio.run(asyncio.sleep(0.01))
    raise AssertionError("never playing")


@pytest.fixture
def client():
    music, player, _ = make(max_seconds=300)
    with TestClient(_app(music)) as c:
        c.player = player
        yield c


def test_seek_moves_the_song_and_answers_with_the_new_status(client):
    _play(client)
    r = client.post("/api/music/seek", json={"position_s": 90})
    assert r.status_code == 200
    body = r.json()
    assert body["state"] == "playing" and body["seekable"] is True and 90 <= body["elapsed_s"] < 92
    assert client.player.seeks == [90]


def test_seek_with_nothing_playing_is_a_409_in_plain_words(client):
    r = client.post("/api/music/seek", json={"position_s": 10})
    assert r.status_code == 409 and r.json()["error"]["code"] == "MUSIC_NOT_PLAYING"


def test_seek_in_a_song_of_unknown_length_is_a_409_that_says_so():
    music, player, _ = make(Resolver(LIVE), max_seconds=300)
    with TestClient(_app(music)) as c:
        _play(c)
        r = c.post("/api/music/seek", json={"position_s": 10})
        assert r.status_code == 409 and r.json()["error"]["code"] == "MUSIC_NOT_SEEKABLE"
        assert player.seeks == []


def test_a_player_that_balks_is_a_502_with_a_sentence_for_the_screen(client):
    _play(client)
    client.player.fail_seek = True
    r = client.post("/api/music/seek", json={"position_s": 10})
    assert r.status_code == 502
    assert r.json()["error"]["code"] == "MUSIC_SEEK_FAILED"
    assert r.json()["error"]["message"] == "Couldn't jump just now. Try again."


@pytest.mark.parametrize("raw", ['{}', '{"position_s": -1}', '{"position_s": "soon"}', '{"position_s": 1e9}', '{"position_s": null}', '{"position_s": NaN}'])
def test_bad_positions_are_refused_before_anything_happens(client, raw):
    _play(client)
    r = client.post("/api/music/seek", content=raw, headers={"Content-Type": "application/json"})
    assert r.status_code == 422
    assert client.player.seeks == []


def test_seek_is_refused_when_music_is_unavailable():
    app = FastAPI()
    register_exception_handlers(app)
    app.include_router(music_route.router, prefix="/api")
    app.state.music, app.state.music_off_reason = None, "offline"
    assert TestClient(app).post("/api/music/seek", json={"position_s": 5}).status_code == 503
