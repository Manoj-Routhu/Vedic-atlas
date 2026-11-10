"""SSE streaming route — streams Supervisor/sub-agent responses in real-time.

Donor: veda/routes/stream.py, read in full. Vision dropped (see chat.py's
docstring for the same rationale). SSE encoding moved to
controller/sse/encoder.py; the disconnect-watch/response-header plumbing
moved to controller/sse/stream_adapter.py — both shared with ambient.py.

Events on the wire:
  data: <text>            a piece of the reply (no event name); the phone appends it
  event: filler / data:   an "I'm working on it" phrase while the model works (same phrases and timing as the voice,
                          service/agent/filler_schedule.py). Display only: never saved, never in the model's history
  data: [DONE]            the reply is complete
"""

import asyncio

from fastapi import APIRouter, Depends, Request

from controller.dependencies.providers import get_filler_settings, get_supervisor
from controller.sse.encoder import sse_encode
from controller.sse.stream_adapter import sse_response, watch_disconnect
from domain.entities.agent_context import AgentContext
from domain.policies.language_policy import language_of
from schemas.chat import StreamRequest
from service.agent.filler_schedule import FillerSettings, filler_phrases
from service.agent.supervisor import SupervisorAgent

router = APIRouter()

_TEXT, _FILLER, _END, _FAILED = "text", "filler", "end", "failed"


@router.post("/stream")
async def stream_chat(
    req: StreamRequest,
    request: Request,
    supervisor: SupervisorAgent = Depends(get_supervisor),
    fillers: FillerSettings | None = Depends(get_filler_settings),
):
    """Stream the Supervisor's response via Server-Sent Events."""
    from_device = getattr(request.state, "device_id", None) is not None
    ctx = AgentContext(
        user_message=req.message,
        # A paired phone may not inject prompt text or pose as the voice pipeline (device_scope_policy).
        system_context="" if from_device else (req.system_context or "")[:2000],
        from_voice=False if from_device else req.from_voice,
        session_id=req.session_id,
    )
    cancel_event = asyncio.Event()
    hindi = language_of(req.message) == "Hindi"

    async def event_generator():
        watcher = asyncio.create_task(watch_disconnect(request, cancel_event))
        reply_started = asyncio.Event()      # set by the first piece of reply; ends the fillers
        queue: asyncio.Queue = asyncio.Queue()

        async def pump_reply() -> None:
            try:
                async for chunk in supervisor.execute_stream(ctx, cancel_event=cancel_event):
                    if cancel_event.is_set():
                        break
                    if chunk:
                        reply_started.set()
                        await queue.put((_TEXT, chunk))
                await queue.put((_END, None))
            except asyncio.CancelledError:
                raise
            except BaseException as e:   # re-raised below, in the response, exactly as before
                await queue.put((_FAILED, e))
            finally:
                reply_started.set()

        async def pump_fillers() -> None:
            first, later = fillers.phrases_for(hindi)
            async for phrase in filler_phrases(
                reply_started, first=first, later=later, first_delay_sec=fillers.first_delay_sec,
                repeat_sec=fillers.repeat_sec, max_count=fillers.max_count,
            ):
                if reply_started.is_set():
                    return
                await queue.put((_FILLER, phrase))

        tasks = [asyncio.create_task(pump_reply())]
        if fillers is not None:
            tasks.append(asyncio.create_task(pump_fillers()))
        try:
            while True:
                kind, value = await queue.get()
                if kind == _TEXT:
                    yield sse_encode(value)
                elif kind == _FILLER:
                    yield sse_encode(value, event="filler")
                elif kind == _FAILED:
                    raise value
                else:
                    break
            if not cancel_event.is_set():
                yield sse_encode("[DONE]")
        finally:
            cancel_event.set()
            reply_started.set()
            for task in (watcher, *tasks):
                task.cancel()
            for task in (watcher, *tasks):
                try:
                    await task
                except (asyncio.CancelledError, Exception):
                    pass

    return sse_response(event_generator())
