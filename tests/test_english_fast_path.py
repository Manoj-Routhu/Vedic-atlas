"""The multilingual feature must not slow the normal (English) flow, and its own bugs stay fixed.

Each test pins one cost or bug found by timing the multilingual branch against main:
  - STT: English uses the fast English-only model; the multilingual model is opt-in.
  - the control decode does not require a `language` key (an English turn pays no output tokens for it).
  - an unclosed <think> no longer throws a valid answer away.
  - the translate step tries once.
  - Piper warmup loads the default voice; a failed warmup does not skip opening the speaker.
  - Hindi / Japanese replies split into sentences while streaming.
"""

import asyncio
import logging
from datetime import datetime
from types import SimpleNamespace

import numpy as np

from domain.entities.agent_context import AgentContext
from domain.policies.claim_guard_policy import SentenceClaimGuard
from domain.policies.reply_filler_policy import FillerStreamFilter
from domain.policies.tool_call_schema import CONTROL_KEYS, build_control_schema
from domain.value_objects.audio_window import AudioWindow
from service.agent.assistant_orchestrator import AssistantOrchestrator
from service.agent.responder import ResponderAgent
from service.agent.tool_execution import TurnOutcome
from service.prompting.prompt_composer import PromptComposer
from service.voice.voice_session import VoiceSession
from tpa.filestore.file_prompt_store import FilePromptStore
from tpa.filestore.yaml_tool_manifest_store import YamlToolManifestStore
from tpa.inference.llama_cpp_client import LlamaCppClient
from tpa.stt.faster_whisper import FasterWhisperProvider
from tpa.tts.piper import PiperProvider

HINDI = "मुझे भी किताबें पढ़ना पसंद है। क्या आपको कोई किताब पसंद है?"
JAPANESE = "それは素晴らしいですね。もっと読みたいですか？"


# ---- STT: English stays on the fast model -------------------------------------

class _Model:
    def __init__(self, label, log):
        self.label, self.log = label, log

    def transcribe(self, audio, **kwargs):
        self.log.append((self.label, kwargs))
        seg = SimpleNamespace(text="hello", start=0.0, end=0.5, avg_logprob=-0.2, no_speech_prob=0.01)
        return iter([seg]), SimpleNamespace(language_probability=0.99, language="en")


def _window():
    pcm = (np.random.default_rng(1).normal(0, 0.05, 16000) * 32767).astype(np.int16).tobytes()
    return AudioWindow(pcm=pcm, sample_rate=16000, channels=1, started_at=datetime.now(), duration_sec=1.0)


def _provider(language, log):
    p = FasterWhisperProvider(model_size="data/models/whisper-small", language=language,
                              english_model_size="data/models/whisper-base.en", noise_suppression_enabled=False)
    p._model, p._fast_model = _Model("multilingual", log), _Model("english", log)
    return p


def test_english_uses_the_fast_english_model_with_the_library_defaults():
    log = []
    asyncio.run(_provider("en", log).transcribe(_window()))
    label, kwargs = log[0]
    assert label == "english"
    assert "beam_size" not in kwargs            # the English path is exactly what main did
    assert kwargs["language"] == "en"


def test_the_multilingual_model_is_used_only_when_asked_for_and_decodes_greedily():
    for language in ("auto", "hi"):
        log = []
        asyncio.run(_provider(language, log).transcribe(_window()))
        label, kwargs = log[0]
        assert label == "multilingual"
        assert kwargs["beam_size"] == 1


def test_switching_the_language_switches_the_model_and_back():
    log = []
    p = _provider("en", log)
    p.set_language("hi")
    asyncio.run(p.transcribe(_window()))
    p.set_language("en")
    asyncio.run(p.transcribe(_window()))
    assert [label for label, _ in log] == ["multilingual", "english"]


def test_the_multilingual_model_is_not_loaded_while_english_is_pinned():
    loaded = []
    p = FasterWhisperProvider(model_size="small", language="en", english_model_size="base.en",
                              noise_suppression_enabled=False)
    p._load = lambda size: loaded.append(size) or _Model(size, [])
    asyncio.run(p.transcribe(_window()))
    assert loaded == ["base.en"]


