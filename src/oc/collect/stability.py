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

from .reader import Record


def _signature(rec: Record) -> str:
    return json.dumps(rec.values, sort_keys=True, ensure_ascii=False, default=str)


class Confirmer:
    def __init__(self, key_field: str, confirm_frames: int = 2) -> None:
        self._key_field = key_field
        self._need = max(1, confirm_frames)
        # key -> {"sig": str, "count": int, "rec": Record}
        self._pending: dict[str, dict] = {}
        self._confirmed_keys: set[str] = set()

    def _key(self, rec: Record) -> str | None:
        val = rec.values.get(self._key_field)
        if val in (None, ""):
            return None
        return str(val).strip().lower()

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
