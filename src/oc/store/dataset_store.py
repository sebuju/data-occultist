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

from . import changes
from .change import ChangeEvent, ChangeOp
from .keys import KeyMap, KeySpec


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# the three files that make up one dataset on disk (see module docstring)
_DATASET_SUFFIXES = (".history.jsonl", ".reverted.json", ".state.json")

# how a key's MANY observations collapse to one displayed value (per-dataset choice)
AGGREGATES = ("latest", "first", "sum", "mean", "max", "min")


def _num(v):
    try:
        return float(str(v).strip())
    except (TypeError, ValueError):
        return None


def aggregate_records(records: list[dict], policy: str = "latest") -> dict:
    """Collapse a key's observation list (each ``{"values":{...}, "ts":...}``, oldest→
    newest) to one row of values per the dataset's ``policy``.

    ``latest``/``first`` take that observation's values wholesale. ``sum``/``mean``/
    ``max``/``min`` apply per field over the NUMERIC observations; a field with no numeric
    values (e.g. ``name``) falls back to its latest value, so key fields are preserved.
    """
    if not records:
        return {}
    latest = records[-1].get("values", {})
    if policy == "first":
        return dict(records[0].get("values", {}))
    if policy not in ("sum", "mean", "max", "min"):
        return dict(latest)                       # "latest" / unknown
    fields: list[str] = []
    for r in records:
        for k in r.get("values", {}):
            if k not in fields:
                fields.append(k)
    fns = {"sum": sum, "mean": lambda ns: sum(ns) / len(ns), "max": max, "min": min}
    out: dict = {}
    for k in fields:
        nums = [n for n in (_num(r.get("values", {}).get(k)) for r in records) if n is not None]
        if nums:
            v = fns[policy](nums)
            out[k] = int(v) if float(v).is_integer() else round(v, 2)
        else:
            out[k] = latest.get(k)
    return out


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
           key: KeyMap | KeySpec = KeySpec(), aggregate: str = "latest") -> dict[str, dict]:
    """Rebuild the keyed state from the ledger, skipping reverted events.

    A key holds MANY observations now: each non-reverted add/update appends the record it
    carried (so the whole history of a key is kept, not just its last value), and the
    dataset's ``aggregate`` policy collapses that list into the displayed ``values``. The
    key is recomputed from each event's raw ``values`` with the CURRENT key spec, so a key
    change re-keys the dataset on the next replay; a remove flips ``present`` off. Events
    unkeyable under the current spec (a key part missing/empty) are skipped.
    """
    no_dedup = getattr(key, "dedup", True) is False
    state: dict[str, dict] = {}
    for ev in events:
        if ev.id in reverted:
            continue
        if no_dedup:
            # 1->many OFF: every non-remove observation is its own record, keyed per event.
            if ev.op is ChangeOp.remove:
                continue
            state[f"#{ev.id}"] = {"records": [{"values": dict(ev.values), "ts": ev.ts}],
                                  "first_seen": ev.ts, "last_seen": ev.ts, "present": True, "_seq": ev.id}
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
        obs = {"values": dict(ev.values), "ts": ev.ts}
        if entry is None:
            # _seq = the add event's id: a monotonic rolling id capturing arrival order,
            # stable across replays (same ledger -> same ids). Sort by it for "order they came".
            state[k] = {"records": [obs], "first_seen": ev.ts, "last_seen": ev.ts, "present": True, "_seq": ev.id}
        else:
            entry["records"].append(obs)
            entry["last_seen"] = ev.ts
            entry["present"] = True
            entry.pop("removed_at", None)
    for entry in state.values():
        entry["values"] = aggregate_records(entry["records"], aggregate)
    return state


