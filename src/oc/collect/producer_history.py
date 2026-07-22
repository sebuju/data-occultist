"""In-memory recent-fetch history per producer — non-persisted, web-process only.

The teach UI's producer *history* satellite node shows the last few sweeps a producer ran: WHEN
it finished, which DATASET it wrote, how many items it FETCHED / FAILED, the run TOTAL, and how
many rows landed. Like the trigger-/register-/process-history rings ([[trigger_history]] and
siblings) this is deliberately transient — a ring buffer in module memory, wiped on restart (a live
debugging view, not an audit log). The ring mechanics live in the shared
:class:`oc.collect.history_ring.HistoryRing` primitive; this module only fixes the producer key +
sweep-record shape.

One row per COMPLETED sweep. A sweep runs in a child ``_sweep-job`` subprocess, so the only place
the parent (web) process learns the outcome is :func:`oc.enrich.price_runner._reap`; that is the
sole ``record`` call site. A separate ``oc collect``/CLI process keeps its own ring the teach UI
can't see — acceptable for a teach-UI-only view (the normal case is one process).
"""

from __future__ import annotations

from .history_ring import HistoryRing

_ring = HistoryRing(200)


def record(game: str, producer_id: str, *, ts: str, dataset: str, total: int,
           fetched: int, failed: int, rows: int, mode: str = "") -> None:
    """Append one completed sweep to the producer's ring (newest first). ``ts`` is an ISO
    timestamp (the caller stamps it — the sweep's finish time — so tests stay deterministic).
    ``rows`` is how many records the sweep wrote (the length of the summary's ``names`` list)."""
    _ring.record((game, producer_id), {"ts": ts, "dataset": dataset, "total": total,
                                       "fetched": fetched, "failed": failed, "rows": rows,
                                       "mode": mode})


def recent(game: str, producer_id: str) -> list[dict]:
    """The producer's recent sweeps, newest first (empty if it hasn't swept this session)."""
    return _ring.recent((game, producer_id))


def snapshot(game: str) -> dict[str, list[dict]]:
    """Every producer's recent sweeps for ``game``, keyed by producer id — the shape the live
    heartbeat carries (``activity.build_activity`` -> ``producer_history``), so an OPEN satellite
    paints from the beat with no per-node fetch."""
    return _ring.snapshot(game)


def clear(game: str, producer_id: str | None = None) -> None:
    """Drop history for one producer, or (``producer_id=None``) every producer of ``game``."""
    _ring.clear(game, producer_id)
