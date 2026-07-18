"""In-memory recent-push history per register — non-persisted, process-memory only.

The teach UI's register *push history* satellite node shows the last few writes into a register's
held map: WHEN a value was pushed, the KEY (readout id) it landed under, the VALUE written, the
ring INDEX it occupies, and what value it wrote OVER (the sample the append pushed out of the ring
— for the common ``capacity == 1`` register this is simply the previously-held value). Like the
trigger-, readout-, and producer-history rings ([[trigger_history]], [[readout_history]],
[[producer_history]]) and the process-history ring ([[process_history]]), this is deliberately
transient: a ring buffer in module memory, wiped on restart (a live debugging view, not an audit
log — the user asked for no persistence). The ring mechanics live in the shared
:class:`oc.collect.history_ring.HistoryRing` primitive; this module only fixes the register key +
push-record shape.

:func:`oc.collect.live.LiveSession._feed_registers` calls :func:`record` whenever a NEW value is
actually written to a keyslot (an unchanged value that only bumps conf/last_seen is not a push).
:func:`snapshot` is read by the live heartbeat (``live.status()``) and delivered to the client,
which paints it into an OPEN satellite (empty / no-op when hidden).
"""

from __future__ import annotations

from .history_ring import HistoryRing

_ring = HistoryRing(200)


def record(game: str, register_id: str, *, ts: str, key: str, value,
           ring_index: int, overwritten=None) -> None:
    """Append one register push to its ring (newest first). ``ts`` is an ISO timestamp (the caller
    stamps it). ``key`` is the readout id the value was held under, ``value`` the value written,
    ``ring_index`` the slot it occupies in that key's ring after the write, ``overwritten`` the
    value the append evicted from the ring (``None`` when the ring wasn't full)."""
    _ring.record((game, register_id), {"ts": ts, "key": key, "value": value,
                                       "ring_index": ring_index, "overwritten": overwritten})


def recent(game: str, register_id: str) -> list[dict]:
    """This register's recent pushes, newest first (empty if nothing pushed this session)."""
    return _ring.recent((game, register_id))


def snapshot(game: str) -> dict[str, list[dict]]:
    """Every register's recent pushes for ``game``, keyed by register id — the shape the live
    heartbeat carries, so an OPEN satellite paints from the beat with no per-node fetch."""
    return _ring.snapshot(game)


def clear(game: str, register_id: str | None = None) -> None:
    """Drop history for one register, or (``register_id=None``) every register of ``game``."""
    _ring.clear(game, register_id)
