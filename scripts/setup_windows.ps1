<#
.SYNOPSIS
  First-time setup of Veda on a Windows laptop. Safe to re-run: every step skips work that is already done.

.DESCRIPTION
  Run it once after cloning (from the repo folder):

      powershell -ExecutionPolicy Bypass -File scripts\setup_windows.ps1

  Options:   -DryRun   show what it would do, change nothing
             -Model 0.6b|1.7b|4b   language model to download (default 4b)
             -SkipModels | -SkipMpv | -SkipLlamaRebuild

  What it does:
    1. finds Python 3.12+ and creates .venv
    2. installs the language-model library (llama-cpp-python) BUILT WITH AVX2/FMA when Visual Studio Build Tools are
       present. The ready-made Windows wheel is built for plain AVX and runs the model about 3-6x slower on a modern
       laptop CPU (measured on a Core Ultra 7: a 55 s router decision became ~5 s). Without Build Tools it falls back to
       the slow wheel and tells you how to fix it.
    3. runs `pip install -e .`  (this includes yt-dlp, which finds songs)
    4. installs mpv (the music player) with winget if it is missing
    5. downloads the models into data\ (resumable): language model, speech-to-text, semantic memory, and the two
       helper files the wake word needs
    6. creates .env from .env.example, then checks the install

  Nothing to configure afterwards: music turns itself on when mpv and yt-dlp are found, the room sensor uses its mock
  driver on a laptop, and reminders are spoken through the same Windows voice as replies.

  NOT downloaded - copy it yourself: the wake-word model you trained
      data\models\openwakeword\hey_veda.onnx   and   hey_veda.onnx.data   (BOTH files)
  Until it is there the voice loop stays off on purpose (text chat, reminders and music by typing still work).
