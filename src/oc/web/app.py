"""FastAPI application factory for the data-rig web UI."""

from __future__ import annotations

import threading
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from ..profile import list_profiles, load_profile
from .deps import get_locator, get_settings
from .routes import (
    activity,
    bench,
    capture,
    dictionaries,
    events,
    flow,
    lexicon,
    live,
    ocr,
    precapture,
    pretty,
    preview,
    prices,
    profiles,
    suggest,
    triggers,
    video,
)

_STATIC = Path(__file__).parent / "static"


class _NoCacheStatic(StaticFiles):
    """Serve the front-end with caching disabled. This is a local, frequently-edited
    teaching tool — a browser holding an old .js/.css after an edit causes confusing
    version skew. Tiny files on local disk, so re-fetching every load costs nothing."""

    async def get_response(self, path, scope):
        resp = await super().get_response(path, scope)
        resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        return resp


def _warm() -> None:
    """Pay the one-time slow costs in the background at startup so the user's first
    Capture/Preview is instant: the process scan AND the OCR model load. The model stays
    resident for the life of the process — with the lean CUDA arena options it only costs
    a few hundred MB of GPU, so there's no reason to keep loading/unloading it."""
    try:
        settings = get_settings()
        locator = get_locator()
        for name in list_profiles(settings.profiles_dir):
            locator.locate(load_profile(settings.profiles_dir, name))
    except Exception:  # noqa: BLE001 - warmup is best-effort
        pass
    try:
        import numpy as np

        from .deps import get_engine
        from .routes.ocr import apply_persisted

        apply_persisted()   # restore the saved CPU/GPU choice before warming the model
        get_engine().ocr.read_image(np.zeros((32, 64, 3), dtype=np.uint8))
    except Exception:  # noqa: BLE001
        pass


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Kill any precapture OCR worker that somehow outlived a prior run before doing
    # anything else — no stray thread should keep hammering the GPU at startup.
    try:
        from .routes.precapture import kill_all_sessions
        kill_all_sessions()
    except Exception:  # noqa: BLE001 - best-effort
        pass
    try:
        from .routes.live import kill_all_sessions as kill_live
        kill_live()
    except Exception:  # noqa: BLE001 - best-effort
        pass
    threading.Thread(target=_warm, daemon=True).start()
    # keep interval triggers firing (+ feed the Activity panel's countdown) while only the
    # teach UI is up; safe — firing is guarded and cross-process file-locked.
    try:
        from .trigger_sched import start as _start_triggers
        _start_triggers(get_settings())
    except Exception:  # noqa: BLE001 - best-effort
        pass
    # Fire on_change triggers for ANY dataset write in this process (form, sweep, preview,
    # precapture, live collection, batch restore) via the dataset change bus.
    try:
        from ..collect.triggers import TriggerRunner
        from ..runtime import load_live_profile
        from ..store.changes import OnChangeFirer, subscribe

        def _runner_for(game: str):
            try:
                profile = load_live_profile(get_settings().profiles_dir, game)
                return TriggerRunner(profile, get_settings().data_dir) if profile.triggers else None
            except Exception:  # noqa: BLE001
                return None
        subscribe(OnChangeFirer(_runner_for))
    except Exception:  # noqa: BLE001 - best-effort
        pass
    yield


def create_app() -> FastAPI:
    app = FastAPI(title="data-rig", version="0.1.0", lifespan=lifespan)

    # Surface the FULL traceback of any unhandled error to the client (this is a local
    # teaching tool) AND to the server log, so a 500 isn't an opaque "Internal Server
    # Error" — the browser console prints the real stack.
    import traceback as _tb

    from fastapi import Request
    from fastapi.responses import JSONResponse

    @app.exception_handler(Exception)
    async def _all_errors(_request: Request, exc: Exception):  # noqa: ANN202
        tb = _tb.format_exc()
        print(tb)   # server console
        return JSONResponse(status_code=500, content={"detail": str(exc), "traceback": tb})

    app.include_router(capture.router)
    app.include_router(profiles.router)
    app.include_router(flow.router)
    app.include_router(preview.router)
    app.include_router(suggest.router)
    app.include_router(lexicon.router)
    app.include_router(precapture.router)
    app.include_router(live.router)
    app.include_router(ocr.router)
    app.include_router(prices.router)
    app.include_router(activity.router)
    app.include_router(triggers.router)
    app.include_router(dictionaries.router)
    app.include_router(pretty.router)
    app.include_router(events.router)
    app.include_router(video.router)
    app.include_router(bench.router)
    # Serve the single-page front-end at root.
    app.mount("/", _NoCacheStatic(directory=str(_STATIC), html=True), name="static")
    return app


app = create_app()
