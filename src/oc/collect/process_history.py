"""In-memory recent input/output history per process — non-persisted, process-memory only.

The teach UI's process *raw* satellite node shows the last few values a process node transformed:
per event the KEY the value flowed under, the INPUT it received (``raw`` — the incoming value from
a readout/register/other process, before the rules ran), the per-rule ``trace``, and the ``output``
(the value after the rule pipeline). Like the register/readout/trigger/producer history rings
([[register_history]] and siblings) this is deliberately transient — a ring in module memory wiped
on restart. The ring mechanics live in the shared :class:`oc.collect.history_ring.HistoryRing`
primitive; this module only fixes the process key + fire-record shape.

:func:`oc.collect.live.LiveSession._feed_processes` calls :func:`record` once per input key each
tick a process evaluates. :func:`snapshot` is read by the live heartbeat and delivered to the
client, which paints it into an OPEN satellite (empty / no-op when hidden).
"""

from __future__ import annotations

from .history_ring import HistoryRing

_ring = HistoryRing(200)


def record(game: str, process_id: str, *, ts: str, key: str, raw: str, value,
           trace=None) -> None:
    """Append one process fire to its ring (newest first). ``ts`` is an ISO timestamp (the caller
    stamps it). ``key`` is the key the value flowed under, ``raw`` the incoming input value (pre-
    rules), ``value`` the final output (``None`` when a rule dropped it), ``trace`` the per-rule
    in/out steps (same shape as ``run_rule_pipeline(trace=True)``) for the satellite's rule cols."""
    _ring.record((game, process_id), {"ts": ts, "key": key, "raw": raw, "value": value,
                                      "trace": trace or []})


def recent(game: str, process_id: str) -> list[dict]:
    """This process's recent fires, newest first (empty if nothing fired this session)."""
    return _ring.recent((game, process_id))


def snapshot(game: str) -> dict[str, list[dict]]:
    """Every process's recent fires for ``game``, keyed by process id — the shape the live
    heartbeat carries, so an OPEN satellite paints from the beat with no per-node fetch."""
    return _ring.snapshot(game)


def clear(game: str, process_id: str | None = None) -> None:
    """Drop history for one process, or (``process_id=None``) every process of ``game``."""
    _ring.clear(game, process_id)
