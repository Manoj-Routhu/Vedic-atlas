"""Vision and devices are separate threads of the system (docs/15-vision-mobile-design.md section 3, rules I1/I2).

I1: vision/devices code may import only core, exceptions, schemas and its own modules. In particular nothing
    from memory, conversation, agents, sessions, voice, persistence or the inference clients.
I2: nothing outside bootstrap/, the CLI entry point and the dependency providers imports vision/devices code.

The checker is a pair of functions over (path, source) so it can be tested on deliberately bad code, not just
on the real tree. Imports are collected everywhere in a file, including inside functions and TYPE_CHECKING blocks.

Run: pytest tests/test_vision_isolation.py
"""

import ast
import re
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parents[1] / "src"
FIRST_PARTY = {p.name for p in SRC.iterdir() if p.is_dir() and not p.name.endswith(".egg-info") and p.name != "__pycache__"}

_NAME_TOKENS = {"vision", "device", "devices"}
_EXTRA_MODULES = {"controller/cli/pair.py"}   # `veda pair` / `veda devices`: part of the devices unit, named for the verb

# What vision/devices code may import (whole dotted segments). Everything else first-party is forbidden.
_ALLOWED_PREFIXES = (
    "core", "exceptions", "schemas",
    "domain.entities.vision", "domain.entities.device",
    "domain.ports.vision_port", "domain.ports.device_registry_port",
    "domain.policies.device_scope_policy",
    "service.vision", "service.devices",
    "tpa.vision", "tpa.filestore.json_device_registry",
)
# Web-layer files of the unit may also use the controller package (routes, middleware, SSE helpers, providers).
_CONTROLLER_LAYER_EXTRA = ("controller",)

# The only places allowed to know the unit exists: wiring, the CLI entry point, the Depends() providers.
_ALLOWED_IMPORTERS = ("bootstrap/", "controller/cli/__main__.py", "controller/dependencies/providers.py")


def _rel(path: Path) -> str:
    return path.relative_to(SRC).as_posix()


def is_unit_file(rel: str) -> bool:
    """True for files of the vision or devices unit: a path component whose name tokens include vision/device(s)."""
    if rel in _EXTRA_MODULES:
        return True
    parts = rel[:-3].split("/") if rel.endswith(".py") else rel.split("/")
    return any(_NAME_TOKENS & set(part.split("_")) for part in parts)


def module_name(rel: str) -> str:
    mod = rel[:-3].replace("/", ".")
    return mod[: -len(".__init__")] if mod.endswith(".__init__") else mod


def _is_module(dotted: str) -> bool:
    base = SRC.joinpath(*dotted.split("."))
    return base.with_suffix(".py").exists() or (base / "__init__.py").exists()


