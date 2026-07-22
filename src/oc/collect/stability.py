"""Temporal confirmation: only accept a record once it reads stable across frames.

This is the core occlusion/flicker defence. A floating window, tooltip, or fade
animation produces records that appear for a frame or two then change or vanish.
By requiring ``confirm_frames`` consecutive *identical* observations (keyed by a
stable field such as item name), such transients never reach the sink, while
genuine on-screen data — which holds still — is confirmed quickly.

Keying on the item name (not screen position) means a row that drifts as the user
scrolls still accumulates confirmations, as long as its values stay consistent.
"""

from __future__ import annotations

import json
from collections.abc import Callable

from .reader import Record


def _signature(rec: Record) -> str:
    return json.dumps(rec.values, sort_keys=True, ensure_ascii=False, default=str)


class Confirmer:
    def __init__(self, key_fn: Callable[[dict], str | None], confirm_frames: int = 2) -> None:
        # ``key_fn`` maps a record's values to its dedup key (the dataset's resolved
        # KeyMap.build) — the SAME key the store uses, so confirm and store agree.
        self._key_fn = key_fn
        self._need = max(1, confirm_frames)
        # key -> {"sig": str, "count": int, "rec": Record}
        self._pending: dict[str, dict] = {}
        self._confirmed_keys: set[str] = set()

    def _key(self, rec: Record) -> str | None:
        return self._key_fn(rec.values)

    def observe(self, records: list[Record]) -> list[Record]:
        """Feed one frame's records; return those that just became confirmed."""
        confirmed: list[Record] = []
        for rec in records:
            key = self._key(rec)
            if key is None or key in self._confirmed_keys:
                continue
            sig = _signature(rec)
            entry = self._pending.get(key)
            if entry and entry["sig"] == sig:
                entry["count"] += 1
            else:
                # New or changed (unstable) reading -> restart the count.
                entry = {"sig": sig, "count": 1, "rec": rec}
                self._pending[key] = entry

            if entry["count"] >= self._need:
                self._confirmed_keys.add(key)
                self._pending.pop(key, None)
                confirmed.append(rec)
        return confirmed

    @property
    def count(self) -> int:
        """Total distinct records confirmed so far (acts as the saved-row count)."""
        return len(self._confirmed_keys)


class PruneGate:
    """Temporal confirmation for a ``RuleThen.prune`` signal — the counterpart to
    :class:`Confirmer` for ACTIVE removal instead of addition.

    ``Confirmer`` is one-shot: once a key confirms, it's remembered forever and never
    re-fires. A prune signal must do the opposite — RE-ARM after firing — because the same
    key can be owned, depleted (pruned), re-owned, and depleted again (e.g. a relic bought
    then used up more than once); each depletion must prune again. ``confirm_frames``
    consecutive ticks of the same key signalling prune fires it once and resets its counter;
    a key that stops signalling (still present, or gone from view) has its counter cleared,
    so it starts clean the next time it appears."""

    def __init__(self, confirm_frames: int) -> None:
        self._need = max(1, int(confirm_frames))
        self._counts: dict[str, int] = {}

    def observe(self, keys: set[str]) -> set[str]:
        """Feed this tick's pruning-candidate keys; return those that just reached
        ``confirm_frames`` consecutive ticks (and are now reset, ready to re-arm)."""
        for k in list(self._counts):
            if k not in keys:
                del self._counts[k]           # signal stopped -> re-arm from 0
        fired: set[str] = set()
        for k in keys:
            n = self._counts.get(k, 0) + 1
            if n >= self._need:
                fired.add(k)
                self._counts.pop(k, None)
            else:
                self._counts[k] = n
        return fired
