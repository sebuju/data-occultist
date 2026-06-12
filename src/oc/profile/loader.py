"""Read/write game profiles as YAML on disk."""

from __future__ import annotations

from pathlib import Path

import yaml

from .models import GameProfile


def profile_path(profiles_dir: Path | str, name: str) -> Path:
    return Path(profiles_dir) / f"{name}.yaml"


def _migrate_keys(raw: dict) -> dict:
    """Older profiles keyed records on the dataset (``key_field`` + normalisation
    flags) or the scroll grid (``dedup_field``). Keys now live on the window/item
    that reads the records — synthesize an equivalent window ``key`` so old profiles
    keep deduping the same way. (``strip_nonalnum`` has no successor and is dropped.)"""
    ds_keys: dict[str, dict] = {}
    for d in raw.get("datasets") or []:
        if not isinstance(d, dict):
            continue
        kf = d.pop("key_field", None)
        d.pop("strip_nonalnum", None)
        case = bool(d.pop("case_sensitive", False))
        if kf or case:
            ds_keys[d.get("id")] = {"fields": [kf or "name"], "case_sensitive": case}
    for w in raw.get("windows") or []:
        if not isinstance(w, dict):
            continue
        sc = w.get("scroll")
        dedup = sc.pop("dedup_field", None) if isinstance(sc, dict) else None
        if w.get("key"):
            continue
        legacy = ds_keys.get(w.get("dataset") or w.get("id"))
        if legacy:
            w["key"] = dict(legacy)
        elif dedup and dedup != "name":
            w["key"] = {"fields": [dedup]}
    return raw


def load_profile(profiles_dir: Path | str, name: str) -> GameProfile:
    path = profile_path(profiles_dir, name)
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    if isinstance(raw, dict):
        raw = _migrate_keys(raw)
    return GameProfile.model_validate(raw)


def save_profile(profiles_dir: Path | str, profile: GameProfile) -> Path:
    path = profile_path(profiles_dir, profile.name)
    path.parent.mkdir(parents=True, exist_ok=True)
    data = profile.model_dump(mode="json", exclude_none=True)
    path.write_text(yaml.safe_dump(data, sort_keys=False, allow_unicode=True), encoding="utf-8")
    return path


def list_profiles(profiles_dir: Path | str) -> list[str]:
    d = Path(profiles_dir)
    if not d.exists():
        return []
    return sorted(p.stem for p in d.glob("*.yaml"))
