// Edge routing + drawing: builds the unified link list, picks ports/sides, fans shared
// endpoints, runs the cached A* orthogonal router (route.js), and paints one persistent
// <path> per link (each changed line MORPHS into its new routed shape). Split out of main.js.
//
// Owns the routing-freeze flag (OCR pauses re-routing) and the drag flag; main.js flips the
// drag flag via setDraggingNodes() — while it's set, lines are frozen (stale ones greyed) and
// re-route once on settle. Reads selectedNodeId/wire and calls startWire from main.js (live
// bindings, runtime-safe circular import).
import * as groups from "./groups.js";
import { routeGraph } from "./route.js";
import { hierRoute } from "./hierRoute.js";
import { deCollide } from "./decollide.js";
import { $, setStatus, model, nodeEls, pos, nw, nh, selected, boot } from "./state.js";
import { selectedNodeId, wire, startWire, CAN_DISABLE, nodeTypeOf } from "./main.js";
import { setEdges, requestRedraw } from "./edgecanvas.js";
import { typeColor, grayscale, cssVar } from "./colors.js";

// Port exit directions (L/R/T/B) -> unit vector, used to stub a line out of a port the
// right way before it turns. Lines are ALWAYS orthogonal — no bezier fallback exists.
const _DIROFF = { L: [-1, 0], R: [1, 0], T: [0, -1], B: [0, 1] };

// Orthogonal elbow between two ports — the instant fallback shown until A* routes the line.
// Replaces the old direct bezier so a curved line is NEVER drawn: a short stub leaves each
// port along its facing direction, then one right-angle connects the stubs. Same point list
// the router emits, so polylinePath renders it in the identical (rounded-corner) 90° style.
function dirElbowPts(x1, y1, d1, x2, y2, d2) {
    const k = 16;
    const a = _DIROFF[d1] || [0, 0], b = _DIROFF[d2] || [0, 0];
    const s1 = [x1 + a[0] * k, y1 + a[1] * k];   // stub out of the source port
    const s2 = [x2 + b[0] * k, y2 + b[1] * k];   // stub into the target port
    // turn axis: if the source exits horizontally, run horizontal-then-vertical, else the reverse
    const corner = a[0] !== 0 ? [s2[0], s1[1]] : [s1[0], s2[1]];
    return [[x1, y1], s1, corner, s2, [x2, y2]];
}

// Resample a polyline to n+1 points spread evenly by arc length — so two shapes with
// different vertex counts can be lerped point-for-point during a morph.
function resamplePoly(pts, n) {
    if (pts.length < 2) return Array.from({ length: n + 1 }, () => (pts[0] || [0, 0]).slice());
    const seg = []; let total = 0;
    for (let i = 0; i < pts.length - 1; i++) { const l = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]); seg.push(l); total += l; }
    if (total === 0) return Array.from({ length: n + 1 }, () => pts[0].slice());
    const out = []; let si = 0, acc = 0;
    for (let i = 0; i <= n; i++) {
        const target = (total * i) / n;
        while (si < seg.length - 1 && acc + seg[si] < target) { acc += seg[si]; si++; }
        const t = seg[si] ? (target - acc) / seg[si] : 0;
        out.push([pts[si][0] + (pts[si + 1][0] - pts[si][0]) * t, pts[si][1] + (pts[si + 1][1] - pts[si][1]) * t]);
    }
    return out;
}

// Closest-facing sides of two rects (shortest centre axis): the port point and
// outward direction (L/R/T/B) on each. The geometric default — used for the live drag
// bezier and as the fallback before the router has scored a better pair of sides.
function facingSides(ra, rb) {
    const acx = ra.x + ra.w / 2, acy = ra.y + ra.h / 2, bcx = rb.x + rb.w / 2, bcy = rb.y + rb.h / 2;
    const dx = bcx - acx, dy = bcy - acy;
    if (Math.abs(dx) >= Math.abs(dy)) {
        if (dx >= 0) return { p1: [ra.x + ra.w, acy], d1: "R", p2: [rb.x, bcy], d2: "L" };
        return { p1: [ra.x, acy], d1: "L", p2: [rb.x + rb.w, bcy], d2: "R" };
    }
    if (dy >= 0) return { p1: [acx, ra.y + ra.h], d1: "B", p2: [bcx, rb.y], d2: "T" };
    return { p1: [acx, ra.y], d1: "T", p2: [bcx, rb.y + rb.h], d2: "B" };
}


const nodeRect = (id) => { const p = pos.get(id); return p && { x: p.x, y: p.y, w: nw(id), h: nh(id) }; };

// ---- one unified link list -------------------------------------------------
// EVERY connection in the view is the same thing: a line between two NODES — always to
// the node rect, never to a box on the image. They all flow through buildLinks →
// routing → drawn on a persistent per-link <path>. No bespoke per-kind drawing.
// a line is highlighted when EITHER end is selected — the single focus node OR any node in the
// multi-select set (marquee / shift-click), so selecting many nodes colours their lines too.
function selClsFor(aId, bId) {
    const hit = (id) => id === selectedNodeId || selected.has(id);
    return (hit(aId) || hit(bId)) ? " sel" : "";
}

// Build the descriptor for every line. `aId`/`bId` name each rect's owner (used to
// fan endpoints that share a node side); `ra`/`rb` are the world rects.
// A data edge always leaves its source node's `.port.out` handle. Every source that draws
// one — window, producer, dataset, view (subset), file source — anchors its data line at the port
// dot and gets the animated flow. (Keep this prefix set in sync with `outPortSpec`.)
const PORT_OUT_SRC = ["win:", "producer:", "ds:", "sub:", "src:", "ro:", "register:"];
// parent->child structural tethers (a node bonded to its companion/children): preview/vttable (img),
// region+field boxes (field), item crops (item), tell boxes (tell). They attach at face CENTRES, not
// corners; their middle segments are still evicted off bands/nodes, only the centred endpoints are spared.
const TETHER_KINDS = ["img", "field", "item", "tell"];
// a data edge leaves its source's out-port; a trigger's control edges (fires + watch) leave the
// trigger's out-ports too — `fires` from the RIGHT `.port.out`, `watch` from the LEFT `.port.pwatch`.
const fromPortOut = (aId, kind) =>
    (kind === "data" && PORT_OUT_SRC.some((p) => aId.startsWith(p))) ||
    ((kind === "trigger" || kind === "watch") && aId.startsWith("trigger:"));

