"""Live collection endpoints: start/stop the real collector for a game and poll status.

One :class:`LiveSession` per game (cached for the server's life). Starting it runs the
full collection pipeline in a background thread, writing to the same datasets the CLI
``collect`` command does. Status is also folded into the activity heartbeat.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from ...collect.live import LiveSession
from ...profile import list_profiles, load_profile
from ..deps import get_engine, get_settings

router = APIRouter(prefix="/api/live", tags=["live"])

_sessions: dict[str, LiveSession] = {}


def kill_all_sessions(timeout: float = 5.0) -> dict:
    """Stop every running live-collection worker and wait. Called on server start/lifespan
    so a stray collector can't outlive the UI that owns it."""
    killed: list[str] = []
    alive: list[str] = []
    for game, s in list(_sessions.items()):
        if not s.is_running():
            continue
        (killed if s.stop(timeout) else alive).append(game)
    return {"killed": killed, "alive": alive}


def _session(game: str, create: bool = False) -> LiveSession:
    s = _sessions.get(game)
    if s is None:
        if not create:
            raise HTTPException(status_code=404, detail="no live session")
        settings = get_settings()
        if game not in list_profiles(settings.profiles_dir):
            raise HTTPException(status_code=404, detail=f"no profile {game!r}")
        s = _sessions[game] = LiveSession(get_engine(), load_profile(settings.profiles_dir, game))
    return s


def _refresh_profile(game: str, s: LiveSession) -> None:
    """Push the on-disk profile into the long-lived session before a run (no-op mid-run)."""
    settings = get_settings()
    if game in list_profiles(settings.profiles_dir):
        s.update_profile(load_profile(settings.profiles_dir, game))


@router.post("/{game}/start")
def start(game: str, interval: float = 1.0):
    s = _session(game, create=True)
    _refresh_profile(game, s)   # pick up profile edits made since the last run
    s.start(interval=interval)
    return s.status()


@router.post("/{game}/stop")
def stop(game: str):
    s = _sessions.get(game)
    if s is None:
        return {"running": False, "frames": 0, "written": 0, "fps": 0.0, "recognized": []}
    s.stop()
    return s.status()


@router.get("/{game}/status")
def status(game: str):
    s = _sessions.get(game)
    if s is None:
        return {"running": False, "frames": 0, "written": 0, "fps": 0.0, "recognized": []}
    return s.status()
