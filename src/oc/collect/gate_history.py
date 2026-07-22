"""In-memory recent-flip history per gate — non-persisted, process-memory only.

The teach UI's gate *flip history* satellite node shows the last few times a gate's pass/block
decision changed: WHEN it flipped, the SOURCE it tests, the source's live VALUE at the flip, the
per-condition breakdown (one column per :class:`~oc.profile.models.GateCond`, so the satellite can
show which condition(s) held), the combined ``logic``/``negate``, and the resulting ``holds``. Like
the trigger-/readout-/register-/process-history rings ([[trigger_history]], [[readout_history]],
[[register_history]], [[process_history]]) this is deliberately transient: a ring buffer in module
memory, wiped on restart (a live debugging view, not an audit log). The ring mechanics live in the
shared :class:`oc.collect.history_ring.HistoryRing` primitive; this module only fixes the gate key +
flip-record shape.

:meth:`oc.collect.triggers.TriggerRunner.emit_gate_flow` calls :func:`record` on every tick a gate's
holds/blocks decision FLIPS (a steady value never spams the log, mirroring the flow-blob animation
it already drives). :func:`snapshot` is read by the live heartbeat and delivered to the client, which
paints it into an OPEN satellite (empty / no-op when hidden).
"""

from __future__ import annotations

from .history_ring import HistoryRing

_ring = HistoryRing(200)


def record(game: str, gate_id: str, *, ts: str, source: str, source_value, conds,
           logic: str, negate: bool, holds: bool) -> None:
    """Append one gate flip to its ring (newest first). ``ts`` is an ISO timestamp (the caller
    stamps it). ``source`` is the gate's tested ref, ``source_value`` its live value at the flip,
    ``conds`` a list of ``{"when": ..., "arg": ..., "hold": bool}`` (one per condition), ``logic``/
    ``negate`` the gate's combine settings, ``holds`` the resulting (post-negate) pass/block."""
    _ring.record((game, gate_id), {"ts": ts, "source": source, "source_value": source_value,
                                   "conds": conds, "logic": logic, "negate": negate, "holds": holds})


def recent(game: str, gate_id: str) -> list[dict]:
    """This gate's recent flips, newest first (empty if nothing flipped this session)."""
    return _ring.recent((game, gate_id))


def snapshot(game: str) -> dict[str, list[dict]]:
    """Every gate's recent flips for ``game``, keyed by gate id — the shape the live heartbeat
    carries, so an OPEN satellite paints from the beat with no per-node fetch."""
    return _ring.snapshot(game)


def clear(game: str, gate_id: str | None = None) -> None:
    """Drop history for one gate, or (``gate_id=None``) every gate of ``game``."""
    _ring.clear(game, gate_id)
