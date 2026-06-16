"""Capture endpoints: serve a live screenshot of the target game window.

The browser draws boxes over this image; because the captured image *is* the
window client area, box coordinates divided by image size are exactly the
window-fraction coords stored in the profile.
"""

from __future__ import annotations

import cv2
from fastapi import APIRouter, Body, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse, Response

from ...profile import list_profiles, load_profile
from .. import captures_store
from ..deps import get_engine, get_locator, get_settings
from ..encode import frame_to_jpeg

router = APIRouter(prefix="/api", tags=["capture"])


@router.get("/games")
def detect_games():
    """Report which known profiles have a running, locatable window."""
    settings = get_settings()
    locator = get_locator()
    out = []
    for name in list_profiles(settings.profiles_dir):
        profile = load_profile(settings.profiles_dir, name)
        win = locator.locate(profile)
        out.append(
            {
                "name": name,
                "running": win is not None,
                "title": win.title if win else None,
                "client": win.client.as_tuple() if win else None,
            }
        )
    return JSONResponse(out)


@router.get("/capture")
def capture(game: str = Query(..., description="profile name"), stash: bool = True):
    """Return a JPEG of the game window. ``stash=false`` (live view) skips saving."""
    engine = get_engine()
    settings = get_settings()
    profile = load_profile(settings.profiles_dir, game)
    win = get_locator().locate(profile)
    if win is None:
        raise HTTPException(status_code=404, detail=f"Window for {game!r} not found")
    frame = engine.capture.grab_window(win)
    jpeg = frame_to_jpeg(frame)
    name = captures_store.save(settings.captures_dir, game, jpeg) if stash else ""
    return Response(
        content=jpeg,
        media_type="image/jpeg",
        headers={
            "X-Client-Width": str(frame.client.w),
            "X-Client-Height": str(frame.client.h),
            "X-Capture-Name": name,
        },
    )


@router.get("/captures/{game}")
def list_captures(game: str):
    """List stashed captures for a game, newest first."""
    return captures_store.listing(get_settings().captures_dir, game)


@router.post("/captures/{game}/live/grab")
def live_grab(game: str):
    """Capture the live window and save the frame into the game's ``live`` bucket.

    Called once per live-tuning round so live mode persists what it sees. Returns the
    running {count, bytes} of saved live images so the panel can show the stat. A missing
    window is not an error here (live mode polls; the window may be hidden this instant) —
    just return the current stats unchanged.
    """
    settings = get_settings()
    profile = load_profile(settings.profiles_dir, game)
    win = get_locator().locate(profile)
    if win is not None:
        frame = get_engine().capture.grab_window(win)
        jpeg = frame_to_jpeg(frame)
        captures_store.save(settings.captures_dir, game, jpeg, sub=captures_store.LIVE)
    return captures_store.stats(settings.captures_dir, game, captures_store.LIVE)


@router.get("/captures/{game}/live/stats")
def live_stats(game: str):
    """{count, bytes} of saved live images for the game."""
    return captures_store.stats(get_settings().captures_dir, game, captures_store.LIVE)


@router.post("/captures/{game}/live/clear")
def live_clear(game: str):
    """Delete all saved live images for the game; returns the (now-zero) stats."""
    settings = get_settings()
    captures_store.clear(settings.captures_dir, game, captures_store.LIVE)
    return captures_store.stats(settings.captures_dir, game, captures_store.LIVE)


@router.get("/captures/{game}/bindings")
def get_bindings(game: str):
    """Which stashes each window opens with: {window_id: [capture_name, …]}. Always a list
    (a window can hold several image pages); legacy bare-string values are normalised here."""
    raw = captures_store.get_bindings(get_settings().captures_dir, game)
    return {w: captures_store.as_list(v) for w, v in raw.items()}


@router.post("/captures/{game}/bind")
def bind_capture(game: str, window: str = Query(...), name: str = Query(...)):
    """Bind a single stashed capture to a window (replacing any pages), or unbind (empty name)."""
    captures_store.set_binding(get_settings().captures_dir, game, window, name)
    return {"ok": True, "window": window, "name": name}


@router.post("/captures/{game}/bindlist")
def bind_list(game: str, window: str = Query(...), names: list[str] = Body(...)):
    """Bind a window to an ordered list of stashes (its image pages); empty list unbinds."""
    captures_store.set_bindings(get_settings().captures_dir, game, window, names)
    return {"ok": True, "window": window, "names": names}


@router.get("/captures/{game}/{name}")
def get_capture(game: str, name: str):
    """Serve a stashed capture image, with its client size in headers."""
    path = captures_store.path_for(get_settings().captures_dir, game, name)
    if path is None:
        raise HTTPException(status_code=404, detail="capture not found")
    return FileResponse(str(path), media_type="image/jpeg")


@router.post("/item/cutout")
def item_cutout(
    game: str = Query(...), capture: str = Query(...),
    x: float = Query(...), y: float = Query(...), w: float = Query(...), h: float = Query(...),
):
    """Freeze an item cell: crop the bound capture to the fraction box, save a PNG.

    The cutout never changes once saved — it's the item template's reference image."""
    settings = get_settings()
    path = captures_store.path_for(settings.captures_dir, game, capture)
    if path is None:
        raise HTTPException(status_code=404, detail="capture not found")
    img = cv2.imread(str(path))
    if img is None:
        raise HTTPException(status_code=500, detail="failed to read capture")
    H, W = img.shape[:2]
    px, py = max(0, int(x * W)), max(0, int(y * H))
    pw, ph = max(1, int(w * W)), max(1, int(h * H))
    crop = img[py : py + ph, px : px + pw]
    ok, buf = cv2.imencode(".png", crop)
    if not ok:
        raise HTTPException(status_code=500, detail="failed to encode cutout")
    name = captures_store.save_cutout(settings.captures_dir, game, buf.tobytes())
    return {"name": name, "url": f"/api/item/cutout/{game}/{name}"}


@router.get("/item/cutout/{game}/{name}")
def get_cutout(game: str, name: str):
    """Serve a frozen item cutout PNG."""
    path = captures_store.cutout_path(get_settings().captures_dir, game, name)
    if path is None:
        raise HTTPException(status_code=404, detail="cutout not found")
    return FileResponse(str(path), media_type="image/png")
