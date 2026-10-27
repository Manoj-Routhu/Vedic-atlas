#!/usr/bin/env bash
#
# setup_pi.sh - set up Veda on a Raspberry Pi (or any Debian-based Linux machine).
#
#   bash scripts/setup_pi.sh                      # everything below
#   bash scripts/setup_pi.sh --dry-run            # show what it would do, change nothing
#   bash scripts/setup_pi.sh --extras embedding   # also install an optional extra from pyproject.toml
#   bash scripts/setup_pi.sh --skip-hardware      # do not install the GPIO / DHT11 libraries
#   bash scripts/setup_pi.sh --model 1.7b         # pick the language model: 0.6b | 1.7b | 4b (default 4b)
#
# What it does (safe to re-run; each step skips work that is already done):
#   1. checks the machine (CPU, RAM, free disk, Python >= 3.12)
#   2. installs system packages with apt            (skip: --skip-apt)
#   3. creates .venv and runs `pip install -e .`    (skip: --skip-install)
#        - also yt-dlp (music search) is part of `pip install -e .`; mpv (the player) comes from apt in step 2
#        - on a Raspberry Pi: the GPIO mute switch and DHT11 room-sensor libraries, best effort (skip: --skip-hardware)
#        - nothing to configure afterwards: Veda turns music on when mpv and yt-dlp are found and uses the DHT11
#          when its library is installed (config/music.yaml, config/sensing.yaml: driver auto)
#   4. downloads the models with wget, resumable    (skip: --skip-models)
#        - language model   data/Qwen3-<size>-Q4_K_M.gguf      (--model: 0.6b ~0.4 GB, 1.7b ~1.1 GB, 4b ~2.5 GB)
#        - speech-to-text   data/models/whisper-base.en/       (faster-whisper base.en, 145 MB)
#        - voice            data/models/piper/<voice>.onnx     (Piper en_US-lessac-medium, 63 MB)
#        - memory           data/bge-small-en-v1.5/            (BGE-small embeddings, 134 MB: lets Veda recall
#                                                               things you told it in earlier sessions)
#        - wake helpers     inside the openwakeword package   (melspectrogram + embedding models, 2.4 MB: the
#                                                               wake word cannot load without them)
#   5. vision for the phone app                     (skip: --skip-vision)
#        - llama-server (llama.cpp b11716, ARM)       data/tools/llama-b11716-ubuntu-arm64/   (14 MB)
#        - camera model Qwen3-VL-2B Q4_K_M + mmproj   data/models/vision/                     (1.1 GB + 0.4 GB, checked with SHA-256)
#        It only runs when a paired phone sends a photo, and unloads again when idle.
#   6. points config/audio.yaml at the Piper voice  (skip: --skip-config)
#   7. creates .env from .env.example if there is none, and sets VEDA_DEVICE=pi on a Pi (listens for paired phones)
#   8. checks the install and tells you what is still missing
#
# NOT downloaded - copy it yourself (WinSCP): the wake-word model you trained
#   data/models/openwakeword/hey_veda.onnx   and   hey_veda.onnx.data     (BOTH files)
# Until it is there the voice loop stays off on purpose (it never listens continuously).
#
# Overridable with environment variables:
#   PYTHON=/path/to/python3.12   which Python to build the venv with
#   VENV=/some/dir               venv location (default: <repo>/.venv)
#   MODEL=0.6b|1.7b|4b           same as --model
#   LLM_URL=...                  another GGUF for the chosen model (it is saved under that model's usual file name,
#                                the one its config/profiles/*.yaml (or config/inference.yaml for 4b) expects)
#   PIPER_VOICE=en_US-amy-medium another Piper voice name from rhasspy/piper-voices
#   CMAKE_ARGS=...               extra CMake flags for llama-cpp-python

# This script uses bash features. `sh scripts/setup_pi.sh` runs it under dash on Debian, so stop early with a clear message.
if [ -z "${BASH_VERSION:-}" ]; then
  echo "Run this with bash:  bash scripts/setup_pi.sh" >&2
  exit 1
fi

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="${VENV:-$ROOT/.venv}"

# Language model: chosen with --model / MODEL, resolved by select_model() once the options are parsed.
MODEL="${MODEL:-4b}"
LLM_URL_OVERRIDE="${LLM_URL:-}"
LLM_URL="" LLM_DEST="" PROFILE=""

