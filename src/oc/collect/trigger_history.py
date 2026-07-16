"""In-memory recent-fire history per trigger — non-persisted, web-process only.

The teach UI's trigger *history* satellite node shows the last few times a trigger fired: WHEN,
WHY (the condition that justified it), WHAT it fired (target ids), and whether a fire was
suppressed by the trigger's throttle. This is deliberately transient — a ring buffer in module
memory, wiped on restart (the satellite is a live debugging view, not an audit log).

Every fire site in :mod:`oc.collect.triggers` calls :func:`record` alongside ``record_fire``
(which persists only the last-fired timestamp). :func:`recent` is read by the history endpoint
(``/api/triggers/{game}/{id}/history``). Because ``on_change`` fires wherever the write happens,
a separate ``oc collect`` process keeps its own ring the teach UI can't see — acceptable for a
teach-UI-only view (the normal case is one process).
"""

from __future__ import annotations

from collections import deque

_CAP = 50
# (game, trigger_id) -> deque of newest-first fire records
_history: dict[tuple[str, str], deque] = {}


def record(game: str, trigger_id: str, *, why: str, targets: list[str],
           throttled: bool = False, ts: str, node: str = "", value: object = None) -> None:
    """Append one fire (or throttled suppression) to the trigger's ring. ``ts`` is an ISO
    timestamp (the caller stamps it so tests stay deterministic). Newest entries first.

    ``node``/``value`` name the readout node whose reading justified the fire and the actual
    value that crossed (on_readout only; blank for interval/lifecycle/on_change kinds)."""
    key = (game, trigger_id)
    dq = _history.get(key)
    if dq is None:
        dq = _history[key] = deque(maxlen=_CAP)
    dq.appendleft({"ts": ts, "why": why, "targets": list(targets), "throttled": throttled,
                   "node": node, "value": value})


def recent(game: str, trigger_id: str) -> list[dict]:
    """The trigger's recent fires, newest first (empty if it hasn't fired this session)."""
    return list(_history.get((game, trigger_id), ()))


def clear(game: str, trigger_id: str | None = None) -> None:
    """Drop history for one trigger, or (``trigger_id=None``) every trigger of ``game``."""
    if trigger_id is not None:
        _history.pop((game, trigger_id), None)
        return
    for key in [k for k in _history if k[0] == game]:
        _history.pop(key, None)
