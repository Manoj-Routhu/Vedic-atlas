"""LlamaCppClient — InferencePort implementation via llama-cpp-python.

★ New, no donor equivalent. Grounded in ADR-001 (llama.cpp as the
advanced/Pi fallback backend) and ADR-008 (single quantized SLM, Q5_K_M
preferred). Loads a local GGUF file directly — no server process. Fails
loudly at construction if the model file is missing rather than
attempting any network fetch, per the "no runtime auto-download when
offline_mode is enforced" rule (REQ-M-02).

Thinking-mode suppression (`think=False`, the default): unlike OllamaClient,
llama-cpp-python's `create_chat_completion` has no `think`/`enable_thinking`
parameter of its own — Qwen3's chat template reacts to a `/no_think` marker
placed in the conversation text instead (the model's own documented
fallback for engines that don't support template-level thinking control).
That alone isn't fully reliable (a truncated generation can still leave a
dangling `<think>` block), so every return path also strips any
`<think>...</think>` block as a safety net - belt and suspenders, not
either/or.
"""

from __future__ import annotations

import asyncio
import re
import threading
import time
from pathlib import Path
from typing import AsyncIterator

from core.logging_config import logger
from domain.ports.inference_port import InferencePort, InferenceTimeoutError

_THINK_OPEN = "<think>"
_THINK_CLOSE = "</think>"
_THINK_BLOCK_RE = re.compile(r"<think>.*?</think>\s*", re.DOTALL)
_UNCLOSED_THINK_RE = re.compile(r"<think>.*", re.DOTALL)


def _one_entry_per_system_prompt(llama_cpp, llama, capacity_bytes: int):
    """A LlamaRAMCache that keeps ONE entry per system prompt.

    llama-cpp-python stores a new entry after every call, so each control turn added another ~370 MB copy of the same
    control prefix and the oldest entries - the chat and narrate prefixes - were evicted to make room. A new entry that
    shares the WHOLE system turn with an old one serves every later prompt of that kind just as well, so the old one is
    dropped. "Whole system turn" = the shared prefix holds a second ChatML <|im_start|> (the user turn's); for a model
    without that token nothing is replaced and the cache behaves as before.

    Entries come from `_lean_save_state`, so they carry no logits copy (see there)."""
    ids = llama.tokenize(b"<|im_start|>", add_bos=False, special=True)
    turn_start = ids[0] if len(ids) == 1 else None

    class _Cache(llama_cpp.LlamaRAMCache):
        def __setitem__(self, key, value):
            key = tuple(key)
            if turn_start is not None:
                for old in list(self.cache_state):
                    shared = llama_cpp.Llama.longest_token_prefix(old, key)
                    if old != key and key[:shared].count(turn_start) >= 2:
                        del self.cache_state[old]
            if key in self.cache_state:
                del self.cache_state[key]
            self.cache_state[key] = value
            # The library drops the OLDEST entry when the cache is full. Every turn stores the control prompt first and the chat /
            # narrate prompt after it, so the control prompt becomes the oldest entry at the worst moment, and losing it means
            # re-reading ~3,000 tokens (about 157 s at the Pi's measured 19 tok/s). It is by far the longest prompt, so it is the
            # one entry that is never evicted; the shorter chat / narrate entries are rebuilt cheaply.
            pinned = max(self.cache_state, key=len)
            while self.cache_size > self.capacity_bytes and len(self.cache_state) > 1:
                victim = next(k for k in self.cache_state if k != pinned)
                dropped = self.cache_state.pop(victim)
                logger.warning(
                    f"[llm] prompt cache full ({self.capacity_bytes // 1048576} MB): dropped a {len(victim)}-token entry "
                    f"({dropped.llama_state_size // 1048576} MB) to keep the {len(pinned)}-token control prompt"
                )
            if self.cache_size > self.capacity_bytes:     # the control prompt alone does not fit: the cache cannot help
                logger.warning(
                    f"[llm] prompt_cache_mb={self.capacity_bytes // 1048576} is smaller than the control prompt's cached state "
                    f"({self.cache_size // 1048576} MB): every turn will re-read it. Raise prompt_cache_mb."
                )
                self.cache_state.clear()

    return _Cache(capacity_bytes=capacity_bytes)


