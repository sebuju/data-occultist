"""Shared Server-Sent-Events streaming primitive.

Every SSE stream (dataset changes, graph flow hops, log-bar lines — all multiplexed on the
ONE :mod:`oc.web.routes.events` endpoint) is the SAME loop: emit a ``ready`` event, optionally
backfill, then forward bus events to the client until the connection drops, a bounded window
expires, OR the server shuts down. Only the per-event wire formatting (and the optional
backfill) differ, so that loop lives here ONCE and the route is a thin caller.

Crucially the loop races each wait against :func:`oc.web.shutdown.wait_shutdown`, so a
server-side shutdown ends the stream instantly instead of blocking uvicorn's connection
drain — no graceful-shutdown timeout needed. The bus runs on worker threads, so the
per-connection ``push`` bridges items onto the serving loop with ``call_soon_threadsafe``.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable

from fastapi import Request
from fastapi.responses import StreamingResponse

from .shutdown import is_shutting_down, wait_shutdown

# push one bus item onto the stream queue (threadsafe); subscribe wires a bus to it and
# returns an unsubscribe fn. format_fn turns one queued item into SSE wire text — it gets
# the live queue too, so a busy stream can coalesce a burst (see the dataset endpoint).
Push = Callable[[object], None]
Subscriber = Callable[[Push], Callable[[], None]]
Formatter = Callable[[object, "asyncio.Queue"], Awaitable[str]]

_WINDOW_S = 600.0   # backstop only — the client's EventSource auto-reconnects when it closes


def sse_response(request: Request, subscribe: Subscriber, format_fn: Formatter,
                 *, backfill: Callable[[], list] | None = None,
                 window_s: float = _WINDOW_S) -> StreamingResponse:
    """Build the standard short-lived ``text/event-stream`` response.

    ``subscribe`` is handed a threadsafe ``push`` and returns its unsubscribe. ``format_fn``
    renders one queued item (it may drain ``queue`` to coalesce). ``backfill`` (optional)
    yields items to replay before going live. The stream ends on client disconnect, window
    expiry, or server shutdown — whichever comes first."""
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()

    def push(item: object) -> None:
        loop.call_soon_threadsafe(queue.put_nowait, item)

    off = subscribe(push)

    async def gen():
        stop = asyncio.ensure_future(wait_shutdown())
        get: asyncio.Future | None = None
        try:
            yield "event: ready\ndata: {}\n\n"
            if backfill is not None:
                for item in backfill():
                    yield await format_fn(item, queue)
            deadline = loop.time() + window_s
            while loop.time() < deadline and not is_shutting_down():
                if await request.is_disconnected():
                    break
                if get is None:
                    get = asyncio.ensure_future(queue.get())
                done, _ = await asyncio.wait({get, stop}, timeout=1.0,
                                             return_when=asyncio.FIRST_COMPLETED)
                if stop in done:                 # shutdown — end now
                    break
                if get in done:
                    item = get.result()
                    get = None
                    yield await format_fn(item, queue)
                # else: idle tick — keep `get` pending, re-check disconnect/deadline/shutdown
        finally:
            stop.cancel()
            if get is not None:
                get.cancel()
            off()

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