def test_shipped_audio_config_defaults_to_the_fast_english_path():
    from core.config import load_full_config
    audio = load_full_config().audio
    assert audio.stt_language == "en"
    assert audio.stt_english_model_path
    assert audio.vad.silence_ms == 700          # a pause under 0.7 s must not end the question (400 cut "best places to visit in" short)


# ---- control decode: language is optional -------------------------------------

def test_language_is_not_a_required_key_of_the_control_decode():
    manifests = list(YamlToolManifestStore().load_all())
    schema = build_control_schema(manifests)
    assert "language" in schema["properties"] and "language" in CONTROL_KEYS
    assert "language" not in schema["required"]


def test_english_prompt_examples_do_not_teach_a_language_key():
    composer = PromptComposer(FilePromptStore(), YamlToolManifestStore().load_all())
    examples = composer._flagged_examples()
    assert examples and '"language"' not in examples


# ---- <think> handling ---------------------------------------------------------

def test_an_answer_after_an_unclosed_think_tag_is_kept_when_the_model_finished():
    strip = LlamaCppClient._strip_thinking
    assert strip("<think>\n\nEs ist 14:52 Uhr.", finished=True) == "Es ist 14:52 Uhr."
    assert strip("<think>\n\nreasoning</think>\n\nEs ist 14:52 Uhr.", finished=True) == "Es ist 14:52 Uhr."


def test_a_generation_cut_off_inside_a_think_block_is_still_discarded():
    strip = LlamaCppClient._strip_thinking
    assert strip("<think>\n\nlet me think about", finished=False) == ""
    assert strip("plain answer") == "plain answer"


# ---- translate: one attempt ---------------------------------------------------

def test_the_translate_step_makes_a_single_model_call_when_it_gets_nothing_back():
    calls = []

    class Client:
        async def complete(self, **kwargs):
            calls.append(kwargs)
            return ""

    stub = SimpleNamespace(
        _composer=PromptComposer(FilePromptStore(), YamlToolManifestStore().load_all()),
        _client=Client(), model=None, _narrate_temperature=0.2, _narrate_num_predict=90,
    )
    outcome = TurnOutcome(reply=None)
    result = asyncio.run(AssistantOrchestrator._localize(
        stub, "It's 2:45 PM.", "Hindi", AgentContext(user_message="x"), outcome))
    assert result is None and len(calls) == 1


# ---- Piper warmup ---------------------------------------------------------------

def test_piper_warmup_loads_the_default_voice(tmp_path):
    en, hi = tmp_path / "en.onnx", tmp_path / "hi.onnx"
    en.write_bytes(b"")
    hi.write_bytes(b"")
    p = PiperProvider(model_path=en, voices={"hi": str(hi)})
    loaded = []

    class Voice:
        def synthesize(self, text):
            return iter(())

    p._ensure = lambda path: loaded.append(path) or Voice()
    p.warmup()
    assert loaded == [en]


def test_a_failed_tts_warmup_still_opens_the_speaker():
    opened = []

    class Tts:
        sample_rate = 22050

        def warmup(self):
            raise TypeError("boom")

    class Speaker:
        def keep_open(self, rate):
            opened.append(rate)

    stub = SimpleNamespace(_tts=Tts(), _speaker=Speaker())
    asyncio.run(VoiceSession._warm_output(stub))
    assert opened == [22050]


# ---- sentence splitting for TTS -------------------------------------------------

def test_the_voice_splitter_ends_a_sentence_at_a_danda_and_at_full_width_marks():
    first, rest = VoiceSession._pop_sentence(HINDI)
    assert first.endswith("।") and rest.strip().startswith("क्या")
    first, rest = VoiceSession._pop_sentence(JAPANESE)
    assert first.endswith("。") and rest.startswith("も")
    first, rest = VoiceSession._pop_sentence("That sounds great. Do you want more?")
    assert first == "That sounds great."


def _stream(text, step=5):
    filt, guard, out = FillerStreamFilter(), SentenceClaimGuard(lambda s: False), []
    for i in range(0, len(text), step):
        released = filt.feed(text[i:i + step])
        out += guard.feed(released) if released else []
    out += guard.feed(filt.finish()) + guard.finish()
    return [s.strip() for s in out]


def test_hindi_and_japanese_replies_stream_as_separate_sentences():
    assert len(_stream(HINDI)) == 2
    assert len(_stream(JAPANESE)) == 2
    assert _stream("That sounds great. Do you want more?") == ["That sounds great.", "Do you want more?"]


