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
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter

from ..logfile import LineLog

router = APIRouter(prefix="/api/nodelog", tags=["nodelog"])

_LOG_DIR = Path("logs")
_PREFIX = "nodelog-"

# prefix-scoped: logs/ is SHARED with routes/logbar.py's logbar-*.log under the same
# extension — an unscoped glob would sort/cap both kinds' stems together (a keep-last-10
# across the mix, not per kind). See oc.logfile.LineLog for the background-writer rationale.
_log = LineLog(_PREFIX, log_dir=_LOG_DIR)


@router.post("/session")
def start_session() -> dict:
    """Fresh front-end boot: rotate to a new file and prune to the last 10.

    No-ops under pytest (``PYTEST_CURRENT_TEST``): a route test can hit this route or
    trigger a ``HistoryRing`` write, and without the guard that would rotate/populate a
    real file in the user's ``logs/`` with test-fixture noise."""
    if os.environ.get("PYTEST_CURRENT_TEST"):
        return {"file": None}
    return {"file": _log.rotate()}


def _fmt_entry(entry: dict) -> str:
    return " ".join(f"{k}={v}" for k, v in entry.items() if k not in ("ts", "t"))


def write(kind: str, game: str, node_id: str, entry: dict) -> None:
    """Hand one history-ring record to the background writer. Lazily opens a file if
    ``start_session`` was missed (e.g. a ring recorded before app startup ran). Never
    blocks, never raises. No-ops under pytest — see ``start_session``."""
    if os.environ.get("PYTEST_CURRENT_TEST"):
        return
    now = datetime.now()
    line = (f"{now:%d/%m/%y %H:%M:%S}.{now.microsecond // 1000:03d} "
            f"[{kind}] {game}:{node_id} {_fmt_entry(entry)}\n")
    _log.write(line)
