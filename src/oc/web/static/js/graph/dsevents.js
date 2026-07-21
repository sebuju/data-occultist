// dsevents.js — the single dataset-change PUSH bus for the studio page.
//
// One EventSource to `GET /api/events/{game}` (the coalesced `dataset` stream off the store
// change bus) fans every "dataset X changed (+n rows)" out to all subscribers, so the page
// holds ONE connection no matter how many consumers care — node-view live refresh, the flow
// blob animation, and the Pretty data layer all ride this same bus instead of each opening
// their own EventSource to the same endpoint.
//
// This is the dataset-write twin of hub.js (which polls /api/activity for worker/device
// status). Server events are already coalesced ~1s per dataset, so a heavy sweep refetches a
// given dataset at most ~once/second; consumers debounce their own work on top.
//
// Lifecycle: opened/repointed by `setGame` (called from loadGame + Pretty's initData — both
// idempotent) and then kept open for the page's life, reconnecting on the server's short-lived
// stream. NO consumer closes it; a consumer that goes away just drops its subscription. The
// connection is cheap to hold and being always-on is what lets a view come and go without a
// gap. Subscribers must tolerate the brief reconnect window (each pairs this push with a slow
// fallback poll).

import * as api from "../api.js";
import * as conn from "../conn.js";

let game = null;
let stream = null;
let lastSeq = 0;            // last activity-log seq seen, so a reconnect's ?after= resumes the log
// Stable per-PAGE id sent as ?cid= on every (re)connect, so the server can attribute a "this
// viewer is hidden" report to this stream's activity pump (see events.py:_hidden_viewers). It
// must survive reconnects — a fresh id per socket would orphan the last report.
const cid = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));
let retry = null;
let downTimer = null;       // grace before declaring offline on a sustained stream failure
const subs = new Set();
const flowSubs = new Set();
const logSubs = new Set();
const activitySubs = new Set();
const fireSubs = new Set();

// Subscribe to every dataset change. `fn(dataset, n)` — the dataset id and the coalesced row
// count for this event. Returns an unsubscribe.
export function subscribe(fn) {
    subs.add(fn);
    return () => subs.delete(fn);
}

// Subscribe to FLOW hops, multiplexed on this SAME stream (no second EventSource — see the
// connection-pool note above). `fn(ev)` gets the parsed hop {kind,src,dst,n}. Returns unsubscribe.
export function subscribeFlow(fn) {
    flowSubs.add(fn);
    return () => flowSubs.delete(fn);
}

// Subscribe to activity-LOG lines, multiplexed on this SAME stream. `fn(ev)` gets the parsed
// line {seq,ts,msg,level}; cross-reconnect dedup (by seq) is handled here. Returns unsubscribe.
export function subscribeLog(fn) {
    logSubs.add(fn);
    return () => logSubs.delete(fn);
}

// Subscribe to the pushed ACTIVITY snapshot (worker/device/trigger status), multiplexed on this
// SAME stream — the push replacement for hub.js's old /api/activity poll, so it isn't timer-
// throttled when the tab is backgrounded. `fn(snap)` gets the full activity dict. Returns unsub.
export function subscribeActivity(fn) {
    activitySubs.add(fn);
    return () => activitySubs.delete(fn);
}

// Subscribe to instant trigger-FIRE cues, multiplexed on this SAME stream. `fn(ev)` gets the
// parsed cue {trigger}. Un-backfilled (see events.py) — only LIVE fires arrive, so a subscriber
// plays a sound without any replay-dedup guard; a fire lost in a rare reconnect gap is dropped
// (better than a late/double play for a live cue). Returns unsubscribe.
export function subscribeFire(fn) {
    fireSubs.add(fn);
    return () => fireSubs.delete(fn);
}

// Point the bus at a game (opening or repointing the stream). Idempotent: a no-op when the
// stream is already open for the same game.
export function setGame(g) {
    if (g === game && stream) return;
    if (g !== game) lastSeq = 0;   // new game -> fresh log cursor
    game = g;
    open();
}

export function stop() { close(); }

// This page's stream id.
export function clientId() { return cid; }

