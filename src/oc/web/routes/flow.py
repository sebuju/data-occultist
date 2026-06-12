"""Dashboard endpoints: the window->dataset->records data flow."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from ...profile import list_profiles, load_profile
from ...store import KeySpec, inspect
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
    profile = load_profile(settings.profiles_dir, game)

    windows = []
    used_datasets = set()
    for w in profile.windows:
        used_datasets.add(w.dataset_id)
        windows.append({
            "id": w.id,
            "dataset": w.dataset_id,
            "key_fields": profile.key_map_for(w.dataset_id).fields_used(),
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


def _store(game: str, dataset: str) -> DatasetStore:
    settings = get_settings()
    profile = load_profile(settings.profiles_dir, game) if game in list_profiles(settings.profiles_dir) else None
    key = profile.key_map_for(dataset) if profile else KeySpec()
    agg = profile.aggregate_for(dataset) if profile else "latest"
    return DatasetStore(settings.data_dir, game, dataset, key=key, aggregate=agg)


def _detail(store: DatasetStore, dataset: str, limit: int = 0) -> dict:
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
    store = _store(game, dataset)
    store.clear_data()
    return _detail(store, dataset)


@router.post("/{game}/dataset/{dataset}/delete")
def delete_dataset_route(game: str, dataset: str):
    """Permanently delete a dataset's stored files (ledger + state). The profile def is
    removed separately by the UI; this stops the dataset re-spawning from disk."""
    from ...store.dataset_store import delete_dataset
    settings = get_settings()
    removed = delete_dataset(settings.data_dir, game, dataset)
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
    store.revert_batch(batch, on)
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


# ---- subsets: derived views over a dataset ---------------------------------

def _subset(game: str, subset: str):
    settings = get_settings()
    if game not in list_profiles(settings.profiles_dir):
        raise HTTPException(status_code=404, detail=f"No profile {game!r}")
    profile = load_profile(settings.profiles_dir, game)
    sub = profile.subset_def(subset)
    if sub is None:
        raise HTTPException(status_code=404, detail=f"No subset {subset!r}")
    return profile, sub


@router.get("/{game}/subset/{subset}")
def subset_view(game: str, subset: str):
    """Compute a view: outer-join its source datasets on the shared key, then filter +
    derive + sort. Recomputed from current records, so it tracks dataset updates."""
    from ...enrich.subset import compute_view
    _, sub = _subset(game, subset)
    inputs = [(ds, _store(game, ds).records()) for ds in sub.inputs()]
    result = compute_view(inputs, sub)
    return {"subset": subset, "datasets": sub.inputs(), **result}
