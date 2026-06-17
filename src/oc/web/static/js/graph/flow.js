// Flow blobs: small dots that travel along a graph edge when a backend stage actually wrote
// data — orange for data, cyan for a firing trigger, teal for a watch. Driven by the
// /api/flow-events/{game} SSE stream (one event per real per-stage hop, carrying the item
// count). NOT a choreographed full-chain walk — each blob animates exactly the one edge that
// the matching backend stage wrote.
//
// Performance contract (CLAUDE.md rule 1): nothing runs at idle. The rAF loop is started on
// the first spawned blob and STOPPED the moment the active list empties; <circle> elements are
// pooled (created on demand, parked on finish), never created/destroyed per frame. While
// active, each frame is a handful of cx/cy writes (capped). The blob layer lives inside
// #gworld, so it inherits the existing pan/zoom transform for free.

import { edgeGeometry } from "./routing.js";
import { model } from "./state.js";

const CAP = 40;            // max blobs spawned per event (overflow is represented, not drawn)
const STAGGER_MS = 80;     // gap between blobs of one event, so they read as a train not a clump
const SPEED = 320;         // world units / second along the edge (duration = length / SPEED)
const SVGNS = "http://www.w3.org/2000/svg";

let game = null;
let enabled = true;        // code-level toggle; default ON. UI may flip this later via setFlowEnabled.
let ctrlStream = null;     // EventSource: control hops (trigger->price, trigger->watch)
let dataStream = null;     // EventSource: dataset writes (drives data hops, any write path)
let layer = null;          // <svg id="gflow"> inside #gworld
const pool = [];           // parked <circle> free-list
const blobs = [];          // active particles
let raf = 0;

// ---- geometry --------------------------------------------------------------
// edgeGeometry(src,dst) -> world-space polyline for that edge (or null if not routed yet) is
// the ONE source of edge geometry, exported from routing.js so flow.js and routing don't fork
// link-key/route-cache logic (CLAUDE.md rule 7).

// Cumulative arc length of a polyline + a point at distance `d` along it.
function polyLength(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i][0] - pts[i - 1][0], dy = pts[i][1] - pts[i - 1][1];
    L += Math.hypot(dx, dy);
  }
  return L;
}
function pointAt(pts, d) {
  if (d <= 0) return pts[0];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (acc + seg >= d) {
      const t = seg ? (d - acc) / seg : 0;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    acc += seg;
  }
  return pts[pts.length - 1];
}

// ---- blob pool + render layer ----------------------------------------------
function ensureLayer() {
  if (layer) return layer;
  const world = document.getElementById("gworld");
  if (!world) return null;
  layer = document.createElementNS(SVGNS, "svg");
  layer.setAttribute("id", "gflow");
  // sits above edges/nodes inside the transformed world; pointer-events off so it never
  // intercepts drags. Sized by CSS (overflow visible) — coords are world units.
  world.appendChild(layer);
  return layer;
}
const BLOB_R = 4;          // world units; rides the #gworld transform so it scales with zoom
function takeBlob(kind) {
  const el = pool.pop() || document.createElementNS(SVGNS, "circle");
  el.setAttribute("class", `flow-blob ${kind}`);
  el.setAttribute("r", BLOB_R);
  el.style.display = "";
  if (el.parentNode !== layer) layer.appendChild(el);
  return el;
}
function retire(b) {
  b.el.style.display = "none";
  pool.push(b.el);
}

// ---- spawning --------------------------------------------------------------
// Spawn up to CAP blobs that travel src -> dst along the current routed edge. They re-read the
// edge geometry each frame, so they follow live re-routing (node drag) and pan/zoom for free.
function spawn(kind, src, dst, n) {
  if (!enabled) return;
  if (!ensureLayer()) return;
  const pts = edgeGeometry(src, dst);
  if (!pts) return;                       // edge not drawn/routed yet — skip silently
  const count = Math.min(n, CAP);
  const len = polyLength(pts);
  const dur = Math.max(250, (len / SPEED) * 1000);   // ms; floor so very short edges still read
  for (let i = 0; i < count; i++) {
    blobs.push({
      el: takeBlob(kind), kind, src, dst,
      delay: i * STAGGER_MS, t: 0, dur, started: false,
    });
  }
  start();
}

