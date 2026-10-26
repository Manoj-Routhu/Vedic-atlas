"""ReplyPolicy — how each executed call becomes part of the reply. Pure.

  failed call                         -> FAILED   deterministic failure text; a result is never invented
  template tool, or `final` result    -> SPOKEN   the tool's own sentence, kept verbatim and NEVER sent to the model
  anything else (llm / document)      -> NARRATE  handed to the content stage, which sees only these results

So the number of content decodes does not scale with the number of calls: all NARRATE results share one.
"""

from typing import Iterable

from domain.entities.tool_manifest import REPLY_TEMPLATE

SPOKEN = "spoken"
NARRATE = "narrate"
FAILED = "failed"

TEMPLATE_MODE = "template"
ADVISE_MODE = "advise"

FAIL_REPLY = "I couldn't do that: {error}"
UNCONFIRMED_REPLY = "I can't confirm that I did that. Could you say it again?"


def classify_call(*, ok: bool, reply_mode: str, final: bool) -> str:
    if not ok:
        return FAILED
    if reply_mode == REPLY_TEMPLATE or final:
        return SPOKEN
    return NARRATE


def failure_text(error: str | None) -> str:
    return FAIL_REPLY.format(error=error or "blocked")


def spoken_text(spoken: str | None, observation: str) -> str:
    """The sentence for a SPOKEN call: the tool's own text, else the first line of its output."""
    if spoken:
        return spoken
    return observation.splitlines()[0] if observation else "Done."


def resolve_reply_mode(model_advise: bool, allow_advice: Iterable[bool]) -> str:
    """ADVISE only when the model asked for it AND every successful call's tool permits it (`allow_advice` in its
    manifest); otherwise TEMPLATE. All-or-nothing: one tool that must be read back literally (a task confirmation)
    keeps the whole turn on its own sentences. Configuration declares what is permitted; the model chooses within it."""
    permitted = list(allow_advice)
    return ADVISE_MODE if model_advise and permitted and all(permitted) else TEMPLATE_MODE
