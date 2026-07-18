// The big directional arrow drawn over the canvas during keyboard node-nav. While an arrow key is
// HELD, ONE "live" endpoint tracks from the current anchor to the candidate target; each committed
// hop APPENDS its node to the chain, so walking across several nodes grows a SINGLE continuous
// smooth (Catmull-Rom -> bezier) curve threading every landed node, tipped by one arrowhead at the
// leading end. The whole curve survives the run then fades on ONE shared timer.
//
// Endpoints are stored in WORLD coords and re-projected to screen on every applyView (camera.js),
// so the curve stays BOUND to its nodes — it pans/zooms WITH the camera instead of detaching. The
// layer itself is a viewport-fixed sibling of #gpan (not inside the transformed world), so the
// stroke/head keep a constant on-screen size at any zoom; only the endpoints move. Rebuilt on key
// events AND on camera moves, never on a steady-state poll/tick.
import { $, view } from "./state.js";
import { svg } from "../dom.js";

const ARROW_TTL = 900;   // ms the whole curve survives (after the last hop) before it dies
const HEAD = 54, HALF = 26;   // arrowhead length + half-width, in constant screen px

let layer = null;
const chain = [];        // committed walk points: {x, y, c} in WORLD coords (+ endpoint colour)
let live = null;         // in-progress preview endpoint {x, y, c} (world space), or null
let chainTimer = null;   // ONE death timer for the whole curve (restarted each hop)

function ensureLayer() {
    if (layer && layer.isConnected) return layer;
    layer = svg("svg", { id: "navArrowLayer" });
    $("graph").appendChild(layer);
    return layer;
}
// world point -> graph-local screen px (pan = translate on #gpan, zoom = scale on #gworld)
function w2s(p) { return { x: p.x * view.zoom + view.panX, y: p.y * view.zoom + view.panY }; }

// Smooth path threading all points via a Catmull-Rom -> cubic-bezier conversion (curve passes
// THROUGH every point). Returns the SVG `d` string plus the unit end-tangent `tan` (direction the
// curve arrives at the last point, for orienting the arrowhead). `pts` are screen px, length >= 2.
const SMOOTH = 0.09;   // Catmull-Rom handle scale: smaller = shorter handles = sharper turns (1/6 = round)
function smoothPath(pts) {
    const n = pts.length;
    let d = `M ${pts[0].x} ${pts[0].y}`;
    let c2x = pts[0].x, c2y = pts[0].y;   // last control handle before the end point
    for (let i = 0; i < n - 1; i++) {
        const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || pts[i + 1];
        // Catmull-Rom -> bezier control points; SMOOTH tunes handle length (turn sharpness)
        const c1x = p1.x + (p2.x - p0.x) * SMOOTH, c1y = p1.y + (p2.y - p0.y) * SMOOTH;
        c2x = p2.x - (p3.x - p1.x) * SMOOTH; c2y = p2.y - (p3.y - p1.y) * SMOOTH;
        d += ` C ${c1x} ${c1y} ${c2x} ${c2y} ${p2.x} ${p2.y}`;
    }
    const end = pts[n - 1];
    let tx = end.x - c2x, ty = end.y - c2y, tl = Math.hypot(tx, ty);
    if (tl < 1e-3) { tx = end.x - pts[n - 2].x; ty = end.y - pts[n - 2].y; tl = Math.hypot(tx, ty) || 1; }
    return { d, tan: { x: tx / tl, y: ty / tl } };
}

// A per-point colour gradient running along the whole curve (userSpaceOnUse so its axis matches the
// on-screen endpoints), stops placed at each point's cumulative arc-length fraction. Set via inline
// style on the path/head so it beats the CSS class colour. `pts` are screen px, length >= 2.
function mkGradient(pts, idx) {
    const first = pts[0], last = pts[pts.length - 1];
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
    const total = cum[cum.length - 1] || 1;
    const stops = pts.map((p, i) => svg("stop", { offset: `${cum[i] / total}`, "stop-color": p.c }));
    return svg("linearGradient",
        { id: `navGrad${idx}`, gradientUnits: "userSpaceOnUse", x1: first.x, y1: first.y, x2: last.x, y2: last.y },
        ...stops);
}

export function navArrowsActive() { return chain.length > 1 || !!(chain.length && live); }

// Re-project the whole chain against the CURRENT camera and redraw ONE continuous curved arrow.
// Called on key events and on every camera move (applyView) so the curve stays glued to its nodes.
export function renderNavArrows() {
    const active = navArrowsActive();
    if (layer) while (layer.firstChild) layer.removeChild(layer.firstChild);
    if (!active) return;
    const L = ensureLayer();
    const pts = (live ? [...chain, live] : chain).map((p) => ({ ...w2s(p), c: p.c }));
    const end = pts[pts.length - 1];
    // end tangent (from the full curve) orients the head; base sits HEAD px back along it
    const { tan } = smoothPath(pts);
    const bx = end.x - tan.x * HEAD, by = end.y - tan.y * HEAD;   // base of the head
    const px = -tan.y, py = tan.x;                                // unit perpendicular
    // draw the SHAFT stopping at the head base (not the tip) so it doesn't poke through the head
    const { d } = smoothPath([...pts.slice(0, -1), { x: bx, y: by, c: end.c }]);
    const gid = "navGrad0";
    L.appendChild(svg("g", { class: "nav-arrow" },
        svg("defs", null, mkGradient(pts, 0)),
        svg("path", { class: "nav-arrow-shaft", d, style: `stroke:url(#${gid});fill:none` }),
        svg("polygon", {
            class: "nav-arrow-head", style: `fill:url(#${gid})`,
            points: `${end.x},${end.y} ${bx + px * HALF},${by + py * HALF} ${bx - px * HALF},${by - py * HALF}`,
        })));
}

// Set/replace the live preview endpoint (WORLD {x,y}); on the first hop of a run the anchor `from`
// seeds chain[0]. c1/c2 tint the anchor/target ends. `to` null clears just the live endpoint,
// leaving the committed chain in place. The live endpoint has no timer — it persists while held.
export function drawLive(from, to, c1, c2) {
    if (from && !chain.length) chain.push({ x: from.x, y: from.y, c: c1 });
    live = to ? { x: to.x, y: to.y, c: c2 } : null;
    renderNavArrows();
}

// Freeze the live endpoint as a committed chain point and restart the ONE shared death timer, so the
// whole curve survives the run and fades ARROW_TTL after the LAST hop (not per-segment).
export function lockLive() {
    if (!live) return;
    chain.push(live);
    live = null;
    if (chainTimer) clearTimeout(chainTimer);
    chainTimer = setTimeout(() => { chain.length = 0; chainTimer = null; renderNavArrows(); }, ARROW_TTL);
}

// Kill the whole curve at once (blur / reset), cancelling the pending death timer.
export function clearNavArrow() {
    if (chainTimer) { clearTimeout(chainTimer); chainTimer = null; }
    chain.length = 0; live = null; renderNavArrows();
}
