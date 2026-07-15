// Canvas overlay: render a capture, draw labelled boxes, and create / move /
// resize them interactively. Box geometry is kept in fractions (0..1) of the
// image so it maps directly to window-fraction coords in the profile.
//
// The canvas internal resolution stays at the image's native pixels; zoom only
// changes the CSS display width. Mouse mapping uses getBoundingClientRect, so
// drawing stays pixel-accurate at any zoom.

import { observeResize } from "./dom.js";
import { boot } from "./graph/state.js";

// Fallback hues for roles that DON'T map to a graph node type (data_area/search/state are
// window-internal boxes, not their own node). Node-backed roles resolve their colour from the
// node type token instead (see roleColor) so a box reads as the node it spawns.
const ROLE_COLOR = {
    state_detect: "#e6c25a",
    state: "#e6c25a",
    search: "#e89a4c",
    data_area: "#e89a4c",
};

// A draw-tool box should read in the colour of the NODE it creates. That colour lives in exactly
// one place — the `--nt-<type>` tokens in base.css (mirrored onto nodes in graph.css) — so resolve
// it from there rather than duplicating hexes here (a hue edit in base.css then propagates to the
// canvas too). Cached per type; the vars are static after load.
const ROLE_NODE_TYPE = {
    region: "region", field: "itemfield", item: "item", bbox: "item",
    detect: "detect", scrollbar: "scrollbar", readout: "readout",
};
const _ntCache = {};
function roleColor(role) {
    const t = ROLE_NODE_TYPE[role];
    if (!t) return ROLE_COLOR[role] || "#fff";
    if (!_ntCache[t]) {
        _ntCache[t] = getComputedStyle(document.documentElement)
            .getPropertyValue(`--nt-${t}`).trim() || "#fff";
    }
    return _ntCache[t];
}

// How a read was validated against authored knowledge -> a coloured pill on the cell, so the
// author sees a value is TRUSTED (confirmed by the dictionary / a snap / glyph pixels), not just
// its OCR confidence %. Keyed by FieldResolver.verified (+ the reader's "glyph" upgrade).
const VERIFY = {
    dict:  { label: "dict",  color: "#7ddc7d" },   // green  — exact vocabulary hit
    split: { label: "split", color: "#e6c25a" },   // amber  — fused words unmerged
    fuzzy: { label: "fuzzy", color: "#5aa9e6" },    // blue   — similarity snap (weakest)
    glyph: { label: "glyph", color: "#c98ae6" },    // purple — pixel glyph_check refined
};

const HANDLE_PX = 5;     // half-size of a resize handle, screen pixels
export const MIN_FRAC = 0.004;  // minimum box size in fractions -- also the floor a typed rect-edit input clamps to (imaging.js)
const LABEL_BASE_PX = 12; // label size on screen at zoom z=1 (scales ∝ z, so it shrinks when zoomed out)
const LABEL_MAX_PX = 16;  // cap so a label never gets giant when zoomed in

// Resize handles: dx/dy in {-1,0,1} mark which edges a handle moves.
const HANDLES = [
    { id: "nw", dx: -1, dy: -1, cur: "nwse-resize" },
    { id: "n", dx: 0, dy: -1, cur: "ns-resize" },
    { id: "ne", dx: 1, dy: -1, cur: "nesw-resize" },
    { id: "e", dx: 1, dy: 0, cur: "ew-resize" },
    { id: "se", dx: 1, dy: 1, cur: "nwse-resize" },
    { id: "s", dx: 0, dy: 1, cur: "ns-resize" },
    { id: "sw", dx: -1, dy: 1, cur: "nesw-resize" },
    { id: "w", dx: -1, dy: 0, cur: "ew-resize" },
];

