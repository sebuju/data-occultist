"""FastAPI application factory for the data-occultist web UI."""

from __future__ import annotations

import asyncio
import signal
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
    capture_backend,
    dbbackup,
    dbschema,
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
    screenshot,
    sounds,
    sources,
    stats,
    suggest,
    triggers,
    video,
)

_STATIC = Path(__file__).parent / "static"


class _RevalidateStatic(StaticFiles):
    """Serve the front-end cacheable but always-revalidated. This is a local,
    frequently-edited teaching tool — a browser holding an old .js/.css after an edit
    causes confusing version skew, so caching must never be silent. ``no-cache`` (note:
    means "cache but revalidate before every use", NOT "don't cache") gives us both: the
    browser keeps the file but re-checks it each load. StaticFiles already emits
    ``ETag``/``Last-Modified`` from mtime and answers the conditional request with an
    empty ``304 Not Modified`` when unchanged, so an unedited asset costs a tiny
    revalidation ping instead of a full re-transfer, while an edited one is served fresh
    at once (zero skew). Relative ES-module imports each revalidate themselves, so this
    needs no version stamps or import map."""

    async def get_response(self, path, scope):
        resp = await super().get_response(path, scope)
        resp.headers["Cache-Control"] = "no-cache"
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
        from .routes.capture_backend import apply_persisted as apply_capture
        from .routes.ocr import apply_persisted

        apply_capture()     # restore the saved capture backend (overrides settings.yaml baseline)
        apply_persisted()   # restore the saved CPU/GPU choice before warming the model
        ocr = get_engine().ocr
        ocr.read_image(np.zeros((32, 64, 3), dtype=np.uint8))
        # ALSO warm the recognition path: grid reads use read_lines/text_rec, but
        # read_image's detector finds no boxes in a blank frame so it never runs rec.
        # Without this, the first real grid read pays rec's first-inference cost INSIDE
        # the OCR lock — the log bar then reports a wildly inflated "initial" duration.
        if hasattr(ocr, "read_lines"):
            ocr.read_lines([np.zeros((16, 48, 3), dtype=np.uint8)])
    except Exception:  # noqa: BLE001
        pass


