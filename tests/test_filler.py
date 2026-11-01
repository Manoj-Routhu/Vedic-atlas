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
        self.voices = []

    async def synthesize(self, text, voice=None):
        self.spoken_texts.append(text)
        self.voices.append(voice)
        yield b"\x00\x00" * 10


def _session(tts, work_sec, text="what are my tasks", **kw):
    return VoiceSession(
        audio=object(), collector=_Collector(), stt=_STT(text), tts=tts,
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
    session = _session(tts, 0.1, filler_phrases=["A."], filler_phrases_hi=["ए।"], filler_first_delay_sec=0.01,
                       filler_max_count=1)
    asyncio.run(session._render_fillers())
    assert (None, "A.") in session._filler_pcm and ("Hindi", "ए।") in session._filler_pcm
    tts.spoken_texts.clear()
    asyncio.run(session._handle(_utterance()))
    assert tts.spoken_texts == ["hello."]


def test_default_hindi_phrases_are_devanagari_short_and_plain():
    from core.filler import HINDI_FILLER_PHRASES, HINDI_FILLER_STILL_PHRASES
    for phrase in (*HINDI_FILLER_PHRASES, *HINDI_FILLER_STILL_PHRASES):
        assert any(0x0900 <= ord(c) < 0x0980 for c in phrase) and not any(c.isascii() and c.isalpha() for c in phrase)
        assert len(phrase.split()) <= 5


def test_hindi_turn_speaks_hindi_fillers_with_the_hindi_voice():
    tts = _Tts()
    session = _session(
        tts, 0.5, text="मेरे काम क्या हैं", filler_phrases=["Hold tight."], filler_still_phrases=["Almost done."],
        filler_phrases_hi=["रुकिए।"], filler_still_phrases_hi=["बस थोड़ा।"],
        filler_first_delay_sec=0.01, filler_repeat_sec=1.0, filler_max_count=2,
    )
    session._filler_repeat_sec = 0.05
    asyncio.run(session._handle(_utterance()))
    fillers = [(t, v) for t, v in zip(tts.spoken_texts, tts.voices) if t not in ("hello.",)]
    assert fillers == [("रुकिए।", "Hindi"), ("बस थोड़ा।", "Hindi")]


def test_english_turn_never_gets_hindi_fillers():
    tts = _Tts()
    session = _session(tts, 0.3, filler_phrases=["Hold tight."], filler_phrases_hi=["रुकिए।"],
                       filler_first_delay_sec=0.01, filler_max_count=1)
    asyncio.run(session._handle(_utterance()))
    assert "Hold tight." in tts.spoken_texts and "रुकिए।" not in tts.spoken_texts


def test_prerendered_hindi_filler_keeps_the_rate_of_the_voice_that_made_it():
    class _RateTts(_Tts):
        sample_rate = 22050

        async def synthesize(self, text, voice=None):
            type(self).sample_rate = 16000 if voice == "Hindi" else 22050
            yield b"\x00\x00" * 10

    played = []
    tts = _RateTts()
    session = _session(tts, 0.1, filler_phrases=["A."], filler_phrases_hi=["ए।"])
    session._speaker.play_pcm = lambda pcm, rate: played.append(rate)
    asyncio.run(session._render_fillers())
    assert session._filler_pcm[("Hindi", "ए।")][1] == 16000 and session._filler_pcm[(None, "A.")][1] == 22050


def test_echo_guard_hears_our_own_hindi_filler():
    session = _session(_Tts(), 0.0)
    session._turn_fillers = ["ज़रा रुकिए।"]
    assert session._is_echo("ज़रा रुकिए")
