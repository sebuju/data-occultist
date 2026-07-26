// Alignment + spacing guides. When one or more nodes are SELECTED, DRAGGED or RESIZED, draw faint
// guide lines to nearby nodes whose left/centre/right (x) or top/middle/bottom (y) coordinate
// lines up with the moving node(s) — so a node can be squared up with its surroundings by eye —
// PLUS, per side (left/right/top/bottom), a measurement line + px label to the nearest node that
// overlaps the moving bbox on that side, so gaps can be matched by eye too. Visual only: the node
// still moves/resizes on the 20px grid, the guides just show what it lines up / spaces against.
// An alignment line is drawn ONLY in the empty space between the boxes it ties together (never over
// a node body, its own or a bystander's) and only against neighbours currently on screen — see
// lineSegments / viewWorld.
// A RESIZE additionally stamps a W×H badge dead-centre of each resized node (showGuides/flashGuides
// `size: true`), so the settled box size is readable for as long as its guides are up.
// Recomputed live each drag/resize frame (showGuides), cleared on deselect/settle.
//
// A lazy <svg id="gguides"> lives inside #gworld (like flow.js's #gflow), so it rides the pan/zoom
// transform for free — coords are world units. Lines use non-scaling-stroke so they stay a crisp
// 1px at any zoom; the spacing label counter-scales zoom so its text stays a constant screen size.

import { pos, nw, nh, nodeEls, view } from "./state.js";

const SVGNS = "http://www.w3.org/2000/svg";
const TOL = 4;   // world px: two coords within this count as aligned (grid snap makes exact common)

// `live`: read the node's PAINTED box instead of its target position. A node mid-grid-snap is eased
// to its new left/top by CSS (.gnode.snapping, 90ms) — so for the length of that ease the box on
// screen trails `pos`. Guides drawn from `pos` therefore detach from the node edge, which shows up
// worst on the distance guides (their line endpoint + px label sit right on that edge). offsetLeft/
// offsetTop return the INTERPOLATED value mid-transition, and #gnodes is the offsetParent at the
// world origin, so they're the same coordinate space as `pos`.
// Only the moving subject is ever easing; every other node is static, so `pos` is exact for them —
// and far cheaper, which matters because the guide pass reads every node in the graph.
const rectOf = (id, live) => {
    const el = live && nodeEls.get(id);
    if (el) return { x: el.offsetLeft, y: el.offsetTop, w: nw(id), h: nh(id) };
    const p = pos.get(id);
    return p && { x: p.x, y: p.y, w: nw(id), h: nh(id) };
};
// the 3 alignment coords on each axis: near edge, centre, far edge
const xsOf = (r) => [r.x, r.x + r.w / 2, r.x + r.w];
const ysOf = (r) => [r.y, r.y + r.h / 2, r.y + r.h];

// The world rect currently on screen, padded by one viewport. Guides are only ever drawn against
// neighbours inside it: a node thousands of world px away is not something the user is squaring up
// against, and matching one used to stretch a single alignment line clean across the graph (an
// 11000px line through a dozen unrelated nodes, ending nowhere near the pair it was about).
// Same screen->world mapping as everywhere else (#gpan translate + #gworld scale).
function viewWorld() {
    const g = document.getElementById("graph");
    const r = g ? g.getBoundingClientRect() : { width: window.innerWidth, height: window.innerHeight };
    const z = view.zoom || 1;
    const x = -view.panX / z, y = -view.panY / z, w = r.width / z, h = r.height / z;
    return { x: x - w, y: y - h, w: w * 3, h: h * 3 };   // one viewport of slack on every side
}
const hits = (r, b) => r.x < b.x + b.w && r.x + r.w > b.x && r.y < b.y + b.h && r.y + r.h > b.y;

// Split an alignment line into the segments that cover NO node. `spans` = the perpendicular lo..hi
// of every box the line ties together (they set how far the line runs); `blocked` = the same for
// every other box the line would cross on its way. The line runs from the first participant to the
// last (plus a short overhang past each outer end, which is what keeps it visible when two boxes
// touch and there's no gap to draw in) MINUS every box span, so it stitches the aligned boxes
// without ever being drawn over a body — and its ends land on the box edges the guide is about.
const OVERHANG = 14;   // world px of line past the outermost box on each side
function lineSegments(spans, blocked) {
    let start = Infinity, end = -Infinity;
    for (const [lo, hi] of spans) { start = Math.min(start, lo); end = Math.max(end, hi); }
    const cuts = [...spans, ...blocked].sort((a, b) => a[0] - b[0]);
    const out = [];
    let at = start - OVERHANG;
    const tail = end + OVERHANG;
    for (const [lo, hi] of cuts) {
        if (hi <= at) continue;
        if (lo > at) out.push([at, Math.min(lo, tail)]);
        at = Math.max(at, hi);
        if (at >= tail) break;
    }
    if (at < tail) out.push([at, tail]);
    return out.filter(([a, b]) => b - a > 0.5);
}

