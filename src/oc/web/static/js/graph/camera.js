// Canvas camera: pan, zoom, fit-to-node, and the world transform. The viewport's pan/zoom lives
// in the shared `view` object (state.js); this module is the only place that animates it and
// writes the #gworld transform. Extracted from main.js — depends on the shared state + a couple
// of sibling modules (floating-panel geometry, the node-map indicator), never on render/model.
import { $, view, pos, nodeEls, overlays } from "./state.js";
import { floatWins } from "./floatwin.js";
import { persist } from "./persist.js";
import { nmUpdateViewport } from "./panels/nodemap.js";
import { scaleGroupBorders } from "./groups.js";

let panAnim = null;
export function cancelPan() { if (panAnim) { cancelAnimationFrame(panAnim); panAnim = null; } }

export function panTo(id) {
    const p = pos.get(id), el = nodeEls.get(id);
    if (!p || !el) return;
    const u = usableViewport();   // clear of floating panels
    const z = view.zoom, ew = el.offsetWidth, eh = el.offsetHeight;
    const left = p.x * z + view.panX, top = p.y * z + view.panY;
    if (left >= u.left && top >= u.top && left + ew * z <= u.left + u.w && top + eh * z <= u.top + u.h) return;  // already in the clear
    const tx = (u.left + u.w / 2) - (p.x + ew / 2) * z;
    const ty = (u.top + u.h / 2) - (p.y + eh / 2) * z;
    const sx = view.panX, sy = view.panY, t0 = performance.now(), dur = 380;
    cancelPan();
    const step = (now) => {
        let t = (now - t0) / dur; if (t > 1) t = 1;
        const e = t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;   // easeInOutQuad
        view.panX = sx + (tx - sx) * e; view.panY = sy + (ty - sy) * e;
        applyView();
        panAnim = t < 1 ? requestAnimationFrame(step) : null;
    };
    panAnim = requestAnimationFrame(step);
}

// Hard zoom-in ceiling: nodes inherit the body font (--fs-md), so on-screen text = baseFont ×
// zoom. Cap so it never renders larger than 16px — i.e. don't zoom closer than 16/baseFont.
// Read the computed value (tracks the CSS var; no hard-coded px). Used by fit/pan-zoom-to only —
// the manual wheel is unrestricted.
const MAX_FONT_PX = 16;
let _maxZoom = null;
export function maxZoom() {
    if (_maxZoom == null) _maxZoom = MAX_FONT_PX / (parseFloat(getComputedStyle(document.body).fontSize) || 14);
    return _maxZoom;
}

// Comfortable zoom to fit a node in the viewport, with only a small margin around it
// (tight, not lots of empty space). Shared by double-click AND the node-map jump.
const FIT_FILL = 0.96;   // node spans this fraction of the viewport
const FIT_MAX = 4;       // allow zooming further in for small nodes
export function fitZoom(w, h, rect) {
    return Math.min(maxZoom(), Math.max(0.15, Math.min(FIT_MAX, (rect.width * FIT_FILL) / w, (rect.height * FIT_FILL) / h)));
}

// The part of the graph viewport NOT covered by any visible, uncollapsed floating window —
// so pan/zoom centres a node in clear space instead of behind a panel. Each panel clips the
// usable box on whichever side it intrudes least (panels hug an edge, so this carves them
// off cleanly); chained/overlapping panels just clip in turn. Returns graph-local coords.
export function usableViewport() {
    const rect = $("graph").getBoundingClientRect();
    let L = 0, T = 0, R = rect.width, B = rect.height;
    for (const [, w] of floatWins()) {
        if (w.el.hidden || w.state.collapsed) continue;
        const r = w.el.getBoundingClientRect();
        const l = Math.max(r.left - rect.left, L), t = Math.max(r.top - rect.top, T);
        const rr = Math.min(r.right - rect.left, R), bb = Math.min(r.bottom - rect.top, B);
        if (rr <= l || bb <= t) continue;   // no overlap with the current usable box
        const fromL = rr - L, fromR = R - l, fromT = bb - T, fromB = B - t;
        const m = Math.min(fromL, fromR, fromT, fromB);
        if (m === fromL) L = rr; else if (m === fromR) R = l; else if (m === fromT) T = bb; else B = t;
    }
    // ignore the inset if it leaves no room (panels cover the viewport) — fall back to full rect
    if (R - L < 80) { L = 0; R = rect.width; }
    if (B - T < 80) { T = 0; B = rect.height; }
    return { left: L, top: T, w: R - L, h: B - T };
}

// Smoothly pan AND zoom to centre a WORLD rect {x,y,w,h}. fit=true picks a comfortable zoom
// to frame it, else keeps the current zoom. The shared core of panZoomTo (node) and the
// group double-click jump.
// onlyIn=true makes the move ZOOM-IN-ONLY: if the camera is already closer than the fit zoom,
// framing would zoom OUT (jarring on a double-click) — skip the whole move instead.
// Returns true if the camera actually moved (a target far enough from the current view to
// animate); false when the rect is already framed, so callers can fall back to another action.
export function panZoomToRect(box, { fit = true, onlyIn = false } = {}) {
    if (!box || !box.w || !box.h) return false;
    const u = usableViewport();   // centre in the area clear of floating panels
    const tz = fit ? fitZoom(box.w, box.h, { width: u.w, height: u.h }) : view.zoom;
    if (onlyIn && tz < view.zoom - 1e-3) return false;   // already closer than fit → don't zoom out
    const tx = (u.left + u.w / 2) - (box.x + box.w / 2) * tz;
    const ty = (u.top + u.h / 2) - (box.y + box.h / 2) * tz;
    const sx = view.panX, sy = view.panY, sz = view.zoom, t0 = performance.now(), dur = 380;
    if (Math.abs(tx - sx) < 0.5 && Math.abs(ty - sy) < 0.5 && Math.abs(tz - sz) < 1e-3) return false;  // already framed
    cancelPan();
    const step = (now) => {
        let t = (now - t0) / dur; if (t > 1) t = 1;
        const e = t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;   // easeInOutQuad
        view.panX = sx + (tx - sx) * e; view.panY = sy + (ty - sy) * e; view.zoom = sz + (tz - sz) * e;
        applyView(); updateOverlayZoom();
        panAnim = t < 1 ? requestAnimationFrame(step) : null;
        if (!panAnim) persist.local();
    };
    panAnim = requestAnimationFrame(step);
    return true;
}

