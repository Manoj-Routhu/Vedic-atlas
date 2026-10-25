"""Vision config: defaults are off, the model server can only be loopback, VEDA_DEVICE overlays merge after VEDA_PROFILE,
and the files named in config/vision.yaml are what was downloaded.

Run: pytest tests/test_vision_config.py
"""

import hashlib

import pytest
from pydantic import ValidationError

import core.config as config
import core.env as env_module
from core.constants import PROJECT_ROOT
from schemas.config_schemas import VisionConfig


@pytest.fixture(autouse=True)
def _isolated(monkeypatch, tmp_path):
    monkeypatch.delenv("VEDA_PROFILE", raising=False)
    monkeypatch.delenv("VEDA_DEVICE", raising=False)
    monkeypatch.setattr(env_module, "PROJECT_ROOT", tmp_path)   # no real .env
    config._full_config_cache = None
    yield
    config._full_config_cache = None


def test_vision_is_off_in_code_and_switched_on_by_config_vision_yaml():
    assert VisionConfig().enabled is False   # a missing section never turns the camera model on
    assert config.load_full_config().vision.enabled is True   # config/vision.yaml turns it on


def test_yaml_values_load():
    cfg = config.load_full_config().vision
    assert cfg.port == 8081 and cfg.host == "127.0.0.1"
    assert cfg.model_path.endswith("Qwen3VL-2B-Instruct-Q4_K_M.gguf")
    assert cfg.mmproj_path.endswith("mmproj-Qwen3VL-2B-Instruct-Q8_0.gguf")
    assert cfg.binary_path is None   # per machine: only a hardware overlay sets it


@pytest.mark.parametrize("host", ["0.0.0.0", "192.168.1.5", "localhost", "example.com", ""])
def test_model_server_host_must_be_a_loopback_ip(host):
    with pytest.raises(ValidationError):
        VisionConfig(host=host)


@pytest.mark.parametrize("host", ["127.0.0.1", "::1", "127.0.0.2"])
def test_loopback_hosts_are_accepted(host):
    assert VisionConfig(host=host).host == host


@pytest.mark.parametrize("field,value", [
    ("port", 0), ("port", 70000), ("n_ctx", 0), ("image_max_edge_px", -1), ("upload_max_bytes", 0),
    ("idle_unload_seconds", 0), ("min_headroom_mb", -1), ("n_threads", 0), ("max_new_tokens", 0),
])
def test_bad_numbers_are_rejected(field, value):
    with pytest.raises(ValidationError):
        VisionConfig(**{field: value})


def test_laptop_overlay_sets_the_binary_and_threads(monkeypatch):
    monkeypatch.setenv("VEDA_DEVICE", "laptop")
    cfg = config.load_full_config().vision
    assert cfg.binary_path.endswith("llama-server.exe")
    assert cfg.n_threads == 6


def test_pi_overlay_limits_vision_and_the_main_models_prompt_cache(monkeypatch):
    monkeypatch.setenv("VEDA_DEVICE", "pi")
    cfg = config.load_full_config()
    assert cfg.vision.n_threads == 2 and cfg.vision.image_max_edge_px == 768
    assert cfg.inference.prompt_cache_mb == 128   # base value is 768


def test_overlay_does_not_touch_the_base_when_unset():
    cfg = config.load_full_config()
    assert cfg.inference.prompt_cache_mb == 768
    assert cfg.vision.n_threads is None


def test_hardware_overlay_merges_after_the_model_profile(monkeypatch):
    monkeypatch.setenv("VEDA_PROFILE", "qwen3-0.6b")
    monkeypatch.setenv("VEDA_DEVICE", "pi")
    cfg = config.load_full_config()
    assert "0.6B" in cfg.inference.model_path   # the model profile still applies
    assert cfg.inference.prompt_cache_mb == 128   # and the machine overlay on top of it


def test_unknown_device_fails_loudly(monkeypatch):
    monkeypatch.setenv("VEDA_DEVICE", "toaster")
    with pytest.raises(FileNotFoundError):
        config.load_full_config()


def test_downloaded_model_files_match_the_configured_hashes():
    """Only runs where the models were downloaded (data/ is not in git)."""
    cfg = config.load_full_config().vision
    for path, expected in ((cfg.model_path, cfg.model_sha256), (cfg.mmproj_path, cfg.mmproj_sha256)):
        file = PROJECT_ROOT / path
        if not file.exists():
            pytest.skip(f"{path} not downloaded here")
        h = hashlib.sha256()
        with open(file, "rb") as f:
            for block in iter(lambda: f.read(1 << 20), b""):
                h.update(block)
        assert h.hexdigest() == expected, path
