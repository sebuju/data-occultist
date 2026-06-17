"""Server-sent events: push backend activity-log lines (trigger watches/fires, external API
fetches) to the browser's log bar. Backed by the activity-log bus (:mod:`oc.eventlog`).

Short-lived like the dataset event stream (:mod:`.events`): a bounded window then close, so the
client's EventSource reconnects and no stream is immortal. On (re)connect the client passes the
last seq it saw (``?after=``) so the backfill skips lines it already showed.
"""

from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from ...eventlog import recent, subscribe

router = APIRouter(prefix="/api/log", tags=["log"])

_WINDOW_S = 600.0   # backstop; the client's EventSource auto-reconnects when the window closes


@router.get("/{game}")
async def stream(game: str, request: Request, after: int = 0):
    """A short-lived ``text/event-stream`` of activity-log lines for ``game`` (plus gameless
    lines). Each event is ``{seq, ts, msg, level}``; the client appends them to the log bar."""
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[dict] = asyncio.Queue()

    def on_event(ev: dict) -> None:
        if ev.get("game") in (None, game):
            loop.call_soon_threadsafe(queue.put_nowait, ev)   # bus runs on worker threads

    off = subscribe(on_event)

    async def gen():
        try:
            # backfill anything buffered since the client's last-seen seq, then go live
            for ev in recent(after_seq=after, game=game):
                yield f"event: log\ndata: {json.dumps(ev)}\n\n"
            deadline = loop.time() + _WINDOW_S
            while loop.time() < deadline:
                if await request.is_disconnected():
                    break
                try:
                    ev = await asyncio.wait_for(queue.get(), timeout=1.0)
                except asyncio.TimeoutError:
                    continue   # idle tick — re-check disconnect / deadline
                yield f"event: log\ndata: {json.dumps(ev)}\n\n"
        finally:
            off()

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
