"""Garbled speech must not become a 40+ s tool decision, and a garbled message must not inherit the previous tool.

Measured on the target machine (see docs/06-configuration.md): a control decision costs 36-94 s, so a wrong or useless
one is expensive; two garbled Hindi transcripts flipped from web_search to the room sensor because the last tool was
the room sensor.
"""

import asyncio
from datetime import datetime, timedelta
from types import SimpleNamespace

from domain.entities.agent_context import AgentContext
from domain.entities.agent_result import AgentResult
from domain.entities.session_context import SessionContext
from domain.entities.utterance import Utterance
from domain.policies.transcript_policy import SHAKY_BELOW, UNCLEAR_BELOW, speech_quality, unclear_reply
from domain.value_objects.audio_window import AudioWindow
from domain.value_objects.transcript import Transcript
from service.agent.assistant_orchestrator import AssistantOrchestrator
from service.prompting.prompt_composer import PromptComposer
from service.session.session_state import SessionStateService
from service.voice.voice_session import VoiceSession
from domain.entities.conversation import Turn
from tpa.filestore.file_prompt_store import FilePromptStore
from tpa.filestore.yaml_tool_manifest_store import YamlToolManifestStore

HINDI = "मोदी जी के बारे में बताओ"


# ---- the policy -----------------------------------------------------------------------------------------------------

def test_speech_quality_bands():
    assert [speech_quality(x) for x in (None, -0.2, -0.4, -0.69)] == ["ok"] * 4
    assert [speech_quality(x) for x in (-0.71, -0.9, -1.0)] == ["shaky"] * 3
    assert speech_quality(-1.01) == "unclear" and speech_quality(-1.5) == "unclear"
    assert speech_quality(-0.8, unclear_below=-0.9, shaky_below=-0.5) == "shaky"      # configurable


def test_the_measured_clear_speech_is_nowhere_near_the_refusal_line():
    # clear English scored -0.36..-0.43 on the real model; the refusal line leaves a wide margin
    assert -0.36 > SHAKY_BELOW and -0.43 > SHAKY_BELOW and UNCLEAR_BELOW < SHAKY_BELOW


def test_the_repeat_request_is_in_the_speakers_language():
    assert unclear_reply("hi").startswith("माफ़")
    assert unclear_reply("en") == unclear_reply("de") == unclear_reply(None) == "Sorry, I didn't catch that. Could you say it again?"


# ---- the voice loop ---------------------------------------------------------------------------------------------------

class _Gate:
    muted = False
    paused = False

    def is_muted(self):
        return False


class _Collector:
    is_speaking = False

    def reset(self):
        pass


class _Speaker:
    def interrupt(self):
        pass

    def play_pcm(self, pcm, rate):
        pass

    def wait_done(self, timeout):
        return True


class _TTS:
    sample_rate = 22050

    def __init__(self):
        self.spoken = []

    async def synthesize(self, text, voice=None):
        self.spoken.append((text, voice))
        yield b"\x00\x00" * 10


class _Supervisor:
    def __init__(self):
        self.contexts = []

    async def execute_stream(self, ctx, cancel_event=None):
        self.contexts.append(ctx)
        yield "Fine."

    async def execute(self, ctx):
        self.contexts.append(ctx)
        return AgentResult(agent_name="r", response="ok")


class _STT:
    def __init__(self, text, avg_logprob, language="en"):
        self._t = Transcript(text=text, confidence=0.99, language=language, avg_logprob=avg_logprob)

    async def transcribe(self, audio):
        return self._t


def _utterance():
    now = datetime.now()
    window = AudioWindow(pcm=b"\x00\x00" * 160, sample_rate=16000, channels=1, started_at=now, duration_sec=2.0)
    return Utterance(audio=window, started_at=now, duration_sec=2.0, frame_count=1)


def _run(text, avg_logprob, language="en"):
    tts, sup = _TTS(), _Supervisor()
    session = VoiceSession(
        audio=object(), collector=_Collector(), stt=_STT(text, avg_logprob, language), tts=tts, speaker=_Speaker(),
        supervisor=sup, capture_gate=_Gate(), speak_replies=True,
    )
    asyncio.run(session._handle(_utterance()))
    return session, tts, sup


def test_unclear_speech_asks_again_without_calling_the_assistant():
    session, tts, sup = _run("mumble mumble words", -1.2)
    assert sup.contexts == [] and session.status()["turns"] == 0
    assert [t for t, _ in tts.spoken] == ["Sorry, I didn't catch that. Could you say it again?"]
    assert tts.spoken[0][1] is None                                  # the English voice


