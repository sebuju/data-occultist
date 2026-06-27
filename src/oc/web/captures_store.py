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

# Live mode writes its frames into this sub-folder so they pile up separately from the
# hand-stashed captures (the top-level ``listing`` glob is non-recursive, so it never sees
# them). They get their own stats + clear, and a bulk delete reclaims the disk.
LIVE = "live"


def _safe(name: str) -> str:
    return _SAFE.sub("_", name)


def save(captures_dir: Path | str, game: str, data: bytes, clock=None, sub: str = "") -> str:
    """Save a JPEG under ``captures/<game>[/<sub>]/<stamp>.jpg`` and return its filename."""
    stamp = (clock or (lambda: datetime.now(timezone.utc)))().strftime("%Y%m%d-%H%M%S-%f")
    name = f"{stamp}.jpg"
    base = Path(captures_dir) / _safe(game)
    path = (base / _safe(sub) / name) if sub else (base / name)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return name


def listing(captures_dir: Path | str, game: str) -> list[str]:
    d = Path(captures_dir) / _safe(game)
    if not d.exists():
        return []
    return sorted((p.name for p in d.glob("*.jpg")), reverse=True)


def stats(captures_dir: Path | str, game: str, sub: str = "") -> dict:
    """{count, bytes} of the .jpg files in ``captures/<game>[/<sub>]/`` (non-recursive)."""
    base = Path(captures_dir) / _safe(game)
    d = (base / _safe(sub)) if sub else base
    count, nbytes = 0, 0
    if d.exists():
        for p in d.glob("*.jpg"):
            count += 1
            try:
                nbytes += p.stat().st_size
            except OSError:
                pass
    return {"count": count, "bytes": nbytes}


def clear(captures_dir: Path | str, game: str, sub: str = "") -> int:
    """Delete every .jpg in ``captures/<game>[/<sub>]/`` and return how many were removed."""
    base = Path(captures_dir) / _safe(game)
    d = (base / _safe(sub)) if sub else base
    removed = 0
    if d.exists():
        for p in d.glob("*.jpg"):
            try:
                p.unlink()
                removed += 1
            except OSError:
                pass
    return removed


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


def cutout_loader(captures_dir: Path | str, game: str):
    """Return ``name -> BGR ndarray | None`` for a game's frozen item cutouts — the loader
    that feeds template tells their reference sub-image (see ``items.item_templates``)."""
    import cv2

    def load(name: str):
        p = cutout_path(captures_dir, game, name)
        return cv2.imread(str(p)) if p else None

    return load


# ---- per-window stash bindings (which stash a window opens with) ----------

def _bindings_path(captures_dir: Path | str, game: str) -> Path:
    return Path(captures_dir) / _safe(game) / "_bindings.json"


def get_bindings(captures_dir: Path | str, game: str) -> dict:
    """Raw bindings map. A window's value is a LIST of capture names (the pages it shows),
    but legacy files store a bare string for a single binding — callers normalise with
    ``as_list``/``first`` so both shapes read the same."""
    p = _bindings_path(captures_dir, game)
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}


def as_list(value) -> list[str]:
    """A binding value (list, bare string, or missing) as a list of capture names."""
    if not value:
        return []
    return list(value) if isinstance(value, list) else [value]


def first(value) -> str | None:
    """The primary (page 0) capture of a binding value, or None when unbound."""
    names = as_list(value)
    return names[0] if names else None


def _write_bindings(captures_dir: Path | str, game: str, data: dict) -> None:
    p = _bindings_path(captures_dir, game)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, ensure_ascii=False, indent=0, sort_keys=True), encoding="utf-8")


def set_binding(captures_dir: Path | str, game: str, window: str, name: str) -> None:
    """Bind a window to a single stash (replacing any pages it had), or UNBIND it when
    ``name`` is empty (so a window can have no image — e.g. a freshly created one, which
    must not inherit a deleted window's binding)."""
    set_bindings(captures_dir, game, window, [name] if name else [])


def set_bindings(captures_dir: Path | str, game: str, window: str, names: list[str]) -> None:
    """Bind a window to an ordered list of stashes (its image pages), or UNBIND it when the
    list is empty. Blanks are dropped and order is preserved (it drives the page buttons)."""
    data = get_bindings(captures_dir, game)
    kept = [n for n in names if n]
    if kept:
        data[window] = kept
    else:
        data.pop(window, None)
    _write_bindings(captures_dir, game, data)
