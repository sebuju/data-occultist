"""Persist teaching captures so a past screenshot can be reloaded for box tuning.

Stashed under ``captures/<game>/<timestamp>.jpg``. The teaching UI can list and
reselect them, so you can refine boxes against an old capture without the game
being on that screen.

Live mode's frames go one level deeper — ``captures/<game>/live/<session>/<timestamp>.jpg`` —
so each live-capture start is its own browsable, replayable, individually-deletable recording
(see the ``live_*`` helpers below and :mod:`oc.web.live_sessions`, which decides which session
a save belongs to).
"""

from __future__ import annotations

import json
import re
import shutil
import threading
from datetime import datetime, timezone
from pathlib import Path

_SAFE = re.compile(r"[^A-Za-z0-9._-]")

# Live mode writes its frames into this sub-folder so they pile up separately from the
# hand-stashed captures (the top-level ``listing`` glob is non-recursive, so it never sees
# them). They get their own stats + clear, and a bulk delete reclaims the disk.
LIVE = "live"


def _safe(name: str) -> str:
    return _SAFE.sub("_", name)


_id_lock = threading.Lock()
_last_session_id = ""


def new_session_id(clock=None) -> str:
    """Id for a fresh live session — the capture stamp of its start (same scheme as precapture's
    sessions). The Windows clock only ticks every ~1-16 ms, so two sessions started back to back
    read the SAME microsecond stamp; bump past the last id issued so ids stay unique and still
    sort chronologically (two runs must never share a folder)."""
    global _last_session_id
    sid = (clock or (lambda: datetime.now(timezone.utc)))().strftime("%Y%m%d-%H%M%S-%f")
    with _id_lock:
        if sid <= _last_session_id:
            stem, us = _last_session_id.rsplit("-", 1)
            sid = f"{stem}-{int(us) + 1:06d}"
        _last_session_id = sid
    return sid


def save(captures_dir: Path | str, game: str, data: bytes, clock=None) -> str:
    """Save a JPEG under ``captures/<game>/<stamp>.jpg`` and return its filename."""
    stamp = (clock or (lambda: datetime.now(timezone.utc)))().strftime("%Y%m%d-%H%M%S-%f")
    name = f"{stamp}.jpg"
    path = Path(captures_dir) / _safe(game) / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return name


def listing(captures_dir: Path | str, game: str) -> list[str]:
    """Filenames of the .jpg files in ``captures/<game>/`` (non-recursive), newest first. The
    live bucket is a sub-folder, so it never shows up here — see :func:`live_listing`."""
    d = Path(captures_dir) / _safe(game)
    if not d.exists():
        return []
    return sorted((p.name for p in d.glob("*.jpg")), reverse=True)


def stats(captures_dir: Path | str, game: str) -> dict:
    """{count, bytes} of the .jpg files in ``captures/<game>/`` (non-recursive)."""
    return _dir_stats(Path(captures_dir) / _safe(game))


def _dir_stats(d: Path) -> dict:
    count, nbytes = 0, 0
    if d.exists():
        for p in d.glob("*.jpg"):
            count += 1
            try:
                nbytes += p.stat().st_size
            except OSError:
                pass
    return {"count": count, "bytes": nbytes}


def clear(captures_dir: Path | str, game: str) -> int:
    """Delete every .jpg in ``captures/<game>/`` and return how many were removed."""
    d = Path(captures_dir) / _safe(game)
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
    if not _bare(name):
        return None
    p = Path(captures_dir) / _safe(game) / name
    return p if p.exists() else None


def _bare(name: str) -> bool:
    """True when ``name`` is a plain filename — no separators, no parent hops."""
    return bool(name) and "/" not in name and "\\" not in name and ".." not in name


# ---- live sessions (one folder per live-capture start) --------------------

def _live_base(captures_dir: Path | str, game: str) -> Path:
    return Path(captures_dir) / _safe(game) / LIVE


def _live_dir(captures_dir: Path | str, game: str, session: str) -> Path:
    return _live_base(captures_dir, game) / _safe(session)


