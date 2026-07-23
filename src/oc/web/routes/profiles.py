"""Profile CRUD endpoints for the teaching UI."""

from __future__ import annotations

import time

from fastapi import APIRouter, Body, Header, HTTPException
from fastapi.responses import JSONResponse

from ...eventlog import publish as logev

from ...profile import (
    GameProfile,
    backup_meta,
    backup_path,
    list_backups,
    list_profiles,
    load_graph_local,
    load_profile,
    profile_signature,
    profile_write_lock,
    read_backup,
    restore_backup,
    save_graph_local,
    save_profile,
    structural_yaml,
)
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
    body = load_profile(settings.profiles_dir, name).model_dump(mode="json", exclude_none=True)
    # Tag the response with a structural fingerprint (stale-tab save guard): the client
    # remembers this ETag and sends it back as If-Match on save, so a save that would
    # clobber a change made elsewhere since this GET gets rejected (409) instead of
    # silently overwriting it. Hashing the STRUCTURAL text (not the raw bytes) means a
    # pure layout/geometry save from another tab never trips a false conflict.
    sig = profile_signature(settings.profiles_dir, name)
    headers = {"ETag": f'"{sig["token"]}"', "X-Profile-Modified": sig["modified"]} if sig else {}
    return JSONResponse(body, headers=headers)


def _preserve_producer_http(existing, incoming) -> None:
    """Anti-data-loss: a save must never silently drop a producer's authored ``http`` spec
    (URL + headers + mapping). If an ``http``-type producer arrives with no ``http`` — a
    stale/partial client that lost the block — keep the on-disk spec instead of nuking it.
    (Deliberately clearing it means switching the node's ``type``, not blanking ``http``.)"""
    if existing is None:
        return
    prev = {p.id: p for p in existing.producers}
    for p in incoming.producers:
        if getattr(p, "type", "") == "http" and p.http is None:
            old = prev.get(p.id)
            if old is not None and old.http is not None:
                p.http = old.http


@router.put("/{name}")
def put_profile(
    name: str,
    profile: GameProfile,
    merge: bool = True,
    layout: bool = False,
    if_match: str | None = Header(None, alias="If-Match"),
):
    """Save a profile. With ``merge`` (default), upsert the incoming window(s) and
    field(s) into the existing profile so other windows are preserved — this is how
    a game accumulates multiple windows authored one at a time.

    ``layout`` marks a pure layout save (node positions/open-images, no content change —
    the graph editor's ``persist.layout()``): it skips the dictionary-feed re-pull (feeds
    only change on content edits) and tells :func:`save_profile` to skip its structural-
    snapshot diff, since a layout-only save is never structural.

    ``If-Match`` is the stale-tab save guard (paired with the ETag on GET): if present
    and it no longer matches the on-disk structural token — someone else saved a
    structural change since this tab loaded — the save is REJECTED with 409 instead of
    silently clobbering it, and the response carries both YAMLs + timestamps so the
    client can render a side-by-side conflict modal. No ``If-Match`` (a first-ever save,
    or the modal's own "overwrite" action) always writes unconditionally."""
    if profile.name != name:
        raise HTTPException(status_code=400, detail="Body name must match URL name")
    settings = get_settings()
    # Phase wall-clocks for the slow-save warn below — a save that blocks (GIL contention from
    # OCR/toast work, a lock wait, a Windows sharing-violation retry) shows WHERE it blocked
    # instead of just feeling slow in the UI.
    t0 = time.perf_counter()
    # The read (existing) -> merge -> write is a read-modify-write: two overlapping autosaves
    # (rapid edits fire a PUT each) would otherwise race and the later write silently drops
    # whatever the other one added (lost update) — same failure class the OCR cache already
    # locks against. A cross-process lock on the profile file serializes the whole cycle.
    with profile_write_lock(settings.profiles_dir, name):
        t_lock = time.perf_counter()
        if if_match is not None:
            cur = profile_signature(settings.profiles_dir, name)
            # ETag values are sent quoted (RFC 7232) so strict HTTP clients (e.g. .NET's
            # HttpClient, which otherwise silently drops an unquoted response ETag) parse
            # it — strip the quotes back off before comparing to our plain hex token.
            if cur is not None and cur["token"] != if_match.strip('"'):
                return JSONResponse(status_code=409, content={
                    "conflict": True,
                    "server_yaml": cur["structural"],
                    "incoming_yaml": structural_yaml(profile),
                    "server_modified": cur["modified"],
                    "server_version": cur["token"],
                })
        t_sig = time.perf_counter()
        existing = load_profile(settings.profiles_dir, name) if name in list_profiles(settings.profiles_dir) else None
        if merge and existing is not None:
            profile = merge_profiles(existing, profile)
        _preserve_producer_http(existing, profile)   # never let a stale save strip an http node's spec
        t_load = time.perf_counter()
        if not layout:
            # Re-pull fed dictionaries so a feed-config change (columns/wiring) refreshes terms now —
            # save_profile then externalises the derived (deduped) list to each dictionary's term file.
            try:
                from ...learn.dict_feed import apply_feeds
                apply_feeds(settings.data_dir, name, profile)
            except Exception:  # noqa: BLE001 - best-effort; never block a save
                pass
        t_feeds = time.perf_counter()
        path = save_profile(settings.profiles_dir, profile, layout_only=layout)
        t_write = time.perf_counter()
        new_sig = profile_signature(settings.profiles_dir, name)
    total = time.perf_counter() - t0
    if total > 1.0:
        logev(f"profile save slow ({total:.1f}s): lock {t_lock - t0:.1f} · sig {t_sig - t_lock:.1f}"
              f" · load {t_load - t_sig:.1f} · feeds {t_feeds - t_load:.1f}"
              f" · write {t_write - t_feeds:.1f} · resig {time.perf_counter() - t_write:.1f}",
              "warn", game=name)
    headers = {"ETag": f'"{new_sig["token"]}"'} if new_sig else {}
    return JSONResponse({"saved": str(path), "windows": [w.id for w in profile.windows]}, headers=headers)


