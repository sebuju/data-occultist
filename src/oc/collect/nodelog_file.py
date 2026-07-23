"""Write-only mirror of every :class:`~oc.collect.history_ring.HistoryRing` record to a
rotating file — the same "persist what the panel already shows" treatment given the
front-end log bar (see :mod:`oc.web.routes.logbar`). This is deliberately WRITE-ONLY: the
app never reads it back (no route, no boot replay) — it exists purely so a session's node
history (gate flips, trigger fires, register pushes, ...) survives past the 200-entry ring
and the process restart that wipes it, for the user to open by hand if something needs
digging into after the fact.

One file per FRONT-END boot, same as the log bar — ``start_session`` is called from the
``/api/nodelog/session`` route (hit by the client on boot, see ``log.js``), NOT from server
startup. It used to rotate on server boot, but a ``--reload`` dev-server restart (which
happens on every source save) fired that just as often, spamming ``logs/`` with near-empty
files. A dev reload doesn't reopen the page, so tying rotation to the front end instead
means one file per real session. Keep-last-10, same as every other rotating store here."""

from __future__ import annotations

import os
import threading
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter

from .. import backup

router = APIRouter(prefix="/api/nodelog", tags=["nodelog"])

_LOG_DIR = Path("logs")
_EXT = "log"
_PREFIX = "nodelog-"
_KEEP = 10

_lock = threading.Lock()
_current: Path | None = None


def _new_path(now: datetime) -> Path:
    _LOG_DIR.mkdir(parents=True, exist_ok=True)
    stamp = now.strftime("%Y%m%d-%H%M%S")
    path = _LOG_DIR / f"{_PREFIX}{stamp}.{_EXT}"
    n = 1
    while path.exists():
        path = _LOG_DIR / f"{_PREFIX}{stamp}-{n}.{_EXT}"
        n += 1
    return path


@router.post("/session")
def start_session() -> dict:
    """Fresh front-end boot: open a new file and prune to the last 10.

    ``prefix=_PREFIX`` scopes the prune to this module's own ``nodelog-*.log`` files —
    ``logs/`` is SHARED with ``routes/logbar.py``'s ``logbar-*.log`` under the same
    extension, and an unscoped glob would sort/cap both kinds' stems together (a
    keep-last-10 across the mix, not per kind).

    No-ops under pytest (``PYTEST_CURRENT_TEST``): a route test can hit this route or
    trigger a ``HistoryRing`` write, and without the guard that would rotate/populate a
    real file in the user's ``logs/`` with test-fixture noise."""
    if os.environ.get("PYTEST_CURRENT_TEST"):
        return {"file": None}
    global _current
    try:
        with _lock:
            _current = _new_path(datetime.now())
            _current.touch()
            stamps = [p.stem for p in backup.list_snapshots(_LOG_DIR, _EXT, prefix=_PREFIX)]
            backup.prune(_LOG_DIR, _EXT, backup.keep_last_n(stamps, _KEEP), prefix=_PREFIX)
        return {"file": _current.name}
    except OSError:
        return {"file": None}


def _fmt_entry(entry: dict) -> str:
    return " ".join(f"{k}={v}" for k, v in entry.items() if k not in ("ts", "t"))


def write(kind: str, game: str, node_id: str, entry: dict) -> None:
    """Append one history-ring record. Lazily opens a file if ``start_session`` was missed
    (e.g. a ring recorded before app startup ran). Never raises. No-ops under pytest — see
    ``start_session``."""
    if os.environ.get("PYTEST_CURRENT_TEST"):
        return
    global _current
    try:
        with _lock:
            if _current is None:
                _current = _new_path(datetime.now())
            now = datetime.now()
            line = (f"{now:%d/%m/%y %H:%M:%S}.{now.microsecond // 1000:03d} "
                    f"[{kind}] {game}:{node_id} {_fmt_entry(entry)}\n")
            with open(_current, "a", encoding="utf-8") as f:
                f.write(line)
    except OSError:
        pass