WHISPER_BASE_URL="https://huggingface.co/Systran/faster-whisper-base.en/resolve/main"
WHISPER_DIR="$ROOT/data/models/whisper-base.en"
WHISPER_FILES=(config.json model.bin tokenizer.json vocabulary.txt)

PIPER_BASE_URL="https://huggingface.co/rhasspy/piper-voices/resolve/main"
PIPER_VOICE="${PIPER_VOICE:-en_US-lessac-medium}"
PIPER_DIR="$ROOT/data/models/piper"

VISION_BASE_URL="https://huggingface.co/Qwen/Qwen3-VL-2B-Instruct-GGUF/resolve/main"
VISION_DIR="$ROOT/data/models/vision"
VISION_MODEL="Qwen3VL-2B-Instruct-Q4_K_M.gguf"
VISION_MODEL_SHA256="089d75c52f4b7ffc56ba998ffc50aae89fcafc755f9e7208aacca281dca6c2ae"
VISION_MMPROJ="mmproj-Qwen3VL-2B-Instruct-Q8_0.gguf"
VISION_MMPROJ_SHA256="f9a68fabba69c3b81e153367b2c7521030b0fa8bb0de400c9599c8e6725f9c82"
LLAMA_CPP_URL="https://github.com/ggml-org/llama.cpp/releases/download/b11716/llama-b11716-bin-ubuntu-arm64.tar.gz"
LLAMA_CPP_DIR="$ROOT/data/tools/llama-b11716-ubuntu-arm64"   # config/hardware/pi.yaml points here

EMBED_BASE_URL="https://huggingface.co/BAAI/bge-small-en-v1.5/resolve/main"
EMBED_DIR="$ROOT/data/bge-small-en-v1.5"

WAKE_DIR="$ROOT/data/models/openwakeword"
# openwakeword does not ship its two feature-extractor models in the pip package; without them the wake word
# cannot load at all ("melspectrogram.onnx ... File doesn't exist"). They go inside the installed package.
OWW_FEATURE_URL="https://github.com/dscripka/openWakeWord/releases/download/v0.5.1"
OWW_FEATURE_FILES=(melspectrogram.onnx embedding_model.onnx)

APT_PACKAGES=(build-essential cmake git wget curl ca-certificates pkg-config
              python3-dev python3-venv libportaudio2 portaudio19-dev alsa-utils mpv bluez)

MIN_DISK_GB=8        # llama-cpp-python build + venv + up to 2.7 GB of models
MIN_RAM_MB=3500      # set per model by select_model() (rough: model file + context + speech/memory models)

DRY_RUN=0 SKIP_APT=0 SKIP_INSTALL=0 SKIP_MODELS=0 SKIP_CONFIG=0 SKIP_HARDWARE=0 SKIP_VISION=0 EXTRAS=""

# ---------------------------------------------------------------- output helpers

