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
// `fn` is invoked as `fn({ superseded })` and may be async; its result/rejection is swallowed
// (callers own their own error handling). Keys are independent — work on different keys runs
// concurrently.
//
// `superseded()` tells a running `fn` whether a newer call for the same key is ALREADY queued to
// run right after it — i.e. this run's result is about to be stale. There's no cancellation here
// (the fetch already in flight still completes), but a `fn` that checks `superseded()` right
// before its DOM write can SKIP that write and let the trailing rerun paint the fresh result
// instead, closing the "stale response paints, then gets overwritten a beat later" flash every
// singleFlight consumer otherwise has. Callers that ignore the arg behave exactly as before.
//
// Returns a PROMISE that settles when THIS caller's work is done: the non-busy (first) caller gets
// the real run's promise; a caller that arrived mid-flight gets a promise resolved once its trailing
// rerun finishes. That matters for anything that shows a "loading" state while it waits — resolving
// the busy branch immediately (as this used to) lifted the spinner while the caller's own refresh
// hadn't even started, so the node stopped looking busy a beat before its content updated.

const _inflight = new Map();   // key -> Promise of the currently running fn
const _again = new Map();      // key -> { fn, waiters } — the LATEST request made while busy (run once when the current ends)

export function singleFlight(key, fn) {
    if (_inflight.has(key)) {                                    // busy -> remember the latest request…
        const q = _again.get(key) || { fn: null, waiters: [] };
        q.fn = fn; _again.set(key, q);
        return new Promise((resolve) => q.waiters.push(resolve));   // …and settle this caller when it has run
    }
    const superseded = () => _again.has(key);
    const p = Promise.resolve().then(() => fn({ superseded })).catch(() => {}).finally(() => {
        _inflight.delete(key);
        const q = _again.get(key);
        if (!q) return;
        _again.delete(key);
        // a call arrived mid-flight -> run it now, then release everyone who waited on it. The
        // `.then` is deliberately NOT returned: `p` (this run's caller) must not be held open by
        // a rerun it never asked for.
        singleFlight(key, q.fn).then(() => q.waiters.forEach((r) => r()));
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
