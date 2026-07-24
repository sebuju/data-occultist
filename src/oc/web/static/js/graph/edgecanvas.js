// Viewport-<canvas> renderer for the pure-geometry graph layers — wires + end-caps and group
// box fill/border — replacing the SVG <path>/<div> emission. Motivation + constraints:
// .trash/handover-edges-canvas.md and memory `node-virtualization-rejected`.
//
// WHY a canvas: on a pure pan the SVG world (#gworld) is re-rastered every frame (it is
// deliberately un-composited — every will-change variant broke rendering). Thousands of path
// strokes + dashed group borders dominate that raster. We instead draw the visible geometry
// ourselves onto viewport-sized canvases that sit OUTSIDE the transformed world.
//
// WHY a bitmap cache on top (edgecache.js): with thousands of wires even our own re-stroke per
// pan frame janks. Each layer rasters once into an offscreen bitmap (viewport + margin) and a pan
// frame becomes ONE integer-offset drawImage blit; re-raster only on geometry/style/zoom change.
// Culling note: edges fully outside the rastered region are skipped as a pure raster optimization
// — nothing on screen is ever hidden (this is NOT the rejected DOM LOD/culling direction).
//
// TWO layers sandwich #gpan because the world's own z-order puts group boxes BELOW nodes and
// edges ABOVE them, and a single viewport canvas can't be both:
//   #gcanvas-under  (z below #gpan)  -> group box fill + border   (behind the whole world)
//   #gcanvas-over   (z above #gpan)  -> wires + end-cap markers    (above the node cards)
// Both are driven by ONE primitive (rule 7): createCachedLayer() in edgecache.js.
//
// The draw callbacks read the display models below (setEdges / setGroups), which the owning
// modules (routing.js / groups.js) rebuild only when geometry/style actually changes; a pan/zoom
// just re-blits the cached raster. requestRedraw() coalesces to one rAF and keeps the idle
// contract (rule 1): a static frame draws once and stops — no standing loop.

import { view } from "./state.js";
import { stampMarker } from "./edgemarks.js";
import { groupBorderCss } from "./groups.js";
import { createCachedLayer, stats, flags, resetStats } from "./edgecache.js";

// ---- display models (rebuilt by routing.js / groups.js; read every raster/direct draw) -----
let edges = [];        // [{ pts, straight, stroke, alpha, width, lineCap, dash, capStart, capEnd, selColor }]
let groups = [];       // [{ x,y,w,h, tier, outline, fill, dashed }]
let corridors = [];    // [{ axis:'v'|'h', x,y,w,h }] — bus channels, debug tint (routing.js ROUTE.corridors)
let obstacles = [];     // [{x,y,w,h}] — hard obstacle rects (group title headings) fed to the router,
                        // debug outline only while ROUTE.corridors is on (routing.js showObstacles)
let edgeOpts = { radius: 14 };

export function setEdges(list, opts, dirty = true) { edges = list || []; if (opts) edgeOpts = opts; if (dirty) over?.markDirty(); requestRedraw(); }
export function setGroups(list) { groups = list || []; under?.markDirty(); requestRedraw(); }
// Bus corridors, drawn as a flat tint on the SAME under-layer as the group boxes (they belong behind
// the node cards, like a group box does — a second cached layer for two fillRects would be a copy of
// createCachedLayer, not a use of it).
export function setCorridors(list) { corridors = list || []; under?.markDirty(); requestRedraw(); }
export function setObstacles(list) { obstacles = list || []; under?.markDirty(); requestRedraw(); }
// For paths that mutate edge geometry IN PLACE without going through setEdges (the morph tick in
// routing.js writes rec.pts directly): invalidate the wire cache so the next frame direct-draws.
export function invalidateEdges() { over?.markDirty(); requestRedraw(); }

// ---- the two cached canvas layers ----------------------------------------------------------
let over = null, under = null;   // createCachedLayer() handles

