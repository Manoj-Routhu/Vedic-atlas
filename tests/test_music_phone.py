"""The phone as a music remote: pause / resume with an honest clock, the status snapshot, the /api/music routes, and who
may call them. The sound itself is the device's (mpv); nothing here plays audio.

Run: pytest tests/test_music_phone.py
"""

from __future__ import annotations

import asyncio
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from controller.routes import music as music_route
from domain.entities.music_track import Candidate
from domain.ports.music_ports import MusicError
from domain.policies.device_scope_policy import scope_for
from exceptions.handlers import register_exception_handlers
from service.music.music_service import MusicService


class Gate:
    def __init__(self):
        self.closed = 0

    def pause_capture(self, source):
        self.closed += 1

    def resume_capture(self, source):
        self.closed -= 1


class Player:
    def __init__(self):
        self.is_playing = False
        self.started = []
        self.paused = 0
        self.resumed = 0
        self.fail_pause = False

    async def start(self, url, on_finished):
        self.started.append(url)
        self.is_playing = True

    async def pause(self):
        if self.fail_pause:
            raise RuntimeError("no control channel")
        self.paused += 1

    async def resume(self):
        self.resumed += 1

    async def stop(self):
        self.is_playing = False


class Resolver:
    def __init__(self, hits=None, error=None):
        self.hits = hits if hits is not None else [Candidate("Tum Hi Ho - Arijit Singh", "T-Series", "https://x/1", 262.0)]
        self.error = error

    async def search(self, query):
        if self.error:
            raise self.error
        return self.hits


def make(resolver=None, **kw):
    gate, player = Gate(), Player()
    music = MusicService(resolver or Resolver(), player, gate, **kw)
    return music, player, gate


async def settle(music, state="playing"):
    for _ in range(300):
        if music.status().state == state:
            return
        await asyncio.sleep(0.01)
    raise AssertionError(f"never reached {state}: {music.status()}")


def run(coro_fn):
    async def main():
        return await coro_fn()

    return asyncio.run(main())


# ---- the service --------------------------------------------------------------------------------------------------


def test_status_follows_the_song_from_idle_to_starting_to_playing_and_back():
    async def go():
        music, player, gate = make(max_seconds=300)
        music.start()
        assert music.status().state == "idle" and music.status().title is None
        await music.play("tum hi ho")
        assert music.status().state in ("starting", "playing")
        await settle(music)
        s = music.status()
        assert (s.title, s.limit_s, s.duration_s) == ("Tum Hi Ho - Arijit Singh", 300, 262.0)
        assert s.elapsed_s is not None and s.elapsed_s < 1
        await music.stop("asked")
        assert music.status().state == "idle" and gate.closed == 0

    run(go)


def test_pause_by_user_pauses_the_player_and_the_clock_and_resume_carries_on():
    async def go():
        music, player, _ = make(max_seconds=300)
        music.start()
        await music.play("tum hi ho")
        await settle(music)
        await asyncio.sleep(0.05)
        assert await music.pause_by_user() is True
        assert player.paused == 1 and music.status().state == "paused"
        frozen = music.status().elapsed_s
        await asyncio.sleep(0.1)
        assert music.status().elapsed_s == frozen                    # time spent paused is not counted
        assert await music.resume_by_user() is True
        assert player.resumed == 1 and music.status().state == "playing"
        await asyncio.sleep(0.05)
        assert music.status().elapsed_s > frozen
        await music.stop("asked")

    run(go)


def test_the_time_limit_does_not_run_while_paused():
    async def go():
        music, player, _ = make(max_seconds=0.3)
        music.start()
        await music.play("tum hi ho")
        await settle(music)
        await asyncio.sleep(0.1)
        await music.pause_by_user()
        await asyncio.sleep(0.5)                                      # longer than the whole limit
        assert music.status().state == "paused"
        await music.resume_by_user()
        await asyncio.sleep(0.05)
        assert music.status().state == "playing"                      # about 0.15 s of its 0.3 s are left
        await settle(music, "idle")                                   # and then it does stop by itself

    run(go)


def test_a_reminder_spoken_while_the_user_has_paused_does_not_restart_the_song():
    async def go():
        music, player, _ = make()
        music.start()
        await music.play("tum hi ho")
        await settle(music)
        await music.pause_by_user()
        await music.pause()                                           # a reminder is about to be spoken
        await music.resume()                                          # ... and it is done
        assert player.paused == 1 and player.resumed == 0 and music.status().state == "paused"
        await music.resume_by_user()
        assert player.resumed == 1
        await music.stop("asked")

    run(go)