// Smoothly pan AND zoom to centre a node (the node-map jump). Returns whether the camera moved.
export function panZoomTo(id, opts = {}) {
    const el = nodeEls.get(id), p = pos.get(id);
    if (!el || !p) return false;
    return panZoomToRect({ x: p.x, y: p.y, w: el.offsetWidth || 220, h: el.offsetHeight || 80 }, opts);
}

// Double-click a node: fit it tight to the viewport and centre it (smooth, shared with the
// node-map jump so both frame a node the same way). Returns whether the camera moved.
export function zoomToNode(id) { return panZoomTo(id, { fit: true, onlyIn: true }); }

export function viewportCenterWorld() {
    const u = usableViewport();
    return { x: (u.left + u.w / 2 - view.panX) / view.zoom, y: (u.top + u.h / 2 - view.panY) / view.zoom };
}

let _lastBorderZoom = null;
export function applyView() {
    $("gworld").style.transform = `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom})`;
    // group outline width is zoom-scaled; rewrite it ONLY when zoom actually changed (not on pure
    // pan) so a pan-drag mutates zero group DOM in steady state.
    if (view.zoom !== _lastBorderZoom) { _lastBorderZoom = view.zoom; scaleGroupBorders(view.zoom); }
    nmUpdateViewport();   // keep the node-map's viewport indicator in sync with pan/zoom
}

export function resizeCanvas() {
    let maxX = 0, maxY = 0;
    for (const p of pos.values()) {
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
        maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }
    const w = maxX + 280, h = maxY + 200;
    for (const id of ["gworld", "gnodes"]) { const el = $(id); el.style.width = `${w}px`; el.style.height = `${h}px`; }
    for (const id of ["gedges", "gedges-top"]) { const svg = $(id); svg.setAttribute("width", w); svg.setAttribute("height", h); }
}

export function updateOverlayZoom() {
    for (const [, rec] of overlays) rec.overlay.setWorldZoom(view.zoom);   // every overlay (window + item)
}

// ---- pan + wheel-zoom input -----------------------------------------------

let suppressNextMenu = false;   // set when a right-drag pan actually moved
// The contextmenu handler asks this: did a pan-drag just end (so swallow the menu)? Reading clears it.
export function consumePanSuppress() { const v = suppressNextMenu; suppressNextMenu = false; return v; }

export function startPan(ev) {
    const s = { x: ev.clientX, y: ev.clientY, px: view.panX, py: view.panY };
    let moved = false;
    const mv = (e) => {
        if (!moved && Math.hypot(e.clientX - s.x, e.clientY - s.y) < 4) return;  // ignore micro-jitter
        if (!moved) { moved = true; $("graph").classList.add("panning"); }
        view.panX = s.px + (e.clientX - s.x); view.panY = s.py + (e.clientY - s.y); applyView();
    };
    const up = () => {
        document.removeEventListener("mousemove", mv); document.removeEventListener("mouseup", up);
        $("graph").classList.remove("panning");
        suppressNextMenu = moved;   // only a real drag eats the context menu; a plain click keeps it
        if (moved) persist.local();
    };
    document.addEventListener("mousemove", mv);
    document.addEventListener("mouseup", up);
}

// Is the cursor over an element whose content actually overflows and can scroll? Walk up to
// the canvas; the wheel belongs to that element (native scroll), not to the canvas zoom.
export function scrollableUnder(target) {
    for (let n = target; n && n.id !== "graph" && !n.classList?.contains("graphcanvas"); n = n.parentElement) {
        if (n.classList?.contains("scrollhost")) return true;
        const oy = getComputedStyle(n).overflowY;
        if ((oy === "auto" || oy === "scroll") && n.scrollHeight > n.clientHeight + 1) return true;
    }
    return false;
}

export function onWheel(ev) {
    // Ctrl/Cmd+wheel belongs to the browser (page zoom) — don't hijack it or preventDefault.
    if (ev.ctrlKey || ev.metaKey) return;
    // anything scrollable under the cursor (preview/batches scrollhost, overflowing tables/lists)
    // scrolls its own content; everywhere else the wheel zooms the canvas
    if (scrollableUnder(ev.target)) return;
    ev.preventDefault();
    const rect = $("graph").getBoundingClientRect();
    const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
    const old = view.zoom;
    const z = Math.max(0.15, old * (ev.deltaY < 0 ? 1.1 : 1 / 1.1));   // manual wheel: no font ceiling
    // keep the world point under the cursor fixed
    view.panX = mx - (mx - view.panX) * (z / old);
    view.panY = my - (my - view.panY) * (z / old);
    view.zoom = z;
    applyView(); updateOverlayZoom(); persist.local();
}
