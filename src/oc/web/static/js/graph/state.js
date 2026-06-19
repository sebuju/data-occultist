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
export const setStatus = (m) => log(m);   // #status is gone — the log bar shows messages now

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

// Central registry of EVERY drawing overlay, so selection, deselection, and box hotkeys
// are handled in ONE place — any new overlay just registers here and gets cross-deselect
// + WASD for free. rec = { overlay, kind, winId, itemId?, persist(box), refresh() }.
export const overlays = new Map();

// Detected-grid layers (per window) + per-item/preview read caches.
export const gridPreviews = new Map();   // winId -> live-detected field boxes (dashed grid)
export const gridReads = new Map();      // winId -> per-cell read values {x,y,w,h,text,confidence}
export const gridCellBoxes = new Map();  // winId -> detected CELL outlines (solid), the tiling found
export const gridGuards = new Map();     // winId -> located GUARD cells (fieldless detector items, e.g. "no relic"), drawn distinctly
export const gridDetections = new Map(); // winId -> raw OCR lines {box,text,confidence} the engine found (opt-in overlay layer)
export const itemReads = new Map();      // "winId:itemId" -> last cutout read {fields,tells,valid,cell}

// Live dataset counts (from the heartbeat) + change-detection bookkeeping.
export const prevPresent = {};
export const prevLastTs = {};            // dataset -> last ledger event ts (changes on ANY batch)
export const dsTab = new Map();          // dataset -> "data" | "history" (which tab the merged node shows)

// Invalidate every detected-grid layer for a window at once (kept in lock-step so a stale
// cell outline can't linger after the others clear).
export function clearGrid(winId) { gridPreviews.delete(winId); gridReads.delete(winId); gridCellBoxes.delete(winId); gridGuards.delete(winId); gridDetections.delete(winId); }

// Node rect geometry from the live DOM (border-box). Foundational helpers shared by
// routing, placement, marquee and the node map — all read straight off `nodeEls`.
export const nw = (id) => nodeEls.get(id)?.offsetWidth || 220;   // node width (right edge)
export const nh = (id) => nodeEls.get(id)?.offsetHeight || 80;   // node height
