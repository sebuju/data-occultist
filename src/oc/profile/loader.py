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

import copy
import itertools
import json
import os
import re
import stat
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

import yaml

from .. import backup
from ..filelock import file_lock
from .models import DEFAULT_DETECT_THRESHOLD, GameProfile

# Re-exported for callers/tests that imported these from here before the stamp/list/prune
# machinery + thinning policy were hoisted into the shared snapshot module (oc.backup).
retention_keep = backup.retention_keep
_STAMP_FMT = backup.STAMP_FMT


def profile_path(profiles_dir: Path | str, name: str) -> Path:
    return Path(profiles_dir) / f"{name}.yaml"


_tmp_seq = itertools.count()   # per-call uniqueness for _atomic_write_text's temp filename

_save_locks: dict[str, threading.Lock] = {}
_save_locks_guard = threading.Lock()


@contextmanager
def profile_write_lock(profiles_dir: Path | str, name: str):
    """Serialize a profile's whole read-existing -> merge -> write cycle, so two overlapping
    saves (rapid UI edits each autosave a PUT) can't lost-update each other. Two layers, both
    needed: a per-name ``threading.Lock`` for the common case (FastAPI's sync routes run on a
    threadpool — two overlapping requests share ONE process), nested inside ``file_lock`` for
    the cross-process case (the desktop app + ``serve`` saving the same profile). ``file_lock``
    alone does NOT cover the first case: on Windows its msvcrt region lock is not reliably
    enforced between two handles opened by the SAME process."""
    with _save_locks_guard:
        lock = _save_locks.setdefault(name, threading.Lock())
    with lock, file_lock(profile_path(profiles_dir, name)):
        yield


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
    # pid+thread+counter scoped: a bare pid collides when the SAME process handles two
    # overlapping saves on different threadpool threads (every sync FastAPI route does) —
    # both would `write_text` the identical temp path and interleave, splicing one call's
    # leftover tail onto the other's shorter content before either `os.replace` ever runs.
    tmp = path.with_name(f"{path.name}.{os.getpid()}.{threading.get_ident()}.{next(_tmp_seq)}.tmp")
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


def _read_text_retry(path: Path) -> str:
    """Read a text file, retrying on a transient Windows ``PermissionError`` (WinError 5). A
    save's ``os.replace`` momentarily makes the target inaccessible, so a read that races a
    concurrent save (the profile is loaded fresh on many requests) can hit a sharing violation —
    the twin of the write-side retry above. Mirrors the same short backoff; the last attempt
    re-raises so a genuinely unreadable file still surfaces."""
    delays = (0.05, 0.1, 0.2, 0.4, 0.0)   # ~0.75s total; last attempt re-raises
    for delay in delays:
        try:
            return path.read_text(encoding="utf-8")
        except PermissionError:
            if not delay:
                raise
            time.sleep(delay)
    raise AssertionError("unreachable")   # the loop either returns or re-raises


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
    _fix(raw.get("detect"))   # game-level worthiness gate
    for w in raw.get("windows") or []:
        if not isinstance(w, dict):
            continue
        _fix(w.get("detect"))
        for s in w.get("states") or []:
            if isinstance(s, dict):
                _fix(s.get("detect"))
    return raw


