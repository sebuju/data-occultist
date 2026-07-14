// The big directional arrows drawn over the canvas during keyboard node-nav. While an arrow key is
// HELD, ONE "live" arrow tracks from the current anchor to the candidate target; each committed hop
// LOCKS its arrow in place and a fresh live one stacks on top, so chaining across several nodes
// leaves a breadcrumb of every hop until the run settles and all clear.
//
// Endpoints are stored in WORLD coords and re-projected to screen on every applyView (camera.js),
// so the arrows stay BOUND to their nodes — they pan/zoom WITH the camera instead of detaching. The
// layer itself is a viewport-fixed sibling of #gpan (not inside the transformed world), so the
// stroke/head keep a constant on-screen size at any zoom; only the endpoints move. Rebuilt on key
// events AND on camera moves, never on a steady-state poll/tick.
import { $, view } from "./state.js";
import { svg } from "../dom.js";

const ARROW_TTL = 900;   // ms a committed arrow survives before dying on its OWN timer

let layer = null;
const locked = [];   // committed hops: {from:{x,y}, to:{x,y}, timer} — each dies independently
let live = null;     // the in-progress preview segment (world space), or null

function ensureLayer() {
    if (layer && layer.isConnected) return layer;
    layer = svg("svg", { id: "navArrowLayer" });
    $("graph").appendChild(layer);
    return layer;
}
// world point -> graph-local screen px (pan = translate on #gpan, zoom = scale on #gworld)
function w2s(p) { return { x: p.x * view.zoom + view.panX, y: p.y * view.zoom + view.panY }; }

// One arrow at constant screen size: shaft stopping at the head's base + a filled triangle head at
// `to`. Endpoints are {x,y} in screen px. The stroke/fill are a linear gradient running along the
// arrow from the anchor node's colour (`c1`) to the target node's colour (`c2`); `idx` keys a unique
// gradient id per arrow. The gradient is userSpaceOnUse so its axis matches the on-screen endpoints,
// and set via inline style so it beats the CSS class colour. Returns null when the points coincide.
function mkArrow(from, to, c1, c2, idx) {
    const dx = to.x - from.x, dy = to.y - from.y, len = Math.hypot(dx, dy);
    if (len < 1) return null;
    const ux = dx / len, uy = dy / len;   // unit along
    const px = -uy, py = ux;              // unit perpendicular
    const HEAD = 54, HALF = 26;           // big + clearly visible
    const bx = to.x - ux * HEAD, by = to.y - uy * HEAD;   // base of the head
    const gid = `navGrad${idx}`;
    return svg("g", { class: "nav-arrow" },
        svg("defs", null,
            svg("linearGradient", { id: gid, gradientUnits: "userSpaceOnUse", x1: from.x, y1: from.y, x2: to.x, y2: to.y },
                svg("stop", { offset: "0", "stop-color": c1 }),
                svg("stop", { offset: "1", "stop-color": c2 }))),
        svg("line", { class: "nav-arrow-shaft", x1: from.x, y1: from.y, x2: bx, y2: by, style: `stroke:url(#${gid})` }),
        svg("polygon", {
            class: "nav-arrow-head", style: `fill:url(#${gid})`,
            points: `${to.x},${to.y} ${bx + px * HALF},${by + py * HALF} ${bx - px * HALF},${by - py * HALF}`,
        }));
}

export function navArrowsActive() { return !!(live || locked.length); }

// Re-project every stored arrow against the CURRENT camera and redraw. Called on key events and on
// every camera move (applyView) so the arrows stay glued to their nodes.
export function renderNavArrows() {
    if (!navArrowsActive()) { if (layer) while (layer.firstChild) layer.removeChild(layer.firstChild); return; }
    const L = ensureLayer();
    while (L.firstChild) L.removeChild(L.firstChild);
    const segs = live ? [...locked, live] : locked;
    segs.forEach((s, i) => { const g = mkArrow(w2s(s.from), w2s(s.to), s.c1, s.c2, i); if (g) L.appendChild(g); });
}

// Set/replace the live preview to the WORLD segment from->to (both {x,y}), tinted as a gradient from
// the anchor colour c1 to the target colour c2; null clears just the live one, leaving locked
// breadcrumbs. The live arrow has no timer — it persists while the key is held.
export function drawLive(from, to, c1, c2) { live = (from && to) ? { from, to, c1, c2 } : null; renderNavArrows(); }

// Freeze the live arrow as a locked hop with its OWN death timer, so each breadcrumb fades out on
// its own clock (independent of the others) rather than all clearing together.
export function lockLive() {
    if (!live) return;
    const seg = { from: live.from, to: live.to, c1: live.c1, c2: live.c2, timer: null };
    seg.timer = setTimeout(() => {
        const i = locked.indexOf(seg);
        if (i !== -1) locked.splice(i, 1);
        renderNavArrows();
    }, ARROW_TTL);
    locked.push(seg);
    live = null;
}

// Kill every arrow at once (blur / reset), cancelling each pending death timer.
export function clearNavArrow() {
    for (const s of locked) clearTimeout(s.timer);
    locked.length = 0; live = null; renderNavArrows();
}
