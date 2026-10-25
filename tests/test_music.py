"""Music (docs/13): choosing the song, the service that keeps the mic and the music apart, the tool, the adapters' commands.

No mpv, no yt-dlp, no model: a fake player and a fake search, but the REAL CaptureGate, so the mic/music contract is the
actual one (play closes the mic; mute or unmute, the end of the song, the time limit and a stop all let go of it)."""

import asyncio
from datetime import datetime, timezone

import pytest

from domain.entities.agent_context import AgentContext
from domain.entities.music_track import Candidate
from domain.events.capture_event import CaptureEvent
from domain.policies import music_policy as mp
from domain.ports.music_ports import MusicError
from service.music.music_service import MusicAwareSpeaker, MusicService
from service.privacy.capture_gate import CaptureGate
from service.skills.builtin.music import MusicSkill
from tpa.audio.music_adapters import MpvPlayer, YtDlpResolver, parse_results
from tpa.filestore.yaml_tool_manifest_store import YamlToolManifestStore

MANIFEST = next(m for m in YamlToolManifestStore().load_all() if m.name == "music_control")


def hit(title, channel="", url=None, duration=240.0):
    return Candidate(title, channel, url or f"https://yt/{title}", duration)


# ---- which hit is the song -----------------------------------------------------------------------------------------------

def test_the_hit_that_matches_the_words_wins_over_a_better_ranked_one_that_does_not():
    hits = [hit("Tum Hi Bata Do"), hit("Tum Hi Ho (Official Video) - Arijit Singh | Aashiqui 2"), hit("Tum Hi Ho karaoke")]
    track = mp.pick_track("Tum Hi Ho", hits)
    assert track.title == "Tum Hi Ho - Arijit Singh, Aashiqui 2" and track.url.startswith("https://yt/Tum Hi Ho (Official")


def test_karaoke_and_covers_lose_unless_the_request_asks_for_them_and_the_top_hit_wins_ties():
    assert mp.pick_track("Believer", [hit("Believer karaoke"), hit("Believer - Imagine Dragons")]).title == "Believer - Imagine Dragons"
    assert mp.pick_track("Believer karaoke", [hit("Believer - Imagine Dragons"), hit("Believer karaoke")]).title == "Believer karaoke"
    same = [hit("Song A"), hit("Song A")]
    assert mp.pick_track("song a", same).url == same[0].url


def test_nothing_matching_still_plays_the_top_hit_and_non_songs_are_skipped_when_a_song_exists():
    assert mp.pick_track("zzz qqq", [hit("Alpha"), hit("Beta")]).title == "Alpha"
    hour_mix = hit("Tum Hi Ho 1 hour mix", duration=3600)
    assert mp.pick_track("Tum Hi Ho", [hour_mix, hit("Tum Hi Ho")]).url == "https://yt/Tum Hi Ho"
    assert mp.pick_track("x", [hit("only", duration=3600)]).title == "only"      # nothing better: it is still the top hit
    assert mp.pick_track("x", []) is None and mp.pick_track("x", [Candidate("t", "c", "", 100)]) is None


def test_the_query_is_one_bounded_clean_line():
    assert mp.clean_query("  play\nthe song \x00 Tum   Hi Ho ") == "play the song Tum Hi Ho"
    assert len(mp.clean_query("a" * 500)) <= mp.MAX_QUERY_CHARS


# ---- the service, with the real gate -------------------------------------------------------------------------------------------

class Switch:
    source_name = "test"

    def __init__(self):
        self.muted, self.callback = False, None

    def subscribe(self, cb):
        self.callback = cb

    def is_muted(self):
        return self.muted

    def sync_state(self, muted):
        self.muted = muted


class Audio:
    def __init__(self):
        self.live = False

    def start(self):
        self.live = True

    def stop(self):
        self.live = False


class Resolver:
    def __init__(self, hits):
        self.hits, self.queries = hits, []

    async def search(self, query):
        self.queries.append(query)
        if isinstance(self.hits, Exception):
            raise self.hits
        return self.hits


class Player:
    def __init__(self):
        self.started, self.paused, self.resumed, self.stops, self.finish = [], 0, 0, 0, None
        self.is_playing = False

    async def start(self, url, on_finished):
        self.started.append(url)
        self.finish, self.is_playing = on_finished, True

    async def pause(self):
        self.paused += 1

    async def resume(self):
        self.resumed += 1

    async def stop(self):
        self.stops += 1
        self.is_playing = False


