"""Managed icon storage for toast nodes' icon fields.

Icons are picked once via a native file input (the icon-picker modal, ``icon_picker.js``), copied
into ONE shared folder here, and reused by path across every game/toast afterward — not searched
for across the filesystem on every pick. Mirrors ``video.py``'s upload endpoint (this module's
only sibling precedent for a raw file upload).
"""

from __future__ import annotations

import mimetypes
import os
import shutil
from pathlib import Path

from fastapi import APIRouter, HTTPException, Response, UploadFile

from ..deps import get_settings

router = APIRouter(prefix="/api/icons", tags=["icons"])

_ICON_EXTS = (".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico")
_ICON_FILE_CAP = 15 * 1024 * 1024   # a preview thumbnail has no business needing more than this


def _icons_dir() -> Path:
    d = Path(get_settings().data_dir) / "_icons"
    d.mkdir(parents=True, exist_ok=True)
    return d


@router.get("")
def list_icons():
    """Every stored icon, newest first — the picker modal's gallery."""
    d = _icons_dir()
    out = []
    for p in d.iterdir():
        if not p.is_file():
            continue
        st = p.stat()
        out.append({"name": p.name, "path": str(p.resolve()), "mtime": st.st_mtime, "size": st.st_size})
    out.sort(key=lambda c: c["mtime"], reverse=True)
    return {"icons": out}


@router.post("")
async def upload(file: UploadFile):
    """Copy an uploaded image into the shared icon store, deduped by name (a numeric suffix on
    collision — silently overwriting would retroactively change any toast already pointing at that
    path). Returns ``{name, path}`` for the picker to immediately select."""
    name = Path(file.filename or "icon").name   # strip any path components the browser sent
    ext = Path(name).suffix.lower()
    if ext not in _ICON_EXTS:
        raise HTTPException(status_code=400, detail=f"unsupported image type {ext!r}")
    d = _icons_dir()
    dest = d / name
    stem, i = Path(name).stem, 1
    while dest.exists():
        dest = d / f"{stem}_{i}{ext}"
        i += 1
    with dest.open("wb") as out:
        shutil.copyfileobj(file.file, out)
    return {"name": dest.name, "path": str(dest.resolve())}


@router.get("/file")
def icon_file(name: str):
    """Raw bytes of a stored icon, for the picker's thumbnail preview. ``name`` is confined to the
    icon store (resolved path's parent must be exactly the store dir) — unlike the toast preview
    routes' caller-supplied absolute paths, ``name`` here is arbitrary client text."""
    d = _icons_dir()
    resolved = (d / name).resolve()
    if resolved.parent != d.resolve() or not resolved.is_file():
        raise HTTPException(status_code=404, detail="icon not found")
    size = os.path.getsize(resolved)
    if size > _ICON_FILE_CAP:
        raise HTTPException(status_code=413, detail="file too large to preview")
    data = resolved.read_bytes()
    media_type = mimetypes.guess_type(str(resolved))[0] or "application/octet-stream"
    return Response(content=data, media_type=media_type)