def _migrate_readout_ids(raw: dict) -> dict:
    """Readouts used to carry an auto ``ro_N`` id PLUS a free-form ``name`` (the thing the UI
    edited and a trigger watched), unlike every other node whose id IS its authored string.
    Adopt each readout's ``name`` as its ``id`` and drop the split, repointing the references
    that keyed off the old id: ``{{ro_N}}`` tokens in a toast's title/message/attribution and
    each ``trigger.readout_watch`` entry. A blank/duplicate/unchanged name keeps the old id
    (only the dead ``name`` field is dropped). Idempotent — a nameless readout is untouched, so
    this no-ops on every load after the first save."""
    if not isinstance(raw, dict):
        return raw
    windows = raw.get("windows") or []
    taken = {v["id"] for w in windows for v in (w.get("readouts") or [])
             if isinstance(v, dict) and v.get("id")}   # every readout id in use (globally unique)
    renames: dict[str, str] = {}
    for w in windows:
        for v in (w.get("readouts") or []):
            if not isinstance(v, dict):
                continue
            nm, old = (v.get("name") or "").strip(), v.get("id")
            v.pop("name", None)   # the id/name split is gone regardless of the outcome
            if not nm or nm == old or nm in taken:
                continue
            taken.discard(old)
            taken.add(nm)
            v["id"] = nm
            renames[old] = nm
    if not renames:
        return raw
    tok = {old: re.compile(r"\{\{\s*" + re.escape(old) + r"\s*\}\}") for old in renames}
    for t in (raw.get("toasts") or []):
        if not isinstance(t, dict):
            continue
        for k in ("title", "message", "attribution"):
            s = t.get(k)
            if isinstance(s, str) and "{{" in s:
                for old, new in renames.items():
                    s = tok[old].sub("{{" + new + "}}", s)
                t[k] = s
    for t in (raw.get("triggers") or []):
        if isinstance(t, dict) and isinstance(t.get("readout_watch"), list):
            t["readout_watch"] = [renames.get(x, x) for x in t["readout_watch"]]
    return raw


def _migrate_join_exclude(raw: dict) -> dict:
    """``JoinSource.exclude: bool`` became ``mode: str`` (``join|exclude|mark|broadcast``) so a
    second and third "source combines specially" behavior could join the first instead of
    piling up parallel booleans. Fold the old flag in: ``exclude: true`` -> ``mode: "exclude"``,
    dropped otherwise (the model default ``mode: "join"`` already matches ``exclude: false``).
    Idempotent — a source with no ``exclude`` key, or one already carrying ``mode``, is
    untouched."""
    if not isinstance(raw, dict):
        return raw
    for sub in raw.get("subsets") or []:
        if not isinstance(sub, dict):
            continue
        for src in sub.get("sources") or []:
            if not isinstance(src, dict):
                continue
            was_excluded = src.pop("exclude", None)
            if was_excluded and "mode" not in src:
                src["mode"] = "exclude"
    return raw


def _split_shared_readout_fields(raw: dict) -> dict:
    """A front-end id-minting bug (fixed in ``model.js``) let a fresh readout's linked field id
    collide with an already-in-use one, so the client silently reused the existing ``FieldDef``
    instead of creating a new one — two readouts (or a readout and a region/item-field box) ended
    up sharing ONE field, incl. its ``rules`` pipeline. Editing/pasting rules on one readout then
    silently changed a sibling readout the user never touched. Heal it: a region/item-field always
    owns its field (its own id IS the field id); the first readout to reference a field keeps it;
    every later readout sharing that field id gets its own DEEP COPY appended to the window, with
    its ``field`` repointed. Idempotent — a window with no shared readout fields is untouched."""
    if not isinstance(raw, dict):
        return raw
    for w in (raw.get("windows") or []):
        if not isinstance(w, dict):
            continue
        fields = w.get("fields") or []
        by_id = {f["id"]: f for f in fields if isinstance(f, dict) and f.get("id")}
        claimed = {r["field"] for r in (w.get("regions") or [])
                   if isinstance(r, dict) and r.get("field")}
        claimed |= {itf["field"] for it in (w.get("items") or []) if isinstance(it, dict)
                    for itf in (it.get("fields") or []) if isinstance(itf, dict) and itf.get("field")}
        for v in (w.get("readouts") or []):
            if not isinstance(v, dict):
                continue
            fid = v.get("field")
            if not fid or fid not in by_id:
                continue
            if fid not in claimed:
                claimed.add(fid)
                continue
            n, new_id = 1, f"{fid}_split1"
            while new_id in by_id:
                n += 1
                new_id = f"{fid}_split{n}"
            clone = copy.deepcopy(by_id[fid])
            clone["id"] = new_id
            fields.append(clone)
            by_id[new_id] = clone
            v["field"] = new_id
            claimed.add(new_id)
        w["fields"] = fields
    return raw


