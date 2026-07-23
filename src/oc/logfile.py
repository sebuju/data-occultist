"""Shared write-only rotating line-log primitive.

Both the front-end log bar (:mod:`oc.web.routes.logbar`) and the node-history mirror
(:mod:`oc.collect.nodelog_file`) persist a stream of one-line records to
``logs/<prefix><stamp>.log``, one fresh file per session, keep-last-N — the same
snapshot-store dance (:mod:`oc.backup`) with the same shape of caller. This used to be two
copies of the same ``open(path, "a") -> write -> close`` per line, each guarded by its own
lock. That per-line open/close is the thing that made ``POST /api/logbar/emit`` spike to
~1s under an antivirus scan or a synced ``logs/`` dir: the close/flush ran on the request
thread (a sync FastAPI route runs in the AnyIO threadpool) and serialized against every
other bus publisher via the shared lock.

:class:`LineLog` fixes both problems at once: ``write`` only ever does a ``queue.Queue.put``
(never blocks, never touches disk) and a single background daemon thread owns the one open
handle, draining whatever queued up since its last turn and flushing once per batch. Disk
latency — and any AV-scan stall — now lands on the daemon, never on the caller.

Write-only, like both callers: nothing reads these files back (no route, no boot replay), so
losing an in-flight batch on abrupt process death is an acceptable trade for "the caller
never blocks."
"""

from __future__ import annotations

import os
import queue
import threading
from datetime import datetime
from pathlib import Path

from . import backup

_Job = tuple[str, object]  # ("line", str) | ("rotate", Path)


class LineLog:
    """One rotating, keep-last-N, prefix-scoped line log, written on a background thread."""

    def __init__(self, prefix: str, *, log_dir: Path = Path("logs"), ext: str = "log",
                 keep: int = 10) -> None:
        self._prefix = prefix
        self._dir = log_dir
        self._ext = ext
        self._keep = keep
        self._lock = threading.Lock()
        self._current: Path | None = None
        self._queue: queue.Queue[_Job] = queue.Queue()
        self._thread: threading.Thread | None = None

    def _new_path(self, now: datetime) -> Path:
        """A fresh ``<prefix><stamp>.<ext>`` path, bumping a suffix on a same-second collision."""
        self._dir.mkdir(parents=True, exist_ok=True)
        stamp = now.strftime("%Y%m%d-%H%M%S")
        path = self._dir / f"{self._prefix}{stamp}.{self._ext}"
        n = 1
        while path.exists():
            path = self._dir / f"{self._prefix}{stamp}-{n}.{self._ext}"
            n += 1
        return path

    def _prune(self) -> None:
        stamps = [p.stem for p in backup.list_snapshots(self._dir, self._ext, prefix=self._prefix)]
        keep = backup.keep_last_n(stamps, self._keep)
        backup.prune(self._dir, self._ext, keep, prefix=self._prefix)

    def existing_files(self) -> list[Path]:
        """This log's ``<prefix>*.<ext>`` files, oldest first."""
        return backup.list_snapshots(self._dir, self._ext, prefix=self._prefix)

    def _ensure_writer(self) -> None:
        if self._thread is None:
            self._thread = threading.Thread(target=self._run, daemon=True)
            self._thread.start()

    def rotate(self) -> str | None:
        """Start a fresh file, pruning to the last N. No-ops under pytest — see
        :mod:`oc.web.routes.logbar` / :mod:`oc.collect.nodelog_file` for why."""
        if os.environ.get("PYTEST_CURRENT_TEST"):
            return None
        try:
            with self._lock:
                self._current = self._new_path(datetime.now())
                self._current.touch()
                self._prune()
                path = self._current
        except OSError:
            return None
        self._ensure_writer()
        self._queue.put(("rotate", path))
        return path.name

    def attach(self, path: Path) -> str:
        """Reuse an already-rotated file (a ``--reload`` worker respawn picking the same
        launch's file back up) instead of minting + pruning a new one."""
        with self._lock:
            self._current = path
        self._ensure_writer()
        self._queue.put(("rotate", path))
        return path.name

    def write(self, line: str) -> None:
        """Enqueue one line for the background writer. Never blocks, never raises. No-ops
        under pytest."""
        if os.environ.get("PYTEST_CURRENT_TEST"):
            return
        with self._lock:
            if self._current is None:
                self._current = self._new_path(datetime.now())
        self._ensure_writer()
        self._queue.put(("line", line))

    def _run(self) -> None:
        fh = None
        target: Path | None = None
        while True:
            kind, payload = self._queue.get()
            try:
                if kind == "rotate":
                    if fh is not None:
                        fh.close()
                        fh = None
                    target = payload  # type: ignore[assignment]
                    continue
                if target is None:
                    with self._lock:
                        if self._current is None:
                            self._current = self._new_path(datetime.now())
                        target = self._current
                if fh is None:
                    fh = open(target, "a", encoding="utf-8")
                fh.write(payload)  # type: ignore[arg-type]
                # Drain whatever else queued up since we last looked, so a burst of
                # emits costs one flush instead of one open/write/close each.
                while True:
                    try:
                        kind2, payload2 = self._queue.get_nowait()
                    except queue.Empty:
                        break
                    if kind2 == "rotate":
                        fh.close()
                        fh = None
                        target = payload2  # type: ignore[assignment]
                        fh = open(target, "a", encoding="utf-8")
                    else:
                        fh.write(payload2)  # type: ignore[arg-type]
                fh.flush()
            except OSError:
                if fh is not None:
                    try:
                        fh.close()
                    except OSError:
                        pass
                fh = None
