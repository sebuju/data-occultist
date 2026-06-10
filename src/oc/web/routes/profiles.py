"""Profile CRUD endpoints for the teaching UI."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from ...profile import GameProfile, list_profiles, load_profile, save_profile
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