def _migrate_dictionary_ids(raw: dict) -> dict:
    """Dictionaries carried an auto ``dict_N`` id PLUS a separate ``name`` (shown in the node
    while a field pinned the id) — the same split readouts had. Adopt each dictionary's ``name``
    as its ``id``, repointing every ``FieldDef.dictionary`` pin, and drop the split. A blank/
    duplicate/unchanged name keeps the id (only ``name`` is dropped); ``source`` (the term file)
    is left untouched. Idempotent — a nameless dictionary is a no-op."""
    if not isinstance(raw, dict):
        return raw
    dicts = raw.get("dictionaries") or []
    taken = {d["id"] for d in dicts if isinstance(d, dict) and d.get("id")}
    renames: dict[str, str] = {}
    for d in dicts:
        if not isinstance(d, dict):
            continue
        nm, old = (d.get("name") or "").strip(), d.get("id")
        d.pop("name", None)
        if not nm or nm == old or nm in taken:
            continue
        taken.discard(old)
        taken.add(nm)
        d["id"] = nm
        renames[old] = nm
    if not renames:
        return raw
    for w in (raw.get("windows") or []):
        for f in (w.get("fields") or []):
            if isinstance(f, dict) and f.get("dictionary") in renames:
                f["dictionary"] = renames[f["dictionary"]]
    return raw


def _migrate_glyph_node_id(raw: dict) -> dict:
    """The glyph atlas graph node was renamed ``"glyphs"`` -> ``"atlas"`` when it grew to teach
    both glyph- and symbol-kind cutouts. ``GameProfile.glyphs`` -> ``GameProfile.atlas`` is
    handled by a model validator, but the graph-layout node id is opaque UI data (a plain dict
    key), so repoint every place a layout references it by that literal string. Idempotent — a
    profile that never had the node, or already renamed it, is untouched."""
    if not isinstance(raw, dict):
        return raw
    layout = raw.get("layout")
    if not isinstance(layout, dict):
        return raw
    nodes = layout.get("nodes")
    if isinstance(nodes, dict) and "glyphs" in nodes and "atlas" not in nodes:
        nodes["atlas"] = nodes.pop("glyphs")
    imgs = layout.get("open_images")
    if isinstance(imgs, list):
        layout["open_images"] = ["atlas" if i == "glyphs" else i for i in imgs]
    for g in (layout.get("groups") or []):
        if isinstance(g, dict) and isinstance(g.get("members"), list):
            g["members"] = ["atlas" if m == "glyphs" else m for m in g["members"]]
    return raw


# ---- dictionaries: terms live in their own files under config/dictionaries/ -------

def dictionaries_dir(profiles_dir: Path | str) -> Path:
    """Shared term-file directory, a sibling of the profiles dir (``config/games`` ->
    ``config/dictionaries``). Git-tracked: these are real content, not local cruft."""
    return Path(profiles_dir).parent / "dictionaries"


def _default_source(dct) -> str:
    """Filename for a dictionary that doesn't name one — a slug of its id."""
    base = (dct.id or "dictionary").lower()
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
    clear_profile_cache()   # terms are resolved INTO profiles -> the YAML-mtime cache can't see this


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


# Parse cache: profiles are loaded fresh on MANY requests (clear, item read, price, …), each a
# disk read + YAML parse + model validation. Cache the parsed profile keyed by the file's
# (mtime_ns, size) — a cache hit happens ONLY when the file is byte-for-byte the same, so ANY
# write (our atomic os.replace, or an external edit) changes the signature and busts it on the
# very next load. No time-based staleness window. A cached profile is stored PRISTINE and every
# caller gets a deep copy, because consumers (apply_overrides, merge_profiles) mutate in place.
_profile_cache: dict[str, tuple[tuple[int, int], GameProfile]] = {}
_profile_cache_lock = threading.Lock()


def clear_profile_cache() -> None:
    """Drop the whole parse cache. Called when something changes a profile's INPUTS without
    touching its own YAML mtime — e.g. a dictionary file is rewritten (its terms are resolved
    INTO the profile), which the YAML signature alone can't see."""
    with _profile_cache_lock:
        _profile_cache.clear()