if [[ -t 1 ]]; then
  BOLD=$'\033[1m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; RESET=$'\033[0m'
else
  BOLD=""; GREEN=""; YELLOW=""; RED=""; RESET=""
fi

step() { printf '\n%s==> %s%s\n' "$BOLD" "$*" "$RESET"; }
info() { printf '    %s\n' "$*"; }
ok()   { printf '    %sOK%s    %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '    %sWARN%s  %s\n' "$YELLOW" "$RESET" "$*" >&2; }
die()  { printf '\n%sERROR%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }

on_error() {
  # Failures inside $(...) helpers (remote_size, find_python) are handled by their callers: stay quiet.
  if (( BASH_SUBSHELL > 0 )); then return 0; fi
  printf '\n%sFailed at line %s:%s %s\n' "$RED" "$1" "$RESET" "$2" >&2
}
trap 'on_error "$LINENO" "$BASH_COMMAND"' ERR

# Run a command, or just print it in --dry-run mode.
run() {
  if (( DRY_RUN )); then
    printf '    [dry-run] %s\n' "$*"
  else
    "$@"
  fi
}

usage() {
  # print the leading comment block (from line 3 to the first line that is not a comment)
  awk 'NR >= 3 { if ($0 !~ /^#/) exit; sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}"
  cat <<'EOF'

Options:
  --dry-run          print the steps without changing anything
  --skip-apt         do not run apt (you installed the system packages yourself)
  --skip-install     do not create the venv / pip install
  --skip-models      do not download models
  --skip-config      do not edit config/audio.yaml
  --skip-vision      do not download the camera model and llama-server (the phone's Look screen will not work)
  --skip-hardware    do not install the GPIO / DHT11 libraries (the mute switch and room sensor stay on the software versions)
  --extras LIST      pyproject extras to install, comma separated (e.g. embedding,hotkey)
  --model SIZE       language model to download: 0.6b (fastest), 1.7b, or 4b (default, best answers, slowest)
  -h, --help         this text
EOF
}

# Resolve the chosen model into its download URL, file, memory need and the config profile that runs it.
# The 0.6b / 1.7b / 4b profiles live in config/profiles/ and are switched on with VEDA_PROFILE (see the summary).
select_model() {
  case "$MODEL" in
    0.6b)
      LLM_URL="https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q4_K_M.gguf"
      LLM_DEST="$ROOT/data/Qwen3-0.6B-Q4_K_M.gguf"; PROFILE="qwen3-0.6b"; MIN_RAM_MB=1500 ;;
    1.7b)
      LLM_URL="https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_K_M.gguf"
      LLM_DEST="$ROOT/data/Qwen3-1.7B-Q4_K_M.gguf"; PROFILE="qwen3-1.7b"; MIN_RAM_MB=2500 ;;
    4b)
      LLM_URL="https://huggingface.co/bartowski/Qwen_Qwen3-4B-GGUF/resolve/main/Qwen_Qwen3-4B-Q4_K_M.gguf"
      LLM_DEST="$ROOT/data/Qwen3-4B-Q4_K_M.gguf"; PROFILE="qwen3-4b"; MIN_RAM_MB=3500 ;;
    *) die "unknown model '$MODEL': use 0.6b, 1.7b or 4b" ;;
  esac
  [[ -n "$LLM_URL_OVERRIDE" ]] && LLM_URL="$LLM_URL_OVERRIDE"
  return 0
}

# ---------------------------------------------------------------- 1. the machine

python_ok() {
  "$1" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 12) else 1)' >/dev/null 2>&1
}

find_python() {
  local -a candidates
  local c
  if [[ -n "${PYTHON:-}" ]]; then
    candidates=("$PYTHON")
  else
    candidates=(python3.13 python3.12 python3 python)
  fi
  for c in "${candidates[@]}"; do
    if command -v "$c" >/dev/null 2>&1 && python_ok "$c"; then
      command -v "$c"
      return 0
    fi
  done
  return 1
}

explain_python() {
  cat >&2 <<'EOF'

Veda needs Python 3.12 or newer, and none was found.
  - Raspberry Pi OS "Bookworm" ships Python 3.11. Newer releases ("Trixie") ship 3.13 and work as they are.
  - To stay on Bookworm, get a newer Python with uv (https://docs.astral.sh/uv/):
        curl -LsSf https://astral.sh/uv/install.sh | sh
        ~/.local/bin/uv python install 3.12
        PYTHON="$(~/.local/bin/uv python find 3.12)" bash scripts/setup_pi.sh
EOF
}

build_jobs() {
  local cpus mem_mb jobs
  cpus="$(nproc 2>/dev/null || echo 2)"
  mem_mb="$(awk '/MemTotal/ {printf "%d", $2 / 1024}' /proc/meminfo 2>/dev/null || echo 4096)"
  jobs=$(( mem_mb / 1024 ))            # compiling llama.cpp needs roughly 1 GB per job
  (( jobs < 1 )) && jobs=1
  (( jobs > cpus )) && jobs=$cpus
  echo "$jobs"
}

preflight() {
  step "Checking this machine"
  local os arch mem_mb free_gb
  # shellcheck source=/dev/null
  os="$( (. /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-unknown}") || echo unknown )"
  arch="$(uname -m)"
  info "OS: $os   CPU: $arch   repo: $ROOT"

  case "$arch" in
    aarch64|x86_64|arm64) ;;
    *) warn "$arch looks like a 32-bit system; Veda's packages need a 64-bit OS (64-bit Raspberry Pi OS)." ;;
  esac

  mem_mb="$(awk '/MemTotal/ {printf "%d", $2 / 1024}' /proc/meminfo 2>/dev/null || echo 0)"
  if (( mem_mb > 0 && mem_mb < MIN_RAM_MB )); then
    warn "only ${mem_mb} MB RAM; the ${MODEL} model needs about ${MIN_RAM_MB} MB. Try a smaller one: --model 1.7b or --model 0.6b."
  else
    info "RAM: ${mem_mb} MB"
  fi

  free_gb="$(df -Pk "$ROOT" 2>/dev/null | awk 'NR == 2 {printf "%d", $4 / 1024 / 1024}')"
  if [[ -n "$free_gb" ]] && (( free_gb < MIN_DISK_GB )); then
    warn "only ${free_gb} GB free here; about ${MIN_DISK_GB} GB is needed."
  else
    info "free disk: ${free_gb:-?} GB"
  fi

  if (( EUID == 0 )); then
    warn "running as root: the venv and downloaded files will be owned by root. Prefer your normal user."
  fi
  [[ -f "$ROOT/pyproject.toml" ]] || die "pyproject.toml not found in $ROOT; run this script from a full checkout of the repo."
}

