"""calendar_create — add one event to the user's calendar.

The model supplies three small values (`title`, `date_offset`, a 24-hour `time`); the date arithmetic, range checks, the
"already passed" check and the spoken confirmation are code (domain/policies/calendar_policy.py). The confirmation is read
back from the event the calendar returned, so the reply can never claim something that was not stored.

No attendees are ever set: adding an event cannot send anybody an invitation. An identical event (same title, same start)
is not added twice, so repeating the request is harmless.

When the user is answering this tool's own question ("What time should I set it for?" -> "10:30 PM"), the request and its
answers are checked together; "in 10 minutes" is worked out here from the clock.
"""

from __future__ import annotations

from datetime import datetime
from typing import Callable

from domain.entities.agent_context import AgentContext
from domain.entities.skill_result import SkillResult
from domain.entities.tool_manifest import ToolManifest
from domain.policies.calendar_policy import (
    asks_to_add, asks_to_change_not_add, day_label, earlier_request, event_times, message_states_duration,
    message_states_time, relative_start, same_event, spoken_created, title_is_from_the_message, validate_new_event,
)
from domain.ports.calendar_port import CalendarPort
from exceptions.exception import ToolUnavailableError
from service.skills.manifest_skill import ManifestSkill

_NO_WRITE_ACCESS = (401, 403)


class CalendarCreateSkill(ManifestSkill):
    what = "add that to your calendar"

    def __init__(
        self, calendar: CalendarPort, manifest: ToolManifest, now: Callable[[], datetime] = lambda: datetime.now().astimezone(),
        on_created: Callable[[], None] | None = None, **kw,
    ):
        super().__init__(manifest, **kw)
        self._calendar = calendar
        self._now = now
        self._on_created = on_created   # lets the reminder scheduler re-read the calendar at once

    async def run(self, ctx: AgentContext, title="", date_offset=0, time="", duration_minutes=None, **_) -> SkillResult:
        if asks_to_change_not_add(ctx.user_message):
            return self._fail("no tool to change events", "I can't move, cancel or delete calendar events yet, only add them.")
        now = self._now()
        earlier = earlier_request(ctx.conversation_history, now)
        said = " ".join([*earlier, ctx.user_message])
        if not earlier and not asks_to_add(ctx.user_message) and not message_states_time(ctx.user_message) \
                and relative_start(ctx.user_message, now) is None and not title_is_from_the_message(title, ctx.user_message):
            # Nothing in these words asks for an event: the model replayed an old request from the conversation.
            return self._fail("no calendar request in the message", "I didn't add anything to your calendar.")
        soon = relative_start(said, now)
        if soon is not None and not message_states_time(said):
            time, date_offset = soon.strftime("%H:%M"), (soon.date() - now.date()).days
            if not message_states_duration(said):
                duration_minutes = None   # "in 10 mins" is when it starts, not how long it lasts
        elif time and not message_states_time(said):
            time = ""   # the user named no time: the model's is a guess, so ask instead of booking it
        if title and not title_is_from_the_message(title, said):
            title = ""  # not the user's words (often an example copied from the prompt): ask what to call it
        try:
            name, offset, at, minutes = validate_new_event(title, date_offset, time, duration_minutes)
            start, end = event_times(now, offset, at, minutes)
        except ValueError as e:
            sentence = str(e)
            return self._fail(sentence, sentence if sentence.endswith("?") else sentence + ".")
        label = day_label(now, offset, 1)
        try:
            same_slot = await self._calendar.list_events(start, start.replace(second=59))
            clash = next((e for e in same_slot if same_event(e, name, start)), None)
            if clash is not None:
                text = spoken_created(clash, label, already=True)
                return self._ok(text, text)
            event = await self._calendar.create_event(name, start, end)
        except ToolUnavailableError as e:
            if e.status in _NO_WRITE_ACCESS:
                return self._fail(
                    e.message, "I don't have permission to add calendar events yet. Run veda login in the terminal to allow it.",
                )
            raise
        if self._on_created is not None:
            self._on_created()
        text = spoken_created(event, label)
        return self._ok(text, text)
