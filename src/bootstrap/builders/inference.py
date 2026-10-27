"""Inference client and embedding provider builders."""

from __future__ import annotations

import asyncio
from pathlib import Path

from core.logging_config import logger
from schemas.config_schemas import AppConfig
from service.inference.graceful_degradation import GracefulDegradation
from service.inference.single_flight import SingleFlight
from tpa.inference.factory import build_inference_client


def build_inference(cfg: AppConfig, governance, lock: asyncio.Lock | None = None, thread_lock=None):
    """Returns (wrapped_client, raw_backend).

    The raw backend is returned alongside because boot-time helpers
    (`verify_ready`, `warmup`) are adapter-specific and deliberately not
    part of InferencePort — the wrappers shouldn't have to know about them.
    """
    icfg = cfg.inference
    # Resolve relative to PROJECT_ROOT, not the process cwd — same pattern
    # build_stt already uses for its model path. Unexercised until now:
    # the ollama backend never reads model_path at all, so this relative-
    # path bug had no way to surface before llama_cpp was first used.
    model_path = icfg.model_path
    if model_path and not Path(model_path).is_absolute():
        from core.constants import PROJECT_ROOT
        model_path = str(PROJECT_ROOT / model_path)
    primary = build_inference_client(
        backend=icfg.backend,
        ollama_host=icfg.ollama_host,
        model_alias=icfg.model_alias,
        llama_cpp_model_path=model_path,
        n_ctx=icfg.n_ctx,
        n_threads=icfg.n_threads,
        num_batch=icfg.num_batch,
        num_predict=icfg.num_predict,
        temperature=icfg.temperature,
        keep_alive=icfg.keep_alive,
        think=icfg.think,
        timeout=icfg.timeout,
        prompt_cache_mb=icfg.prompt_cache_mb,
        use_mmap=icfg.use_mmap,
        model_lock=thread_lock,
    )
    on_success = (lambda name: governance.record_success(name)) if governance else None
    on_failure = (lambda name: governance.record_failure(name)) if governance else None
    # SingleFlight is innermost so the serialisation guarantee holds even
    # when GracefulDegradation retries or switches backends.
    wrapped = GracefulDegradation(
        primary=SingleFlight(primary, lock=lock), on_success=on_success, on_failure=on_failure
    )
    return wrapped, primary


def build_embedding(cfg: AppConfig):
    ecfg = cfg.embedding
    if not ecfg.enabled:
        return None
    try:
        from core.constants import PROJECT_ROOT
        from tpa.inference.embedding_adapter import OnnxEmbeddingProvider

        path = Path(ecfg.model_path or "data/bge-small-en-v1.5")
        model_dir = path if path.is_absolute() else PROJECT_ROOT / path
        provider = OnnxEmbeddingProvider(
            model_dir=model_dir, model_id=ecfg.model_id, pooling=ecfg.pooling, max_tokens=ecfg.max_tokens
        )
        logger.info(f"[embedding] model {provider.model_id!r} ready ({model_dir.name})")
        return provider
    except Exception as e:
        logger.warning(f"[embedding] unavailable - semantic memory is OFF (recent history only): {e}")
        return None
