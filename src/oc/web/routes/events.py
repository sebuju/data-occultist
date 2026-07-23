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
import time

from fastapi import APIRouter, Request

from ...eventlog import recent as log_recent, subscribe as subscribe_log
from ...store.changes import subscribe
from ...store.fire_events import subscribe as subscribe_fire
from ...store.flow_events import subscribe as subscribe_flow
from .. import gpu_watch
from ..deps import get_settings
from ..sse import sse_response
from .activity import build_activity

router = APIRouter(prefix="/api/events", tags=["events"])

# Activity keepalive cadence (seconds): fast while a worker runs, idle otherwise. The fast beat
# is paced to just outrun the collector's readout production (``tuning.gate_interval`` = 0.25s,
# see collector._ocr_due) so a fresh live value ships on the next beat instead of waiting out a
# slower keepalive — the push, not the OCR loop, was the node view's bottleneck.
_ACT_FAST_S = 0.2
_ACT_IDLE_S = 2.5

# Connections whose viewer reported itself HIDDEN (``?cid=`` -> ``POST /api/events/visible``).
#
# SSE isn't timer-throttled when a tab is backgrounded, which is why the heartbeat was moved onto
# this stream in the first place — a hidden tab is the NORM here (the game must be foregrounded).
# But "keeps beating" no longer has to mean "beats FAST": the one thing that genuinely can't wait
# for a beat, the trigger-fire sound cue, rides its own instant ``fire`` channel now, and the
# history rings are server-side and shipped whole (see collect/readout_history.py), so a skipped
# beat loses no data — it only delays a repaint nobody is looking at. So a hidden viewer drops to
# the idle cadence, and unhiding repaints at once via ``hub.kick()``'s one-off GET.
#
# Membership only — an unknown cid counts as VISIBLE, so an old client, a dropped POST, or a
# browser without occlusion detection fails SAFE (fast) rather than silently stale.
_hidden_viewers: set[str] = set()


@router.post("/visible")
def set_viewer_visible(cid: str, visible: bool = True) -> dict:
    """Report whether the viewer holding stream ``cid`` is on screen. Called by ``hub.js`` on
    ``visibilitychange`` — one event, no poll."""
    if not cid:              # a cid-less stream is the fail-safe (visible) case; never mark it
        return {"cid": cid, "visible": True}
    if visible:
        _hidden_viewers.discard(cid)
    else:
        _hidden_viewers.add(cid)
    return {"cid": cid, "visible": visible}


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
async def events(game: str, request: Request, after: int = 0, cid: str = ""):
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
      live, so reconnects don't drop or duplicate lines.

    ``?cid=`` identifies this viewer so it can report itself hidden and slow its own activity
    beat — see ``_hidden_viewers``."""

    def subscribe_fn(push):
        # this ONE socket is the page's liveness signal: while any is open a front end
        # is listening, and the GPU watchdog leaves the OCR session alone
        gpu_watch.client_connected()

        def on_change(g: str, dataset: str, records: list, data_changed: bool = True,
                      batch: int | None = None) -> None:
            if g == game:
                # carry the row count so the client can animate "n items flowed into this dataset"
                push(("dataset", (dataset, len(records or []))))
        def on_flow(g: str, kind: str, src: str, dst: str, n: int) -> None:
            if g == game:
                push(("flow", {"kind": kind, "src": src, "dst": dst, "n": n}))
        def on_log(ev: dict) -> None:
            # file_only events (routes/logbar.py's /emit — client-only diagnostics with no
            # server origin) are persisted to the log file by their own bus subscriber but
            # never streamed back: the browser that published one already shows it locally,
            # so echoing it over SSE would double it up.
            if ev.get("game") in (None, game) and not ev.get("file_only"):
                push(("log", ev))
        def on_fire(g: str, trigger_id: str, sounds: list) -> None:
            # a live, un-backfilled cue -> the browser plays these sound nodes at once. ``sounds`` is
            # the router-selected / direct sound ids; empty -> the client plays the trigger's own.
            if g == game:
                push(("fire", {"trigger": trigger_id, "sounds": sounds}))

        # Activity is a POLLED aggregate (no event bus), so a per-connection task recomputes it at
        # the fast/idle cadence and pushes only when it actually changed (+ an _ACT_IDLE_S
        # keepalive). This replaces the old client-side hub.js poll: pushed over SSE, it isn't
        # timer-throttled when the tab is hidden.
        async def pump_activity():
            last = None
            last_push = float("-inf")
            while True:
                try:
                    # build_activity reads disk (sweep sidecars, session status, schedules); at
                    # this cadence that's steady on-loop I/O, so run it OFF the event loop.
                    snap = await asyncio.to_thread(build_activity, game, get_settings())
                except Exception:   # a transient build error must not kill the stream
                    await asyncio.sleep(_ACT_IDLE_S)
                    continue
                sig = _act_sig(snap)
                changed = sig != last
                last = sig
                # Push on real CHANGE only, plus a keepalive no slower than _ACT_IDLE_S. The loop
                # rate is the CHECK rate, not the wire rate: at the fast cadence an unconditional
                # push would ship several fat snapshots/sec (they carry the producer/readout/
                # register/process history rings) and run every hub subscriber's reconcile pass
                # that often, for no new information. Safe to skip a beat because `_act_sig`
                # excludes the per-second `next_in` countdown and the client interpolates it
                # locally (ago.js), and a newly-opened panel is seeded by hub.kick()'s one-off
                # GET, not by this stream. A fire flips last_fired (in the signature) -> pushes
                # immediately, and the follow-up ticks fast.
                now = time.monotonic()
                if changed or (now - last_push) >= _ACT_IDLE_S:
                    push(("activity", snap))
                    last_push = now
                # A hidden viewer holds the idle cadence even while a worker runs: the fast beat
                # only buys repaint latency, and there is nothing on screen to repaint.
                fast = (changed or _act_busy(snap)) and cid not in _hidden_viewers
                await asyncio.sleep(_ACT_FAST_S if fast else _ACT_IDLE_S)

        task = asyncio.ensure_future(pump_activity())
        offs = [subscribe(on_change), subscribe_flow(on_flow), subscribe_log(on_log),
                subscribe_fire(on_fire)]
        return lambda: (gpu_watch.client_disconnected(), task.cancel(), [off() for off in offs],
                        _hidden_viewers.discard(cid))   # this viewer is gone -> don't leak its cid

    async def fmt(first, queue: asyncio.Queue) -> str:
        tag, payload = first
        if tag == "flow":
            return f"event: flow\ndata: {json.dumps(payload)}\n\n"
        if tag == "log":
            return f"event: log\ndata: {json.dumps(payload)}\n\n"
        if tag == "fire":
            return f"event: fire\ndata: {json.dumps(payload)}\n\n"
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
                        backfill=lambda: [("log", ev) for ev in log_recent(after_seq=after, game=game)
                                          if not ev.get("file_only")])
