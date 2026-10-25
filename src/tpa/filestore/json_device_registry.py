"""JsonDeviceRegistry - paired devices in data/devices.json, owned by the server process.

Only a hash of each token is stored. The file is replaced atomically so a crash mid-write can't leave
half a registry; `last_seen` is kept in memory and written at most once a minute.
"""

from __future__ import annotations

import json
import os
import threading
from datetime import datetime, timedelta
from pathlib import Path

from core.constants import DATA_DIR
from core.logging_config import logger
from domain.entities.device import Device

_DEFAULT_PATH = DATA_DIR / "devices.json"
_TOUCH_PERSIST_EVERY = timedelta(minutes=1)


class JsonDeviceRegistry:
    def __init__(self, path: str | Path | None = None):
        self._path = Path(path) if path else _DEFAULT_PATH
        self._lock = threading.Lock()
        self._by_hash: dict[str, Device] = {}
        self._last_persist = datetime.min
        self._load()

    def add(self, device: Device) -> None:
        with self._lock:
            self._by_hash[device.token_hash] = device
            self._save()

    def get_by_token_hash(self, token_hash: str) -> Device | None:
        with self._lock:
            return self._by_hash.get(token_hash)

    def list(self) -> list[Device]:
        with self._lock:
            return sorted(self._by_hash.values(), key=lambda d: d.created_at)

    def remove(self, device_id: str) -> bool:
        with self._lock:
            for token_hash, device in list(self._by_hash.items()):
                if device.id == device_id:
                    del self._by_hash[token_hash]
                    self._save()
                    return True
        return False

    def touch(self, device_id: str) -> None:
        now = datetime.now()
        with self._lock:
            for device in self._by_hash.values():
                if device.id == device_id:
                    device.last_seen = now
                    break
            if now - self._last_persist >= _TOUCH_PERSIST_EVERY:
                self._save()

    # --- file I/O (callers hold the lock) ---

    def _load(self) -> None:
        if not self._path.exists():
            return
        try:
            rows = json.loads(self._path.read_text(encoding="utf-8"))
            for row in rows:
                device = Device(
                    id=row["id"], name=row["name"], scopes=frozenset(row["scopes"]), token_hash=row["token_hash"],
                    created_at=datetime.fromisoformat(row["created_at"]),
                    last_seen=datetime.fromisoformat(row["last_seen"]) if row.get("last_seen") else None,
                )
                self._by_hash[device.token_hash] = device
        except (OSError, ValueError, KeyError, TypeError) as e:
            # Fail closed: an unreadable registry means no phone is trusted, not that every phone is.
            logger.error(f"[devices] could not read {self._path} ({type(e).__name__}); starting with no paired devices")
            self._by_hash.clear()

    def _save(self) -> None:
        rows = [
            {
                "id": d.id, "name": d.name, "scopes": sorted(d.scopes), "token_hash": d.token_hash,
                "created_at": d.created_at.isoformat(timespec="seconds"),
                "last_seen": d.last_seen.isoformat(timespec="seconds") if d.last_seen else None,
            }
            for d in self._by_hash.values()
        ]
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(rows, indent=2), encoding="utf-8")
        os.replace(tmp, self._path)
        self._last_persist = datetime.now()
