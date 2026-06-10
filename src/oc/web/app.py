"""FastAPI application factory for the teaching UI."""

from __future__ import annotations

import threading
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from ..profile import list_profiles, load_profile
from .deps import get_locator, get_settings
from .routes import capture, flow, lexicon, ocr, precapture, preview, profiles, suggest

_STATIC = Path(__file__).parent / "static"


def _warm() -> None:
    """Pay the one-time slow costs in the background at startup so the user's first
    Capture/Preview is instant: the process scan AND the OCR model load."""
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
    threading.Thread(target=_warm, daemon=True).start()
    yield


def create_app() -> FastAPI:
    app = FastAPI(title="oc teaching UI", version="0.1.0", lifespan=lifespan)
    app.include_router(capture.router)
    app.include_router(profiles.router)
    app.include_router(flow.router)
    app.include_router(preview.router)
    app.include_router(suggest.router)
    app.include_router(lexicon.router)
    app.include_router(precapture.router)
    app.include_router(ocr.router)
    # Serve the single-page front-end at root.
    app.mount("/", StaticFiles(directory=str(_STATIC), html=True), name="static")
    return app


app = create_app()
