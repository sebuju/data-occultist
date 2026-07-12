// Alignment guides. When one or more nodes are SELECTED or being DRAGGED, draw faint guide
// lines to nearby nodes whose left/centre/right (x) or top/middle/bottom (y) coordinate lines
// up with the moving node(s) — so a node can be squared up with its surroundings by eye. Visual
// only: the node still moves on the 20px grid, the guides just show what it aligns to. Recomputed
// live each drag frame (showGuides), cleared on deselect/settle.
//
// A lazy <svg id="gguides"> lives inside #gworld (like flow.js's #gflow), so it rides the pan/zoom
// transform for free — coords are world units. Lines use non-scaling-stroke so they stay a crisp
// 1px at any zoom.

import { pos, nw, nh, nodeEls } from "./state.js";

const SVGNS = "http://www.w3.org/2000/svg";
const TOL = 4;   // world px: two coords within this count as aligned (grid snap makes exact common)

const rectOf = (id) => { const p = pos.get(id); return p && { x: p.x, y: p.y, w: nw(id), h: nh(id) }; };
// the 3 alignment coords on each axis: near edge, centre, far edge
const xsOf = (r) => [r.x, r.x + r.w / 2, r.x + r.w];
const ysOf = (r) => [r.y, r.y + r.h / 2, r.y + r.h];

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

export function clearGuides() { cancelTimer(); if (layer) layer.replaceChildren(); }

function guideLine(x1, y1, x2, y2) {
    const el = document.createElementNS(SVGNS, "line");
    el.setAttribute("class", "align-guide");
    el.setAttribute("x1", x1); el.setAttribute("y1", y1);
    el.setAttribute("x2", x2); el.setAttribute("y2", y2);
    return el;
}

// Draw guides for `ids` (the selected / dragged node set) against every OTHER node. The moving
// reference is the UNION bounding box of `ids`, so a single drag, a shift-subtree drag and a
// multi-select drag all align the same way (the cluster's edges + centre).
export function showGuides(ids) {
    const svg = ensureLayer();
    if (!svg) return;
    cancelTimer();   // a live (drag) redraw owns the layer — drop any pending flash auto-clear
    const moving = new Set(ids);
    const rects = ids.map(rectOf).filter(Boolean);
    if (!rects.length) { svg.replaceChildren(); return; }
    const bx = Math.min(...rects.map((r) => r.x)), by = Math.min(...rects.map((r) => r.y));
    const br = Math.max(...rects.map((r) => r.x + r.w)), bb = Math.max(...rects.map((r) => r.y + r.h));
    const mbox = { x: bx, y: by, w: br - bx, h: bb - by };
    const mxs = xsOf(mbox), mys = ysOf(mbox);

    // matched guides keyed by rounded coord; grow each line's perpendicular span to cover every
    // involved rect (the moving bbox + each matched neighbour) so it visibly connects them.
    const vlines = new Map();   // x coord -> { c, lo, hi }  (vertical line at x=c, spanning y lo..hi)
    const hlines = new Map();   // y coord -> { c, lo, hi }  (horizontal line at y=c, spanning x lo..hi)
    const bump = (map, coord, lo, hi) => {
        const k = Math.round(coord);
        const g = map.get(k) || { c: coord, lo, hi };
        g.lo = Math.min(g.lo, lo); g.hi = Math.max(g.hi, hi);
        map.set(k, g);
    };
    for (const id of nodeEls.keys()) {
        if (moving.has(id)) continue;
        const r = rectOf(id);
        if (!r) continue;
        for (const ox of xsOf(r)) for (const mx of mxs) if (Math.abs(mx - ox) <= TOL) {
            bump(vlines, ox, Math.min(mbox.y, r.y), Math.max(mbox.y + mbox.h, r.y + r.h));
        }
        for (const oy of ysOf(r)) for (const my of mys) if (Math.abs(my - oy) <= TOL) {
            bump(hlines, oy, Math.min(mbox.x, r.x), Math.max(mbox.x + mbox.w, r.x + r.w));
        }
    }
    const frag = document.createDocumentFragment();
    for (const g of vlines.values()) frag.appendChild(guideLine(g.c, g.lo, g.c, g.hi));
    for (const g of hlines.values()) frag.appendChild(guideLine(g.lo, g.c, g.hi, g.c));
    svg.replaceChildren(frag);
}

// Draw guides, then auto-clear after `ms` — for a discrete WASD move/resize (no drag to end them).
// Each nudge resets the timer, so a burst of steps keeps the guides up until ~ms after the last.
export function flashGuides(ids, ms = 1200) {
    showGuides(ids);          // cancels any prior timer
    clearTimer = setTimeout(() => { clearTimer = null; clearGuides(); }, ms);
}