def _released_before_the_end(text, step=5):
    """Sentences released while the LAST few characters of the reply have not arrived yet."""
    filt, guard, early = FillerStreamFilter(), SentenceClaimGuard(lambda s: False), []
    for i in range(0, len(text) - 6, step):
        piece = filt.feed(text[i:i + step])
        early += guard.feed(piece) if piece else []
    return early


def test_hindi_speech_starts_before_the_reply_has_finished_generating():
    three_hindi = HINDI + " बताइए।"
    three_english = "That sounds great. Do you want more? Tell me."
    assert _released_before_the_end(three_english)                  # what English already did
    assert _released_before_the_end(three_hindi), "nothing was spoken until the whole Hindi reply had streamed"


# ---- a long reply must still come out in the user's language, and be spoken with the right voice -----------------

from domain.policies.language_policy import shorten_for_translation, voice_language

LONG_ANSWER = ("The sources indicate that the INDIA bloc's protest at Delhi's Ramlila Maidan is expected to draw a large crowd, "
               "with organisers saying that thousands of supporters will attend while police have arranged extra security.")


def test_a_long_sentence_is_cut_at_a_clause_before_it_is_translated():
    short = shorten_for_translation(LONG_ANSWER)
    assert short == "The sources indicate that the INDIA bloc's protest at Delhi's Ramlila Maidan is expected to draw a large crowd."
    assert len(short) <= 121


def test_short_text_and_whole_sentences_are_left_alone():
    assert shorten_for_translation("It's 2:45 PM.") == "It's 2:45 PM."
    two = "First sentence here. Second sentence follows it. A third sentence is far too long to fit inside the limit at all, really, because it keeps going on and on and on."
    assert shorten_for_translation(two) == "First sentence here. Second sentence follows it."
    assert shorten_for_translation("") == ""


def test_an_english_reply_is_spoken_with_the_default_voice_even_when_the_turn_is_hindi():
    assert voice_language("It's 3 PM.", "Hindi") is None            # a Hindi voice would mangle it
    assert voice_language("It's 3 PM.", "Telugu") == "Telugu"      # not a supported language: left alone (no Telugu voice exists)
    assert voice_language("3:16 बजे है।", "Hindi") == "Hindi"   # real Hindi keeps its voice
    assert voice_language("Hello", "English") == "English"
    assert voice_language("Hello", "English") == "English"
    assert voice_language("Hello", None) is None


def test_the_translate_step_is_given_only_the_short_piece_and_room_to_finish():
    seen = {}

    class Client:
        async def complete(self, **kwargs):
            seen.update(kwargs)
            return "अनुवाद"

    stub = SimpleNamespace(
        _composer=PromptComposer(FilePromptStore(), YamlToolManifestStore().load_all()),
        _client=Client(), model=None, _narrate_temperature=0.2, _narrate_num_predict=90,
    )
    asyncio.run(AssistantOrchestrator._localize(stub, LONG_ANSWER, "Hindi", AgentContext(user_message="x"), TurnOutcome(reply=None)))
    assert "security" not in seen["prompt"] and "large crowd." in seen["prompt"]
    assert seen["num_predict"] >= 300


# ---- only English, Hindi and Telugu --------------------------------------------------------------------------------------

from datetime import datetime as _dt

from domain.entities.conversation import Turn
from domain.policies.language_policy import language_of, normalise_language


class _Probs:
    """A Whisper model whose first (auto-detect) call finds `detected`, and whose pinned call finds what it is told."""
    def __init__(self, detected, probs):
        self.detected, self.probs, self.calls = detected, probs, []

    def transcribe(self, audio, **kwargs):
        language = kwargs.get("language")
        self.calls.append(language)
        seg = SimpleNamespace(text="hello", start=0.0, end=0.5, avg_logprob=-0.2, no_speech_prob=0.01)
        info = SimpleNamespace(language=language or self.detected, language_probability=1.0 if language else 0.9,
                               all_language_probs=None if language else self.probs)
        return iter([seg]), info


def _auto_provider(detected, probs, **kw):
    p = FasterWhisperProvider(model_size="data/models/whisper-small", language="auto", noise_suppression_enabled=False, **kw)
    p._model = _Probs(detected, probs)
    return p