export class Overlay {
    constructor(canvas, { onCreate, onSelect, onChange, onZoom, onPick, canCreate, minFrac } = {}) {
        this.canvas = canvas;
        // Software (CPU-backed) 2D context, NOT the default GPU-accelerated one. An accelerated
        // canvas becomes its OWN compositor layer ("is accelerated canvas"); with one per window/
        // region/item node, every node overlapping a canvas gets pulled into compositing too
        // (reason "overlap"), and as they slide past each other on pan/zoom the layer set churns —
        // that's the intermittent giant "Update Layer Tree" (Layerize) spike that made panning
        // heavy for no visible reason. willReadFrequently:true keeps it software (no seed layer, no
        // overlap cascade) and is the right hint anyway — the eyedropper (onPick) reads pixels back.
        this.ctx = canvas.getContext("2d", { willReadFrequently: true });
        this.img = null;
        this.boxes = [];
        this.activeId = null;
        // smallest box this overlay allows (fractions). Default suits window/detect boxes; the glyph
        // surface passes a much smaller floor so a single tiny glyph can be boxed tightly.
        this.minFrac = minFrac ?? MIN_FRAC;
        this.onCreate = onCreate;
        this.onSelect = onSelect;
        this.onChange = onChange;   // a box was moved/resized
        this.onZoom = onZoom;
        this.onPick = onPick;       // eyedropper: sampled "#rrggbb"
        // Optional gate: when it returns false, drag-to-draw is disabled (no new box, no
        // crosshair) — e.g. the game gate canvas with no draw tool picked. Default: always on,
        // so existing callers (window/item canvases) keep drawing as before.
        this.canCreate = canCreate;
        this.picking = false;
        this.op = null;             // active interaction
        this._pendingBoxes = null;  // box swap deferred until the current drag/resize ends (async OCR refresh mid-drag)
        this.scale = 1;
        this.gridCells = [];        // faint preview rectangles (fractions)
        this.cellBoxes = [];        // detected CELL outlines (the tiled item cells), drawn solid
        this.guardCells = [];       // located GUARD cells (fieldless detector items) — drawn in a distinct colour
        this.occludedCells = [];    // cells DISMISSED for scroll-occlusion (below the item's min coverage) — drawn red + reason
        this.gridGuides = null;     // search structure: column dividers + locator scan strips
        this.previewItems = [];     // extracted per-cell values: {x,y,w,h,text,confidence}
        this.detections = [];       // raw OCR lines: {box:{x,y,w,h}, text, confidence}
        this.detectStatus = {};     // live detector outcomes by box id: {matched, score?, threshold?}
        // Which draw layers paint (toggled by the checkboxes under the window canvas). raw OCR
        // (every line the engine found, independent of the taught boxes) is opt-in / default off.
        this.vis = { regions: true, detects: true, cells: true, grid: true, reads: true, raw: false };
        this.autoFit = true;        // keep fit-to-width until the user manually zooms
        this.worldZoom = 1;         // outer graph zoom, so UI sizes stay constant on screen
        this._bind();
        // Re-fit when the canvas area resizes (e.g. opened in a modal/iframe whose width arrives
        // after the image loaded). Avoids the image rendering as a sliver. { gate:true } keeps
        // fit()'s width:100% write (a no-op size-wise) from re-triggering. A NEW Overlay is built on
        // every image open, so this MUST be disposed on close (see destroy()) or it leaks unbounded.
        // Skipped during boot: every window's image opening in a burst reflows its siblings,
        // re-triggering this RO for already-fitted overlays (each fit() forces a layout read via
        // clientWidth) — setImage() already fits directly on load, so these are redundant.
        // finishBoot fits every open overlay once after the veil drops (game_lifecycle.js).
        this._roDispose = observeResize(canvas.parentElement, () => { if (this.img && this.autoFit && !boot.phase) this.fit(); }, { gate: true });
    }

    // Tear down the resize observer. Called by closeImage/closeItemImage before dropping the
    // Overlay instance — an Overlay is created per open, so a leaked observer would accumulate.
    destroy() { clearTimeout(this._zoomRenderT); this._roDispose && this._roDispose(); this._roDispose = null; }

    setWorldZoom(z) {
        this.worldZoom = z || 1;
        // Re-rastering the full-res image on every graph-zoom STEP is the zoom hitch: N open overlays
        // × a multi-megapixel clearRect+drawImage per frame (the transform itself is free — devtools
        // scaling #gworld is instant). The canvas lives under #gworld's scale, so it scales visually
        // for free during the zoom; only re-raster to a crisp backing once zoom SETTLES. Debounced so
        // a burst of steps costs ONE render, not one per step. Box/label edits still render inline via
        // the other setters — only the graph-zoom re-raster waits.
        clearTimeout(this._zoomRenderT);
        this._zoomRenderT = setTimeout(() => { this._zoomRenderT = null; this.render(); }, 120);
    }
    setGridPreview(cells) { this.gridCells = cells || []; this.render(); }
    setCellBoxes(cells) { this.cellBoxes = cells || []; this.render(); }
    setGuardCells(cells) { this.guardCells = cells || []; this.render(); }
    setOccludedCells(cells) { this.occludedCells = cells || []; this.render(); }
    setGridGuides(g) { this.gridGuides = g || null; this.render(); }
    setPreview(items) { this.previewItems = items || []; this.render(); }
    setDetections(items) { this.detections = items || []; this.render(); }
    setDetectStatus(map) { this.detectStatus = map || {}; this.render(); }   // colour/tint detect boxes by live match
    setVisible(partial) { Object.assign(this.vis, partial || {}); this.render(); }   // toggle which draw layers paint

    setImage(img) {
        this.img = img;
        if (!img) { this.canvas.width = 0; this.canvas.height = 0; this.render(); return; }   // blank: no image bound
        this.canvas.width = img.naturalWidth;
        this.canvas.height = img.naturalHeight;
        this.fit();
        this.render();
    }

    // A mid-drag refresh (live loop / async OCR) MUST NOT swap the boxes array under an active
    // op — op.box is a live reference into the old array, so replacing it freezes the drag. Stash
    // the new set and apply it when the op ends (see _onUp).
    setBoxes(boxes) {
        if (this.op) { this._pendingBoxes = boxes; return; }
        this.boxes = boxes; this.render();
    }
    setActive(id) { this.activeId = id; this.render(); }

    // ---- zoom (display only) ------------------------------------------------

