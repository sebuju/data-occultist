"""Server-sent events: push dataset changes to the browser so the Pretty UI + node view
update the instant a dataset is written — from any source — instead of polling. Backed by the
dataset change bus (:mod:`oc.store.changes`).

Each connection is intentionally SHORT-LIVED (a bounded window), then closed so the client's
EventSource auto-reconnects. The shared :func:`oc.web.sse.sse_response` primitive also ends the
stream the instant the server shuts down, so a long stream never blocks shutdown/reload.
"""

from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, Request

from ...eventlog import recent as log_recent, subscribe as subscribe_log
from ...store.changes import subscribe
from ...store.flow_events import subscribe as subscribe_flow
from ..sse import sse_response

router = APIRouter(prefix="/api/events", tags=["events"])


@router.get("/{game}")
async def events(game: str, request: Request, after: int = 0):
    """A short-lived ``text/event-stream`` MULTIPLEXING every event kind for ``game`` over ONE
    connection — so the whole page holds a SINGLE SSE socket, not one per kind. The browser caps
    ~6 connections per host; each extra always-on stream permanently eats one and starves plain
    GETs (the window image waited seconds behind a saturated pool). Queued items are tagged
    ``("dataset"|"flow"|"log", payload)``:

    * ``dataset`` — store change-bus writes, COALESCED ~1s (a sweep writes thousands of rows ->
      a flood of publishes; emit each changed dataset once/sec, summing row counts). Client
      refetches what it needs per event (and on reconnect, via ``ready``).
    * ``flow`` — one per real per-stage write (window->dataset, price->dataset, trigger->price,
      trigger->watch), NOT coalesced: every hop is a distinct blob animation, forwarded as it
      arrives (the client caps blobs per event).
    * ``log`` — activity-log lines (trigger watch/fire, external API fetches). ``?after=`` is the
      last seq the client saw; backfill replays lines since it (skips already-shown) before going
      live, so reconnects don't drop or duplicate lines."""

    def subscribe_fn(push):
        def on_change(g: str, dataset: str, records: list) -> None:
            if g == game:
                # carry the row count so the client can animate "n items flowed into this dataset"
                push(("dataset", (dataset, len(records or []))))
        def on_flow(g: str, kind: str, src: str, dst: str, n: int) -> None:
            if g == game:
                push(("flow", {"kind": kind, "src": src, "dst": dst, "n": n}))
        def on_log(ev: dict) -> None:
            if ev.get("game") in (None, game):
                push(("log", ev))
        offs = [subscribe(on_change), subscribe_flow(on_flow), subscribe_log(on_log)]
        return lambda: [off() for off in offs]

    async def fmt(first, queue: asyncio.Queue) -> str:
        tag, payload = first
        if tag == "flow":
            return f"event: flow\ndata: {json.dumps(payload)}\n\n"
        if tag == "log":
            return f"event: log\ndata: {json.dumps(payload)}\n\n"
        # dataset: coalesce a ~1s burst, but DON'T swallow flow/log items sharing the queue —
        # defer and re-queue them so the next loop iteration emits each (delayed at most one batch).
        counts: dict[str, int] = {}
        ds, n = payload
        counts[ds] = counts.get(ds, 0) + n
        await asyncio.sleep(1.0)
        deferred = []
        while not queue.empty():
            item = queue.get_nowait()
            if item[0] == "dataset":
                d, m = item[1]
                counts[d] = counts.get(d, 0) + m
            else:
                deferred.append(item)
        for item in deferred:
            queue.put_nowait(item)
        return "".join(f"event: dataset\ndata: {json.dumps({'dataset': d, 'n': t})}\n\n"
                       for d, t in counts.items())

    # backfill buffered log lines since the client's last-seen seq, then go live
    return sse_response(request, subscribe_fn, fmt,
                        backfill=lambda: [("log", ev) for ev in log_recent(after_seq=after, game=game)])