def imported_modules(source: str) -> set[str]:
    """Every absolute first-party module a file imports. `from pkg import name` counts as pkg.name only when
    pkg/name is a module (not a class or function), otherwise as pkg."""
    found: set[str] = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            found.update(a.name for a in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            for alias in node.names:
                child = f"{node.module}.{alias.name}"
                found.add(child if _is_module(child) else node.module)
    return {m for m in found if m.split(".")[0] in FIRST_PARTY}


def _under(module: str, prefix: str) -> bool:
    return module == prefix or module.startswith(prefix + ".")


def forbidden_imports(rel: str, source: str) -> list[str]:
    """I1: first-party imports of a unit file that are not on the allow-list."""
    allowed = _ALLOWED_PREFIXES
    if rel.startswith(("controller/", "bootstrap/")):
        allowed = allowed + _CONTROLLER_LAYER_EXTRA
    return [mod for mod in sorted(imported_modules(source)) if not any(_under(mod, p) for p in allowed)]


def unit_importers(rel: str, source: str, unit_modules: set[str]) -> list[str]:
    """I2: unit modules imported by a file that is not part of the unit and not an allowed importer."""
    if is_unit_file(rel) or rel.startswith(_ALLOWED_IMPORTERS):
        return []
    return sorted(m for m in imported_modules(source) if any(_under(m, u) for u in unit_modules))


def _all_sources() -> dict[str, str]:
    return {_rel(p): p.read_text(encoding="utf-8") for p in SRC.rglob("*.py") if "egg-info" not in str(p)}


# ---------- the real tree ----------

def test_the_unit_files_are_found():
    rels = [r for r in _all_sources() if is_unit_file(r)]
    for expected in (
        "domain/entities/vision.py", "domain/ports/vision_port.py", "service/devices/device_service.py",
        "controller/middleware/device_auth.py", "controller/routes/devices.py", "controller/cli/pair.py",
        "tpa/filestore/json_device_registry.py",
    ):
        assert expected in rels, expected
    assert "tpa/audio/sounddevice_capture.py" not in rels   # a name containing "device" is not the unit


def test_vision_and_devices_import_only_what_they_may():
    problems = {rel: bad for rel, src in _all_sources().items() if is_unit_file(rel) and (bad := forbidden_imports(rel, src))}
    assert not problems, f"I1 violated (vision/devices code reaching into other subsystems): {problems}"


def test_nothing_else_imports_vision_or_devices():
    sources = _all_sources()
    unit_modules = {module_name(r) for r in sources if is_unit_file(r)}
    problems = {rel: bad for rel, src in sources.items() if (bad := unit_importers(rel, src, unit_modules))}
    assert not problems, f"I2 violated (a subsystem depends on vision/devices): {problems}"


# ---------- the checker itself: it must actually catch violations ----------

@pytest.mark.parametrize("forbidden", [
    "import service.memory.knowledge_base",
    "from service.conversation.conversation_manager import ConversationManager",
    "from service.agent.supervisor import SupervisorAgent",
    "from service.session.session_state import SessionStateService",
    "from service.voice import voice_session",
    "from tpa.persistence.session import SessionLocal",
    "from tpa.inference.llama_cpp_client import LlamaCppClient",
    "from domain.ports.inference_port import InferencePort",
    "from domain.ports.memory_repository_port import MemoryRepositoryPort",
])
def test_checker_flags_forbidden_imports_anywhere_in_a_file(forbidden):
    top_level = forbidden + "\n"
    inside_function = f"def f():\n    {forbidden}\n"
    type_checking = f"from typing import TYPE_CHECKING\nif TYPE_CHECKING:\n    {forbidden}\n"
    for source in (top_level, inside_function, type_checking):
        assert forbidden_imports("service/vision/vision_service.py", source), source


def test_checker_allows_the_permitted_imports():
    source = (
        "from core.enums import ExceptionCode\nfrom exceptions.exception import AppException\n"
        "from schemas.config_schemas import VisionConfig\nfrom domain.ports.vision_port import VisionPort\n"
        "from domain.entities import vision\nfrom service.vision.vision_service import VisionService\n"
    )
    assert forbidden_imports("service/vision/vision_service.py", source) == []


def test_only_the_web_layer_of_the_unit_may_use_controller():
    source = "from controller.dependencies.providers import get_vision\n"
    assert forbidden_imports("controller/routes/vision.py", source) == []
    assert forbidden_imports("service/vision/vision_service.py", source) == ["controller.dependencies.providers"]


def test_checker_flags_a_subsystem_importing_vision():
    unit = {"service.vision.vision_service", "domain.ports.vision_port"}
    assert unit_importers("service/agent/supervisor.py", "from service.vision.vision_service import VisionService\n", unit)
    assert unit_importers("service/memory/recall.py", "from domain.ports import vision_port\n", unit) == ["domain.ports.vision_port"]
    assert unit_importers("bootstrap/container.py", "from service.vision.vision_service import VisionService\n", unit) == []
    assert unit_importers("service/agent/supervisor.py", "import json\nfrom core.config import load_full_config\n", unit) == []
