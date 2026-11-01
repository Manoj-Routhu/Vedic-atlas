import asyncio
import random

from core.filler import CLI_STATUS_WORDS, FILLER_PHRASES, FILLER_STILL_PHRASES, PhrasePicker
from service.voice.voice_session import VoiceSession
from test_voice_mute_and_artifacts import _Collector, _FakeTTS, _Gate, _PlayingSpeaker, _STT, _Supervisor, _utterance


def test_picker_never_repeats_back_to_back():
    picker = PhrasePicker(["a", "b", "c"], random.Random(1))
    picks = [picker.pick() for _ in range(200)]
    assert all(x != y for x, y in zip(picks, picks[1:]))
    assert set(picks) == {"a", "b", "c"}


def test_picker_with_one_phrase_and_with_none():
    assert PhrasePicker(["only"]).pick() == "only"
    assert PhrasePicker([]).pick() == ""


def test_default_phrases_are_short_and_plain():
    for phrase in (*FILLER_PHRASES, *FILLER_STILL_PHRASES):
        assert len(phrase.split()) <= 5
    assert len(CLI_STATUS_WORDS) >= 5


class _Tts(_FakeTTS):
    def __init__(self):
        self.spoken_texts = []

    async def synthesize(self, text):
        self.spoken_texts.append(text)
        yield b"\x00\x00" * 10


def _session(tts, work_sec, **kw):
    return VoiceSession(
        audio=object(), collector=_Collector(), stt=_STT("what are my tasks"), tts=tts,
        speaker=_PlayingSpeaker(), supervisor=_Supervisor(work_sec=work_sec),
        capture_gate=_Gate(), speak_replies=True, **kw,
    )


def test_long_wait_speaks_several_fillers_up_to_the_cap_and_never_twice_in_a_row():
    tts = _Tts()
    session = _session(
        tts, 0.5, filler_phrases=["Hold tight.", "Wait please."], filler_still_phrases=["Almost done.", "Nearly there."],
        filler_first_delay_sec=0.01, filler_repeat_sec=1.0, filler_max_count=3,
    )
    session._filler_repeat_sec = 0.05   # the field is validated >= 1 s in config, not on the class
    asyncio.run(session._handle(_utterance()))
    fillers = [t for t in tts.spoken_texts if t != "hello."]
    assert len(fillers) == 3
    assert fillers[0] in ("Hold tight.", "Wait please.") and all(f in ("Almost done.", "Nearly there.") for f in fillers[1:])
    assert fillers[1] != fillers[2]
    assert all(session._is_echo(f.strip(".")) for f in fillers)


def test_max_count_zero_turns_fillers_off():
    tts = _Tts()
    session = _session(tts, 0.1, filler_phrases=["A."], filler_first_delay_sec=0.01, filler_max_count=0)
    asyncio.run(session._handle(_utterance()))
    assert tts.spoken_texts == ["hello."]


def test_prerendered_filler_audio_is_played_without_synthesising_again():
    tts = _Tts()
    session = _session(tts, 0.1, filler_phrases=["A."], filler_first_delay_sec=0.01, filler_max_count=1)
    asyncio.run(session._render_fillers())
    assert "A." in session._filler_pcm
    tts.spoken_texts.clear()
    asyncio.run(session._handle(_utterance()))
    assert tts.spoken_texts == ["hello."]
