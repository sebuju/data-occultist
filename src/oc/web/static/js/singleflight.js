// singleFlight(key, fn) — run an async `fn` per `key` at most once at a time, but NEVER drop a
// call that arrives mid-flight: it re-runs ONCE after the current run finishes, collapsing any
// number of overlapping calls into a single trailing run.
//
// This is the "...Again" idiom (window detect/preview/rule-trace/readout reads in imaging.js,
// subset/data-node/source-preview refreshes, refreshLive's own flag) hoisted into one primitive
// so every copy gets a trailing rerun for free instead of re-deriving it per feature. The trailing
// run is what makes a
// push-driven refresh correct: the LAST event of a burst (e.g. the final write of an async price
// sweep) often lands while the previous fetch is still in flight — a bare `if (inFlight) return`
// drops it and strands the final data until some later unrelated refresh. Here it always re-runs.
//
// `fn` is invoked with no args and may be async; its result/rejection is swallowed (callers own
// their own error handling). Keys are independent — work on different keys runs concurrently.
//
// Returns the PROMISE of the run it started: the non-busy (first) caller gets the real run's
// promise, so it can `await` its own work finishing — the busy branch resolves immediately
// (mirrors calling this while a bespoke "Busy/Again" copy is mid-flight: that always returned
// right away too, without waiting for the trailing rerun).

const _inflight = new Map();   // key -> Promise of the currently running fn
const _again = new Map();      // key -> the LATEST fn requested while busy (run once when the current ends)

export function singleFlight(key, fn) {
    if (_inflight.has(key)) { _again.set(key, fn); return Promise.resolve(); }   // busy -> remember the latest request
    const p = Promise.resolve().then(fn).catch(() => {}).finally(() => {
        _inflight.delete(key);
        const next = _again.get(key);
        if (next) { _again.delete(key); singleFlight(key, next); }   // a call arrived mid-flight -> run it now
    });
    _inflight.set(key, p);
    return p;
}

// How many keys with the given prefix are currently in flight or queued for a trailing rerun —
// e.g. the boot veil polls this (scoped to "det:"/"prev:") to know when a boot OCR fan-out has
// fully drained, not just momentarily empty between two reads (see bootSettle in main.js).
export function pendingCount(prefix) {
    let n = 0;
    for (const k of _inflight.keys()) if (k.startsWith(prefix)) n++;
    for (const k of _again.keys()) if (k.startsWith(prefix)) n++;
    return n;
}
