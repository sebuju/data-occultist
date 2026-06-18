// Optimistic "X ago" ticker. ONE 1s interval re-paints every tracked element so relative
// labels advance second-by-second instead of jumping 2-3 at a time on the next poll/heartbeat
// (which reads jarring). Reconciles textContent only when it changes; auto-drops an element
// the moment it leaves the DOM, and stops the interval once nothing is tracked. Every "ago"
// label in the UI registers here rather than re-deriving its own clock — one shared primitive,
// not a per-caller ticker.

import { since } from "./datefmt.js";

const tracked = new Map();   // el -> { ts, fmt }
let timer = null;

function paint(el, rec) {
    const t = rec.fmt(since(rec.ts));
    if (el.textContent !== t) el.textContent = t;
}

function ensureTimer() {
    if (timer) return;
    timer = setInterval(() => {
        for (const [el, rec] of tracked) {
            if (!el.isConnected) { tracked.delete(el); continue; }   // gone from the DOM -> forget it
            paint(el, rec);
        }
        if (!tracked.size) { clearInterval(timer); timer = null; }
    }, 1000);
}

// Track `el` as a live "ago" label for source time `ts` (ms epoch or an iso/Date-parseable
// value). `fmt` wraps the relative string, e.g. `(s) => \`last fired ${s}\``. Paints at once.
// A static state (e.g. "never fired") is the caller's: pass that text itself and DON'T call
// this — call stopAgo to untrack a label that was previously live.
export function liveAgo(el, ts, fmt = (s) => s) {
    if (!el || ts == null) return;
    const rec = { ts, fmt };
    tracked.set(el, rec);
    paint(el, rec);
    ensureTimer();
}

// Untrack `el` (it's showing a static label now, or is being torn down).
export function stopAgo(el) { if (el) tracked.delete(el); }
