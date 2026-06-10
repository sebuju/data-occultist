"""Per-dataset store backed by a revertable ledger.

Files (under ``data/<game>/``):
  * ``<dataset>.history.jsonl`` — append-only ChangeEvent ledger (the source of truth)
  * ``<dataset>.reverted.json`` — set of event ids the user has reverted
  * ``<dataset>.state.json``    — derived snapshot cache (current keyed records)

The ledger is authoritative: the current state is the result of REPLAYING every
non-reverted event in order. ``record_seen`` appends adds/updates live; ``reconcile``
appends removals only when handed the keys from a *complete* pass. ``revert`` marks an
event reverted and rebuilds the state, so the affected record falls back to its
previous accepted value (or disappears if the reverted event was its only add).

Generic by construction: the key field and record shape come from the profile.
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


def replay(events: list[ChangeEvent], reverted: set[int]) -> dict[str, dict]:
    """Rebuild the keyed state snapshot from the ledger, skipping reverted events.

    Each add/update carries the full record at that time, so applying events in order
    leaves each key at its last non-reverted value; a remove flips ``present`` off.
    """
    state: dict[str, dict] = {}
    for ev in events:
        if ev.id in reverted:
            continue
        entry = state.get(ev.key)
        if ev.op is ChangeOp.remove:
            if entry is not None:
                entry["present"] = False
                entry["removed_at"] = ev.ts
            continue
        if entry is None:
            state[ev.key] = {"values": dict(ev.values), "first_seen": ev.ts,
                             "last_seen": ev.ts, "present": True}
        else:
            entry["values"] = dict(ev.values)
            entry["last_seen"] = ev.ts
            entry["present"] = True
            entry.pop("removed_at", None)
    return state


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
        self._history_path = base / f"{dataset}.history.jsonl"
        self._reverted_path = base / f"{dataset}.reverted.json"
        self._state_path = base / f"{dataset}.state.json"
        self._key_field = key_field
        self._clock = clock
        self._events: list[ChangeEvent] = []
        self._reverted: set[int] = set()
        self._next_id = 1
        self._state: dict[str, dict] = {}
        self._load()

    # ---- persistence -------------------------------------------------------

    def _load(self) -> None:
        if self._history_path.exists():
            for line in self._history_path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line:
                    self._events.append(ChangeEvent.from_dict(json.loads(line)))
        if self._reverted_path.exists():
            self._reverted = set(json.loads(self._reverted_path.read_text(encoding="utf-8")))
        self._next_id = 1 + max((e.id for e in self._events), default=0)
        self._state = replay(self._events, self._reverted)

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
        self._events.append(event)

    def _save_reverted(self) -> None:
        self._reverted_path.parent.mkdir(parents=True, exist_ok=True)
        self._reverted_path.write_text(json.dumps(sorted(self._reverted)), encoding="utf-8")

    def _new_event(self, op: ChangeOp, key: str, values: dict, changed: dict | None = None) -> ChangeEvent:
        ev = ChangeEvent(self._clock(), op, key, values, changed or {}, id=self._next_id)
        self._next_id += 1
        self._append(ev)
        return ev

    # ---- mutation ----------------------------------------------------------

    def record_seen(self, values: dict) -> ChangeEvent | None:
        """Register a confirmed record. Logs an add or a field update; returns the
        event, or ``None`` if nothing changed (record already known and identical)."""
        key = _norm_key(values.get(self._key_field))
        if key is None:
            return None
        entry = self._state.get(key)

        if entry is None:
            ev = self._new_event(ChangeOp.add, key, dict(values))
            self._state[key] = {"values": dict(values), "first_seen": ev.ts,
                                "last_seen": ev.ts, "present": True}
            return ev

        changed = {}
        merged = dict(entry["values"])
        for fld, new in values.items():
            old = entry["values"].get(fld)
            if old != new:
                changed[fld] = [old, new]
                merged[fld] = new
        was_absent = not entry.get("present", True)
        if not changed and not was_absent:
            return None

        op = ChangeOp.add if was_absent else ChangeOp.update
        ev = self._new_event(op, key, merged, changed)
        entry["values"] = merged
        entry["last_seen"] = ev.ts
        entry["present"] = True
        entry.pop("removed_at", None)
        return ev

    def reconcile(self, present_keys: set[str]) -> list[ChangeEvent]:
        """Mark stored keys absent from a *complete* pass as removed.

        ``present_keys`` must already be normalised (lowercased/stripped). Only call
        when confident the pass saw the whole dataset, else occlusion logs false removals.
        """
        events: list[ChangeEvent] = []
        for key, entry in self._state.items():
            if entry.get("present", True) and key not in present_keys:
                ev = self._new_event(ChangeOp.remove, key, dict(entry["values"]))
                entry["present"] = False
                entry["removed_at"] = ev.ts
                events.append(ev)
        return events

    # ---- ledger / revert ---------------------------------------------------

    def set_reverted(self, event_id: int, reverted: bool = True) -> None:
        """Revert (or un-revert) one event, then rebuild the state from the ledger so
        the affected record falls back to its previous accepted value."""
        if reverted:
            self._reverted.add(int(event_id))
        else:
            self._reverted.discard(int(event_id))
        self._save_reverted()
        self._state = replay(self._events, self._reverted)
        self.save()

    def history(self, limit: int = 50) -> list[dict]:
        """Ledger entries newest-first, each annotated with whether it's reverted."""
        out = []
        for ev in reversed(self._events[-limit:] if limit else self._events):
            d = ev.to_dict()
            d["reverted"] = ev.id in self._reverted
            out.append(d)
        return out

    # ---- queries -----------------------------------------------------------

    @property
    def present_count(self) -> int:
        return sum(1 for e in self._state.values() if e.get("present", True))

    def records(self, limit: int = 200) -> list[dict]:
        rows = [{"key": k, "present": e.get("present", True),
                 "first_seen": e.get("first_seen"), "last_seen": e.get("last_seen"),
                 **e.get("values", {})} for k, e in self._state.items()]
        rows.sort(key=lambda r: (not r["present"], r["key"]))
        return rows[:limit]

    def normalize_key(self, value) -> str | None:
        return _norm_key(value)
