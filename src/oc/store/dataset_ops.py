"""Dataset-level data actions a trigger can perform — clear a dataset, or clone/move its data
into another dataset. The ONE funnel both firing paths call (the collector's
:meth:`TriggerRunner._fire_targets` AND the web "fire now" route), so an automatic fire and a
manual test fire behave identically — the same reason :func:`oc.collect.triggers.fire_target`
exists for producer sweeps.

Copies go through :meth:`DatasetStore.record_many` (ONE transaction, ONE change-bus announce):
per-row ``record_seen`` would flood the web app's asyncio loop with SSE publishes and wedge it.
The destination store is opened via :func:`oc.store.store_for`, so the copied raw values re-key
under the DESTINATION's key spec automatically (a src/dst key mismatch is handled for free).

Two copy shapes:

* **batches** — preserve batch grouping: each source batch becomes a fresh batch on the dest.
* **resolved** — collapse the source's current (deduped) records into ONE new batch on the dest.

Destructive actions (``clear``, and ``move``'s source clear) snapshot the DB first, throttled so
an ``interval`` trigger doing this every few seconds can't copy the whole store each time.
"""

from __future__ import annotations

import time

from . import store_for
from .dataset_store import _PLUMBING
from .db_backup import snapshot_db
from .flow_events import publish_flow

_ACTIONS = frozenset({"clear", "clone_batches", "clone_resolved", "move_batches", "move_resolved"})

# min seconds between dataset-op snapshots per game, so a fast interval trigger can't snapshot the
# whole store on every fire (the consistent copy is synchronous — see snapshot_db).
_SNAPSHOT_THROTTLE_S = 30.0
_last_snapshot: dict[str, float] = {}   # game -> monotonic time of the last dataset-op snapshot


def _strip(row: dict) -> dict:
    """A record's raw field values only — drop the bookkeeping cols so they don't land as data
    columns (and mis-key) when re-written into the destination."""
    return {k: v for k, v in row.items() if k not in _PLUMBING}


def _snapshot(data_dir, game: str, reason: str) -> None:
    """Snapshot the game's store before a destructive op, at most once per throttle window."""
    now = time.monotonic()
    if now - _last_snapshot.get(game, 0.0) < _SNAPSHOT_THROTTLE_S:
        return
    _last_snapshot[game] = now
    snapshot_db(data_dir, game, reason=reason, background=True)


def copy_batches(src_store, dest_store) -> int:
    """Copy every source batch into ``dest_store`` as its OWN fresh batch (grouping preserved).
    Reverted events and removes are skipped. Returns the number of rows written."""
    written = 0
    # batches() is newest-first; replay oldest-first so dest batch order mirrors the source.
    for meta in reversed(src_store.batches(limit=0)):
        rows = [ev["values"] for ev in src_store.batch_events(meta["batch"])
                if not ev["reverted"] and ev["op"] != "remove"]
        if not rows:
            continue
        dest_store.begin_batch()
        results = dest_store.record_many(rows)
        written += sum(1 for r in results if r is not None)
    return written


def copy_resolved(src_store, dest_store) -> int:
    """Copy the source's current present records into ONE new batch on ``dest_store``.
    Absent (soft-removed) rows are dropped — else record_many would resurrect them present.
    Returns the number of rows written."""
    rows = [_strip(r) for r in src_store.records() if r.get("present")]
    if not rows:
        return 0
    dest_store.begin_batch()
    results = dest_store.record_many(rows)
    return sum(1 for r in results if r is not None)


def run_dataset_action(data_dir, game: str, profile, *, source: str, action: str,
                       dest: str = "") -> dict:
    """Run one dataset ``action`` on ``source`` (writing to ``dest`` for clone/move).

    Returns ``{"action", "source", "dest", "rows"}`` on a real action, or ``{}`` on a no-op /
    guard failure (unknown action; clone/move with no ``dest`` or ``dest == source`` — the latter
    would clone a dataset onto itself then clear it, i.e. total data loss)."""
    if action not in _ACTIONS:
        return {}

    if action == "clear":
        _snapshot(data_dir, game, f"pre-clear:{source}")
        store_for(data_dir, game, source, profile=profile).clear_data()
        return {"action": action, "source": source, "dest": "", "rows": 0}

    # clone_* / move_*
    if not dest or dest == source:
        return {}
    src_store = store_for(data_dir, game, source, profile=profile)
    dest_store = store_for(data_dir, game, dest, profile=profile)
    copy = copy_batches if action.endswith("_batches") else copy_resolved
    written = copy(src_store, dest_store)
    if action.startswith("move_"):
        _snapshot(data_dir, game, f"pre-move:{source}")
        src_store.clear_data()
    return {"action": action, "source": source, "dest": dest, "rows": written}


def fire_dataset_target(game: str, data_dir, profile, action, dataset_id: str) -> bool:
    """Run ``action``'s dataset op (clear/clone/move) on ``dataset_id`` — the shared funnel both
    the collector dispatch and the web fire-now route call, so automatic and manual fires can't
    drift. Runs nothing (returns False) when the action has no op set. On a real op it emits the
    action->dataset control pulse (for the canvas flow animation) and returns True. A misbehaving
    op must never crash the collector loop / a request."""
    if not getattr(action, "action", ""):
        return False
    try:
        result = run_dataset_action(data_dir, game, profile, source=dataset_id,
                                    action=action.action, dest=action.dest)
    except Exception:   # noqa: BLE001
        return False
    if not result:
        return False
    publish_flow(game, "trigger", f"action:{action.id}", f"ds:{dataset_id}", 1)
    return True
