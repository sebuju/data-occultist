// Viewport-<canvas> renderer for the pure-geometry graph layers — wires + end-caps and group
// box fill/border — replacing the SVG <path>/<div> emission. Motivation + constraints:
// .trash/handover-edges-canvas.md and memory `node-virtualization-rejected`.
//
// WHY a canvas: on a pure pan the SVG world (#gworld) is re-rastered every frame (it is
// deliberately un-composited — every will-change variant broke rendering). Thousands of path
// strokes + dashed group borders dominate that raster. We instead redraw only the visible
// geometry ourselves onto a viewport-sized canvas that sits OUTSIDE the transformed world and
// applies pan/zoom in its own draw math — nothing is hidden (this is NOT the rejected LOD/culling
// direction), we just rasterize the same picture at devicePixelRatio × zoom ourselves.
//
// TWO layers sandwich #gpan because the world's own z-order puts group boxes BELOW nodes and
// edges ABOVE them, and a single viewport canvas can't be both:
//   #gcanvas-under  (z below #gpan)  -> group box fill + border   (behind the whole world)
//   #gcanvas-over   (z above #gpan)  -> wires + end-cap markers    (above the node cards)
// Both are driven by ONE primitive (rule 7): createLayer() + one shared redraw math.
//
// The draw callbacks read the display models below (setEdges / setGroups), which the owning
// modules (routing.js / groups.js) rebuild only when geometry/style actually changes; a pan/zoom
// just re-runs the same math against the current models. requestRedraw() coalesces to one rAF and
// keeps the idle contract (rule 1): a static frame draws once and stops — no standing loop.

import { view } from "./state.js";
import { stampMarker } from "./edgemarks.js";
import { groupBorderCss } from "./groups.js";

// ---- display models (rebuilt by routing.js / groups.js; read every redraw) ----------------
let edges = [];        // [{ pts, straight, stroke, alpha, width, lineCap, dash, capStart, capEnd, selColor }]
let groups = [];       // [{ x,y,w,h, tier, outline, fill, dashed }]
let edgeOpts = { radius: 14 };

export function setEdges(list, opts) { edges = list || []; if (opts) edgeOpts = opts; requestRedraw(); }
export function setGroups(list) { groups = list || []; requestRedraw(); }

// ---- the two canvas layers ---------------------------------------------------------------
let over = null, under = null;   // { canvas, ctx, cssW, cssH }

function createLayer(id, insertBeforeEl) {
    const canvas = document.createElement("canvas");
    canvas.id = id;
    canvas.className = "gcanvas";
    // GPU-accelerated by default (no willReadFrequently). This canvas is viewport-FIXED (never
    // transformed), so it dodges the world-relayerize trap the overlay canvases fight with
    // software rendering — measure before switching to willReadFrequently (see handover).
    const ctx = canvas.getContext("2d");
    const graph = document.getElementById("graph");
    graph.insertBefore(canvas, insertBeforeEl);
    const layer = { canvas, ctx, cssW: 0, cssH: 0 };
    refit(layer);
    return layer;
}

function refit(layer) {
    const r = layer.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (layer.canvas.width !== w) layer.canvas.width = w;
    if (layer.canvas.height !== h) layer.canvas.height = h;
    layer.cssW = r.width; layer.cssH = r.height;
}

// Mount both layers once (idempotent). #gpan is the pan wrapper; the under-canvas goes before it
// (renders behind the world), the over-canvas after it (renders above the nodes). Called once at
// boot (main.js).
export function mountCanvasLayers() {
    if (over) return;
    const gpan = document.getElementById("gpan");
    under = createLayer("gcanvas-under", gpan);            // before #gpan
    over = createLayer("gcanvas-over", gpan.nextSibling);  // after #gpan
    const ro = new ResizeObserver(() => { refit(under); refit(over); requestRedraw(); });
    ro.observe(document.getElementById("graph"));
    requestRedraw();
}

// ---- redraw --------------------------------------------------------------------------------
let _raf = 0;
// Coalesced (next-frame) redraw — for structural/morph updates where a one-frame defer is fine.
export function requestRedraw() {
    if (!over || _raf) return;
    _raf = requestAnimationFrame(() => { _raf = 0; redraw(); });
}
// SYNCHRONOUS redraw — for the camera. applyView() writes the #gpan transform in the current frame
// (the DOM nodes move now); deferring the canvas paint to the next rAF trails the lines one frame
// behind the nodes during a fast pan/zoom. Painting here lands both in the same frame. Cancels any
// pending coalesced frame so we don't double-draw.
export function redrawNow() {
    if (!over) return;
    if (_raf) { cancelAnimationFrame(_raf); _raf = 0; }
    redraw();
}

