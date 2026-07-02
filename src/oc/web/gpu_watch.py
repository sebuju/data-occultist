"""Auto-release the GPU OCR session when nobody is listening.

The OCR model stays resident for the life of the process so reads are instant while
the UI is up — but once the front end is gone there is no one to read for, and a GPU
session keeps holding its CUDA arena (VRAM the game could use). A lifespan watchdog
drops the GPU session when BOTH have been true for a grace period:

* no front-end SSE connection (the page holds exactly ONE events socket, so zero
  connections == no page is listening; the socket's 600s window re-connects in
  milliseconds, far inside the grace), and
* OCR is idle — nothing holds the OCR lock now, nothing took it recently, and no
  server-side worker (precapture / live collection) is running that could want it
  between frames.

Release is the same lazy lifecycle as the manual button (``POST /api/ocr/release``):
the next read rebuilds the model, so a returning page just pays one model load.
"""

from __future__ import annotations

import asyncio
import threading
import time

# Both gates use the same grace: the front end must be gone this long AND OCR must
# have been idle this long. Long enough that an SSE reconnect gap or a burst of
# back-to-back reads never trips it; short enough that closing the tab actually
# frees the VRAM promptly.
GRACE_S = 30.0
_POLL_S = 10.0

_lock = threading.Lock()
_clients = 0
_last_client = time.monotonic()   # when the last client disconnected (or process start)


def client_connected() -> None:
    global _clients
    with _lock:
        _clients += 1


def client_disconnected() -> None:
    global _clients, _last_client
    with _lock:
        _clients = max(0, _clients - 1)
        _last_client = time.monotonic()


def frontend_gone_for() -> float:
    """Seconds since the last front-end SSE connection closed; 0.0 while any is open."""
    with _lock:
        return 0.0 if _clients else time.monotonic() - _last_client


def _maybe_release() -> None:
    """One watchdog tick: drop the GPU session iff every gate agrees. Runs off-loop."""
    # imports deferred: this module is imported by routes and must stay cycle-free
    from ..eventlog import publish
    from ..ocr.serialize import OCR_LOCK, ocr_idle_for
    from .deps import get_engine
    from .routes.live import any_running as live_running
    from .routes.precapture import any_running as precapture_running

    if frontend_gone_for() < GRACE_S or ocr_idle_for() < GRACE_S:
        return
    ocr = get_engine().ocr
    if not getattr(ocr, "gpu_active", False) or not hasattr(ocr, "release"):
        return
    # a running worker may be between frames (lock momentarily free) — don't yank
    # its model out from under it, that would just thrash release/rebuild
    if precapture_running() or live_running():
        return
    # hold the OCR lock across the drop so no inference can be in flight mid-release
    if not OCR_LOCK.acquire(blocking=False):
        return
    try:
        ocr.release()
    finally:
        OCR_LOCK.release()
    publish("GPU OCR session auto-released (front end closed, OCR idle)")


async def _run() -> None:
    from .shutdown import is_shutting_down, wait_shutdown

    stop = asyncio.ensure_future(wait_shutdown())
    try:
        while not is_shutting_down():
            done, _ = await asyncio.wait({stop}, timeout=_POLL_S)
            if stop in done:
                break
            try:
                # gc.collect inside release can take a beat — keep it off the event loop
                await asyncio.to_thread(_maybe_release)
            except Exception:  # noqa: BLE001 - the watchdog must never die
                pass
    finally:
        stop.cancel()


def start() -> None:
    """Start the watchdog on the running loop (called from the app lifespan)."""
    asyncio.ensure_future(_run())