def test_pause_and_resume_say_no_when_nothing_is_playing_or_the_player_will_not_pause():
    async def go():
        music, player, _ = make()
        music.start()
        assert await music.pause_by_user() is False and await music.resume_by_user() is False
        await music.play("tum hi ho")
        await settle(music)
        player.fail_pause = True
        assert await music.pause_by_user() is False
        assert music.status().state == "playing"                      # it did not pretend
        await music.stop("asked")

    run(go)


def test_stop_forgets_the_pause_so_the_next_song_starts_normally():
    async def go():
        music, player, _ = make()
        music.start()
        await music.play("tum hi ho")
        await settle(music)
        await music.pause_by_user()
        await music.stop("asked")
        await music.play("tum hi ho")
        await settle(music)
        assert music.status().state == "playing"
        await music.stop("asked")

    run(go)


# ---- the routes ---------------------------------------------------------------------------------------------------


@pytest.fixture
def client():
    app = FastAPI()
    register_exception_handlers(app)
    app.include_router(music_route.router, prefix="/api")
    music, player, gate = make()
    app.state.music = music
    app.state.music_off_reason = None
    with TestClient(app) as c:
        c.music, c.player, c.gate, c.app = music, player, gate, app
        yield c


def test_status_when_idle(client):
    r = client.get("/api/music/status")
    assert r.status_code == 200
    assert r.json() == {"available": True, "reason": None, "state": "idle", "title": None, "elapsed_s": None, "limit_s": None, "duration_s": None}


def test_play_names_the_song_it_chose_then_pause_resume_stop(client):
    r = client.post("/api/music/play", json={"query": "tum hi ho"})
    assert r.status_code == 200 and r.json()["title"] == "Tum Hi Ho - Arijit Singh"
    time.sleep(0.1)
    assert client.get("/api/music/status").json()["state"] == "playing"
    assert client.post("/api/music/pause").json()["state"] == "paused"
    assert client.post("/api/music/resume").json()["state"] == "playing"
    assert client.post("/api/music/stop").json()["state"] == "idle"
    assert client.gate.closed == 0                                    # the microphone is back


def test_pause_with_nothing_playing_is_a_409_with_a_plain_message(client):
    r = client.post("/api/music/pause")
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "MUSIC_NOT_PLAYING"


def test_a_song_that_cannot_be_found_is_a_404_whose_message_can_be_shown_as_is(client):
    client.app.state.music = make(Resolver(hits=[]))[0]
    # an empty search result raises the spoken error from pick_track
    r = client.post("/api/music/play", json={"query": "zzzz qqqq"})
    assert r.status_code == 404
    assert r.json()["error"]["message"] == "I couldn't find that song."


def test_a_search_that_fails_is_reported_the_same_way(client):
    client.app.state.music = make(Resolver(error=MusicError("timeout", "I couldn't reach the music search.")))[0]
    r = client.post("/api/music/play", json={"query": "anything"})
    assert r.status_code == 404 and r.json()["error"]["message"] == "I couldn't reach the music search."


def test_an_empty_or_huge_query_is_refused_before_anything_happens(client):
    assert client.post("/api/music/play", json={"query": ""}).status_code == 422
    assert client.post("/api/music/play", json={"query": "x" * 201}).status_code == 422
    assert client.player.started == []


@pytest.mark.parametrize("reason", ["off", "offline", "tools_missing"])
def test_when_music_is_not_available_status_still_answers_and_says_why(client, reason):
    client.app.state.music = None
    client.app.state.music_off_reason = reason
    r = client.get("/api/music/status")
    assert r.status_code == 200 and r.json()["available"] is False and r.json()["reason"] == reason
    r = client.post("/api/music/play", json={"query": "x"})
    assert r.status_code == 503 and r.json()["error"]["code"] == "MUSIC_UNAVAILABLE"   # the app turns this into "music isn't available"
    assert client.post("/api/music/stop").status_code == 503


# ---- who may call them --------------------------------------------------------------------------------------------


@pytest.mark.parametrize("method,path", [
    ("GET", "/api/music/status"), ("POST", "/api/music/play"), ("POST", "/api/music/stop"),
    ("POST", "/api/music/pause"), ("POST", "/api/music/resume"),
])
def test_only_a_phone_with_the_control_permission_may_use_music(method, path):
    assert scope_for(method, path) == "control"


def test_unknown_music_routes_are_not_open_to_phones():
    assert scope_for("POST", "/api/music/volume") is None
    assert scope_for("DELETE", "/api/music/stop") is None
