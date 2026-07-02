"""Per-game cache of OCR results for STASHED images.

Reopening the graph re-runs detect/preview/item-read on the saved window images
and item cutouts every boot — seconds of OCR (cold engine + serialized lock = the
load-time variance) for images and box layouts that didn't change since last load.
This caches each result so a warm boot reads a sidecar instead of touching the OCR
engine at all.

Persisted to ``data/<game>/ocr_cache.json`` as ``{key_hash: payload}``. The key
hashes the IMMUTABLE image id (a timestamped capture / cutout filename) together
with a canonical dump of the OCR-affecting inputs (the window def + fields). Any
box / region / detector change moves the hash → cache miss → fresh read. Live grabs
(no stashed image) are never cached — their pixels vary frame to frame.
"""

from __future__ import annotations

import hashlib
import json
import os
import threading
from pathlib import Path
from typing import Any


def cache_key(image_id: str, config: Any, engine_sig: str = "") -> str:
    """Stable hash of an immutable image id + the inputs that change OCR output.
    ``engine_sig`` is the OCR backend's own fingerprint (``ocr_sig``: backend name,
    inference engine, model options) — swapping the engine moves every key, so stale
    results from another engine are never served as fresh reads."""
    blob = image_id + "\x00" + json.dumps(config, sort_keys=True, default=str, ensure_ascii=False) \
        + "\x00" + engine_sig
    return hashlib.sha1(blob.encode("utf-8")).hexdigest()


class OcrCache:
    def __init__(self, path: Path | str) -> None:
        self._path = Path(path)
        self._entries: dict[str, dict] = {}
        self._dirty = False
        # One instance is shared per game (lru_cache in deps) and FastAPI runs the sync OCR routes
        # in a threadpool — boot fires several reads at once. Guard the dict + the file swap so
        # concurrent put/save can't corrupt state or race the rename (WinError 32 on Windows).
        self._lock = threading.Lock()
        self._load()

    def _load(self) -> None:
        if self._path.exists():
            try:
                self._entries = json.loads(self._path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                self._entries = {}   # a corrupt cache is rebuildable — just recompute

    def get(self, key: str) -> dict | None:
        with self._lock:
            return self._entries.get(key)

    def put(self, key: str, value: dict) -> None:
        with self._lock:
            if self._entries.get(key) == value:
                return
            self._entries[key] = value
            self._dirty = True

    def save(self) -> None:
        with self._lock:
            if not self._dirty:
                return
            self._path.parent.mkdir(parents=True, exist_ok=True)
            # Unique temp per writer so two concurrent saves never share (or clobber) one tmp; the
            # whole swap stays under the lock so only one rename targets the cache at a time.
            tmp = self._path.with_name(f"{self._path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
            try:
                tmp.write_text(json.dumps(self._entries, ensure_ascii=False), encoding="utf-8")
                os.replace(tmp, self._path)   # atomic swap so a crash mid-write can't truncate it
                self._dirty = False
            except OSError:
                # rebuildable cache — a transient lock collision must never 500 the read it rode in on
                try:
                    tmp.unlink()
                except OSError:
                    pass

    @classmethod
    def for_game(cls, data_dir: Path | str, game: str) -> "OcrCache":
        return cls(Path(data_dir) / game / "ocr_cache.json")
