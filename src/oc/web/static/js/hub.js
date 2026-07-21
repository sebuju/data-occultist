// hub.js — the single backend HEARTBEAT.
//
// Fans one activity snapshot out to every subscriber, so each panel sees worker/device/trigger
// status without opening its own poll. The snapshot is now PUSHED over the page's one SSE socket
// (`graph/dsevents.js` -> the `activity` channel), NOT polled: a `setTimeout` poll is throttled to
// ~1/min when the tab is backgrounded, but an SSE `onmessage` handler is not — so the heartbeat
// keeps beating (node/state refresh) with the tab hidden, which is the norm here (the game must
// be foregrounded). The server paces the stream — fast while a worker runs, ~2.5s idle, and ~2.5s
// regardless while this viewer reports itself HIDDEN (dsevents.js sends that; a beat nobody can
// see only costs a snapshot build and a reconcile pass). See `routes/events.py`.
//
// Note the fast beat is no longer load-bearing for trigger-fire SOUNDS: those ride their own
// instant `fire` channel now, so slowing a hidden viewer's beat can't make a cue late.
//
// This replaces the per-consumer status pollers (tasks panel, precapture indicator, kill-GPU
// button). Latency-bound OCR loops — live detect and video stepping — stay separate by design:
// they are per-frame work, not status heartbeats.
import * as api from "./api.js";
import * as conn from "./conn.js";
import * as dsevents from "./graph/dsevents.js";

let gameFn = () => null;   // supplied by the app so kick() always polls the current game
let last = null;           // most recent snapshot, replayed to new subscribers
let liveActive = false;    // UI live mode is on (client tuning loop) — see setLiveActive
let unsub = null;          // dsevents activity subscription while the hub is running
const subs = new Set();

// Wire the current-game accessor once at startup.
export function init(getGame) { if (getGame) gameFn = getGame; }

// The latest snapshot (or null before the first beat).
export function latest() { return last; }

// Subscribe to every heartbeat snapshot. Fires IMMEDIATELY with the last snapshot (if any) so a
// freshly-opened panel paints without waiting a full beat. Returns unsubscribe.
export function subscribe(fn) {
    subs.add(fn);
    if (last) { try { fn(last); } catch { /* ignore */ } }
    return () => subs.delete(fn);
}

function fan(snap) {
    last = snap;
    for (const fn of subs) { try { fn(snap); } catch { /* a bad subscriber must not stall the others */ } }
}

// Coming back on screen must feel instant: the server drops a hidden viewer's beat to the idle
// cadence (dsevents reports that — it owns the stream id), so on unhide we don't wait for the
// resumed stream, we kick a one-off snapshot. Repaint concern only; the cadence report itself
// lives in ONE place, dsevents.js.
function onVisible() { if (document.visibilityState !== "hidden") kick(); }

// Begin the heartbeat: subscribe to the pushed activity stream, and kick once so panels paint
// with a fresh snapshot immediately (the stream may not be open yet, and its first push arrives
// a beat later). Idempotent.
export function start() {
    if (!unsub) {
        unsub = dsevents.subscribeActivity(fan);
        document.addEventListener("visibilitychange", onVisible);
    }
    kick();
}

// Stop the heartbeat (subscribers stay registered; start() resumes).
export function stop() {
    if (!unsub) return;
    unsub(); unsub = null;
    document.removeEventListener("visibilitychange", onVisible);
}

// Force a beat NOW — call after a user action that changed server state (start a sweep, fire a
// trigger, toggle live mode) so the UI reflects it without waiting for the server's next push.
// A one-off GET is the low-latency path; the steady stream keeps everything current after.
export function kick() {
    const game = gameFn();
    if (!game || !conn.isOnline()) return;
    api.activity.get(game).then(fan).catch(() => { /* tfetch already told conn; the stream will catch up */ });
}

// Tell the hub that UI live mode is on/off. Cadence is now server-driven (the stream stays fast
// while a server worker runs), so this no longer pins a client cadence — it just requests an
// immediate reflect when live turns on.
export function setLiveActive(on) {
    on = !!on;
    if (on === liveActive) return;
    liveActive = on;
    if (on) kick();
}
