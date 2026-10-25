"""Application lifespan: boot checks, start/stop of every long-running subsystem."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI

from core.config import active_profile, ensure_dirs, load_full_config
from core.env import load_env
from core.logging_config import configure_logging, logger
from tpa.persistence.migrations import init_tables

from bootstrap.background import backfill_memory_index, housekeeping_loop
from bootstrap.container import build_app_state


_GOOGLE_HINTS = {
    "not_linked": "not signed in: run `veda login` (mail and calendar answer \"isn't set up\" until then)",
    "rejected": "Google refused the saved sign-in (expired or revoked): run `veda login`",
    "needs_permission": "the saved sign-in lacks permission for: {scopes}: run `veda login` to grant it",
    "unreachable": "could not reach Google to check the sign-in (offline?); it will be tried again when used",
}


async def log_google_status(auth) -> None:
    """One line at boot saying whether mail/calendar will work, and exactly how to fix it if not. Never blocks or raises."""
    try:
        status = await asyncio.wait_for(auth.status(), timeout=15)
    except Exception as e:
        logger.info(f"[google] sign-in not checked ({type(e).__name__})")
        return
    state = status.get("state", "ok")
    if state == "ok":
        logger.info("[google] sign-in OK (mail, calendar, reminders)")
    else:
        logger.warning("[google] " + _GOOGLE_HINTS.get(state, state).format(scopes=", ".join(status.get("missing_scopes", []))))


@asynccontextmanager
async def lifespan(app: FastAPI):
    load_env()
    cfg = load_full_config()
    configure_logging(cfg.app.log_level)
    logger.info(
        f"[config] profile={active_profile() or 'base (none set)'} model={cfg.inference.model_path} "
        f"n_ctx={cfg.inference.n_ctx} max_history={cfg.app.max_history} chat_summaries={cfg.app.chat_summaries} "
        f"chat_persona={cfg.app.chat_persona}"
    )
    ensure_dirs()
    init_tables()

    build_app_state(app)

    # Fail loudly here if the configured model isn't importable, rather than
    # 404-ing on the user's first turn with an opaque error.
    client = app.state.inference_backend
    if cfg.inference.verify_on_boot and hasattr(client, "verify_ready"):
        try:
            await client.verify_ready()
            logger.info(f"[inference] model {cfg.inference.model_alias!r} ready on {cfg.inference.backend}")
        except Exception as e:
            logger.error(f"[inference] NOT READY: {e}")

    if cfg.inference.warmup_on_boot and hasattr(client, "warmup"):
        try:
            await client.warmup()
            logger.info("[inference] warmed up")
        except Exception as e:
            logger.warning(f"[inference] warmup skipped: {e}")

    if cfg.inference.warmup_on_boot:
        await app.state.orchestrator.warmup()  # pre-evaluate the control prefix so the first real turn is not cold

    # Must start inside the running loop — the gate captures it so a
    # mute transition raised on a hardware thread can still reach the bus.
    try:
        app.state.capture_gate.start()
    except Exception as e:
        logger.error(f"CaptureGate failed to start: {e}")

    try:
        app.state.conversation_summariser.start()
    except Exception as e:
        logger.warning(f"ConversationSummariser failed to start: {e}")

    app.state.task_purge_job = asyncio.create_task(housekeeping_loop(app.state.task_service, app.state.trace_repo, app.state.session_state))

    if getattr(app.state, "memory_indexer", None) is not None and app.state.memory_indexer.enabled:
        asyncio.create_task(backfill_memory_index(app))

    if app.state.voice_session is not None:
        try:
            app.state.voice_session.start()
        except Exception as e:
            logger.error(f"VoiceSession failed to start: {e}")

    if getattr(app.state, "google_auth", None) is not None:
        asyncio.create_task(log_google_status(app.state.google_auth))

    if getattr(app.state, "reminders", None) is not None:
        app.state.reminders.start()   # after the voice loop, so its first announcement can already be spoken
        logger.info("[reminders] started")

    if getattr(app.state, "vision", None) is not None:
        try:
            await app.state.vision.start()   # does not load the model: that happens on the first photo
        except Exception as e:
            logger.warning(f"Vision failed to start: {e}")

    yield

    if getattr(app.state, "vision", None) is not None:
        try:
            await app.state.vision.stop()   # also stops the model process
        except Exception as e:
            logger.warning(f"Vision failed to stop cleanly: {e}")

    if getattr(app.state, "reminders", None) is not None:
        try:
            await app.state.reminders.stop()
        except Exception as e:
            logger.warning(f"Reminders failed to stop cleanly: {e}")

    if getattr(app.state, "voice_session", None) is not None:
        try:
            await app.state.voice_session.stop()
        except Exception as e:
            logger.warning(f"VoiceSession failed to stop cleanly: {e}")

    app.state.task_purge_job.cancel()
    try:
        await app.state.conversation_summariser.stop()
    except Exception:
        pass
    try:
        app.state.capture_gate.stop()
    except Exception as e:
        logger.warning(f"CaptureGate failed to stop cleanly: {e}")

    recognizer = getattr(app.state, "speaker_recognizer", None)
    if recognizer is not None:
        try:
            recognizer.stop()
        except Exception:
            pass

    from core.constants import TEMP_DIR
    if TEMP_DIR.exists():
        for f in TEMP_DIR.iterdir():
            f.unlink(missing_ok=True)