def _live_session_dirs(captures_dir: Path | str, game: str) -> list[Path]:
    try:
        return [p for p in _live_base(captures_dir, game).iterdir() if p.is_dir()]
    except OSError:
        return []


def _stamp_of(name: str) -> datetime | None:
    """Capture time out of a ``%Y%m%d-%H%M%S-%f.jpg`` filename, or None for a stray file."""
    try:
        return datetime.strptime(Path(name).stem, "%Y%m%d-%H%M%S-%f")
    except ValueError:
        return None


def save_live(captures_dir: Path | str, game: str, data: bytes, session: str, clock=None) -> str:
    """Save a live frame under ``captures/<game>/live/<session>/<stamp>.jpg``. The session folder
    is created HERE, on the first actual write — a live start that never captures anything leaves
    no empty folder behind."""
    stamp = (clock or (lambda: datetime.now(timezone.utc)))().strftime("%Y%m%d-%H%M%S-%f")
    name = f"{stamp}.jpg"
    d = _live_dir(captures_dir, game, session)
    d.mkdir(parents=True, exist_ok=True)
    (d / name).write_bytes(data)
    return name


def live_listing(captures_dir: Path | str, game: str, session: str) -> list[str]:
    """Filenames in one live session, newest first."""
    d = _live_dir(captures_dir, game, session)
    if not d.exists():
        return []
    return sorted((p.name for p in d.glob("*.jpg")), reverse=True)


def list_live_sessions(captures_dir: Path | str, game: str) -> list[dict]:
    """Every saved live session, newest first:
    ``{id, label, count, bytes, first, last, span}`` — ``first``/``last`` are the session's
    oldest/newest capture stamps (ISO) and ``span`` their gap in seconds, i.e. how long the
    recording runs (what the feed dropdown shows next to the image count)."""
    migrate_flat_live(captures_dir, game)
    out = []
    for d in _live_session_dirs(captures_dir, game):
        stamps, nbytes, count = [], 0, 0
        try:
            for p in d.glob("*.jpg"):
                count += 1
                ts = _stamp_of(p.name)
                if ts is not None:
                    stamps.append(ts)
                try:
                    nbytes += p.stat().st_size
                except OSError:
                    pass
        except OSError:
            continue
        if not count:      # an empty leftover folder is not a recording
            continue
        first, last = (min(stamps), max(stamps)) if stamps else (None, None)
        out.append({
            "id": d.name, "label": _read_meta(d).get("label", ""),
            "count": count, "bytes": nbytes,
            "first": first.isoformat() if first else None,
            "last": last.isoformat() if last else None,
            "span": (last - first).total_seconds() if first and last else 0.0,
        })
    out.sort(key=lambda s: s["id"], reverse=True)
    return out


def newest_live_session(captures_dir: Path | str, game: str) -> str | None:
    """Id of the most recent non-empty live session, or None when nothing is saved."""
    sessions = list_live_sessions(captures_dir, game)
    return sessions[0]["id"] if sessions else None


def live_stats(captures_dir: Path | str, game: str, session: str | None = None) -> dict:
    """``{count, bytes, sessions}`` for one live session, or summed across ALL of them when
    ``session`` is None (the live panel's saved-image stat line)."""
    if session:
        st = _dir_stats(_live_dir(captures_dir, game, session))
        st["sessions"] = 1 if st["count"] else 0
        return st
    sessions = list_live_sessions(captures_dir, game)
    return {
        "count": sum(s["count"] for s in sessions),
        "bytes": sum(s["bytes"] for s in sessions),
        "sessions": len(sessions),
    }


def live_clear(captures_dir: Path | str, game: str, session: str | None = None) -> int:
    """Delete one live session's folder, or every session when ``session`` is None. Returns how
    many sessions were removed."""
    dirs = ([_live_dir(captures_dir, game, session)] if session
            else _live_session_dirs(captures_dir, game))
    removed = 0
    for d in dirs:
        if d.is_dir():
            shutil.rmtree(d, ignore_errors=True)
            removed += 1
    return removed


def live_path_for(captures_dir: Path | str, game: str, session: str, name: str) -> Path | None:
    if not _bare(name) or not _bare(session):
        return None
    p = _live_dir(captures_dir, game, session) / name
    return p if p.exists() else None


