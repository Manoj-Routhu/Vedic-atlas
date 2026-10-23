"""The FastAPI application: exception handlers, middleware, routers and the root route."""

from __future__ import annotations

from fastapi import FastAPI

from controller.middleware.request_context import request_context
from controller.routes import (
    admin, approval, config as config_route, governance as governance_route,
    google as google_route, health, knowledge, lookup, persona, privacy, reminders as reminders_route, speakers, stream,
    tasks as tasks_route, trace as trace_route, voice,
)
from core.constants import PROJECT_NAME, VERSION
from core.logging_config import logger
from exceptions.handlers import register_exception_handlers

from bootstrap.lifespan import lifespan


app = FastAPI(title=PROJECT_NAME, version=VERSION, lifespan=lifespan)
register_exception_handlers(app)
app.middleware("http")(request_context)
logger.info(f"{PROJECT_NAME} v{VERSION} application initialized")

for _mod in (
    admin, approval, config_route, governance_route,
    google_route, health, knowledge, lookup, persona, privacy, reminders_route, speakers, stream, tasks_route, trace_route, voice,
):
    app.include_router(_mod.router, prefix="/api")


@app.get("/", include_in_schema=False)
async def _root() -> dict:
    """Headless build — the Pi target has no browser (ADR-008). The API and
    the `veda` CLI are the interfaces; the Angular SPA was removed."""
    return {
        "name": PROJECT_NAME,
        "version": VERSION,
        "interfaces": ["REST /api/*", "CLI: veda"],
        "docs": "/docs",
    }