// Out-ports all share ONE face for a uniform look, but WHICH face is negotiated every route:
// whichever side most data lines want (target right of source -> R, else L) wins, then EVERY data
// out-port uses it. `outSide` holds the current winner.
let outSide = "R";
function negotiateOutSide(links) {
    let r = 0, l = 0;
    for (const ln of links) {
        if (!ln.port || ln.portKind === "watch") continue;
        if (!PORT_OUT_SRC.some((p) => ln.aId.startsWith(p))) continue;   // data sources vote; triggers don't
        const sc = ln.ra.x + ln.ra.w / 2, tc = ln.rb.x + ln.rb.w / 2;
        if (tc >= sc) r++; else l++;
    }
    return l > r ? "L" : "R";   // tie -> R (the historical default)
}
// A trigger's two control ports each face their OWN targets, not a shared face. The fires-port
// (`.port.out`) goes L when most of the producers / sources / datasets it fires sit to the trigger's
// left, else R; the watch-port (`.port.pwatch`) goes to the side of the dataset/subset it watches.
// The one hard rule: when BOTH ports are wired they must sit on OPPOSITE faces or their lines would
// stack — so the watch-port takes the side opposite fires (which equals its own target side whenever
// the two targets are on different sides, and splits them apart when they'd collide, fires winning
// since a mis-faced fires line is the visible bug). Recomputed every route from live geometry, so a
// target that moves (or a re-wire) re-picks the faces and no line wraps back around the node.
const triggerSides = new Map();   // trigger id -> { fires: "L"|"R", watch: "L"|"R" }
const flip = (s) => (s === "L" ? "R" : "L");
function computeTriggerSides(links) {
    triggerSides.clear();
    const votes = new Map();   // trigger id -> { fires:{l,r}, watch:{l,r} }
    for (const ln of links) {
        if (!ln.port || !ln.aId.startsWith("trigger:")) continue;
        const sc = ln.ra.x + ln.ra.w / 2, tc = ln.rb.x + ln.rb.w / 2;
        const v = votes.get(ln.aId) || votes.set(ln.aId, { fires: { l: 0, r: 0 }, watch: { l: 0, r: 0 } }).get(ln.aId);
        const box = ln.portKind === "watch" ? v.watch : v.fires;   // fires + dataset-action share the fires port
        if (tc < sc) box.l++; else box.r++;
    }
    for (const [id, v] of votes) {
        const fires = v.fires.l > v.fires.r ? "L" : "R";                  // no fire targets -> default R
        const hasWatch = v.watch.l + v.watch.r > 0;
        triggerSides.set(id, { fires, watch: hasWatch ? flip(fires) : "L" });   // watch opposite fires (else default L)
    }
}
// The face a port line leaves: a data source uses the negotiated shared side; a trigger's fires /
// watch ports use the sides computed above (defaults: fires R, watch L when a trigger fires nothing).
function sideForPort(l) {
    if (l.aId.startsWith("trigger:")) {
        const s = triggerSides.get(l.aId);
        return l.portKind === "watch" ? (s ? s.watch : "L") : (s ? s.fires : "R");
    }
    if (l.portKind === "watch") return "L";
    return PORT_OUT_SRC.some((p) => l.aId.startsWith(p)) ? outSide : "R";
}
function buildLinks() {
    const links = [];
    const add = (key, aId, bId, top, kind, ra, rb) => {
        if (!ra || !rb) return;
        const port = fromPortOut(aId, kind);
        const flow = port && kind !== "watch";   // watch keeps its own dotted/diamond look, not the data flow arrow
        const tgt = bId.startsWith("sub:") ? " toview" : "";
        const own = kind === "own" && bId.startsWith("win:") ? " ownwin"          // game→window owns the window's accent tint
            : kind === "own" && bId.startsWith("dict:") ? " owndict" : "";         // game→dictionary owns the dict's purple tint
        const portKind = kind === "watch" ? "watch" : "out";   // which port element this line leaves (`.port.pwatch` vs `.port.out`)
        // EVERY line ends in a glyph (squarecap by default, else arrow/chevron/diamond); they all
        // draw on the top layer so the end glyph sits OVER the node instead of being hidden behind
        // its card (edges z1 < nodes z2 < top z5).
        const over = true;
        // Every line takes the colour of the node it LEAVES (source), overriding the per-kind
        // stroke in graph.css. Resolved to that type's --nt token; an unknown/satellite source
        // (no --nt-<type>) falls back to --line via the CSS var fallback. Applied inline in
        // drawEdges (inline style beats the stylesheet); end-glyphs follow via `context-stroke`.
        const srcType = nodeTypeOf(aId);
        links.push({ key, aId, bId, top, over, port, portKind, cls: `gedge ${kind}${flow ? " flow" : ""}${tgt}${own}${selClsFor(aId, bId)}`, srcType, ra, rb });
    };
    for (const e of model.edges())
        add(`${e.from} ${e.to}`, e.from, e.to, !!selClsFor(e.from, e.to), e.kind, nodeRect(e.from), nodeRect(e.to));
    computePorts(links);
    return links;
}

