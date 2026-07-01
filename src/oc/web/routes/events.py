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
from ..deps import get_settings
from ..sse import sse_response
from .activity import build_activity

router = APIRouter(prefix="/api/events", tags=["events"])

# Activity keepalive cadence (seconds): fast while a worker runs, idle otherwise. Mirrors the
# old hub.js FAST/IDLE cadence — but with NO backgrounded penalty, because SSE isn't timer-
# throttled, so a hidden tab now stays as fresh as an idle foreground one (the whole point).
_ACT_FAST_S = 0.8
_ACT_IDLE_S = 2.5


def _act_busy(snap: dict) -> bool:
    """A worker is running -> keep the activity cadence fast (mirror ``hub.js:busy``)."""
    if not snap:
        return False
    if snap.get("precapture") or snap.get("live"):
        return True
    if snap.get("sweeps"):
        return True
    return any(x.get("running") for t in snap.get("triggers", []) for x in t.get("targets", []))


def _act_sig(snap: dict) -> str:
    """Change-signature for push dedup, EXCLUDING the per-second ``next_in`` countdown (else the
    snapshot churns every second and we'd push 1/s). Everything else — ``last_fired``, running
    flags, sweeps, precapture, live, ocr — is discrete state, so this pushes only on real change.
    The client interpolates ``next_in`` locally between the idle keepalives."""
    triggers = [{k: v for k, v in t.items() if k != "next_in"} for t in snap.get("triggers", [])]
    return json.dumps({**snap, "triggers": triggers}, sort_keys=True, default=str)


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

        # Activity is a POLLED aggregate (no event bus), so a per-connection task recomputes it and
        # pushes on change (+ an adaptive keepalive to refresh the countdown). This replaces the old
        # client-side hub.js poll: pushed over SSE, it isn't timer-throttled when the tab is hidden.
        async def pump_activity():
            last = None
            while True:
                try:
                    snap = build_activity(game, get_settings())
                except Exception:   # a transient build error must not kill the stream
                    await asyncio.sleep(_ACT_IDLE_S)
                    continue
                sig = _act_sig(snap)
                changed = sig != last
                last = sig
                # Always push (a keepalive) so the countdown + new-subscriber replay stay fresh;
                # run fast while a worker is busy or right after a change, idle otherwise. A fire
                # flips last_fired (in the signature) -> `changed` -> the follow-up ticks fast.
                push(("activity", snap))
                await asyncio.sleep(_ACT_FAST_S if (changed or _act_busy(snap)) else _ACT_IDLE_S)

        task = asyncio.ensure_future(pump_activity())
        offs = [subscribe(on_change), subscribe_flow(on_flow), subscribe_log(on_log)]
        return lambda: (task.cancel(), [off() for off in offs])

    async def fmt(first, queue: asyncio.Queue) -> str:
        tag, payload = first
        if tag == "flow":
            return f"event: flow\ndata: {json.dumps(payload)}\n\n"
        if tag == "log":
            return f"event: log\ndata: {json.dumps(payload)}\n\n"
        if tag == "activity":
            return f"event: activity\ndata: {json.dumps(payload, default=str)}\n\n"
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
