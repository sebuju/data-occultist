"""Read/write game profiles as YAML on disk.

This module is the single IO boundary for a profile, and it owns three on-disk
splits that keep the profile YAML small, safe, and versioned:

* **Backups** — a save snapshots the prior file to
  ``config/games/.backups/<name>/<stamp>.yaml`` only when something *structural*
  changed, and the write itself is atomic (temp + ``os.replace``) so a crash can never
  truncate a profile. Non-structural churn — node layout, box geometry (``x/y/w/h``),
  and UI view-state (``config_collapsed``/``hidden_columns``) — still persists to the
  live file but does NOT create a snapshot (see ``_structural``); it rides into the next
  structural snapshot instead. Snapshots are thinned by ``retention_keep`` (all of the
  last 48h, then daily for a month, then weekly) so the dir stays bounded forever.
* **Dictionaries** — a dictionary's terms live in ``config/dictionaries/<source>``,
  not inline in the profile. The loader fills ``DictionaryDef.terms`` from that file
  on load and writes it back on save; a missing file resolves to zero terms so the
  node survives as a bare reference.
* **Graph-local state** — the per-device viewport (zoom/pan, minimap) is a small
  gitignored JSON sidecar, not part of the profile.
"""

from __future__ import annotations

import json
import os
import re
import stat
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import yaml

from .models import DEFAULT_DETECT_THRESHOLD, GameProfile


def profile_path(profiles_dir: Path | str, name: str) -> Path:
    return Path(profiles_dir) / f"{name}.yaml"


def _atomic_write_text(path: Path, text: str) -> None:
    """Write ``text`` to ``path`` atomically: a sibling temp file then ``os.replace``
    (atomic on Windows and POSIX), so a reader never sees a half-written file and a
    crash mid-write can't truncate the original.

    On Windows the replace can transiently fail with ``PermissionError`` (WinError 5)
    when another process is holding the target for a moment — an editor, antivirus, or
    the dev server's ``--reload`` file watcher reading the file as it changes. Retry a
    few times with a short backoff, and clear a read-only attribute if that's the cause,
    rather than failing the whole save on a momentary lock."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")   # pid-scoped: concurrent saves don't clobber
    try:
        tmp.write_text(text, encoding="utf-8")
        delays = (0.05, 0.1, 0.2, 0.4, 0.0)   # ~0.75s total; last attempt re-raises
        for delay in delays:
            try:
                os.replace(tmp, path)
                return
            except PermissionError:
                if not delay:
                    raise
                if path.exists():
                    try:
                        os.chmod(path, stat.S_IWRITE)   # clear read-only if that's blocking it
                    except OSError:
                        pass
                time.sleep(delay)
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass


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


def _migrate_detect_thresholds(raw: dict) -> dict:
    """``DetectDef.threshold`` is now a required field (no baked-in default in the
    model — the UI seeds it from ``DEFAULT_DETECT_THRESHOLD`` at node creation). Older
    profiles that predate the UI always writing it would fail validation, so backfill
    any detector / state-detector missing ``threshold`` with the same default."""
    def _fix(dets) -> None:
        for d in dets or []:
            if isinstance(d, dict) and d.get("threshold") is None:
                d["threshold"] = DEFAULT_DETECT_THRESHOLD
    for w in raw.get("windows") or []:
        if not isinstance(w, dict):
            continue
        _fix(w.get("detect"))
        for s in w.get("states") or []:
            if isinstance(s, dict):
                _fix(s.get("detect"))
    return raw


# ---- dictionaries: terms live in their own files under config/dictionaries/ -------

def dictionaries_dir(profiles_dir: Path | str) -> Path:
    """Shared term-file directory, a sibling of the profiles dir (``config/games`` ->
    ``config/dictionaries``). Git-tracked: these are real content, not local cruft."""
    return Path(profiles_dir).parent / "dictionaries"


def _default_source(dct) -> str:
    """Filename for a dictionary that doesn't name one — a slug of its name/id."""
    base = (dct.name or dct.id or "dictionary").lower()
    slug = re.sub(r"[^a-z0-9._-]+", "_", base).strip("_") or "dictionary"
    return slug if slug.endswith(".txt") else f"{slug}.txt"


def read_dictionary(profiles_dir: Path | str, source: str) -> list[str]:
    """Terms from ``config/dictionaries/<source>`` (newline-delimited, trimmed, blanks
    dropped). A missing file returns ``[]`` — the dictionary node survives."""
    if not source:
        return []
    path = dictionaries_dir(profiles_dir) / source
    if not path.exists():
        return []
    return [ln.strip() for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip()]


def write_dictionary(profiles_dir: Path | str, source: str, terms: list[str]) -> None:
    """Persist ``terms`` to ``config/dictionaries/<source>`` atomically, but only when
    the content actually changed — so unrelated profile saves (node drags) never
    rewrite a 7000-line file."""
    if not source:
        return
    path = dictionaries_dir(profiles_dir) / source
    text = "\n".join(terms) + ("\n" if terms else "")
    if path.exists() and path.read_text(encoding="utf-8") == text:
        return
    _atomic_write_text(path, text)


