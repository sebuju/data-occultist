"""Read/write game profiles as YAML on disk."""

from __future__ import annotations

from pathlib import Path

import yaml

from .models import GameProfile


def profile_path(profiles_dir: Path | str, name: str) -> Path:
    return Path(profiles_dir) / f"{name}.yaml"


def load_profile(profiles_dir: Path | str, name: str) -> GameProfile:
    path = profile_path(profiles_dir, name)
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
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