def test_a_clip_detected_as_an_unsupported_language_is_redone_in_the_best_supported_one():
    p = _auto_provider("pt", [("pt", 0.90), ("en", 0.06), ("hi", 0.03), ("te", 0.01)])
    transcript = asyncio.run(p.transcribe(_window()))
    assert p._model.calls == [None, "en"]                       # detected, then redone
    assert transcript.language == "en"
    assert transcript.confidence == 0.06                         # the probability Whisper really gave it, not 1.0


def test_the_best_supported_language_wins_even_when_it_is_not_english():
    p = _auto_provider("pt", [("pt", 0.90), ("hi", 0.06), ("en", 0.01), ("te", 0.01)])
    assert asyncio.run(p.transcribe(_window())).language == "hi"


def test_a_supported_detection_costs_a_single_pass():
    p = _auto_provider("hi", [("hi", 0.9), ("en", 0.05)])
    assert asyncio.run(p.transcribe(_window())).language == "hi"
    assert p._model.calls == [None]


def test_an_unsupported_language_never_becomes_the_sticky_language():
    p = _auto_provider("pt", [("pt", 0.9), ("en", 0.06)])
    asyncio.run(p.transcribe(_window()))
    assert p._last_language is None
    p._remember_language("de", 5.0, 0.99)
    assert p._last_language is None


def test_pinning_an_unsupported_language_is_refused_and_a_bad_config_value_degrades_to_auto():
    p = FasterWhisperProvider(model_size="data/models/whisper-small", language="auto")
    for bad in ("de", "ja", "kn", "te"):
        try:
            p.set_language(bad)
        except ValueError as e:
            assert "en, hi" in str(e)
        else:
            raise AssertionError(f"{bad} was accepted")
    assert p.current_language == "auto"
    assert FasterWhisperProvider(model_size="data/models/whisper-small", language="de").current_language == "auto"
    p.set_language("hi")
    assert p.current_language == "hi"


def test_shipped_config_is_english_and_hindi_with_piper_on_every_machine():
    from core.config import load_full_config
    audio = load_full_config().audio
    assert audio.stt_languages == ["en", "hi"]
    assert audio.stt_auto_min_sec == 0                           # always detect among the three, no sticky forcing
    assert audio.tts_engine == "piper"                           # not "auto": Windows speech has no Hindi/Telugu voice
    assert set(audio.tts_voice_map) == {"en", "hi"}


def test_other_languages_are_english_for_the_reply():
    assert normalise_language("German") == "English" and normalise_language("Japanese") == "English"
    assert normalise_language("Hindi") == "Hindi" and normalise_language("unknown") is None
    assert language_of("Guten Tag, wie geht es dir") is None


# ---- English turns carry no multilingual prompt cost -----------------------------------------------------------------------

def _responder():
    class Convo:
        turns = []
        def get_summaries_block(self): return ""
    class Know:
        def get_context(self): return ""
    return ResponderAgent(client=None, conversation=Convo(), knowledge=Know())


def test_an_english_chat_turn_gets_the_original_short_instruction():
    prompt = _responder().build_prompt(AgentContext(user_message="how are you today"))
    assert prompt.rstrip().endswith("Respond directly to the user. Be concise and conversational.")
    assert "same language" not in prompt and "The user wrote in" not in prompt


def test_a_hindi_chat_turn_is_told_the_language():
    prompt = _responder().build_prompt(AgentContext(user_message=HINDI, metadata={"language": "Hindi"}))
    assert "The user wrote in Hindi. Write your entire reply in Hindi." in prompt and "same language" in prompt


def test_hindi_history_takes_a_quarter_of_the_room_in_the_control_prompt():
    composer = PromptComposer(FilePromptStore(), YamlToolManifestStore().load_all())
    hindi, english = ("है " * 120).strip(), ("ok " * 120).strip()

    def turns(text):
        now = _dt.now()
        return [Turn(None, "s", "user", text, now), Turn(None, "s", "assistant", text, now)]

    def recent_chars(history):
        prompt = composer.control_stage("hi", history, "").prompt
        return len(prompt.split("RECENT:")[1].split("TODAY:")[0])

    assert recent_chars(turns(hindi)) < recent_chars(turns(english)) / 2
