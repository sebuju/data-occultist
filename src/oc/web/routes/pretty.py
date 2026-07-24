"""Pretty Studio endpoints: the design sidecar, transient node-input overrides, and a
manual dataset-record write (data entry from a Pretty form).

The design (``<game>.pretty.yaml``) is authored content and persists to disk. Overrides are
transient runtime values that affect the running profile but are never written to the
profile YAML — until an explicit ``commit`` bakes them in.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Body, Depends, HTTPException

from ...profile import list_profiles, load_profile, save_profile
from ...profile.pretty import load_pretty, save_pretty
from ...profile.pretty_repoint import repoint_pretty
from ...runtime import apply_overrides, clear_override, get_overrides, set_override
from ...store import store_for
from ..deps import get_settings
from ..sandbox import ensure_sandbox, sandbox_flag, wants_sandbox

router = APIRouter(prefix="/api/pretty", tags=["pretty"])


def _pdir(sbx: str | None) -> Path:
    """The real profiles_dir (via this module's OWN get_settings() call, so a test's
    ``monkeypatch.setattr("oc.web.routes.pretty.get_settings", ...)`` still applies), or
    its sandboxed copy when the request opted in."""
    real = get_settings().profiles_dir
    return ensure_sandbox(real) if wants_sandbox(sbx) else real


def _require_game(game: str, pdir: Path):
    if game not in list_profiles(pdir):
        raise HTTPException(status_code=404, detail=f"No profile {game!r}")


# ---- the design document ----------------------------------------------------------

@router.get("/{game}")
def get_pretty(game: str, sbx: str | None = Depends(sandbox_flag)):
    pdir = _pdir(sbx)
    _require_game(game, pdir)
    return load_pretty(pdir, game)


@router.put("/{game}")
def put_pretty(game: str, doc: dict = Body(...), sbx: str | None = Depends(sandbox_flag)):
    pdir = _pdir(sbx)
    _require_game(game, pdir)
    path = save_pretty(pdir, game, doc)
    return {"saved": str(path)}


@router.post("/{game}/repoint")
def repoint(game: str, body: dict = Body(...), sbx: str | None = Depends(sandbox_flag)):
    """Rewrite ``{{token}}`` references after a graph-node rename so Pretty tokens don't go
    stale. Body: ``{rewrites: [{kind, old, new, win?}]}``. Best-effort — a no-op (0 hits) never
    touches the file. Works even when Pretty was never opened this session (edits the doc on
    disk; a view switch reloads it)."""
    pdir = _pdir(sbx)
    _require_game(game, pdir)
    doc = load_pretty(pdir, game)
    n = repoint_pretty(doc, (body or {}).get("rewrites") or [])
    if n:
        save_pretty(pdir, game, doc)
    return {"repointed": n}


# ---- transient overrides ----------------------------------------------------------

@router.get("/{game}/overrides")
def list_overrides(game: str, sbx: str | None = Depends(sandbox_flag)):
    _require_game(game, _pdir(sbx))
    return {"overrides": get_overrides(game)}


@router.post("/{game}/override")
def post_override(game: str, body: dict = Body(...), sbx: str | None = Depends(sandbox_flag)):
    """Set one transient override. Body: ``{path, value}``. Takes effect on the running
    profile immediately (next load); never written to YAML."""
    _require_game(game, _pdir(sbx))
    path = (body or {}).get("path")
    if not path:
        raise HTTPException(status_code=400, detail="missing path")
    set_override(game, path, (body or {}).get("value"))
    return {"overrides": get_overrides(game)}


@router.delete("/{game}/override")
def delete_override(game: str, path: str | None = None, sbx: str | None = Depends(sandbox_flag)):
    """Clear one override (``?path=...``) or all of them (no path)."""
    _require_game(game, _pdir(sbx))
    clear_override(game, path)
    return {"overrides": get_overrides(game)}


@router.post("/{game}/overrides/commit")
def commit_overrides(game: str, sbx: str | None = Depends(sandbox_flag)):
    """Bake every active override into the authored profile YAML, then clear them. After
    this the values are normal authored config (no longer 'pretty dirty')."""
    pdir = _pdir(sbx)
    _require_game(game, pdir)
    ov = get_overrides(game)
    if not ov:
        return {"committed": 0}
    profile = load_profile(pdir, game)
    apply_overrides(profile, game)
    save_profile(pdir, profile)
    clear_override(game)   # now on disk -> no longer transient
    return {"committed": len(ov)}


# ---- manual dataset record (data entry) -------------------------------------------

@router.post("/{game}/dataset/{dataset}/record")
def record_row(game: str, dataset: str, values: dict = Body(...), sbx: str | None = Depends(sandbox_flag)):
    """Write one manual record into a dataset, keyed exactly as the collector would key it.
    Used by a Pretty data-entry form. Wrapped in its own batch so it is independently
    revertable from the node view's dataset history."""
    pdir = _pdir(sbx)
    _require_game(game, pdir)
    settings = get_settings()
    profile = load_profile(pdir, game)
    store = store_for(settings.data_dir, game, dataset, profile=profile)
    store.begin_batch()
    ev = store.record_seen({k: v for k, v in (values or {}).items()})
    store.save()
    return {"dataset": dataset, "written": bool(ev),
            "records": store.records(0), "batches": store.batches(80)}