    _applyScale() {
        if (!this.img) return;
        // autoFit fills the wrap EXACTLY via CSS (width:100%), so no sub-pixel slack ever shows on
        // the right/bottom edge (a rounded px width can't match a fractional wrap width). A MANUAL
        // zoom (teach page) uses an explicit px width so the canvas can grow past its container.
        // Either way `scale` still carries the fit ratio that drives buffer supersampling.
        this.canvas.style.width = this.autoFit ? "100%" : `${Math.round(this.img.naturalWidth * this.scale)}px`;
        this.onZoom?.(this.scale);
    }
    setScale(scale) { this.autoFit = false; this.scale = Math.min(20, Math.max(0.05, scale)); this._applyScale(); }
    zoom(factor) { this.setScale(this.scale * factor); }
    // fit() = measureFit() (read) + applyFit() (write), split so a caller fitting MANY overlays in
    // one pass (finishBoot, game_lifecycle.js) can batch every read before any write — reading N
    // overlays' clientWidth back to back costs ONE forced layout (nothing dirtied it in between),
    // where N interleaved read+write fit() calls would force up to N (classic layout thrash).
    // NO naturalWidth fallback: when the wrap has no width yet (clientWidth 0, e.g. the node isn't
    // laid out at setImage time) falling back to the image's own width scales to ~1:1 — a giant
    // canvas that only corrects when a later reflow (OCR readout filling in) fires the
    // ResizeObserver, so it visibly jumps. Bail (return null) instead; the observer retries fit()
    // the moment the wrap gets real width, sizing it right the FIRST time.
    measureFit() {
        if (!this.img) return null;
        // fill the wrap's FULL content width — no slack. The wrap has overflow:hidden and the
        // canvas is its only flow child, so an exact fit can't trigger a scrollbar; any leftover
        // slack just shows the wrap (dark) on the right/bottom edge.
        const avail = this.canvas.parentElement?.clientWidth || 0;
        return avail > 1 ? avail : null;   // <=1: layout not ready; ResizeObserver will retry
    }
    applyFit(avail) {
        if (avail == null || !this.img) return;
        // set autoFit BEFORE applying, so _applyScale fills via width:100% (not a rounded px) —
        // going through setScale would clear autoFit first and bake in a px width with sub-px slack.
        this.scale = Math.min(20, Math.max(0.05, avail / this.img.naturalWidth));
        this.autoFit = true;        // keep auto-fitting on later resizes; fill the wrap exactly
        this._applyScale();
    }
    fit() { this.applyFit(this.measureFit()); }

    // ---- geometry helpers ---------------------------------------------------

    _frac(ev) {
        const r = this.canvas.getBoundingClientRect();
        return {
            x: (ev.clientX - r.left) / r.width,
            y: (ev.clientY - r.top) / r.height,
            tol: { x: HANDLE_PX / r.width, y: HANDLE_PX / r.height },
        };
    }

    _hitHandle(p, b) {
        if (!b) return null;
        for (const h of HANDLES) {
            // Handle anchor point on the box for this dx/dy.
            const hx = b.x + ((h.dx + 1) / 2) * b.w;
            const hy = b.y + ((h.dy + 1) / 2) * b.h;
            if (Math.abs(p.x - hx) <= p.tol.x && Math.abs(p.y - hy) <= p.tol.y) return h;
        }
        return null;
    }

