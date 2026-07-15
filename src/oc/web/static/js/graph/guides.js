// Alignment + spacing guides. When one or more nodes are SELECTED, DRAGGED or RESIZED, draw faint
// guide lines to nearby nodes whose left/centre/right (x) or top/middle/bottom (y) coordinate
// lines up with the moving node(s) — so a node can be squared up with its surroundings by eye —
// PLUS, per side (left/right/top/bottom), a measurement line + px label to the nearest node that
// overlaps the moving bbox on that side, so gaps can be matched by eye too. Visual only: the node
// still moves/resizes on the 20px grid, the guides just show what it lines up / spaces against.
// Recomputed live each drag/resize frame (showGuides), cleared on deselect/settle.
//
// A lazy <svg id="gguides"> lives inside #gworld (like flow.js's #gflow), so it rides the pan/zoom
// transform for free — coords are world units. Lines use non-scaling-stroke so they stay a crisp
// 1px at any zoom; the spacing label counter-scales zoom so its text stays a constant screen size.

import { pos, nw, nh, nodeEls, view } from "./state.js";

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
const LABEL_CHAR_W = 0.62;   // digit width as a fraction of font-size, for --font-mono
const LABEL_PAD = 4;         // world px padding each side, at font-size scale (counter-scaled like the text)
function spacingLabel(cx, cy, gap) {
    const text = `${Math.round(gap)}`;
    const fs = 12 / (view.zoom || 1);   // counter-scale #gworld's zoom -> constant screen size
    const pad = LABEL_PAD / (view.zoom || 1);
    const w = text.length * fs * LABEL_CHAR_W + pad * 2, h = fs + pad * 2;
    const g = document.createElementNS(SVGNS, "g");
    g.setAttribute("class", "spacing-label");
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
    const others = [];   // every other node's rect, reused below for the distance guides
    for (const id of nodeEls.keys()) {
        if (moving.has(id)) continue;
        const r = rectOf(id);
        if (!r) continue;
        others.push(r);
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
    drawSpacing(frag, mbox, others);
    svg.replaceChildren(frag);
}

// Draw guides, then auto-clear after `ms` — for a discrete WASD move/resize (no drag to end them).
// Each nudge resets the timer, so a burst of steps keeps the guides up until ~ms after the last.
export function flashGuides(ids, ms = 1200) {
    showGuides(ids);          // cancels any prior timer
    clearTimer = setTimeout(() => { clearTimer = null; clearGuides(); }, ms);
}
