# Vedic Atlas

Veda is an on-device voice/text assistant. All reasoning happens locally: no cloud LLM,
no silent model downloads, and no network call that is not explicitly allow-listed
(`src/tpa/online/allow_list.py`). The target hardware is a Raspberry Pi; the same code
runs on a laptop.

## Features

- **Voice loop**: wake word, speech-to-text, TTS replies, speaker recognition.
- **Unified orchestrator**: a single control model decides, per turn, whether to answer
  or call a tool (the old keyword routing and router model were removed).
- **Tool harness**: system control, clock, reminders, memory, lookup, and Google
  Calendar and Gmail (Google sign-in, with a mail contact map for resolving names).
- **Vision**: photograph something with the phone app and a local vision model on the
  Pi (Qwen3-VL-2B, run by `llama-server` as a separate loopback-only process) describes it.
  No internet is used on the vision path, and vision has no access to memory or agents.
- **Phone app** (`mobile/`): an Android app (Expo / React Native) that pairs with your Pi
  over home Wi-Fi: Look (camera, spoken descriptions, questions), Chat with approvals,
  Control (mute, tasks, reminders, personality) and Settings. See [Phone app](#phone-app).
- **Device pairing and access control**: one-time pairing codes, per-device tokens with
  scopes (`chat`, `control`, `vision`, `approve`), revocable with `veda devices revoke`.
  The LAN gate is fail-closed; only loopback is trusted.
- **Governance and guardrails**: approval flow for destructive actions, privacy controls.
- **Router fine-tuning pipeline** (`training/`): synthetic datasets, labeling, review
  and a clean held-out test set for training the tool-routing model.

## Architecture

Ports-and-adapters (hexagonal): `domain/` defines pure contracts, `tpa/` supplies the
concrete adapters, `service/` orchestrates. Start with
[`docs/00-overview.md`](docs/00-overview.md), then the per-layer docs in `docs/`.

## Folder Structure

```
vedic-atlas/
├── config/                  # settings and run profiles
├── data/
├── docs/                    # architecture, layer docs, handoff, plans
├── mobile/                  # Android phone app (Expo / React Native)
├── scripts/                 # includes mock_pi.py, a stand-in Pi for app development
├── server.py                # ASGI entry point (uvicorn server:app)
├── src/
│   ├── bootstrap/           # composition root: wires adapters, builds the FastAPI app
│   ├── controller/          # CLI + REST routes
│   ├── core/                # config, constants, logging
│   ├── domain/              # entities, ports, pure policies
│   ├── exceptions/
│   ├── schemas/
│   ├── service/             # agents, skills, governance, memory, voice, mail, reminders
│   ├── tpa/                 # adapters: audio, stt, tts, inference, wake_word, online, ...
│   └── utilities/
├── tests/                   # unit tests and eval harness
├── training/                # router fine-tuning pipeline (see training/README.md)
├── wakeword_training/
├── .env.example
├── LICENSE
├── pyproject.toml
├── run.bat
└── run.sh
```

## Getting Started

### Prerequisites
- Python 3.10+

### Setup & Run
`run.bat` (Windows) and `./run.sh` (Linux/macOS) start the `veda` CLI. With no arguments
it opens the REPL and starts the local server (the voice loop runs inside it) if one is not
already running. `veda server` runs the server on its own.

Copy `.env.example` to `.env` and set `VEDA_PROFILE` to choose a run profile from
`config/profiles/`.

## Phone app

The app talks to the Pi's HTTP API over your home network (plain HTTP, no cloud). English
only and Android only for now. It is a working prototype for sideloading, **not** ready
for the Play Store (it still needs HTTPS or a documented local-network story, a privacy
policy and in-app reporting for AI content).

### Set up a Raspberry Pi
`bash scripts/setup_pi.sh` installs everything, including the phone camera model: the ARM
`llama-server` build and Qwen3-VL-2B (about 1.5 GB, checked with SHA-256; skip with
`--skip-vision`). It adds `VEDA_DEVICE=pi` to `.env`, which loads `config/hardware/pi.yaml`
(the Pi's vision settings, and listening for paired phones).

### Use it from a phone (same home Wi-Fi)
On the Pi:
```
veda                # start Veda and open the chat prompt (joins it if it is already running)
veda --restart      # stop the running Veda and start a fresh one
veda pair           # print a one-time code and QR; enter it in the app
veda devices        # list paired phones; `veda devices revoke <id>` removes one
```
Talk to it by voice at the Pi, or type at the prompt, or use the phone for Look, Chat and
Control. A physical mute switch on the Pi's mic leaves the terminal and the phone working.

On a laptop (no hardware profile) a server started by `veda` listens on this machine only,
so a phone cannot reach it. Start it with `veda server --lan` first, then `veda pair`.

Run only one Veda server: each loads every model again. `veda server` refuses to start a
second one (it names the process already running).

### Develop the app without a Pi
`scripts/mock_pi.py` serves the real routes, pairing and permission gate with a scripted
vision model and canned chat replies:

```
vedic-atlas-env/Scripts/python.exe scripts/mock_pi.py --host 0.0.0.0
```

```
cd mobile
npm ci
npm run check        # typecheck, lint and all tests (unit + contract against the mock Pi)
npm start            # Expo dev server
```

The Android release build on Windows needs a short build path and JDK 17:
`powershell -File mobile/scripts/build-android.ps1 -Variant release`
(the script explains why). The APK is written to `mobile/apk/` and is not committed.

### Status
Verified on a real phone over home Wi-Fi: pairing, Look (including questions by voice),
Chat with approvals, Control and Settings. Speech-to-text runs on the phone; the first time,
the phone must download its offline English speech pack once (the app offers a button for it,
over Wi-Fi; your voice is never sent anywhere). Still to do: the polish stage (visual design,
TalkBack, tablet widths) and measuring RAM with both models loaded on a Pi 5 (8 GB).

## More Docs

Vision and phone app:
- [`docs/15-vision-mobile-design.md`](docs/15-vision-mobile-design.md): the Pi side: pairing, access scopes, the vision service and its memory guard
- [`docs/16-mobile-app-design.md`](docs/16-mobile-app-design.md): the Android app: screens, UX, stages, build notes

Core:
- [`docs/00-overview.md`](docs/00-overview.md): architecture overview, with the per-layer docs `01` to `06` beside it
- [`docs/08-tool-harness.md`](docs/08-tool-harness.md): the tool harness
- [`docs/HANDOFF.md`](docs/HANDOFF.md): setting up on another machine, first-run checklist
- [`training/README.md`](training/README.md): router training pipeline
