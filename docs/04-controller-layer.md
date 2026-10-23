# Controller Layer

`src/controller/` is the HTTP/terminal boundary: FastAPI routes, SSE
streaming plumbing, request middleware, dependency providers, and a
separate terminal CLI client. `src/bootstrap/` — the composition root that
wires every adapter and boots the FastAPI app — is covered at the end of
this document since it's the thing that makes the controller layer
runnable.

## Routes (`controller/routes/`, all mounted under `/api`)

| File | Router | Endpoints |
|---|---|---|
| `admin.py` | — | `POST /admin/shutdown` — sends `SIGINT` to the server's own process after a short delay (lets the response flush first; uvicorn handles `SIGINT` for clean teardown) |
| `approval.py` | — | `POST /approval/{id}/approve`; `POST /approval/{id}/deny`; `GET /approval/pending`; `POST /approval/yolo/on`; `POST /approval/yolo/off`; `GET /approval/yolo` |
| `config.py` | — | `GET /config/proactivity`; `POST /config/proactivity` (400 on an invalid value) |
| `governance.py` | `prefix="/governance"` | `GET /governance/status`; `GET /governance/audit/stats`. Duck-types via `hasattr()` since the provider can be `None` |
| `health.py` | — | `GET /health` — duck-types `supervisor`/`event_bus`/`governance`, separately probes the DB with `SELECT 1`. Deliberately never 503s itself — it's the "what's broken" endpoint |
| `knowledge.py` | — | `GET /knowledge`; `POST /knowledge`; `DELETE /knowledge/{index}` |
| `lookup.py` | — | `GET /lookup/health` (live probe of geocoding, weather, currency, web search — incl. whether the API key is set) |
| `persona.py` | — | `GET /persona`; `POST /persona` — persists to `data/cli_persona.json` (flat file, not the DB); on change, calls `ambient_dispatcher.set_proactivity()` to sync |
| `privacy.py` | — | `GET /privacy/status`; `POST /privacy/mute`; `POST /privacy/mute/toggle` |
| `speakers.py` | — | `GET /speakers`; `POST /speakers/enroll/start|feed|finish|cancel`; `DELETE /speakers/{name}` — speaker enrolment (no CLI command yet) |
| `stream.py` | — | `POST /stream` — SSE chat streaming via `supervisor.execute_stream()` |
| `tasks.py` | — | `GET /tasks`; `POST /tasks`; `POST /tasks/{id}/complete` |
| `trace.py` | — | `GET /trace?limit=N` — recent tool turns: what was asked, every tool call with its real result, guard decisions, stage timings, prompt tokens |
| `voice.py` | — | `GET /voice/status` (read-only). Mute control lives under `/privacy`; the voice session starts and stops with the server |

## Dependency injection (`dependencies/providers.py`)

Typed `Depends()` accessors reading off `request.app.state`:

```python
def _require(request: Request, attr: str, label: str):
    obj = getattr(request.app.state, attr, None)
    if obj is None:
        raise HTTPException(status_code=503, detail=f"{label} not initialized")
    return obj
```

`get_supervisor`, `get_ambient_dispatcher`, `get_approval_broker`, `get_knowledge_base`,
`get_trace_repo`, `get_lookup_health`, `get_task_service` and
`get_speaker_enrollment_service` are required (503 if missing).
`get_governance` is optional — it returns `None` without a 503, and the
calling route must handle that case (governance can be disabled by config). Note that `privacy.py` and `voice.py` don't use this module —
they define their own local `_require`-style dependency inline, reading
`app.state.capture_gate`/`app.state.voice_session` directly.

## Middleware (`middleware/request_context.py`)

```python
async def request_context(request: Request, call_next):
    set_request_id(uuid.uuid4().hex[:8])
    return await call_next(request)
```

Registered via `app.middleware("http")(request_context)` in `bootstrap/app.py`.
Generates an 8-character hex ID per request and pushes it into
`core.logging_config`'s `ContextVar`, so every log line emitted while
handling that request carries a consistent ID — this replaces a
concurrency bug where a single mutable instance attribute was shared
across concurrent requests.

## Server-Sent Events (`controller/sse/`)

- **`encoder.py` — `sse_encode(payload: str) -> str`**: splits the payload
  on newlines, emits `data: <line>\n` per line, terminated by a blank
  line — so multi-line text survives SSE framing instead of truncating at
  the first embedded newline.