def _lean_save_state(llama_cpp, llama):
    """Llama.save_state for the prompt cache, without its copies (bound onto the instance).

    The library's version allocates the state (~400 MB for the control prompt), copies it to a compact buffer, then to
    `bytes`, and also copies the logits buffer (n_batch x n_vocab float32, ~311 MB for Qwen3): ~1.5 GB of RAM for a
    moment on every call. With the vision model loaded that spike got it OOM-killed (2026-10-27 23:23). Here the state
    is written once into one buffer, and the logits are one zero row: the cache's size limit never counted them (4
    entries held ~1.2 GB more than prompt_cache_mb), and restoring an entry sets `_requires_eval`, so llama-cpp-python
    re-evaluates the last token instead of reading them; the one row broadcasts in load_state's assignment."""
    import ctypes

    import numpy as np

    def save_state():
        size = llama_cpp.llama_state_get_size(llama._ctx.ctx)
        buf = (ctypes.c_uint8 * int(size))()
        n = int(llama_cpp.llama_state_get_data(llama._ctx.ctx, buf, size))
        if n > int(size):
            raise RuntimeError("Failed to copy llama state data")
        return llama_cpp.llama.LlamaState(
            scores=np.zeros((1, llama._n_vocab), dtype=np.single),
            input_ids=llama.input_ids.copy(),
            n_tokens=llama.n_tokens,
            llama_state=buf,   # load_state copies the first `llama_state_size` bytes out of it
            llama_state_size=n,
            seed=llama._seed,
        )

    return save_state


