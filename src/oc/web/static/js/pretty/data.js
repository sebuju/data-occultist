// The Pretty data layer: one poller + cache + pub/sub feeding every bound widget, plus the
// reactive scope that lets elements read each other.
//
// Widgets `require(key)` what they need (a dataset/subset/status) and `subscribe(key, fn)` to
// be told when it changes; `read(key)` returns the cached value. A tick refetches only the
// keys something currently needs and notifies subscribers ONLY when the value actually
// changed (so steady-state polls cause zero work downstream — widgets reconcile in place,
// CLAUDE.md rule 1). `node:` values are read live off the shared model (not polled);
// `widget:` values are published by widgets into the scope.

import * as papi from "./api.js";
import { model } from "../graph/state.js";
import { pathGet } from "./path.js";

let game = null;
let timer = null;
let stream = null;            // EventSource — server pushes "this dataset changed"
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
  if (timer) openStream();   // active session switching games -> repoint the stream
  // _subs is intentionally kept: widgets re-subscribe on re-render, and stale keys are
  // harmless (notified only when present in _cache).
}

export function startData() { stopData(); openStream(); refetchNeeded(); timer = setInterval(refetchNeeded, FALLBACK_MS); }
export function stopData() { if (timer) clearInterval(timer); timer = null; closeStream(); }

// On a dataset change the server doesn't know which subsets depend on it, so refetch every
// key something currently needs — cheap, and guarantees bound tables/charts/subsets update.
function refetchNeeded() { for (const key of _need.keys()) fetchKey(key); }
let _evtDebounce = null;
function onStreamChange() {   // debounce so a burst of dataset events triggers one refetch round
  clearTimeout(_evtDebounce);
  _evtDebounce = setTimeout(refetchNeeded, 150);
}
function openStream() {
  closeStream();
  if (!game) return;
  try {
    stream = new EventSource(`/api/events/${encodeURIComponent(game)}`);
    stream.addEventListener("dataset", onStreamChange);   // any dataset write -> pull fresh (debounced)
    // (no refetch on "ready": streams are short-lived/reconnect often; the fallback interval
    //  covers the brief reconnect gap without refetching on every reconnect)
  } catch { /* EventSource unavailable -> the fallback interval covers it */ }
}
function closeStream() { if (stream) { try { stream.close(); } catch { /* */ } stream = null; } }

// ---- needs / subscriptions ---------------------------------------------------------

export function require(key) {
  if (!key) return;
  if (key.startsWith("node:") || key.startsWith("widget:")) return;   // not polled
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

// A widget publishes its live value into the scope (control value, form field, selected row).
export function publish(widgetId, value) {
  const key = `widget:${widgetId}`;
  if (_scope.get(key) === value) return;
  _scope.set(key, value);
  notify(key);
}

// ---- polling ------------------------------------------------------------------------

async function fetchKey(key) {
  if (!game) return;
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
