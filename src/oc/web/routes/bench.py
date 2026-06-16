"""Capture-benchmark endpoint: measure raw grab throughput, no OCR.

Drives the same code path the CLI ``bench`` command does (hammer ``grab_window``
for a few seconds, count grabs and — for backends that expose ``frame_seq`` —
distinct frames), but against the web app's warmed locator so the "testing" panel
can show capture rate and let the user A/B ``printwindow`` vs ``wgc`` live.

The loop is short and runs in FastAPI's threadpool (a sync endpoint), so it never
blocks the event loop. An explicit ``capture`` override builds a throwaway backend
of that name so the test doesn't disturb the live one; with no override it reuses
the configured backend.
"""

from __future__ import annotations

import time

from fastapi import APIRouter, HTTPException, Query

from ...runtime import load_live_profile
from ...registry import build_capture, capture_names
from ..deps import get_engine, get_locator, get_settings

router = APIRouter(prefix="/api", tags=["bench"])


@router.get("/bench/backends")
def backends():
    """Capture backends available on this machine (``wgc`` only appears if the
    optional ``windows-capture`` wheel is installed) plus the configured default."""
    return {"backends": capture_names(), "default": get_settings().capture.name}


@router.get("/bench")
def bench(
    game: str = Query(..., description="profile name"),
    seconds: float = Query(3.0, ge=0.2, le=20.0),
    capture: str | None = Query(None, description="override capture backend (e.g. wgc)"),
    warmup: float = Query(0.8, ge=0.0, le=5.0),
):
    engine = get_engine()
    settings = get_settings()
    profile = load_live_profile(settings.profiles_dir, game)
    win = get_locator().locate(profile)
    if win is None:
        raise HTTPException(status_code=404, detail=f"Window for {game!r} not found")

    override = capture and capture != settings.capture.name
    if override:
        try:
            backend = build_capture(capture)
        except KeyError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        name = capture
    else:
        backend = engine.capture
        name = settings.capture.name

    has_seq = isinstance(getattr(type(backend), "frame_seq", None), property)
    try:
        warm_end = time.perf_counter() + warmup
        while time.perf_counter() < warm_end:
            backend.grab_window(win)

        grabs = 0
        seq0 = backend.frame_seq if has_seq else 0
        shape = None
        t0 = time.perf_counter()
        end = t0 + seconds
        while time.perf_counter() < end:
            frame = backend.grab_window(win)
            grabs += 1
            if frame.image.size > 3:
                shape = frame.image.shape
        elapsed = time.perf_counter() - t0
        frames = (backend.frame_seq - seq0) if has_seq else None
    finally:
        if override and hasattr(backend, "close"):
            backend.close()

    return {
        "backend": name,
        "window": [win.client.w, win.client.h],
        "captured": [shape[1], shape[0]] if shape else None,
        "seconds": round(elapsed, 3),
        "grabs": grabs,
        "grabs_per_s": round(grabs / elapsed, 1) if elapsed else 0.0,
        "ms_per_grab": round(1000 * elapsed / grabs, 2) if grabs else None,
        # frames/s: distinct frames produced. None for backends with no counter
        # (every grab is a fresh frame, so it equals grabs/s).
        "frames": frames,
        "frames_per_s": (round(frames / elapsed, 1) if elapsed else 0.0) if frames is not None else None,
    }