class LlamaCppClient:
    """Implements InferencePort by loading a local GGUF model via llama-cpp-python."""

    def __init__(
        self,
        model_path: str | Path,
        n_ctx: int = 4096,
        n_threads: int | None = None,
        timeout: float = 120.0,
        num_predict: int = 512,
        think: bool = False,
        prompt_cache_mb: int = 0,
        use_mmap: bool = True,
        model_lock: threading.Lock | None = None,
        flash_attn: bool = False,
        kv_cache_type: str = "f16",
    ):
        path = Path(model_path)
        if not path.exists():
            raise FileNotFoundError(
                f"GGUF model not found at {path} — this build does not auto-download models. "
                "Run the installer's model-fetch step first."
            )
        import llama_cpp  # imported lazily so this module can be inspected without the dependency installed

        extra: dict = {}
        kv = (kv_cache_type or "f16").strip().lower()
        if kv not in ("f16", "q8_0"):
            raise ValueError(f"kv_cache_type must be 'f16' or 'q8_0', not {kv_cache_type!r}")
        if kv == "q8_0":
            # An 8-bit KV cache halves the memory of the context AND of every cached prompt (the control prompt's entry:
            # ~527 MB -> ~263 MB on the Pi). llama.cpp can only quantise the V cache with flash attention on.
            extra.update(type_k=llama_cpp.GGML_TYPE_Q8_0, type_v=llama_cpp.GGML_TYPE_Q8_0)
            flash_attn = True
        if flash_attn:
            extra["flash_attn"] = True
        self._llama = llama_cpp.Llama(
            model_path=str(path), n_ctx=n_ctx, n_threads=n_threads, use_mmap=use_mmap, verbose=False, **extra
        )
        if extra:
            logger.info(f"[llm] flash_attn={bool(flash_attn)} kv_cache_type={kv}")
        if prompt_cache_mb > 0:
            # The context only reuses its KV cache when consecutive prompts share a start. Veda alternates between
            # chat, routing and tool-call prompts, each with a long fixed prefix, so every call re-read its whole
            # prompt. A RAM cache of evaluated prefixes lets each prompt type reuse its own prefix.
            self._llama.save_state = _lean_save_state(llama_cpp, self._llama)
            self._llama.set_cache(_one_entry_per_system_prompt(llama_cpp, self._llama, prompt_cache_mb * 1024 * 1024))
        self._timeout = timeout
        self._num_predict = num_predict
        self._think = think
        # A llama.cpp context is not thread-safe. A call that timed out (asyncio.wait_for) is only abandoned by the
        # event loop: its worker thread keeps decoding. This lock is held by that thread, so the next call waits for
        # it instead of decoding on the same context at the same time (which crashes the whole server).
        # Pass ONE lock to every llama.cpp instance on this CPU (main LLM + router model). It is a THREAD lock on
        # purpose: a call abandoned by a timeout keeps decoding in its worker thread after the asyncio-level lock
        # (SingleFlight) has been released, and only this lock stops the next call from starting on top of it.
        self._model_lock = model_lock or threading.Lock()

    @property
    def name(self) -> str:
        return "llama_cpp"

    def _prompt_messages(self, prompt: str, system: str) -> list[dict]:
        if not self._think:
            # Qwen3's documented soft-switch for engines (like raw
            # llama-cpp-python) that don't expose chat-template-level
            # thinking control.
            # Own line: appended to the user's words the model copied it into arguments (a task titled "/no_think").
            prompt = f"{prompt}\n/no_think"
        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})
        return messages

    @staticmethod
    def _strip_thinking(text: str, finished: bool = False) -> str:
        """Safety net: remove any <think>...</think> block, or an unclosed
        one if generation was cut off mid-thought, that slipped through
        despite the /no_think prompt directive.

        `finished` = the model stopped by itself (finish_reason "stop"), not at the token limit. Qwen3 sometimes opens
        `<think>` under /no_think and then writes its ANSWER without ever closing the tag
        (`<think>

Es ist 14:52 Uhr.`). Deleting everything after an unclosed tag threw that answer away (an empty
        reply, then retries). When the model finished on its own, the text after the tag is the answer and is kept;
        a generation cut off at the limit is still discarded, because that is unfinished reasoning."""
        text = _THINK_BLOCK_RE.sub("", text)
        if finished and _THINK_OPEN in text:
            return text.replace(_THINK_OPEN, "", 1).strip()
        text = _UNCLOSED_THINK_RE.sub("", text)
        return text.strip()

    async def complete(
        self,
        prompt: str,
        system: str = "",
        model: str | None = None,
        timeout: int | None = None,
        *,
        num_predict: int | None = None,
        json_schema: dict | None = None,
        temperature: float | None = None,
    ) -> str:
        # llama-cpp-python's create_chat_completion is synchronous/blocking —
        # run it off the event loop so it doesn't stall other coroutines.
        # service/inference/single_flight.py is what guarantees only one call
        # runs at a time (it did not exist when this file was first written).
        kwargs: dict = {
            "messages": self._prompt_messages(prompt, system),
            "max_tokens": num_predict if num_predict is not None else self._num_predict,
        }
        if temperature is not None:
            kwargs["temperature"] = temperature
        if json_schema is not None:
            # Grammar-constrained decoding: the model cannot emit anything that
            # isn't valid JSON for this schema.
            kwargs["response_format"] = {"type": "json_object", "schema": json_schema}
        def _run():
            with self._model_lock:
                self._perf_reset()
                started = time.perf_counter()
                result = self._llama.create_chat_completion(**kwargs)
                self._log_perf(result, started, grammar=json_schema is not None)
                return result

        try:
            result = await asyncio.wait_for(asyncio.to_thread(_run), timeout=timeout or self._timeout)
        except asyncio.TimeoutError as exc:
            raise InferenceTimeoutError(f"llama.cpp request timed out: {exc}") from exc
        choice = result["choices"][0]
        content = choice["message"]["content"]
        return self._strip_thinking(content, finished=choice.get("finish_reason") == "stop") if not self._think else content

    def _perf_reset(self) -> None:
        try:
            import llama_cpp
            llama_cpp.llama_perf_context_reset(self._llama.ctx)
        except Exception:
            pass

    def _log_perf(self, result: dict, started: float, *, grammar: bool) -> None:
        """One line per call: prompt tokens in total vs actually evaluated (a prefix-cache hit evaluates few), the
        evaluation speed, the generated tokens and their speed. Diagnostic only; never raises."""
        try:
            import llama_cpp
            perf = llama_cpp.llama_perf_context(self._llama.ctx)
            usage = result.get("usage", {})
            cache = getattr(self._llama, "cache", None)
            logger.info(
                f"[llm] total_ms={int((time.perf_counter() - started) * 1000)} prompt_tokens={usage.get('prompt_tokens')} "
                f"evaluated={perf.n_p_eval} in {perf.t_p_eval_ms:.0f}ms reused={perf.n_reused} | generated={usage.get('completion_tokens')} "
                f"in {perf.t_eval_ms:.0f}ms | grammar={grammar} | cache_entries="
                f"{len(cache.cache_state) if cache is not None and hasattr(cache, 'cache_state') else '-'} "
                f"cache_mb={int(cache.cache_size / 1048576) if cache is not None and hasattr(cache, 'cache_size') else '-'}"
            )
        except Exception as e:
            logger.debug(f"[llm] perf unavailable: {e}")

    def count_tokens(self, text: str) -> int:
        """Exact token count with this model's own tokenizer (used for prompt budgets)."""
        return len(self._llama.tokenize(text.encode("utf-8"), add_bos=False))

    async def stream(
        self,
        prompt: str,
        system: str = "",
        model: str | None = None,
        cancel_event: asyncio.Event | None = None,
        *,
        num_predict: int | None = None,
    ) -> AsyncIterator[str]:
        # llama-cpp-python's streaming generator is synchronous; drain it on a
        # worker thread and forward chunks through an asyncio.Queue.
        queue: asyncio.Queue = asyncio.Queue()
        loop = asyncio.get_event_loop()
        max_tokens = num_predict if num_predict is not None else self._num_predict

        def _produce():
            try:
                with self._model_lock:   # waits for any abandoned (timed-out) call still decoding
                    for chunk in self._llama.create_chat_completion(
                        messages=self._prompt_messages(prompt, system), stream=True, max_tokens=max_tokens
                    ):
                        if cancel_event is not None and cancel_event.is_set():
                            break  # cancelled (e.g. the user muted): stop burning CPU on a reply nobody will hear
                        delta = chunk["choices"][0]["delta"].get("content", "")
                        if delta:
                            loop.call_soon_threadsafe(queue.put_nowait, delta)
            finally:
                loop.call_soon_threadsafe(queue.put_nowait, None)

        asyncio.get_event_loop().run_in_executor(None, _produce)

        if self._think:
            # Nothing to filter - pass chunks through as they arrive.
            while True:
                if cancel_event is not None and cancel_event.is_set():
                    return
                item = await queue.get()
                if item is None:
                    return
                yield item
            return

        # Safety-net filtering: suppress any text between <think> and
        # </think>, tolerating the tag being split across chunk boundaries
        # by holding back a short tail until we're sure it isn't half a tag.
        in_think = False
        pending = ""
        while True:
            if cancel_event is not None and cancel_event.is_set():
                return
            item = await queue.get()
            if item is None:
                if pending and not in_think:
                    yield pending
                return
            pending += item
            while True:
                if in_think:
                    idx = pending.find(_THINK_CLOSE)
                    if idx == -1:
                        pending = ""  # still inside the think block - discard
                        break
                    pending = pending[idx + len(_THINK_CLOSE):]
                    in_think = False
                    continue
                idx = pending.find(_THINK_OPEN)
                if idx == -1:
                    # Hold back a short tail in case "<think>" is split
                    # across this chunk and the next one.
                    safe_len = max(0, len(pending) - len(_THINK_OPEN))
                    if safe_len > 0:
                        yield pending[:safe_len]
                        pending = pending[safe_len:]
                    break
                if idx > 0:
                    yield pending[:idx]
                pending = pending[idx + len(_THINK_OPEN):]
                in_think = True
