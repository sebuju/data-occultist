// bgtimer.js — drop-in setTimeout/clearTimeout backed by ONE shared Web Worker, so the scheduled
// callback fires on time even when the tab is backgrounded (main-thread setTimeout is throttled to
// ~1/min while hidden; a worker's timers are not — see bgtimer.worker.js). The callback still runs
// on the MAIN thread (the worker only posts the wake), so it may fetch and touch the DOM freely.
//
// The one unthrottled-timer primitive: any loop that must keep ticking while backgrounded schedules
// through here instead of setTimeout. Currently the live-tuning loop (livewin.js) is the only caller.
let worker = null;
let nextId = 1;
const cbs = new Map();   // id -> callback

function ensure() {
    if (worker) return worker;
    worker = new Worker(new URL("./bgtimer.worker.js", import.meta.url), { type: "module" });
    worker.onmessage = (e) => {
        const id = e.data && e.data.fire;
        if (id == null) return;
        const cb = cbs.get(id);
        cbs.delete(id);
        if (cb) { try { cb(); } catch { /* a bad callback must not kill the shared worker */ } }
    };
    return worker;
}

// Schedule `cb` after `ms` ms, returning a handle for bgClearTimeout. Fires even while backgrounded.
export function bgSetTimeout(cb, ms) {
    const id = nextId++;
    cbs.set(id, cb);
    ensure().postMessage({ arm: { id, ms } });
    return id;
}

// Cancel a pending bgSetTimeout. Safe with null / already-fired handles.
export function bgClearTimeout(id) {
    if (id == null) return;
    cbs.delete(id);
    if (worker) worker.postMessage({ cancel: id });
}
