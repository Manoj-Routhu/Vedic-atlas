"""Tune Veda's voice detector to YOUR room and YOUR voice.

    python scripts/mic_calibrate.py                 # asks you to stay quiet, then to speak
    python scripts/mic_calibrate.py --seconds 8

Stop the Veda server first (only one program can hold the microphone).

Why: the detector decides "someone is speaking" by loudness (`vad.min_rms` and `vad.speech_ratio` in config/audio.yaml).
In a room whose background is close to a quiet voice, every click or fan burst becomes a short "utterance" that is sent to
Whisper, and while it is processed the microphone is paused, so the start of your real command can be lost. The right
threshold depends on the room and on how loudly you speak, so this measures both. Nothing is saved: only levels are kept.
"""

from __future__ import annotations

import argparse
import sys
import time
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

FRAME = 320   # 20 ms at 16 kHz


def record(mic, np, seconds: float) -> list:
    """Frames (int16 arrays) from the microphone for `seconds`."""
    frames, end = [], time.time() + seconds
    while time.time() < end:
        window = mic.read(timeout=0.5)
        if window is not None:
            frames.append(np.frombuffer(window.pcm, dtype=np.int16).copy())
    return frames


def rms_of(np, frames) -> "list[float]":
    return [float(np.sqrt(np.mean(f.astype(np.float32) ** 2))) for f in frames]


def count_clips(np, frames, min_rms: float, ratio: float, cfg) -> list:
    """How many utterances Veda's own detector + collector would cut from these frames with these settings."""
    from domain.value_objects.audio_window import AudioWindow
    from service.voice.utterance_collector import UtteranceCollector
    from tpa.audio.energy_vad import EnergyVadDetector

    v = cfg.audio.vad
    vad = EnergyVadDetector(frame_duration_ms=v.frame_duration_ms, sample_rate=16000, min_rms=min_rms, speech_ratio=ratio,
                            noise_adapt=v.noise_adapt)
    col = UtteranceCollector(vad=vad, start_frames=v.start_frames, silence_ms=v.silence_ms,
                             max_duration_sec=v.max_utterance_sec, pre_roll_frames=v.pre_roll_frames)
    clips = []
    for f in frames:
        u = col.push(AudioWindow(pcm=f.tobytes(), sample_rate=16000, channels=1, started_at=datetime.now(), duration_sec=0.02))
        if u is not None:
            clips.append(round(u.duration_sec, 1))
    return clips


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--seconds", type=float, default=8.0, help="length of each of the two recordings (default 8)")
    ap.add_argument("--no-wait", action="store_true", help="do not wait for Enter between steps (for scripted runs)")
    args = ap.parse_args()

    import numpy as np

    from bootstrap.builders.audio import build_audio_capture
    from core.config import load_full_config

    cfg = load_full_config()
    v = cfg.audio.vad
    mic = build_audio_capture(cfg)
    print(f"microphone: device index {mic.device_index} | current vad.min_rms={v.min_rms:g} speech_ratio={v.speech_ratio:g} "
          f"start_frames={v.start_frames}\n")

    def step(prompt: str) -> None:
        print(prompt)
        if not args.no_wait:
            input("  press Enter when ready... ")

    mic.start()
    try:
        step(f"1/2  STAY QUIET for {args.seconds:g} s (leave the room as it normally is: fan, laptop, everything).")
        quiet = record(mic, np, args.seconds)
        step(f"\n2/2  SPEAK for {args.seconds:g} s in your normal voice, a few sentences, at the distance you really use "
             "(for example: 'what is the weather today, and what time is it').")
        speech = record(mic, np, args.seconds)
    finally:
        mic.stop()

    q, s = np.array(rms_of(np, quiet)), np.array(rms_of(np, speech))
    q50, q90, q99 = (float(np.percentile(q, p)) for p in (50, 90, 99))
    loud = s[s > q90] if (s > q90).any() else s            # the frames that are actually speech
    s25, s50 = float(np.percentile(loud, 25)), float(np.percentile(loud, 50))
    print("\n--- what I measured (RMS on the int16 scale, so 300 means 0.009 of full scale)")
    print(f"quiet room : median {q50:.0f} | 90% of frames below {q90:.0f} | 99% below {q99:.0f}")
    print(f"your voice : median of the speech frames {s50:.0f} | quiet end (25th percentile) {s25:.0f}")
    now = count_clips(np, quiet, v.min_rms, v.speech_ratio, cfg)
    print(f"\nwith today's settings the quiet recording alone produced {len(now)} utterance(s) {now} -> each one is sent to Whisper")

    separation = s25 / max(q99, 1.0)
    if separation < 1.3:
        print(f"\nYour quiet voice ({s25:.0f}) is barely louder than the room's loudest moments ({q99:.0f}); no loudness threshold can "
              "separate them cleanly. Move closer to the microphone, speak a little louder, or reduce the background sound, "
              "then run this again.")
        return 1
    # halfway (geometric mean) between the room's loud moments and the quiet end of your voice
    suggest = int(round((q99 * s25) ** 0.5, -1))
    suggest = max(suggest, int(v.min_rms))
    after = count_clips(np, quiet, suggest, v.speech_ratio, cfg)
    caught = (s > suggest).mean() * 100
    print(f"\nSuggested: vad.min_rms: {suggest}   (config/audio.yaml; today {v.min_rms:g})")
    print(f"  quiet recording would then produce {len(after)} utterance(s) {after}; {caught:.0f}% of the frames in your speech recording are above it")
    if len(after) == 0 and caught > 40:
        print("  Looks good. Edit vad.min_rms in config/audio.yaml and restart Veda.")
    else:
        print("  Not clean: still noisy or the speech is quiet. Try moving closer to the microphone and run this again.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
