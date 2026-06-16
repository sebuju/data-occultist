"""Pretty Studio endpoints: the design sidecar, transient node-input overrides, and a
manual dataset-record write (data entry from a Pretty form).

The design (``<game>.pretty.yaml``) is authored content and persists to disk. Overrides are
transient runtime values that affect the running profile but are never written to the
profile YAML — until an explicit ``commit`` bakes them in.
"""

from __future__ import annotations

from fastapi import APIRouter, Body, HTTPException

from ...profile import list_profiles, load_profile, save_profile
from ...profile.pretty import load_pretty, save_pretty
from ...runtime import apply_overrides, clear_override, get_overrides, set_override
from ...store import KeySpec
from ...store.dataset_store import DatasetStore
from ..deps import get_settings

router = APIRouter(prefix="/api/pretty", tags=["pretty"])


def _require_game(game: str):
    settings = get_settings()
    if game not in list_profiles(settings.profiles_dir):
        raise HTTPException(status_code=404, detail=f"No profile {game!r}")
    return settings


# ---- the design document ----------------------------------------------------------

@router.get("/{game}")
def get_pretty(game: str):
    settings = _require_game(game)
    return load_pretty(settings.profiles_dir, game)


@router.put("/{game}")
def put_pretty(game: str, doc: dict = Body(...)):
    settings = _require_game(game)
    path = save_pretty(settings.profiles_dir, game, doc)
    return {"saved": str(path)}


# ---- transient overrides ----------------------------------------------------------

@router.get("/{game}/overrides")
def list_overrides(game: str):
    _require_game(game)
    return {"overrides": get_overrides(game)}


@router.post("/{game}/override")
def post_override(game: str, body: dict = Body(...)):
    """Set one transient override. Body: ``{path, value}``. Takes effect on the running
    profile immediately (next load); never written to YAML."""
    _require_game(game)
    path = (body or {}).get("path")
    if not path:
        raise HTTPException(status_code=400, detail="missing path")
    set_override(game, path, (body or {}).get("value"))
    return {"overrides": get_overrides(game)}


@router.delete("/{game}/override")
def delete_override(game: str, path: str | None = None):
    """Clear one override (``?path=...``) or all of them (no path)."""
    _require_game(game)
    clear_override(game, path)
    return {"overrides": get_overrides(game)}


@router.post("/{game}/overrides/commit")
def commit_overrides(game: str):
    """Bake every active override into the authored profile YAML, then clear them. After
    this the values are normal authored config (no longer 'pretty dirty')."""
    settings = _require_game(game)
    ov = get_overrides(game)
    if not ov:
        return {"committed": 0}
    profile = load_profile(settings.profiles_dir, game)
    apply_overrides(profile, game)
    save_profile(settings.profiles_dir, profile)
    clear_override(game)   # now on disk -> no longer transient
    return {"committed": len(ov)}


# ---- manual dataset record (data entry) -------------------------------------------

@router.post("/{game}/dataset/{dataset}/record")
def record_row(game: str, dataset: str, values: dict = Body(...)):
    """Write one manual record into a dataset, keyed exactly as the collector would key it.
    Used by a Pretty data-entry form. Wrapped in its own batch so it is independently
    revertable from the node view's dataset history."""
    settings = _require_game(game)
    profile = load_profile(settings.profiles_dir, game)
    key = profile.key_map_for(dataset) if profile else KeySpec()
    agg = profile.aggregate_for(dataset) if profile else "latest"
    store = DatasetStore(settings.data_dir, game, dataset, key=key, aggregate=agg)
    store.begin_batch()
    ev = store.record_seen({k: v for k, v in (values or {}).items()})
    store.save()
    return {"dataset": dataset, "written": bool(ev),
            "records": store.records(0), "batches": store.batches(80)}
