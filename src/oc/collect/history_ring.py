"""Shared in-memory recent-history ring — the ONE primitive every non-persisted *history
satellite* feeder builds on.

A history satellite (register push-history, process input/output history, gate/router/sound/action
history, and the readout/trigger/producer rings) shows the last few events of a node: a bounded,
newest-first deque per ``(game, <node id>)`` key, held in module memory and wiped on restart — a
live debugging view, not an audit log (the user asked for no persistence). The record SHAPE differs
per feeder (a register push carries ``ring_index``/``overwritten``; a process fire carries the
input ``raw`` + rule ``trace``); this primitive owns only the ring mechanics, so each feeder is a
thin wrapper that fixes its own key + entry dict (see :mod:`register_history`, :mod:`process_history`).

Every history feeder builds on this now (rule 7) — register/process/gate/router/sound/action/
readout/trigger/producer. A feeder whose identity is more than one string (readout: window + id)
composite-keys it into one id string (see :mod:`readout_history`) rather than growing this
primitive's key shape.
"""

from __future__ import annotations

from collections import deque

from . import nodelog_file


class HistoryRing:
    """A bounded newest-first ring per ``(game, id)`` key. ``cap`` caps each key's ring.

    ``kind`` (e.g. ``"gate"``, ``"trigger"``) tags every record written through this ring
    to the write-only node-log file (:mod:`oc.collect.nodelog_file`) — pass it so this
    ring's entries land there; omit for a ring that shouldn't be file-logged."""

    def __init__(self, cap: int = 200, kind: str | None = None) -> None:
        self._cap = cap
        self._kind = kind
        self._h: dict[tuple, deque] = {}

    def record(self, key: tuple, entry: dict) -> None:
        """Prepend one event to ``key``'s ring (newest first), creating the ring on first use."""
        dq = self._h.get(key)
        if dq is None:
            dq = self._h[key] = deque(maxlen=self._cap)
        dq.appendleft(entry)
        if self._kind:
            nodelog_file.write(self._kind, key[0], key[1], entry)

    def recent(self, key: tuple) -> list[dict]:
        """This key's recent events, newest first (empty if nothing recorded)."""
        return list(self._h.get(key, ()))

    def snapshot(self, game: str) -> dict[str, list[dict]]:
        """Every id's recent events for ``game`` -> ``{id: entries}`` — the shape the live
        heartbeat carries so an OPEN satellite paints from the beat with no per-node fetch.
        Assumes keys are ``(game, id)`` two-tuples."""
        return {k[1]: list(dq) for k, dq in self._h.items() if k[0] == game}

    def clear(self, game: str, ident: str | None = None) -> None:
        """Drop history for one id, or (``ident=None``) every id of ``game``."""
        if ident is not None:
            self._h.pop((game, ident), None)
            return
        for k in [k for k in self._h if k[0] == game]:
            self._h.pop(k, None)
