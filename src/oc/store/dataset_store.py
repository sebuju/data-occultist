"""Per-dataset store backed by a revertable ledger.

Files (under ``data/<game>/``):
  * ``<dataset>.history.jsonl`` — append-only ChangeEvent ledger (the source of truth)
  * ``<dataset>.reverted.json`` — set of event ids the user has reverted
  * ``<dataset>.state.json``    — derived snapshot cache (current keyed records)

The ledger is authoritative: the current state is the result of REPLAYING every
non-reverted event in order. Events are grouped into **batches** (one collection/save
run), so the ledger reads as a short list of runs the user can revert wholesale, not a
flood of per-row events.

How rows are keyed (which fields, joined how) is taught on the window/item that
reads them; the resolved :class:`KeySpec`/:class:`KeyMap` is passed in here.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path

from .change import ChangeEvent, ChangeOp
from .keys import KeyMap, KeySpec


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# the three files that make up one dataset on disk (see module docstring)
_DATASET_SUFFIXES = (".history.jsonl", ".reverted.json", ".state.json")


def rename_dataset(data_dir: Path | str, game: str, old: str, new: str) -> bool:
    """Move a dataset's on-disk files from ``old`` to ``new`` so its collected records
    follow a rename in the profile. Returns True if anything was moved. Refuses (raises
    ``FileExistsError``) if any destination file already exists — merging two ledgers
    would collide event ids."""
    base = Path(data_dir) / game
    pairs = [(base / f"{old}{suf}", base / f"{new}{suf}") for suf in _DATASET_SUFFIXES]
    present = [(src, dst) for src, dst in pairs if src.exists()]
    for _, dst in present:
        if dst.exists():
            raise FileExistsError(f"dataset {new!r} already has data")
    for src, dst in present:
        src.rename(dst)
    return bool(present)


def delete_dataset(data_dir: Path | str, game: str, dataset: str) -> bool:
    """Permanently delete a dataset's on-disk files (ledger + reverted + state cache).
    Returns True if anything was deleted. Unlike ``clear_data`` (which reverts every
    event but keeps the ledger), this removes the dataset entirely from disk."""
    base = Path(data_dir) / game
    removed = False
    for suf in _DATASET_SUFFIXES:
        path = base / f"{dataset}{suf}"
        if path.exists():
            path.unlink()
            removed = True
    return removed


def replay(events: list[ChangeEvent], reverted: set[int],
           key: KeyMap | KeySpec = KeySpec()) -> dict[str, dict]:
    """Rebuild the keyed state snapshot from the ledger, skipping reverted events.

    The key is recomputed from each event's raw ``values`` with the CURRENT key spec
    — the events store the record as-is, never a baked key, so changing the key
    (e.g. adding ``level`` to an arcane's key) re-keys the whole dataset on the next
    replay. Each add/update carries the full record at that time, so applying events
    in order leaves each key at its last non-reverted value; a remove flips
    ``present`` off. Events that can't be keyed under the current spec (a key part
    missing/empty) are skipped.
    """
    state: dict[str, dict] = {}
    for ev in events:
        if ev.id in reverted:
            continue
        k = key.build(ev.values)
        if k is None:
            continue
        entry = state.get(k)
        if ev.op is ChangeOp.remove:
            if entry is not None:
                entry["present"] = False
                entry["removed_at"] = ev.ts
            continue
        if entry is None:
            state[k] = {"values": dict(ev.values), "first_seen": ev.ts,
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
        key: KeyMap | KeySpec = KeySpec(),
        clock: Callable[[], str] = _utcnow_iso,
    ) -> None:
        base = Path(data_dir) / game
        self._history_path = base / f"{dataset}.history.jsonl"
        self._reverted_path = base / f"{dataset}.reverted.json"
        self._state_path = base / f"{dataset}.state.json"
        self._key = key
        self._clock = clock
        self._events: list[ChangeEvent] = []
        self._reverted: set[int] = set()
        self._next_id = 1
        self._batch = 0
        self._state: dict[str, dict] = {}
        self._load()

    # ---- persistence -------------------------------------------------------

    def _replay(self) -> dict[str, dict]:
        return replay(self._events, self._reverted, self._key)

    def _meta(self) -> dict:
        """Fingerprint of the inputs the cached state was built from. State is reused only
        when this matches — so a key change (re-key) or a new/removed event invalidates
        the cache and forces a replay."""
        return {"key": self._key.meta(),
                "n_events": len(self._events), "reverted": sorted(self._reverted)}

    def _load(self) -> None:
        history_existed = self._history_path.exists()
        if history_existed:
            for line in self._history_path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line:
                    self._events.append(ChangeEvent.from_dict(json.loads(line)))
        if self._reverted_path.exists():
            self._reverted = set(json.loads(self._reverted_path.read_text(encoding="utf-8")))
        self._next_id = 1 + max((e.id for e in self._events), default=0)
        self._batch = max((e.batch for e in self._events), default=0)
        if not self._load_cached_state():
            self._state = self._replay()
            # Only persist the state cache for a dataset that actually has a ledger.
            # Merely READING a nonexistent/renamed dataset must not write a phantom
            # ``<name>.state.json`` — list_datasets globs those, so it would resurface
            # the dataset (e.g. the old name after a rename) as a blank duplicate.
            if history_existed:
                self.save()

    def _load_cached_state(self) -> bool:
        """Use the cached snapshot when its fingerprint still matches the current key
        options + ledger; otherwise we must re-key. Returns True if the cache was used."""
        if not self._state_path.exists():
            return False
        try:
            cached = json.loads(self._state_path.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            return False
        if not isinstance(cached, dict) or cached.get("_meta") != self._meta():
            return False
        self._state = cached.get("state", {})
        return True

    def save(self) -> None:
        self._state_path.parent.mkdir(parents=True, exist_ok=True)
        self._state_path.write_text(
            json.dumps({"_meta": self._meta(), "state": self._state},
                       ensure_ascii=False, indent=0, sort_keys=True),
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
        key = self._key.build(values)
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
        self._state = self._replay()
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
        self._state = self._replay()
        self.save()

    def _replay_with(self, reverted: set[int]) -> dict[str, dict]:
        return replay(self._events, reverted, self._key)

    def batch_events(self, batch: int) -> list[dict]:
        """Every event of one batch in ledger order, each flagged reverted."""
        batch = int(batch)
        out = []
        for ev in self._events:
            if ev.batch != batch:
                continue
            d = ev.to_dict()
            d["reverted"] = ev.id in self._reverted
            d["key"] = self._key.build(ev.values)
            out.append(d)
        return out

    def preview_batch(self, batch: int) -> list[dict]:
        """What APPLYING this batch changes in the dataset, independent of whether it is
        currently applied: diff between the dataset with the batch fully off vs fully on
        (all other batches kept in their current reverted state). One row per affected
        key: kind add/update/remove, with before/after values and per-field old→new."""
        batch = int(batch)
        bids = {e.id for e in self._events if e.batch == batch}
        if not bids:
            return []
        base = self._replay_with(self._reverted | bids)    # batch off
        after = self._replay_with(self._reverted - bids)   # batch on
        out = []
        for k in sorted(set(base) | set(after)):
            b, a = base.get(k), after.get(k)
            bp = bool(b and b.get("present"))
            ap = bool(a and a.get("present"))
            bv = (b or {}).get("values") or {}
            av = (a or {}).get("values") or {}
            if not bp and ap:
                kind = "add"
            elif bp and not ap:
                kind = "remove"
            elif bp and ap and bv != av:
                kind = "update"
            else:
                continue
            changed = {f: [bv.get(f), av.get(f)] for f in set(bv) | set(av) if bv.get(f) != av.get(f)}
            out.append({"key": k, "kind": kind,
                        "before": bv if bp else None, "after": av if ap else None,
                        "changed": changed})
        return out

    def edit_event(self, event_id: int, values: dict) -> bool:
        """Replace one event's recorded values (re-keys it if the key field changed).
        Permanent — rewrites the ledger."""
        eid = int(event_id)
        for ev in self._events:
            if ev.id == eid:
                ev.values = dict(values)
                self._rewrite_history()
                self._state = self._replay()
                self.save()
                return True
        return False

    def remove_event(self, event_id: int) -> bool:
        """Permanently delete one event from the ledger."""
        eid = int(event_id)
        kept = [e for e in self._events if e.id != eid]
        if len(kept) == len(self._events):
            return False
        self._events = kept
        self._reverted.discard(eid)
        self._rewrite_history()
        self._save_reverted()
        self._state = self._replay()
        self.save()
        return True

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
                "keys": [self._key.build(e.values) or "·" for e in evs[:8]],
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

    def key_of(self, values: dict) -> str | None:
        """The record's dedup key under this store's spec, or ``None`` if unkeyable."""
        return self._key.build(values)
