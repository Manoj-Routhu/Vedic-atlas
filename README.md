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
├── scripts/
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

## More Docs

- [`docs/HANDOFF.md`](docs/HANDOFF.md): setting up on another machine, first-run checklist
- [`docs/08-tool-harness.md`](docs/08-tool-harness.md): the tool harness
- [`training/README.md`](training/README.md): router training pipeline
