"""Shared in-memory recent-history ring — the ONE primitive every non-persisted *history
satellite* feeder builds on.

A history satellite (register push-history, process input/output history, and the older
readout/trigger/producer rings) shows the last few events of a node: a bounded, newest-first
deque per ``(game, <node id>)`` key, held in module memory and wiped on restart — a live
debugging view, not an audit log (the user asked for no persistence). The record SHAPE differs
per feeder (a register push carries ``ring_index``/``overwritten``; a process fire carries the
input ``raw`` + rule ``trace``); this primitive owns only the ring mechanics, so each feeder is a
thin wrapper that fixes its own key + entry dict (see :mod:`register_history`, :mod:`process_history`).

``register_history`` and ``process_history`` build on this; ``readout_history`` / ``trigger_history``
/ ``producer_history`` are older hand-rolled copies still awaiting migration onto it (rule 7).
"""

from __future__ import annotations

from collections import deque


class HistoryRing:
    """A bounded newest-first ring per ``(game, id)`` key. ``cap`` caps each key's ring."""

    def __init__(self, cap: int = 200) -> None:
        self._cap = cap
        self._h: dict[tuple, deque] = {}

    def record(self, key: tuple, entry: dict) -> None:
        """Prepend one event to ``key``'s ring (newest first), creating the ring on first use."""
        dq = self._h.get(key)
        if dq is None:
            dq = self._h[key] = deque(maxlen=self._cap)
        dq.appendleft(entry)

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
