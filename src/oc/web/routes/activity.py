"""Aggregate view of live background work, for the Activity floating window.

One poll instead of N: the front-end heartbeat hub hits ``GET /api/activity/{game}``
and gets every running price sweep, the precapture worker's status (only while it's
actually busy), the enabled triggers, AND the OCR device state — the single request
that feeds the tasks panel, the precapture indicator, and the kill-GPU button. Each
subsystem stays the source of truth for its own cancel endpoint; this is read-only.
"""

from __future__ import annotations

from fastapi import APIRouter

from ...collect.process_history import snapshot as process_history_snapshot
from ...collect.producer_history import snapshot as producer_history_snapshot
from ...collect.readout_history import snapshot as readout_history_snapshot
from ...collect.register_history import snapshot as register_history_snapshot
from ...enrich.price_runner import active_sweeps, recent_blocked
from ..deps import get_settings
from ..source_sched import sources as source_status
from ..trigger_sched import schedule as trigger_schedule
from .live import _sessions as _live_sessions
from .ocr import ocr_state
from .precapture import _sessions

router = APIRouter(prefix="/api/activity", tags=["activity"])

# precapture phases that mean a worker is actually running (so it's worth showing)
_BUSY = {"recording", "processing", "paused"}


def build_activity(game: str, settings) -> dict:
    """The activity snapshot for ``game``: running sweeps, the precapture worker (when busy),
    the live collector (when running), enabled triggers with next-fire countdown, sources, and
    OCR device state. Shared by the ``GET /api/activity`` poll (``hub.kick`` / reload adoption)
    and the pushed ``activity`` SSE channel (:mod:`oc.web.routes.events`)."""
    precap = None
    s = _sessions.get(game)
    if s is not None:
        st = s.status()
        if st.get("phase") in _BUSY:
            precap = st
    live = None
    gated: list[str] = []
    ls = _live_sessions.get(game)
    if ls is not None:
        lst = ls.status()
        if lst.get("running"):
            live = lst
            # triggers whose gates BLOCK them right now -> the UI flags these nodes 'gated off'
            # (a live-only cue; empty when idle). See LiveSession.gated_trigger_ids.
            gated = ls.gated_trigger_ids()
    return {"sweeps": active_sweeps(game, settings.data_dir), "blocked": recent_blocked(game),
            "precapture": precap, "live": live, "gated": gated,
            "triggers": trigger_schedule(game, settings),
            "producer_history": producer_history_snapshot(game),
            # Readout + register history ride the beat TOP-LEVEL (like producer_history), NOT under
            # `live` — so their satellites update from the teach-UI test feed too, not only while the
            # live collector is running (both feed the same module rings).
            "readout_history": readout_history_snapshot(game),
            "register_history": register_history_snapshot(game),
            "process_history": process_history_snapshot(game),
            "sources": source_status(game, settings), "ocr": ocr_state()}


@router.get("/{game}")
def activity(game: str) -> dict:
    """Live jobs for ``game``: running sweeps, the precapture worker (when busy), and the
    enabled triggers with their next-fire countdown."""
    return build_activity(game, get_settings())