#>
[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$SkipModels,
    [switch]$SkipMpv,
    [switch]$SkipLlamaRebuild,
    [ValidateSet("0.6b", "1.7b", "4b")][string]$Model = "4b"
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Venv = Join-Path $Root ".venv"
$VenvPy = Join-Path $Venv "Scripts\python.exe"
$script:Problems = @()

function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Info($m) { Write-Host "    $m" }
function Ok($m) { Write-Host "    OK    $m" -ForegroundColor Green }
function Warn($m) { Write-Host "    WARN  $m" -ForegroundColor Yellow; $script:Problems += $m }
function Die($m) { Write-Host "`nERROR $m" -ForegroundColor Red; exit 1 }

# Run a program; stop with a clear message if it fails.
function Exec([string]$what, [string]$exe, [string[]]$arguments) {
    if ($DryRun) { Write-Host "    [dry-run] $exe $($arguments -join ' ')"; return }
    & $exe @arguments
    if ($LASTEXITCODE -ne 0) { Die "$what failed (exit code $LASTEXITCODE)." }
}

# ---------------------------------------------------------------- 1. Python + venv

function Find-Python {
    $candidates = @(
        @{ exe = "py"; args = @("-3.14") }, @{ exe = "py"; args = @("-3.13") }, @{ exe = "py"; args = @("-3.12") },
        @{ exe = "python"; args = @() }
    )
    foreach ($c in $candidates) {
        if (-not (Get-Command $c.exe -ErrorAction SilentlyContinue)) { continue }
        try {
            $v = & $c.exe @($c.args + @("-c", "import sys; print('{}.{}'.format(*sys.version_info[:2]))")) 2>$null
            if ($LASTEXITCODE -eq 0 -and $v -and ([version]$v -ge [version]"3.12")) { return $c }
        } catch { }
    }
    return $null
}

function Setup-Venv {
    Step "Python environment ($Venv)"
    if (Test-Path $VenvPy) { Ok "reusing the existing environment" }
    else {
        $py = Find-Python
        if (-not $py) { Die "Python 3.12 or newer was not found. Install it (winget install Python.Python.3.12) and run this again." }
        Info "using $($py.exe) $($py.args -join ' ')"
        Exec "creating the virtual environment" $py.exe @($py.args + @("-m", "venv", $Venv))
    }
    Exec "upgrading pip" $VenvPy @("-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel", "--quiet")
}

# ---------------------------------------------------------------- 2. language-model library (AVX2 build)

function Test-LlamaHasAvx2 {
    if (-not (Test-Path $VenvPy)) { return $false }
    $info = & $VenvPy -c "import llama_cpp; print(llama_cpp.llama_print_system_info().decode())" 2>$null
    return ($LASTEXITCODE -eq 0 -and "$info" -match "AVX2 = 1")
}

function Find-Vcvars {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
    if (-not (Test-Path $vswhere)) { return $null }
    $dir = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
    if (-not $dir) { return $null }
    $bat = Join-Path ($dir | Select-Object -First 1) "VC\Auxiliary\Build\vcvars64.bat"
    if (Test-Path $bat) { return $bat }
    return $null
}

function Setup-LlamaCpp {
    Step "Language-model library (llama-cpp-python, built for this CPU)"
    if ($SkipLlamaRebuild) { Info "skipped (-SkipLlamaRebuild)"; return }
    if (Test-LlamaHasAvx2) { Ok "already built with AVX2: nothing to do"; return }
    $vcvars = Find-Vcvars
    if (-not $vcvars) {
        Warn ("Visual Studio Build Tools (C++) not found, so the model library comes as the generic wheel, which is 3-6x SLOWER than a build for this CPU. " +
              "To fix: winget install Microsoft.VisualStudio.2022.BuildTools --override `"--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended`" " +
              "then run this script again (the build takes ~6 minutes, once).")
        Exec "installing the generic llama-cpp-python wheel" $VenvPy @("-m", "pip", "install", "--prefer-binary", "llama-cpp-python>=0.3.0,<0.4",
            "--extra-index-url", "https://abetlen.github.io/llama-cpp-python/whl/cpu")
        return
    }
    Info "building llama-cpp-python with AVX2/FMA (about 6 minutes, once)"
    $wheels = Join-Path $env:TEMP "veda-llama-wheel"
    $bat = Join-Path $env:TEMP "veda-build-llama.bat"
    $lines = @(
        "@echo off",
        "call `"$vcvars`"",
        "if errorlevel 1 exit /b 1",
        "set `"CMAKE_ARGS=-DGGML_NATIVE=OFF -DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON -DGGML_BMI2=ON -DLLAMA_CURL=OFF -DGGML_CCACHE=OFF`"",
        "set FORCE_CMAKE=1",
        "set PIP_NO_INPUT=1",
        "`"$VenvPy`" -m pip wheel `"llama-cpp-python>=0.3.0,<0.4`" --no-binary llama-cpp-python --no-deps --no-cache-dir -w `"$wheels`""
    )
    if ($DryRun) { Write-Host "    [dry-run] would run $bat (MSVC + CMake) and install the wheel from $wheels"; return }
    Remove-Item $wheels -Recurse -Force -ErrorAction SilentlyContinue
    Set-Content -Path $bat -Value $lines -Encoding ASCII
    & cmd.exe /c $bat
    $wheel = Get-ChildItem $wheels -Filter "llama_cpp_python*.whl" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($LASTEXITCODE -ne 0 -or -not $wheel) {
        Warn "building llama-cpp-python failed: falling back to the generic (slower) wheel. Re-run later after checking the C++ build tools."
        Exec "installing the generic llama-cpp-python wheel" $VenvPy @("-m", "pip", "install", "--prefer-binary", "llama-cpp-python>=0.3.0,<0.4",
            "--extra-index-url", "https://abetlen.github.io/llama-cpp-python/whl/cpu")
        return
    }
    Exec "installing the built wheel" $VenvPy @("-m", "pip", "install", "--force-reinstall", "--no-deps", $wheel.FullName)
    if (Test-LlamaHasAvx2) { Ok "llama-cpp-python now uses AVX2/FMA" } else { Warn "the built library does not report AVX2" }
}

function Install-Veda {
    Step "Installing Veda (pip install -e .)"
    Exec "pip install" $VenvPy @("-m", "pip", "install", "--prefer-binary", "-e", $Root)
}

# ---------------------------------------------------------------- 3. mpv (the music player)

function Find-Mpv {
    $cmd = Get-Command mpv -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $roots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, (Join-Path $env:LOCALAPPDATA "Programs"))
    foreach ($r in $roots) { foreach ($d in @("MPV Player", "mpv")) {
        $p = Join-Path (Join-Path $r $d) "mpv.exe"; if (Test-Path $p) { return $p } } }
    $link = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links\mpv.exe"
    if (Test-Path $link) { return $link }
    return $null
}

function Setup-Mpv {
    Step "mpv (music player)"
    if ($SkipMpv) { Info "skipped (-SkipMpv)"; return }
    $p = Find-Mpv
    if ($p) { Ok "found $p"; return }
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Warn "mpv is missing and winget is not available. Install mpv from https://mpv.io/installation/ , then run this again. Music stays off until then."
        return
    }
    Exec "winget install mpv" "winget" @("install", "--id", "shinchiro.mpv", "-e", "--silent", "--accept-package-agreements", "--accept-source-agreements")
    $p = Find-Mpv
    if ($p) { Ok "installed: $p (Veda finds it even though it is not on PATH)" }
    elseif (-not $DryRun) { Warn "mpv was installed but not found yet. Open a NEW terminal, or set mpv_path in config\music.yaml." }
}

# ---------------------------------------------------------------- 4. models

$ModelInfo = @{
    "0.6b" = @{ url = "https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q4_K_M.gguf"; file = "Qwen3-0.6B-Q4_K_M.gguf"; profile = "qwen3-0.6b" }
    "1.7b" = @{ url = "https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_K_M.gguf"; file = "Qwen3-1.7B-Q4_K_M.gguf"; profile = "qwen3-1.7b" }
    "4b"   = @{ url = "https://huggingface.co/bartowski/Qwen_Qwen3-4B-GGUF/resolve/main/Qwen_Qwen3-4B-Q4_K_M.gguf"; file = "Qwen3-4B-Q4_K_M.gguf"; profile = "qwen3-4b" }
}

function Remote-Size([string]$url) {
    $h = & curl.exe -sIL --max-time 30 $url 2>$null
    $len = ($h | Select-String -Pattern "^content-length:\s*(\d+)" -AllMatches | ForEach-Object { $_.Matches } | Select-Object -Last 1)
    if ($len) { return [int64]$len.Groups[1].Value }
    return 0
}

# Resumable, size-checked download into <dest>.part, then moved into place: a half-downloaded model never sits at its final path.
function Fetch([string]$url, [string]$dest) {
    $name = Split-Path $dest -Leaf
    $want = Remote-Size $url
    $have = 0; if (Test-Path $dest) { $have = (Get-Item $dest).Length }
    if ($have -gt 0 -and ($want -eq 0 -or $have -eq $want)) { Ok "$name already downloaded"; return }
    if ($DryRun) { Info "[dry-run] would download $name ($want bytes)"; return }
    New-Item -ItemType Directory -Force (Split-Path $dest -Parent) | Out-Null
    Info "downloading $name ($([math]::Round($want / 1MB)) MB; safe to stop and re-run)"
    & curl.exe -fL -C - --retry 5 --retry-delay 3 -o "$dest.part" $url
    if ($LASTEXITCODE -ne 0) { Die "download failed: $url  (run this script again to resume)" }
    $got = (Get-Item "$dest.part").Length
    if ($want -gt 0 -and $got -ne $want) { Die "${name}: got $got bytes but expected $want. Run this script again to resume." }
    Move-Item -Force "$dest.part" $dest
    Ok $name
}

function Setup-Models {
    Step "Models (data\)"
    if ($SkipModels) { Info "skipped (-SkipModels)"; return }
    if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) { Die "curl.exe not found (it ships with Windows 10 and 11)." }
    $m = $ModelInfo[$Model]
    Info "language model ($Model)"
    Fetch $m.url (Join-Path $Root "data\$($m.file)")

    Info "speech-to-text (faster-whisper base.en)"
    $w = "https://huggingface.co/Systran/faster-whisper-base.en/resolve/main"
    foreach ($f in @("config.json", "model.bin", "tokenizer.json", "vocabulary.txt")) { Fetch "$w/$f" (Join-Path $Root "data\models\whisper-base.en\$f") }

    Info "memory (BGE-small sentence embeddings)"
    $e = "https://huggingface.co/BAAI/bge-small-en-v1.5/resolve/main"
    Fetch "$e/onnx/model.onnx" (Join-Path $Root "data\bge-small-en-v1.5\model.onnx")
    Fetch "$e/tokenizer.json" (Join-Path $Root "data\bge-small-en-v1.5\tokenizer.json")

    Info "wake word helper models (openwakeword feature extractors, 2.4 MB)"
    $dir = & $VenvPy -c "import importlib.util, os; s = importlib.util.find_spec('openwakeword'); print(os.path.join(os.path.dirname(s.origin), 'resources', 'models') if s and s.origin else '')" 2>$null
    if ($dir -and (Test-Path (Split-Path $dir -Parent))) {
        foreach ($f in @("melspectrogram.onnx", "embedding_model.onnx")) {
            Fetch "https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/$f" (Join-Path $dir $f)
        }
    } else { Warn "openwakeword is not installed in .venv, so its helper models were not downloaded." }
}

function Check-WakeModel {
    Step "Wake-word model (you copy this one)"
    $d = Join-Path $Root "data\models\openwakeword"
    $missing = $false
    foreach ($f in @("hey_veda.onnx", "hey_veda.onnx.data")) {
        if (Test-Path (Join-Path $d $f)) { Ok $f } else { Warn "missing: $d\$f"; $missing = $true }
    }
    if ($missing) { Info "copy BOTH files into $d . Until then voice stays off (text chat, reminders and music by typing still work)." }
}

# ---------------------------------------------------------------- 5. .env + verify

function Setup-Env {
    Step ".env (API keys)"
    $envFile = Join-Path $Root ".env"
    if (Test-Path $envFile) { Ok ".env already exists" }
    elseif (Test-Path (Join-Path $Root ".env.example")) {
        if ($DryRun) { Info "[dry-run] would create .env from .env.example" } else { Copy-Item (Join-Path $Root ".env.example") $envFile; Ok "created .env from .env.example" }
    } else { Warn "no .env.example found; create .env yourself if you need API keys" }
    Info "web search needs TAVILY_API_KEY in .env (weather and currency need no key)."
}

function Verify {
    Step "Checking the install"
    if ($DryRun -or -not (Test-Path $VenvPy)) { Info "skipped"; return }
    $code = @'
import importlib, sys
checks = {"fastapi": "web server", "llama_cpp": "language model", "faster_whisper": "speech-to-text", "sounddevice": "microphone/speaker",
          "openwakeword": "wake word", "piper": "text-to-speech", "onnxruntime": "model runtime", "tokenizers": "semantic memory tokenizer",
          "yt_dlp": "music search", "pyttsx3": "Windows voice"}
failed = 0
for module, what in checks.items():
    try:
        importlib.import_module(module); print(f"    OK    {module:15} ({what})")
    except Exception as exc:
        failed += 1; print(f"    FAIL  {module:15} ({what}): {type(exc).__name__}: {exc}")
sys.exit(1 if failed else 0)
'@
    $code | & $VenvPy -
    if ($LASTEXITCODE -ne 0) { Warn "some packages failed to import (see above)." }
    if (Test-Path (Join-Path $Venv "Scripts\veda.exe")) { Ok "the 'veda' command is installed" } else { Warn "the 'veda' command was not created" }
    if (Test-LlamaHasAvx2) { Ok "language model library: AVX2 build (fast)" } else { Warn "language model library: generic build (slow, see above)" }
    $mpv = Find-Mpv
    if ($mpv) { Ok "mpv: $mpv" } else { Warn "mpv not found: music stays off" }
    if (Test-Path (Join-Path $Venv "Scripts\yt-dlp.exe")) { Ok "yt-dlp installed" } else { Warn "yt-dlp not found: music stays off" }
}

function Summary {
    Step "Done"
    if ($DryRun) { Write-Host "    That was a dry run: nothing was changed." }
    Write-Host @"
    Next:
      1. copy data\models\openwakeword\hey_veda.onnx and hey_veda.onnx.data from where you trained it (if not done)
      2. put TAVILY_API_KEY in $Root\.env for web search; Google mail/calendar: see the .env comments, then 'veda login'
      3. start Veda:
             .\.venv\Scripts\Activate.ps1
             veda
         (or run.bat). The microphone starts muted; unmute from the prompt with /unmute.
      4. try: "play Tum Hi Ho", "remind me at <time> to ...", "is it hot in here" (mock sensor on a laptop)
"@
    if ($ModelInfo[$Model].profile -ne "qwen3-4b") { Write-Host "      Set VEDA_PROFILE=$($ModelInfo[$Model].profile) in .env for the $Model model." }
    if ($script:Problems.Count) {
        Write-Host "`n    Things to look at:" -ForegroundColor Yellow
        $script:Problems | ForEach-Object { Write-Host "      - $_" -ForegroundColor Yellow }
    }
}

# ---------------------------------------------------------------- main

if ($DryRun) { Info "DRY RUN: nothing will be changed" }
Set-Location $Root
if (-not (Test-Path (Join-Path $Root "pyproject.toml"))) { Die "pyproject.toml not found in $Root; run this from a full checkout of the repo." }
Setup-Venv
Setup-LlamaCpp
Install-Veda
Setup-Mpv
Setup-Models
Check-WakeModel
Setup-Env
Verify
Summary
