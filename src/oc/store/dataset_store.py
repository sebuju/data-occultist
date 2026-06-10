"""Per-dataset store backed by a revertable ledger.

Files (under ``data/<game>/``):
  * ``<dataset>.history.jsonl`` — append-only ChangeEvent ledger (the source of truth)
  * ``<dataset>.reverted.json`` — set of event ids the user has reverted
  * ``<dataset>.state.json``    — derived snapshot cache (current keyed records)

The ledger is authoritative: the current state is the result of REPLAYING every
non-reverted event in order. Events are grouped into **batches** (one collection/save
run), so the ledger reads as a short list of runs the user can revert wholesale, not a
flood of per-row events.

The dataset owns how its key is normalised for dedup (``strip_nonalnum`` /
``case_sensitive``) — set on the DatasetDef and passed in here.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path

from .change import ChangeEvent, ChangeOp


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def norm_key(value, strip_nonalnum: bool = False, case_sensitive: bool = False) -> str | None:
    """Normalise a value into a dedup key. Always trims; optionally strips everything
    but letters/digits and/or preserves case."""
    if value in (None, ""):
        return None
    s = str(value).strip()
    if strip_nonalnum:
        s = re.sub(r"[^0-9A-Za-z]", "", s)
    if not case_sensitive:
        s = s.lower()
    return s or None


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
        strip_nonalnum: bool = False,
        case_sensitive: bool = False,
        clock: Callable[[], str] = _utcnow_iso,
    ) -> None:
        base = Path(data_dir) / game
        self._history_path = base / f"{dataset}.history.jsonl"
        self._reverted_path = base / f"{dataset}.reverted.json"
        self._state_path = base / f"{dataset}.state.json"
        self._key_field = key_field
        self._strip = strip_nonalnum
        self._case = case_sensitive
        self._clock = clock
        self._events: list[ChangeEvent] = []
        self._reverted: set[int] = set()
        self._next_id = 1
        self._batch = 0
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
        self._batch = max((e.batch for e in self._events), default=0)
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
        ev = ChangeEvent(self._clock(), op, key, values, changed or {}, id=self._next_id, batch=self._batch)
        self._next_id += 1
        self._append(ev)
        return ev

    def begin_batch(self) -> int:
        """Start a new batch; subsequent ``record_seen``/``reconcile`` events belong to it.
        One run (a precapture save, a collection pass) = one revertable batch."""
        self._batch += 1
        return self._batch

    # ---- mutation ----------------------------------------------------------

    def record_seen(self, values: dict) -> ChangeEvent | None:
        """Register a confirmed record. Logs an add or a field update; returns the
        event, or ``None`` if nothing changed (record already known and identical)."""
        key = norm_key(values.get(self._key_field), self._strip, self._case)
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

        ``present_keys`` must already be normalised. Only call when confident the pass
        saw the whole dataset, else occlusion logs false removals.
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

    def _apply_reverted(self) -> None:
        self._save_reverted()
        self._state = replay(self._events, self._reverted)
        self.save()

    def set_reverted(self, event_id: int, reverted: bool = True) -> None:
        """Revert (or un-revert) a single event."""
        self._reverted.add(int(event_id)) if reverted else self._reverted.discard(int(event_id))
        self._apply_reverted()

    def revert_batch(self, batch: int, reverted: bool = True) -> None:
        """Revert (or restore) a whole batch — every record it added/changed falls back
        to its previous accepted value."""
        ids = {e.id for e in self._events if e.batch == int(batch)}
        if reverted:
            self._reverted |= ids
        else:
            self._reverted -= ids
        self._apply_reverted()

    def clear_data(self) -> None:
        """Empty the current records by reverting every event — KEEPS the batch ledger
        (each batch shows reverted and stays restorable)."""
        self._reverted = {e.id for e in self._events}
        self._apply_reverted()

    def _rewrite_history(self) -> None:
        self._history_path.parent.mkdir(parents=True, exist_ok=True)
        self._history_path.write_text("".join(e.to_json() + "\n" for e in self._events), encoding="utf-8")

    def remove_batch(self, batch: int) -> None:
        """Permanently delete a batch's events from the ledger (not just revert)."""
        batch = int(batch)
        ids = {e.id for e in self._events if e.batch == batch}
        if not ids:
            return
        self._events = [e for e in self._events if e.batch != batch]
        self._reverted -= ids
        self._rewrite_history()
        self._save_reverted()
        self._state = replay(self._events, self._reverted)
        self.save()

    def history(self, limit: int = 50) -> list[dict]:
        """Individual ledger events newest-first, each flagged reverted."""
        out = []
        for ev in reversed(self._events[-limit:] if limit else self._events):
            d = ev.to_dict()
            d["reverted"] = ev.id in self._reverted
            out.append(d)
        return out

    def batches(self, limit: int = 50) -> list[dict]:
        """The ledger as runs, newest-first: counts + a key sample, with a reverted flag
        (true when every event in the run is reverted)."""
        groups: dict[int, list[ChangeEvent]] = {}
        for ev in self._events:
            groups.setdefault(ev.batch, []).append(ev)
        out = []
        for batch in sorted(groups, reverse=True)[:limit]:
            evs = groups[batch]
            adds = sum(1 for e in evs if e.op is ChangeOp.add)
            updates = sum(1 for e in evs if e.op is ChangeOp.update)
            removes = sum(1 for e in evs if e.op is ChangeOp.remove)
            out.append({
                "batch": batch,
                "started": evs[0].ts,
                "ts": evs[-1].ts,
                "count": len(evs),
                "adds": adds, "updates": updates, "removes": removes,
                "reverted": all(e.id in self._reverted for e in evs),
                "keys": [e.key for e in evs[:8]],
            })
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
        return norm_key(value, self._strip, self._case)