# ---------------------------------------------------------------- 2. system packages

install_system_packages() {
  step "System packages (apt)"
  if (( SKIP_APT )); then info "skipped (--skip-apt)"; return 0; fi
  if ! command -v apt-get >/dev/null 2>&1; then
    warn "apt-get not found. Install these yourself: ${APT_PACKAGES[*]}"
    return 0
  fi
  local sudo=""
  if (( EUID != 0 )); then
    command -v sudo >/dev/null 2>&1 || die "need root or sudo to run apt-get (or install the packages yourself and use --skip-apt)."
    sudo="sudo"
  fi
  run $sudo apt-get update
  # apt-listchanges and dpkg-preconfigure (apt hook scripts that only show changelogs / ask debconf questions) segfault on
  # some Raspberry Pi OS images, which aborts the whole install. None of the packages here need either, so skip them.
  # The hooks live in /etc/apt/apt.conf.d and apt can only add to them, not clear them, so point this one install at an
  # empty config directory instead (the main /etc/apt/apt.conf and sources are still used).
  local apt_conf empty_dir
  empty_dir="$(mktemp -d)"; apt_conf="$empty_dir/apt.conf"
  printf 'Dir::Etc::parts "%s";\n' "$empty_dir" > "$apt_conf"
  run $sudo env DEBIAN_FRONTEND=noninteractive APT_LISTCHANGES_FRONTEND=none APT_CONFIG="$apt_conf" \
    apt-get install -y "${APT_PACKAGES[@]}"
  rm -rf "$empty_dir"
}

# ---------------------------------------------------------------- 3. venv + pip install

setup_venv_and_install() {
  step "Python environment ($VENV)"
  local py
  if [[ -x "$VENV/bin/python" ]]; then
    python_ok "$VENV/bin/python" || die "$VENV uses a Python older than 3.12. Delete it (rm -rf $VENV) and run this again."
    ok "reusing the existing environment"
  else
    py="$(find_python)" || { explain_python; exit 1; }
    info "using $py ($("$py" --version 2>&1))"
    run "$py" -m venv "$VENV" || die "could not create the virtual environment. On Debian/Raspberry Pi OS: sudo apt install python3-venv"
  fi
  run "$VENV/bin/python" -m pip install --upgrade pip setuptools wheel

  step "Installing Veda (pip install -e .)"
  info "llama-cpp-python is compiled from source here: expect 10-30 minutes on a Raspberry Pi."
  local spec="."
  [[ -n "$EXTRAS" ]] && spec=".[${EXTRAS}]"
  export CMAKE_BUILD_PARALLEL_LEVEL="${CMAKE_BUILD_PARALLEL_LEVEL:-$(build_jobs)}"
  info "build parallelism: $CMAKE_BUILD_PARALLEL_LEVEL job(s)"
  ( cd "$ROOT" && run "$VENV/bin/pip" install --prefer-binary -e "$spec" )

  # openwakeword declares tflite-runtime on Linux, which has no wheels for Python 3.12+ ("No matching
  # distribution found for tflite-runtime"). Veda only runs the ONNX model, which never imports tflite,
  # so install it without its dependencies (the ones it really needs are already in pyproject.toml).
  if [[ "$(uname -s)" == "Linux" ]]; then
    info "wake word: installing openwakeword without its tflite-runtime dependency (not needed for ONNX)"
    ( cd "$ROOT" && run "$VENV/bin/pip" install --no-deps --prefer-binary "openwakeword>=0.6.0" )
  fi
}

is_raspberry_pi() {
  [[ -r /proc/device-tree/model ]] && tr -d '\0' < /proc/device-tree/model | grep -qi "raspberry pi"
}

