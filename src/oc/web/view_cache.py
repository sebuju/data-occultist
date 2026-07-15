"""Per-game on-disk cache of computed subset views, so a cold boot doesn't recompute
every subset's join/pivot/derive/filter/sort from scratch.

``flow.py``'s in-memory ``_VIEW_CACHE`` already avoids recompute WITHIN one running
process, but it's empty on every fresh process (a `serve` restart, `--reload` worker
swap) — the graph boot's one-shot ``/flow/<game>/details`` request then pays the full
recompute cost for every subset at once. This mirrors that cache to
``data/<game>/view_cache.json`` so a warm boot reads the sidecar instead.

Each entry is keyed by subset id and holds the SAME rev signature
(``[[dataset, rev], ...]``) the in-memory cache gates on, plus the computed
``{columns, rows}``. A source dataset's rev bump (any write) moves the signature ->
cache miss -> recompute, same invalidation as the in-memory cache — no new hook
needed. ``sig`` is :func:`~oc.web.view_code_sig.view_code_sig`, checked once at load
so a change to the compute logic (not just the data) busts every entry, same as
:class:`~oc.web.ocr_cache.OcrCache`.
"""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path

from ..filelock import file_lock
from .view_code_sig import view_code_sig


class ViewCache:
    def __init__(self, path: Path | str, game: str = "") -> None:
        self._path = Path(path)
        self._game = game
        self._entries: dict[str, dict] = {}
        self._dirty = False
        # One instance is shared per game (lru_cache in deps); guard the dict + file
        # swap so concurrent put/save can't corrupt state or race the rename (WinError
        # 32 on Windows) — same shape as OcrCache.
        self._lock = threading.Lock()
        self._sig = view_code_sig()
        self._load()

    def _read_disk(self) -> dict:
        if self._path.exists():
            try:
                return json.loads(self._path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                return {}
        return {}

    @staticmethod
    def _split(disk: dict) -> tuple[str, dict]:
        if "entries" in disk:
            return disk.get("sig", ""), disk.get("entries") or {}
        return "", {}

    def _load(self) -> None:
        disk_sig, entries = self._split(self._read_disk())
        if disk_sig != self._sig:
            self._entries = {}
            self._dirty = True
            # Persist the new sig now, not on the next put() — otherwise a second
            # restart before any subset is computed reads the same stale sig again.
            self.save()
        else:
            self._entries = entries

    def get(self, sid: str) -> dict | None:
        """The raw stored entry ``{"rk": [...], "result": {...}}`` for a subset, or
        ``None``. Caller compares ``rk`` against the current rev signature — this
        cache doesn't know what "current" means, just what was last computed."""
        with self._lock:
            return self._entries.get(sid)

    def put(self, sid: str, rk: list, result: dict) -> None:
        with self._lock:
            entry = {"rk": rk, "result": result}
            if self._entries.get(sid) == entry:
                return
            self._entries[sid] = entry
            self._dirty = True

    def _replace(self, tmp: Path) -> None:
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
            if not self._dirty and self._path.exists():
                return
            self._path.parent.mkdir(parents=True, exist_ok=True)
            # Cross-process guard, same reasoning as OcrCache: re-read + merge under a
            # file lock instead of clobbering another process's saved entries. Entries
            # are deterministic by (sid, rk), so two processes computing the same
            # subset at the same revs always agree — merge can only UNION.
            with file_lock(self._path):
                disk_sig, disk_entries = self._split(self._read_disk())
                merged = {**(disk_entries if disk_sig == self._sig else {}), **self._entries}
                tmp = self._path.with_name(f"{self._path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
                try:
                    payload = {"sig": self._sig, "entries": merged}
                    tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
                    self._replace(tmp)
                    self._entries = merged
                    self._dirty = False
                except OSError:
                    try:
                        tmp.unlink()
                    except OSError:
                        pass

    @classmethod
    def for_game(cls, data_dir: Path | str, game: str) -> "ViewCache":
        return cls(Path(data_dir) / game / "view_cache.json", game=game)