def rig(hits=None, **kw):
    switch, audio = Switch(), Audio()
    gate = CaptureGate(switch, audio=audio)
    gate.start()
    player = Player()
    resolver = Resolver(hits if hits is not None else [hit("Tum Hi Ho - Arijit Singh")])
    music = MusicService(resolver, player, gate, poll_sec=0.01, quiet_for_sec=0.03, **kw)
    gate.add_mute_listener(music.on_mute_change)
    return switch, audio, gate, player, resolver, music


def run(coro_fn):
    async def main():
        return await coro_fn()
    return asyncio.run(main())


async def settle(player, n=1):
    for _ in range(300):
        if len(player.started) >= n:
            return
        await asyncio.sleep(0.01)
    raise AssertionError("the song never started")


def test_play_closes_the_mic_starts_the_song_and_the_end_of_the_song_reopens_the_mic():
    switch, audio, gate, player, resolver, music = rig()

    async def go():
        music.start()
        track = await music.play("Tum Hi Ho")
        assert track.title == "Tum Hi Ho - Arijit Singh" and not audio.live and music.active
        await settle(player)
        assert music.is_playing and not audio.live
        player.finish()                                  # the song ends by itself
        await asyncio.sleep(0.05)
        assert not music.active and audio.live

    run(go)


def test_mute_stops_the_song_keeps_the_mic_closed_and_unmute_only_reopens_the_mic():
    switch, audio, gate, player, resolver, music = rig()

    async def go():
        music.start()
        await music.play("x")
        await settle(player)
        gate.set_muted(True, source="api")               # /mute, or the physical switch
        await asyncio.sleep(0.05)
        assert not music.active and player.stops >= 1 and not audio.live and gate.is_muted()
        gate.set_muted(False, source="api")              # /unmute
        assert audio.live and not music.active and len(player.started) == 1   # the song is gone, the mic is back

    run(go)


def test_the_physical_switch_reports_from_another_thread_and_still_stops_the_song():
    switch, audio, gate, player, resolver, music = rig()

    async def go():
        music.start()
        await music.play("x")
        await settle(player)
        await asyncio.to_thread(switch.callback, CaptureEvent(
            muted=True, previous_muted=False, source="gpio", changed_at=datetime.now(timezone.utc)))
        await asyncio.sleep(0.05)
        assert not music.active and not audio.live

    run(go)


def test_unmuting_while_a_song_plays_stops_it_too():
    switch, audio, gate, player, resolver, music = rig()

    async def go():
        music.start()
        gate.set_muted(True, source="api")               # typed "play X" at a muted mic
        await music.play("x")
        await settle(player)
        gate.set_muted(False, source="api")
        await asyncio.sleep(0.05)
        assert not music.active and audio.live

    run(go)


def test_the_end_of_a_voice_turn_cannot_reopen_the_mic_while_the_song_plays():
    switch, audio, gate, player, resolver, music = rig()

    async def go():
        music.start()
        gate.pause_capture("voice_turn:1")               # "Hey Veda, play X": the turn is running
        await music.play("x")
        assert gate.resume_capture("voice_turn:1") is False    # the turn ends
        await settle(player)
        assert not audio.live
        await music.stop("asked")
        assert audio.live

    run(go)


def test_the_time_limit_stops_the_song_and_reopens_the_mic():
    switch, audio, gate, player, resolver, music = rig(max_seconds=0.15)

    async def go():
        music.start()
        await music.play("x")
        await settle(player)
        await asyncio.sleep(0.3)
        assert not music.active and audio.live and player.stops >= 1

    run(go)


def test_the_song_waits_until_veda_has_stopped_talking_and_a_new_request_replaces_the_old_song():
    busy = {"on": True}
    switch, audio, gate, player, resolver, music = rig(is_busy=lambda: busy["on"])

    async def go():
        music.start()
        await music.play("first")
        await asyncio.sleep(0.15)
        assert player.started == []                      # "Playing ..." is still being spoken
        busy["on"] = False
        await settle(player)
        busy["on"] = False
        await music.play("second")                       # replaces
        await settle(player, 2)
        assert len(player.started) == 2 and player.stops >= 1 and music.is_playing and not audio.live

    run(go)


