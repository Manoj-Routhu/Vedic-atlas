"""The shared filler schedule (service/agent/filler_schedule.py) and its use in POST /api/stream.

The voice loop's use of it is covered by tests/test_filler.py; here: the timing itself, the SSE `filler` event, and that a
filler never reaches the model or follows the reply.
"""

import asyncio
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from controller.routes.stream import router
from controller.sse.encoder import sse_encode
from service.agent.filler_schedule import FillerSettings, filler_phrases


def _collect(reply_after: float | None, **kw) -> list[str]:
    async def run():
        started = asyncio.Event()
        if reply_after == 0:
            started.set()   # already started: no timer race on Windows' coarse clock
        elif reply_after is not None:
            asyncio.get_running_loop().call_later(reply_after, started.set)
        return [p async for p in filler_phrases(started, **kw)]

    return asyncio.run(run())


_FAST = dict(first=["One."], later=["Two.", "Three."], first_delay_sec=0.01, repeat_sec=0.02)


def test_phrases_arrive_first_then_still_phrases_up_to_the_cap():
    got = _collect(None, max_count=3, **_FAST)
    assert got[0] == "One." and len(got) == 3
    assert all(p in ("Two.", "Three.") for p in got[1:]) and got[1] != got[2]


def test_a_reply_that_starts_first_gets_no_filler():
    assert _collect(0.0, max_count=3, **_FAST) == []


def test_reply_during_the_wait_stops_the_rest():
    got = _collect(0.03, max_count=5, **_FAST)
    assert 1 <= len(got) < 5


def test_max_count_zero_and_empty_lists_give_nothing():
    assert _collect(None, max_count=0, **_FAST) == []
    assert _collect(None, max_count=3, first=[], later=[], first_delay_sec=0.01, repeat_sec=0.01) == []


def _audio(**kw):
    base = dict(
        filler_phrases=["Hold on."], filler_still_phrases=["Still here."], filler_phrases_hi=["एक पल।"],
        filler_still_phrases_hi=[], filler_first_delay_sec=0.05, filler_repeat_sec=0.05, filler_max_count=3,
    )
    base.update(kw)
    return SimpleNamespace(**base)


def test_settings_pick_the_language_and_fall_back_when_still_list_is_empty():
    s = FillerSettings.from_audio(_audio())
    assert s.phrases_for(False) == (("Hold on.",), ("Still here.",))
    assert s.phrases_for(True) == (("एक पल।",), ("एक पल।",))   # empty Hindi "still" list falls back to the first


def test_encoder_names_an_event_and_leaves_plain_text_alone():
    assert sse_encode("Let me think.", event="filler") == "event: filler\ndata: Let me think.\n\n"
    assert sse_encode("a\nb") == "data: a\ndata: b\n\n"
    assert sse_encode("x", event="a\nb").startswith("event: a b\n")   # a name can never inject a second field


class _Supervisor:
    def __init__(self, work_sec: float, chunks=("Hello ", "there.")):
        self.work_sec, self.chunks, self.seen = work_sec, chunks, []

    async def execute_stream(self, ctx, cancel_event=None):
        self.seen.append(ctx.user_message)
        await asyncio.sleep(self.work_sec)
        for c in self.chunks:
            yield c


def _client(work_sec: float, audio=None, **kw):
    app = FastAPI()
    app.include_router(router, prefix="/api")
    app.state.supervisor = _Supervisor(work_sec, **kw)
    if audio is not False:
        app.state.full_config = SimpleNamespace(audio=audio or _audio())
    return TestClient(app), app.state.supervisor


def _frames(body: str) -> list[str]:
    return [f for f in body.split("\n\n") if f]


def test_slow_reply_gets_fillers_before_the_text_and_none_after():
    client, _ = _client(0.3)
    frames = _frames(client.post("/api/stream", json={"message": "what are my tasks"}).text)
    fillers = [i for i, f in enumerate(frames) if f.startswith("event: filler")]
    texts = [i for i, f in enumerate(frames) if f.startswith("data: ") and "[DONE]" not in f]
    assert fillers and max(fillers) < min(texts)
    assert frames[fillers[0]] == "event: filler\ndata: Hold on."
    assert frames[-1] == "data: [DONE]"
    assert [frames[i] for i in texts] == ["data: Hello ", "data: there."]


def test_fast_reply_gets_no_filler():
    client, _ = _client(0.0, audio=_audio(filler_first_delay_sec=1.0))
    frames = _frames(client.post("/api/stream", json={"message": "hi"}).text)
    assert frames == ["data: Hello ", "data: there.", "data: [DONE]"]


def test_devanagari_question_gets_hindi_fillers():
    client, _ = _client(0.3)
    body = client.post("/api/stream", json={"message": "मेरे काम क्या हैं"}).text
    assert "event: filler\ndata: एक पल।" in body


def test_fillers_off_or_no_config_changes_nothing():
    for audio in (_audio(filler_max_count=0), False):
        client, _ = _client(0.2, audio=audio)
        assert "event:" not in client.post("/api/stream", json={"message": "hi"}).text


def test_fillers_never_reach_the_model():
    client, supervisor = _client(0.3)
    client.post("/api/stream", json={"message": "what are my tasks"})
    assert supervisor.seen == ["what are my tasks"]


def test_a_supervisor_error_still_fails_the_response_and_leaves_no_task_behind():
    class Boom:
        async def execute_stream(self, ctx, cancel_event=None):
            raise RuntimeError("model down")
            yield ""   # pragma: no cover

    app = FastAPI()
    app.include_router(router, prefix="/api")
    app.state.supervisor = Boom()
    app.state.full_config = SimpleNamespace(audio=_audio())
    try:
        TestClient(app).post("/api/stream", json={"message": "hi"})
        raised = False
    except RuntimeError:
        raised = True
    assert raised
