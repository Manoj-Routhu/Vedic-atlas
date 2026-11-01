"""Measure the language model on THIS machine, the way Veda uses it, and say what to change.

    python scripts/bench_llm.py                    # your config (threads, mmap), context sizes 40 / 1000 / 2000 / 3000
    python scripts/bench_llm.py --quick            # 40 and 1000 only (a few minutes on a Pi)
    python scripts/bench_llm.py --compare-kv       # also: flash attention, and flash attention + 8-bit KV cache
    python scripts/bench_llm.py --threads 2,4      # try thread counts

Stop the Veda server first (it holds the model, and timings would be wrong). Nothing is written to disk.

What it reports, per setting and context size:
  read     prompt tokens per second the first time a prompt is read (a cache miss: the cost Veda pays when the cache is empty)
  write    tokens per second generated, with the control JSON grammar, once the prompt is cached (the normal case)
  state    the memory one cached prompt of that size takes (this is what prompt_cache_mb has to hold)
and then projects a control decision (read ~150 new tokens + generate ~25) and checks your prompt_cache_mb.

On a Raspberry Pi the 3000-token rows take minutes each (the first read runs at ~19 tok/s): that is why --quick exists.
"""

from __future__ import annotations

import argparse
import platform
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

NEW_TOKENS_PER_TURN = 150      # history + state + date + message re-read each turn (measured live)
GENERATED_PER_DECISION = 25    # tokens in a typical control answer