# GPIO mute switch (rpi-lgpio) and the DHT11 room sensor (adafruit-circuitpython-dht + blinka). Best effort: these are
# hardware libraries that are not verified on every board, and a failure here must not stop the rest of the setup.
install_hardware_extras() {
  step "Hardware libraries (GPIO mute switch, DHT11 room sensor)"
  if (( SKIP_HARDWARE )); then info "skipped (--skip-hardware)"; return 0; fi
  if (( SKIP_INSTALL )); then info "skipped (--skip-install)"; return 0; fi
  if ! is_raspberry_pi && (( ! DRY_RUN )); then info "this is not a Raspberry Pi: skipped (the laptop uses the software mute switch and the mock sensor)"; return 0; fi
  local pip="$VENV/bin/pip"
  ( cd "$ROOT" && run "$pip" install --prefer-binary -e ".[hardware-gpio]" ) \
    || warn "GPIO libraries did not install: the physical mute switch will fall back to the software switch."
  ( cd "$ROOT" && run "$pip" install --prefer-binary -e ".[hardware-room-sensor]" ) \
    || warn "DHT11 libraries did not install: the room sensor will stay on the mock driver."
  # adafruit-blinka can pull in RPi.GPIO, which clashes with rpi-lgpio (the Raspberry Pi 5 replacement for it).
  if (( ! DRY_RUN )) && "$pip" show RPi.GPIO >/dev/null 2>&1; then
    info "replacing RPi.GPIO with rpi-lgpio (they provide the same module; only rpi-lgpio works on a Pi 5)"
    run "$pip" uninstall -y RPi.GPIO || true
    run "$pip" install --force-reinstall --no-deps "rpi-lgpio>=0.6" || warn "rpi-lgpio did not reinstall."
  fi
}

# ---------------------------------------------------------------- 4. models

# Size in bytes the server reports for a URL (follows redirects); empty if unknown.
remote_size() {
  curl -fsIL --retry 3 --max-time 30 "$1" 2>/dev/null | tr -d '\r' | awk 'tolower($1) == "content-length:" {c = $2} END {print c}'
}

file_size() { wc -c < "$1" | tr -d ' '; }

# fetch URL DEST: resumable download into DEST.part, size-checked, then moved into place.
# A half-downloaded model therefore never sits at its final path.
fetch() {
  local url="$1" dest="$2" want have=0 got part="$2.part"
  want="$(remote_size "$url" || true)"
  [[ -f "$dest" ]] && have="$(file_size "$dest")"

  if [[ -n "$want" && "$have" == "$want" ]]; then
    ok "$(basename "$dest") already downloaded"
    return 0
  fi
  if [[ -f "$dest" && -z "$want" ]]; then
    ok "$(basename "$dest") present (could not check its size online)"
    return 0
  fi
  if (( DRY_RUN )); then
    info "[dry-run] would download $url -> $dest (${want:-unknown} bytes)"
    return 0
  fi

  mkdir -p "$(dirname "$dest")"
  info "downloading $(basename "$dest") (${want:-unknown} bytes)"
  wget -c --tries=5 --timeout=30 --progress=dot:giga -O "$part" "$url" \
    || die "download failed: $url  (run the script again to resume)"
  got="$(file_size "$part")"
  if [[ -n "$want" && "$got" != "$want" ]]; then
    die "$(basename "$dest"): got $got bytes but expected $want. Run the script again to resume."
  fi
  mv -f "$part" "$dest"
  ok "$(basename "$dest")"
}

# URL of a Piper voice: .../en/en_US/lessac/medium/en_US-lessac-medium.onnx
piper_url() {
  local voice="$1" lang_region name quality lang
  [[ "$voice" =~ ^[a-z]{2}_[A-Z]{2}-[A-Za-z0-9_]+-(x_low|low|medium|high)$ ]] \
    || die "PIPER_VOICE '$voice' is not a Piper voice name like en_US-lessac-medium"
  IFS=- read -r lang_region name quality <<<"$voice"
  lang="${lang_region%%_*}"
  echo "$PIPER_BASE_URL/$lang/$lang_region/$name/$quality/$voice.onnx"
}

