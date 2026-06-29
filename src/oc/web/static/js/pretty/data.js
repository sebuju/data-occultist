// The Pretty data layer: one poller + cache + pub/sub feeding every bound widget, plus the
// reactive scope that lets elements read each other.
//
// Widgets `require(key)` what they need (a dataset/subset/status) and `subscribe(key, fn)` to
// be told when it changes; `read(key)` returns the cached value. A tick refetches only the
// keys something currently needs and notifies subscribers ONLY when the value actually
// changed (so steady-state polls cause zero work downstream — widgets reconcile in
// place). `node:` values are read live off the shared model (not polled);
// `widget:` values are published by widgets into the scope.

import * as papi from "./api.js";
import { isOnline } from "../conn.js";
import { model } from "../graph/state.js";
import { pathGet } from "./path.js";
import * as dsevents from "../graph/dsevents.js";
import { singleFlight } from "../singleflight.js";
import * as hub from "../hub.js";

let game = null;
let timer = null;
let dsUnsub = null;           // unsubscribe from the shared dataset-change push bus
let hubUnsub = null;          // unsubscribe from the activity heartbeat (the "activity" source)
const _need = new Map();      // key -> refcount (which dataset/subset/status to poll)
const _cache = new Map();     // key -> last value (rows array, or the status object)
const _sig = new Map();       // key -> JSON signature, to detect real changes
const _subs = new Map();      // key -> Set(fn)
const _scope = new Map();     // "widget:<id>" -> published value

// Primary freshness is PUSH (SSE on dataset change). The interval is just a slow safety net
// in case the stream drops — not the mechanism.
const FALLBACK_MS = 12000;

export function initData(g) {
    game = g;
    _need.clear(); _cache.clear(); _sig.clear(); _scope.clear();
    if (timer) dsevents.setGame(g);   // active session switching games -> repoint the shared bus
    // _subs is intentionally kept: widgets re-subscribe on re-render, and stale keys are
    // harmless (notified only when present in _cache).
}

export function startData() {
    stopData();
    dsevents.setGame(game);                          // ensure the shared bus is pointed at our game
    dsUnsub = dsevents.subscribe(onStreamChange);    // any dataset write -> pull dependents (debounced)
    hubUnsub = hub.subscribe(setActivity);           // live worker status (the "activity" source)
    hub.start();
    refetchNeeded();
    timer = setInterval(refetchNeeded, FALLBACK_MS);
}
export function stopData() {
    if (timer) clearInterval(timer);
    timer = null;
    if (dsUnsub) { dsUnsub(); dsUnsub = null; }       // drop our subscription; the bus stays open for the node view
    if (hubUnsub) { hubUnsub(); hubUnsub = null; }    // hub keeps running for the node view; we just stop listening
}

// Cache the heartbeat snapshot under "activity" and notify only on a real change, so widgets
// bound to activity:* (live / sweeps / precapture / triggers) reconcile in place each beat.
function setActivity(s) {
    const sig = JSON.stringify(s ?? null);
    if (_sig.get("activity") === sig) { _cache.set("activity", s); return; }
    _sig.set("activity", sig);
    _cache.set("activity", s);
    notify("activity");
}

// On a dataset change the server doesn't know which subsets depend on it, so refetch every
// key something currently needs — cheap, and guarantees bound tables/charts/subsets update.
function refetchNeeded() { for (const key of _need.keys()) fetchKey(key); }
let _evtDebounce = null;
const _changedDs = new Set();
// Refetch ONLY what depends on the dataset(s) that changed — not every bound key. A commit to
// one dataset must not refetch all of them (that fan-out is what hammered the server).
function onStreamChange(dataset) {
    if (dataset) _changedDs.add(dataset);
    clearTimeout(_evtDebounce);
    _evtDebounce = setTimeout(flushChanged, 150);
}
function flushChanged() {
    const changed = [..._changedDs]; _changedDs.clear();
    if (!changed.length) { refetchNeeded(); return; }   // no dataset name -> safe fallback
    for (const key of _need.keys()) {
        if (key === "status") { fetchKey(key); continue; }   // cheap
        if (key.startsWith("dataset:")) { if (changed.includes(key.slice(8))) fetchKey(key); continue; }
        if (key.startsWith("subset:")) {
            const id = key.slice(7);
            if (changed.some((ds) => id === ds || model.subsetReaches(id, ds))) fetchKey(key);
        }
    }
}
// ---- needs / subscriptions ---------------------------------------------------------

export function require(key) {
    if (!key) return;
    if (key.startsWith("node:") || key.startsWith("widget:")) return;   // not polled
    if (key === "activity") { const s = hub.latest(); if (s != null) _cache.set("activity", s); return; }   // hub-driven
    _need.set(key, (_need.get(key) || 0) + 1);
    fetchKey(key);   // pull immediately so a freshly placed widget isn't blank until the next tick
}
export function release(key) {
    if (!key || !_need.has(key)) return;
    const n = _need.get(key) - 1;
    if (n <= 0) _need.delete(key); else _need.set(key, n);
}

export function subscribe(key, fn) {
    if (!key) return () => {};
    if (!_subs.has(key)) _subs.set(key, new Set());
    _subs.get(key).add(fn);
    return () => _subs.get(key)?.delete(fn);
}
function notify(key) { _subs.get(key)?.forEach((fn) => { try { fn(); } catch { /* widget update guard */ } }); }
export { notify };

// ---- reads --------------------------------------------------------------------------

export function read(key) {
    if (!key) return undefined;
    if (key.startsWith("node:")) return pathGet(model.profile, key.slice(5));
    if (key.startsWith("widget:")) return _scope.get(key);
    return _cache.get(key);
}

// The controller publishes the current page id here on every page switch / render, so conditions
// and dynamic text bound to the `page` source re-evaluate when the user navigates. Not polled —
// it's pushed, cached under "page", and notified only on a real change.
export function setPage(id) {
    if (_cache.get("page") === id) return;
    _cache.set("page", id);
    notify("page");
}

// A widget publishes its live value into the scope (control value, form field, selected row).
export function publish(widgetId, value) {
    const key = `widget:${widgetId}`;
    if (_scope.get(key) === value) return;
    _scope.set(key, value);
    notify(key);
}

// ---- polling ------------------------------------------------------------------------

// Single-flight per key WITH a trailing re-run: a refetch requested while one is in flight (a
// slow subset compute during a live sweep) must not be dropped — else the bound widget stalls on
// stale data until the next fallback tick. The latest request runs once the current one ends.
function fetchKey(key) { singleFlight(`pd:${key}`, () => _fetchKey(key)); }
async function _fetchKey(key) {
    if (!game || !isOnline()) return;        // don't hammer a paused/unreachable backend
    try {
        let value;
        if (key === "status") value = await papi.flowStatus(game);
        else if (key.startsWith("dataset:")) value = (await papi.datasetRows(game, key.slice(8))).records || [];
        else if (key.startsWith("subset:")) value = (await papi.subsetRows(game, key.slice(7))).rows || [];
        else return;
        const sig = JSON.stringify(value);
        if (_sig.get(key) === sig) { _cache.set(key, value); return; }   // unchanged -> no notify
        _sig.set(key, sig);
        _cache.set(key, value);
        notify(key);
    } catch { /* transient fetch error — keep last cache, retry next tick */ }
}

// Force an immediate refetch of one key (e.g. right after a write) — bound widgets update at
// once rather than waiting for the next event/fallback tick.
export function refresh(key) { fetchKey(key); }
