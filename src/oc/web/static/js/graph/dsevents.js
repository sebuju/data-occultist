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
const subs = new Set();

// Subscribe to every dataset change. `fn(dataset, n)` — the dataset id and the coalesced row
// count for this event. Returns an unsubscribe.
export function subscribe(fn) {
    subs.add(fn);
    return () => subs.delete(fn);
}

// Point the bus at a game (opening or repointing the stream). Idempotent: a no-op when the
// stream is already open for the same game.
export function setGame(g) {
    if (g === game && stream) return;
    game = g;
    open();
}

export function stop() { close(); }

function open() {
    close();
    if (!game) return;
    try {
        stream = new EventSource(`/api/events/${encodeURIComponent(game)}`);
        stream.addEventListener("dataset", onMessage);
        // (no work on "ready": streams reconnect often; each subscriber's fallback poll covers the gap)
    } catch { /* EventSource unavailable -> subscribers fall back to their own poll */ }
}

function close() {
    if (stream) { try { stream.close(); } catch { /* */ } stream = null; }
}

function onMessage(e) {
    let d;
    try { d = JSON.parse(e.data); } catch { return; }
    if (!d || !d.dataset) return;
    for (const fn of subs) { try { fn(d.dataset, d.n || 1); } catch { /* one bad subscriber must not stall the rest */ } }
}