def test_a_failed_search_or_no_result_raises_a_spoken_error_and_leaves_the_mic_alone():
    for hits, spoken in ((MusicError("down", "I couldn't search for music right now."), "I couldn't search for music right now."),
                         ([], "I couldn't find that song.")):
        switch, audio, gate, player, resolver, music = rig(hits)

        async def go():
            music.start()
            with pytest.raises(MusicError) as e:
                await music.play("x")
            assert e.value.spoken == spoken and not music.active and audio.live

        run(go)
    switch, audio, gate, player, resolver, music = rig()

    async def empty():
        with pytest.raises(MusicError):
            await music.play("   ")

    run(empty)


def test_a_player_that_cannot_start_releases_the_mic():
    switch, audio, gate, player, resolver, music = rig()

    async def broken(url, on_finished):
        raise MusicError("mpv missing", "I can't play music yet because it isn't set up.")

    player.start = broken

    async def go():
        music.start()
        await music.play("x")
        await asyncio.sleep(0.2)
        assert not music.active and audio.live

    run(go)


def test_a_reminder_pauses_the_song_while_it_is_spoken_and_then_resumes_it():
    switch, audio, gate, player, resolver, music = rig()

    class Speaker:
        def __init__(self):
            self.said = []

        def available(self):
            return True

        def is_busy(self):
            return False

        async def announce(self, text):
            self.said.append((text, player.paused, player.resumed))
            return True

    inner = Speaker()

    async def go():
        music.start()
        speaker = MusicAwareSpeaker(inner, music)
        assert await speaker.announce("no music yet") is True and player.paused == 0
        await music.play("x")
        await settle(player)
        assert await speaker.announce("Reminder: call mum is due now.") is True
        assert inner.said[-1] == ("Reminder: call mum is due now.", 1, 0) and player.resumed == 1

    run(go)


# ---- the tool ------------------------------------------------------------------------------------------------------------------

def test_the_tool_plays_names_the_song_and_stops():
    switch, audio, gate, player, resolver, music = rig()
    skill = MusicSkill(MANIFEST, music)

    async def go():
        music.start()
        r = await skill.execute(AgentContext(user_message="x"), action="play", query="Tum Hi Ho")
        assert r.success and r.metadata["spoken"] == "Playing Tum Hi Ho - Arijit Singh."
        r = await skill.execute(AgentContext(user_message="x"), action="stop")
        assert r.success and r.metadata["spoken"] == "Stopped the music."
        r = await skill.execute(AgentContext(user_message="x"), action="stop")
        assert r.metadata["spoken"] == "Nothing is playing."
        r = await skill.execute(AgentContext(user_message="x"), action="play", query="")
        assert not r.success and r.metadata["spoken"] == "What song should I play?"
        r = await skill.execute(AgentContext(user_message="x"), action="rewind")
        assert not r.success

    run(go)


def test_the_manifest_is_a_template_tool_that_never_asks_for_advice_and_has_one_prompt_example():
    assert MANIFEST.reply_mode == "template" and not MANIFEST.allow_advice and MANIFEST.permission_level == "auto"
    assert sum(e.prompt_example for e in MANIFEST.examples) == 1
    assert [p.name for p in MANIFEST.params] == ["action", "query"] and MANIFEST.params[0].enum == ("play", "stop")


# ---- the adapters' commands (no program is run) --------------------------------------------------------------------------------

def test_the_search_command_passes_the_query_as_one_argument_after_double_dash():
    argv = YtDlpResolver("yt-dlp", results=5).command("--exec evil; rm -rf x")
    assert argv[-2:] == ["--", "ytsearch5:--exec evil; rm -rf x"] and argv.count("--exec evil; rm -rf x") == 0


def test_search_output_is_parsed_and_live_streams_and_junk_are_skipped():
    text = "\n".join([
        '{"id":"a1","title":"Tum Hi Ho","channel":"T-Series","duration":262,"url":"https://www.youtube.com/watch?v=a1"}',
        "not json",
        '{"id":"b2","title":"Live radio","duration":null,"live_status":"is_live"}',
        '{"id":"c3","title":"No url field","uploader":"X","duration":100.5}',
    ])
    got = parse_results(text)
    assert [c.title for c in got] == ["Tum Hi Ho", "No url field"]
    assert got[0].duration_sec == 262 and got[1].url == "https://www.youtube.com/watch?v=c3" and got[1].channel == "X"


def test_the_player_command_is_audio_only_with_a_control_channel_and_the_url_after_double_dash():
    argv = MpvPlayer("mpv", "yt-dlp", ipc="/tmp/s.sock").command("https://www.youtube.com/watch?v=a1")
    assert "--no-video" in argv and "--input-ipc-server=/tmp/s.sock" in argv
    assert argv[-2:] == ["--", "https://www.youtube.com/watch?v=a1"]


