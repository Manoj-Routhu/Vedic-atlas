"""The prompt cache must never evict the control prompt.

On the Pi, one cached control prompt (~3,000 tokens) is ~527 MB of the 768 MB cache, and every turn stores the control prompt first
and the chat / narrate prompt after it. The library drops the OLDEST entry when full, which was the control prompt: the next turn
then re-read ~3,000 tokens at the measured 19 tok/s (about 157 s).
"""

import logging
from types import SimpleNamespace

import pytest

llama_cpp = pytest.importorskip("llama_cpp")

from tpa.inference.llama_cpp_client import LlamaCppClient, _one_entry_per_system_prompt  # noqa: E402

MB = 1024 * 1024
TURN_START = 999


def _cache(capacity_mb):
    fake_llama = SimpleNamespace(tokenize=lambda *a, **k: [TURN_START])
    return _one_entry_per_system_prompt(llama_cpp, fake_llama, capacity_mb * MB)


def _state(mb):
    return SimpleNamespace(llama_state_size=mb * MB)


def _key(length, tag):
    """A distinct prompt of `length` tokens that contains one turn marker (so it counts as a different system prompt)."""
    return tuple([tag] + [TURN_START] + list(range(tag * 10_000, tag * 10_000 + length - 2)))


def test_everything_that_fits_is_kept():
    cache = _cache(768)
    cache[_key(3000, 1)] = _state(527)
    cache[_key(500, 2)] = _state(88)
    assert len(cache.cache_state) == 2 and cache.cache_size == 615 * MB


def test_the_control_prompt_survives_a_chat_prompt_that_does_not_fit_beside_it(caplog):
    cache = _cache(768)
    control, narrate, chat = _key(3000, 1), _key(500, 2), _key(1500, 3)
    cache[narrate] = _state(88)            # an older turn
    cache[control] = _state(527)           # this turn's decision
    with caplog.at_level(logging.WARNING, logger="veda"):
        cache[chat] = _state(264)          # stored right after it: 527 + 88 + 264 = 879 > 768
    assert control in cache.cache_state    # the old behaviour dropped the control prompt here
    assert cache.cache_size <= 768 * MB
    assert "dropped a" in caplog.text and "control prompt" in caplog.text


def test_the_oldest_short_entry_goes_first():
    cache = _cache(700)
    control, older, newer = _key(3000, 1), _key(400, 2), _key(300, 3)
    cache[older] = _state(70)
    cache[control] = _state(527)
    cache[newer] = _state(60)              # 657 fits: nothing dropped
    assert {older, control, newer} <= set(cache.cache_state)
    cache[_key(300, 4)] = _state(60)       # 717 > 700: the OLDEST short entry is dropped, never the control prompt
    assert control in cache.cache_state and older not in cache.cache_state and newer in cache.cache_state


def test_a_cache_too_small_for_the_control_prompt_says_so_and_holds_nothing(caplog):
    cache = _cache(256)
    with caplog.at_level(logging.WARNING, logger="veda"):
        cache[_key(3000, 1)] = _state(527)
    assert cache.cache_state == {} or len(cache.cache_state) == 0
    assert "Raise prompt_cache_mb" in caplog.text


def test_a_newer_prompt_with_the_same_system_text_still_replaces_the_old_one():
    cache = _cache(768)
    old = (1, 2, TURN_START, 5, 6, TURN_START, 7)
    new = (1, 2, TURN_START, 5, 6, TURN_START, 8, 9)
    cache[old] = _state(10)
    cache[new] = _state(10)
    assert list(cache.cache_state) == [new]


def test_an_unknown_kv_cache_type_is_refused_before_loading_a_model(tmp_path):
    model = tmp_path / "m.gguf"
    model.write_bytes(b"")
    with pytest.raises(ValueError, match="kv_cache_type"):
        LlamaCppClient(model_path=model, kv_cache_type="q4_0")


def test_shipped_defaults_change_nothing_about_how_the_model_loads():
    from core.config import load_full_config
    cfg = load_full_config().inference
    assert cfg.flash_attn is False and cfg.kv_cache_type == "f16"
