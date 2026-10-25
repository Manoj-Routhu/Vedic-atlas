"""The Control endpoints of the mock Pi: tasks, microphone, reminders, persona, proactivity, voice and recent activity.

These are stand-ins held in memory, but their responses have the same shape as the real routes (src/controller/routes/
tasks.py, privacy.py, reminders.py, persona.py, config.py, voice.py, trace.py), so the app meets the real wire format. The
permission rules are not here: the real DeviceAuthMiddleware in front of them decides who may call what.
"""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from schemas.persona import PERSONA_CATALOG, PersonaUpdateRequest

_VALID_PROACTIVITY = ["conservative", "medium", "chatty"]


class _TaskCreate(BaseModel):
    title: str
    notes: str = ""


class _Mute(BaseModel):
    muted: bool


class _Proactivity(BaseModel):
    level: str


class _ReminderConfig(BaseModel):
    enabled: bool | None = None
    lead_minutes: list[int] | None = None
    at_start: bool | None = None
    skip_all_day: bool | None = None


class MockControlState:
    def __init__(self) -> None:
        self.tasks: list[dict] = [
            {"id": 1, "title": "Call mum", "done": False, "notes": "", "due_at": None},
            {"id": 2, "title": "Buy milk", "done": False, "notes": "", "due_at": None},
        ]
        self.next_task_id = 3
        self.muted = False
        self.persona = "friend"
        self.proactivity = "medium"
        self.reminders = {"enabled": True, "lead_minutes": [15], "at_start": True, "skip_all_day": True}


def make_control_router(state: MockControlState) -> APIRouter:
    router = APIRouter()

    # ---- tasks ----
    @router.get("/tasks")
    async def list_tasks(include_done: bool = False):
        return {"tasks": [t for t in state.tasks if include_done or not t["done"]]}

    @router.post("/tasks")
    async def add_task(body: _TaskCreate):
        task = {"id": state.next_task_id, "title": body.title, "done": False, "notes": body.notes, "due_at": None}
        state.next_task_id += 1
        state.tasks.append(task)
        return task

    @router.post("/tasks/{task_id}/complete")
    async def complete_task(task_id: int):
        for task in state.tasks:
            if task["id"] == task_id and not task["done"]:
                task["done"] = True
                return {"status": "completed", "id": task_id}
        raise HTTPException(status_code=404, detail="task not found")

    # ---- microphone ----
    def snapshot() -> dict:
        return {
            "muted": state.muted,
            "source": "api" if state.muted else "boot",
            "hardware_switch": False,
            "since": datetime.now().isoformat(),
            "egress_allow_list": [],
        }

    @router.get("/privacy/status")
    async def privacy_status():
        return snapshot()

    @router.post("/privacy/mute")
    async def set_mute(body: _Mute):
        state.muted = body.muted
        return snapshot()

    @router.get("/voice/status")
    async def voice_status():
        return {"available": True, "running": not state.muted}

    # ---- reminders ----
    @router.get("/reminders/status")
    async def reminders_status():
        return {
            "running": True,
            "last_sync_at": datetime.now().isoformat(timespec="seconds"),
            "last_sync_ok": True,
            "pending": 1,
            "queued_to_say": 0,
            "next_due_at": None,
            "config": dict(state.reminders),
        }

    @router.get("/reminders/config")
    async def reminders_config():
        return dict(state.reminders)

    @router.put("/reminders/config")
    async def set_reminders_config(body: _ReminderConfig):
        changes = body.model_dump(exclude_none=True)
        leads = changes.get("lead_minutes")
        if leads is not None and (not leads or any(not 1 <= m <= 120 for m in leads)):
            raise HTTPException(status_code=422, detail="lead times must be between 1 and 120 minutes")
        state.reminders.update(changes)
        return dict(state.reminders)

    # ---- persona and proactivity ----
    @router.get("/persona")
    async def get_persona():
        return {"state": {"persona": state.persona, "completed": True}, "catalog": [p.model_dump() for p in PERSONA_CATALOG]}

    @router.post("/persona")
    async def set_persona(body: PersonaUpdateRequest):
        if body.persona is not None:
            info = next((p for p in PERSONA_CATALOG if p.id == body.persona), None)
            if info is None:
                raise HTTPException(status_code=400, detail=f"unknown persona '{body.persona}'")
            state.persona = info.id
            state.proactivity = info.proactivity
        return {"state": {"persona": state.persona, "completed": True}}

    @router.get("/config/proactivity")
    async def get_proactivity():
        return {"level": state.proactivity, "valid": _VALID_PROACTIVITY}

    @router.post("/config/proactivity")
    async def set_proactivity(body: _Proactivity):
        if body.level not in _VALID_PROACTIVITY:
            raise HTTPException(status_code=400, detail=f"level must be one of {_VALID_PROACTIVITY}")
        state.proactivity = body.level
        return {"level": state.proactivity, "valid": _VALID_PROACTIVITY}

    # ---- recent activity ----
    @router.get("/trace")
    async def recent_traces(limit: int = 20):
        calls = [
            {"tool": "weather", "args": {"city": "Pune"}, "ok": True, "ms": 1100, "result": "sunny", "error": None},
            {"tool": "set_reminder", "args": {}, "ok": True, "ms": 400, "result": "done", "error": None},
        ]
        traces = [
            {
                "id": i, "request_id": f"mock-{i}", "created_at": datetime.now().isoformat(timespec="seconds"), "agent": "main",
                "user_message": "x", "reply": "y", "decided": "tool", "forced": False, "narrated": False,
                "total_ms": 1500, "calls": [calls[i % 2]],
            }
            for i in range(3, 0, -1)
        ]
        return {"traces": traces[: max(1, min(limit, 200))]}

    return router
