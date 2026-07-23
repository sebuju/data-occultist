"""In-memory recent-route history per router — non-persisted, process-memory only.

The teach UI's router *route history* satellite node shows the last few times a router's SELECTED
branch changed: WHEN it changed, the SOURCE it tests, the source's live VALUE at the change, the
per-branch match breakdown (one column per :class:`~oc.profile.models.RouterBranch`, first match
wins), the ``selected`` branch index (``None`` when no branch matched), and the ``targets`` that
branch forwards. Like the trigger-/readout-/register-/process-/gate-history rings this is
deliberately transient: a ring buffer in module memory, wiped on restart. The ring mechanics live in
the shared :class:`oc.collect.history_ring.HistoryRing` primitive; this module only fixes the router
key + route-record shape.

Unlike a gate (a live pass/block level, animated every tick), a router only routes AT FIRE TIME in
the rest of the engine (:meth:`oc.collect.triggers.TriggerRunner._resolve_fire`). For the satellite
log, :meth:`oc.collect.triggers.TriggerRunner.emit_router_flow` ALSO evaluates every router each live
tick (mirroring :meth:`emit_gate_flow`) purely to detect a SELECTED-BRANCH change and record it here
— routing for an actual fire still goes through ``_resolve_fire`` independently. :func:`snapshot` is
read by the live heartbeat and delivered to the client, which paints it into an OPEN satellite
(empty / no-op when hidden).
"""

from __future__ import annotations

from .history_ring import HistoryRing

_ring = HistoryRing(200, kind="router")


def record(game: str, router_id: str, *, ts: str, source: str, source_value, branches,
           selected, targets) -> None:
    """Append one router route-change to its ring (newest first). ``ts`` is an ISO timestamp (the
    caller stamps it). ``source`` is the router's tested ref, ``source_value`` its live value at the
    change, ``branches`` a list of ``{"i": int, "matched": bool}`` (one per branch, in order),
    ``selected`` the chosen branch index (``None`` if none matched), ``targets`` the forwarded
    target ids of the selected branch (``[]`` if none)."""
    _ring.record((game, router_id), {"ts": ts, "source": source, "source_value": source_value,
                                     "branches": branches, "selected": selected,
                                     "targets": list(targets or [])})


def recent(game: str, router_id: str) -> list[dict]:
    """This router's recent route-changes, newest first (empty if nothing changed this session)."""
    return _ring.recent((game, router_id))


def snapshot(game: str) -> dict[str, list[dict]]:
    """Every router's recent route-changes for ``game``, keyed by router id — the shape the live
    heartbeat carries, so an OPEN satellite paints from the beat with no per-node fetch."""
    return _ring.snapshot(game)


def clear(game: str, router_id: str | None = None) -> None:
    """Drop history for one router, or (``router_id=None``) every router of ``game``."""
    _ring.clear(game, router_id)