def promote_live(captures_dir: Path | str, game: str, session: str, name: str) -> str | None:
    """Copy a live image up into the top-level (permanent) captures folder so it survives a
    live flush. Returns the (unchanged) filename, or None if the source is missing. Idempotent
    — if a top-level file of that name already exists it's left as-is."""
    src = live_path_for(captures_dir, game, session, name)
    if src is None:
        return None
    dst = Path(captures_dir) / _safe(game) / src.name
    if not dst.exists():
        shutil.copy2(src, dst)
    return src.name


def _meta_path(d: Path) -> Path:
    return d / "meta.json"


def _read_meta(d: Path) -> dict:
    try:
        return json.loads(_meta_path(d).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def migrate_flat_live(captures_dir: Path | str, game: str) -> str | None:
    """Fold a pre-sessions flat ``live/*.jpg`` bucket into one session labelled ``recovered``.
    Idempotent (a no-op once the bucket holds only folders) and cheap — one non-recursive glob.
    Returns the new session id, or None when there was nothing to migrate."""
    base = _live_base(captures_dir, game)
    try:
        flat = sorted(base.glob("*.jpg"))
    except OSError:
        return None
    if not flat:
        return None
    # name the session after the OLDEST frame so it sorts into the timeline where it belongs
    sid = Path(flat[0]).stem if _stamp_of(flat[0].name) else new_session_id()
    dst = base / _safe(sid)
    try:
        dst.mkdir(parents=True, exist_ok=True)
        for f in flat:
            f.replace(dst / f.name)
        _meta_path(dst).write_text(
            json.dumps({"created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                        "label": "recovered"}), encoding="utf-8")
    except OSError:
        return None
    return sid


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


# ---- taught cutout atlas (reference glyph/symbol crops) --------------------

def save_atlas_cutout(captures_dir: Path | str, game: str, data: bytes, clock=None) -> str:
    """Save a taught cutout PNG under ``captures/<game>/atlas/`` and return its name."""
    stamp = (clock or (lambda: datetime.now(timezone.utc)))().strftime("%Y%m%d-%H%M%S-%f")
    name = f"cutout-{stamp}.png"
    path = Path(captures_dir) / _safe(game) / "atlas" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return name


def atlas_path(captures_dir: Path | str, game: str, name: str) -> Path | None:
    """Look under the current ``atlas/`` dir first, then the legacy ``glyphs/`` dir (pre-
    unification profiles reference glyph PNGs there and are never moved on migration)."""
    if "/" in name or "\\" in name or ".." in name:
        return None
    base = Path(captures_dir) / _safe(game)
    for sub in ("atlas", "glyphs"):
        p = base / sub / name
        if p.exists():
            return p
    return None


def atlas_loader(captures_dir: Path | str, game: str):
    """Return ``name -> BGR ndarray | None`` for a game's taught atlas crops — feeds the
    AtlasMatcher its reference glyph/symbol images (see ``collect.atlas_match.build_atlas``)."""
    import cv2

    def load(name: str):
        p = atlas_path(captures_dir, game, name)
        return cv2.imread(str(p)) if p else None

    return load


# ---- scroll-calibration cutouts (scrollbar crop at a known scroll position) ------

def save_scroll_cutout(captures_dir: Path | str, game: str, data: bytes, clock=None) -> str:
    """Save a scroll-calibration cutout PNG under ``captures/<game>/scroll/`` and return its
    name. These back ``ScrollSample.file`` — display-only after the thumb ``pos`` is read at
    capture time, so unlike atlas cutouts they need no loader (nothing decodes them at read
    time)."""
    stamp = (clock or (lambda: datetime.now(timezone.utc)))().strftime("%Y%m%d-%H%M%S-%f")
    name = f"scroll-{stamp}.png"
    path = Path(captures_dir) / _safe(game) / "scroll" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return name


def scroll_path(captures_dir: Path | str, game: str, name: str) -> Path | None:
    if "/" in name or "\\" in name or ".." in name:
        return None
    p = Path(captures_dir) / _safe(game) / "scroll" / name
    return p if p.exists() else None


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
