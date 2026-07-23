"""Persist the front-end log bar (`log.js`) to a rotating file per server start.

The log bar is the app's glanceable event strip — trigger fires, price sweeps,
profile-check warnings, GPU/OCR notes. It only ever lived in memory (the DOM ring +
`oc.eventlog`'s own ring), so a problem that scrolled past — or happened right before a
reload — was gone. This gives it a file: one fresh ``logs/logbar-<stamp>.log`` per real
server start, keep-last-10.

The file itself is written ENTIRELY SERVER-SIDE by subscribing to :mod:`oc.eventlog` (the
same bus that feeds the browser over SSE) — nothing outside this module ever opens or
appends to it. Client-only diagnostics (boot progress, mirrored `console.error/warn`) have
no server-side origin, so they reach the bus the only way they can: `POST /api/logbar/emit`
publishes them (`file_only=True`, see `routes/events.py`) and the subscriber below writes
them exactly like any other event — a bus PUBLISH from the browser, never a file write.
`file_only` keeps them out of the SSE fan-out/backfill so the browser that emitted one
doesn't get it echoed back and double-shown.

Rotation reuses the shared snapshot-store primitives (:mod:`oc.backup`) rather than
hand-rolling another prune loop — same reasoning as the profile/DB backups. ``start_session``
is called once from the app's lifespan (``app.py``), NOT per HTTP request — unlike
``oc.collect.nodelog_file``, which deliberately rotates on a client boot ping instead of
server start (nodelog has no dedup, so a client-driven rotation is what avoids a
``--reload`` dev restart spamming ``logs/``). Rotating on server start would hit the exact
same spam here, since ``--reload`` restarts the worker process on every code save — dodged
via ``OCC_BOOT_ID``: ``cli/serve.py`` stamps one random id into the environment before
handing off to uvicorn, and a ``--reload`` worker respawn inherits that SAME env (only a
genuinely new ``serve`` invocation gets a new id), so ``start_session`` can tell "a real new
launch" from "the reload worker restarted again" and reuse the existing file for the latter."""

from __future__ import annotations

import os
import threading
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter

from ... import backup, eventlog

router = APIRouter(prefix="/api/logbar", tags=["logbar"])

_LOG_DIR = Path("logs")
_EXT = "log"
_PREFIX = "logbar-"
_KEEP = 10
_BOOT_MARKER = _LOG_DIR / ".logbar_boot"

_lock = threading.Lock()
_current: Path | None = None


def _new_path(now: datetime) -> Path:
    """A fresh ``logbar-<stamp>.log`` path, bumping a suffix on a same-second collision."""
    _LOG_DIR.mkdir(parents=True, exist_ok=True)
    stamp = now.strftime("%Y%m%d-%H%M%S")
    path = _LOG_DIR / f"{_PREFIX}{stamp}.{_EXT}"
    n = 1
    while path.exists():
        path = _LOG_DIR / f"{_PREFIX}{stamp}-{n}.{_EXT}"
        n += 1
    return path


def _prune() -> None:
    # prefix-scoped: logs/ is SHARED with nodelog_file.py's nodelog-*.log — an unscoped
    # glob would sort/cap both kinds' stems together, and nodelog rotating far more often
    # (still tied to a client boot ping, incl. every reload) would evict every logbar file.
    stamps = [p.stem for p in backup.list_snapshots(_LOG_DIR, _EXT, prefix=_PREFIX)]
    keep = backup.keep_last_n(stamps, _KEEP)
    backup.prune(_LOG_DIR, _EXT, keep, prefix=_PREFIX)


def start_session() -> dict:
    """Called once from the app lifespan on every process start. Rotates to a fresh file —
    UNLESS ``OCC_BOOT_ID`` matches the marker left by a previous call in this same launch,
    which means this is a ``--reload`` worker respawn, not a real new server start; then the
    existing file is reused instead. No ``OCC_BOOT_ID`` (desktop mode, ``--no-reload``, an ad
    hoc ``uvicorn`` launch) always rotates — there is only ever one process either way.

    No-ops under pytest (``PYTEST_CURRENT_TEST``, set by pytest itself): a route test's
    ``TestClient(app)`` runs this SAME lifespan, and without the guard every test run would
    rotate a real file into the user's ``logs/`` and fill it with test-fixture noise."""
    if os.environ.get("PYTEST_CURRENT_TEST"):
        return {"file": None}
    global _current
    boot_id = os.environ.get("OCC_BOOT_ID")
    try:
        with _lock:
            if boot_id and _BOOT_MARKER.exists() and _BOOT_MARKER.read_text().strip() == boot_id:
                existing = sorted(_LOG_DIR.glob(f"{_PREFIX}*.{_EXT}"))
                if existing:
                    _current = existing[-1]
                    return {"file": _current.name}
            _current = _new_path(datetime.now())
            _current.touch()
            _prune()
            if boot_id:
                _LOG_DIR.mkdir(parents=True, exist_ok=True)
                _BOOT_MARKER.write_text(boot_id)
        return {"file": _current.name}
    except OSError:
        return {"file": None}


@router.post("/emit")
def emit(body: dict) -> dict:
    """Publish a batch of ``{msg, level}`` entries onto the :mod:`oc.eventlog` bus as
    ``file_only`` events — for client-only diagnostics (boot progress, mirrored
    ``console.error/warn``) that have no server-side origin. This is a BUS PUBLISH, not a
    file write: ``_on_event`` below is what actually persists it, same as any other event."""
    entries = body.get("entries") or []
    for e in entries:
        level = str(e.get("level", "info"))
        msg = str(e.get("msg", ""))
        if msg:
            eventlog.publish(msg, level, file_only=True)
    return {"ok": True}


def _write_line(level: str, msg: str) -> None:
    """Append one server-stamped line to the current file, lazily opening one if
    ``start_session`` hasn't run yet. Never lets a write throw — logging must not be able
    to break whatever published the event. No-ops under pytest — see ``start_session``."""
    if os.environ.get("PYTEST_CURRENT_TEST"):
        return
    try:
        with _lock:
            global _current
            if _current is None:
                _current = _new_path(datetime.now())
            with open(_current, "a", encoding="utf-8") as f:
                now = datetime.now()
                f.write(f"{now:%d/%m/%y %H:%M:%S}.{now.microsecond // 1000:03d} [{level}] {msg}\n")
    except OSError:
        pass


def _on_event(ev: dict) -> None:
    _write_line(str(ev.get("level", "info")), str(ev.get("msg", "")))


# Subscribed once at import time (this module loads at app startup via app.py) so every
# bus event is written to the current file as it happens.
eventlog.subscribe(_on_event)