let layer = null;
function ensureLayer() {
    if (layer && layer.isConnected) return layer;
    const world = document.getElementById("gworld");
    if (!world) return null;
    layer = document.createElementNS(SVGNS, "svg");
    layer.setAttribute("id", "gguides");
    world.appendChild(layer);   // after #gedges-top/#gflow -> draws on top; pointer-events off (CSS)
    return layer;
}

// Auto-clear timer for flashGuides (a WASD nudge shows guides that fade shortly after the last
// step). A continuous showGuides (drag) cancels it, so a live drag never self-clears mid-move.
let clearTimer = null;
function cancelTimer() { if (clearTimer) { clearTimeout(clearTimer); clearTimer = null; } }

// The ids the CURRENTLY VISIBLE guides were drawn for (null = nothing showing). Remembering the
// subject is what lets any node move re-derive the same guides at the new positions instead of
// leaving the old lines behind — see refreshGuides.
let subject = null;
// Show a W×H badge over each subject node — set by the RESIZE call sites only, so a plain move/
// select never reports a size. Rides `subject`'s lifetime: it lives exactly as long as the guides.
let withSize = false;
let dirty = false, _raf = 0;

export function clearGuides() {
    cancelTimer();
    subject = null; withSize = false; dirty = false;
    if (_raf) { cancelAnimationFrame(_raf); _raf = 0; }
    if (layer) layer.replaceChildren();
}

// Redraw the visible guides at the nodes' CURRENT positions. Called from positionNode — the one
// writer of a node's left/top — so guides stay glued to the geometry no matter what moved a node
// (drag, clone-drag, keyboard nudge, undo, group absorb, a full render). No-op when nothing is
// showing, so this never makes guides APPEAR; it only keeps existing ones honest.
// Coalesced to one redraw per frame: positionNode runs in tight loops (a render places every node),
// and the guide pass scans all nodes, so a redraw per call would be quadratic.
export function refreshGuides() {
    if (!subject) return;
    dirty = true;
    schedule();
}
function schedule() {
    if (_raf) return;
    _raf = requestAnimationFrame(() => { _raf = 0; if (dirty) { dirty = false; draw(); } });
}