download_models() {
  step "Models"
  if (( SKIP_MODELS )); then info "skipped (--skip-models)"; return 0; fi
  command -v wget >/dev/null 2>&1 || die "wget not found (sudo apt install wget)."
  command -v curl >/dev/null 2>&1 || warn "curl not found: downloads will not be size-checked."

  info "language model"
  fetch "$LLM_URL" "$LLM_DEST"

  info "speech-to-text (faster-whisper base.en)"
  local f
  for f in "${WHISPER_FILES[@]}"; do
    fetch "$WHISPER_BASE_URL/$f" "$WHISPER_DIR/$f"
  done

  info "memory (BGE-small sentence embeddings)"
  fetch "$EMBED_BASE_URL/onnx/model.onnx" "$EMBED_DIR/model.onnx"
  fetch "$EMBED_BASE_URL/tokenizer.json" "$EMBED_DIR/tokenizer.json"

  info "voice (Piper $PIPER_VOICE)"
  local url
  url="$(piper_url "$PIPER_VOICE")"
  fetch "$url" "$PIPER_DIR/$PIPER_VOICE.onnx"
  fetch "$url.json" "$PIPER_DIR/$PIPER_VOICE.onnx.json"

  download_wake_feature_models
}

# Folder inside the installed openwakeword package where it looks for its feature models. find_spec does not
# import the package (importing it pulls in scikit-learn, which is slow on a Pi).
openwakeword_models_dir() {
  "$VENV/bin/python" -c 'import importlib.util, os, sys
spec = importlib.util.find_spec("openwakeword")
if spec is None or not spec.origin:
    sys.exit(1)
print(os.path.join(os.path.dirname(spec.origin), "resources", "models"))' 2>/dev/null
}

download_wake_feature_models() {
  info "wake word helper models (openwakeword feature extractors, 2.4 MB)"
  local dir f
  if (( DRY_RUN )); then
    for f in "${OWW_FEATURE_FILES[@]}"; do info "[dry-run] would download $OWW_FEATURE_URL/$f into the openwakeword package"; done
    return 0
  fi
  dir="$(openwakeword_models_dir)" || dir=""
  if [[ -z "$dir" ]]; then
    warn "openwakeword is not installed in $VENV, so its helper models were not downloaded (run without --skip-install)."
    return 0
  fi
  for f in "${OWW_FEATURE_FILES[@]}"; do
    fetch "$OWW_FEATURE_URL/$f" "$dir/$f"
  done
}

# SHA-256 of a file, or empty if it cannot be computed.
sha256_of() { sha256sum "$1" 2>/dev/null | awk '{print $1}'; }

# The camera model for the phone app. Separate from the chat model: it runs in its own llama-server process, only while
# a photo is being described.
download_vision() {
  step "Vision (phone camera)"
  if (( SKIP_VISION )); then info "skipped (--skip-vision)"; return 0; fi
  local arch got
  arch="$(uname -m)"

  info "camera model (Qwen3-VL-2B, about 1.5 GB)"
  fetch "$VISION_BASE_URL/$VISION_MODEL" "$VISION_DIR/$VISION_MODEL"
  fetch "$VISION_BASE_URL/$VISION_MMPROJ" "$VISION_DIR/$VISION_MMPROJ"
  if (( ! DRY_RUN )); then
    got="$(sha256_of "$VISION_DIR/$VISION_MODEL")"
    [[ "$got" == "$VISION_MODEL_SHA256" ]] && ok "$VISION_MODEL checksum" || warn "$VISION_MODEL checksum differs (got ${got:-none}); delete it and run again."
    got="$(sha256_of "$VISION_DIR/$VISION_MMPROJ")"
    [[ "$got" == "$VISION_MMPROJ_SHA256" ]] && ok "$VISION_MMPROJ checksum" || warn "$VISION_MMPROJ checksum differs (got ${got:-none}); delete it and run again."
  fi

  info "llama-server (llama.cpp b11716, ARM)"
  if [[ -x "$LLAMA_CPP_DIR/llama-server" ]]; then
    ok "llama-server already installed"
  elif [[ "$arch" != "aarch64" && "$arch" != "arm64" ]]; then
    warn "$arch is not ARM, so the ARM llama-server build would not run here. Put a llama-server for this machine somewhere and set vision.binary_path in config/vision.yaml."
  elif (( DRY_RUN )); then
    info "[dry-run] would download $LLAMA_CPP_URL and unpack it into $LLAMA_CPP_DIR"
  else
    local archive="$ROOT/data/tools/llama-b11716-ubuntu-arm64.tar.gz"
    mkdir -p "$LLAMA_CPP_DIR"
    fetch "$LLAMA_CPP_URL" "$archive"
    tar -xzf "$archive" -C "$LLAMA_CPP_DIR" --strip-components=1 || die "could not unpack $archive"
    rm -f "$archive"
    chmod +x "$LLAMA_CPP_DIR/llama-server"
    ok "llama-server -> $LLAMA_CPP_DIR"
  fi
}

