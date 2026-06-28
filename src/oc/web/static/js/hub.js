// hub.js — the single backend HEARTBEAT.
//
// One adaptive timer polls `GET /api/activity/{game}` and fans the snapshot out to
// every subscriber, so the UI hits the server ONCE per tick no matter how many panels
// are open. It replaces the per-consumer status pollers (tasks panel, precapture
// indicator, kill-GPU button). Latency-bound OCR loops — live detect (200ms) and video
// stepping — stay separate by design: they are per-frame work, not status heartbeats.
//
// Cadence is adaptive and self-throttling:
//   * a worker is running (a sweep, the precapture worker, a firing trigger) -> FAST,
//   * the tab is backgrounded -> SLOW (nothing to watch closely),
//   * otherwise -> IDLE, just enough to keep the device/trigger state fresh.
// tfetch (api.js) already reports every outcome to conn.js, so being always-on doubles
// as the connectivity signal — no separate health ping needed while online.
import * as api from "./api.js";
import * as conn from "./conn.js";

const FAST_MS = 800;     // a worker is running -> keep the UI responsive
const IDLE_MS = 3000;    // foreground, nothing running -> keep state fresh
const BG_MS = 15000;     // backgrounded -> barely tick

let timer = null;
let inFlight = false;
let gameFn = () => null;   // supplied by the app so the hub always polls the current game
let last = null;           // most recent snapshot, replayed to new subscribers
const subs = new Set();

// Wire the current-game accessor once at startup.
export function init(getGame) { if (getGame) gameFn = getGame; }

// The latest snapshot (or null before the first beat).
export function latest() { return last; }

// Subscribe to every heartbeat snapshot. Fires IMMEDIATELY with the last snapshot (if
// any) so a freshly-opened panel paints without waiting a full tick. Returns unsubscribe.
export function subscribe(fn) {
    subs.add(fn);
    if (last) { try { fn(last); } catch { /* ignore */ } }
    return () => subs.delete(fn);
}

function busy(s) {
    if (!s) return false;
    if (s.precapture) return true;
    if (s.live) return true;
    if (s.sweeps && s.sweeps.length) return true;
    if (s.triggers && s.triggers.some((t) => (t.targets || []).some((x) => x.running))) return true;
    return false;
}

function nextDelay() {
    if (busy(last)) return FAST_MS;
    if (typeof document !== "undefined" && !document.hasFocus()) return BG_MS;
    return IDLE_MS;
}

let pendingKick = false;   // a kick() arrived mid-beat -> beat again the instant this one ends

async function tick() {
    timer = null;
    const game = gameFn();
    if (game && conn.isOnline() && !inFlight) {
        inFlight = true;
        try {
            const snap = await api.activity.get(game);
            last = snap;
            for (const fn of subs) { try { fn(snap); } catch { /* a bad subscriber must not stall the others */ } }
        } catch { /* tfetch already told conn; just retry on the next beat */ }
        finally { inFlight = false; }
    }
    // A kick that landed while the fetch was in flight (e.g. toggling live mode) must NOT wait out
    // the cadence (up to 3s when idle) — serve it now with a fresh beat so the UI reflects the new
    // server state immediately.
    if (pendingKick) { pendingKick = false; stop(); tick(); return; }
    schedule();
}

function schedule() {
    if (timer) return;
    timer = setTimeout(tick, nextDelay());
}

// Begin (or resume) the heartbeat. Idempotent.
export function start() { if (!timer && !inFlight) tick(); }

// Stop the heartbeat (subscribers stay registered; start() resumes).
export function stop() { if (timer) { clearTimeout(timer); timer = null; } }

// Force a beat NOW — call after a user action that changed server state (start a sweep, fire a
// trigger, toggle live mode) so the UI reflects it without waiting out the cadence. If a beat is
// already in flight its snapshot may pre-date the change, so QUEUE a fresh beat for when it ends
// rather than no-op'ing (which would leave the change unseen until the next cadence tick).
export function kick() {
    if (inFlight) { pendingKick = true; return; }
    stop(); tick();
}
