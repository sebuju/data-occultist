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

from ...store.changes import subscribe
from ...store.flow_events import subscribe as subscribe_flow
from ..sse import sse_response

router = APIRouter(prefix="/api/events", tags=["events"])


@router.get("/{game}")
async def events(game: str, request: Request):
    """A short-lived ``text/event-stream`` of ``dataset`` change events for ``game``. The
    client refetches what it needs on each event (and on reconnect, via the ``ready`` event)."""

    def subscribe_fn(push):
        def on_change(g: str, dataset: str, records: list) -> None:
            if g == game:
                # carry the row count so the client can animate "n items flowed into this dataset"
                push((dataset, len(records or [])))
        return subscribe(on_change)

    async def fmt(first, queue: asyncio.Queue) -> str:
        # COALESCE a burst (a sweep/collection writes thousands of rows -> a flood of publishes):
        # drain ~1s and emit each changed dataset ONCE, summing the row counts so a heavy dataset
        # is refetched at most ~once/sec during a sweep.
        counts: dict[str, int] = {}
        ds, n = first
        counts[ds] = counts.get(ds, 0) + n
        await asyncio.sleep(1.0)
        while not queue.empty():
            ds, n = queue.get_nowait()
            counts[ds] = counts.get(ds, 0) + n
        return "".join(f"event: dataset\ndata: {json.dumps({'dataset': d, 'n': t})}\n\n"
                       for d, t in counts.items())

    return sse_response(request, subscribe_fn, fmt)


@router.get("/flow/{game}")
async def flow_events(game: str, request: Request):
    """A short-lived ``text/event-stream`` of FLOW events for ``game`` — one per real per-stage
    write (window->dataset, price->dataset, trigger->price, trigger->watch), carrying the item
    count. Drives the graph's blob animation. Unlike :func:`events`, these are NOT coalesced:
    every hop is a distinct animation, so each is forwarded as it arrives (a heavy sweep can
    burst, but the client caps blobs per event)."""

    def subscribe_fn(push):
        def on_flow(g: str, kind: str, src: str, dst: str, n: int) -> None:
            if g == game:
                push({"kind": kind, "src": src, "dst": dst, "n": n})
        return subscribe_flow(on_flow)

    async def fmt(ev, _queue) -> str:
        return f"event: flow\ndata: {json.dumps(ev)}\n\n"

    return sse_response(request, subscribe_fn, fmt)
