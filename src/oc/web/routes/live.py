"""Live collection endpoints: start/stop the real collector for a game and poll status.

One :class:`LiveSession` per game (cached for the server's life). Starting it runs the
full collection pipeline in a background thread, writing to the same datasets the CLI
``collect`` command does. Status is also folded into the activity heartbeat.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from ...collect.live import LiveSession
from ...profile import list_profiles
from ...runtime import load_live_profile
from ..deps import get_engine, get_settings
from .ocr import _persisted, read_mode

router = APIRouter(prefix="/api/live", tags=["live"])

_sessions: dict[str, LiveSession] = {}

# Frame limiter (min seconds between collector reads), persisted like the OCR knobs so it
# survives restarts (rule 7: reuse the one _persisted dotfile primitive). Default = the
# shipped tuning.collect_interval. 0 = as fast as possible.
_read_interval, _write_interval = _persisted(
    "live_interval", lambda v: max(0.0, float(v)),
    lambda: get_settings().tuning.collect_interval)


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


def any_running() -> bool:
    """True while any live collector runs — the GPU watchdog must not release then."""
    return any(s.is_running() for s in _sessions.values())


def live_readouts(game: str) -> dict:
    """Current ``{readout_id: value}`` for ``game``'s running live session, or ``{}`` if none.
    The web-process source of live readouts so a toast fired from a route can interpolate
    ``{{ro_1}}`` tokens (only a running live collector reads them off-screen)."""
    s = _sessions.get(game)
    if s is None or not s.is_running():
        return {}
    try:
        return dict(s.status().get("readouts") or {})
    except Exception:   # noqa: BLE001 - a status hiccup must never break a fire
        return {}


def _session(game: str, create: bool = False) -> LiveSession:
    s = _sessions.get(game)
    if s is None:
        if not create:
            raise HTTPException(status_code=404, detail="no live session")
        settings = get_settings()
        if game not in list_profiles(settings.profiles_dir):
            raise HTTPException(status_code=404, detail=f"no profile {game!r}")
        s = _sessions[game] = LiveSession(get_engine(), load_live_profile(settings.profiles_dir, game))
    return s


def _refresh_profile(game: str, s: LiveSession) -> None:
    """Push the on-disk profile into the long-lived session before a run (no-op mid-run)."""
    settings = get_settings()
    if game in list_profiles(settings.profiles_dir):
        s.update_profile(load_live_profile(settings.profiles_dir, game))


@router.get("/interval")
def get_interval():
    """The persisted frame limiter (seconds); 0 = as fast as possible."""
    return {"interval": _read_interval()}


@router.post("/interval")
def set_interval(seconds: float):
    """Persist the frame limiter. Applies to the NEXT collector start; a running collector is
    restarted in place by the client so the change takes effect immediately."""
    _write_interval(max(0.0, float(seconds)))
    return {"interval": _read_interval()}


@router.post("/{game}/start")
def start(game: str, interval: float | None = None):
    s = _session(game, create=True)
    _refresh_profile(game, s)   # pick up profile edits made since the last run
    # auto-mode runs the live loop on GPU (then frees it on stop); cpu/gpu leave the device
    # as-is (gpu is already pinned, cpu stays CPU) — same policy as the precapture batch.
    s.batch_device = "gpu" if read_mode() == "auto" else None
    if interval is None:
        interval = _read_interval()   # persisted frame limiter (settings modal owns it)
    s.start(interval=interval)
    _fire_on_capture(game)
    _fire_lifecycle(game, "fire_live_start")   # a live start is also its own distinct event
    return s.status()


def _fire_on_capture(game: str) -> None:
    """Fire any on_capture triggers — a live session counts as a capture start."""
    _fire_lifecycle(game, "fire_capture")


def _fire_lifecycle(game: str, fn_name: str) -> None:
    """Call ``source_sched.<fn_name>(game, settings)`` — a lifecycle fire must never break the
    live start/stop that triggered it."""
    try:
        from .. import source_sched
        getattr(source_sched, fn_name)(game, get_settings())
    except Exception:   # noqa: BLE001
        pass


@router.post("/{game}/stop")
def stop(game: str):
    s = _sessions.get(game)
    if s is None:
        return {"running": False, "frames": 0, "written": 0, "fps": 0.0, "recognized": []}
    s.stop()
    _fire_lifecycle(game, "fire_live_stop")
    return s.status()


@router.get("/{game}/status")
def status(game: str):
    s = _sessions.get(game)
    if s is None:
        return {"running": False, "frames": 0, "written": 0, "fps": 0.0, "recognized": []}
    return s.status()


@router.get("/{game}/debug")
def debug(game: str, after: int = 0):
    """Incremental debug-log poll: entries newer than ``after`` (the last seq the client has).
    Kept off the heartbeat so it costs nothing unless the panel's debug section is open."""
    s = _sessions.get(game)
    if s is None:
        return {"running": False, "seq": 0, "entries": []}
    return s.debug(after)