    _hitBox(p) {
        for (let i = this.boxes.length - 1; i >= 0; i--) {
            const b = this.boxes[i];
            if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) return b;
        }
        return null;
    }

    // A raw-OCR detection rect under the cursor (topmost first). Used only to SNAP a new draw-tool
    // box to a recognised line: with a tool armed and the raw-OCR layer on, clicking a raw rect
    // creates the tool's box at that rect's position/size (see _onDown/_onUp fromDet).
    _hitDetection(p) {
        for (let i = this.detections.length - 1; i >= 0; i--) {
            const b = this.detections[i].box;
            if (b && p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) return this.detections[i];
        }
        return null;
    }

    _clampBox(b) {
        b.w = Math.max(this.minFrac, b.w);
        b.h = Math.max(this.minFrac, b.h);
        b.x = Math.min(Math.max(0, b.x), 1 - b.w);
        b.y = Math.min(Math.max(0, b.y), 1 - b.h);
    }

    // ---- interaction --------------------------------------------------------

    _bind() {
        // stop propagation only for the LEFT (drawing) button, so right-drag still
        // reaches the graph's pan handler over the canvas
        this.canvas.addEventListener("mousedown", (ev) => { if (ev.button === 0) ev.stopPropagation(); this._onDown(ev); });
        this.canvas.addEventListener("mousemove", (ev) => this._onMove(ev));
        window.addEventListener("mouseup", () => this._onUp());
    }

    setPick(on) { this.picking = on; this.canvas.style.cursor = on ? "crosshair" : "crosshair"; }

    _sampleColor(p) {
        const x = Math.round(p.x * this.canvas.width);
        const y = Math.round(p.y * this.canvas.height);
        const [r, g, b] = this.ctx.getImageData(x, y, 1, 1).data;
        const hex = (n) => n.toString(16).padStart(2, "0");
        return `#${hex(r)}${hex(g)}${hex(b)}`;
    }

    _onDown(ev) {
        if (ev.button !== 0) return;   // left button only; right-click never draws
        const p = this._frac(ev);
        if (this.picking) {
            this.picking = false;
            this.onPick?.(this._sampleColor(p));
            return;
        }
        const active = this.boxes.find((b) => b.id === this.activeId);

        // 1) resize the selected box from an edge/corner handle (a locked box has no handles)
        const handle = active && !active.locked ? this._hitHandle(p, active) : null;
        if (handle) {
            this.op = { type: "resize", box: active, handle, orig: { ...active }, moved: false };
            return;
        }
        // 2) clicking a box selects it AND immediately begins a move — drag from anywhere inside,
        //    no prior select needed (a press without a drag just selects; see _onUp's `moved`).
        //    EXCEPT the data_area/bbox backdrop, WHEN a draw tool is armed: you draw items inside
        //    it, so a drag there creates a new box (a plain click still selects it). With no tool
        //    armed (canCreate false) the backdrop is a plain box again — select/move, never draw.
        const canDraw = !(this.canCreate && this.canCreate() === false);
        const hit = this._hitBox(p);
        if (hit && canDraw && (hit.role === "data_area" || hit.role === "bbox")) {
            this.op = { type: "create", x0: p.x, y0: p.y, x1: p.x, y1: p.y, selHit: hit.id };
            return;
        }
        if (hit) {
            if (this.activeId !== hit.id) { this.activeId = hit.id; this.onSelect?.(hit.id); this.render(); }
            // a locked box (e.g. a calibrated scrollbar) selects but never moves
            if (!hit.locked) this.op = { type: "move", box: hit, start: p, orig: { ...hit }, moved: false };
            return;
        }
        // 4) empty space: deselect, then start a new box — unless creation is gated off
        if (this.activeId !== null) { this.activeId = null; this.onSelect?.(null); this.render(); }
        if (!canDraw) return;   // no draw tool -> no new box
        // remember a raw-OCR rect under the press: a click (no drag) on it snaps the new box to
        // that recognised line's geometry (see _onUp); dragging still draws freehand.
        const det = this.vis.raw ? this._hitDetection(p) : null;
        this.op = { type: "create", x0: p.x, y0: p.y, x1: p.x, y1: p.y, fromDet: det ? { ...det.box } : null };
    }

    _onMove(ev) {
        const p = this._frac(ev);
        if (!this.op) {
            this._updateCursor(p);
            return;
        }
        if (this.op.type === "create") {
            this.op.x1 = p.x; this.op.y1 = p.y;
            this.render();
        } else if (this.op.type === "move") {
            const { orig, start, box } = this.op;
            box.x = orig.x + (p.x - start.x);
            box.y = orig.y + (p.y - start.y);
            this._clampBox(box);
            this.op.moved = true;
            this.render();
        } else if (this.op.type === "resize") {
            this._resize(p);
            this.op.moved = true;
            this.render();
        }
    }

    _resize(p) {
        const { box, orig, handle } = this.op;
        if (handle.dx === 1) box.w = p.x - orig.x;
        if (handle.dx === -1) { box.x = p.x; box.w = orig.x + orig.w - p.x; }
        if (handle.dy === 1) box.h = p.y - orig.y;
        if (handle.dy === -1) { box.y = p.y; box.h = orig.y + orig.h - p.y; }
        // Guard against inverted drags past the opposite edge.
        if (box.w < this.minFrac) { box.w = this.minFrac; if (handle.dx === -1) box.x = orig.x + orig.w - this.minFrac; }
        if (box.h < this.minFrac) { box.h = this.minFrac; if (handle.dy === -1) box.y = orig.y + orig.h - this.minFrac; }
        this._clampBox(box);
    }

    _onUp() {
        if (!this.op) return;
        const op = this.op;
        this.op = null;
        if (op.type === "create") {
            const b = {
                x: Math.min(op.x0, op.x1), y: Math.min(op.y0, op.y1),
                w: Math.abs(op.x1 - op.x0), h: Math.abs(op.y1 - op.y0),
            };
            this.render();
            if (b.w > this.minFrac && b.h > this.minFrac) this.onCreate?.(b);   // real drag -> freehand box
            else if (op.fromDet) this.onCreate?.(op.fromDet);   // click on a raw-OCR rect -> snap the tool's box to it
            else if (op.selHit != null) { this.activeId = op.selHit; this.onSelect?.(op.selHit); this.render(); }  // click = select the backdrop
        } else if (op.moved) {
            this.onChange?.(op.box);   // a real move/resize; a click-without-drag only selected
        }
        // Apply any box swap that a live/async refresh deferred during the drag. onChange above
        // usually rebuilds boxes itself (fresh model coords); this catches the no-onChange paths
        // (plain select, create abort) so a deferred refresh isn't lost.
        if (this._pendingBoxes) { this.boxes = this._pendingBoxes; this._pendingBoxes = null; this.render(); }
    }

    _updateCursor(p) {
        const active = this.boxes.find((b) => b.id === this.activeId);
        const h = active && !active.locked ? this._hitHandle(p, active) : null;
        if (h) { this.canvas.style.cursor = h.cur; return; }
        // over a draggable box -> move. The data_area/bbox backdrop is a DRAW surface only while a
        // tool is armed (crosshair); with no tool it's a plain movable box (move), never crosshair.
        const canDraw = !(this.canCreate && this.canCreate() === false);
        const hit = this._hitBox(p);
        if (hit && hit.locked) { this.canvas.style.cursor = "not-allowed"; return; }
        if (hit && (hit.role === "data_area" || hit.role === "bbox")) { this.canvas.style.cursor = canDraw ? "crosshair" : "move"; return; }
        if (hit) { this.canvas.style.cursor = "move"; return; }
        // empty space: crosshair only when a draw tool is armed, else the normal cursor
        this.canvas.style.cursor = canDraw ? "crosshair" : "default";
    }

    // ---- render -------------------------------------------------------------

    render() {
        const { ctx, img } = this;
        // Supersample the backing to the on-screen DEVICE resolution (fit scale × graph
        // zoom × dpr), so the canvas is drawn 1:1 with what's shown instead of a small
        // native-res bitmap that the browser upscales (= blur when zoomed in). Bounded so
        // a 4K image zoomed in doesn't allocate a giant canvas.
        const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
        const z = Math.max(this.scale, 1e-4) * Math.max(this.worldZoom, 1e-4);
        let ss = z * dpr;
        if (img) ss = Math.min(ss, 8, 4096 / Math.max(img.naturalWidth, img.naturalHeight));
        ss = Math.max(0.5, ss);
        if (img) {
            const tw = Math.round(img.naturalWidth * ss), th = Math.round(img.naturalHeight * ss);
            if (this.canvas.width !== tw || this.canvas.height !== th) { this.canvas.width = tw; this.canvas.height = th; }
        }
        const W = this.canvas.width, H = this.canvas.height;
        // backing px per ON-SCREEN css px — multiply screen sizes by this so every line,
        // label and handle is a CONSTANT on-screen size (and crisp, since backing is at
        // device resolution). Equals dpr when the supersample isn't clamped.
        const u = ss / z;
        // ONE uniform size for every label (not per-box). On-screen size = LABEL_BASE_PX at
        // the default graph zoom (worldZoom 1), scaling with the GRAPH zoom only — NOT the
        // per-image fit-scale — so it's readable by default, shrinks freely as you zoom the
        // graph out (no floor → labels go tiny instead of piling into a mess), and is capped
        // (LABEL_MAX_PX) so it never gets huge zoomed in. ·u converts screen px to backing
        // px; backing is supersampled so it stays crisp.
        const labelFs = Math.min(LABEL_MAX_PX, LABEL_BASE_PX * this.worldZoom) * u;
        ctx.clearRect(0, 0, W, H);
        if (img) ctx.drawImage(img, 0, 0, W, H);

        // Detected cell structure: solid outline of each tiled item cell, so the grid the
        // reader actually found is visible (drawn under the dashed per-field boxes).
        if (this.vis.cells && this.cellBoxes.length) {
            ctx.strokeStyle = "rgba(125,220,125,0.95)";
            ctx.lineWidth = 2.5 * u;
            for (const c of this.cellBoxes) ctx.strokeRect(c.x * W, c.y * H, c.w * W, c.h * H);
        }

        // Guard cells: a fieldless detector item (e.g. "no relic selected") that exists only to
        // WIN its tile and suppress a competitor. Distinct orange so it's never mistaken for a
        // data cell; a guard that LOST overlap (didn't win) is drawn dashed + faint so it's clear
        // it isn't acting. Filled lightly since it stores nothing and would otherwise read empty.
        if (this.vis.cells && this.guardCells.length) {
            ctx.lineWidth = 2.5 * u;
            for (const c of this.guardCells) {
                const won = c.valid !== false;
                ctx.strokeStyle = won ? "rgba(240,140,40,0.95)" : "rgba(240,140,40,0.5)";
                ctx.setLineDash(won ? [] : [5 * u, 4 * u]);
                if (won) { ctx.fillStyle = "rgba(240,140,40,0.12)"; ctx.fillRect(c.x * W, c.y * H, c.w * W, c.h * H); }
                ctx.strokeRect(c.x * W, c.y * H, c.w * W, c.h * H);
            }
            ctx.setLineDash([]);
        }

        // Occlusion-dismissed cells: a row the scroll clipped below the item's min coverage, so
        // it was NOT stored. Red dashed box + a light wash + the reason centred, so it's obvious
        // which rows the occlusion guard threw out and why.
        if (this.vis.cells && this.occludedCells.length) {
            ctx.lineWidth = 2.5 * u;
            ctx.setLineDash([6 * u, 4 * u]);
            for (const c of this.occludedCells) {
                ctx.strokeStyle = "rgba(230,104,90,0.95)";
                ctx.fillStyle = "rgba(230,104,90,0.14)";
                ctx.fillRect(c.x * W, c.y * H, c.w * W, c.h * H);
                ctx.strokeRect(c.x * W, c.y * H, c.w * W, c.h * H);
            }
            ctx.setLineDash([]);
            if (this.vis.reads) for (const c of this.occludedCells) {
                if (c.occ) this._centerLabel(`occluded: ${c.occ}`, (c.x + c.w / 2) * W, (c.y + c.h / 2) * H, labelFs, "#e6685a");
            }
        }

        // Grid preview: where each field will be read across the tiled grid.
        if (this.vis.grid && this.gridCells.length) {
            ctx.strokeStyle = "rgba(90,169,230,0.9)";
            ctx.lineWidth = 1.5 * u;
            ctx.setLineDash([5 * u, 3 * u]);
            for (const c of this.gridCells) ctx.strokeRect(c.x * W, c.y * H, c.w * W, c.h * H);
            ctx.setLineDash([]);
        }

        // Preview read-outs: what OCR pulled from each cell, tinted by confidence. A
        // substituted value (an "if empty"/"if number"/"if text" fallback fired) is
        // config, not a read — neutral tint and the rule's name instead of a %.
        if (this.vis.reads) for (const p of this.previewItems) {
            if (p.cell) {
                // a cell-level tag (the matched item template's id): centred on the cell,
                // white on black — no confidence fill, it isn't a read
                this._centerLabel(String(p.text ?? ""), (p.cell.x + p.cell.w / 2) * W, (p.cell.y + p.cell.h / 2) * H, labelFs);
                continue;
            }
            const conf = p.confidence ?? 0;
            const tint = p.substituted ? "138,146,163"
                : conf >= 0.8 ? "125,220,125" : conf >= 0.5 ? "230,194,90" : "230,104,90";
            const x = p.x * W, y = p.y * H, w = p.w * W, h = p.h * H;
            ctx.fillStyle = `rgba(${tint},0.18)`;
            ctx.fillRect(x, y, w, h);
            const txt = p.text === null || p.text === "" || p.text === undefined ? "∅" : String(p.text);
            const tag = p.substituted
                ? `if ${String(p.substituted).replace(/^if_/, "").replace(/_/g, " ")}`
                : `${Math.round(conf * 100)}%`;
            // when the final value differs from the genuine OCR read (dict/fuzzy/glyph correction
            // or a fallback), show the ORIGINAL too so the author sees what was changed
            const raw = p.raw == null ? "" : String(p.raw);
            const shown = raw && raw !== txt && txt !== "∅" ? `${raw} → ${txt}` : txt;
            this._label(`${shown}  ${tag}`, x, y + h, `rgb(${tint})`, labelFs);
            // validated read -> a coloured pill at the cell's top-left naming the mechanism that
            // confirmed it (dictionary / unmerge / fuzzy / glyph), independent of the conf tint
            const v = p.verified && VERIFY[p.verified];
            if (v) this._pill(v.label, x, y, v.color, labelFs);
        }

        // Raw OCR detections: exactly what OCR found and where (independent of boxes).
        if (this.vis.raw) for (const d of this.detections) {
            const x = d.box.x * W, y = d.box.y * H, dw = d.box.w * W, dh = d.box.h * H;
            ctx.strokeStyle = "rgba(201,138,230,0.9)";
            ctx.lineWidth = 1 * u;
            ctx.setLineDash([3 * u, 2 * u]);
            ctx.strokeRect(x, y, dw, dh);
            ctx.setLineDash([]);
            // text above the box; geometry (window fractions as %) below it
            const b = d.box, p = (v) => (v * 100).toFixed(1);
            this._label(d.text, x, y, "#c98ae6", labelFs);
            this._label(`x${p(b.x)} y${p(b.y)} w${p(b.w)} h${p(b.h)}`, x, y + dh, "#c98ae6", labelFs);
        }

        for (const b of this.boxes) {
            if (b.role === "detect" ? !this.vis.detects : !this.vis.regions) continue;
            // a detect box carries its LIVE outcome: green/✓ when matched, red/✗ when not (a
            // faint fill so the verdict reads at a glance, with score% on the label)
            const st = b.role === "detect" ? this.detectStatus[b.id] : null;
            const color = st ? (st.matched ? "#7ddc7d" : "#e6685a") : roleColor(b.role);
            const isActive = b.id === this.activeId;
            ctx.lineWidth = (isActive ? 2.4 : 1.6) * u;
            ctx.strokeStyle = color;
            if (st) {
                ctx.fillStyle = st.matched ? "rgba(125,220,125,0.14)" : "rgba(230,104,90,0.14)";
                ctx.fillRect(b.x * W, b.y * H, b.w * W, b.h * H);
            }
            ctx.strokeRect(b.x * W, b.y * H, b.w * W, b.h * H);
            if (b.border) this._borderBand(b, W, H);   // a 'border' tell: tint the sampled perimeter band
            if (b.searchMargin) this._searchRegion(b, W, H, u, color);   // a 'template' tell: dashed slide region
            let label = b.label || b.id || b.role;
            if (b.locked) label += " 🔒";   // position pinned (e.g. scrollbar with calibration cutouts)
            if (st) label += `  ${st.matched ? "✓" : "✗"}${st.score != null ? ` ${Math.round(st.score * 100)}%` : ""}`;
            if (b.role !== "bbox") this._label(label, b.x * W, b.y * H, color, labelFs);   // the item cell needs no label
            this._alignArrow(b, W, H, u, color);   // anchor snap point (align x/y) drawn, not written
            if (isActive && !this.op && !b.locked) this._drawHandles(b, W, H, u);   // hide handles while dragging; a locked box has none
        }

        // Search structure (drawn LAST, on top of everything): the columns the reader tiles the
        // data area into + the locator scan strip in each — so the grid clues stay visible over
        // the cells/reads/boxes instead of hiding beneath them.
        const g = this.vis.grid ? this.gridGuides : null;
        if (g) {
            // locator markers: a short amber bar straddling the data-area TOP border, marking
            // the horizontal slice of each column where rows are anchored. A border tick — NOT
            // a full-height fill (that washed over the content and read as a selection).
            const yb = (g.yTop ?? 0) * H, bar = 5 * u;
            ctx.fillStyle = "rgba(230,194,90,0.95)";
            for (const s of g.strips || []) ctx.fillRect(s.x * W, yb - bar / 2, s.w * W, bar);
            ctx.strokeStyle = "rgba(230,194,90,0.9)";          // grid dividers
            ctx.lineWidth = 1.5 * u;
            ctx.setLineDash([3 * u, 4 * u]);
            // overshoot the data-area edges by a few px so a divider stays visible even when a
            // cell/box/read sits flush on the boundary and would otherwise occlude its end.
            const pad = 8 * u;
            const yT = g.yTop * H - pad, yB = g.yBot * H + pad;
            for (const x of g.cols || []) { ctx.beginPath(); ctx.moveTo(x * W, yT); ctx.lineTo(x * W, yB); ctx.stroke(); }
            const xL = (g.xLeft ?? 0) * W - pad, xR = (g.xRight ?? 1) * W + pad;   // row dividers (static grid)
            for (const y of g.rows || []) { ctx.beginPath(); ctx.moveTo(xL, y * H); ctx.lineTo(xR, y * H); ctx.stroke(); }
            ctx.setLineDash([]);
        }

        if (this.op?.type === "create") {
            const x = Math.min(this.op.x0, this.op.x1), y = Math.min(this.op.y0, this.op.y1);
            ctx.setLineDash([5 * u, 4 * u]);
            ctx.strokeStyle = "#fff"; ctx.lineWidth = 1 * u;
            ctx.strokeRect(x * W, y * H, Math.abs(this.op.x1 - this.op.x0) * W, Math.abs(this.op.y1 - this.op.y0) * H);
            ctx.setLineDash([]);
        }
    }

    // Draw the box's anchor snap point (where the located cell pins to the OCR line) as an
    // arrow instead of writing "·bottom" in the label: a shaft from the box centre to the
    // edge/corner picked by alignX (left/center/right) × align (top/center/bottom), with a
    // head at that point. A centre×centre anchor has no direction, so it's a dot. Boxes that
    // carry no align (the cell bbox, plain fields) draw nothing.
    _alignArrow(b, W, H, u, color) {
        if (!b.align && !b.alignX) return;
        const fx = b.alignX === "left" ? 0 : b.alignX === "right" ? 1 : 0.5;
        const fy = b.align === "top" ? 0 : b.align === "bottom" ? 1 : 0.5;
        const ctx = this.ctx;
        const cx = (b.x + b.w / 2) * W, cy = (b.y + b.h / 2) * H;
        const tx = (b.x + fx * b.w) * W, ty = (b.y + fy * b.h) * H;
        ctx.save();
        ctx.fillStyle = color; ctx.strokeStyle = color; ctx.lineWidth = 1.6 * u; ctx.setLineDash([]);
        if (fx === 0.5 && fy === 0.5) {            // anchor = box centre: a dot, no direction
            ctx.beginPath(); ctx.arc(cx, cy, 3 * u, 0, Math.PI * 2); ctx.fill();
            ctx.restore(); return;
        }
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(tx, ty); ctx.stroke();   // shaft
        const ang = Math.atan2(ty - cy, tx - cx), hl = 7 * u, ha = 0.5;          // arrowhead at the snap point
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(tx - hl * Math.cos(ang - ha), ty - hl * Math.sin(ang - ha));
        ctx.lineTo(tx - hl * Math.cos(ang + ha), ty - hl * Math.sin(ang + ha));
        ctx.closePath(); ctx.fill();
        ctx.restore();
    }

    // ``fs`` is the font size in backing px (content-scaled, capped — see lfs). Drawn at
    // device resolution so it stays crisp at any zoom.
    _label(text, x, y, color, fs) {
        const ctx = this.ctx;
        const pad = fs * 0.28;
        ctx.font = `${fs}px system-ui`;
        const h = fs + pad * 2;
        const w = ctx.measureText(text).width + pad * 2;
        // keep the plate fully on-canvas vertically — a label anchored at a top-row box's top
        // would otherwise sit above y=0 and be clipped (overflow:hidden) and never seen. The
        // plate spans [y-h, y]; clamp its bottom so the whole plate stays within [0, height].
        y = Math.max(h, Math.min(y, this.canvas.height));
        ctx.fillStyle = "rgba(0,0,0,0.65)";
        ctx.fillRect(x, y - h, w, h);      // readable plate behind the text
        ctx.fillStyle = color;
        ctx.textBaseline = "bottom";
        ctx.fillText(text, x + pad, y - pad);
    }

    // A validation badge: a small SOLID-coloured pill with dark text, anchored TOP-left of a
    // read cell (opposite corner to the bottom conf label, so the two never collide). The fill
    // colour IS the signal (green/amber/blue/purple by mechanism); the label just names it.
    _pill(text, x, y, bg, fs) {
        const ctx = this.ctx;
        const s = fs * 0.82;                 // slightly smaller than the conf label
        const pad = s * 0.3;
        ctx.font = `${s}px system-ui`;
        const hh = s + pad * 2;
        const w = ctx.measureText(text).width + pad * 2;
        y = Math.max(0, Math.min(y, this.canvas.height - hh));   // keep the plate on-canvas
        ctx.fillStyle = bg;
        ctx.fillRect(x, y, w, hh);
        ctx.fillStyle = "rgba(0,0,0,0.85)";
        ctx.textBaseline = "top";
        ctx.fillText(text, x + pad, y + pad);
        ctx.textBaseline = "bottom";         // restore default for the other label paths
    }

    // Centred variant of _label: solid black plate, white text, anchored on (cx, cy) —
    // used for cell-level read-outs (the item's name on its tile).
    _centerLabel(text, cx, cy, fs, color = "#fff") {
        const ctx = this.ctx;
        const pad = fs * 0.28;
        ctx.font = `${fs}px system-ui`;
        const m = ctx.measureText(text);
        const h = fs + pad * 2;
        const w = m.width + pad * 2;
        cy = Math.max(h / 2, Math.min(cy, this.canvas.height - h / 2));   // keep the plate on-canvas vertically
        ctx.fillStyle = "rgba(0,0,0,0.9)";
        ctx.fillRect(cx - w / 2, cy - h / 2, w, h);
        ctx.fillStyle = color;
        ctx.textAlign = "center";
        ctx.textBaseline = "alphabetic";
        // optically centre the actual glyph box (baseline maths, not the em box, which
        // sits visibly low for short caps/digit strings like an item id)
        ctx.fillText(text, cx, cy + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2);
        ctx.textAlign = "left";            // restore defaults for the other label paths
        ctx.textBaseline = "bottom";
    }

    // A 'border' tell samples only the box's PERIMETER band (thickness = width × shorter side),
    // not its fill. Show exactly that: a faint full-box wash + a stronger fill on the ring that's
    // actually checked, both in the taught colour — so the user sees where the colour must ride.
    _borderBand(b, W, H) {
        const ctx = this.ctx;
        const x = b.x * W, y = b.y * H, bw = b.w * W, bh = b.h * H;
        const t = Math.max(1, (b.border.width || 0) * Math.min(bw, bh));   // band px (mirrors border_score)
        const [r, g, bl] = this._hexRgb(b.border.color);
        ctx.save();
        ctx.fillStyle = `rgba(${r},${g},${bl},0.14)`;         // faint wash over the ignored fill
        ctx.fillRect(x, y, bw, bh);
        ctx.fillStyle = `rgba(${r},${g},${bl},0.45)`;         // the sampled ring, drawn as 4 bands
        if (t * 2 >= Math.min(bw, bh)) { ctx.fillRect(x, y, bw, bh); }   // band swallows the box -> whole fill
        else {
            ctx.fillRect(x, y, bw, t);                 // top
            ctx.fillRect(x, y + bh - t, bw, t);        // bottom
            ctx.fillRect(x, y + t, t, bh - 2 * t);     // left
            ctx.fillRect(x + bw - t, y + t, t, bh - 2 * t);   // right
        }
        ctx.restore();
    }

    // A 'template' tell grows its crop by `searchMargin` (fraction of the box, per side) so the
    // saved sub-image can SLIDE to absorb a few px of cell-location drift. Show that slide region
    // as a faint dashed rect around the solid tell box — clamped to the image like the reader does.
    _searchRegion(b, W, H, u, color) {
        const m = b.searchMargin;
        const x0 = Math.max(0, b.x - b.w * m), y0 = Math.max(0, b.y - b.h * m);
        const x1 = Math.min(1, b.x + b.w * (1 + m)), y1 = Math.min(1, b.y + b.h * (1 + m));
        const ctx = this.ctx;
        ctx.save();
        ctx.strokeStyle = color; ctx.globalAlpha = 0.55; ctx.lineWidth = 1 * u;
        ctx.setLineDash([4 * u, 3 * u]);
        ctx.strokeRect(x0 * W, y0 * H, (x1 - x0) * W, (y1 - y0) * H);
        ctx.restore();
    }

    _hexRgb(hex) {
        const h = String(hex || "#ffcc00").replace("#", "");
        const s = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
        return [parseInt(s.slice(0, 2), 16) || 0, parseInt(s.slice(2, 4), 16) || 0, parseInt(s.slice(4, 6), 16) || 0];
    }

    _drawHandles(b, W, H, u) {
        const ctx = this.ctx;
        const bw = b.w * W, bh = b.h * H;
        // cap handle size to the box so small boxes aren't swamped by white squares
        const s = Math.max(1.5 * u, Math.min(HANDLE_PX * u, bw * 0.22, bh * 0.22));
        ctx.strokeStyle = "rgba(34,34,34,0.7)";
        ctx.lineWidth = 1 * u;
        ctx.fillStyle = "rgba(255,255,255,0.7)";
        for (const h of HANDLES) {
            const hx = (b.x + ((h.dx + 1) / 2) * b.w) * W;
            const hy = (b.y + ((h.dy + 1) / 2) * b.h) * H;
            ctx.fillRect(hx - s, hy - s, s * 2, s * 2);
            ctx.strokeRect(hx - s, hy - s, s * 2, s * 2);
        }
        // centre move indicator (the box drags from anywhere inside; this just marks it movable)
        const cx = (b.x + b.w / 2) * W, cy = (b.y + b.h / 2) * H;
        const r = Math.max(3 * u, Math.min(HANDLE_PX * 1.5 * u, bw * 0.32, bh * 0.32));
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255,255,255,0.9)";
        ctx.fill();
        ctx.stroke();
        ctx.lineWidth = 1.5 * u;
        ctx.beginPath();
        ctx.moveTo(cx - r * 0.55, cy); ctx.lineTo(cx + r * 0.55, cy);
        ctx.moveTo(cx, cy - r * 0.55); ctx.lineTo(cx, cy + r * 0.55);
        ctx.stroke();
    }
}
