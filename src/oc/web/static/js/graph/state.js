// Shared graph-editor state. ONE home for the cross-cutting maps/sets/objects every
// graph module reads and mutates, plus the two tiny helpers ($/setStatus) and the live
// GraphModel. These are all *non-reassignable* references (const) — importers mutate the
// Map/Set/object in place, so a live binding is shared across modules without a holder.
//
// Reassignable scalars (selectedNodeId, wire, live, routingFrozen, the undo stack, the
// live-loop timer, …) deliberately live in whichever module owns their writes; other
// modules import-and-read them (ES module bindings are live for reads). See main.js.
import { log } from "../log.js";
import { GraphModel } from "./model.js";

export const $ = (id) => document.getElementById(id);
export const setStatus = (m, level) => log(m, level);   // #status is gone — the log bar shows messages now

// Launch-time URL switches (?debug=1&load=1&routedebug=1 …). Parsed ONCE — the query string cannot
// change without a reload. Booleans read "0"/"false" as off and anything else (including a bare
// "?veil" with no value) as on, so a flag can be flipped on by name alone. One implementation, shared
// by the boot ceremony (graph_boot.js) and the routing debug view (routing.js).
const _query = new URLSearchParams(location.search);
export const urlParam = (k) => _query.get(k);
export const urlFlag = (k, dflt) => { const v = _query.get(k); return v === null ? dflt : (v !== "0" && v !== "false"); };

export const model = new GraphModel();

export const pos = new Map();            // node id -> {x,y}
export const nodeEls = new Map();        // node id -> DOM element (built once, reused)
export const collapsed = new Set();      // collapsed node ids
export const view = { panX: 0, panY: 0, zoom: 1 };  // canvas pan/zoom
export const selected = new Set();       // multi-selected node ids (marquee / shift-click)
export const nodeSizes = new Map();      // node id -> {w,h} for resizable nodes (persisted)
export const openImages = new Set();     // winIds whose image is loaded into the window node (persisted)
export const winPage = new Map();        // winId -> which bound-capture page the canvas shows (NOT persisted)
export const imageCanvases = new Map();  // winId -> { wrap, overlay, canvas } (drawing surface)
export const itemCanvases = new Map();   // `winId:itemId` -> { host, canvas, overlay, + coord maps }
export const busy = new Map();           // node id -> active-work count (drives the spinner)

// Boot phase: true while a game is loading (images reopening, first reads). The auto-fired
// detect/preview/item reads on STASHED images consult the server OCR cache while this is set,
// so a warm boot never touches the OCR engine (no cold-start / lock-contention variance). A
// holder object (not a `let`) so every module reads the live value off the shared reference.
export const boot = { phase: false };

// Defer a boot-time-only fetch (node status/preview) until AFTER the OCR warmup thread
// (app.py _warm) has finished hammering the GIL — firing it eagerly during boot just measures
// warmup contention, not the endpoint's own (near-instant) cost. Runs immediately once boot has
// already settled, so callers can use this unconditionally without an if/else. flushBoot() must
// run once boot.phase clears (main.js, both the initial-load and game-switch paths).
const _bootQ = [];
export function afterBoot(fn) {
    if (!boot.phase) { fn(); return; }
    _bootQ.push(fn);
}
export function flushBoot() {
    for (const fn of _bootQ.splice(0)) { try { fn(); } catch { /* best-effort */ } }
}

// Yield two animation frames — long enough for the browser to actually paint before the
// next chunk of synchronous work runs (a single rAF can still land before layout/paint
// settles, same reason main.js's node-size probe double-rafs). Used to spread a burst of
// synchronous per-item work (e.g. boot's per-window canvas builds) across frames instead
// of running it all in one tick, so the tab stays responsive and queued fetch
// continuations get a chance to run between items.
export function nextFrame() {
    return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
}

// Central registry of EVERY drawing overlay, so selection, deselection, and box hotkeys
// are handled in ONE place — any new overlay just registers here and gets cross-deselect
// + WASD for free. rec = { overlay, kind, winId, itemId?, persist(box), refresh() }.
export const overlays = new Map();