def list_dictionaries(profiles_dir: Path | str) -> list[dict]:
    """Every term file under ``config/dictionaries/`` with its word count — the pool
    the teach UI's dictionary picker offers. Sorted by filename; missing dir -> []."""
    d = dictionaries_dir(profiles_dir)
    if not d.exists():
        return []
    out: list[dict] = []
    for p in sorted(d.glob("*.txt")):
        terms = [ln for ln in p.read_text(encoding="utf-8").splitlines() if ln.strip()]
        out.append({"source": p.name, "count": len(terms)})
    return out


def _resolve_dictionaries(profiles_dir: Path | str, profile: GameProfile) -> None:
    """Fill each dictionary's ``terms`` from its ``source`` file. A dict without a
    ``source`` gets a default one; if its term file exists we adopt it, otherwise we
    keep whatever inline terms the (legacy) profile carried so the next save can
    externalise them."""
    for d in profile.dictionaries:
        if not d.source:
            d.source = _default_source(d)
        path = dictionaries_dir(profiles_dir) / d.source
        if path.exists():
            d.terms = read_dictionary(profiles_dir, d.source)
        # else: keep inline terms (migration completes on next save)


def load_profile(profiles_dir: Path | str, name: str) -> GameProfile:
    path = profile_path(profiles_dir, name)
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    if isinstance(raw, dict):
        raw = _migrate_detect_thresholds(_migrate_keys(raw))
    profile = GameProfile.model_validate(raw)
    _resolve_dictionaries(profiles_dir, profile)
    return profile


def _profile_yaml(profile: GameProfile) -> str:
    """The on-disk YAML for a profile: full model dump minus the dictionary ``terms``
    (those live in their own files, written separately)."""
    data = profile.model_dump(mode="json", exclude_none=True)
    for d in data.get("dictionaries") or []:
        d.pop("terms", None)
    return yaml.safe_dump(data, sort_keys=False, allow_unicode=True)


# Keys whose churn is NOT structural: a save that touches only these makes no backup.
# ``layout`` is the whole top-level node-layout block; ``x/y/w/h`` are FractionBox
# geometry (drag/resize); ``config_collapsed``/``hidden_columns`` are UI view-state that
# leaks into the profile body. All of it still persists to the live file — it just
# rides into the next structural snapshot, exactly as node layout already did.
_NONSTRUCTURAL_KEYS = frozenset({"layout", "x", "y", "w", "h",
                                 "config_collapsed", "hidden_columns"})


def _strip_nonstructural(node):
    """Recursively drop ``_NONSTRUCTURAL_KEYS`` from a parsed-YAML tree."""
    if isinstance(node, dict):
        return {k: _strip_nonstructural(v) for k, v in node.items()
                if k not in _NONSTRUCTURAL_KEYS}
    if isinstance(node, list):
        return [_strip_nonstructural(v) for v in node]
    return node


def _structural(text: str) -> str:
    """``text`` re-dumped with all non-structural fields removed, so two profiles that
    differ ONLY in node layout / box geometry / UI view-state compare equal — such saves
    persist to disk but skip a snapshot."""
    raw = yaml.safe_load(text) or {}
    return yaml.safe_dump(_strip_nonstructural(raw), sort_keys=False, allow_unicode=True)


def save_profile(profiles_dir: Path | str, profile: GameProfile) -> Path:
    path = profile_path(profiles_dir, profile.name)
    path.parent.mkdir(parents=True, exist_ok=True)

    # Externalise dictionary terms first (deduped), so the YAML carries only references.
    for d in profile.dictionaries:
        if not d.source:
            d.source = _default_source(d)
        write_dictionary(profiles_dir, d.source, d.terms)

    text = _profile_yaml(profile)

    if path.exists():
        old = path.read_text(encoding="utf-8")
        if old == text:
            return path  # true no-op: nothing changed, don't churn a backup
        # Snapshot the prior version only when something structural changed.
        if _structural(old) != _structural(text):
            _snapshot(profiles_dir, profile.name, old)

    _atomic_write_text(path, text)
    return path


def list_profiles(profiles_dir: Path | str) -> list[str]:
    d = Path(profiles_dir)
    if not d.exists():
        return []
    return sorted(p.stem for p in d.glob("*.yaml"))


# ---- versioned backups -----------------------------------------------------------

def _backup_dir(profiles_dir: Path | str, name: str) -> Path:
    return Path(profiles_dir) / ".backups" / name


def backup_path(profiles_dir: Path | str, name: str, stamp: str) -> Path:
    return _backup_dir(profiles_dir, name) / f"{stamp}.yaml"


_STAMP_FMT = "%Y%m%d-%H%M%S-%f"