// Pick each line's port + side, then fan endpoints that share a node side so they sit
// one GAP apart instead of all stacking on the side's midpoint.
const GAP = () => ROUTE.cell * 2;   // preferred spacing: fanned endpoints AND parallel bundles (a line can still squeeze to 1 cell between two)
const MIN_PORT_GAP = 11;   // hard floor between adjacent fanned port dots (dot is 8px) — never let them overlap
// both node ids belong to the same (non-null) group
function sameGroup(aId, bId) { const g = groups.groupOf(aId); return !!g && g === groups.groupOf(bId); }
function computePorts(links) {
    outSide = negotiateOutSide(links);   // pick the shared out-port face before pinning any line
    computeTriggerSides(links);          // per-trigger fires-port faces (independent of the shared face)
    for (const l of links) {
        // geometric facing — the pre-route default for a brand-new line; the router picks the real
        // faces (and the routed result's ports override these in drawEdges/runRouting).
        const f = facingSides(l.ra, l.rb);
        l.p1 = f.p1; l.d1 = f.d1; l.p2 = f.p2; l.d2 = f.d2;
        // port lines leave a pinned face (the port dot); pin the pre-route default to match what the
        // router will pick (route.js pinSrc) so the elbow doesn't flip. `watch` leaves the LEFT
        // `.port.pwatch`; every other port line leaves the RIGHT `.port.out`.
        if (l.port) {
            if (sideForPort(l) === "L") { l.d1 = "L"; l.p1 = [l.ra.x, l.ra.y + l.ra.h / 2]; }
            else { l.d1 = "R"; l.p1 = [l.ra.x + l.ra.w, l.ra.y + l.ra.h / 2]; }
        }
        l.align = false;
        l.relax = sameGroup(l.aId, l.bId);
    }
    // Grouped nodes read as a single unit, so the "ports sit at the edge centre" rule is relaxed
    // for lines BETWEEN members of the same group: if their facing sides share an axis, slide
    // both ports to a common coordinate inside the rects' overlap → the connector runs dead
    // straight instead of doglegging to two centres. Aligned ports skip the fan below.
    for (const l of links) {
        if (!sameGroup(l.aId, l.bId)) continue;
        const horiz = (l.d1 === "L" || l.d1 === "R") && (l.d2 === "L" || l.d2 === "R");
        const vert = (l.d1 === "T" || l.d1 === "B") && (l.d2 === "T" || l.d2 === "B");
        if (!horiz && !vert) continue;
        const ax = horiz ? 1 : 0;   // perpendicular axis to align on
        const aLo = ax ? l.ra.y : l.ra.x, aHi = aLo + (ax ? l.ra.h : l.ra.w);
        const bLo = ax ? l.rb.y : l.rb.x, bHi = bLo + (ax ? l.rb.h : l.rb.w);
        const lo = Math.max(aLo, bLo), hi = Math.min(aHi, bHi);
        if (lo > hi) continue;      // no overlap → can't straighten, keep the centred ports
        const c = (lo + hi) / 2;
        l.p1[ax] = c; l.p2[ax] = c;
        l.align = true;
    }
    const buckets = new Map();   // `${owner}|${dir}` -> endpoints on that rect side
    const put = (owner, dir, l, end, other) => {
        const horiz = dir === "L" || dir === "R";
        const perp = horiz ? other.y + other.h / 2 : other.x + other.w / 2;
        const k = `${owner}|${dir}`;
        (buckets.get(k) || buckets.set(k, []).get(k)).push({ l, end, perp, horiz });
    };
    for (const l of links) {
        if (l.align) continue;   // grouped straight lines keep their off-centre ports — don't fan them
        put(l.aId, l.d1, l, "a", l.rb); put(l.bId, l.d2, l, "b", l.ra);
    }
    const gap = GAP();
    for (const arr of buckets.values()) {
        if (arr.length < 2) continue;
        arr.sort((u, v) => u.perp - v.perp);   // order by where each other end sits → no crossing
        const n = arr.length;
        arr.forEach((it, i) => {
            const rect = it.end === "a" ? it.l.ra : it.l.rb;
            const lo = it.horiz ? rect.y : rect.x, span = it.horiz ? rect.h : rect.w;
            // preferred = one GAP apart, kept just inside the edge; but never below the no-overlap
            // floor — when the edge can't hold N dots at GAP, fall back to MIN_PORT_GAP (overflowing
            // the edge only if even that won't fit) instead of squeezing them on top of each other.
            const pref = Math.min(span - MIN_PORT_GAP, (n - 1) * gap);
            const spread = Math.max(0, pref, (n - 1) * MIN_PORT_GAP);
            const coord = lo + span / 2 - spread / 2 + (i * spread) / (n - 1);
            const port = it.end === "a" ? it.l.p1 : it.l.p2;
            if (it.horiz) port[1] = coord; else port[0] = coord;
        });
    }
    // A line may share an EDGE with a node's out-port, but must not END directly OVER the out-port
    // dot. The dot sits where the node's outgoing line starts (its p1). Nudge any incoming end that
    // landed on the same side AND ~same coord as that dot just clear of it (kept on the edge).
    const outDot = new Map();   // nodeId -> { dir, coord } of its out-port dot
    for (const l of links) {
        if (outDot.has(l.aId)) continue;
        const horiz = l.d1 === "L" || l.d1 === "R";
        outDot.set(l.aId, { dir: l.d1, coord: horiz ? l.p1[1] : l.p1[0] });
    }
    for (const l of links) {
        const od = outDot.get(l.bId);
        if (!od || od.dir !== l.d2) continue;            // different edge → no conflict
        const horiz = l.d2 === "L" || l.d2 === "R";
        const cur = horiz ? l.p2[1] : l.p2[0];
        if (Math.abs(cur - od.coord) >= gap * 0.5) continue;   // already clear of the dot
        const lo = horiz ? l.rb.y : l.rb.x, hi = lo + (horiz ? l.rb.h : l.rb.w);
        const want = od.coord + (cur >= od.coord ? gap : -gap);
        const v = Math.max(lo + 4, Math.min(hi - 4, want));
        if (horiz) l.p2[1] = v; else l.p2[0] = v;
    }
}

// Per-line port dots: EVERY port line gets its OWN dot at BOTH ends — the source end (where it
// leaves a node, a draggable handle) and the destination end (where it arrives). A node fanning N
// lines shows N dots, one per line, never all stacked on one point. Each dot FOLLOWS its line: the
// router (fanFaceEnds) picks the coord, the dot moves onto that node-relative point.

// Position one dot at a world point, relative to its node's rect. (-1: the dot lives in the
// node's PADDING box inside its 1px border, but the point/rect are border-box world coords.)
// An ACTIVE dot (line attached) is INVISIBLE — the line paints its own start dot (#portcap
// marker-start, #portcap-sel when selected), which by construction sits exactly on the line and
// over it. This element is only the grab target riding the line's start; idle handles (no line)
// go back to visible via the idle cssText reset in placeSrcDots.
function styleDot(dot, pt, rect, cls) {
    dot.style.left = `${pt[0] - rect.x - 1}px`;
    dot.style.top = `${pt[1] - rect.y - 1}px`;
    dot.style.right = "auto";
    dot.style.transform = "translate(-50%, -50%)";
    dot.style.opacity = "0";
    dot._idleStyle = null;   // active now -> force a rewrite back to its idle home when it next goes idle
}

// Grow/shrink a pool of source-dot clones off `base` (the drag handle = dot #0); clones get
// `extraCls` and re-wire `spec` (listeners aren't cloned). Returns [base, ...clones].
function ensurePortDots(node, count, base, extrasSel, extraCls, spec) {
    let extras = [...node.querySelectorAll(extrasSel)];
    while (extras.length < count - 1) {
        const d = base.cloneNode(false);
        d.classList.add(extraCls);
        if (spec && node._outId) d.addEventListener("mousedown", (ev) => startWire(node._outId, ev, spec));
        node.appendChild(d); extras.push(d);
    }
    for (let i = count - 1; i < extras.length; i++) extras[i].remove();
    return [base, ...extras.slice(0, Math.max(0, count - 1))];
}

// One source-dot family (the `.port.out` fires/data handle, or the `.port.pwatch` watch handle):
// fan a dot per line onto its start; when idle, drop clones and park the handle at its CSS home.
function placeSrcDots(node, lines, baseSel, extrasSel, extraCls, spec, idleStyle = "") {
    const base = node.querySelector(baseSel);
    if (!base) return;
    if (!lines || !lines.length) {   // idle handle: no line uses it — show only on node hover (.port-idle)
        node.querySelectorAll(extrasSel).forEach((d) => d.remove());
        // park at its idle home — CSS default ("") or the negotiated left face — only when it changed
        if (base._idleStyle !== idleStyle) { base.style.cssText = idleStyle; base._idleStyle = idleStyle; }
        base.classList.add("port-idle");
        return;
    }
    base.classList.remove("port-idle");
    const dots = ensurePortDots(node, lines.length, base, extrasSel, extraCls, spec);
    lines.forEach((l, i) => { if (dots[i]) styleDot(dots[i], l.p1, l.ra, l.cls); });
}

