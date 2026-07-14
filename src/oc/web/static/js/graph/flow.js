// Flow blobs: small dots that travel along a graph edge when a backend stage actually wrote
// data — orange for data, cyan for a firing trigger, teal for a watch. Driven by the SHARED
// dsevents bus (the flow channel of the one /api/events/{game} SSE stream — see dsevents.js;
// no dedicated flow socket), one event per real per-stage hop carrying the item count. NOT a
// choreographed full-chain walk — each blob animates exactly the one edge the stage wrote.
//
// Performance contract: nothing runs at idle. The rAF loop is started on
// the first spawned blob and STOPPED the moment the active list empties; <circle> elements are
// pooled (created on demand, parked on finish), never created/destroyed per frame. While
// active, each frame is a handful of cx/cy writes (capped). The blob layer lives inside
// #gworld, so it inherits the existing pan/zoom transform for free.

import { edgeGeometry } from "./routing.js";
import { model } from "./state.js";
import { nodeTypeOf } from "./main.js";
import { typeColor } from "./colors.js";
import * as dsevents from "./dsevents.js";

const CAP = 40;            // max blobs spawned per event (overflow is represented, not drawn)
const STAGGER_MS = 80;     // gap between blobs of one event, so they read as a train not a clump
const SPEED = 320;         // world units / second along the edge (duration = length / SPEED)
const SVGNS = "http://www.w3.org/2000/svg";

let game = null;
let enabled = true;        // code-level toggle; default ON. UI may flip this later via setFlowEnabled.
let flowUnsub = null;      // unsubscribe from the shared bus's FLOW channel (control + feeder hops)
let dsUnsub = null;        // unsubscribe from the shared dataset-change bus (drives data hops)
let layer = null;          // <svg id="gflow"> inside #gworld
const pool = [];           // parked <circle> free-list
const blobs = [];          // active particles
let raf = 0;

// ---- geometry --------------------------------------------------------------
// edgeGeometry(src,dst) -> world-space polyline for that edge (or null if not routed yet) is
// the ONE source of edge geometry, exported from routing.js so flow.js and routing don't fork
// link-key/route-cache logic (one shared primitive).

// The routed polyline for a hop, in the hop's OWN direction. Routes are cached directionally
// (keyed `from to`), but a flow hop can run EITHER way along an edge — a "watch" pulse travels
// watched-node -> trigger, the reverse of how the watch edge is drawn (trigger -> watched). So
// when the forward route is missing, fall back to the edge's reverse and flip its points, so the
// blob still rides the real routed path (following live re-routing) just in the other direction.
function routedPolyline(src, dst) {
    const fwd = edgeGeometry(src, dst);
    if (fwd) return fwd;
    const rev = edgeGeometry(dst, src);
    return rev ? rev.slice().reverse() : null;
}

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
    const pts = routedPolyline(src, dst);
    if (!pts) return;                       // edge not drawn/routed yet — skip silently
    const count = Math.min(n, CAP);
    const len = polyLength(pts);
    const dur = Math.max(250, (len / SPEED) * 1000);   // ms; floor so very short edges still read
    // data blob rides the node-tinted data line (stroke = typeColor of the source node); match it.
    // trigger/watch keep their fixed CSS colour ("" -> falls back to .flow-blob.<kind>).
    const fill = kind === "data" ? typeColor(nodeTypeOf(src)) : "";
    for (let i = 0; i < count; i++) {
        const el = takeBlob(kind);
        el.style.fill = fill; el.style.color = fill;   // color drives the drop-shadow glow (currentColor)
        blobs.push({ el, kind, src, dst, delay: i * STAGGER_MS, t: 0, dur, started: false });
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
        const pts = routedPolyline(b.src, b.dst);        // re-read: follows live re-routing (either direction)
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
// FLOW hops are explicit, SOURCE-AWARE pulses from the dedicated flow bus: each event names the
// exact edge that a real backend stage wrote (the window/price node that produced, the dataset
// that received) plus the kind ("data" orange, "trigger" cyan, "watch" teal). We animate that
// ONE edge. This is why two windows sharing a dataset no longer both light up: only the window
// that actually wrote emits a "data" hop, so only its edge animates.
function onFlow(d) {            // d: parsed hop from the shared bus's flow channel
    if (!enabled) return;
    if (!d || !d.kind || !d.src || !d.dst) return;
    spawn(d.kind, d.src, d.dst, d.n || 1);
}
// The ds -> view train is the one data segment that is NOT source-ambiguous — a dataset changing
// re-derives ALL of its views regardless of who wrote it — so it rides the universal, coalesced
// dataset-change stream and fires for EVERY write path (live collection, commit button, manual
// edits, batch restore, price sweeps). The feeder -> dataset hop deliberately does NOT come from
// here (it has no source info); it comes from the source-aware flow bus above.
function onData(dataset, n) {
    if (!enabled) return;
    const from = `ds:${dataset}`;
    for (const ed of model.edges()) {
        if (ed.kind !== "data") continue;
        if (ed.from === from && ed.to.startsWith("sub:")) spawn("data", from, ed.to, Math.min(n, 4));  // dataset -> view
    }
}
function openStream() {
    closeStream();
    if (!game || !enabled) return;
    // BOTH channels ride the shared dsevents bus (ONE EventSource for the whole page): flow hops
    // (control + feeder) on the flow channel, dataset writes on the dataset channel. No dedicated
    // flow socket — a second always-on stream starves the browser's connection pool. The
    // subscriptions stay only while flow is enabled (the handlers no-op otherwise).
    flowUnsub = dsevents.subscribeFlow(onFlow);
    dsUnsub = dsevents.subscribe(onData);
}
function closeStream() {
    if (flowUnsub) { flowUnsub(); flowUnsub = null; }
    if (dsUnsub) { dsUnsub(); dsUnsub = null; }
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
