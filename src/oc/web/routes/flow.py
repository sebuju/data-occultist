"""Dashboard endpoints: the window->dataset->records data flow."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ...profile import list_profiles
from ...runtime import load_live_profile
from ...store import inspect, rows_at, store_for
from ...store.dataset_store import DatasetStore
from ..deps import get_settings

router = APIRouter(prefix="/api/flow", tags=["flow"])


@router.get("/{game}")
def flow(game: str):
    """Structure + live counts: each window, the dataset it feeds, and per-dataset
    stored totals with the most recent change."""
    settings = get_settings()
    if game not in list_profiles(settings.profiles_dir):
        raise HTTPException(status_code=404, detail=f"No profile {game!r}")
    profile = load_live_profile(settings.profiles_dir, game)

    windows = []
    used_datasets = set()
    for w in profile.windows:
        ds = w.dataset_id   # None when the window has no dataset (records discarded)
        if ds is not None:
            used_datasets.add(ds)
        windows.append({
            "id": w.id,
            "dataset": ds,
            "key_fields": profile.key_map_for(ds).fields_used() if ds is not None else [],
            "fields": sorted({r.field for r in w.regions}),
            "regions": len(w.regions),
            "detect": len(w.detect),
            "states": [s.id for s in w.states],
            "save_states": [s.id for s in w.states if s.valid_for_save],
        })

    # Datasets from the profile plus any already on disk. The resolved key map is
    # only needed to OPEN the store (replay re-keys from raw values) — the dataset
    # itself reports nothing about keys; they're taught on the windows/items.
    names = sorted(used_datasets | set(inspect.list_datasets(settings.data_dir, game)))
    datasets = [inspect.summarize(settings.data_dir, game, n, profile.key_map_for(n),
                                  profile.aggregate_for(n))
                for n in names]
    return {"game": game, "windows": windows, "datasets": datasets}


def _store(game: str, dataset: str, aggregate: str | None = None) -> DatasetStore:
    settings = get_settings()
    profile = load_live_profile(settings.profiles_dir, game) if game in list_profiles(settings.profiles_dir) else None
    # a view passes its OWN aggregate (the 'many → one' is the view's call); a bare dataset read
    # falls back to the profile/dataset default — store_for resolves both key and aggregate.
    return store_for(settings.data_dir, game, dataset, profile=profile, aggregate=aggregate)


def _detail(store: DatasetStore, dataset: str, limit: int = 0) -> dict:
    # Parse the ledger up front so `records` (keyed state) can't lag the `batches`/`history` we
    # show from that same ledger — and so a stale state cache self-heals before we read it.
    store.ensure_loaded()
    # `history` (per-event) kept for the legacy dashboard page; the graph uses `batches`
    return {"dataset": dataset, "records": store.records(limit),
            "batches": store.batches(80), "history": store.history(50)}


@router.get("/{game}/dataset/{dataset}")
def dataset_detail(game: str, dataset: str, limit: int = 0):
    return _detail(_store(game, dataset), dataset, limit)


@router.get("/{game}/dataset/{dataset}/observations")
def record_observations(game: str, dataset: str, key: str):
    """The 'many' under one record key: every observation that aggregated into it."""
    return {"key": key, "observations": _store(game, dataset).observations(key)}


@router.post("/{game}/dataset/{dataset}/rename")
def rename_dataset_route(game: str, dataset: str, to: str):
    """Move a dataset's stored records to a new name (the profile rename is saved
    separately by the UI). Keeps the live dataset list from re-spawning the old name."""
    from ...store.dataset_store import rename_dataset
    to = to.strip()
    if not to:
        raise HTTPException(status_code=400, detail="empty dataset name")
    settings = get_settings()
    try:
        rename_dataset(settings.data_dir, game, dataset, to)
    except FileExistsError as e:
        raise HTTPException(status_code=409, detail=str(e))
    return {"dataset": to}


@router.post("/{game}/dataset/{dataset}/clear")
def clear_dataset(game: str, dataset: str):
    """Empty the records by reverting every batch — the batch ledger is kept (each
    batch restorable)."""
    from ...store.db_backup import snapshot_db
    snapshot_db(get_settings().data_dir, game, reason=f"pre-clear:{dataset}")
    store = _store(game, dataset)
    store.clear_data()
    return _detail(store, dataset)


@router.post("/{game}/dataset/{dataset}/delete")
def delete_dataset_route(game: str, dataset: str):
    """Permanently delete a dataset's stored files (ledger + state). The profile def is
    removed separately by the UI; this stops the dataset re-spawning from disk."""
    from ...store import changes
    from ...store.dataset_store import delete_dataset
    from ...store.db_backup import snapshot_db
    settings = get_settings()
    snapshot_db(settings.data_dir, game, reason=f"pre-delete:{dataset}")
    removed = delete_dataset(settings.data_dir, game, dataset)
    if removed:
        changes.publish(game, dataset)   # node + any data panel watching it refresh -> empty
    return {"dataset": dataset, "removed": removed}


@router.post("/{game}/dataset/{dataset}/remove-batch")
def remove_batch_route(game: str, dataset: str, batch: int):
    """Permanently delete one batch from the ledger."""
    store = _store(game, dataset)
    store.remove_batch(batch)
    return _detail(store, dataset)


@router.post("/{game}/dataset/{dataset}/revert")
def revert_batch(game: str, dataset: str, batch: int, on: bool = True):
    """Revert (``on=true``) or restore a whole collection/save batch — every record it
    added or changed falls back to its previous accepted value. Returns refreshed detail."""
    store = _store(game, dataset)
    store.revert_batch(batch, on)   # the store owns the change-bus announce (incl. restore rows)
    return _detail(store, dataset)


def _batch_detail(store: DatasetStore, dataset: str, batch: int) -> dict:
    return {"dataset": dataset, "batch": int(batch),
            "events": store.batch_events(batch), "preview": store.preview_batch(batch),
            "batches": store.batches(80)}


@router.get("/{game}/dataset/{dataset}/batch/{batch}")
def batch_detail(game: str, dataset: str, batch: int):
    """One batch: its events + a preview of what applying it changes in the dataset."""
    return _batch_detail(_store(game, dataset), dataset, batch)


@router.post("/{game}/dataset/{dataset}/event/{event_id}/revert")
def revert_event(game: str, dataset: str, batch: int, event_id: int, on: bool = True):
    """Revert/restore a single event within a batch."""
    store = _store(game, dataset)
    store.set_reverted(event_id, on)
    return _batch_detail(store, dataset, batch)


@router.post("/{game}/dataset/{dataset}/event/{event_id}/edit")
def edit_event(game: str, dataset: str, batch: int, event_id: int, values: dict):
    """Replace a single event's recorded values (permanent ledger rewrite)."""
    store = _store(game, dataset)
    if not store.edit_event(event_id, values):
        raise HTTPException(status_code=404, detail=f"no event {event_id}")
    return _batch_detail(store, dataset, batch)