check_wake_model() {
  step "Wake-word model (you copy this one)"
  local f missing=0
  for f in hey_veda.onnx hey_veda.onnx.data; do
    if [[ -f "$WAKE_DIR/$f" ]]; then ok "$f"; else warn "missing: $WAKE_DIR/$f"; missing=1; fi
  done
  if (( missing )); then
    warn "copy BOTH files from your PC (WinSCP) into $WAKE_DIR/ . Until then voice stays off (text chat still works)."
  fi
}

# ---------------------------------------------------------------- 5-6. config + .env

configure_tts() {
  step "Config"
  if (( SKIP_CONFIG )); then info "skipped (--skip-config)"; return 0; fi
  local cfg="$ROOT/config/audio.yaml" rel="data/models/piper/$PIPER_VOICE.onnx"
  [[ -f "$cfg" ]] || { warn "$cfg not found; set audio.tts_model_path to $rel yourself."; return 0; }
  if grep -Eq '^tts_model_path:[[:space:]]*(null|~)?[[:space:]]*(#.*)?$' "$cfg"; then
    run sed -i.bak -E "s|^tts_model_path:.*\$|tts_model_path: $rel|" "$cfg"
    run rm -f "$cfg.bak"
    ok "config/audio.yaml: tts_model_path -> $rel (tts_engine 'auto' picks Piper on Linux)"
    info "this edits a tracked file: 'git stash' (or commit it) before a 'git pull' if git complains."
  else
    ok "config/audio.yaml already sets tts_model_path: $(grep -E '^tts_model_path:' "$cfg" | head -1)"
  fi
}

setup_env_file() {
  step ".env (API keys)"
  if [[ -f "$ROOT/.env" ]]; then
    ok ".env already exists"
  elif [[ -f "$ROOT/.env.example" ]]; then
    run cp "$ROOT/.env.example" "$ROOT/.env"
    run chmod 600 "$ROOT/.env"
    ok "created .env from .env.example (permissions 600)"
  else
    warn "no .env.example found; create .env yourself if you need API keys"
  fi
  # On a Pi, VEDA_DEVICE=pi loads config/hardware/pi.yaml: the camera model's Pi settings, and listening for paired phones.
  if [[ "$(uname -m)" == "aarch64" || "$(uname -m)" == "arm64" ]] && [[ -f "$ROOT/.env" ]] && ! grep -Eq '^VEDA_DEVICE=' "$ROOT/.env"; then
    run bash -c "printf '\nVEDA_DEVICE=pi\n' >> '$ROOT/.env'"
    ok "added VEDA_DEVICE=pi to .env"
  fi
  info "web search needs TAVILY_API_KEY in .env (weather and currency need no key)."
}

# ---------------------------------------------------------------- 7. verify + summary

verify_install() {
  step "Checking the install"
  if (( DRY_RUN || SKIP_INSTALL )); then info "skipped"; return 0; fi
  if "$VENV/bin/python" - <<'PY'
import importlib, sys

checks = {
    "fastapi": "web server", "llama_cpp": "language model", "faster_whisper": "speech-to-text",
    "sounddevice": "microphone/speaker", "openwakeword": "wake word", "piper": "text-to-speech",
    "onnxruntime": "model runtime", "tokenizers": "text tokenizer (semantic memory)", "yt_dlp": "music search",
}
failed = 0
for module, what in checks.items():
    try:
        importlib.import_module(module)
        print(f"    OK    {module:15} ({what})")
    except Exception as exc:  # ImportError, or a missing system library such as PortAudio
        failed += 1
        print(f"    FAIL  {module:15} ({what}): {type(exc).__name__}: {exc}")
sys.exit(1 if failed else 0)
PY
  then
    :
  else
    warn "some packages failed to import (see above). 'sounddevice' failing usually means: sudo apt install libportaudio2"
  fi
  if [[ -x "$VENV/bin/veda" ]]; then
    ok "the 'veda' command is installed"
  else
    warn "the 'veda' command was not created"
  fi
  if command -v mpv >/dev/null 2>&1; then ok "mpv ($(mpv --version 2>/dev/null | head -1 | cut -d' ' -f1-2)): the music player"; else warn "mpv not found: sudo apt install mpv"; fi
  if is_raspberry_pi; then
    "$VENV/bin/python" -c 'import RPi.GPIO' >/dev/null 2>&1 && ok "GPIO library (physical mute switch)" || warn "GPIO library missing: the mute switch falls back to software"
    "$VENV/bin/python" -c 'import adafruit_dht, board' >/dev/null 2>&1 && ok "DHT11 library (room sensor)" || warn "DHT11 library missing: the room sensor stays on the mock driver"
  fi
}

