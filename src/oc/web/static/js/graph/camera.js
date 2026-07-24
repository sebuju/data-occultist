// Canvas camera: pan, zoom, fit-to-node, and the world transform. The viewport's pan/zoom lives
// in the shared `view` object (state.js); this module is the only place that animates it and
// writes the #gworld transform. Extracted from main.js — depends on the shared state + a couple
// of sibling modules (floating-panel geometry, the node-map indicator), never on render/model.
import { $, view, pos, nodeEls, overlays } from "./state.js";
import { floatWins } from "./floatwin.js";
import { persist } from "./persist.js";
import { nmUpdateViewport } from "./panels/nodemap.js";
import { redrawNow } from "./edgecanvas.js";
import { renderNavArrows, navArrowsActive } from "./navarrow.js";
import { GRID } from "./dragresize.js";
import { comboOpen } from "./combo_popover.js";

// Minimum on-screen gap between snap-grid dots. When zoom would pack them tighter than this, the
// spacing coarsens to a larger multiple of the world grid (sparse dots when zoomed out).
const DOT_MIN_PX = 22;
// Current on-screen dot spacing (px), recomputed on zoom change; the per-frame pan write reads it.
let _dotCell = GRID;

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
// Manual zoom-OUT floor: near-infinite, just clear of 0 (no div-by-zero in nodemap/pan math).
export const MIN_ZOOM = 0.001;
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
    // Occluders that steal usable space: the floating panels, PLUS two position:fixed chrome bars
    // that overlay #graph but aren't floatWins — the selection toolbar (top, up whenever a node is
    // selected, i.e. during the very double-click that centres it) and the log bar's collapsed
    // strip (bottom 25px). Clip the log bar by its .log-head child, not the whole #logbar: an OPEN
    // log-body grows tall but draws OVER panels (z 1100), so reserve only the collapsed strip —
    // same call floatwin.js's _botGap makes. Off-screen / display:none bars yield a non-overlapping
    // rect and fall out at the overlap guard below (boot logbar, pretty-view where #graph is hidden).
    const occluders = [];
    for (const [, w] of floatWins()) if (!w.el.hidden && !w.state.collapsed) occluders.push(w.el);
    const sel = $("seltoolbar"); if (sel && !sel.hidden) occluders.push(sel);
    const logHead = document.querySelector("#logbar .log-head"); if (logHead) occluders.push(logHead);
    for (const el of occluders) {
        const r = el.getBoundingClientRect();
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
// The ONE camera animation (easeInOutQuad, 380ms): smoothly drive pan+zoom to (tx,ty,tz). Every
// animated move — rect framing, fit-all, node centring — routes through here rather than copying
// the loop (rule 7). Returns false (no-op) when already at the target. Persists on settle.
function animateView(tx, ty, tz) {
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

export function panZoomToRect(box, { fit = true, onlyIn = false } = {}) {
    if (!box || !box.w || !box.h) return false;
    const u = usableViewport();   // centre in the area clear of floating panels
    const tz = fit ? fitZoom(box.w, box.h, { width: u.w, height: u.h }) : view.zoom;
    if (onlyIn && tz < view.zoom - 1e-3) return false;   // already closer than fit → don't zoom out
    const tx = (u.left + u.w / 2) - (box.x + box.w / 2) * tz;
    const ty = (u.top + u.h / 2) - (box.y + box.h / 2) * tz;
    return animateView(tx, ty, tz);
}

// ---- discrete zoom ladder + fit-all ---------------------------------------

// The zoom rungs: wheel ticks and PageUp/PageDown step through THESE discrete levels (not a
// continuous factor) so every zoom lands on a known, repeatable scale.
export const ZOOM_LEVELS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 15];

// The three furthest-out rungs (0.05 / 0.1 / 0.25) are a DRAG-ONLY regime: at that scale a node
// is too small to aim inside, so ANY press on it drags the whole node — never selects an input,
// never reaches a canvas-interior box. Both the node press gate (main.js) and the overlay canvas
// stopPropagation (overlay.js) consult this so they bypass in lockstep. eps admits continuous
// zooms landing a hair above the rung.
export const dragOnlyZoom = () => view.zoom <= ZOOM_LEVELS[2] * 1.001;

// Step one rung along the ladder (dir>0 = in, dir<0 = out), keeping the world point at (cx,cy)
// graph-local px fixed — the cursor for a wheel tick, the viewport centre for a key. Snaps
// instantly (no animation). Steps are NOT queued: within one frame the LATEST request overwrites
// any earlier one and exactly one rung is applied on the next rAF, so a fast flick (or a reversed
// direction mid-frame) never stacks multiple rungs — the most recent intent wins.
let zoomPending = null;   // {dir, cx, cy} of the latest step awaiting the next frame
export function zoomStep(dir, cx = null, cy = null) {
    zoomPending = { dir, cx, cy };
    if (zoomRaf) return;   // a frame is already scheduled; it will read the latest zoomPending
    zoomRaf = requestAnimationFrame(() => {
        zoomRaf = null;
        const p = zoomPending; zoomPending = null;
        if (!p) return;
        const old = view.zoom, eps = old * 1e-3;
        let z;
        if (p.dir > 0) z = ZOOM_LEVELS.find((l) => l > old + eps) ?? ZOOM_LEVELS[ZOOM_LEVELS.length - 1];
        else { const below = ZOOM_LEVELS.filter((l) => l < old - eps); z = below.length ? below[below.length - 1] : ZOOM_LEVELS[0]; }
        if (z === old) return;
        let { cx: px, cy: py } = p;
        if (px == null) { const r = $("graph").getBoundingClientRect(); px = r.width / 2; py = r.height / 2; }
        view.panX = px - (px - view.panX) * (z / old);   // keep the point under (px,py) fixed
        view.panY = py - (py - view.panY) * (z / old);
        view.zoom = z;
        applyView(); updateOverlayZoom();
        persist.local();
    });
}

// Double-Esc: frame EVERY node — centre on the node cloud's bounding box at a zoom that fits it
// all in the clear viewport (clamped to the ladder's range). Animated, unlike the discrete step.
export function fitAllZoom() {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [id, p] of pos) {
        const el = nodeEls.get(id); if (!el) continue;
        x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
        x1 = Math.max(x1, p.x + el.offsetWidth); y1 = Math.max(y1, p.y + el.offsetHeight);
    }
    if (!Number.isFinite(x0)) return false;   // no positioned nodes
    const box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    const u = usableViewport();
    const MARGIN = 0.92;   // a little breathing room around the cloud
    let tz = Math.min((u.w * MARGIN) / box.w, (u.h * MARGIN) / box.h);
    tz = Math.max(0.25, Math.min(ZOOM_LEVELS[ZOOM_LEVELS.length - 1], tz));   // never zoom out past 0.25 on fit-all
    const tx = (u.left + u.w / 2) - (box.x + box.w / 2) * tz;
    const ty = (u.top + u.h / 2) - (box.y + box.h / 2) * tz;
    return animateView(tx, ty, tz);
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

let _lastZoom = null;
export function applyView() {
    // The camera transform is SPLIT (see #gpan/#gworld in graph.css): pan = translate on #gpan
    // (every frame), zoom = scale on #gworld (only when it changes). Neither element is
    // composited — every will-change variant broke rendering (device-scale raster = wrong-looking
    // lines at low zoom, tile shimmer, a 30s renderer freeze zooming out); pan repaints by design.
    // The translate is snapped to whole DEVICE pixels so the repaint lands on the same pixel
    // grid every frame (fractional offsets re-antialias 1px strokes differently each frame).
    // Only the WRITE is rounded; view.panX/panY stay float so pan math never accumulates rounding.
    const dpr = window.devicePixelRatio || 1;
    const tx = Math.round(view.panX * dpr) / dpr, ty = Math.round(view.panY * dpr) / dpr;
    $("gpan").style.transform = `translate(${tx}px, ${ty}px)`;
    // zoom-dependent writes happen ONLY when zoom actually changed — a pure pan must not touch
    // #gworld's style (the sound-forge zoom watcher observes it) or any group DOM.
    if (view.zoom !== _lastZoom) {
        _lastZoom = view.zoom;
        $("gworld").style.transform = `scale(${view.zoom})`;
        // Snap-grid polka dots (fixed-size dot from the CSS radial-gradient; JS only sizes/places
        // the tile). ADAPTIVE SPACING: coarsen the dot spacing to a power-of-two multiple of the
        // 20px world grid so the on-screen gap never drops below DOT_MIN_PX — zoomed out gives a
        // SPARSE grid, zoomed in marks every snap point. A multiple keeps every dot on a real snap
        // coordinate (all anchored at world 0), just skipping intermediate ones when far out.
        let m = 1;
        while (GRID * m * view.zoom < DOT_MIN_PX) m *= 2;
        _dotCell = GRID * m * view.zoom;
        $("graph").style.backgroundSize = `${_dotCell}px ${_dotCell}px`;
        // group outline width is zoom-scaled; the canvas group renderer applies it in drawGroups
        // (via groupBorderCss) on the redrawNow() below, so no DOM border to rewrite here.
    }
    // Dot tile tracks the pan every frame (same device-rounded tx/ty as #gpan so dots land on the
    // node pixel grid). The radial dot is CENTERED in its tile, so shift the origin back by half a
    // cell to land the dot center on the world grid point (tx + k*_dotCell), where snapped node
    // corners draw. Runs after the zoom block so it uses the current _dotCell. CSS wraps mod size.
    const half = _dotCell / 2;
    $("graph").style.backgroundPosition = `${tx - half}px ${ty - half}px`;
    // Canvas renderer (flagged) sits OUTSIDE the transformed world, so it repaints itself against
    // the new pan/zoom on every apply. SYNCHRONOUS so the lines land in the same frame as the #gpan
    // transform above (a deferred rAF paint trails the DOM nodes by a frame while panning fast).
    // A no-op when the canvas isn't mounted.
    redrawNow();
    nmUpdateViewport();   // keep the node-map's viewport indicator in sync with pan/zoom
    if (navArrowsActive()) renderNavArrows();   // keep nav arrows glued to their nodes as the view moves
}

export function resizeCanvas() {
    let maxX = 0, maxY = 0;
    for (const p of pos.values()) {
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
        maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }
    const w = maxX + 280, h = maxY + 200;
    for (const id of ["gworld", "gnodes"]) { const el = $(id); el.style.width = `${w}px`; el.style.height = `${h}px`; }
    // edges + group boxes are drawn on the viewport-fixed canvases (edgecanvas.js), sized to the
    // viewport via their own ResizeObserver — nothing world-sized to grow here.
}

export function updateOverlayZoom() {
    for (const [, rec] of overlays) rec.overlay.setWorldZoom(view.zoom);   // every overlay (window + item)
}

// ---- pan + wheel-zoom input -----------------------------------------------

let suppressNextMenu = false;   // set when a right-drag pan actually moved
// The contextmenu handler asks this: did a pan-drag just end (so swallow the menu)? Reading clears it.
export function consumePanSuppress() { const v = suppressNextMenu; suppressNextMenu = false; return v; }

export function startPan(ev, { forceSuppress = false } = {}) {
    const s = { x: ev.clientX, y: ev.clientY, px: view.panX, py: view.panY };
    s.cx = ev.clientX; s.cy = ev.clientY;   // latest cursor (init to the drag start)
    let moved = false;
    // Coalesce to ONE view write per frame AND pace the applies to a steady divisor of the
    // refresh. A high-polling mouse delivers several mousemoves per frame; more importantly, a
    // GPU that can't hold full refresh on a heavy scene drops frames UNEVENLY (the felt jank),
    // so applying every `stride`th frame yields a CONSTANT frame time instead. Measure the
    // refresh over the first few frames of the drag, then lock stride = round(refreshHz / 72):
    // 144Hz -> every 2nd frame (72Hz), 60Hz -> every frame (untouched), 240Hz -> every 3rd.
    // Events only record the latest cursor; the loop applies it.
    let raf = null, stride = 1, sinceApply = 0;
    let prevTs = 0, gapSum = 0, gaps = 0, lastAx = null, lastAy = null;
    const apply = () => { view.panX = s.px + (s.cx - s.x); view.panY = s.py + (s.cy - s.y); applyView(); };
    const frame = (ts) => {
        if (gaps < 5 && prevTs) {   // measure refresh -> divisor, once, over the first few gaps
            gapSum += ts - prevTs;
            if (++gaps === 5) stride = Math.min(4, Math.max(1, Math.round(1000 / ((gapSum / 5) * 72))));
        }
        prevTs = ts;
        if (++sinceApply >= stride) {   // apply the latest cursor on a stride boundary
            sinceApply = 0;
            if (s.cx !== lastAx || s.cy !== lastAy) { lastAx = s.cx; lastAy = s.cy; apply(); }  // skip redundant rewrite (idle drag = zero DOM)
        }
        raf = requestAnimationFrame(frame);   // continuous while dragging
    };
    const mv = (e) => {
        if (!moved && Math.hypot(e.clientX - s.x, e.clientY - s.y) < 4) return;  // ignore micro-jitter
        if (!moved) { moved = true; $("graph").classList.add("panning"); raf = requestAnimationFrame(frame); }
        s.cx = e.clientX; s.cy = e.clientY;
    };
    const up = () => {
        // stop the loop and flush the exact release position so it lands under the cursor
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        if (moved) apply();
        document.removeEventListener("mousemove", mv); document.removeEventListener("mouseup", up);
        $("graph").classList.remove("panning");
        // a real drag eats the context menu; so does a plain click that just disarmed a draw
        // tool (forceSuppress) — otherwise the native/add-node menu would pop up right after.
        suppressNextMenu = moved || forceSuppress;
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

let zoomRaf = null;   // one paint-side update per frame across a wheel-tick burst (see below)
export function onWheel(ev) {
    // Ctrl/Cmd+wheel belongs to the browser (page zoom) — don't hijack it or preventDefault.
    if (ev.ctrlKey || ev.metaKey) return;
    // a rich/combo dropdown is open — its body-level panel is pinned at its open-time position, so
    // zooming out from under it (moving the anchor node) would strand it. Skip the zoom; the wheel
    // is a no-op over the node here (nothing to scroll).
    if (comboOpen()) return;
    // anything scrollable under the cursor (preview/batches scrollhost, overflowing tables/lists)
    // scrolls its own content; everywhere else the wheel zooms the canvas
    if (scrollableUnder(ev.target)) return;
    ev.preventDefault();
    const rect = $("graph").getBoundingClientRect();
    const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
    // One wheel tick = one rung along the discrete zoom ladder, kept fixed under the cursor.
    // zoomStep coalesces the style work to one paint per frame (zoomRaf), so a burst of ticks
    // costs one update, not one per tick; persist is debounced inside it.
    zoomStep(ev.deltaY < 0 ? 1 : -1, mx, my);
}
