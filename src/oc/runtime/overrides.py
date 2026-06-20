"""Transient node-input overrides for Pretty Studio.

A value set through a Pretty control changes the **running** profile at once but is
**never** written to the authored ``<game>.yaml``. Those values live here — in process
memory, keyed by game then by a dotted path into the profile — and are layered onto every
freshly-loaded profile by :func:`load_live_profile`. They are transient by design: a server
restart drops them. The only way one reaches disk is an explicit user "save pretty to yaml"
(see :mod:`oc.web.routes.pretty`), which bakes the value into the profile and clears it here.

Path grammar (shared with the front-end ``pretty/overrides.js``): ``.``-separated segments,
where a segment is either a plain attribute (``interval_s``) or a list element addressed by
its ``id`` (``producers[p1]``). Examples::

    triggers[t1].interval_s
    producers[p1].throttle
    producers[p1].enabled
    windows[equipment].fields[name].min_confidence

A path that no longer resolves (the node was renamed/removed) is skipped, never an error —
a stale override must never break a profile load.
"""

from __future__ import annotations

import re
import threading
from pathlib import Path

from ..profile import load_profile
from ..profile.models import GameProfile

_lock = threading.Lock()
# game -> { dotted-path -> value }
_store: dict[str, dict[str, object]] = {}

_SEG = re.compile(r"^([A-Za-z_][\w]*)(?:\[(.+)\])?$")


def get_overrides(game: str) -> dict[str, object]:
    """A copy of every active override for ``game`` (``{}`` if none)."""
    with _lock:
        return dict(_store.get(game, {}))


def set_override(game: str, path: str, value: object) -> None:
    """Set (or replace) one override. ``value`` is stored verbatim; type coercion to the
    target attribute happens at apply time."""
    if not path:
        return
    with _lock:
        _store.setdefault(game, {})[path] = value


def clear_override(game: str, path: str | None = None) -> None:
    """Drop one override (``path`` given) or every override for the game (``path`` None)."""
    with _lock:
        if path is None:
            _store.pop(game, None)
        else:
            g = _store.get(game)
            if g is not None:
                g.pop(path, None)
                if not g:
                    _store.pop(game, None)


def all_games() -> list[str]:
    with _lock:
        return list(_store.keys())


# ---- path resolution + application -------------------------------------------------

def _descend(obj: object, name: str, key: str | None):
    """One path step: attribute ``name``, then — if ``key`` — index that list by ``.id``."""
    cur = getattr(obj, name)
    if key is not None:
        if not isinstance(cur, (list, tuple)):
            return None
        for el in cur:
            if str(getattr(el, "id", None)) == key:
                return el
        return None
    return cur


def _coerce(old: object, value: object) -> object:
    """Coerce ``value`` to the type of the attribute it replaces, so a string from JSON
    lands as the right Python type. Unknown/None target type -> value unchanged."""
    if isinstance(old, bool):
        if isinstance(value, str):
            return value.strip().lower() in ("1", "true", "yes", "on")
        return bool(value)
    if isinstance(old, int) and not isinstance(old, bool):
        try:
            return int(float(value))
        except (TypeError, ValueError):
            return old
    if isinstance(old, float):
        try:
            return float(value)
        except (TypeError, ValueError):
            return old
    if isinstance(old, str):
        return "" if value is None else str(value)
    return value


def _apply_one(profile: GameProfile, path: str, value: object) -> bool:
    segs = path.split(".")
    parent: object = profile
    for seg in segs[:-1]:
        m = _SEG.match(seg)
        if not m:
            return False
        parent = _descend(parent, m.group(1), m.group(2))
        if parent is None:
            return False
    m = _SEG.match(segs[-1])
    if not m or m.group(2) is not None:   # final segment must be a plain attribute
        return False
    name = m.group(1)
    if not hasattr(parent, name):
        return False
    try:
        setattr(parent, name, _coerce(getattr(parent, name), value))
    except (ValueError, TypeError):
        return False
    return True


def apply_overrides(profile: GameProfile, game: str) -> GameProfile:
    """Mutate ``profile`` in place with every active override for ``game``. Stale paths are
    skipped silently. Returns the same profile for chaining."""
    for path, value in get_overrides(game).items():
        try:
            _apply_one(profile, path, value)
        except Exception:  # noqa: BLE001 - one bad override must never break a load
            continue
    return profile


def load_live_profile(profiles_dir: Path | str, game: str) -> GameProfile:
    """Load ``game`` and layer its transient Pretty overrides on top. Use this anywhere a
    profile is loaded to be RUN (collection, pricing, triggers, preview); the editor's own
    load/save path keeps using the raw :func:`oc.profile.load_profile`."""
    profile = load_profile(profiles_dir, game)
    return apply_overrides(profile, game)
