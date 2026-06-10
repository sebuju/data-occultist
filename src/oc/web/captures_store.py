"""Persist teaching captures so a past screenshot can be reloaded for box tuning.

Stashed under ``captures/<game>/<timestamp>.jpg``. The teaching UI can list and
reselect them, so you can refine boxes against an old capture without the game
being on that screen.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path

_SAFE = re.compile(r"[^A-Za-z0-9._-]")


def _safe(name: str) -> str:
    return _SAFE.sub("_", name)


def save(captures_dir: Path | str, game: str, data: bytes, clock=None) -> str:
    stamp = (clock or (lambda: datetime.now(timezone.utc)))().strftime("%Y%m%d-%H%M%S-%f")
    name = f"{stamp}.jpg"
    path = Path(captures_dir) / _safe(game) / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return name


def listing(captures_dir: Path | str, game: str) -> list[str]:
    d = Path(captures_dir) / _safe(game)
    if not d.exists():
        return []
    return sorted((p.name for p in d.glob("*.jpg")), reverse=True)


def path_for(captures_dir: Path | str, game: str, name: str) -> Path | None:
    # Guard against traversal: only a bare filename in the game's folder.
    if "/" in name or "\\" in name or ".." in name:
        return None
    p = Path(captures_dir) / _safe(game) / name
    return p if p.exists() else None


# ---- frozen item cutouts (the item template's saved image) ----------------

def save_cutout(captures_dir: Path | str, game: str, data: bytes, clock=None) -> str:
    """Save a frozen item-cell PNG under ``captures/<game>/items/`` and return its name."""
    stamp = (clock or (lambda: datetime.now(timezone.utc)))().strftime("%Y%m%d-%H%M%S-%f")
    name = f"item-{stamp}.png"
    path = Path(captures_dir) / _safe(game) / "items" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return name


def cutout_path(captures_dir: Path | str, game: str, name: str) -> Path | None:
    if "/" in name or "\\" in name or ".." in name:
        return None
    p = Path(captures_dir) / _safe(game) / "items" / name
    return p if p.exists() else None


# ---- per-window stash bindings (which stash a window opens with) ----------

def _bindings_path(captures_dir: Path | str, game: str) -> Path:
    return Path(captures_dir) / _safe(game) / "_bindings.json"


def get_bindings(captures_dir: Path | str, game: str) -> dict:
    p = _bindings_path(captures_dir, game)
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}


def set_binding(captures_dir: Path | str, game: str, window: str, name: str) -> None:
    p = _bindings_path(captures_dir, game)
    p.parent.mkdir(parents=True, exist_ok=True)
    data = get_bindings(captures_dir, game)
    data[window] = name
    p.write_text(json.dumps(data, ensure_ascii=False, indent=0, sort_keys=True), encoding="utf-8")