function guideLine(x1, y1, x2, y2) {
    const el = document.createElementNS(SVGNS, "line");
    el.setAttribute("class", "align-guide");
    el.setAttribute("x1", x1); el.setAttribute("y1", y1);
    el.setAttribute("x2", x2); el.setAttribute("y2", y2);
    return el;
}
function spacingLine(x1, y1, x2, y2) {
    const el = document.createElementNS(SVGNS, "line");
    el.setAttribute("class", "spacing-guide");
    el.setAttribute("x1", x1); el.setAttribute("y1", y1);
    el.setAttribute("x2", x2); el.setAttribute("y2", y2);
    return el;
}
// Label = a small pill (bg rect + centred text) so it reads over a guide line or a node underneath
// instead of just a halo-stroked glyph. Sized from the string WITHOUT getBBox (a live drag/resize
// redraws every frame — getBBox forces layout and would make that expensive); monospace + a fixed
// digit width both make that a safe estimate.
// ONE pill primitive, two callers (rule 7): the spacing gap labels and the resize W×H badge — they
// differ only in text + class, so the geometry/counter-scale maths lives here once.
const LABEL_CHAR_W = 0.62;   // digit width as a fraction of font-size, for --font-mono
const LABEL_PAD = 4;         // world px padding each side, at font-size scale (counter-scaled like the text)
function pillLabel(cx, cy, text, cls) {
    const fs = 12 / (view.zoom || 1);   // counter-scale #gworld's zoom -> constant screen size
    const pad = LABEL_PAD / (view.zoom || 1);
    const w = text.length * fs * LABEL_CHAR_W + pad * 2, h = fs + pad * 2;
    const g = document.createElementNS(SVGNS, "g");
    g.setAttribute("class", cls);
    const rect = document.createElementNS(SVGNS, "rect");
    rect.setAttribute("x", cx - w / 2); rect.setAttribute("y", cy - h / 2);
    rect.setAttribute("width", w); rect.setAttribute("height", h);
    rect.setAttribute("rx", pad * 0.6);
    const el = document.createElementNS(SVGNS, "text");
    el.setAttribute("x", cx); el.setAttribute("y", cy);
    el.style.fontSize = `${fs}px`;   // inline style beats CSS/presentation-attr specificity
    el.textContent = text;
    g.append(rect, el);
    return g;
}
const spacingLabel = (cx, cy, gap) => pillLabel(cx, cy, `${Math.round(gap)}`, "spacing-label");
// W×H badge for a just-resized node, pinned to the CENTRE of that node's own box (not the union
// bbox — with several nodes resized at once each one reports its own size over itself).
const sizeBadge = (r) => pillLabel(r.x + r.w / 2, r.y + r.h / 2, `${Math.round(r.w)} × ${Math.round(r.h)}`, "size-badge");
// Per side (L/R/T/B), find every OTHER rect whose perpendicular span overlaps the moving bbox on
// that side, and draw a measurement line + px label to each — but only ONE per "lane": sorted
// nearest-first, a candidate is skipped once its overlap span is already covered by a nearer kept
// neighbour (so two nodes directly in line draw just the nearer one; two nodes offset to different
// heights/widths on the same side each get their own line). "Overlap" keeps a line meaningful (it
// visibly connects the two facing edges) instead of pointing at an unrelated node off to the side.
function drawSpacing(frag, mbox, others) {
    const sides = [
        { key: "left", near: (r) => r.x + r.w <= mbox.x, gap: (r) => mbox.x - (r.x + r.w), overlap: (r) => Math.min(mbox.y + mbox.h, r.y + r.h) - Math.max(mbox.y, r.y) },
        { key: "right", near: (r) => r.x >= mbox.x + mbox.w, gap: (r) => r.x - (mbox.x + mbox.w), overlap: (r) => Math.min(mbox.y + mbox.h, r.y + r.h) - Math.max(mbox.y, r.y) },
        { key: "top", near: (r) => r.y + r.h <= mbox.y, gap: (r) => mbox.y - (r.y + r.h), overlap: (r) => Math.min(mbox.x + mbox.w, r.x + r.w) - Math.max(mbox.x, r.x) },
        { key: "bottom", near: (r) => r.y >= mbox.y + mbox.h, gap: (r) => r.y - (mbox.y + mbox.h), overlap: (r) => Math.min(mbox.x + mbox.w, r.x + r.w) - Math.max(mbox.x, r.x) },
    ];
    for (const s of sides) {
        const candidates = others
            .map((r) => ({ r, gap: s.gap(r), lo: s.key === "left" || s.key === "right" ? Math.max(mbox.y, r.y) : Math.max(mbox.x, r.x), hi: s.key === "left" || s.key === "right" ? Math.min(mbox.y + mbox.h, r.y + r.h) : Math.min(mbox.x + mbox.w, r.x + r.w) }))
            .filter((c) => s.near(c.r) && c.hi - c.lo > 0 && c.gap >= 0)
            .sort((a, b) => a.gap - b.gap);
        const covered = [];   // [lo,hi] spans already claimed by a nearer kept neighbour on this side
        for (const c of candidates) {
            if (covered.some(([lo, hi]) => c.lo < hi && c.hi > lo)) continue;   // lane already covered
            covered.push([c.lo, c.hi]);
            const mid = (c.lo + c.hi) / 2;
            if (s.key === "left" || s.key === "right") {
                const x1 = s.key === "left" ? c.r.x + c.r.w : mbox.x + mbox.w;
                const x2 = s.key === "left" ? mbox.x : c.r.x;
                frag.appendChild(spacingLine(x1, mid, x2, mid));
                frag.appendChild(spacingLabel((x1 + x2) / 2, mid, c.gap));
            } else {
                const y1 = s.key === "top" ? c.r.y + c.r.h : mbox.y + mbox.h;
                const y2 = s.key === "top" ? mbox.y : c.r.y;
                frag.appendChild(spacingLine(mid, y1, mid, y2));
                frag.appendChild(spacingLabel(mid, (y1 + y2) / 2, c.gap));
            }
        }
    }
}

// Draw guides for `ids` (the selected / dragged node set) against every OTHER node. The moving
// reference is the UNION bounding box of `ids`, so a single drag, a shift-subtree drag and a
// multi-select drag all align the same way (the cluster's edges + centre).
// `size: true` (resize call sites) additionally stamps each subject node's W×H at its centre.
export function showGuides(ids, { size = false } = {}) {
    cancelTimer();   // a live (drag) redraw owns the layer — drop any pending flash auto-clear
    subject = [...ids]; withSize = size;
    // This draw supersedes any queued re-sync: drop it rather than leave a no-op frame callback
    // pending every frame of a drag (positionNode queues one, then this runs later in the same frame).
    dirty = false;
    if (_raf) { cancelAnimationFrame(_raf); _raf = 0; }
    draw();
}

