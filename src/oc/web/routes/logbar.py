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
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter

from ... import eventlog
from ...logfile import LineLog

router = APIRouter(prefix="/api/logbar", tags=["logbar"])

_LOG_DIR = Path("logs")
_PREFIX = "logbar-"
_BOOT_MARKER = _LOG_DIR / ".logbar_boot"

# prefix-scoped: logs/ is SHARED with nodelog_file.py's nodelog-*.log — an unscoped glob
# would sort/cap both kinds' stems together, and nodelog rotating far more often (still tied
# to a client boot ping, incl. every reload) would evict every logbar file. See LineLog for
# why writes go through a background queue rather than an open/write/close per line.
_log = LineLog(_PREFIX, log_dir=_LOG_DIR)


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
    boot_id = os.environ.get("OCC_BOOT_ID")
    try:
        if boot_id and _BOOT_MARKER.exists() and _BOOT_MARKER.read_text().strip() == boot_id:
            existing = _log.existing_files()
            if existing:
                return {"file": _log.attach(existing[-1])}
        name = _log.rotate()
        if boot_id and name:
            _LOG_DIR.mkdir(parents=True, exist_ok=True)
            _BOOT_MARKER.write_text(boot_id)
        return {"file": name}
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


def _on_event(ev: dict) -> None:
    """Format one server-stamped line and hand it to the background writer — never lets a
    write throw or block the publishing thread. See :class:`~oc.logfile.LineLog`."""
    now = datetime.now()
    level = str(ev.get("level", "info"))
    msg = str(ev.get("msg", ""))
    _log.write(f"{now:%d/%m/%y %H:%M:%S}.{now.microsecond // 1000:03d} [{level}] {msg}\n")


# Subscribed once at import time (this module loads at app startup via app.py) so every
# bus event is written to the current file as it happens.
eventlog.subscribe(_on_event)
