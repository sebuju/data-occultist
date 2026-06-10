"""Precapture: record frames fast, batch-OCR them, review, then save.

One :class:`PrecaptureSession` per game in-process. The worker threads live inside the
session; these endpoints just drive them and poll status. Saving commits the staged
records into the real datasets (the same ledger-backed stores live collection writes).
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from ...collect.precapture import PrecaptureSession
from ...profile import list_profiles, load_profile
from ..deps import get_engine, get_settings

router = APIRouter(prefix="/api/precapture", tags=["precapture"])

_sessions: dict[str, PrecaptureSession] = {}


def _session(game: str, create: bool = False) -> PrecaptureSession:
    s = _sessions.get(game)
    if s is None:
        if not create:
            raise HTTPException(status_code=404, detail="no precapture session")
        settings = get_settings()
        if game not in list_profiles(settings.profiles_dir):
            raise HTTPException(status_code=404, detail=f"no profile {game!r}")
        s = _sessions[game] = PrecaptureSession(get_engine(), load_profile(settings.profiles_dir, game))
    return s


@router.post("/{game}/record/start")
def record_start(game: str, max_frames: int = 300, interval_ms: int = 0):
    s = _session(game, create=True)
    s.start_recording(max_frames=max_frames, interval_ms=interval_ms)
    return s.status()


@router.post("/{game}/record/stop")
def record_stop(game: str):
    s = _session(game)
    s.stop_recording()
    return s.status()


@router.post("/{game}/process/start")
def process_start(game: str):
    s = _session(game)
    s.start_processing()
    return s.status()


@router.post("/{game}/process/pause")
def process_pause(game: str, on: bool = True):
    s = _session(game)
    s.pause(on)
    return s.status()


@router.post("/{game}/cancel")
def cancel(game: str):
    s = _session(game)
    s.cancel()
    return s.status()


@router.post("/{game}/reset")
def reset(game: str):
    s = _sessions.get(game)
    if s:
        s.reset()
    return {"phase": "idle", "frames": 0, "processed": 0, "fps": 0.0, "error": None, "datasets": []}


@router.post("/{game}/save")
def save(game: str):
    s = _session(game)
    written = s.save()
    return {"written": written, "status": s.status()}


@router.get("/{game}/status")
def status(game: str):
    s = _sessions.get(game)
    if s is None:
        return {"phase": "idle", "frames": 0, "processed": 0, "fps": 0.0, "error": None, "datasets": []}
    return s.status()