- **`stream_adapter.py`**: `SSE_HEADERS` (`Cache-Control: no-cache`,
  `Connection: keep-alive`, `X-Accel-Buffering: no`); `sse_response(generator)`
  wraps an async string generator as a `StreamingResponse`;
  `watch_disconnect(request, cancel_event)` polls `request.is_disconnected()`
  every 0.25s in a background task and sets the cancel event the moment
  the client drops, so in-flight inference in `stream.py`/`ambient.py` can
  cancel immediately rather than waiting for a failed send.

## The CLI (`controller/cli/`) — a separate terminal client

This is **not** a second code path into the business logic — it's a
terminal UI that talks to the FastAPI server exclusively over HTTP/SSE,
same as any other client would.

- **`__main__.py`**: argparse entry point for `veda ...`. Subcommands:
  `hello`, `server`, `persona`, `approve`, `config`, `status`, `mute`,
  `unmute`, `listen`, `task`, `doctor` (health of the online tools), `trace [n]`
  (what the tools actually did on the last n turns). No subcommand + interactive TTY → launches
  the REPL. No subcommand + piped stdin → one-shot chat with the piped
  text. Bare positional text → one-shot streaming chat.
- **`client.py` — `VedaClient`**: sync `httpx.Client` wrapper, base URL
  from `VEDA_SERVER_URL` env var (default `http://127.0.0.1:8000`).
  `ensure_up()` makes sure a server answers and says what it did in `client.how`:
  **reused** (already running: left alone), **waited** (an earlier `veda` spawned one that is still loading the model:
  wait for it, never start a second; its pid is kept in `data/veda-server-<port>.pid`), **started** (spawned
  `python -m uvicorn bootstrap.app:app` with `PYTHONPATH` set to `src/` and Uvicorn access logs disabled) or **restarted**.
  The server answers only after the model is loaded and warmed (about a minute on a laptop, more on a Pi), so the wait is
  240 s (`VEDA_START_TIMEOUT`),
  progress is logged every 15 s, and if the server process dies the last lines of `data/veda-server.log` are shown at once.
  Bare `veda` continues a running server; `veda --restart` (or `VEDA_RESTART_ON_START=1`) first calls `stop_server()` for a
  fresh one (psutil finds the listener, refuses anything that is not recognisably a Veda server, tries
  `POST /api/admin/shutdown`, then terminates, then kills). One-shot commands (`veda task`, `veda doctor`,
  `veda "prompt"`) attach to a running server the same way. Wraps essentially every route
  above (`stream_chat`, `chat_one_shot`, persona/approval/task/status
  helpers).
- **`commands.py`**: `cmd_approve` (interactive y/n/skip loop, or `--id`/
  `--deny` for scripted use), `cmd_config`, `cmd_status`, plus mic/task
  helpers shared with the REPL.
- **`repl.py` — `Repl`**: `prompt_toolkit`-based interactive loop with
  slash commands (`/help`, `/quit`, `/clear`, `/persona`, `/status`,
  `/yolo on|off`, `/approve`, `/mute`, `/unmute`, `/listen`, `/task`, `/doctor`, `/trace [n]`);
  bare text is sent as chat via `client.stream_chat()`.
- **`server.py`**: `cmd_server(port, host)` — `veda server` runs
  `uvicorn.run("bootstrap.app:app", ...)` directly in-process; this one *is* the
  FastAPI app, not a client call to it.
- **`logo.py`** / **`render.py`**: ASCII/rich terminal rendering — a
  status-glyph banner and TTY-aware streaming token output (live update +
  final markdown re-render in a TTY; raw text when piped).

## Error handling at the controller boundary

The controller layer does **not** do its own try/except-per-route error
translation as a general pattern. It relies on
`exceptions/handlers.py`'s `register_exception_handlers(app)` — see
[05-exception-handling.md](05-exception-handling.md) for the full mapping.
Individual routes do still `raise HTTPException(...)` directly for
route-local semantic errors (404 on a missing approval/task, 400 on an
invalid persona/proactivity value) — these bypass the custom
`AppException` handler and go through FastAPI's native `HTTPException`
handling instead.

## Composition root (`src/bootstrap/`)

This is where every `domain/ports/` interface gets a concrete `tpa/`
adapter and the FastAPI app gets built. It sits above `controller`, `service` and `tpa`; nothing imports it.
The repo-root `server.py` is only the ASGI entry point (`from bootstrap.app import app`).

| Module | Holds |
|---|---|
| `bootstrap/app.py` | `app` — the FastAPI instance: exception handlers, middleware, routers, `GET /` |
| `bootstrap/lifespan.py` | `lifespan(app)` — boot checks, start and stop of every long-running subsystem |
| `bootstrap/container.py` | `build_app_state(app)` — builds every subsystem and attaches it to `app.state` |
| `bootstrap/background.py` | memory-index backfill and the hourly housekeeping loop |
| `bootstrap/builders/*.py` | the `build_*` functions below, one module per family |

