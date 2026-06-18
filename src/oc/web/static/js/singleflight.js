// singleFlight(key, fn) — run an async `fn` per `key` at most once at a time, but NEVER drop a
// call that arrives mid-flight: it re-runs ONCE after the current run finishes, collapsing any
// number of overlapping calls into a single trailing run.
//
// This is the "...Again" idiom (detectAgain / previewAgain / itemReadAgain, and refreshLive's
// own flag) hoisted into one primitive. The trailing run is what makes a
// push-driven refresh correct: the LAST event of a burst (e.g. the final write of an async price
// sweep) often lands while the previous fetch is still in flight — a bare `if (inFlight) return`
// drops it and strands the final data until some later unrelated refresh. Here it always re-runs.
//
// `fn` is invoked with no args and may be async; its result/rejection is swallowed (callers own
// their own error handling). Keys are independent — work on different keys runs concurrently.

const _inflight = new Set();
const _again = new Map();   // key -> the LATEST fn requested while busy (run once when the current ends)

export function singleFlight(key, fn) {
    if (_inflight.has(key)) { _again.set(key, fn); return; }   // busy -> remember the latest request
    _inflight.add(key);
    Promise.resolve().then(fn).catch(() => {}).finally(() => {
        _inflight.delete(key);
        const next = _again.get(key);
        if (next) { _again.delete(key); singleFlight(key, next); }   // a call arrived mid-flight -> run it now
    });
}