// Tell the server whether this viewer is on screen, so its activity pump can hold the idle
// cadence while nobody is looking (events.py:_hidden_viewers). This lives HERE, with the socket,
// because the server forgets the report when the stream drops — and this stream drops routinely
// (the 600s server-side window). So it must be re-sent on every open, not only when the DOM event
// fires; a hidden tab that rolled over a window would otherwise go fast again and never be told
// otherwise. hub.js owns only the repaint side (kick on unhide).
function reportVisibility() {
    api.activity.setVisible(cid, document.visibilityState !== "hidden");
}
if (typeof document !== "undefined") document.addEventListener("visibilitychange", reportVisibility);

function open() {
    close();
    if (!game) return;
    try {
        // ?after= carries the log cursor so a reconnect's backfill skips already-shown lines.
        stream = new EventSource(
            `/api/events/${encodeURIComponent(game)}?after=${lastSeq}&cid=${encodeURIComponent(cid)}`);
        stream.addEventListener("dataset", onMessage);
        stream.addEventListener("flow", onFlow);   // flow hops ride the SAME socket (one connection)
        stream.addEventListener("log", onLog);     // activity-log lines too — one socket for the page
        stream.addEventListener("activity", onActivity);   // worker/device status — one socket too
        stream.addEventListener("fire", onFire);   // instant trigger-fire sound cues — same socket
        stream.addEventListener("open", markOk);   // stream up -> we can reach the backend
        // A clean server-side window close (or transient drop) surfaces as `error`. Recreate the
        // source OURSELVES (not native auto-reconnect) so the URL picks up the fresh ?after=lastSeq
        // cursor — otherwise the log backfill refetches from the stale original and dupes.
        stream.addEventListener("error", onError);
        // (no work on "ready": streams reconnect often; each subscriber's fallback poll covers the gap)
    } catch { /* EventSource unavailable -> subscribers fall back to their own poll */ }
}

// The stream is the always-on liveness signal (it inherited that from the old hub poll). Any
// successful open/message proves the backend is reachable and cancels a pending offline verdict.
function markOk() {
    clearTimeout(downTimer); downTimer = null;
    conn.reportReachable();
    reportVisibility();   // fresh connection -> the server has no record of this viewer yet
}

function onError() {
    if (stream) { try { stream.close(); } catch { /* */ } stream = null; }
    // A clean 600s window close reconnects at once, so only a SUSTAINED failure means the server is
    // gone — arm a grace timer and declare offline only if no successful open lands first (no flap).
    if (!downTimer) downTimer = setTimeout(() => { downTimer = null; conn.reportUnreachable("event stream lost"); }, 5000);
    clearTimeout(retry); retry = setTimeout(open, 1500);
}

function close() {
    clearTimeout(retry); retry = null;
    clearTimeout(downTimer); downTimer = null;
    if (stream) { try { stream.close(); } catch { /* */ } stream = null; }
}

function onMessage(e) {
    let d;
    try { d = JSON.parse(e.data); } catch { return; }
    if (!d || !d.dataset) return;
    for (const fn of subs) { try { fn(d.dataset, d.n || 1); } catch { /* one bad subscriber must not stall the rest */ } }
}

function onFlow(e) {
    let d;
    try { d = JSON.parse(e.data); } catch { return; }
    for (const fn of flowSubs) { try { fn(d); } catch { /* one bad subscriber must not stall the rest */ } }
}

function onLog(e) {
    let ev;
    try { ev = JSON.parse(e.data); } catch { return; }
    if (ev.seq && ev.seq <= lastSeq) return;   // dedup across reconnects / backfill overlap
    if (ev.seq) lastSeq = ev.seq;
    for (const fn of logSubs) { try { fn(ev); } catch { /* one bad subscriber must not stall the rest */ } }
}

function onFire(e) {
    let d;
    try { d = JSON.parse(e.data); } catch { return; }
    for (const fn of fireSubs) { try { fn(d); } catch { /* one bad subscriber must not stall the rest */ } }
}

function onActivity(e) {
    markOk();   // a snapshot lands every ~2.5s even when idle -> keeps the reachable signal fresh
    let snap;
    try { snap = JSON.parse(e.data); } catch { return; }
    for (const fn of activitySubs) { try { fn(snap); } catch { /* one bad subscriber must not stall the rest */ } }
}