`_IS_WINDOWS = platform.system() == "Windows"` gates the platform-specific adapter choices; it lives in
`builders/system.py` and `builders/tts.py` (tests patch it there).

### `build_*` functions (`bootstrap/builders/`)

| Function | Module | Wires | Selection logic |
|---|---|---|---|
| `build_system_control()` | `system` | `SystemControlPort` | Windows → `WindowsSystemAdapter`, else `LinuxSystemAdapter` |
| `build_notifier()` | `system` | `NotificationPort` | Windows → `DesktopNotifier`; else `None` |
| `build_mute_switch(cfg)` | `audio` | `MuteSwitchPort` | `privacy.mute_switch`: `software`/`keyboard`/`gpio`/`hid`; any construction/start failure falls back to `SoftwareMuteSwitch` |
| `build_indicator()` | `audio` | `IndicatorPort` | Tries `BlinkStickIndicator`; falls back to `SoftwareIndicator` |
| `build_audio_capture(cfg, frame_length=None)` | `audio` | `AudioCapturePort` | `SoundDeviceCapture`; `None` if `sounddevice` is missing or construction fails |
| `build_vad(cfg)` | `audio` | `VoiceActivityPort` | `audio.vad.engine == "webrtc"` → `WebRtcVadDetector`, else `EnergyVadDetector` (default) |
| `build_stt(cfg)` | `audio` | `STTPort` | `FasterWhisperProvider`; requires the model path to exist if configured — no download |
| `build_tts(cfg)` | `tts` | `TTSPort` | `audio.tts_engine`: `auto` (default) → `pyttsx3` on Windows, `piper` elsewhere; or an explicit `piper` / `pyttsx3`. Every requirement is checked at boot (the `piper` package, the voice file, `pyttsx3` being importable) and a problem is logged as an error with the fix and returns `None`, so voice stops at startup (`not started - missing: tts`) instead of staying silent. `tts_model_path` is resolved from the project root. Explicit `piper` with no voice falls back to `pyttsx3` on Windows only |
| `build_wake_word(cfg)` | `audio` | `WakeWordPort` | Off if disabled; `"hotkey"` → `HotkeyWakeWord`; `"porcupine"` → needs `PORCUPINE_ACCESS_KEY` env var + a keyword path, validates 16kHz |
| `build_voice_session(cfg, *, audio, capture_gate, supervisor, event_bus)` | `voice` | assembles `VoiceSession` | Off if `audio.voice_enabled` is `False`; refuses to start if mic, VAD, STT, TTS, or speaker is missing |
| `build_audit_sink(cfg)` | `safety` | `AuditSinkPort` | `NullAuditSink` unless `governance.enabled` and `governance.audit.backend == "sqlite"` → `SqliteAuditSink` |
| `build_inference(cfg, governance)` | `inference` | `InferencePort` | `build_inference_client(...)` wrapped in `SingleFlight(GracefulDegradation(...))`, hooked to `governance.record_success`/`record_failure` |
| `build_embedding(cfg)` | `inference` | `EmbeddingPort` | Off unless `embedding.enabled` → `OnnxEmbeddingProvider` from `embedding.model_path` (default `data/bge-small-en-v1.5`); a missing model logs "semantic memory is OFF" and returns `None` |
| `build_lookup(cfg, tool_manifests)` | `lookup` | — | Builds `AllowListedHttpClient`, registers `WeatherProvider`/`GeocodingProvider`/`FxProvider`/`TavilyProvider` into a `FactProviderRegistry`, returns a `LookupService` (with a `TtlCache` and per-category TTLs from the manifests) plus the Tavily provider (for the health probe) |
| `build_lookup_health(lookup, search, key_env)` | `lookup` | — | Probes for `veda doctor` / `GET /lookup/health`: geocoding, weather, currency, web_search (skipped, with a hint, when the API key is missing) |
| `build_guardrails(cfg)` | `safety` | — | Builds `PermissionManager`, `RateLimiter`, `InputValidator`, `OutputValidator`, `AuditLogger`; registers hooks onto a `HookRegistry` |
| `build_skills(cfg, hooks)` | `skills` | — | Registers `TerminalSkill`, `FileOpsSkill` into a `SkillRegistry`, returns `(registry, SkillRunner)` |
| `build_speaker(cfg)` | `audio` | speaker playback | `SpeakerPlayback`; `None` if unavailable |
| `build_speaker_id(cfg)` / `build_speaker_enrollment_service(cfg, audio)` | `speaker_id` | speaker recognition | per `audio.speaker_id.backend`; `None` (feature off) on any failure |
| `build_reminders(cfg, ...)` | `reminders` | `ReminderService` | `None` unless `reminders.enabled` |

