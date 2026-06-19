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

let game = null;
let stream = null;
let lastSeq = 0;            // last activity-log seq seen, so a reconnect's ?after= resumes the log
let retry = null;
const subs = new Set();
const flowSubs = new Set();
const logSubs = new Set();

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

// Point the bus at a game (opening or repointing the stream). Idempotent: a no-op when the
// stream is already open for the same game.
export function setGame(g) {
    if (g === game && stream) return;
    if (g !== game) lastSeq = 0;   // new game -> fresh log cursor
    game = g;
    open();
}

export function stop() { close(); }

function open() {
    close();
    if (!game) return;
    try {
        // ?after= carries the log cursor so a reconnect's backfill skips already-shown lines.
        stream = new EventSource(`/api/events/${encodeURIComponent(game)}?after=${lastSeq}`);
        stream.addEventListener("dataset", onMessage);
        stream.addEventListener("flow", onFlow);   // flow hops ride the SAME socket (one connection)
        stream.addEventListener("log", onLog);     // activity-log lines too — one socket for the page
        // A clean server-side window close (or transient drop) surfaces as `error`. Recreate the
        // source OURSELVES (not native auto-reconnect) so the URL picks up the fresh ?after=lastSeq
        // cursor — otherwise the log backfill refetches from the stale original and dupes.
        stream.addEventListener("error", onError);
        // (no work on "ready": streams reconnect often; each subscriber's fallback poll covers the gap)
    } catch { /* EventSource unavailable -> subscribers fall back to their own poll */ }
}

function onError() {
    if (stream) { try { stream.close(); } catch { /* */ } stream = null; }
    clearTimeout(retry); retry = setTimeout(open, 1500);
}

function close() {
    clearTimeout(retry); retry = null;
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
