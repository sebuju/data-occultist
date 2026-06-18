"""Stash a rendered node-canvas screenshot into the repo's ``.trash/`` scratch dir.

The graph editor's toolbox renders the whole node canvas to a PNG client-side
(browser JS can't write disk) and POSTs the bytes here. We drop them into
``.trash/`` (gitignored scratch) with a timestamped name — a throwaway visual
snapshot, not tracked data, so it lives nowhere near ``captures/`` or ``data/``.
"""

from __future__ import annotations

import re
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query, Request

router = APIRouter(prefix="/api", tags=["screenshot"])

_SAFE = re.compile(r"[^A-Za-z0-9._-]")
_TRASH = Path(".trash")


@router.post("/screenshot/{game}")
async def stash_screenshot(game: str, request: Request, view: str = Query("canvas")):
    """Write POSTed PNG bytes to ``.trash/<game>-<view>-dd-mm-yy-HHMM.png``.

    ``view`` tags the kind in the filename (``canvas`` = whole graph, ``viewport`` =
    current on-screen view) so the two don't clobber each other."""
    data = await request.body()
    if not data:
        raise HTTPException(status_code=400, detail="empty screenshot body")
    stamp = datetime.now().strftime("%d-%m-%y-%H%M")
    name = f"{_SAFE.sub('_', game)}-{_SAFE.sub('_', view)}-{stamp}.png"
    _TRASH.mkdir(parents=True, exist_ok=True)
    path = _TRASH / name
    path.write_bytes(data)
    return {"path": str(path), "name": name}