class DatasetStore:
    def __init__(
        self,
        data_dir: Path | str,
        game: str,
        dataset: str,
        key: KeyMap | KeySpec = KeySpec(),
        clock: Callable[[], str] = _utcnow_iso,
        aggregate: str = "latest",
    ) -> None:
        base = Path(data_dir) / game
        self._game = game
        self._dataset = dataset
        self._history_path = base / f"{dataset}.history.jsonl"
        self._reverted_path = base / f"{dataset}.reverted.json"
        self._state_path = base / f"{dataset}.state.json"
        self._key = key
        self._agg = aggregate or "latest"
        self._clock = clock
        self._events: list[ChangeEvent] = []
        self._events_loaded = False   # events are parsed lazily — a valid cache skips the parse
        self._n_events = 0            # total event count (kept without holding the list)
        self._reverted: set[int] = set()
        self._next_id = 1
        self._batch = 0
        self._state: dict[str, dict] = {}
        self._load()

    # ---- persistence -------------------------------------------------------

    def _replay(self) -> dict[str, dict]:
        self._ensure_events()
        return replay(self._events, self._reverted, self._key, self._agg)

    def _apply_agg(self, entry: dict) -> None:
        entry["values"] = aggregate_records(entry.get("records", []), self._agg)

    def _src(self) -> dict | None:
        """Identity of the history file (size + mtime) — lets the cache be validated WITHOUT
        parsing the file. Any append changes it, invalidating the cache."""
        try:
            st = self._history_path.stat()
            return {"size": st.st_size, "mtime": st.st_mtime_ns}
        except OSError:
            return None

    def _meta(self) -> dict:
        """Fingerprint the cached state was built from, validated WITHOUT reading history:
        shape version + key spec + reverted set + the history file's size/mtime. It also
        carries ``next_id``/``batch``/``n_events`` so the fast path can restore them without
        a parse. A re-key, a revert, or any new event (file grows) invalidates it."""
        return {"v": 4, "key": self._key.meta(), "reverted": sorted(self._reverted),
                "src": self._src(), "next_id": self._next_id, "batch": self._batch,
                "n_events": self._n_events}

    def _read_events(self) -> None:
        """Parse the full history ledger into memory (the expensive part — avoided when a
        valid state cache exists)."""
        self._events = []
        if self._history_path.exists():
            for line in self._history_path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line:
                    self._events.append(ChangeEvent.from_dict(json.loads(line)))
        self._n_events = len(self._events)
        self._next_id = 1 + max((e.id for e in self._events), default=0)
        self._batch = max((e.batch for e in self._events), default=0)
        self._events_loaded = True

    def _ensure_events(self) -> None:
        """Parse the ledger on first need (revert/edit/batch views/replay)."""
        if not self._events_loaded:
            self._read_events()

    def _load(self) -> None:
        history_existed = self._history_path.exists()
        if self._reverted_path.exists():
            self._reverted = set(json.loads(self._reverted_path.read_text(encoding="utf-8")))
        if self._load_cached_state():   # FAST: stat-validated cache, no history parse
            return
        # cache miss -> parse the ledger, replay, and persist a fresh cache
        self._read_events()
        self._state = self._replay()
        # Only persist the state cache for a dataset that actually has a ledger. Merely
        # READING a nonexistent/renamed dataset must not write a phantom ``<name>.state.json``
        # — list_datasets globs those, so it would resurface the dataset as a blank duplicate.
        if history_existed:
            self.save()

    def _load_cached_state(self) -> bool:
        """Use the cached snapshot when its fingerprint (key + reverted + history size/mtime)
        still matches — WITHOUT parsing history. Restores next_id/batch/n_events from the
        cache so events can stay unloaded. Returns True if the cache was used."""
        if not self._state_path.exists():
            return False
        try:
            cached = json.loads(self._state_path.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            return False
        if not isinstance(cached, dict):
            return False
        meta = cached.get("_meta") or {}
        if (meta.get("v") != 4 or meta.get("key") != self._key.meta()
                or meta.get("reverted") != sorted(self._reverted) or meta.get("src") != self._src()):
            return False
        self._state = cached.get("state", {})
        for entry in self._state.values():   # recompute displayed values under THIS aggregate
            self._apply_agg(entry)
        self._next_id = meta.get("next_id", 1)
        self._batch = meta.get("batch", 0)
        self._n_events = meta.get("n_events", 0)
        return True   # events stay lazy

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
        self._n_events += 1
        if self._events_loaded:
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

    def _announce(self, records: list) -> None:
        """Tell the change bus this dataset's data changed (UI push + on_change triggers).
        ``records`` are the values just added/updated, for trigger pricing; [] = UI-only."""
        changes.publish(self._game, self._dataset, records)

    # ---- mutation ----------------------------------------------------------

    def record_seen(self, values: dict) -> ChangeEvent | None:
        """Register a confirmed record. A NEW key starts an observation list; an existing
        key APPENDS a fresh observation when the merged record differs from its latest
        (so the key accumulates a history instead of overwriting). Returns the event, or
        ``None`` when the read is identical to the current latest (nothing to track)."""
        if getattr(self._key, "dedup", True) is False:
            # 1->many OFF: every read is its own record (keyed per event), never merged.
            ev = self._new_event(ChangeOp.add, "", dict(values))
            self._state[f"#{ev.id}"] = {"records": [{"values": dict(values), "ts": ev.ts}],
                                        "first_seen": ev.ts, "last_seen": ev.ts, "present": True,
                                        "_seq": ev.id, "values": dict(values)}
            self._apply_agg(self._state[f"#{ev.id}"])
            self._announce([dict(values)])
            return ev
        key = self._key.build(values)
        if key is None:
            return None
        entry = self._state.get(key)

        if entry is None:
            ev = self._new_event(ChangeOp.add, key, dict(values))
            self._state[key] = {"records": [{"values": dict(values), "ts": ev.ts}],
                                "first_seen": ev.ts, "last_seen": ev.ts, "present": True,
                                "_seq": ev.id, "values": dict(values)}
            self._apply_agg(self._state[key])
            self._announce([dict(values)])
            return ev

        records = entry.setdefault("records", [])
        latest = records[-1]["values"] if records else {}
        merged = {**latest, **values}              # observation = full record state now
        changed = {f: [latest.get(f), merged.get(f)] for f in merged if latest.get(f) != merged.get(f)}
        was_absent = not entry.get("present", True)
        if not changed and not was_absent:
            return None                            # identical to latest → nothing to add

        op = ChangeOp.add if was_absent else ChangeOp.update
        ev = self._new_event(op, key, dict(merged), changed)
        records.append({"values": dict(merged), "ts": ev.ts})
        entry["last_seen"] = ev.ts
        entry["present"] = True
        entry.pop("removed_at", None)
        self._apply_agg(entry)                     # refresh the displayed (aggregated) value
        self._announce([dict(merged)])
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
        if events:
            self._announce([])
        return events

    # ---- ledger / revert ---------------------------------------------------

    def _apply_reverted(self, records: list | None = None) -> None:
        self._save_reverted()
        self._state = self._replay()
        self.save()
        # `records` are the rows a restore re-applies (so on_change re-prices them); a plain
        # revert/clear passes none -> UI-only announce.
        self._announce(records or [])

    def set_reverted(self, event_id: int, reverted: bool = True) -> None:
        """Revert (or un-revert) a single event."""
        self._reverted.add(int(event_id)) if reverted else self._reverted.discard(int(event_id))
        self._apply_reverted()

    def revert_batch(self, batch: int, reverted: bool = True) -> None:
        """Revert (or restore) a whole batch — every record it added/changed falls back
        to its previous accepted value."""
        self._ensure_events()
        bi = int(batch)
        ids = {e.id for e in self._events if e.batch == bi}
        if reverted:
            self._reverted |= ids
            self._apply_reverted()
        else:
            self._reverted -= ids
            # restoring re-applies this batch's live rows -> announce them so on_change prices
            # them. Owned by the mutation, not the caller, so every restore path is covered.
            recs = [dict(e.values) for e in self._events
                    if e.batch == bi and e.id not in self._reverted and e.values]
            self._apply_reverted(recs)

    def clear_data(self) -> None:
        """Empty the current records by reverting every event — KEEPS the batch ledger
        (each batch shows reverted and stays restorable)."""
        self._ensure_events()
        self._reverted = {e.id for e in self._events}
        self._apply_reverted()

    def _rewrite_history(self) -> None:
        self._history_path.parent.mkdir(parents=True, exist_ok=True)
        self._history_path.write_text("".join(e.to_json() + "\n" for e in self._events), encoding="utf-8")

    def remove_batch(self, batch: int) -> None:
        """Permanently delete a batch's events from the ledger (not just revert)."""
        batch = int(batch)
        self._ensure_events()
        ids = {e.id for e in self._events if e.batch == batch}
        if not ids:
            return
        self._events = [e for e in self._events if e.batch != batch]
        self._reverted -= ids
        self._rewrite_history()
        self._save_reverted()
        self._state = self._replay()
        self.save()
        self._announce([])

    def _replay_with(self, reverted: set[int]) -> dict[str, dict]:
        self._ensure_events()
        return replay(self._events, reverted, self._key, self._agg)

    def batch_events(self, batch: int) -> list[dict]:
        """Every event of one batch in ledger order, each flagged reverted."""
        batch = int(batch)
        self._ensure_events()
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
        self._ensure_events()
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
        self._ensure_events()
        for ev in self._events:
            if ev.id == eid:
                ev.values = dict(values)
                self._rewrite_history()
                self._state = self._replay()
                self.save()
                self._announce([dict(values)])   # edited row -> UI refresh + on_change re-price
                return True
        return False

    def remove_event(self, event_id: int) -> bool:
        """Permanently delete one event from the ledger."""
        eid = int(event_id)
        self._ensure_events()
        kept = [e for e in self._events if e.id != eid]
        if len(kept) == len(self._events):
            return False
        self._events = kept
        self._reverted.discard(eid)
        self._rewrite_history()
        self._save_reverted()
        self._state = self._replay()
        self.save()
        self._announce([])
        return True

    def history(self, limit: int = 50) -> list[dict]:
        """Individual ledger events newest-first, each flagged reverted."""
        self._ensure_events()
        out = []
        for ev in reversed(self._events[-limit:] if limit else self._events):
            d = ev.to_dict()
            d["reverted"] = ev.id in self._reverted
            out.append(d)
        return out

    def batches(self, limit: int = 50) -> list[dict]:
        """The ledger as runs, newest-first: counts + a key sample, with a reverted flag
        (true when every event in the run is reverted)."""
        self._ensure_events()
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

    def records(self, limit: int = 0) -> list[dict]:
        """All current records, present first then by key. ``limit<=0`` means no cap
        (the default) — a dataset is served whole; callers don't truncate records."""
        rows = [{"key": k, "present": e.get("present", True),
                 "first_seen": e.get("first_seen"), "last_seen": e.get("last_seen"),
                 "_count": len(e.get("records", [])), "_seq": e.get("_seq"),
                 **e.get("values", {})} for k, e in self._state.items()]
        rows.sort(key=lambda r: (not r["present"], r["key"]))
        return rows[:limit] if limit and limit > 0 else rows

    def key_of(self, values: dict) -> str | None:
        """The record's dedup key under this store's spec, or ``None`` if unkeyable."""
        return self._key.build(values)

    def observations(self, key: str) -> list[dict]:
        """The full observation history under one key, oldest→newest (each row carries its
        ``ts``). This is the 'many' side a view's aggregate collapses."""
        entry = self._state.get(key)
        return [{"ts": o.get("ts"), **o.get("values", {})} for o in (entry.get("records", []) if entry else [])]