# ---- per-device graph-local state (viewport/minimap, gitignored sidecar) ---------

@router.get("/{name}/graphlocal")
def get_graphlocal(name: str):
    return load_graph_local(get_settings().profiles_dir, name)


@router.put("/{name}/graphlocal")
def put_graphlocal(name: str, state: dict = Body(...)):
    save_graph_local(get_settings().profiles_dir, name, state)
    return {"ok": True}


# ---- versioned backups -----------------------------------------------------------

@router.get("/{name}/backups")
def get_backups(name: str, limit: int = 10, offset: int = 0):
    """A PAGE of snapshots, newest first, each with date + node/structural counts.
    Only the returned page is parsed (counts need a YAML load) — listing is a cheap
    glob, so a profile with hundreds of backups still opens instantly. ``limit<=0``
    returns the rest from ``offset``. Returns ``{total, items}`` for the lazy list."""
    paths = list(reversed(list_backups(get_settings().profiles_dir, name)))   # newest first
    page = paths[offset:] if limit <= 0 else paths[offset:offset + limit]
    return {"total": len(paths), "items": [backup_meta(p) for p in page]}


@router.get("/{name}/backups/{stamp}")
def get_backup(name: str, stamp: str):
    """The full backup profile (drives the preview render and restore)."""
    settings = get_settings()
    if not backup_path(settings.profiles_dir, name, stamp).exists():
        raise HTTPException(status_code=404, detail=f"No backup {stamp!r} for {name!r}")
    return read_backup(settings.profiles_dir, name, stamp).model_dump(mode="json", exclude_none=True)


@router.post("/{name}/backups/{stamp}/restore")
def post_restore_backup(name: str, stamp: str):
    """Load a backup as the new live profile (snapshotting the current state first).
    The chosen backup file is left intact."""
    settings = get_settings()
    if not backup_path(settings.profiles_dir, name, stamp).exists():
        raise HTTPException(status_code=404, detail=f"No backup {stamp!r} for {name!r}")
    profile = restore_backup(settings.profiles_dir, name, stamp)
    return profile.model_dump(mode="json", exclude_none=True)
