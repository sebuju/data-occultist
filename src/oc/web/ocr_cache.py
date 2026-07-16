"""Per-game cache of OCR results for STASHED images.

Reopening the graph re-runs detect/preview/item-read on the saved window images
and item cutouts every boot — seconds of OCR (cold engine + serialized lock = the
load-time variance) for images and box layouts that didn't change since last load.
This caches each result so a warm boot reads a sidecar instead of touching the OCR
engine at all.

Persisted to ``data/<game>/ocr_cache.json`` as ``{"sig": <code_sig>, "entries":
{key_hash: payload}}``. The key hashes the IMMUTABLE image id (a timestamped
capture / cutout filename) together with a canonical dump of the OCR-affecting
inputs (the window def + fields) and the engine's own fingerprint. Any box /
region / detector / engine change moves the hash → cache miss → fresh read. Live
grabs (no stashed image) are never cached — their pixels vary frame to frame.

``sig`` is :func:`~oc.web.ocr_code_sig.ocr_code_sig` — a content hash of the
read-affecting OCR source files. Editing OCR code doesn't move any per-key hash,
so it's checked once at load: a mismatch wipes every entry (the code changed, not
just the config) and logs a one-line notice to the game's activity feed. Because
it hashes bytes, not mtimes, a checkout / reinstall that leaves the code identical
does not bust it.
"""

from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from pathlib import Path
from typing import Any

from ..filelock import file_lock
from .ocr_code_sig import ocr_code_sig


def cache_key(image_id: str, config: Any, engine_sig: str = "") -> str:
    """Stable hash of an immutable image id + the inputs that change OCR output.
    ``engine_sig`` is the OCR backend's own fingerprint (``ocr_sig``: backend name,
    inference engine, model options) — swapping the engine moves every key, so stale
    results from another engine are never served as fresh reads."""
    blob = image_id + "\x00" + json.dumps(config, sort_keys=True, default=str, ensure_ascii=False) \
        + "\x00" + engine_sig
    return hashlib.sha1(blob.encode("utf-8")).hexdigest()


class OcrCache:
    def __init__(self, path: Path | str, game: str = "") -> None:
        self._path = Path(path)
        self._game = game
        self._entries: dict[str, dict] = {}
        self._dirty = False
        # One instance is shared per game (lru_cache in deps) and FastAPI runs the sync OCR routes
        # in a threadpool — boot fires several reads at once. Guard the dict + the file swap so
        # concurrent put/save can't corrupt state or race the rename (WinError 32 on Windows).
        self._lock = threading.Lock()
        self._sig = ocr_code_sig()
        self._load()

    def _read_disk(self) -> dict:
        """Whatever is currently on disk, or ``{}`` if missing/corrupt (rebuildable)."""
        if self._path.exists():
            try:
                return json.loads(self._path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                return {}
        return {}

    @staticmethod
    def _split(disk: dict) -> tuple[str, dict]:
        """Pull (sig, entries) out of a raw disk dict. An old flat-format cache
        (no "entries" key, from before the code-sig bust existed) has no sig to
        compare against — treat it as sig-less so it busts under the new code."""
        if "entries" in disk:
            return disk.get("sig", ""), disk.get("entries") or {}
        return "", {}

    def _load(self) -> None:
        disk_sig, entries = self._split(self._read_disk())
        if disk_sig != self._sig:
            if entries:
                self._notify_bust(len(entries))
            self._entries = {}
            self._dirty = True
            # Persist the new sig NOW, not on the next request's put(). Otherwise a second
            # restart before any OCR read (e.g. two quick dev reloads) reads the same stale
            # sig off disk again and re-busts + re-publishes for what's really one change.
            self.save()
        else:
            self._entries = entries

    def _notify_bust(self, dropped: int) -> None:
        # Deferred import: keeps this module cycle-free for anything importing it before
        # the web app is wired up (matches the gpu_watch.py pattern). A publish failure
        # must never break a cache load.
        try:
            from ..eventlog import publish

            publish(
                f"OCR cache busted — code changed ({dropped} entries dropped)",
                level="warn", game=self._game or None,
            )
        except Exception:
            pass

    def get(self, key: str) -> dict | None:
        with self._lock:
            return self._entries.get(key)

    def put(self, key: str, value: dict) -> None:
        with self._lock:
            if self._entries.get(key) == value:
                return
            self._entries[key] = value
            self._dirty = True

    def _replace(self, tmp: Path) -> None:
        # Windows can transiently fail a rename over a file another process just touched
        # (WinError 32, sharing violation) — retry briefly rather than dropping the save.
        for attempt in range(5):
            try:
                os.replace(tmp, self._path)
                return
            except OSError:
                if attempt == 4:
                    raise
                time.sleep(0.02)

    def save(self) -> None:
        with self._lock:
            # Not dirty is normally "nothing to do" — but if the sidecar was deleted out from
            # under a live process (in-memory entries unchanged, so put() never dirtied us),
            # that's still a reason to write: self-heal rather than staying gone until restart.
            if not self._dirty and self._path.exists():
                return
            self._path.parent.mkdir(parents=True, exist_ok=True)
            # Cross-process guard: another OcrCache instance (desktop app run alongside `serve`,
            # or a `--reload` worker overlapping its predecessor) may have saved keys since we
            # last loaded — re-read + merge under a file lock instead of clobbering them. Entries
            # are deterministic by key (a hash of the immutable image id + every OCR-affecting
            # input), so two processes computing the same key always agree: a merge can only
            # UNION, never conflict. Only merge disk entries that match OUR code sig — a
            # differing disk sig means those entries came from other (older/newer) code and
            # must not be re-absorbed after this instance already decided to bust them.
            with file_lock(self._path):
                disk_sig, disk_entries = self._split(self._read_disk())
                merged = {**(disk_entries if disk_sig == self._sig else {}), **self._entries}
                # Unique temp per writer so two concurrent saves never share (or clobber) one tmp.
                tmp = self._path.with_name(f"{self._path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
                try:
                    payload = {"sig": self._sig, "entries": merged}
                    tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
                    self._replace(tmp)   # atomic swap so a crash mid-write can't truncate it
                    self._entries = merged   # adopt the merge so we don't re-save the other side's keys
                    self._dirty = False
                except OSError:
                    # rebuildable cache — a transient lock collision must never 500 the read it rode in on
                    try:
                        tmp.unlink()
                    except OSError:
                        pass

    @classmethod
    def for_game(cls, data_dir: Path | str, game: str) -> "OcrCache":
        return cls(Path(data_dir) / game / "ocr_cache.json", game=game)