// Only the SOURCE end shows a dot (the draggable port handle). The arriving end is laid out by the
// router (fanFaceEnds spaces every landing point), but draws no sphere — the line just meets the edge.
function placePortDots(links) {
    const srcOut = new Map(), srcWatch = new Map();
    const push = (m, id, l) => (m.get(id) || m.set(id, []).get(id)).push(l);
    for (const l of links) {
        if (!l.port) continue;
        push(l.portKind === "watch" ? srcWatch : srcOut, l.aId, l);   // leaving end -> source family
    }
    // a data source's idle out-dot sits on the negotiated face (left only when `outSide` flipped);
    // triggers keep the CSS default (right fires-port, left watch-port).
    for (const [id, node] of nodeEls) {
        const outIdle = (outSide === "L" && PORT_OUT_SRC.some((p) => id.startsWith(p))) ? "left:-4px;right:auto" : "";
        placeSrcDots(node, srcOut.get(id), ".port.out:not(.port-extra)", ".port.out.port-extra", "port-extra", node._outSpec, outIdle);
        placeSrcDots(node, srcWatch.get(id), ".port.pwatch:not(.pw-extra)", ".port.pwatch.pw-extra", "pw-extra", node._watchSpec);
    }
}

const MORPH_MS = 150, MORPH_N = 32;
let tweenRoutes = false;     // set by runRouting so the NEXT draw morphs the lines that changed

// Has the routed geometry for a record moved enough to repaint/morph? (compares against its last
// adopted shape, stored on the display record as `_geo`/`_routed`.)
function geoChanged(rec, pts) {
    if (!rec._routed || !rec._geo || rec._geo.length !== pts.length) return true;
    for (let i = 0; i < pts.length; i++)
        if (Math.abs(rec._geo[i][0] - pts[i][0]) > 0.5 || Math.abs(rec._geo[i][1] - pts[i][1]) > 0.5) return true;
    return false;
}

let drawSig = "";   // link signature for THIS draw (compared against the route cache's)
// True while a node is being dragged. The line MODE never changes (always the A* 90° route);
// this only makes routing run SYNCHRONOUSLY each frame instead of one rAF later, so the route
// is recomputed and painted in the same frame the node moves — the line stays glued to the
// node (smooth) instead of trailing it by a frame. Per-frame routing cost is accepted.
let draggingNodes = false;
let draggedIds = null;   // Set of node ids under the cursor THIS drag (multi-node drags move many)
// Is a point still sitting on (or within a few px of) a node rect? A routed endpoint sits ON its
// node's edge; once that node is dragged away, the cached endpoint floats off it -> not onRect.
const onRect = (p, r, mar = 3) =>
    !!p && !!r && p[0] >= r.x - mar && p[0] <= r.x + r.w + mar && p[1] >= r.y - mar && p[1] <= r.y + r.h + mar;
// Orientation sign of (a,b,c); used by the segment-segment cross test.
const _ccw = (a, b, c) => (c[1] - a[1]) * (b[0] - a[0]) - (b[1] - a[1]) * (c[0] - a[0]);
// Do segments p1p2 and p3p4 cross? (standard straddle test, endpoints-touch counts as crossing)
function segSeg(p1, p2, p3, p4) {
    const d1 = _ccw(p3, p4, p1), d2 = _ccw(p3, p4, p2), d3 = _ccw(p1, p2, p3), d4 = _ccw(p1, p2, p4);
    return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}
// Does segment a→b touch axis-aligned rect r? (either end inside, or it cuts any rect edge.)
function segHitsRect(a, b, r) {
    const x2 = r.x + r.w, y2 = r.y + r.h;
    if (Math.max(a[0], b[0]) < r.x || Math.min(a[0], b[0]) > x2 ||
        Math.max(a[1], b[1]) < r.y || Math.min(a[1], b[1]) > y2) return false;   // bbox reject
    const inside = (p) => p[0] >= r.x && p[0] <= x2 && p[1] >= r.y && p[1] <= y2;
    if (inside(a) || inside(b)) return true;
    const tl = [r.x, r.y], tr = [x2, r.y], br = [x2, y2], bl = [r.x, y2];
    return segSeg(a, b, tl, tr) || segSeg(a, b, tr, br) || segSeg(a, b, br, bl) || segSeg(a, b, bl, tl);
}
// A frozen routed line is invalid this drag frame if a DRAGGED node (other than its own endpoints)
// has slid on top of it — any segment of its polyline now cuts through that node's rect.
function lineCrossesDragged(pts, aId, bId) {
    if (!draggedIds || pts.length < 2) return false;
    for (const did of draggedIds) {
        if (did === aId || did === bId) continue;   // its own endpoint nodes legitimately touch it
        const r = nodeRect(did);
        if (!r) continue;
        for (let i = 0; i < pts.length - 1; i++) if (segHitsRect(pts[i], pts[i + 1], r)) return true;
    }
    return false;
}
function drawEdges() {
    const links = buildLinks();
    // a selection dims every UNselected line (grayscale + near-transparent) so the selected node's
    // own lines read at a glance; the canvas renderer bakes the dim into each line's stroke/alpha.
    const anySel = selectedNodeId != null || selected.size > 0;
    drawSig = ROUTE.enabled ? linksSig(links) : "";   // change-gate: from the geometric facing ports
    // adopt the routed result's chosen faces/ports so the port dots + freshness check line up with
    // the painted path (the router, not the facing default, owns a routed line's endpoints).
    for (const l of links) {
        const c = routeCache.get(l.key);
        if (!c || !c.p1) continue;
        l.p1 = c.p1; l.d1 = c.d1; l.p2 = c.p2; l.d2 = c.d2;
        // While dragging we do NOT re-route — the live A* reglue looked janky. The cached routed path
        // stays frozen as the node moves; mark it stale (paint greys + fades it) when it can no longer
        // be trusted, on any of three counts. A clean route morphs back in once, on drag settle.
        //   (a) either ENDPOINT node is being dragged (its line must re-route to follow it),
        //   (b) an endpoint floated off its node rect (covers a dragged endpoint that already left),
        //   (c) a dragged node has slid ON TOP of this otherwise-stationary line (crosses its rect).
        if (draggingNodes && c.pts && c.pts.length >= 2)
            l._stale = (!!draggedIds && (draggedIds.has(l.aId) || draggedIds.has(l.bId)))
                || !onRect(c.pts[0], l.ra) || !onRect(c.pts[c.pts.length - 1], l.rb)
                || lineCrossesDragged(c.pts, l.aId, l.bId);
    }
    // node ids that are turned off — any line touching one is greyed (carries no live data)
    const disSet = new Set();
    for (const n of model.nodes()) if (CAN_DISABLE.has(n.type) && n.ref && n.ref.enabled === false) disSet.add(n.id);

    paintCanvas(links, disSet, anySel);

    // Place the port dots AFTER painting, and pin each dot to the PAINTED path's start, not the
    // freshly recomputed fan point: a path that kept an older shape (routing frozen during OCR, no
    // routed result yet) is never repainted above, so a dot placed at the new fan coord would sit a
    // few px off its own line whenever the node's size settled after the line was first drawn.
    // (A routed line already has l.p1 = its route's pts[0], adopted from routeCache above — also the
    // morph target, so a morphing line's dot goes straight to where the line is about to land.)
    // Don't re-fan the port dots mid-drag: each dot is a child of its node and rides it as the node
    // moves, so re-placing them every frame only makes them twitch (and lead the CSS-eased node).
    // They settle onto the fresh route when the drag ends and routing runs again.
    if (!draggingNodes) {
        for (const l of links) {
            const c = routeCache.get(l.key);
            const geo = l._rec && l._rec._geo;   // painted path start (canvas display record)
            if (!(c && c.pts && c.pts.length >= 2) && geo && geo.length) l.p1 = geo[0];
        }
        placePortDots(links);   // move each out-port grab handle onto where its line starts
    }
    tweenRoutes = false;
    scheduleRouting();   // pathfind to the 90° route; lines only ever paint a FINISHED route
}

