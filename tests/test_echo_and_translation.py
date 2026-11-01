"""The localisation stage and the echo filter."""

from domain.entities.agent_context import AgentContext
from domain.policies.echo_policy import fallback_reply, is_echo
from service.agent.responder import ResponderAgent
from service.prompting.prompt_composer import PromptComposer
from tpa.filestore.file_prompt_store import FilePromptStore
from tpa.filestore.yaml_tool_manifest_store import YamlToolManifestStore

HINDI = "\u0906\u091c \u092e\u0947\u0930\u093e \u091c\u0928\u094d\u092e\u0926\u093f\u0928 \u0939\u0948"
HINDI_ASK = "\u0915\u094d\u092f\u093e \u0924\u0941\u092e \u092e\u0941\u0902\u092c\u0908 \u092e\u0947\u0902 \u092a\u093e\u0930\u094d\u091f\u0940 \u0915\u0930\u0928\u0947 \u0915\u0947 \u0932\u093f\u090f \u091c\u0917\u0939 \u0922\u0942\u0902\u0922"
HINDI_DONE = HINDI_ASK + " \u0938\u0915\u0924\u0947 \u0939\u094b?"


def _composer():
    return PromptComposer(FilePromptStore(), YamlToolManifestStore().load_all())


# ---- echo filter -------------------------------------------------------------

def test_exact_repeat_is_an_echo():
    assert is_echo(HINDI, HINDI)
    assert is_echo("hello there", "hello there")


def test_punctuation_and_case_do_not_hide_an_echo():
    assert is_echo(HINDI + "?", HINDI)
    assert is_echo("Hello There!", "hello there")


def test_a_completed_fragment_counts_as_an_echo():
    assert is_echo(HINDI_DONE, HINDI_ASK)


def test_a_real_answer_is_not_an_echo():
    assert not is_echo("Jazz am Abend ist etwas Feines, Anna.", "Hallo, ich bin Anna. Ich höre abends gern Jazz.")
    assert not is_echo("The weather is 27 degrees in Chennai.", HINDI_ASK)


def test_short_replies_and_empty_text_are_not_echoes():
    assert not is_echo("ok", "a much longer message from the user")
    assert not is_echo("", HINDI)
    assert not is_echo(HINDI, "")


# ---- translate prompt --------------------------------------------------------

def test_translate_stage_carries_the_sentence_and_no_user_text():
    stage = _composer().translate_stage("In Chennai it's 27 degrees.", "Hindi")
    assert "TARGET LANGUAGE: Hindi" in stage.prompt
    assert "TEXT:\nIn Chennai it's 27 degrees." in stage.prompt
    assert "QUESTION" not in stage.prompt and "USER:" not in stage.prompt
    assert "Translate TEXT into TARGET LANGUAGE" in stage.system
    assert "never repeat the user's question" in stage.system


# ---- fixed fallback + retry prompt ------------------------------------------

def test_fallback_reply_is_controlled_and_in_the_turn_language():
    assert fallback_reply(None) == fallback_reply("English")
    assert fallback_reply("Klingon") == fallback_reply("English")
    assert "\u091c\u0935\u093e\u092c" in fallback_reply("hindi")     # "answer" in Hindi
    assert fallback_reply("Telugu") == fallback_reply("English")     # Telugu is not supported: the English sentence


class _Conversation:
    turns = []
    def get_summaries_block(self):
        return ""


class _Knowledge:
    def get_context(self):
        return ""


def test_the_retry_prompt_forbids_repeating_the_message():
    responder = ResponderAgent(client=None, conversation=_Conversation(), knowledge=_Knowledge())
    prompt = responder.build_prompt(AgentContext(user_message="hello there", metadata={"no_echo": True}))
    assert "previous attempt repeated" in prompt
    assert "never repeat or restate" in prompt


# ---- a reply that starts by mirroring the user is an answer, not an echo ------------------------------------------

import asyncio

from domain.policies.echo_policy import EchoHold, is_exact_echo