def test_unclear_hindi_is_asked_again_in_hindi_with_the_hindi_voice():
    _, tts, sup = _run(HINDI, -1.3, language="hi")
    assert sup.contexts == [] and tts.spoken[0][0] == unclear_reply("hi") and tts.spoken[0][1] == "Hindi"


def test_clear_speech_goes_straight_to_the_assistant():
    session, tts, sup = _run("what are my tasks", -0.4)
    assert len(sup.contexts) == 1 and session.status()["turns"] == 1
    assert "stt_shaky" not in sup.contexts[0].metadata and sup.contexts[0].metadata["stt_avg_logprob"] == -0.4


def test_shaky_speech_is_answered_but_flagged_so_it_inherits_nothing():
    _, _, sup = _run("what are my tasks", -0.85)
    assert len(sup.contexts) == 1 and sup.contexts[0].metadata["stt_shaky"] is True


def test_a_backend_that_reports_no_confidence_is_never_refused():
    _, _, sup = _run("what are my tasks", None)
    assert len(sup.contexts) == 1 and "stt_shaky" not in sup.contexts[0].metadata


# ---- the previous tool ----------------------------------------------------------------------------------------------------

def _state(tool, slots):
    now = datetime.now()
    return SessionContext("s", "", tool, slots, now - timedelta(seconds=90), now + timedelta(minutes=5))


def _service():
    return SessionStateService(repo=None, manifests={m.name: m for m in YamlToolManifestStore().load_all()})


def test_a_tool_with_nothing_to_reuse_is_not_shown_as_the_active_one():
    service = _service()
    assert service.render_active(_state("get_room_temperature", {})) == ""


def test_a_tool_with_slots_still_carries_them_for_follow_ups():
    line = _service().render_active(_state("get_weather", {"place": "Oslo"}))
    assert line.startswith("ACTIVE: get_weather | place=Oslo")


def test_shaky_speech_gets_no_active_line_even_when_there_is_one():
    stub = SimpleNamespace(_session_state=_service())
    state = _state("get_weather", {"place": "Oslo"})
    assert AssistantOrchestrator._active_for(stub, AgentContext(user_message="x"), state).startswith("ACTIVE: get_weather")
    assert AssistantOrchestrator._active_for(stub, AgentContext(user_message="x", metadata={"stt_shaky": True}), state) == ""


# ---- history the decider re-reads ------------------------------------------------------------------------------------------

def test_the_control_history_clip_applies_to_both_sides_and_keeps_a_name_late_in_a_long_reply():
    composer = PromptComposer(FilePromptStore(), YamlToolManifestStore().load_all(), turn_chars=200, control_turn_chars=100)
    now = datetime.now()
    history = [Turn(None, "s", "user", "u" * 300, now), Turn(None, "s", "assistant", "a" * 300, now)]
    recent = composer.control_stage("and then?", history, "").prompt.split("RECENT:")[1].split("TODAY:")[0]
    assert "u" * 99 + "…" in recent and "a" * 99 + "…" in recent and "u" * 101 not in recent
    # the shipped 200 keeps "Narendra Modi" (about character 80) of a typical reply: clipping to 50 lost the name and the follow-up "how old is he"
    reply = "According to the sources, the current prime minister of India is Narendra Modi, who has served since 26 May 2014."
    shipped = PromptComposer(FilePromptStore(), YamlToolManifestStore().load_all(), turn_chars=200, control_turn_chars=200)
    kept = shipped.control_stage("how old is he", [Turn(None, "s", "user", "who is the prime minister of India", now), Turn(None, "s", "assistant", reply, now)], "").prompt
    assert "Narendra Modi" in kept


def test_a_follow_up_sees_two_exchanges_so_it_can_reach_the_earlier_topic():
    composer = PromptComposer(FilePromptStore(), YamlToolManifestStore().load_all())
    now = datetime.now()
    history = [Turn(None, "s", "user", "weather in Oslo", now), Turn(None, "s", "assistant", "It is 4 degrees in Oslo.", now),
               Turn(None, "s", "user", "what time is it", now), Turn(None, "s", "assistant", "It is 3 PM.", now)]
    prompt = composer.control_stage("and tomorrow there?", history, "", exchanges=2).prompt
    assert "weather in Oslo" in prompt and "what time is it" in prompt          # measured: 1 exchange got 1 of 6 such follow-ups, 2 got 6 of 6
    assert "weather in Oslo" not in composer.control_stage("tell me a joke", history, "", exchanges=2).prompt   # a stand-alone message sees none


