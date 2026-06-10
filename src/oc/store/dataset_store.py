"""Per-dataset stateful store: current snapshot + append-only change history.

Files (under ``data/<game>/``):
  * ``<dataset>.state.json``    — current keyed records with first/last-seen stamps
  * ``<dataset>.history.jsonl`` — one ChangeEvent per line (add/update/remove)

Generic by construction: the key field and the record shape come from the profile,
never from code. ``record_seen`` logs adds/updates live; ``reconcile`` logs removals
only when handed the keys from a *complete* pass (caller's responsibility), so a
partial/occluded view is never mistaken for a deletion.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path

from .change import ChangeEvent, ChangeOp


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _norm_key(value) -> str | None:
    if value in (None, ""):
        return None
    return str(value).strip().lower()


class DatasetStore:
    def __init__(
        self,
        data_dir: Path | str,
        game: str,
        dataset: str,
        key_field: str,
        clock: Callable[[], str] = _utcnow_iso,
    ) -> None:
        base = Path(data_dir) / game
        self._state_path = base / f"{dataset}.state.json"
        self._history_path = base / f"{dataset}.history.jsonl"
        self._key_field = key_field
        self._clock = clock
        self._state: dict[str, dict] = {}
        self._load()

    # ---- persistence -------------------------------------------------------

    def _load(self) -> None:
        if self._state_path.exists():
            self._state = json.loads(self._state_path.read_text(encoding="utf-8"))

    def save(self) -> None:
        self._state_path.parent.mkdir(parents=True, exist_ok=True)
        self._state_path.write_text(
            json.dumps(self._state, ensure_ascii=False, indent=0, sort_keys=True),
            encoding="utf-8",
        )

    def _append(self, event: ChangeEvent) -> None:
        self._history_path.parent.mkdir(parents=True, exist_ok=True)
        with self._history_path.open("a", encoding="utf-8") as fh:
            fh.write(event.to_json() + "\n")

    # ---- mutation ----------------------------------------------------------

    def record_seen(self, values: dict) -> ChangeEvent | None:
        """Register a confirmed record. Logs an add or a field update; returns the
        event, or ``None`` if nothing changed (record already known and identical)."""
        key = _norm_key(values.get(self._key_field))
        if key is None:
            return None
        ts = self._clock()
        entry = self._state.get(key)

        if entry is None:
            self._state[key] = {
                "values": dict(values),
                "first_seen": ts,
                "last_seen": ts,
                "present": True,
            }
            event = ChangeEvent(ts, ChangeOp.add, key, dict(values))
            self._append(event)
            return event

        # Known key: detect field-level changes (e.g. a mod's rank went up).
        changed = {}
        merged = dict(entry["values"])
        for fld, new in values.items():
            old = entry["values"].get(fld)
            if old != new:
                changed[fld] = [old, new]
                merged[fld] = new
        entry["values"] = merged
        entry["last_seen"] = ts
        was_absent = not entry.get("present", True)
        entry["present"] = True

        if changed or was_absent:
            op = ChangeOp.add if was_absent else ChangeOp.update
            event = ChangeEvent(ts, op, key, merged, changed)
            self._append(event)
            return event
        return None

    def reconcile(self, present_keys: set[str]) -> list[ChangeEvent]:
        """Mark stored keys that are absent from a *complete* pass as removed.

        ``present_keys`` must already be normalised (lowercased/stripped). Only call
        this when confident the pass saw the whole dataset; otherwise occlusion or a
        half-scroll would log false removals.
        """
        ts = self._clock()
        events: list[ChangeEvent] = []
        for key, entry in self._state.items():
            if entry.get("present", True) and key not in present_keys:
                entry["present"] = False
                entry["removed_at"] = ts
                event = ChangeEvent(ts, ChangeOp.remove, key, dict(entry["values"]))
                self._append(event)
                events.append(event)
        return events

    # ---- queries -----------------------------------------------------------

    @property
    def present_count(self) -> int:
        return sum(1 for e in self._state.values() if e.get("present", True))

    def normalize_key(self, value) -> str | None:
        return _norm_key(value)