def retention_keep(stamps: list[str], now: datetime) -> set[str]:
    """Thinning policy for backup stamps (``%Y%m%d-%H%M%S-%f``, UTC). Returns the subset
    to KEEP; the caller deletes the rest. Dense recent, sparse old:

    * keep ALL snapshots from the last 48h (active authoring → fine-grained undo),
    * keep the newest one per calendar day for the prior 30 days,
    * keep the newest one per ISO week older than that.

    ``now`` is passed in (not read from the clock) so the policy is pure and testable.
    Unparseable stamps are kept (never silently delete something we don't understand)."""
    keep: set[str] = set()
    keep_buckets: set = set()
    # Newest first so the first stamp seen in each day/week bucket is the one we keep.
    for s in sorted(stamps, reverse=True):
        try:
            dt = datetime.strptime(s, _STAMP_FMT).replace(tzinfo=timezone.utc)
        except ValueError:
            keep.add(s)
            continue
        age = now - dt
        if age.total_seconds() <= 48 * 3600:
            keep.add(s)                       # all of the last 48h
            continue
        if age.days <= 30:
            bucket = ("D", dt.year, dt.month, dt.day)        # one per calendar day
        else:
            iso = dt.isocalendar()
            bucket = ("W", iso[0], iso[1])                   # one per ISO week
        if bucket not in keep_buckets:
            keep_buckets.add(bucket)
            keep.add(s)
    return keep


def _snapshot(profiles_dir: Path | str, name: str, text: str) -> Path:
    """Snapshot a profile's prior contents into the backup dir, stamped UTC, then thin
    the dir per ``retention_keep`` so it stays bounded."""
    # Windows' wall clock has ~15ms resolution, so two snapshots in quick succession can
    # produce an identical %f stamp; bump by a microsecond until the path is free so a
    # snapshot never silently overwrites another (the stamp stays parseable + sortable).
    now = datetime.now(timezone.utc)
    path = backup_path(profiles_dir, name, now.strftime(_STAMP_FMT))
    while path.exists():
        now += timedelta(microseconds=1)
        path = backup_path(profiles_dir, name, now.strftime(_STAMP_FMT))
    _atomic_write_text(path, text)
    _prune_backups(profiles_dir, name, datetime.now(timezone.utc))
    return path


def _prune_backups(profiles_dir: Path | str, name: str, now: datetime) -> None:
    """Delete snapshots outside the ``retention_keep`` policy."""
    d = _backup_dir(profiles_dir, name)
    if not d.exists():
        return
    files = list(d.glob("*.yaml"))
    keep = retention_keep([p.stem for p in files], now)
    for p in files:
        if p.stem not in keep:
            p.unlink(missing_ok=True)


def list_backups(profiles_dir: Path | str, name: str) -> list[Path]:
    """All snapshots for a profile, oldest first (the stamp sorts chronologically)."""
    d = _backup_dir(profiles_dir, name)
    if not d.exists():
        return []
    return sorted(d.glob("*.yaml"))


def backup_meta(path: Path) -> dict:
    """General info about a backup for the browser: timestamp + node/structural
    counts. ``nodes`` is the count of placed graph nodes (``layout.nodes``); the rest
    are structural counts of the profile body."""
    stamp = path.stem
    try:
        iso = datetime.strptime(stamp, "%Y%m%d-%H%M%S-%f").replace(tzinfo=timezone.utc).isoformat()
    except ValueError:
        iso = stamp
    raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    layout = raw.get("layout") or {}
    counts = {
        "nodes": len((layout.get("nodes") or {})),
        "windows": len(raw.get("windows") or []),
        "items": sum(len(w.get("items") or []) for w in (raw.get("windows") or [])),
        "datasets": len(raw.get("datasets") or []),
        "subsets": len(raw.get("subsets") or []),
        "price_nodes": len(raw.get("price_nodes") or []),
        "dictionaries": len(raw.get("dictionaries") or []),
    }
    return {"stamp": stamp, "iso": iso, "size": path.stat().st_size, "counts": counts}


def read_backup(profiles_dir: Path | str, name: str, stamp: str) -> GameProfile:
    """Parse a backup snapshot into a profile (terms resolved from the current
    dictionary files, same as a live load)."""
    path = backup_path(profiles_dir, name, stamp)
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    if isinstance(raw, dict):
        raw = _migrate_detect_thresholds(_migrate_keys(raw))
    profile = GameProfile.model_validate(raw)
    _resolve_dictionaries(profiles_dir, profile)
    return profile


def restore_backup(profiles_dir: Path | str, name: str, stamp: str) -> GameProfile:
    """Load a backup and re-save it as the live profile. This goes through
    ``save_profile``, so the CURRENT state is snapshotted first and the write is
    atomic; the chosen backup file is left untouched."""
    profile = read_backup(profiles_dir, name, stamp)
    save_profile(profiles_dir, profile)
    return profile


# ---- per-device graph-local state (gitignored sidecar) ---------------------------

def graph_local_path(profiles_dir: Path | str, name: str) -> Path:
    return Path(profiles_dir) / ".local" / f"{name}.json"


def load_graph_local(profiles_dir: Path | str, name: str) -> dict:
    """The viewport/minimap sidecar for a profile, or ``{}`` if none/unreadable."""
    path = graph_local_path(profiles_dir, name)
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, OSError):
        return {}


def save_graph_local(profiles_dir: Path | str, name: str, state: dict) -> Path:
    path = graph_local_path(profiles_dir, name)
    _atomic_write_text(path, json.dumps(state, indent=0))
    return path