def test_shipped_defaults_are_the_cheaper_ones():
    from core.config import load_full_config
    cfg = load_full_config()
    assert cfg.prompting.control_history_exchanges == 2 and cfg.prompting.control_turn_chars == 200
    assert cfg.agents.session_ttl_sec == 300 and cfg.prompting.history_for_follow_ups_only is False   # history is always shown (decided 2026-11-01: "help me with first lesson" lost its topic)
    assert cfg.inference.prompt_cache_mb == 768        # the Pi's limit; the laptop must not use more
    assert cfg.audio.stt_unclear_below == -1.0 and cfg.audio.stt_shaky_below == -0.7


# ---- a language claim needs the script -----------------------------------------------------------------------------------

def test_an_english_message_is_never_hindi_whatever_the_model_claims():
    from domain.policies.language_policy import resolve_language
    assert resolve_language("what is the weather in Pune", "Hindi") == "English"      # measured misclaim after Hindi turns
    assert resolve_language("tell me a joke", "Hindi") == "English"
    assert resolve_language(HINDI, None) == "Hindi" and resolve_language(HINDI, "English") == "Hindi"   # the script wins
    assert resolve_language("what time is it", None) is None                            # no claim, no script: nothing to say
    assert resolve_language("what time is it", "English") == "English"
    assert resolve_language("hello there", "unknown") is None                           # unreadable stays unknown
    assert resolve_language("guten tag", "German") == "English"                         # unsupported -> English


# ---- a new question must not inherit the previous search's topic ---------------------------------------------------------

def test_follow_ups_continue_and_stand_alone_questions_do_not():
    from domain.policies.session_state_policy import continues_previous
    for follow_up in ("ok and what about the day after", "okay and tomorrow?", "so what about Sunday", "hmm what else",
                      "where are they from?", "and in Delhi?", "what about tomorrow?", "how old is he", "tomorrow?",
                      "tell me more", "is it going to rain there", "और दिल्ली में?",
                      "वो कहाँ से हैं?", "उनके बारे में और बताओ"):
        assert continues_previous(follow_up), follow_up
    for alone in ("tell me a joke", "ok tell me a joke", "what is the capital of India", "who painted the Mona Lisa", "how many days are in a leap year",
                  "भारत की राजधानी क्या है?", "मोदी जी के बारे में बताओ"):
        assert not continues_previous(alone), alone


def _search_state(query="latest news about cricket"):
    return _state("web_search", {"query": query, "topic": "news"})


def test_a_previous_search_is_shown_only_to_a_message_that_continues_it():
    service = _service()
    state = _search_state()
    assert service.render_active(state, "where are they from?").startswith("ACTIVE: web_search | query=latest news about cricket")
    assert service.render_active(state, "tell me a joke") == ""                          # measured: it searched "latest joke about cricket"
    assert service.render_active(state, "भारत की राजधानी क्या है?") == ""


def test_other_tools_keep_their_state_whatever_the_message_says():
    service = _service()
    assert service.render_active(_state("get_weather", {"place": "Oslo"}), "tell me a joke").startswith("ACTIVE: get_weather")
    assert service.render_active(_search_state()).startswith("ACTIVE: web_search")        # no message given: unchanged behaviour


def test_the_last_exchange_is_shown_only_to_a_message_that_points_back_at_it():
    composer = PromptComposer(FilePromptStore(), YamlToolManifestStore().load_all())
    now = datetime.now()
    history = [Turn(None, "s", "user", "latest news about cricket", now), Turn(None, "s", "assistant", "India won the match.", now)]

    def recent(message):
        return composer.control_stage(message, history, "", exchanges=1, show_empty=True).prompt.split("RECENT:")[1].split("TODAY:")[0]

    assert "cricket" in recent("who won it?")                    # a follow-up keeps the exchange
    assert "cricket" in recent("tell me more")
    assert recent("tell me a joke").strip() == "none"           # a new subject does not (measured: it searched "cricket news")
    assert recent("what is the capital of India").strip() == "none"


def test_history_can_be_shown_to_every_message_again_with_one_setting():
    now = datetime.now()
    history = [Turn(None, "s", "user", "latest news about cricket", now), Turn(None, "s", "assistant", "India won.", now)]
    on = PromptComposer(FilePromptStore(), YamlToolManifestStore().load_all())                                   # default: follow-ups only
    off = PromptComposer(FilePromptStore(), YamlToolManifestStore().load_all(), history_for_follow_ups_only=False)  # exactly as before

    def recent(composer):
        return composer.control_stage("tell me a joke", history, "", exchanges=2, show_empty=True).prompt.split("RECENT:")[1].split("TODAY:")[0]

    assert recent(on).strip() == "none" and "cricket" in recent(off)
