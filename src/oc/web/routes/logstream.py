"""Server-sent events: push backend activity-log lines (trigger watches/fires, external API
fetches) to the browser's log bar. Backed by the activity-log bus (:mod:`oc.eventlog`).

Short-lived like the dataset event stream (:mod:`.events`): a bounded window then close, so the
client's EventSource reconnects and no stream is immortal (and the shared primitive ends it at
once on server shutdown). On (re)connect the client passes the last seq it saw (``?after=``) so
the backfill skips lines it already showed.
"""

from __future__ import annotations

import json

from fastapi import APIRouter, Request

from ...eventlog import recent, subscribe
from ..sse import sse_response

router = APIRouter(prefix="/api/log", tags=["log"])


@router.get("/{game}")
async def stream(game: str, request: Request, after: int = 0):
    """A short-lived ``text/event-stream`` of activity-log lines for ``game`` (plus gameless
    lines). Each event is ``{seq, ts, msg, level}``; the client appends them to the log bar."""

    def subscribe_fn(push):
        def on_event(ev: dict) -> None:
            if ev.get("game") in (None, game):
                push(ev)
        return subscribe(on_event)

    async def fmt(ev, _queue) -> str:
        return f"event: log\ndata: {json.dumps(ev)}\n\n"

    # backfill anything buffered since the client's last-seen seq, then go live
    return sse_response(request, subscribe_fn, fmt,
                        backfill=lambda: recent(after_seq=after, game=game))