summary() {
  step "Done"
  cat <<EOF
    Next:
      1. copy data/models/openwakeword/hey_veda.onnx and hey_veda.onnx.data from your PC (if not done)
      2. put TAVILY_API_KEY in $ROOT/.env for web search
      3. mail and calendar: put GOOGLE_API_CLIENT_ID and GOOGLE_CLIENT_SECRET in $ROOT/.env, then sign in once:
             veda login --manual        (no browser on the Pi: open the address on another device, paste the result back)
             veda login --check         (verify the saved sign-in; later runs reuse it, no new sign-in after a restart)
         Without them, mail and calendar requests answer that they are not set up.
      4. optional, the fine-tuned router: copy router-Q4_K_M.gguf (or Q5_K_M) by hand into $ROOT/data/router/ and set
         VEDA_PROFILE=router-q4 (or router-q5) instead of the profile below. Not downloaded by this script.
      5. start Veda with the profile that matches the model you downloaded ($MODEL):
             source $VENV/bin/activate
             veda
         (the microphone starts muted; unmute from the prompt with /unmute)
         Set the profile once in $ROOT/.env:   VEDA_PROFILE=$PROFILE
         (or export it in the shell, which wins over .env). Veda logs "[config] profile=..." at startup.
         Without a profile Veda runs the untrimmed base config, which is built for the 4b model.
      6. use it from your phone (same home Wi-Fi). On a Pi, .env has VEDA_DEVICE=pi, so \`veda\` already listens for phones:
             veda                 start Veda and open the chat prompt (if it is already running, it joins it)
             veda --restart       stop the running Veda and start a fresh one
             veda pair            print a one-time code and QR, then enter it in the Veda app
             veda devices         list paired phones         veda devices revoke <id>   remove one
         Never run two Veda servers: each loads every model again. \`veda server\` now refuses to start a second one.
      7. music and reminders speak through the speaker. For a Bluetooth speaker, pair it once (it reconnects by itself later):
             bluetoothctl            then:  scan on  ->  pair <MAC>  ->  trust <MAC>  ->  connect <MAC>  ->  exit
         and make it the default output (Raspberry Pi OS desktop: the speaker icon). Test:  mpv --no-video <any audio file>
      8. wiring (pins are BCM numbers, set in config/privacy.yaml and config/sensing.yaml):
             mute switch   privacy.mute_gpio_pin       (default 17)
             DHT11 sensor  sensing.room.gpio_pin       (default 4, data pin; 3.3 V and GND for power)
      Check devices if voice is silent:  arecord -l   and   aplay -l
EOF
}

# ---------------------------------------------------------------- main

main() {
  while (( $# )); do
    case "$1" in
      --dry-run)      DRY_RUN=1 ;;
      --skip-apt)     SKIP_APT=1 ;;
      --skip-install) SKIP_INSTALL=1 ;;
      --skip-models)  SKIP_MODELS=1 ;;
      --skip-config)  SKIP_CONFIG=1 ;;
      --skip-vision)  SKIP_VISION=1 ;;
      --skip-hardware) SKIP_HARDWARE=1 ;;
      --extras)       shift; [[ $# -gt 0 ]] || die "--extras needs a value"; EXTRAS="$1" ;;
      --extras=*)     EXTRAS="${1#--extras=}" ;;
      --model)        shift; [[ $# -gt 0 ]] || die "--model needs a value (0.6b, 1.7b or 4b)"; MODEL="$1" ;;
      --model=*)      MODEL="${1#--model=}" ;;
      -h|--help)      usage; exit 0 ;;
      *)              usage >&2; die "unknown option: $1" ;;
    esac
    shift
  done

  select_model
  (( DRY_RUN )) && info "DRY RUN: nothing will be changed"
  preflight
  install_system_packages
  if (( SKIP_INSTALL )); then step "Python environment"; info "skipped (--skip-install)"; else setup_venv_and_install; fi
  install_hardware_extras
  download_models
  download_vision
  check_wake_model
  configure_tts
  setup_env_file
  verify_install
  summary
}

# Run main only when executed, not when sourced (so the helpers can be tested).
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
