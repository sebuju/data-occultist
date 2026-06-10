"""Dashboard endpoints: the window->dataset->records data flow."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from ...profile import list_profiles, load_profile
from ...store import inspect
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
            "fields": sorted({r.field for r in w.regions}),
            "regions": len(w.regions),
            "anchors": len(w.anchors),
            "states": [s.id for s in w.states],
            "save_states": [s.id for s in w.states if s.valid_for_save],
        })

    # Datasets from the profile plus any already on disk. The dataset (not the window)
    # owns the dedup key, so it's reported here.
    names = sorted(used_datasets | set(inspect.list_datasets(settings.data_dir, game)))
    datasets = []
    for n in names:
        summary = inspect.summarize(settings.data_dir, game, n)
        summary["key_field"] = profile.key_for(n)
        datasets.append(summary)
    return {"game": game, "windows": windows, "datasets": datasets}


@router.get("/{game}/dataset/{dataset}")
def dataset_detail(game: str, dataset: str, limit: int = 200, history: int = 50):
    settings = get_settings()
    return {
        "dataset": dataset,
        "records": inspect.records(settings.data_dir, game, dataset, limit),
        "history": inspect.history(settings.data_dir, game, dataset, history),
    }


@router.post("/{game}/dataset/{dataset}/revert")
def revert_event(game: str, dataset: str, event: int, on: bool = True):
    """Revert (``on=true``) or un-revert one ledger event, falling the affected record
    back to its previous accepted value. Returns the refreshed detail."""
    settings = get_settings()
    profile = load_profile(settings.profiles_dir, game) if game in list_profiles(settings.profiles_dir) else None
    key = profile.key_for(dataset) if profile else "name"
    store = DatasetStore(settings.data_dir, game, dataset, key_field=key)
    store.set_reverted(event, on)
    return {
        "dataset": dataset,
        "records": store.records(limit=200),
        "history": store.history(50),
    }