// Mount both layers once (idempotent). #gpan is the pan wrapper; the under-canvas goes before it
// (renders behind the world), the over-canvas after it (renders above the nodes). Called once at
// boot (main.js).
export function mountCanvasLayers() {
    if (over) return;
    const gpan = document.getElementById("gpan");
    under = createCachedLayer({ id: "gcanvas-under", before: gpan, draw: drawUnder });
    over = createCachedLayer({ id: "gcanvas-over", before: gpan.nextSibling, draw: drawEdges });
    const ro = new ResizeObserver(() => { under.refit(); over.refit(); requestRedraw(); });
    ro.observe(document.getElementById("graph"));
    // A/B + e2e hook: stats counters, bypass switch (direct draw every frame = pre-cache path).
    // redrawNow lets a test flip bypass and repaint SYNCHRONOUSLY (atomic vs live data refreshes).
    window.__edgecanvas = { stats, flags, resetStats, redraw: requestRedraw, redrawNow };
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

function redraw() {
    if (!over) return;
    under.render();
    over.render();
}

// Trace one edge's rounded-orthogonal polyline into `target` (a ctx with an open path, or a
// Path2D) — the canvas port of route.js polylinePath("curve"): straight L runs into each interior
// vertex, a quadratic Q for the rounded corner. `straight` (2-pt lines and mid-morph shapes)
// skips the rounding.
function tracePath(target, pts, straight, radius) {
    if (pts.length < 2) return;
    target.moveTo(pts[0][0], pts[0][1]);
    if (pts.length === 2 || straight) {
        for (let i = 1; i < pts.length; i++) target.lineTo(pts[i][0], pts[i][1]);
        return;
    }
    for (let i = 1; i < pts.length - 1; i++) {
        const a = pts[i - 1], b = pts[i], c = pts[i + 1];
        const la = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        const lc = Math.hypot(c[0] - b[0], c[1] - b[1]) || 1;
        const rad = Math.min(radius, la / 2, lc / 2);
        const pinx = b[0] + (a[0] - b[0]) * (rad / la), piny = b[1] + (a[1] - b[1]) * (rad / la);
        const poutx = b[0] + (c[0] - b[0]) * (rad / lc), pouty = b[1] + (c[1] - b[1]) * (rad / lc);
        target.lineTo(pinx, piny);
        target.quadraticCurveTo(b[0], b[1], poutx, pouty);
    }
    const e = pts[pts.length - 1];
    target.lineTo(e[0], e[1]);
}

// Per-edge Path2D, cached on the display record keyed by pts array identity (routing.js always
// REPLACES pts, never mutates in place, so identity is a valid geometry key). Built once per
// geometry change; a pan/raster then strokes the prebuilt path.
function pathFor(e, radius) {
    if (e._path && e._pathPts === e.pts && e._pathStraight === !!e.straight && e._pathRadius === radius) return e._path;
    const p = new Path2D();
    tracePath(p, e.pts, e.straight, radius);
    e._path = p; e._pathPts = e.pts; e._pathStraight = !!e.straight; e._pathRadius = radius;
    return p;
}

// Per-edge world bbox, same identity-keyed cache as pathFor.
function bboxFor(e) {
    if (e._bbox && e._bboxPts === e.pts) return e._bbox;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of e.pts) {
        if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
        if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
    }
    e._bbox = [x0, y0, x1, y1]; e._bboxPts = e.pts;
    return e._bbox;
}

// Raster-cull pad in world px: covers the widest stroke plus the largest end-cap marker (12).
const CULL_PAD = 16;
const bboxHits = (bb, r, pad) =>
    bb[0] - pad <= r.x + r.w && bb[2] + pad >= r.x && bb[1] - pad <= r.y + r.h && bb[3] + pad >= r.y;

const angleAt = (from, to) => Math.atan2(to[1] - from[1], to[0] - from[0]);