def test_mpv_is_told_where_yt_dlp_is_when_it_is_found_and_the_control_channel_suits_the_platform(tmp_path, monkeypatch):
    fake = tmp_path / "yt-dlp"
    fake.write_text("")
    monkeypatch.setattr("tpa.audio.music_adapters.shutil.which", lambda name: str(fake) if name == str(fake) else None)
    argv = MpvPlayer("mpv", str(fake), ipc="x").command("u")
    assert f"--script-opts=ytdl_hook-ytdl_path={fake}" in argv
    from tpa.audio.music_adapters import ipc_address
    assert ipc_address(7, "win32") == "\\\\.\\pipe\\veda-mpv-7" and ipc_address(7, "linux").endswith("veda-mpv-7.sock")


def test_music_is_off_by_default_and_hidden_from_the_prompt_config_flags():
    from schemas.config_schemas import AppConfig
    cfg = AppConfig()
    assert cfg.music.enabled is False and cfg.music.max_minutes == 5


def test_a_real_child_process_reports_when_it_ends_and_stop_is_safe_to_repeat():
    import sys as _sys
    player = MpvPlayer(_sys.executable, "yt-dlp", ipc="x")      # python rejects the mpv options and exits at once
    ended = []

    async def go():
        await player.start("https://example.invalid/x", lambda: ended.append(True))
        for _ in range(200):
            if ended:
                break
            await asyncio.sleep(0.05)
        await player.stop()
        await player.stop()
        assert ended and not player.is_playing
        with pytest.raises(MusicError):
            await MpvPlayer("definitely-not-a-program-xyz", "yt-dlp", ipc="x").start("u", lambda: None)

    asyncio.run(go())


def test_a_missing_yt_dlp_is_a_spoken_error_not_a_crash():
    async def go():
        with pytest.raises(MusicError) as e:
            await YtDlpResolver("definitely-not-a-program-xyz").search("tum hi ho")
        assert "isn't set up" in e.value.spoken

    asyncio.run(go())


def test_the_spoken_title_is_short_and_drops_labels_and_decoration():
    assert mp.spoken_title("Full Video: Chikiri Chikiri | Peddi | Ram Charan | Janhvi | Buchi Babu | AR Rahman") == "Chikiri Chikiri, Peddi"
    assert mp.spoken_title("Believer (Official Music Video) - Imagine Dragons") == "Believer - Imagine Dragons"
    assert mp.spoken_title("8K: Chikiri Chikiri Video | Peddi") == "Chikiri Chikiri Video, Peddi"
    assert mp.spoken_title("Tum Hi Ho|Arijit Singh|Aashiqui 2|@tseries") == "Tum Hi Ho, Arijit Singh"
    assert mp.spoken_title("   ") == "that song" and len(mp.spoken_title("x" * 300)) <= 80


def test_mpv_is_found_in_the_usual_windows_folder_when_it_is_not_on_path(tmp_path, monkeypatch):
    from tpa.audio import music_adapters as ma
    folder = tmp_path / "MPV Player"
    folder.mkdir()
    (folder / "mpv.exe").write_text("")
    monkeypatch.setattr(ma.shutil, "which", lambda n: None)
    monkeypatch.setattr(ma.sys, "platform", "win32")
    monkeypatch.setattr(ma.sys, "executable", str(tmp_path / "nowhere" / "python.exe"))
    monkeypatch.setenv("ProgramFiles", str(tmp_path))
    assert ma.find_program("mpv") == str(folder / "mpv.exe")
    assert ma.find_program("yt-dlp") is None            # only mpv has well-known install folders


def test_the_room_sensor_driver_auto_uses_the_mock_when_the_dht11_library_is_not_installed():
    from tpa.sensors.room_drivers import MockRoomDriver, build_room_driver
    got = build_room_driver("auto", gpio_pin=4, mock_temperature_c=21.0, mock_humidity_pct=40.0)
    assert isinstance(got, MockRoomDriver) and got.read() == (21.0, 40.0)       # this laptop has no adafruit_dht
    assert isinstance(build_room_driver("mock", gpio_pin=4, mock_temperature_c=1.0, mock_humidity_pct=2.0), MockRoomDriver)
    with pytest.raises(Exception):
        build_room_driver("dht11", gpio_pin=4, mock_temperature_c=1.0, mock_humidity_pct=2.0)    # asked for explicitly: no silent fallback