def _install_shutdown_signals() -> None:
    """Make the process notice a shutdown signal the MOMENT it arrives — before uvicorn
    starts waiting for connections to drain. uvicorn installs its own SIGINT/SIGTERM
    handlers in ``serve()`` just before this lifespan startup runs, so we CHAIN them: flip
    our shutdown flag first (long-lived SSE streams watch it and end immediately), then call
    uvicorn's handler (which sets ``should_exit``). With the streams self-closing there is
    nothing left for uvicorn to wait on, so shutdown is clean with no graceful-shutdown
    timeout. Off the main thread (e.g. desktop mode runs uvicorn on a daemon thread),
    ``signal.signal`` raises — harmless; that path stops via the lifespan-shutdown backstop."""
    from .shutdown import signal_shutdown

    def _chain(sig: int) -> None:
        try:
            prev = signal.getsignal(sig)
        except (ValueError, OSError):
            return

        def handler(signum, frame):
            signal_shutdown()
            if callable(prev):
                prev(signum, frame)

        try:
            signal.signal(sig, handler)
        except (ValueError, OSError, RuntimeError):
            pass   # not the main thread / unsupported on this platform

    for name in ("SIGINT", "SIGTERM", "SIGBREAK"):
        sig = getattr(signal, name, None)
        if sig is not None:
            _chain(sig)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    import os

    from .shutdown import bind_loop, signal_shutdown
    bind_loop(asyncio.get_running_loop())
    _install_shutdown_signals()
    # Quieten the static-asset GET flood in uvicorn's access log on every launch path (serve,
    # --reload worker, desktop, bare uvicorn). OCC_VERBOSE_ACCESS=1 (the serve --verbose-access
    # flag) keeps every line.
    try:
        from .logfilter import install as _install_access_filter
        _install_access_filter(verbose=os.environ.get("OCC_VERBOSE_ACCESS") == "1")
    except Exception:  # noqa: BLE001 - log tidiness must never break startup
        pass
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
    # A sweep killed mid-run (e.g. server restart) strands its per-game .price_sweep.lock,
    # which then BLOCKS every trigger-fired sweep for ~30 min. A fresh process holds no sweep,
    # so any lock on disk is orphaned — clear them all now.
    try:
        from ..enrich.price_runner import clear_stale_locks
        clear_stale_locks(get_settings().data_dir)
    except Exception:  # noqa: BLE001 - best-effort
        pass
    # Point the per-node timing store at the data dir (also done in Engine.build, but a
    # request can replay a dataset before the warm thread builds the engine).
    try:
        from ..store import stats_store
        stats_store.configure(get_settings().data_dir)
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
    # Watch on_change file sources (trailing-throttle reads) and fire on_app_start triggers.
    try:
        from .source_sched import start as _start_sources
        _start_sources(get_settings())
    except Exception:  # noqa: BLE001 - best-effort
        pass
    # Fire on_change triggers for ANY dataset write in this process (form, sweep, preview,
    # precapture, live collection, batch restore) via the dataset change bus.
    try:
        from ..collect.triggers import TriggerRunner
        from ..enrich.price_runner import sweep_status
        from ..runtime import load_live_profile
        from ..store.changes import OnChangeFirer, subscribe

        def _runner_for(game: str):
            try:
                profile = load_live_profile(get_settings().profiles_dir, game)
                return TriggerRunner(profile, get_settings().data_dir) if profile.triggers else None
            except Exception:  # noqa: BLE001
                return None
        # defer firing while a sweep is still writing the dataset -> one fire per sweep, not per row
        subscribe(OnChangeFirer(_runner_for, busy=lambda g, ds: bool(sweep_status(g, ds).get("running"))))
    except Exception:  # noqa: BLE001 - best-effort
        pass
    # Daily-on-change database backup: any dataset write may trigger a snapshot if the
    # newest one is >24h old (the snapshot runs off-thread, never blocking the write).
    try:
        from ..store.changes import subscribe as _sub_changes
        from ..store.db_backup import AutoBackup
        _sub_changes(AutoBackup(get_settings().data_dir))
    except Exception:  # noqa: BLE001 - best-effort
        pass
    yield
    # --- shutdown -------------------------------------------------------------------------
    # Backstop for any stop that ISN'T a signal (e.g. desktop's server.should_exit): flip the
    # flag so any still-open SSE stream ends, then stop the background work so teardown is idle.
    signal_shutdown()
    try:
        from ..store import stats_store
        stats_store.flush_all()
    except Exception:  # noqa: BLE001 - best-effort
        pass
    try:
        # Ask every child sweep to stop (cancel flag), let it flush partial data, then hard-stop
        # + reap any survivor — so no orphaned sweep process outlives the server.
        from ..enrich.price_runner import shutdown_sweeps
        shutdown_sweeps()
    except Exception:  # noqa: BLE001 - best-effort
        pass
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


def _is_loopback(host: str | None) -> bool:
    """True only for loopback clients (127.0.0.0/8, ::1, IPv4-mapped ::ffff:127.x)."""
    if not host:
        return False
    import ipaddress
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def create_app() -> FastAPI:
    app = FastAPI(title="data-occultist", version="0.1.0", lifespan=lifespan)

    # Defense-in-depth: this is a local teaching tool with no auth and full-traceback error
    # bodies. We default-bind to 127.0.0.1, but if someone binds 0.0.0.0 (or a proxy forwards
    # in), reject any request whose peer isn't loopback BEFORE it reaches a route. No headers
    # are trusted (X-Forwarded-For etc. are spoofable) — only the real TCP peer.
    from fastapi.responses import PlainTextResponse

    @app.middleware("http")
    async def _localhost_only(request: Request, call_next):  # noqa: ANN202
        if not _is_loopback(request.client.host if request.client else None):
            return PlainTextResponse("forbidden: localhost only", status_code=403)
        return await call_next(request)

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
    app.include_router(capture_backend.router)
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
    app.include_router(sources.router)
    app.include_router(sounds.router)
    app.include_router(dictionaries.router)
    app.include_router(pretty.router)
    app.include_router(events.router)
    app.include_router(video.router)
    app.include_router(bench.router)
    app.include_router(stats.router)
    app.include_router(screenshot.router)
    app.include_router(dbschema.router)
    app.include_router(dbbackup.router)
    # Serve the single-page front-end at root.
    app.mount("/", _RevalidateStatic(directory=str(_STATIC), html=True), name="static")
    return app


app = create_app()
