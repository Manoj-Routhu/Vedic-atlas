"""DispatchPolicy — what to do with a ControlDecision. Pure; fails closed.

Table (first match wins):

  invalid output, or calls that name no real tool        -> FAIL_CLOSED  fixed apology, nothing runs
  calls non-empty                                        -> TOOLS        the model's own clarification, if any, is asked AFTER the tool answer
  ... a destructive call in a multi-call is HELD (never runs; the user is asked to say it on its own)
  ... a call whose target argument is only a pronoun/ordinal/filler is HELD (asks which one)
  ... a destructive call whose target the user never named is HELD (asks which one)
      the other calls still run and the question follows their answer; when EVERY call is held -> CLARIFY, nothing runs
  calls empty, clarification text                        -> CLARIFY      ask, no further model call
  calls empty, needs_live_data is True                   -> REFUSE       fixed refusal, NEVER free chat
  otherwise                                              -> CHAT         (needs_live_data False, or no flag)

The decision itself was made by the model after reading the message (principle P1). The ONE place the message is
consulted is the last veto above: a destructive call is only run if the user's own words name its target
(destructive_policy.target_is_explicit). That is a fail-closed check on the model's output, never a way to pick or
force a tool.
"""

from dataclasses import dataclass
from enum import Enum
from typing import Mapping

from domain.entities.control_decision import ControlDecision
from domain.entities.tool_manifest import ToolManifest
from domain.policies.destructive_policy import is_destructive, target_is_explicit, target_names_nothing
from domain.policies.tool_call_schema import MAX_CALLS

REFUSAL_REPLY = "I can't look that up right now."
UNPARSEABLE_REPLY = "Sorry, I didn't catch that. Could you say it again?"
ONE_AT_A_TIME_REPLY = "I'll do that one step at a time. What should I do first?"
TARGET_REQUIRED_REPLY = "Which one do you mean?"
SEPARATELY_REPLY = "I'll handle the other request on its own. Please say it again by itself."   # asked after the rest ran


class Route(str, Enum):
    TOOLS = "tools"
    CLARIFY = "clarify"
    CHAT = "chat"
    REFUSE = "refuse"
    FAIL_CLOSED = "fail_closed"


@dataclass(frozen=True)
class Resolution:
    route: Route
    calls: tuple[dict, ...] = ()
    text: str = ""    # the reply for CLARIFY / REFUSE / FAIL_CLOSED
    advise: bool = False       # carried from the decision for TOOLS only; the route table never reads it
    also_chat: bool = False
    follow_up: str = ""       # TOOLS only: a question to ask AFTER the tool answer (held calls, or the model's own clarification)


def _usable_calls(calls, manifests: Mapping[str, ToolManifest], max_calls: int) -> list[dict]:
    """Real tools only, object args, exact duplicates dropped, capped. (The grammar already guarantees this
    for the constrained decode; a second protocol or a future bug must not be able to bypass it.)"""
    out: list[dict] = []
    for c in calls:
        if not isinstance(c, dict) or c.get("tool") not in manifests or not isinstance(c.get("args"), dict):
            continue
        item = {"tool": c["tool"], "args": c["args"]}
        if item not in out:
            out.append(item)
    return out[:max_calls]


def resolve(
    decision: ControlDecision, manifests: Mapping[str, ToolManifest], *, max_calls: int = MAX_CALLS, user_message: str | None = None,
) -> Resolution:
    if not decision.valid:
        return Resolution(Route.FAIL_CLOSED, text=UNPARSEABLE_REPLY)

    if decision.calls:
        calls = _usable_calls(decision.calls, manifests, max_calls)
        if not calls:
            return Resolution(Route.FAIL_CLOSED, text=UNPARSEABLE_REPLY)
        multi = len(calls) > 1
        runnable: list[dict] = []
        held: list[str] = []   # why each held call did not run
        for c in calls:
            m = manifests[c["tool"]]
            if multi and is_destructive(m, c["args"]):
                held.append(SEPARATELY_REPLY)           # destructive tools never join a multi-call
            elif target_names_nothing(m, c["args"]):
                held.append(TARGET_REQUIRED_REPLY)      # "mark it as done": a pronoun is not a target
            elif user_message is not None and not target_is_explicit(m, c["args"], user_message):
                held.append(TARGET_REQUIRED_REPLY)      # a guessed or inherited target never runs
            else:
                runnable.append(c)
        if not runnable:
            return Resolution(Route.CLARIFY, text=ONE_AT_A_TIME_REPLY if SEPARATELY_REPLY in held else TARGET_REQUIRED_REPLY)
        follow_up = held[0] if held else (decision.clarification or "").strip()
        return Resolution(Route.TOOLS, calls=tuple(runnable), advise=decision.advise, also_chat=decision.also_chat, follow_up=follow_up)

    question = (decision.clarification or "").strip()
    if question:
        return Resolution(Route.CLARIFY, text=question)
    if decision.needs_live_data is True:
        return Resolution(Route.REFUSE, text=REFUSAL_REPLY)
    return Resolution(Route.CHAT)