function drawEdges(ctx, worldRect) {
    const radius = edgeOpts.radius ?? 14;
    for (const e of edges) {
        const pts = e.pts;
        if (!pts || pts.length < 2) continue;
        if (worldRect && !bboxHits(bboxFor(e), worldRect, CULL_PAD)) continue;   // fully off-raster
        ctx.globalAlpha = e.alpha;
        ctx.strokeStyle = e.stroke;
        ctx.lineWidth = e.width;
        ctx.lineCap = e.lineCap || "butt";
        ctx.lineJoin = "round";
        ctx.setLineDash(e.dash || []);
        ctx.stroke(pathFor(e, radius));
        ctx.setLineDash([]);
        // End caps: start oriented out of the source (p0->p1), end oriented into the target
        // (p[n-2]->p[n-1]). Markers are opaque glyphs — draw at the same dim alpha as the line.
        if (e.capStart) stampMarker(ctx, e.capStart, pts[0][0], pts[0][1], angleAt(pts[1], pts[0]), e.stroke, e.selColor);
        if (e.capEnd) { const n = pts.length; stampMarker(ctx, e.capEnd, pts[n - 1][0], pts[n - 1][1], angleAt(pts[n - 2], pts[n - 1]), e.stroke, e.selColor); }
    }
    ctx.globalAlpha = 1;
}

// The under-layer: group boxes, then the corridor tint ON TOP of them (a corridor runs BETWEEN the
// node rows, so it routinely crosses a group's fill — under it, it would be invisible). Still below
// #gpan, so node cards and wires both cover it.
function drawUnder(ctx, worldRect) {
    drawGroups(ctx, worldRect);
    if (corridors.length) drawCorridors(ctx, worldRect);
    if (obstacles.length) drawObstacles(ctx, worldRect);
}

// Translucent strip per channel, flat colour by AXIS (not load — a gradient across every corridor
// was noise). Fill only, no border: at a few hundred corridors an outline reads as another wire
// rather than as an edge.
const COR_V = "rgba(79,163,255,0.14)";   // vertical corridors
const COR_H = "rgba(232,195,58,0.14)";   // horizontal corridors
function drawCorridors(ctx, worldRect) {
    for (const c of corridors) {
        if (worldRect && !bboxHits([c.x, c.y, c.x + c.w, c.y + c.h], worldRect, 0)) continue;
        ctx.fillStyle = c.axis === "v" ? COR_V : COR_H;
        ctx.fillRect(c.x, c.y, c.w, c.h);
    }
}

// Hard obstacle rects fed to the router (group title headings, blockRects) — debug-only outline so a
// carve gone wrong (a corridor sliced across a heading) is visible. Stroke, not fill: these already
// sit under a group's own fill/border and a solid tint would just blot it out.
function drawObstacles(ctx, worldRect) {
    ctx.strokeStyle = "rgba(255,140,0,0.8)";
    ctx.lineWidth = 1.5;
    for (const o of obstacles) {
        if (worldRect && !bboxHits([o.x, o.y, o.x + o.w, o.y + o.h], worldRect, 0)) continue;
        ctx.strokeRect(o.x + 0.75, o.y + 0.75, o.w - 1.5, o.h - 1.5);
    }
}

function drawGroups(ctx, worldRect) {
    const bw = groupBorderCss(view.zoom);   // group dashed border width (world px), zoom-scaled 1..3
    for (const g of groups) {
        if (worldRect && !bboxHits([g.x, g.y, g.x + g.w, g.y + g.h], worldRect, bw * 2)) continue;
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
        // sub + super: fill only, never stroked (super rim intentionally dropped)
        if (!g.outline || g.tier === "sub" || g.tier === "super") continue;
        ctx.strokeStyle = g.outline;
        if (g.tier === "group") {
            if (g.selected) {
                // ctrl-selected: the group's OWN border becomes a solid, thicker accent highlight —
                // never a second outline on top of it.
                ctx.lineWidth = bw * 2;
                ctx.strokeRect(g.x, g.y, g.w, g.h);
            } else {
                ctx.lineWidth = bw;
                ctx.setLineDash([bw * 2, bw * 2]);   // CSS dashed ~= dash/gap = border width (per box, world units)
                ctx.strokeRect(g.x, g.y, g.w, g.h);
                ctx.setLineDash([]);
            }
        }
    }
}
