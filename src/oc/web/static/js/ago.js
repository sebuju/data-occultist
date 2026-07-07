// Optimistic live tickers. ONE 1s interval re-paints every tracked element so relative labels
// advance second-by-second instead of jumping 2-3 at a time on the next poll/heartbeat (which
// reads jarring). Two flavours share the one interval:
//   • liveAgo   — an elapsed "X ago" label off a past timestamp (last-fired, backup age).
//   • liveUntil — a FUTURE countdown ("next in: X") off a remaining-seconds value.
// Both reconcile textContent only when it changes; auto-drop an element the moment it leaves the
// DOM, and stop the interval once nothing is tracked. Every ticking label registers here rather
// than re-deriving its own clock — one shared primitive, not a per-caller ticker.

import { since, countdown } from "./datefmt.js";

const trackedAgo = new Map();     // el -> { ts, fmt }
const trackedUntil = new Map();   // el -> { deadline, fmt }
let timer = null;

function paintAgo(el, rec) {
    const t = rec.fmt(since(rec.ts));
    if (el.textContent !== t) el.textContent = t;
}

function paintUntil(el, rec) {
    const rem = Math.max(0, (rec.deadline - Date.now()) / 1000);
    const t = rec.fmt(countdown(rem), rem);
    if (el.textContent !== t) el.textContent = t;
}

function ensureTimer() {
    if (timer) return;
    timer = setInterval(() => {
        for (const [el, rec] of trackedAgo) {
            if (!el.isConnected) { trackedAgo.delete(el); continue; }
            paintAgo(el, rec);
        }
        for (const [el, rec] of trackedUntil) {
            if (!el.isConnected) { trackedUntil.delete(el); continue; }
            paintUntil(el, rec);
        }
        if (!trackedAgo.size && !trackedUntil.size) { clearInterval(timer); timer = null; }
    }, 1000);
}

// Track `el` as a live "ago" label for source time `ts` (ms epoch or an iso/Date-parseable
// value). `fmt` wraps the relative string, e.g. `(s) => \`last fired ${s}\``. Paints at once.
// A static state (e.g. "never fired") is the caller's: pass that text itself and DON'T call
// this — call stopAgo to untrack a label that was previously live.
export function liveAgo(el, ts, fmt = (s) => s) {
    if (!el || ts == null) return;
    trackedUntil.delete(el);   // an element is one kind at a time
    const rec = { ts, fmt };
    trackedAgo.set(el, rec);
    paintAgo(el, rec);
    ensureTimer();
}

// Track `el` as a live FUTURE countdown: `secs` is seconds-remaining as of NOW (server's snapshot).
// Re-registering each heartbeat re-syncs the deadline (kills drift). `fmt(str, remSecs)` renders it,
// e.g. `(s, r) => r <= 0 ? "due…" : \`idle (next in: ${s})\``. Paints at once.
export function liveUntil(el, secs, fmt = (s) => s) {
    if (!el || secs == null) return;
    trackedAgo.delete(el);
    const rec = { deadline: Date.now() + secs * 1000, fmt };
    trackedUntil.set(el, rec);
    paintUntil(el, rec);
    ensureTimer();
}

// Untrack `el` (it's showing a static label now, or is being torn down).
export function stopAgo(el) { if (el) { trackedAgo.delete(el); trackedUntil.delete(el); } }
