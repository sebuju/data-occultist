"""Profile CRUD endpoints for the teaching UI."""

from __future__ import annotations

from fastapi import APIRouter, Body, HTTPException

from ...profile import (
    GameProfile,
    backup_meta,
    backup_path,
    list_backups,
    list_profiles,
    load_graph_local,
    load_profile,
    read_backup,
    restore_backup,
    save_graph_local,
    save_profile,
)
from ...profile.merge import merge_profiles
from ..deps import get_settings

router = APIRouter(prefix="/api/profiles", tags=["profiles"])


@router.get("")
def all_profiles():
    return list_profiles(get_settings().profiles_dir)


@router.get("/{name}")
def get_profile(name: str):
    settings = get_settings()
    if name not in list_profiles(settings.profiles_dir):
        raise HTTPException(status_code=404, detail=f"No profile {name!r}")
    return load_profile(settings.profiles_dir, name).model_dump(mode="json", exclude_none=True)


@router.put("/{name}")
def put_profile(name: str, profile: GameProfile, merge: bool = True):
    """Save a profile. With ``merge`` (default), upsert the incoming window(s) and
    field(s) into the existing profile so other windows are preserved — this is how
    a game accumulates multiple windows authored one at a time."""
    if profile.name != name:
        raise HTTPException(status_code=400, detail="Body name must match URL name")
    settings = get_settings()
    if merge and name in list_profiles(settings.profiles_dir):
        profile = merge_profiles(load_profile(settings.profiles_dir, name), profile)
    path = save_profile(settings.profiles_dir, profile)
    return {"saved": str(path), "windows": [w.id for w in profile.windows]}


# ---- per-device graph-local state (viewport/minimap, gitignored sidecar) ---------

@router.get("/{name}/graphlocal")
def get_graphlocal(name: str):
    return load_graph_local(get_settings().profiles_dir, name)


@router.put("/{name}/graphlocal")
def put_graphlocal(name: str, state: dict = Body(...)):
    save_graph_local(get_settings().profiles_dir, name, state)
    return {"ok": True}


# ---- versioned backups -----------------------------------------------------------

@router.get("/{name}/backups")
def get_backups(name: str):
    """Snapshots for a profile, newest first, each with date + node/structural counts."""
    paths = list_backups(get_settings().profiles_dir, name)
    return [backup_meta(p) for p in reversed(paths)]


@router.get("/{name}/backups/{stamp}")
def get_backup(name: str, stamp: str):
    """The full backup profile (drives the preview render and restore)."""
    settings = get_settings()
    if not backup_path(settings.profiles_dir, name, stamp).exists():
        raise HTTPException(status_code=404, detail=f"No backup {stamp!r} for {name!r}")
    return read_backup(settings.profiles_dir, name, stamp).model_dump(mode="json", exclude_none=True)


@router.post("/{name}/backups/{stamp}/restore")
def post_restore_backup(name: str, stamp: str):
    """Load a backup as the new live profile (snapshotting the current state first).
    The chosen backup file is left intact."""
    settings = get_settings()
    if not backup_path(settings.profiles_dir, name, stamp).exists():
        raise HTTPException(status_code=404, detail=f"No backup {stamp!r} for {name!r}")
    profile = restore_backup(settings.profiles_dir, name, stamp)
    return profile.model_dump(mode="json", exclude_none=True)