// Detected-grid layers (per window) + per-item/preview read caches.
export const gridPreviews = new Map();   // winId -> live-detected field boxes (dashed grid)
export const gridReads = new Map();      // winId -> per-cell read values {x,y,w,h,text,confidence}
export const gridCellBoxes = new Map();  // winId -> detected CELL outlines (solid), the tiling found
export const gridGuards = new Map();     // winId -> located GUARD cells (fieldless detector items, e.g. "no relic"), drawn distinctly
export const gridOccluded = new Map();   // winId -> cells DISMISSED because scrolling clipped them below the item's min coverage {x,y,w,h,reason}
export const gridDetections = new Map(); // winId -> raw OCR lines {box,text,confidence} the engine found (opt-in overlay layer)
export const itemReads = new Map();      // "winId:itemId" -> last cutout read {fields,tells,valid,cell}

// Last /api/preview readout values + their confidence, keyed by readout id. The NON-LIVE
// source for each readout node's `.ro-live` value: when the collector isn't running there's no
// heartbeat value, so the readout shows what the current image reads (written by refreshPreview).
// A holder object (not a `let`) so both writer (imaging) and reader (livewin) share one ref.
// `vals`/`confs` are GATED (empty/low-confidence reads omitted) -- used only for the crosses_*
// trigger "prev" chip. `all`/`allConfs` are the FULL map (empty/low-confidence as "") -- drive
// .ro-live + the register's non-live fallback so a blank slot shows/holds empty, not nothing.
export const readoutPreview = { vals: {}, confs: {}, all: {}, allConfs: {} };

// Live dataset counts (from the heartbeat) + change-detection bookkeeping.
export const prevPresent = {};
export const prevLastTs = {};            // dataset -> last ledger event ts (changes on ANY batch)
export const dsTab = new Map();          // dataset -> "data" | "history" (which tab the merged node shows)

// Invalidate every detected-grid layer for a window at once (kept in lock-step so a stale
// cell outline can't linger after the others clear).
export function clearGrid(winId) { gridPreviews.delete(winId); gridReads.delete(winId); gridCellBoxes.delete(winId); gridGuards.delete(winId); gridOccluded.delete(winId); gridDetections.delete(winId); }

// Node rect geometry from the live DOM (border-box). Foundational helpers shared by
// routing, placement, marquee and the node map — all read straight off `nodeEls`.
//
// SIZE FREEZE (drag perf). A drag rewrites the moving nodes' left/top every frame, and the guide
// pass then measures EVERY node — a read-after-write that forces a full layout, scaling with node
// count, on each move. But a *moved* node's size doesn't change (only its position), and the only
// element whose size really changes mid-drag is the one being *resized*. So snapshot every size
// once when a drag starts and serve `nw`/`nh` from that Map; the dragged/resized ids are left OUT
// of the snapshot and keep reading live, which is correct for resize and cheap for move (a handful
// of nodes, not N). Frozen/thawed in lock-step with the routing drag flag (setDraggingNodes).
let sizeFreeze = null;                       // id -> {w,h}, or null when not dragging
export const sizesFrozen = () => sizeFreeze !== null;
export function freezeNodeSizes(exclude = null) {
    if (sizeFreeze) return;   // MUST be idempotent: the resize loop re-arms the drag flag every
                              // move, and re-measuring N nodes per move would be worse than no cache
    const m = new Map();
    for (const [id, el] of nodeEls) {
        if (exclude?.has(id)) continue;
        m.set(id, { w: el.offsetWidth, h: el.offsetHeight });
    }
    sizeFreeze = m;
}
export function thawNodeSizes() { sizeFreeze = null; }
export const nw = (id) => sizeFreeze?.get(id)?.w ?? (nodeEls.get(id)?.offsetWidth || 220);   // node width (right edge)
export const nh = (id) => sizeFreeze?.get(id)?.h ?? (nodeEls.get(id)?.offsetHeight || 80);   // node height