// Draw the guides for the current `subject`. Split out of showGuides so a plain re-sync
// (refreshGuides) redraws the SAME subject without re-stating who it is.
function draw() {
    const svg = ensureLayer();
    if (!svg) return;
    const ids = subject || [];
    const moving = new Set(ids);
    const rects = ids.map((id) => rectOf(id, true)).filter(Boolean);   // painted box — see rectOf
    if (!rects.length) { svg.replaceChildren(); return; }
    // Still easing toward the target? Keep redrawing until the painted box ARRIVES. Position changes
    // alone don't cover the TAIL of the ease: hold the pointer still mid-drag (or finish a WASD
    // glide) and nothing calls back, so the guides would freeze while the node slides out from under
    // them. Release is already fine — settle drops `.snapping` first, which lands the node at once.
    // Gated on `.snapping` (the class that carries the transition) AND a ≥1px gap: offsetLeft is
    // integer-rounded while pos can be fractional, so chasing exact equality could spin forever.
    if (ids.some((id) => {
        const el = nodeEls.get(id), p = pos.get(id);
        if (!el || !p || !el.classList.contains("snapping")) return false;
        return Math.abs(el.offsetLeft - p.x) >= 1 || Math.abs(el.offsetTop - p.y) >= 1;
    })) { dirty = true; schedule(); }
    const bx = Math.min(...rects.map((r) => r.x)), by = Math.min(...rects.map((r) => r.y));
    const br = Math.max(...rects.map((r) => r.x + r.w)), bb = Math.max(...rects.map((r) => r.y + r.h));
    const mbox = { x: bx, y: by, w: br - bx, h: bb - by };
    const mxs = xsOf(mbox), mys = ysOf(mbox);

    // matched guides keyed by rounded coord; each entry collects the perpendicular SPAN of every box
    // the line ties together (the moving bbox + each matched neighbour), kept as separate spans so
    // the line can later be drawn only in the gaps BETWEEN them (gapSegments) instead of straight
    // over their bodies.
    const vlines = new Map();   // x coord -> { c, spans: [[y0,y1], ...] }  (vertical line at x=c)
    const hlines = new Map();   // y coord -> { c, spans: [[x0,x1], ...] }  (horizontal line at y=c)
    const bump = (map, coord, lo, hi) => {
        const k = Math.round(coord);
        const g = map.get(k) || { c: coord, spans: [] };
        g.spans.push([lo, hi]);
        map.set(k, g);
    };
    const vis = viewWorld();
    const others = [];   // every other VISIBLE node's rect, reused below for the distance guides
    for (const id of nodeEls.keys()) {
        if (moving.has(id)) continue;
        const r = rectOf(id);
        if (!r || !hits(r, vis)) continue;   // off-screen neighbours are not what's being lined up
        others.push(r);
        for (const ox of xsOf(r)) for (const mx of mxs) if (Math.abs(mx - ox) <= TOL) {
            bump(vlines, ox, r.y, r.y + r.h);
        }
        for (const oy of ysOf(r)) for (const my of mys) if (Math.abs(my - oy) <= TOL) {
            bump(hlines, oy, r.x, r.x + r.w);
        }
    }
    const frag = document.createDocumentFragment();
    // Boxes the line merely PASSES OVER (not aligned with it) block it too — an unrelated node
    // sitting between two aligned ones used to get a guide drawn straight across its body.
    // `> 0.5` so a box whose own edge IS the guide coordinate doesn't count as blocking itself.
    const crossedY = (c) => others.filter((r) => c - r.x > 0.5 && r.x + r.w - c > 0.5).map((r) => [r.y, r.y + r.h]);
    const crossedX = (c) => others.filter((r) => c - r.y > 0.5 && r.y + r.h - c > 0.5).map((r) => [r.x, r.x + r.w]);
    for (const g of vlines.values()) for (const [lo, hi] of lineSegments([[mbox.y, mbox.y + mbox.h], ...g.spans], crossedY(g.c)))
        frag.appendChild(guideLine(g.c, lo, g.c, hi));
    for (const g of hlines.values()) for (const [lo, hi] of lineSegments([[mbox.x, mbox.x + mbox.w], ...g.spans], crossedX(g.c)))
        frag.appendChild(guideLine(lo, g.c, hi, g.c));
    drawSpacing(frag, mbox, others);
    // last, so the badge sits over the guide lines it shares the box with
    if (withSize) for (const r of rects) frag.appendChild(sizeBadge(r));
    svg.replaceChildren(frag);
}

// Draw guides, then auto-clear after `ms` — for a discrete WASD move/resize (no drag to end them).
// Each nudge resets the timer, so a burst of steps keeps the guides up until ~ms after the last.
export function flashGuides(ids, { ms = 1200, size = false } = {}) {
    showGuides(ids, { size });   // cancels any prior timer
    clearTimer = setTimeout(() => { clearTimer = null; clearGuides(); }, ms);
}
