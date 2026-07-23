"""In-memory recent-fire history per trigger — non-persisted, web-process only.

The teach UI's trigger *history* satellite node shows the last few times a trigger fired: WHEN,
WHY (the condition that justified it), WHAT it fired (target ids), and whether a fire was
suppressed by the trigger's throttle. Like the register-/process-/gate-/router-/sound-/action-
history rings ([[register_history]] and siblings) this is deliberately transient — a ring buffer in
module memory, wiped on restart (the satellite is a live debugging view, not an audit log). The ring
mechanics live in the shared :class:`oc.collect.history_ring.HistoryRing` primitive; this module only
fixes the trigger key + fire-record shape.

Every fire site in :mod:`oc.collect.triggers` calls :func:`record` alongside ``record_fire`` (which
persists only the last-fired timestamp). :func:`snapshot` is read by the live heartbeat
(``activity.build_activity``) and delivered to the client, which paints it into an OPEN satellite
(empty / no-op when hidden). Because ``on_change`` fires wherever the write happens, a separate
``oc collect`` process keeps its own ring the teach UI can't see — acceptable for a teach-UI-only
view (the normal case is one process).
"""

from __future__ import annotations

from .history_ring import HistoryRing

_ring = HistoryRing(200, kind="trigger")


def record(game: str, trigger_id: str, *, why: str, targets: list[str],
           throttled: bool = False, ts: str, node: str = "", value: object = None) -> None:
    """Append one fire (or throttled suppression) to the trigger's ring (newest first). ``ts`` is
    an ISO timestamp (the caller stamps it so tests stay deterministic). ``node``/``value`` name the
    readout node whose reading justified the fire and the actual value that crossed (on_readout
    only; blank for interval/lifecycle/on_change kinds)."""
    _ring.record((game, trigger_id), {"ts": ts, "why": why, "targets": list(targets),
                                      "throttled": throttled, "node": node, "value": value})


def recent(game: str, trigger_id: str) -> list[dict]:
    """The trigger's recent fires, newest first (empty if it hasn't fired this session)."""
    return _ring.recent((game, trigger_id))


def snapshot(game: str) -> dict[str, list[dict]]:
    """Every trigger's recent fires for ``game``, keyed by trigger id — the shape the live heartbeat
    carries, so an OPEN satellite paints from the beat with no per-node fetch."""
    return _ring.snapshot(game)


def clear(game: str, trigger_id: str | None = None) -> None:
    """Drop history for one trigger, or (``trigger_id=None``) every trigger of ``game``."""
    _ring.clear(game, trigger_id)