### `build_app_state(app)` sequence (`container.py`)

1. Load config → `app.state.full_config`
2. `EventBus()` → `app.state.event_bus`
3. `ApprovalBroker(bus=event_bus)` → `app.state.approval_broker`
4. Build audit sink, then `build_governance(cfg.governance, audit_sink)` → `app.state.governance`
5. Build inference client + embedding provider → `app.state`
6. Build `SqliteVectorStore`, `MemoryIndexer`, `SemanticRecall` → `app.state`
7. Build `ConversationRepository`, `AgentMemoryRepository`,
   `ConversationManager`; `app.state.db_session_factory = SessionLocal`
   (exists specifically so `routes/health.py` can probe the DB)
8. Build `ConversationSummariser` → `app.state`
9. Build `KnowledgeBase` (wired to re-index on change if memory indexing is enabled) → `app.state`
10. Build `TaskService` → `app.state`
11. Load tool manifests (`YamlToolManifestStore`); if `privacy.online.enabled`, build the lookup
    stack; build guardrails + skills and register `TasksSkill` plus (when online) `GetWeatherSkill`,
    `ConvertCurrencySkill`, `WebSearchSkill`. With online disabled, manifests marked
    `requires_online` are dropped
12. Build `SystemControlPort` and register the device skills (`app_control`, `volume_control`, `device_status`),
    `AgentRegistry`, `ToolUseGuard`, `PromptComposer`, `SqliteTraceRepository`, `SessionStateService`; build
    `ResponderAgent` (plain chat, with the claims reply veto) and register it
13. Build `ControlDecoder` + `AssistantOrchestrator` (`app.state.orchestrator`), then `SupervisorAgent(orchestrator)`;
    register it too → `app.state.agent_registry`, `app.state.supervisor`; build `AmbientDispatcher` →
    `app.state.ambient_dispatcher` (proactivity + ambient-event narration)
14. `app.state.lookup_service` / `lookup_health` (set in step 11), `app.state.trace_repo`,
    `app.state.notifier`, `app.state.egress_allow_list`
15. **Privacy chain**: build `mute_switch`, `audio_capture`, then
    `CaptureGate(mute_switch, indicator, audio_capture, bus=event_bus)` —
    comment: CaptureGate is "the only thing allowed to start/stop the mic
    or drive the indicator." The *same* `audio_capture` instance is shared
    with the voice session — "two independent mic streams would fight
    over the device"
16. `app.state.voice_session = build_voice_session(...)`
17. Log `"Bootstrap: N agents, M skills registered"`

### `lifespan(app)` — startup/shutdown (`lifespan.py`)

Startup: load config → configure logging → `ensure_dirs()` → `init_tables()`
→ `build_app_state(app)` → optionally `verify_ready()`/`warmup()` the inference
backend (logs an error but does **not** crash boot — deliberately, so the
failure is loud at boot rather than a confusing 404 on the user's first
turn) → start `capture_gate` (must happen inside the running event loop,
since a mute transition from a hardware thread needs to reach the bus) →
start `conversation_summariser` → fire-and-forget a memory-index backfill
task if enabled → start `voice_session` if built → `yield`.

Shutdown: stop `voice_session` (awaited) → stop `conversation_summariser`
(awaited, exceptions swallowed) → stop `capture_gate` → delete every file
under `TEMP_DIR`.

### App construction (`app.py`)

```python
app = FastAPI(title=PROJECT_NAME, version=VERSION, lifespan=lifespan)
register_exception_handlers(app)
app.middleware("http")(request_context)

for _mod in (admin, approval, config_route, governance_route,
             health, knowledge, lookup, persona, privacy, speakers,
             stream, tasks_route, trace_route, voice):
    app.include_router(_mod.router, prefix="/api")
```

A root `GET /` (excluded from the OpenAPI schema) returns
`{"name", "version", "interfaces": ["REST /api/*", "CLI: veda"], "docs": "/docs"}`
— the docstring notes this is a deliberately headless build: no browser
UI, the REST API and the `veda` CLI are the only interfaces.

### Running it

The app is addressed by its full module path, `bootstrap.app:app`, so it starts the same way from any working
directory as long as `src/` is importable (the editable install does that; otherwise set `PYTHONPATH=src`):

```bash
pip install -e .
python -m uvicorn bootstrap.app:app --reload
# or the repo-root shim:
python -m uvicorn server:app --reload
# or simply:
veda server
```