// ---- the loop (alive only while blobs exist) -------------------------------
let last = 0;
function start() {
  if (raf) return;
  last = 0;
  raf = requestAnimationFrame(step);
}
function step(now) {
  const dt = last ? now - last : 16;
  last = now;
  for (let i = blobs.length - 1; i >= 0; i--) {
    const b = blobs[i];
    if (b.delay > 0) { b.delay -= dt; continue; }   // still staggered in
    const pts = edgeGeometry(b.src, b.dst);          // re-read: follows live re-routing
    if (!pts) { retire(b); blobs.splice(i, 1); continue; }
    b.t += dt / b.dur;
    if (b.t >= 1) { retire(b); blobs.splice(i, 1); continue; }
    const len = polyLength(pts);
    const p = pointAt(pts, b.t * len);
    b.el.setAttribute("cx", p[0]);
    b.el.setAttribute("cy", p[1]);
  }
  if (blobs.length) raf = requestAnimationFrame(step);
  else raf = 0;                                       // idle: stop the loop entirely (rule 1)
}

// ---- live streams ----------------------------------------------------------
// CONTROL hops (trigger->price, trigger->watch) are explicit pulses with no dataset write, so
// they come from the dedicated flow bus.
function onControl(e) {
  if (!enabled) return;
  let d;
  try { d = JSON.parse(e.data); } catch { return; }
  if (!d || !d.kind || !d.src || !d.dst) return;
  spawn(d.kind, d.src, d.dst, d.n || 1);
}
// DATA hops are derived from the universal dataset-change stream, so they fire for EVERY write
// path — live collection, the commit-to-dataset button, manual edits, batch restore, price
// sweeps — not just one code site. On "dataset X gained n rows" we animate every data edge that
// FEEDS X (its window / price-node sources), plus a short train down each view that re-derives
// from X (ds -> sub). We do NOT animate ds -> price here: a price node only reads on its own
// sweep, and that sweep's WRITE shows up as its own dataset event (price -> its output dataset).
function onData(e) {
  if (!enabled) return;
  let d;
  try { d = JSON.parse(e.data); } catch { return; }
  if (!d || !d.dataset) return;
  const n = d.n || 1;
  const to = `ds:${d.dataset}`;
  for (const ed of model.edges()) {
    if (ed.kind !== "data") continue;
    if (ed.to === to) spawn("data", ed.from, to, n);                                    // feeders -> dataset
    else if (ed.from === to && ed.to.startsWith("sub:")) spawn("data", to, ed.to, Math.min(n, 4));  // dataset -> view
  }
}
function openStream() {
  closeStream();
  if (!game || !enabled) return;
  const g = encodeURIComponent(game);
  try {
    ctrlStream = new EventSource(`/api/events/flow/${g}`);
    ctrlStream.addEventListener("flow", onControl);
    dataStream = new EventSource(`/api/events/${g}`);
    dataStream.addEventListener("dataset", onData);
  } catch { /* EventSource unavailable -> no blobs, no harm */ }
}
function closeStream() {
  for (const s of [ctrlStream, dataStream]) if (s) { try { s.close(); } catch { /* */ } }
  ctrlStream = dataStream = null;
}

function clearBlobs() {
  for (const b of blobs) retire(b);
  blobs.length = 0;
  if (raf) { cancelAnimationFrame(raf); raf = 0; }
}

// ---- public surface --------------------------------------------------------
export function initFlow(g) { clearBlobs(); game = g; if (enabled) openStream(); }
export function stopFlow() { clearBlobs(); closeStream(); }
export function setFlowEnabled(on) {
  enabled = !!on;
  if (enabled) openStream();
  else { clearBlobs(); closeStream(); }
}
export function isFlowEnabled() { return enabled; }