HINDI_LIKE_BOOKS = "मुझे किताबें पढ़ना पसंद है"
HINDI_ME_TOO = "मुझे भी किताबें पढ़ना पसंद है।"
HINDI_FOLLOW_UP = "क्या आपको कोई खास किताब पसंद है?"


def test_a_me_too_sentence_is_similar_but_not_an_exact_echo():
    assert is_echo(HINDI_ME_TOO, HINDI_LIKE_BOOKS)          # still looks like the message ...
    assert not is_exact_echo(HINDI_ME_TOO, HINDI_LIKE_BOOKS)  # ... but it is not the user's own words


def test_a_mirroring_first_sentence_is_held_then_released_with_the_real_answer():
    hold = EchoHold(HINDI_LIKE_BOOKS)
    assert hold.feed(HINDI_ME_TOO) == ([], False) and hold.pending
    released, echoed = hold.feed(HINDI_FOLLOW_UP)
    assert released == [HINDI_ME_TOO, HINDI_FOLLOW_UP] and not echoed and not hold.pending


def test_a_reply_that_ends_on_the_mirroring_sentence_is_an_echo():
    hold = EchoHold(HINDI_LIKE_BOOKS)
    hold.feed(HINDI_ME_TOO)
    assert hold.pending            # the caller treats a stream that ends here as an echo


def test_more_echo_after_the_held_sentence_is_an_echo():
    hold = EchoHold(HINDI_LIKE_BOOKS)
    hold.feed(HINDI_ME_TOO)
    assert hold.feed(HINDI_LIKE_BOOKS + "।") == ([], True)


def test_the_users_own_words_and_a_continuation_are_echoes_at_once():
    assert EchoHold(HINDI).feed(HINDI) == ([], True)
    assert EchoHold(HINDI_ASK).feed(HINDI_DONE) == ([], True)


def test_an_ordinary_first_sentence_is_released_immediately_with_no_delay():
    hold = EchoHold("how far is the moon from the earth")
    assert hold.feed("About 384,000 kilometres.") == (["About 384,000 kilometres."], False)
    assert hold.feed("That is far.") == (["That is far."], False)


class _StreamModel:
    """Stands in for the base LLM stream: yields the reply a few characters at a time."""
    def __init__(self, text):
        self.text = text

    async def __call__(self, ctx, cancel_event=None):
        for i in range(0, len(self.text), 4):
            yield self.text[i:i + 4]


def _run_responder(monkeypatch, user, reply):
    from service.agent.base_llm_agent import LLMAgent
    saved = []
    monkeypatch.setattr(LLMAgent, "execute_stream", lambda self, ctx, cancel_event=None: _StreamModel(reply)(ctx, cancel_event))

    async def _done(self, ctx, text):
        saved.append(text)
    monkeypatch.setattr(ResponderAgent, "on_completion", _done)
    responder = ResponderAgent(client=None, conversation=_Conversation(), knowledge=_Knowledge(), reply_veto=lambda s: False)
    ctx = AgentContext(user_message=user, metadata={"language": "Hindi"})

    async def run():
        return [c async for c in responder.execute_stream(ctx)]
    return "".join(asyncio.run(run())), ctx, saved


def test_the_hindi_me_too_reply_is_spoken_instead_of_being_replaced_by_the_fallback(monkeypatch):
    reply = HINDI_ME_TOO + " " + HINDI_FOLLOW_UP
    text, ctx, saved = _run_responder(monkeypatch, HINDI_LIKE_BOOKS, reply)
    assert HINDI_ME_TOO.strip() in text and HINDI_FOLLOW_UP in text
    assert fallback_reply("Hindi") not in text and not ctx.metadata.get("no_echo")


def test_a_real_echo_is_still_replaced_by_the_fixed_fallback_sentence(monkeypatch):
    text, ctx, saved = _run_responder(monkeypatch, HINDI_LIKE_BOOKS, HINDI_LIKE_BOOKS + "।")
    assert text.strip() == fallback_reply("Hindi") and saved == [fallback_reply("Hindi")]
    assert ctx.metadata.get("no_echo")             # it was retried once before giving up