// ---- canvas edge renderer -------------------------------------------------------------------
// One persistent display record per link (mirrors the <path> identity so a reroute MORPHS the
// same record), fed to edgecanvas.setEdges(). Style (colour/dash/caps/dim) is resolved here once
// per drawEdges; geometry rides the same morph logic as SVG but writes rec.pts, not a `d` string.
const canvasRecs = new Map();   // link key -> display record {pts,straight,stroke,alpha,width,lineCap,dash,capStart,capEnd,selColor, _geo,_routed,_raf}
let wireRec = null;             // live drag wire, drawn as a sampled cubic (not in canvasRecs)

// A cubic bezier sampled to a polyline so the canvas can draw the live drag wire straight-through.
function sampleCubic(p0, p1, p2, p3, n) {
    const out = [];
    for (let i = 0; i <= n; i++) {
        const t = i / n, u = 1 - t;
        out.push([u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
                  u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]]);
    }
    return out;
}

// Source-node hue fallback: the inline stroke wins in the SVG cascade, so a line with a known
// source type is that type's colour. Only a source WITHOUT a --nt token falls back to the per-kind
// stroke from graph.css (rare) — mapped here so those lines still match.
function kindColor(cs) {
    if (cs.has("data")) return cssVar("--data");
    if (cs.has("trigger")) return cssVar("--trigger-line");
    if (cs.has("watch")) return cssVar("--watch-line");
    if (cs.has("ownwin")) return cssVar("--nt-window");
    if (cs.has("owndict")) return cssVar("--nt-dictionary");
    if (cs.has("field")) return cssVar("--nt-region");
    if (cs.has("detect")) return cssVar("--nt-detect");
    if (cs.has("scrollbar")) return cssVar("--nt-scrollbar");
    if (cs.has("state")) return cssVar("--warn");
    if (cs.has("item")) return cssVar("--nt-item");
    if (cs.has("tell")) return cssVar("--nt-itemtell");
    if (cs.has("attach")) return cssVar("--accent");
    if (cs.has("img")) return cssVar("--muted");
    return cssVar("--line");
}

// Resolve a link's paint style (colour/dash/caps + the three dim states) into its record. Mirrors
// the graph.css cascade: caps by declaration order (later wins), dim alpha by specificity
// (stale !important > sel !important > sel-inactive .1 > dis .4).
function applyEdgeStyle(rec, l, dis, anySel, selCol) {
    const cs = new Set(l.cls.split(" "));
    const sel = cs.has("sel"), stale = !!l._stale;
    const isFlow = cs.has("flow"), isWatch = cs.has("watch"), isWire = cs.has("wire");
    const color = l.srcType ? typeColor(l.srcType) : kindColor(cs);
    const gray = dis || stale || (anySel && !sel);
    rec.stroke = gray ? grayscale(color) : color;
    rec.alpha = stale ? 0.3 : sel ? 1 : (anySel && !sel) ? 0.1 : dis ? 0.4 : 1;
    rec.width = 1.8;
    rec.dash = cs.has("img") ? [2, 4] : isWatch ? [1, 5] : isWire ? [4, 4] : [];
    rec.lineCap = isWatch ? "round" : "butt";
    rec.selColor = selCol;
    let capEnd = "squarecap";
    if (cs.has("toview")) capEnd = "flowarrow";
    if (isFlow) capEnd = "flowarrow";
    if (cs.has("trigger")) capEnd = "hexcap";
    if (isWatch) capEnd = "watchcap";
    let capStart = "squarecap";
    if (isFlow || isWatch) capStart = sel ? "portcap-sel" : "portcap";
    if (isWire) { capStart = null; capEnd = null; }
    rec.capStart = capStart; rec.capEnd = capEnd;
}

function cancelMorphC(rec) { if (rec && rec._raf) { cancelAnimationFrame(rec._raf); rec._raf = null; } }
function setRoutedC(rec, pts) { cancelMorphC(rec); rec._geo = pts; rec._routed = true; rec.pts = pts; rec.straight = false; }
function setElbowC(rec, l) {
    cancelMorphC(rec);
    const pts = dirElbowPts(l.p1[0], l.p1[1], l.d1, l.p2[0], l.p2[1], l.d2);
    rec._geo = pts; rec._routed = false; rec.pts = pts; rec.straight = false;
}
// Morph the record's geometry into the new routed shape (the canvas twin of startMorph): lerp
// resampled points each frame, redraw, land on the crisp rounded route.
function startMorphC(rec, toPts) {
    const from = resamplePoly(rec._geo && rec._geo.length ? rec._geo : toPts, MORPH_N);
    const to = resamplePoly(toPts, MORPH_N);
    cancelMorphC(rec);
    const t0 = performance.now();
    const tick = (now) => {
        let t = (now - t0) / MORPH_MS; if (t < 0) t = 0; if (t > 1) t = 1;
        const e = t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;   // easeInOutQuad
        rec.pts = from.map((p, i) => [p[0] + (to[i][0] - p[0]) * e, p[1] + (to[i][1] - p[1]) * e]);
        rec.straight = true;   // straight through the (dense) morph points — rounding wobbles, matches straightD
        requestRedraw();
        if (t < 1) rec._raf = requestAnimationFrame(tick);
        else { rec._raf = null; setRoutedC(rec, toPts); requestRedraw(); }
    };
    rec._raf = requestAnimationFrame(tick);
}