@router.post("/{game}/dataset/{dataset}/event/{event_id}/remove")
def remove_event(game: str, dataset: str, batch: int, event_id: int):
    """Permanently delete a single event from the ledger."""
    store = _store(game, dataset)
    store.remove_event(event_id)
    return _batch_detail(store, dataset, batch)


# ---- subsets: derived tables over a dataset --------------------------------

def _subset(game: str, subset: str):
    settings = get_settings()
    if game not in list_profiles(settings.profiles_dir):
        raise HTTPException(status_code=404, detail=f"No profile {game!r}")
    profile = load_live_profile(settings.profiles_dir, game)
    sub = profile.subset_def(subset)
    if sub is None:
        raise HTTPException(status_code=404, detail=f"No subset {subset!r}")
    return profile, sub


def _flow_fetch(game: str):
    """A ``fetch_dataset(dataset_id, aggregate)`` for :func:`compute_view_rows` — a plain
    dataset's records aggregated by the CONSUMING subset's ``aggregate`` policy.

    records() off the fingerprinted state cache — NO forced ledger parse. The cache's src
    (history size+mtime) invalidates on any append, so _load reparses whenever the ledger
    moved; when it hasn't, the cache is provably current and a subset can't lag it. Parsing
    the full ledger here (ensure_loaded) cost ~870ms on a 44MB/101k-event dataset for no
    gain — the heal it provided only ever fired on an already-poisoned cache.

    ``agg == "all"`` is the no-collapse opt-out: open at ``latest`` (so the materialisation
    doesn't churn) and return every observation via :func:`rows_at`."""
    return lambda ds, agg: rows_at(_store(game, ds, "latest" if agg == "all" else agg), agg)


