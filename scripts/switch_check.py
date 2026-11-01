"""Check the hardware mute switch (BCM 17 = header pin 11; 3V3 on pin 1, GND on pin 6) without starting Veda.

    python scripts/switch_check.py               # watch the switch for 20 s, print every flip
    python scripts/switch_check.py --seconds 60
    python scripts/switch_check.py --pin 17 --muted-level high

Stop the Veda server first (only one program can own the pin). Flip the switch while it runs.
It reads the pin the way Veda's GpioMuteSwitch does (RPi.GPIO, the rpi-lgpio build on a Pi 5) and reports:

    level    the raw pin level, HIGH or LOW
    meaning  MUTED or LIVE, using mute_gpio_muted_level from config/privacy.yaml

OK means both positions were seen and the level changed. Run it with the same python Veda uses
(.venv/bin/python): if it says the GPIO library is missing there, Veda falls back to the software
switch and the physical one does nothing.
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]


def _load_privacy() -> dict:
    return yaml.safe_load((ROOT / "config" / "privacy.yaml").read_text(encoding="utf-8")) or {}


def main() -> int:
    privacy = _load_privacy()
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--pin", type=int, default=privacy.get("mute_gpio_pin", 17), help="BCM pin (default: from config/privacy.yaml)")
    parser.add_argument("--muted-level", choices=("low", "high"), default=privacy.get("mute_gpio_muted_level", "low"),
                        help="pin level that means MUTED (default: from config/privacy.yaml)")
    parser.add_argument("--seconds", type=float, default=20.0, help="how long to watch (default 20)")
    args = parser.parse_args()

    try:
        import RPi.GPIO as GPIO
    except ImportError as e:
        print(f"GPIO library missing for {sys.executable}: {e}")
        print("Veda would fall back to the software mute switch. Install it with: pip install rpi-lgpio")
        return 2

    muted_is_high = args.muted_level == "high"
    GPIO.setmode(GPIO.BCM)
    # The switch drives the pin to 3V3 or GND, so the pull only matters for a broken wire; same as GpioMuteSwitch.
    GPIO.setup(args.pin, GPIO.IN, pull_up_down=GPIO.PUD_UP if muted_is_high else GPIO.PUD_DOWN)

    def read() -> tuple[str, str]:
        high = GPIO.input(args.pin) == GPIO.HIGH
        return ("HIGH" if high else "LOW"), ("MUTED" if high == muted_is_high else "LIVE")

    try:
        print(f"GPIO{args.pin} (muted when {args.muted_level.upper()}), watching {args.seconds:g} s. Flip the switch.")
        level, meaning = read()
        print(f"  start   level={level:<4} meaning={meaning}")
        seen = {level}
        last = level
        deadline = time.time() + args.seconds
        while time.time() < deadline:
            time.sleep(0.02)
            level, meaning = read()
            if level == last:
                continue
            time.sleep(0.05)               # debounce, like Veda's 50 ms
            level, meaning = read()
            if level != last:
                last = level
                seen.add(level)
                print(f"  flip    level={level:<4} meaning={meaning}")
    finally:
        GPIO.cleanup(args.pin)

    if len(seen) == 2:
        print("OK: the pin saw both HIGH and LOW, so the switch wiring works.")
        return 0
    print(f"NOT OK: the pin only ever read {seen.pop()}. Check pins 1, 6 and 11 and flip the switch while this runs.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
