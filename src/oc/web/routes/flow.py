"""Dashboard endpoints: the window->dataset->records data flow."""

from __future__ import annotations

import threading

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ...profile import list_profiles
from ...runtime import load_live_profile
from ...store import inspect, rows_at, store_for
from ...store.dataset_store import DatasetStore
from ..deps import get_settings, get_view_cache

router = APIRouter(prefix="/api/flow", tags=["flow"])

# Process-level view cache: (game, subset_id) -> (revs_key, result). A subset's computed
# {columns, rows} is reused across requests while its transitive source datasets are unchanged
# (revs_key matches). Any write bumps a source's rev -> the key mismatches -> recompute. One
# entry per subset (a mismatch REPLACES it), so memory stays bounded to one snapshot each.
# rev lives in the shared SQLite, so a collector process writing the DB invalidates us too.
_VIEW_CACHE: dict[tuple[str, str], tuple[tuple, dict]] = {}
_VIEW_LOCK = threading.Lock()


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
    # Drop any blank id: a window left unwired (dataset "") or a legacy ""-sink on disk
    # must never surface as a ghost "empty dataset" node.
    names = sorted(n for n in (used_datasets | set(inspect.list_datasets(settings.data_dir, game))) if n)
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
    # Capture the pre-clear state synchronously (consistent copy) but compress it off-thread, so a
    # clear of one small dataset isn't blocked seconds on gzipping the whole multi-hundred-MB store.
    snapshot_db(get_settings().data_dir, game, reason=f"pre-clear:{dataset}", background=True)
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


def _view_ctx(data_dir, game: str, profile):
    """One ``(store, fetch)`` pair for a view computation, shared by the single-subset and batch
    endpoints so the store memo and the fetch policy never diverge (and so the memo `store()`
    that `fetch` opens is the SAME one `_cached_view` reads `rev` from).

    ``store(ds, aggregate)`` opens each dataset once (memoised). ``fetch(ds, agg)`` returns its
    records aggregated per the CONSUMING source's policy — off the fingerprinted state cache, NO
    forced ledger parse (the cache self-invalidates on any append). ``agg == "all"`` is the
    no-collapse opt-out: open at ``latest`` (so the materialisation doesn't churn) and return
    every observation via :func:`rows_at`."""
    memo: dict[tuple[str, str | None], DatasetStore] = {}
    def store(ds: str, aggregate: str | None = None) -> DatasetStore:
        k = (ds, aggregate)
        if k not in memo:
            memo[k] = store_for(data_dir, game, ds, profile=profile, aggregate=aggregate)
        return memo[k]
    def fetch(d, agg):
        return rows_at(store(d, "latest" if agg == "all" else agg), agg, present_only=True)
    return store, fetch


def _cached_view(game: str, profile, sid: str, store, fetch, vcache,
                  batch_cache: dict | None = None) -> dict:
    """A subset's ``{columns, rows}``, served from :data:`_VIEW_CACHE` while its transitive source
    datasets are unchanged. The rev signature (one indexed PK read per source dataset, via the
    shared ``store`` memo) gates the cache; a mismatch recomputes (timed under the stats "rc"
    bucket) and replaces the entry. ``batch_cache`` is the per-request shared view memo passed to
    :func:`compute_view_rows` so sibling subsets don't re-derive a common heavy upstream.

    Falls back to the on-disk :class:`~oc.web.view_cache.ViewCache` (``vcache``) when the
    in-memory cache misses — the process just started (empty ``_VIEW_CACHE``) but a PRIOR process
    already computed this subset at the same revs, so the sidecar saves the recompute. A disk hit
    is adopted into ``_VIEW_CACHE`` too, so the rest of this process's requests skip the sidecar."""
    from ...enrich.subset import compute_view_rows, subset_source_datasets
    from ...store import stats_store
    rk = tuple(sorted((d, store(d).rev) for d in subset_source_datasets(profile, sid)))
    with _VIEW_LOCK:
        hit = _VIEW_CACHE.get((game, sid))
        if hit is not None and hit[0] == rk:
            return hit[1]
    rk_list = [list(pair) for pair in rk]
    disk = vcache.get(sid)
    if disk is not None and disk.get("rk") == rk_list:
        result = disk["result"]
        with _VIEW_LOCK:
            _VIEW_CACHE[(game, sid)] = (rk, result)
        return result
    result: dict = {"columns": [], "rows": []}
    with stats_store.time_block(game, f"sub:{sid}", "rc",
                                n_fn=lambda: len(result.get("rows", []))):
        result = compute_view_rows(profile, sid, fetch, cache=batch_cache)
    with _VIEW_LOCK:
        _VIEW_CACHE[(game, sid)] = (rk, result)
    vcache.put(sid, rk_list, result)
    return result


@router.get("/{game}/subset/{subset}")
def subset_view(game: str, subset: str):
    """Compute a view: outer-join its sources (datasets OR other views) on the shared key,
    then filter + derive + sort. View inputs are computed first (dependency order), so an
    upstream view's derived columns feed downstream. Recomputed from current records, so it
    tracks updates. Input cycles resolve to empty rather than looping."""
    profile, sub = _subset(game, subset)
    store, fetch = _view_ctx(get_settings().data_dir, game, profile)
    vcache = get_view_cache(game)
    result = _cached_view(game, profile, subset, store, fetch, vcache)
    vcache.save()   # no-op when nothing new was computed (dirty check)
    return {"subset": subset, "datasets": sub.inputs(), **result}


class _DetailsReq(BaseModel):
    datasets: list[str] = []
    subsets: list[str] = []


@router.post("/{game}/details")
def flow_details(game: str, req: _DetailsReq):
    """One round-trip for the graph boot: every requested dataset's detail + subset's view at
    once. A single ``store`` memo is shared across the whole batch, so a dataset that feeds its
    own node AND several views opens/parses once instead of once per consumer (the per-node
    fan-out — and the same source fetched once per view — collapses to one request).

    One ``batch_cache`` is shared across every subset too, so a heavy upstream view feeding
    several siblings (e.g. the ``*_suggestions`` views) is computed once for the whole batch;
    unchanged subsets short-circuit off :data:`_VIEW_CACHE` entirely (rev-gated)."""
    settings = get_settings()
    if game not in list_profiles(settings.profiles_dir):
        raise HTTPException(status_code=404, detail=f"No profile {game!r}")
    profile = load_live_profile(settings.profiles_dir, game)

    store, fetch = _view_ctx(settings.data_dir, game, profile)
    vcache = get_view_cache(game)

    datasets: dict[str, dict] = {}
    for ds in dict.fromkeys(req.datasets):   # dedupe, keep order
        try:
            datasets[ds] = _detail(store(ds), ds)
        except Exception:
            continue   # a bad / disk-only id must not sink the rest of the batch

    batch_cache: dict = {}
    subsets: dict[str, dict] = {}
    for sid in dict.fromkeys(req.subsets):
        sub = profile.subset_def(sid)
        if sub is None:
            continue
        try:
            result = _cached_view(game, profile, sid, store, fetch, vcache, batch_cache)
            subsets[sid] = {"subset": sid, "datasets": sub.inputs(), **result}
        except Exception:
            continue
    vcache.save()   # one write for the whole batch, not one per subset
    return {"datasets": datasets, "subsets": subsets}
