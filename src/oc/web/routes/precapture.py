"""Precapture: record frames fast, batch-OCR them, review, then save.

One :class:`PrecaptureSession` per game in-process. The worker threads live inside the
session; these endpoints just drive them and poll status. Saving commits the staged
records into the real datasets (the same ledger-backed stores live collection writes).
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from ...collect.precapture import PrecaptureSession
from ...profile import list_profiles
from ...runtime import load_live_profile
from ..captures_store import _safe
from ..deps import get_engine, get_settings
from .ocr import read_mode

router = APIRouter(prefix="/api/precapture", tags=["precapture"])

_sessions: dict[str, PrecaptureSession] = {}


def kill_all_sessions(timeout: float = 5.0) -> dict:
    """Stop every running precapture worker and WAIT for it to die. Returns
    ``{"killed": [...], "alive": [...]}`` — ``alive`` are workers that refused to stop
    within ``timeout`` (still hogging the GPU). Called on server start and whenever the
    page loads, so a stray OCR thread can never outlive the UI that owns it."""
    killed: list[str] = []
    alive: list[str] = []
    for game, s in list(_sessions.items()):
        if not s.is_running():
            continue
        if s.kill(timeout):
            killed.append(game)
        else:
            alive.append(game)
    return {"killed": killed, "alive": alive}


def _session(game: str, create: bool = False) -> PrecaptureSession:
    s = _sessions.get(game)
    if s is None:
        if not create:
            raise HTTPException(status_code=404, detail="no precapture session")
        settings = get_settings()
        if game not in list_profiles(settings.profiles_dir):
            raise HTTPException(status_code=404, detail=f"no profile {game!r}")
        s = _sessions[game] = PrecaptureSession(get_engine(), load_live_profile(settings.profiles_dir, game))
    return s


def _refresh_profile(game: str, s: PrecaptureSession) -> None:
    """Push the on-disk profile into the long-lived session before a run, so UI edits to
    detect/region boxes since the session was created actually take effect (no-op mid-run)."""
    settings = get_settings()
    if game in list_profiles(settings.profiles_dir):
        s.update_profile(load_live_profile(settings.profiles_dir, game))


@router.post("/{game}/record/start")
def record_start(game: str, max_frames: int = 300, interval_ms: int = 0, label: str = ""):
    s = _session(game, create=True)
    _refresh_profile(game, s)
    # auto-scroll is per-window now (ScrollDef.autoscroll/scroll_clicks); start_recording reads
    # it off the window it classifies on screen.
    s.start_recording(max_frames=max_frames, interval_ms=interval_ms, label=label)
    try:   # a precapture recording counts as a capture start -> fire on_capture triggers
        from ..source_sched import fire_capture
        fire_capture(game, get_settings())
    except Exception:   # noqa: BLE001 - a lifecycle fire must never break recording
        pass
    return s.status()


@router.get("/{game}/sessions")
def list_sessions(game: str):
    """Every saved recording session for this game (newest first) + the active status."""
    s = _session(game, create=True)
    return {"sessions": s.list_sessions(), "status": s.status()}


@router.get("/{game}/{sid}/frame/{idx}")
def session_frame(game: str, sid: str, idx: int):
    """Serve one frame image (``NNNNN.jpg``) of a saved session, for the capture picker.

    Reads the file straight off disk (``captures/<game>/precapture/<sid>/<idx>.jpg``) — no
    session/worker is created, so previewing frames never touches the OCR pipeline.
    """
    if "/" in sid or "\\" in sid or ".." in sid or idx < 0:
        raise HTTPException(status_code=404, detail="bad frame reference")
    path = Path(get_settings().captures_dir) / _safe(game) / "precapture" / _safe(sid) / f"{idx:05d}.jpg"
    if not path.exists():
        raise HTTPException(status_code=404, detail="frame not found")
    return FileResponse(str(path), media_type="image/jpeg")


@router.post("/{game}/sessions/{sid}/load")
def load_session(game: str, sid: str):
    """Make a saved session active and load its frames + records, ready to re-process/save."""
    s = _session(game, create=True)
    try:
        s.load_session(sid)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"no session {sid!r}")
    return {"sessions": s.list_sessions(), "status": s.status()}


@router.post("/{game}/sessions/{sid}/rename")
def rename_session(game: str, sid: str, label: str = ""):
    s = _session(game, create=True)
    try:
        s.rename_session(sid, label)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"no session {sid!r}")
    return {"sessions": s.list_sessions(), "status": s.status()}


@router.delete("/{game}/sessions/{sid}")
def delete_session(game: str, sid: str):
    s = _session(game, create=True)
    s.delete_session(sid)
    return {"sessions": s.list_sessions(), "status": s.status()}


@router.post("/{game}/record/stop")
def record_stop(game: str):
    s = _session(game)
    s.stop_recording()
    return s.status()


@router.post("/{game}/process/start")
def process_start(game: str):
    s = _session(game)
    _refresh_profile(game, s)   # classify/read use the profile — pick up edits made since recording
    # auto-mode runs the batch on GPU (then frees it); cpu/gpu leave the device as-is
    s.batch_device = "gpu" if read_mode() == "auto" else None
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
        return s.status()
    return {"phase": "idle", "frames": 0, "processed": 0, "fps": 0.0, "error": None, "datasets": []}


@router.post("/kill-all")
def kill_all():
    """Stop every running OCR worker and wait. ``alive`` non-empty => some refused."""
    return kill_all_sessions()


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