@router.get("/{game}/subset/{subset}")
def subset_view(game: str, subset: str):
    """Compute a view: outer-join its sources (datasets OR other views) on the shared key,
    then filter + derive + sort. View inputs are computed first (dependency order), so an
    upstream view's derived columns feed downstream. Recomputed from current records, so it
    tracks updates. Input cycles resolve to empty rather than looping."""
    from ...enrich.subset import compute_view_rows
    from ...store import stats_store
    profile, sub = _subset(game, subset)
    # Time the whole top-level recompute (nested inputs included) — this is the cost that
    # grows as the source datasets grow. Nested views aren't timed separately (no double-count).
    with stats_store.time_block(game, f"sub:{subset}", "rc",
                                n_fn=lambda: len(result.get("rows", []))):
        result = compute_view_rows(profile, subset, _flow_fetch(game))
    return {"subset": subset, "datasets": sub.inputs(), **result}


class _DetailsReq(BaseModel):
    datasets: list[str] = []
    subsets: list[str] = []


@router.post("/{game}/details")
def flow_details(game: str, req: _DetailsReq):
    """One round-trip for the graph boot: every requested dataset's detail + subset's view at
    once. A single ``store`` memo is shared across the whole batch, so a dataset that feeds its
    own node AND several views opens/parses once instead of once per consumer (the per-node
    fan-out — and the same source fetched once per view — collapses to one request)."""
    from ...enrich.subset import compute_view_rows
    from ...store import stats_store
    settings = get_settings()
    if game not in list_profiles(settings.profiles_dir):
        raise HTTPException(status_code=404, detail=f"No profile {game!r}")
    profile = load_live_profile(settings.profiles_dir, game)

    memo: dict[tuple[str, str | None], DatasetStore] = {}
    def store(ds: str, aggregate: str | None = None) -> DatasetStore:
        k = (ds, aggregate)
        if k not in memo:
            memo[k] = store_for(settings.data_dir, game, ds, profile=profile, aggregate=aggregate)
        return memo[k]

    datasets: dict[str, dict] = {}
    for ds in dict.fromkeys(req.datasets):   # dedupe, keep order
        try:
            datasets[ds] = _detail(store(ds), ds)
        except Exception:
            continue   # a bad / disk-only id must not sink the rest of the batch

    # subset rows aggregate by the CONSUMING view's policy (mirrors _flow_fetch) — share the memo
    def fetch(d, agg):
        return rows_at(store(d, "latest" if agg == "all" else agg), agg)
    subsets: dict[str, dict] = {}
    for sid in dict.fromkeys(req.subsets):
        sub = profile.subset_def(sid)
        if sub is None:
            continue
        result: dict = {"rows": []}
        try:
            with stats_store.time_block(game, f"sub:{sid}", "rc",
                                        n_fn=lambda: len(result.get("rows", []))):
                result = compute_view_rows(profile, sid, fetch)
            subsets[sid] = {"subset": sid, "datasets": sub.inputs(), **result}
        except Exception:
            continue
    return {"datasets": datasets, "subsets": subsets}