def load_profile(profiles_dir: Path | str, name: str) -> GameProfile:
    path = profile_path(profiles_dir, name)
    key = str(path)
    try:
        st = path.stat()
        sig: tuple[int, int] | None = (st.st_mtime_ns, st.st_size)
    except OSError:
        sig = None
    if sig is not None:
        with _profile_cache_lock:
            hit = _profile_cache.get(key)
        if hit is not None and hit[0] == sig:
            return hit[1].model_copy(deep=True)   # pristine cached -> own copy (callers mutate)
    raw = yaml.safe_load(_read_text_retry(path))
    if isinstance(raw, dict):
        raw = _migrate_glyph_node_id(_migrate_dictionary_ids(_split_shared_readout_fields(
            _migrate_join_exclude(_migrate_readout_ids(_migrate_detect_thresholds(_migrate_keys(raw)))))))
    profile = GameProfile.model_validate(raw)
    _resolve_dictionaries(profiles_dir, profile)
    if sig is not None:
        with _profile_cache_lock:
            _profile_cache[key] = (sig, profile)
    return profile.model_copy(deep=True)


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


def save_profile(profiles_dir: Path | str, profile: GameProfile, layout_only: bool = False) -> Path:
    """``layout_only`` marks a pure layout save (node positions/open-images — the graph
    editor's ``persist.layout()``, never a content edit). Such a save can never change
    dictionary terms or structure, so it skips two GIL-heavy full-profile YAML round-trips:
    the per-dictionary ``write_dictionary`` disk write and the ``_structural`` snapshot
    diff (which itself re-parses and re-dumps the whole profile twice). This is what keeps
    a boot-time reopened-image save from stalling concurrent requests behind it."""
    path = profile_path(profiles_dir, profile.name)
    path.parent.mkdir(parents=True, exist_ok=True)

    if not layout_only:
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
        # Snapshot the prior version only when something structural changed. A layout-only
        # save is non-structural by definition, so skip the diff (and its two extra
        # safe_load+safe_dump passes) entirely — never worth a backup.
        if not layout_only and _structural(old) != _structural(text):
            _snapshot(profiles_dir, profile.name, old)

    _atomic_write_text(path, text)
    return path


def list_profiles(profiles_dir: Path | str) -> list[str]:
    d = Path(profiles_dir)
    if not d.exists():
        return []
    # `<game>.pretty.yaml` is the pretty-layout sidecar, not a game profile -> skip it
    return sorted(p.stem for p in d.glob("*.yaml") if not p.name.endswith(".pretty.yaml"))


# ---- versioned backups -----------------------------------------------------------

def _backup_dir(profiles_dir: Path | str, name: str) -> Path:
    return Path(profiles_dir) / ".backups" / name


def backup_path(profiles_dir: Path | str, name: str, stamp: str) -> Path:
    return _backup_dir(profiles_dir, name) / f"{stamp}.yaml"


def _snapshot(profiles_dir: Path | str, name: str, text: str) -> Path:
    """Snapshot a profile's prior contents into the backup dir, stamped UTC, then thin
    the dir per the shared thinning policy so it stays bounded."""
    _, path = backup.new_stamp_path(_backup_dir(profiles_dir, name), "yaml",
                                    datetime.now(timezone.utc))
    _atomic_write_text(path, text)
    _prune_backups(profiles_dir, name, datetime.now(timezone.utc))
    return path


def _prune_backups(profiles_dir: Path | str, name: str, now: datetime) -> None:
    """Delete snapshots outside the ``retention_keep`` policy."""
    d = _backup_dir(profiles_dir, name)
    keep = backup.retention_keep([p.stem for p in backup.list_snapshots(d, "yaml")], now)
    backup.prune(d, "yaml", keep)


def list_backups(profiles_dir: Path | str, name: str) -> list[Path]:
    """All snapshots for a profile, oldest first (the stamp sorts chronologically)."""
    return backup.list_snapshots(_backup_dir(profiles_dir, name), "yaml")


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
        "producers": len(raw.get("producers") or []),
        "dictionaries": len(raw.get("dictionaries") or []),
    }
    return {"stamp": stamp, "iso": iso, "size": path.stat().st_size, "counts": counts}


def read_backup(profiles_dir: Path | str, name: str, stamp: str) -> GameProfile:
    """Parse a backup snapshot into a profile (terms resolved from the current
    dictionary files, same as a live load)."""
    path = backup_path(profiles_dir, name, stamp)
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    if isinstance(raw, dict):
        raw = _migrate_glyph_node_id(_migrate_dictionary_ids(_split_shared_readout_fields(
            _migrate_readout_ids(_migrate_detect_thresholds(_migrate_keys(raw))))))
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