function paintCanvas(links, disSet, anySel) {
    const used = new Set();
    const selCol = cssVar("--sel");
    for (const l of links) {
        used.add(l.key);
        let rec = canvasRecs.get(l.key);
        if (!rec) { rec = { key: l.key }; canvasRecs.set(l.key, rec); }
        l._rec = rec;
        applyEdgeStyle(rec, l, disSet.has(l.aId) || disSet.has(l.bId), anySel, selCol);
        const c = routeCache.get(l.key);
        if (c && c.pts.length >= 2) {
            if (tweenRoutes && rec._routed && geoChanged(rec, c.pts)) startMorphC(rec, c.pts);
            else if (!rec._raf && geoChanged(rec, c.pts)) setRoutedC(rec, c.pts);
        } else if (!rec.pts) {
            setElbowC(rec, l);   // brand-new line: provisional elbow until the router runs
        }
    }
    for (const [k, rec] of canvasRecs) if (!used.has(k)) { cancelMorphC(rec); canvasRecs.delete(k); }
    const list = [...canvasRecs.values()];
    if (wire) {
        const dx = Math.max(30, (wire.x2 - wire.x1) / 2);
        wireRec = wireRec || { key: "__wire__", straight: true, width: 1.8, lineCap: "butt", dash: [4, 4], capStart: null, capEnd: null };
        wireRec.stroke = cssVar("--accent"); wireRec.alpha = 1; wireRec.selColor = selCol;
        wireRec.pts = sampleCubic([wire.x1, wire.y1], [wire.x1 + dx, wire.y1], [wire.x2 - dx, wire.y2], [wire.x2, wire.y2], 24);
        list.push(wireRec);
    } else wireRec = null;
    setEdges(list, { radius: ROUTE.radius });
}

// Coalesce edge redraws under a drag: each requestEdges() queues at most ONE redraw per
// animation frame, so the many mousemove events in a frame collapse to a single drawEdges()
// that paints the LATEST node positions (pos is mutated in place before this is called). The
// pending rAF IS the request — newer calls ride it instead of stacking a stale one behind it.
let _edgeRaf = 0;
function requestEdges() {
    if (_edgeRaf) return;   // a redraw is already queued; it'll read the newest positions when it runs
    _edgeRaf = requestAnimationFrame(() => {
        _edgeRaf = 0;
        // While dragging we never re-route (the live A* reglue was janky): just repaint the lines at
        // the node's new position, keeping each cached routed shape frozen (stale ones greyed). The
        // single clean re-route — morphed in — happens once on settle (flushEdges -> scheduleRouting).
        drawEdges();
    });
}
function flushEdges() {   // force the final frame now (drop on settle) — cancels any pending rAF
    if (_edgeRaf) { cancelAnimationFrame(_edgeRaf); _edgeRaf = 0; }
    drawEdges();
}

// ---- live line routing -----------------------------------------------------
// Pathfinding runs on its own rAF whenever the layout signature changes: drawEdges() requests a
// recompute, the A* fires on the next frame, then each changed line MORPHS into its new routed
// shape (interpolated, not snapped). Routing does NOT run mid-drag — the lines stay frozen at their
// last route (stale ones greyed) and re-route once on settle. It is cached + gated by a layout
// signature, so a frame where nothing moved is a no-op and the loop idles.
const ROUTE = {
    enabled: true,
    hier: true,         // hierarchical routing: each group routed as its own sub-problem, its boundary
                        // lines funnelled through fanned per-face GATES (hierRoute.js). Toggle off in the
                        // console (window.__route.hier=false; __reroute()) to fall back to one global pass.
    decollide: true,    // GLOBAL cross-pass de-collision (decollide.js): hier's isolated passes can each
                        // route a wire onto the same world coord (nudge only separates within a pass), so
                        // a final pass fans coincident runs apart. Toggle off: window.__route.decollide=false; __reroute()
    corners: "curve",   // "curve" | "square" — internal toggle (window.__route.corners)
    cell: 10,           // grid resolution (world px) — fine enough to squeeze a line between two others
    clearWanted: 5,     // cells of breathing room a line prefers around nodes
    radius: 14,         // corner rounding for "curve"
};
// internal handles: tweak ROUTE in the console, __reroute() to force a recompute
// (e.g. after flipping __route.corners to "square").
if (typeof window !== "undefined") {
    window.__route = ROUTE;
    window.__reroute = () => { routeCache = new Map(); routeHash = ""; hierPassCache = new Map(); drawEdges(); };   // force a full recompute
    // read-only e2e introspection (playwright): the routed geometry keyed by `${from} ${to}`, plus
    // every node's world rect — lets a test assert no edge passes through a non-endpoint node.
    window.__routes = () => { const o = {}; for (const [k, c] of routeCache) o[k] = { pts: c.pts, d1: c.d1, d2: c.d2 }; return o; };
    window.__nodeRects = () => { const o = {}; for (const id of nodeEls.keys()) { const r = nodeRect(id); if (r) o[id] = r; } return o; };
    // __overlaps(): scan the RENDERED edge geometry (the canvas display records — their `pts` are the
    // clean orthogonal polyline, no bezier control points to strip, and their key carries the real
    // endpoint ids) and report the two ways a line reads as "drawn on top of" something:
    //   coincident  — two DIFFERENT edges whose H (or V) segments share a coord (within `tol` px) and
    //                 overlap along their run (> `minOv` px). This is "two lines stacked on each other".
    //   throughNode — an edge segment that runs through the INTERIOR of a node that isn't its endpoint.
    // Console: `window.__overlaps()` — returns {coincident:[...], throughNode:[...]}.
    window.__overlaps = (tol = 2, minOv = 12) => {
        const rects = []; for (const id of nodeEls.keys()) { const r = nodeRect(id); if (r) rects.push({ id, ...r }); }
        const segs = [];                                  // {ei, axis, coord, lo, hi, ends:[fromId,toId]}
        let ei = 0;
        for (const [key, rec] of canvasRecs) {
            const P = rec.pts; ei++;
            if (!P || P.length < 2) continue;
            const sp = key.indexOf(" ");
            const ends = [key.slice(0, sp), key.slice(sp + 1)];
            for (let i = 0; i + 1 < P.length; i++) { const a = P[i], b = P[i + 1];
                if (Math.abs(a[1] - b[1]) < 0.6 && Math.abs(a[0] - b[0]) > 1) segs.push({ ei, ends, axis: "H", coord: a[1], lo: Math.min(a[0], b[0]), hi: Math.max(a[0], b[0]) });
                else if (Math.abs(a[0] - b[0]) < 0.6 && Math.abs(a[1] - b[1]) > 1) segs.push({ ei, ends, axis: "V", coord: a[0], lo: Math.min(a[1], b[1]), hi: Math.max(a[1], b[1]) });
            }
        }
        const coincident = [];
        for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
            const s = segs[i], t = segs[j];
            if (s.ei === t.ei || s.axis !== t.axis || Math.abs(s.coord - t.coord) > tol) continue;
            const ov = Math.min(s.hi, t.hi) - Math.max(s.lo, t.lo); if (ov <= minOv) continue;
            coincident.push({ axis: s.axis, coord: Math.round(s.coord), overlapPx: Math.round(ov), a: s.ends.join("→"), b: t.ends.join("→") });
        }
        const throughNode = [];
        for (const s of segs) for (const r of rects) {
            if (s.ends.includes(r.id)) continue;          // its own endpoint — not a violation
            const pad = 8, x0 = r.x + pad, x1 = r.x + r.w - pad, y0 = r.y + pad, y1 = r.y + r.h - pad;
            const hit = s.axis === "H" ? (s.coord > y0 && s.coord < y1 && s.hi > x0 && s.lo < x1)
                                       : (s.coord > x0 && s.coord < x1 && s.hi > y0 && s.lo < y1);
            if (hit) throughNode.push({ edge: s.ends.join("→"), through: r.id, axis: s.axis, coord: Math.round(s.coord) });
        }
        return { coincident, throughNode };
    };
}

