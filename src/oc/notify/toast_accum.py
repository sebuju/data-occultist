"""Persistent tally behind an ACCUMULATING toast.

An accumulating toast node (``ToastDef.accumulate``) does not wipe to its latest render — it ADDS
each fire's body to a running list and shows the whole list, so e.g. a relic toast grows with every
screen seen instead of replacing. That list can't live in memory: each toast is posted by a
throwaway child process (see :mod:`oc.notify.windows_toast`) and the fire itself may come from any
thread. So the tally is a small JSON sidecar the SERVER owns — read, appended, capped, and written
here at spec-build time (``oc.collect.triggers.toast_spec``), never touching WinRT.

Each entry captures a fire's body: its rendered text blocks AND its inline images. The rich toasts
(the relic card) paint their data into an inline IMAGE, not text blocks, so an image tally is the
part that actually grows. A fire's inline image is snapshotted into the tally dir under a
content-hash name (so re-seeing the same screen reuses the same file and DEDUPS), and the entry
references it — the per-fire render path (overwritten each fire) can't be shared across entries.

Keyed by the toast's rendered ``replace_key`` (the same identity Windows replace-by-tag uses), one
JSON per key under ``<data_dir>/<game>/.toast_accum/`` (mirroring ``.toast_images``); snapshot PNGs
share that dir. Entries dedup by rendered content, the list is capped newest-wins (so the toast
can't outgrow Windows' small surface), and orphaned snapshots are pruned. Cleared on live-session
start so each session starts a fresh tally.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path


def _safe(key: str) -> str:
    """Filesystem-safe stem for a (possibly token-rendered) accumulator key."""
    return "".join(c if c.isalnum() or c in "-_" else "_" for c in key) or "_"


def _dir(data_dir, game: str) -> Path:
    return Path(data_dir) / str(game) / ".toast_accum"


def _path(data_dir, game: str, key: str) -> Path:
    return _dir(data_dir, game) / f"{_safe(key)}.json"


def _blocks_sig(blocks: list[dict]) -> str:
    return json.dumps([[b.get("content", ""), b.get("style", ""), b.get("align", "")]
                       for b in blocks], sort_keys=True)


def _entry_sig(entry: dict) -> str:
    """Dedup identity for one entry — its rendered text blocks plus its snapshot image names (the
    hash-named files, so identical content collapses)."""
    imgs = ",".join(sorted(Path(p).name for p in entry.get("images", [])))
    return _blocks_sig(entry.get("blocks", [])) + "|" + imgs


def load(data_dir, game: str, key: str) -> list[dict]:
    """The stored tally for ``key`` as a list of ``{blocks, images}`` entries, oldest first.
    ``[]`` when absent / unreadable."""
    p = _path(data_dir, game, key)
    if not p.exists():
        return []
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
        return d if isinstance(d, list) else []
    except (json.JSONDecodeError, OSError):
        return []


def append(data_dir, game: str, key: str, blocks: list[dict], images: list[str],
           cap: int) -> tuple[list[dict], list[str]]:
    """Append this fire's ``blocks`` + inline ``images`` to ``key``'s tally and return the FULL
    flattened ``(blocks, images)`` (oldest first) for the toast body. Each image is snapshotted into
    the tally dir under a content-hash name so it survives the next fire; the entry is deduped by
    content (a prior identical entry is dropped, the fresh one appended newest), the list capped to
    the last ``cap`` entries, and orphaned snapshots pruned. ``cap <= 0`` or an empty body is a
    no-op that still returns the current flattened tally."""
    d = _dir(data_dir, game)
    entries = load(data_dir, game, key)
    if (blocks or images) and cap > 0:
        snaps = [s for p in images if (s := _snapshot(d, p))]
        entry = {"blocks": blocks, "images": snaps}
        sig = _entry_sig(entry)
        entries = [e for e in entries if _entry_sig(e) != sig]
        entries.append(entry)
        if len(entries) > cap:
            entries = entries[-cap:]
        _save(data_dir, game, key, entries)
        _prune(d, entries)
    flat_blocks = [b for e in entries for b in e.get("blocks", [])]
    flat_images = [im for e in entries for im in e.get("images", [])]
    return flat_blocks, flat_images


def clear(data_dir, game: str, key: str | None = None) -> None:
    """Drop ``key``'s tally, or EVERY tally + snapshot for ``game`` when ``key`` is None
    (live-session start). Best-effort — a missing file / dir is fine."""
    d = _dir(data_dir, game)
    if key is not None:
        try:
            _path(data_dir, game, key).unlink()
        except OSError:
            pass
        return
    if not d.is_dir():
        return
    for f in list(d.glob("*.json")) + list(d.glob("img_*.png")):
        try:
            f.unlink()
        except OSError:
            pass


def _snapshot(d: Path, path: str) -> str | None:
    """Copy image ``path``'s bytes into the tally dir under a content-hash name (dedup + persist
    past the next fire's overwrite). Returns the absolute snapshot path, or None if unreadable."""
    try:
        data = Path(path).read_bytes()
    except OSError:
        return None
    h = hashlib.sha1(data).hexdigest()[:16]  # noqa: S324 - dedup identity, not crypto
    out = d / f"img_{h}.png"
    try:
        d.mkdir(parents=True, exist_ok=True)
        if not out.exists():
            out.write_bytes(data)
    except OSError:
        return None
    return str(out.resolve())


def _prune(d: Path, entries: list[dict]) -> None:
    """Delete snapshot PNGs no capped entry references any more (an evicted entry's image)."""
    keep = {Path(im).name for e in entries for im in e.get("images", [])}
    try:
        for f in d.glob("img_*.png"):
            if f.name not in keep:
                f.unlink()
    except OSError:
        pass


def _save(data_dir, game: str, key: str, entries: list[dict]) -> None:
    p = _path(data_dir, game, key)
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(entries), encoding="utf-8")
    except OSError:
        pass
