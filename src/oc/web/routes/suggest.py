"""Suggest endpoint: analyse a capture and propose a reading layout."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from ...collect.suggest import analyze
from ...ocr.serialize import ocr_job
from ...profile import list_profiles
from ...runtime import load_live_profile
from ..deps import get_engine, get_locator, get_settings

router = APIRouter(prefix="/api", tags=["suggest"])


@router.get("/suggest")
def suggest(
    game: str = Query(...),
    sx: float | None = None, sy: float | None = None,
    sw: float | None = None, sh: float | None = None,
):
    settings = get_settings()
    engine = get_engine()
    if game not in list_profiles(settings.profiles_dir):
        raise HTTPException(status_code=404, detail=f"No profile {game!r}")
    profile = load_live_profile(settings.profiles_dir, game)
    win = get_locator().locate(profile)
    if win is None:
        raise HTTPException(status_code=404, detail="game window not found")
    frame = engine.capture.grab_window(win)
    search = None
    if None not in (sx, sy, sw, sh):
        search = {"x": sx, "y": sy, "w": sw, "h": sh}
    with ocr_job():   # one job so it doesn't interleave with a preview/detect/precapture
        return analyze(frame, engine.ocr, search)