let routeCache = new Map();     // link key -> { pts:[[x,y]…], sig } (sig = its own deps)
let routeHash = "";             // global layout signature of the last pass (cheap change gate)
let gateFaces = new Map();      // "key|gid" -> gate face last frame (hierRoute hysteresis, anti-flicker)
let hierPassCache = new Map();  // "outer"/"inner:<gid>" -> {sig,res}: memoised sub-pass routes (per-pass cache)
let routeRaf = null;            // pending requestAnimationFrame handle (one in flight at a time)

// Everything physical is an obstacle: nodes AND panels. Lines weave around all of
// them, not just the two rects they connect.
function obstacleRects({ boxes = true } = {}) {
    const out = [];
    for (const n of model.nodes()) { const r = nodeRect(n.id); if (r) out.push(r); }
    for (const t of groups.titleRects()) out.push(t);   // lines prefer not to cross a group title
    // group boxes: in hier mode a box IS a hard obstacle + drives every gate, so a box move/resize
    // (even without a routed node's own rect changing) must invalidate the route cache. deCollide
    // passes {boxes:false} — it takes the boxes as CONTAINERS (clamp, not freeze) instead.
    if (boxes) for (const b of groups.groupBoxes()) if (b.box) out.push(b.box);
    return out;
}

// Signature that invalidates the route cache: the ports of every link plus every
// obstacle rect. Any move/resize/open/close changes it (a moved node can reshape a
// route it isn't even an endpoint of, so obstacles must be in here too).
const rnd = (p) => `${Math.round(p[0])},${Math.round(p[1])}`;
function linksSig(links) {
    let s = `${ROUTE.cell}:${ROUTE.clearWanted}:`;
    for (const l of links) s += `${l.key}@${rnd(l.p1)}${l.d1}${rnd(l.p2)}${l.d2};`;
    for (const o of obstacleRects()) s += `${o.x},${o.y},${o.w},${o.h}|`;
    for (const b of groups.groupBoxes()) s += b.gate === false ? "u" : "g";   // gate toggle -> re-path
    return s;
}

function scheduleRouting() {
    if (!ROUTE.enabled) return;
    if (draggingNodes) return;           // no re-routing mid-drag — lines stay frozen (stale ones greyed);
                                         // the single clean route runs on settle
    if (routingFrozen) return;           // OCR in progress -> don't re-route (lines would wiggle)
    if (boot.phase) return;              // boot storm -> skip the A*/deCollide rAF hog; one clean pass runs on settle
    if (drawSig === routeHash) return;   // routes already current (drawSig set in drawEdges)
    if (routeRaf) return;                // one recompute already queued for the next frame
    routeRaf = requestAnimationFrame(runRouting);
}

