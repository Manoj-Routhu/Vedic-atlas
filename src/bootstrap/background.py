"""Background jobs started by the lifespan: memory indexing and housekeeping."""

from __future__ import annotations

import asyncio

from fastapi import FastAPI

from core.logging_config import logger


async def index_exchanges(app: FastAPI) -> None:
    """Index every saved question-and-answer that has no vector yet, and drop vectors whose turn is gone (the 30-day cleanup
    deletes old turns, and what was deleted must not stay recallable). Cheap after the first run: only the new ones embed."""
    from domain.policies.exchange_note_policy import exchange_note

    store, repo = app.state.vector_store, app.state.conversation_repo
    model_id = app.state.embedding_provider.model_id
    pairs = repo.exchanges()
    existing = store.ref_ids(source="exchange", model_id=model_id)
    stale = existing - {str(turn_id) for turn_id, *_ in pairs}
    if stale:
        store.delete_refs(source="exchange", ref_ids=stale)
    added = 0
    for turn_id, _sid, question, answer, _when in pairs:
        note = exchange_note(question, answer)
        if note and str(turn_id) not in existing and await app.state.memory_indexer.index("exchange", str(turn_id), note):
            added += 1
    logger.info(f"[memory-index] exchanges: {added} indexed, {len(stale)} stale removed")


async def backfill_memory_index(app: FastAPI) -> None:
    """Index existing facts and summaries once at startup (best-effort, background)."""
    indexer = getattr(app.state, "memory_indexer", None)
    store = getattr(app.state, "vector_store", None)
    if indexer is None or store is None or not indexer.enabled:
        return
    try:
        store.clear("fact")
        for i, fact in enumerate(app.state.knowledge.list_facts()):
            await indexer.index("fact", str(i), fact)
        for summ in app.state.conversation_repo.recent_summaries(limit=1000):
            await indexer.index("summary", str(summ.id), summ.content, skip_existing=True)
        await index_exchanges(app)
        logger.info("[memory-index] backfill complete")
    except Exception as e:
        logger.warning(f"[memory-index] backfill failed: {e}")


async def housekeeping_loop(task_service, trace_repo, session_state=None, interval_sec: float = 3600.0) -> None:
    """Hourly: drop completed tasks and old tool-turn traces past their retention windows."""
    from datetime import datetime, timedelta

    from domain.policies.retention_policy import TURN_TRACE_RETENTION_DAYS

    while True:
        try:
            removed = task_service.purge_completed()
            if removed:
                logger.info(f"[tasks] purged {removed} completed task(s)")
            old = trace_repo.purge_before(datetime.now() - timedelta(days=TURN_TRACE_RETENTION_DAYS))
            if old:
                logger.info(f"[trace] purged {old} old tool-turn trace(s)")
            if session_state is not None:
                expired = session_state.purge_expired()
                if expired:
                    logger.info(f"[session-state] purged {expired} expired row(s)")
        except Exception as e:
            logger.warning(f"[housekeeping] failed: {e}")
        await asyncio.sleep(interval_sec)