def simd_verdict(info: str) -> str:
    machine = platform.machine().lower()
    if machine in ("amd64", "x86_64"):
        missing = [f for f in ("AVX2", "FMA") if f"{f} = 1" not in info]
        return "OK" if not missing else f"SLOW BUILD: this library lacks {', '.join(missing)}, which this CPU very likely has (3-6x slower)"
    if machine in ("aarch64", "arm64"):
        if "NEON = 1" not in info:
            return "SLOW BUILD: no NEON reported; rebuild llama-cpp-python natively (scripts/setup_pi.sh)"
        if "DOTPROD = 1" not in info and "MATMUL_INT8 = 1" not in info:
            return "SLOW BUILD: no DOTPROD/MATMUL_INT8, so the model's Q4_K weights cannot use llama.cpp's fast ARM kernels; rebuild with CMAKE_ARGS='-DGGML_NATIVE=ON'"
        return "OK"
    return "unknown CPU family"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--quick", action="store_true", help="context sizes 40 and 1000 only")
    ap.add_argument("--ctx", default="", help="comma list of context sizes (overrides --quick)")
    ap.add_argument("--threads", default="", help="comma list of generation thread counts to try (default: your config)")
    ap.add_argument("--compare-kv", action="store_true", help="also try flash attention and flash attention + 8-bit KV cache")
    ap.add_argument("--tokens", type=int, default=32, help="tokens to generate per measurement (default 32)")
    args = ap.parse_args()

    import llama_cpp

    from core.config import load_full_config
    from domain.policies.tool_call_schema import build_control_schema
    from tpa.filestore.yaml_tool_manifest_store import YamlToolManifestStore

    cfg = load_full_config()
    icfg = cfg.inference
    model = Path(icfg.model_path)
    model = model if model.is_absolute() else ROOT / model
    info = llama_cpp.llama_print_system_info().decode().strip()
    print(f"machine: {platform.machine()} | cpus: {__import__('os').cpu_count()} | model: {model.name}")
    print(f"llama.cpp: {info}")
    print(f"build check: {simd_verdict(info)}\n")

    ctxs = [int(x) for x in args.ctx.split(",")] if args.ctx else ([40, 1000] if args.quick else [40, 1000, 2000, 3000])
    threads = [int(x) for x in args.threads.split(",")] if args.threads else [icfg.n_threads]
    settings = [("f16 KV (today)", False, llama_cpp.GGML_TYPE_F16)]
    if args.compare_kv:
        settings += [("flash attention", True, llama_cpp.GGML_TYPE_F16), ("flash + 8-bit KV", True, llama_cpp.GGML_TYPE_Q8_0)]

    schema = build_control_schema(list(YamlToolManifestStore().load_all()))
    grammar = {"response_format": {"type": "json_object", "schema": schema}}
    filler = "Rule: a tool is called only when the user asks for what it does. " * 400
    rows = []
    for n_threads in threads:
        for label, flash, kv in settings:
            kwargs = dict(model_path=str(model), n_ctx=max(ctxs) + 600, n_threads=n_threads, use_mmap=icfg.use_mmap, verbose=False)
            if flash:
                kwargs["flash_attn"] = True
            if kv != llama_cpp.GGML_TYPE_F16:
                kwargs.update(type_k=kv, type_v=kv)
            llm = llama_cpp.Llama(**kwargs)
            for target in ctxs:
                system = "Decide what to do with the user's message. Reply with ONLY one JSON object.\n"
                if target > 100:
                    system += llm.detokenize(llm.tokenize(filler.encode(), add_bos=False)[:target]).decode(errors="ignore")
                msgs = [{"role": "system", "content": system}, {"role": "user", "content": "weather in Pune\n/no_think"}]
                llm.reset()
                t = time.perf_counter()
                first = llm.create_chat_completion(messages=msgs, max_tokens=2, temperature=0.0, **grammar)
                read_s = time.perf_counter() - t
                prompt_tokens = first["usage"]["prompt_tokens"]
                state_mb = int(llama_cpp.llama_state_get_size(llm._ctx.ctx)) / 1048576
                t = time.perf_counter()
                r = llm.create_chat_completion(messages=msgs, max_tokens=args.tokens, temperature=0.0, **grammar)
                write_s = time.perf_counter() - t
                made = r["usage"]["completion_tokens"]
                rows.append((n_threads, label, prompt_tokens, prompt_tokens / read_s, made / write_s, state_mb))
                print(f"threads={n_threads or 'default'} {label:16} prompt {prompt_tokens:5} tok | read {prompt_tokens / read_s:6.1f} tok/s | "
                      f"write {made / write_s:5.1f} tok/s | cached state {state_mb:5.0f} MB", flush=True)
            del llm

    print("\n--- projection for a control decision (read ~%d new tokens, write ~%d) -------------------------------" %
          (NEW_TOKENS_PER_TURN, GENERATED_PER_DECISION))
    big = max(r[2] for r in rows)
    for n_threads, label, tokens, read, write, state in rows:
        if tokens == big:
            total = NEW_TOKENS_PER_TURN / read + GENERATED_PER_DECISION / write
            print(f"threads={n_threads or 'default'} {label:16} at {tokens} tokens: ~{total:4.1f} s   "
                  f"(read {NEW_TOKENS_PER_TURN / read:4.1f} s + write {GENERATED_PER_DECISION / write:4.1f} s)   one cached prompt: {state:4.0f} MB")

    print("\n--- prompt cache check ------------------------------------------------------------------------------------")
    base = next((r for r in rows if r[2] == big), None)
    if base:
        per_token = base[5] / base[2]
        control = 2990 * per_token               # tokens in today's control prompt (see docs/06-configuration.md)
        others = (1500 + 500 + 120) * per_token  # chat (full history) + narrate + translate
        need = control + others
        have = icfg.prompt_cache_mb
        print(f"cached state: {per_token * 1024:.0f} KB per prompt token -> control prompt ~{control:.0f} MB; worst case with chat + narrate + translate ~{need:.0f} MB")
        print(f"prompt_cache_mb is {have}: " + ("fits everything." if have >= need else
              f"the control prompt always stays (it is never evicted); the others may be dropped and rebuilt. A bigger cache is not an option on the Pi; "
              "re-run with --compare-kv and, if it is not slower there, use kv_cache_type: q8_0 (halves this)."))
    return 0


if __name__ == "__main__":
    sys.exit(main())