// Set up the world transform on a layer's ctx: device-pixel backing, then pan (device-px snapped,
// matching camera.applyView so 1px strokes land on the same grid) + zoom, so all draw math runs
// in WORLD coordinates and stroke/marker sizes in world units render at ×zoom — identical to the
// SVG under #gworld's scale.
function begin(layer) {
    const dpr = window.devicePixelRatio || 1;
    const ctx = layer.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, layer.cssW, layer.cssH);
    const tx = Math.round(view.panX * dpr) / dpr, ty = Math.round(view.panY * dpr) / dpr;
    ctx.translate(tx, ty);
    ctx.scale(view.zoom, view.zoom);
    return ctx;
}

function redraw() {
    if (!over) return;
    drawGroups(begin(under));
    drawEdges(begin(over));
}

// Trace one edge's rounded-orthogonal polyline into the current path — the canvas port of
// route.js polylinePath("curve"): straight L runs into each interior vertex, a quadratic Q for
// the rounded corner. `straight` (2-pt lines and mid-morph shapes) skips the rounding.
function tracePath(ctx, pts, straight, radius) {
    ctx.beginPath();
    if (pts.length < 2) return;
    ctx.moveTo(pts[0][0], pts[0][1]);
    if (pts.length === 2 || straight) {
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        return;
    }
    for (let i = 1; i < pts.length - 1; i++) {
        const a = pts[i - 1], b = pts[i], c = pts[i + 1];
        const la = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        const lc = Math.hypot(c[0] - b[0], c[1] - b[1]) || 1;
        const rad = Math.min(radius, la / 2, lc / 2);
        const pinx = b[0] + (a[0] - b[0]) * (rad / la), piny = b[1] + (a[1] - b[1]) * (rad / la);
        const poutx = b[0] + (c[0] - b[0]) * (rad / lc), pouty = b[1] + (c[1] - b[1]) * (rad / lc);
        ctx.lineTo(pinx, piny);
        ctx.quadraticCurveTo(b[0], b[1], poutx, pouty);
    }
    const e = pts[pts.length - 1];
    ctx.lineTo(e[0], e[1]);
}

const angleAt = (from, to) => Math.atan2(to[1] - from[1], to[0] - from[0]);

function drawEdges(ctx) {
    const radius = edgeOpts.radius ?? 14;
    for (const e of edges) {
        const pts = e.pts;
        if (!pts || pts.length < 2) continue;
        ctx.globalAlpha = e.alpha;
        ctx.strokeStyle = e.stroke;
        ctx.lineWidth = e.width;
        ctx.lineCap = e.lineCap || "butt";
        ctx.lineJoin = "round";
        ctx.setLineDash(e.dash || []);
        tracePath(ctx, pts, e.straight, radius);
        ctx.stroke();
        ctx.setLineDash([]);
        // End caps: start oriented out of the source (p0->p1), end oriented into the target
        // (p[n-2]->p[n-1]). Markers are opaque glyphs — draw at the same dim alpha as the line.
        if (e.capStart) stampMarker(ctx, e.capStart, pts[0][0], pts[0][1], angleAt(pts[1], pts[0]), e.stroke, e.selColor);
        if (e.capEnd) { const n = pts.length; stampMarker(ctx, e.capEnd, pts[n - 1][0], pts[n - 1][1], angleAt(pts[n - 2], pts[n - 1]), e.stroke, e.selColor); }
    }
    ctx.globalAlpha = 1;
}

function drawGroups(ctx) {
    const bw = groupBorderCss(view.zoom);   // group dashed border width (world px), zoom-scaled 1..3
    for (const g of groups) {
        if (g.fill) {
            ctx.fillStyle = g.fill;
            if (g.tier === "sub") {   // rounded fill, no border (borderless "chip" look)
                ctx.beginPath();
                ctx.roundRect(g.x, g.y, g.w, g.h, 8);   // 8 world-px radius, scales with zoom like the box
                ctx.fill();
            } else {
                ctx.fillRect(g.x, g.y, g.w, g.h);
            }
        }
        if (!g.outline || g.tier === "sub") continue;   // sub: fill only, never stroked
        ctx.strokeStyle = g.outline;
        if (g.tier === "group") {
            ctx.lineWidth = bw;
            ctx.setLineDash([bw * 2, bw * 2]);   // CSS dashed ~= dash/gap = border width (per box, world units)
            ctx.strokeRect(g.x, g.y, g.w, g.h);
            ctx.setLineDash([]);
        } else if (g.tier === "super") {
            ctx.lineWidth = 1;   // solid 1px world rim (matches the un-zoom-scaled .sgroup border)
            ctx.strokeRect(g.x, g.y, g.w, g.h);
        }
    }
}
