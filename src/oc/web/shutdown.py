"""Process-wide shutdown signal — the ONE source of truth for "the server is going down".

Long-lived SSE streams (:mod:`oc.web.sse`) and the trigger scheduler watch this so they
stop the instant shutdown begins. The point: the server tears down its OWN streams rather
than waiting for the client to disconnect (which never happens on a server-side Ctrl+C /
reload — the browser tab is still open). With the streams self-closing, uvicorn's
connection drain finishes immediately, so NO graceful-shutdown timeout is needed.

It is set from a chained signal handler (so it fires BEFORE uvicorn waits for connections)
and again from the lifespan shutdown as a backstop for non-signal stops (e.g. desktop's
``server.should_exit``). Safe to call from any thread / a signal handler.
"""

from __future__ import annotations

import asyncio
import threading

_flag = threading.Event()                            # sync mirror for non-async watchers
_loop: asyncio.AbstractEventLoop | None = None
_event: asyncio.Event | None = None


def bind_loop(loop: asyncio.AbstractEventLoop) -> None:
    """Capture the serving loop and create the :class:`asyncio.Event` on it. Call once from
    the lifespan startup (which runs on that loop)."""
    global _loop, _event
    _loop = loop
    _event = asyncio.Event()
    if _flag.is_set():               # shutdown already raced ahead of bind — reflect it
        _event.set()


def signal_shutdown() -> None:
    """Mark the process as shutting down. Threadsafe; safe from a signal handler. Wakes the
    serving loop so every awaiting stream resolves at once."""
    _flag.set()
    loop, event = _loop, _event
    if loop is not None and event is not None:
        try:
            loop.call_soon_threadsafe(event.set)
        except RuntimeError:         # loop already closed — nothing left to wake
            pass


def is_shutting_down() -> bool:
    return _flag.is_set()


async def wait_shutdown() -> None:
    """Resolve once shutdown is signalled (immediately if already down). Falls back to
    polling the sync flag if no loop has been bound (e.g. in a unit test)."""
    if _flag.is_set():
        return
    if _event is None:
        while not _flag.is_set():
            await asyncio.sleep(0.2)
        return
    await _event.wait()