function runRouting() {
    routeRaf = null;                     // this frame's pass is running; let drawEdges queue the next one
    const links = buildLinks();          // route the layout as it stands NOW
    const sig = linksSig(links);
    if (sig === routeHash) return;       // nothing moved since the last pass
    try {
        // The whole graph is routed in one pass (the engine needs every line together for face-
        // selection + nudging). Obstacles = every node; soft obstacles = groups. Carry each line's
        // last-frame faces in as hysteresis so a tiny move can't flip a route's whole shape.
        const nodes = [];
        for (const n of model.nodes()) { const r = nodeRect(n.id); if (r) nodes.push({ id: n.id, x: r.x, y: r.y, w: r.w, h: r.h }); }
        // pass the REAL rendered box + title-band height (groupBox uses PAD=40 + titleH, NOT the
        // router's member-bounds guess) so the heading soft/hard rect lands exactly on the banner.
        const boxOf = new Map(groups.groupBoxes().map((b) => [b.id, b]));
        const grps = groups.allGroups().map((g) => { const b = boxOf.get(g.id); return { members: [...g.members], box: b ? b.box : null, bandH: b ? b.bandH : 0 }; });
        // a DATA out-line leaves no pinned face: A* picks whichever of the 4 faces routes cleanest
        // (the port dot follows the chosen face). Watch/trigger control lines KEEP their semantic pin
        // (watch=L; fires=the side facing its targets) so the line leaves the port it belongs to; two
        // that share a face just fan apart. `port` still flags every port line so the router fans +
        // centres its endpoint on whatever face it lands on.
        const dataOut = (l) => l.portKind === "out" && PORT_OUT_SRC.some((p) => l.aId.startsWith(p));
        const edges = links.map((l) => ({ from: l.aId, to: l.bId, key: l.key, port: l.port, pinSrc: (l.port && !dataOut(l)) ? sideForPort(l) : null, tether: TETHER_KINDS.some((k) => l.cls.split(" ").includes(k)),
            // watch ends in a diamond sunk slightly into the watched node; trigger ends in a hollow ring
            // pulled back by its radius (3px) so the ring centres ON the fired node's edge. The data-flow
            // arrow needs NO inset: its marker is centred (refX=5) so it already straddles the edge, and
            // insetting would only push the line stub visibly inside the card (flow lines draw on top).
            insetEnd: l.portKind === "watch" ? 3 : (/\btrigger\b/.test(l.cls) ? 3 : 0) }));
        // every data source parks its out-port on the negotiated shared face (`outSide`); the router
        // keeps arriving lines off that dot when it's idle (`reserveMid`). A trigger's fires-port parks
        // on the side facing its targets (default R when it fires nothing).
        const outPorts = new Map();
        for (const n of nodes) {
            if (PORT_OUT_SRC.some((p) => n.id.startsWith(p))) outPorts.set(n.id, outSide);       // negotiated shared face
            else if (n.id.startsWith("trigger:")) outPorts.set(n.id, triggerSides.get(n.id)?.fires || "R");   // faces its targets
        }
        const prevSides = new Map();
        for (const [k, c] of routeCache) if (c.d1) prevSides.set(k, { d1: c.d1, d2: c.d2 });
        // subgroup + super-group TITLE bands as extra avoid rects: subgroup band sits at the TOP of
        // its box (height bandH), super-group label band at the BOTTOM (SUPER_LABEL_BAND tall).
        const titleBands = [];
        for (const b of groups.subGroupBoxes()) if (b.bandH > 0) titleBands.push({ x0: b.box.x, y0: b.box.y, x1: b.box.x + b.box.w, y1: b.box.y + b.bandH });
        // an ungated group is dropped from the hard-box hierarchy below (its members route as free
        // nodes, straight through its footprint) but its TITLE still reads as a heading — feed the band
        // in here the same way a subgroup's is, so lines still dodge it even though the box no longer does.
        for (const b of groups.groupBoxes()) if (b.gate === false && b.box && b.bandH > 0) titleBands.push({ x0: b.box.x, y0: b.box.y, x1: b.box.x + b.box.w, y1: b.box.y + b.bandH });
        // super-group: avoid only the watermark TEXT, not the whole bottom band — most of the band
        // is empty canvas the lines should be free to cross.
        for (const b of groups.superGroupBoxes()) {
            const r = b.labelRect;
            if (r) titleBands.push({ x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h });
            else if (b.bandH > 0) titleBands.push({ x0: b.box.x, y0: b.box.y + b.box.h - b.bandH, x1: b.box.x + b.box.w, y1: b.box.y + b.box.h });
        }
        const config = { clearance: ROUTE.cell * 2, laneGap: ROUTE.cell };
        let res;
        if (ROUTE.hier) {
            // hierarchical: collapse each group to a hard box and funnel its crossing lines through gates.
            // groupOf() returns the group RECORD; hierRoute/gates key off the group id. An ungated group
            // is left OUT of this map entirely: boxless to hierRoute/classifyAndGate means its members
            // route as free outer nodes and no gate is generated — fully transparent to the router (its
            // title band alone is still fed in above).
            const groupBox = new Map();
            for (const b of groups.groupBoxes()) if (b.box && b.gate !== false) groupBox.set(b.id, { x: b.box.x, y: b.box.y, w: b.box.w, h: b.box.h, bandH: b.bandH || 0 });
            const gof = (id) => { const r = groups.groupOf(id); return r ? r.id : null; };
            const out = hierRoute(nodes, groupBox, gof, edges, { prevSides, outPorts, titleBands, config, laneGap: ROUTE.cell, prevFace: gateFaces, passCache: hierPassCache });
            res = out.routes; gateFaces = out.faces; hierPassCache = out.passCache;
            // hier's isolated passes are mutually blind, so two can route a wire onto the identical world
            // coord (nudge only de-overlaps within a pass). Fan those coincident runs apart against every
            // obstacle (nodes + group boxes) + title band so a shift never crosses one. (single-pass
            // routeGraph below needs no such pass — it nudges the whole graph together.)
            if (ROUTE.decollide) {
                // Group boxes are CONTAINERS, not walls: a run inside its own box may still slide into
                // a parallel lane so long as it stays INSIDE the box. Freezing it (what a straddling
                // wall does) is what left sibling skip-edges stacked on one coord over a node row. Pass
                // boxes apart from the hard walls (nodes + title bands) a lane shift can't cross.
                const containers = groups.groupBoxes().filter((b) => b.box && b.gate !== false).map((b) => b.box);
                const walls = obstacleRects({ boxes: false })
                    .concat(titleBands.map((b) => ({ x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 })));
                res = deCollide(res, walls, { laneGap: ROUTE.cell, containers });
            }
        } else {
            res = routeGraph(nodes, grps, edges, { prevSides, outPorts, titleBands, config });
        }
        const fresh = new Map();
        for (const l of links) { const r = res.get(l.key); if (r && r.pts && r.pts.length >= 2) fresh.set(l.key, r); }
        routeCache = fresh;                 // also drops keys for links that vanished
        routeHash = sig;
    } catch (err) {
        setStatus(`route failed: ${err.message}`);   // surface instead of silently using elbows
        return;
    }
    tweenRoutes = true;   // a fresh route landed -> the next drawEdges animates each changed line into its
                          // new shape (interpolated morph) instead of snapping — feels far less janky
    drawEdges();
}

// Freeze edge re-routing while OCR runs. The image/cutout canvases redraw every read and
// fire their ResizeObservers -> drawEdges -> A* reroute, so the lines visibly wiggle during
// OCR (and continuously in live mode). While frozen, drawEdges keeps each line's current path
// and scheduleRouting skips the A*. Each OCR tick refreshes the timer, so a continuous live
// loop stays frozen; ~300ms after the last read it unfreezes and settles the routes once.
let routingFrozen = false;
let _routeFreezeTimer = null;
function freezeRouting() {
    routingFrozen = true;
    clearTimeout(_routeFreezeTimer);
    _routeFreezeTimer = setTimeout(() => { routingFrozen = false; drawEdges(); }, 300);
}

// main.js owns the drag interaction; it flips this flag so drawEdges keeps the cached routed lines
// frozen (greying any whose node has moved off them) instead of re-routing every frame; the clean
// route is computed once on settle.
export function setDraggingNodes(v, ids = null) { draggingNodes = v; draggedIds = v ? new Set(ids || []) : null; }

// World-space routed polyline for the edge between two node ids (the same key buildLinks uses,
// `${from} ${to}`), or null if that edge isn't drawn/routed yet. The ONE accessor for an edge's
// geometry — flow.js animates blobs along it instead of re-deriving link keys / route cache.
export function edgeGeometry(fromId, toId) {
    const c = routeCache.get(`${fromId} ${toId}`);
    return c && c.pts && c.pts.length >= 2 ? c.pts : null;
}

export { drawEdges, requestEdges, flushEdges, buildLinks, nodeRect, freezeRouting, routeCache, ROUTE };
