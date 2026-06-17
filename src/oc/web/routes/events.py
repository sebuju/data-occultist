"""Server-sent events: push dataset changes to the browser so the Pretty UI + node view
update the instant a dataset is written — from any source — instead of polling. Backed by the
dataset change bus (:mod:`oc.store.changes`).

Each connection is intentionally SHORT-LIVED (a bounded window), then closed so the client's
EventSource auto-reconnects. That keeps a long stream from blocking server shutdown/reload,
and a disconnect check frees the connection promptly when a tab closes.
"""

from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from ...store.changes import subscribe

router = APIRouter(prefix="/api/events", tags=["events"])

_WINDOW_S = 600.0   # backstop only. The REAL shutdown fix is uvicorn timeout_graceful_shutdown
#                     (force-cancels the stream task) set in cli/edit.py; this just guarantees no
#                     stream is truly immortal. The client's EventSource auto-reconnects.


@router.get("/{game}")
async def events(game: str, request: Request):
    """A short-lived ``text/event-stream`` of ``dataset`` change events for ``game``. The
    client refetches what it needs on each event (and on reconnect, via the ``ready`` event)."""
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[str] = asyncio.Queue()

    def on_change(g: str, dataset: str, _records: list) -> None:
        if g == game:
            loop.call_soon_threadsafe(queue.put_nowait, dataset)   # bus runs on worker threads

    off = subscribe(on_change)

    async def gen():
        try:
            yield "event: ready\ndata: {}\n\n"
            deadline = loop.time() + _WINDOW_S
            while loop.time() < deadline:
                if await request.is_disconnected():
                    break
                try:
                    first = await asyncio.wait_for(queue.get(), timeout=1.0)
                except asyncio.TimeoutError:
                    continue   # idle tick — re-check disconnect / deadline
                # COALESCE a burst (a sweep/collection writes thousands of rows -> a flood of
                # publishes): drain ~1s and emit each changed dataset ONCE, so the client refetches
                # a heavy dataset at most ~once/sec during a sweep instead of per burst.
                batch = {first}
                await asyncio.sleep(1.0)
                while not queue.empty():
                    batch.add(queue.get_nowait())
                for dataset in batch:
                    yield f"event: dataset\ndata: {json.dumps({'dataset': dataset})}\n\n"
        finally:
            off()

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
