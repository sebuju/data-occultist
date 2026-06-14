"""Aggregate view of live background work, for the Activity floating window.

One poll instead of N: the front-end heartbeat hub hits ``GET /api/activity/{game}``
and gets every running price sweep, the precapture worker's status (only while it's
actually busy), the enabled triggers, AND the OCR device state — the single request
that feeds the tasks panel, the precapture indicator, and the kill-GPU button. Each
subsystem stays the source of truth for its own cancel endpoint; this is read-only.
"""

from __future__ import annotations

from fastapi import APIRouter

from ...enrich.price_runner import active_sweeps
from ..deps import get_settings
from ..trigger_sched import schedule as trigger_schedule
from .ocr import ocr_state
from .precapture import _sessions

router = APIRouter(prefix="/api/activity", tags=["activity"])

# precapture phases that mean a worker is actually running (so it's worth showing)
_BUSY = {"recording", "processing", "paused"}


@router.get("/{game}")
def activity(game: str) -> dict:
    """Live jobs for ``game``: running sweeps, the precapture worker (when busy), and the
    enabled triggers with their next-fire countdown."""
    precap = None
    s = _sessions.get(game)
    if s is not None:
        st = s.status()
        if st.get("phase") in _BUSY:
            precap = st
    return {"sweeps": active_sweeps(game), "precapture": precap,
            "triggers": trigger_schedule(game, get_settings()), "ocr": ocr_state()}
