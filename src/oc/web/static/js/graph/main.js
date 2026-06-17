// Node-view home: edit a game's structure as a graph (Game → Windows → Fields →
// Datasets), drag to arrange, drag-wire a window to a dataset, edit inline, and
// watch live dataset counts. Box drawing stays on the canvas (ui.html link).
import * as api from "../api.js";
import * as conn from "../conn.js";
import * as hub from "../hub.js";
import { esc, TRASH, CAMERA, PAUSE, labCell } from "../dom.js";
import { nodeIcon, iconFor } from "./node_icons.js";
import { openModal } from "../modal.js";
import { Overlay } from "../overlay.js";
import { log, timed, setLogOpen, mirrorConsole } from "../log.js";

mirrorConsole();   // surface uncaught errors + console.error/warn in the log bar (no devtools needed)
import { GraphModel } from "./model.js";
import { routeGraph, polylinePath } from "./route.js";
import { buildKey, DEFAULT_KEY } from "../keys.js";
import { priceParts, wirePriceNode } from "./price_node.js";
import { GRID, snap, showSizeHud, hideSizeHud, addResizeGrips, beginDrag } from "./dragresize.js";
import { createFloatWin, floatWins } from "./floatwin.js";
import { triggerParts } from "./trigger_node.js";
import { openDictionaryPicker } from "./dict_picker.js";
import { enhanceTable, setTableStore } from "./table.js";
import { VTable, setVTableStore } from "../vtable.js";
import { initPersist, persist, setScrubHook } from "./persist.js";
import * as prettyOverrides from "../pretty/overrides.js";
import { buildBackups } from "./backups.js";
import * as groups from "./groups.js";
import { initTitlebar } from "../titlebar.js";
import { openLogStream } from "../logstream.js";

initTitlebar();   // custom window chrome — no-op outside the desktop window

import {
  $, setStatus, model, pos, nodeEls, collapsed, view, selected, nodeSizes, openImages, winPage,
  imageCanvases, itemCanvases, busy, overlays, gridPreviews, gridReads, gridCellBoxes,
  itemReads, prevPresent, prevLastTs, dsTab, clearGrid, nw, nh,
} from "./state.js";
import {
  drawEdges, requestEdges, flushEdges, buildLinks, nodeRect, freezeRouting,
  setDraggingNodes, routeCache, ROUTE,
} from "./routing.js";
import { initFlow } from "./flow.js";
import {
  nmState, nlState, buildNodeMap, buildNodeList, setNodeMapVisible, setNodeListVisible,
  nmSyncSelection, renderNodeViews, nmUpdateViewport,
} from "./panels/nodemap.js";
import { act, actState, buildActivity } from "./panels/activity.js";
import { testWin, testState, buildTesting } from "./panels/testing.js";
import {
  tb, tbState, buildToolbox,
  createWindowNode, createPriceNode, createTriggerNode, createDictionaryNode,
} from "./panels/toolbox.js";
import { openContextMenu } from "../ctxmenu.js";
import {
  vtables, vtableFor, refreshDataNode, refreshDatasetNode, refreshAllDataNodes, expandSubsetRow,
  batchesState, loadBatchesNode, refreshAllBatchesNodes,
} from "./panels/datanodes.js";
import {
  pc, pcState, precapOpen, precapBusy, buildPrecap, fmtBytes,
} from "./panels/precap.js";
import { pushHistory, resetHistory, undo, redo } from "./history.js";
import { workers, registerWorker, unregisterWorker } from "./workers.js";
import {
  KINDS, ITEM_KINDS, updateImageLabel, closeImage, openImage, createItemFromGeom,
  closeItemImage, setItemCellKeepingChildren, openItemImage, refreshItemBoxes,
  itemReadTimers, itemReadBusy, itemReadAgain, scheduleItemRead, runItemRead, itemReadout,
  prevHost, previewProfileFor, previewBusy, previewAgain, setReadBusy, refreshPreview,
  commitPreviewNode, tellChip, subLabel, previewCell, previewTable, prefillDetectText,
  detectBusy, detectAgain, refreshDetect, setDetectStatus, detectT, _detectPending,
  _detectAll, refreshOpenDetect, previewT, _previewPending, _previewAll, refreshOpenPreviews,
  loadImage, refreshImageBoxes, itemLocatorBox, staticGridOrigins, buildGridGuides,
  staticFieldPreview, refreshGridPreview, cellKept, setGridFromPreview, selectRegionNode,
} from "./imaging.js";
import {
  liveWin, liveWinState, buildLiveWindow, renderLiveWindow, setLiveMode, setLiveSave,
} from "./panels/livewin.js";

const COLX = { game: 20, window: 300, trigger: 560, price: 700, preview: 1580, region: 600, detect: 600, state: 600, scrollbar: 600, item: 600, itemfield: 850, itemtell: 1080, dataset: 900, subset: 1900, dictionary: 20 };
export let live = {};             // dataset -> {present,total,last_op,last_ts} (read by datanodes/refreshLive)
export let wire = null;           // active drag-wire {winId, x1,y1} (read by routing.drawEdges)
export let selectedNodeId = null; // node whose line(s) are highlighted (read by routing.selClsFor)

// Central registry of EVERY drawing overlay lives in state.js; selection, deselection, and
// box hotkeys are handled in ONE place here — any new overlay registers and gets
// cross-deselect + WASD for free. rec = { overlay, kind, winId, itemId?, persist(box), refresh() }.
let activeOverlayKey = null;        // which overlay holds the live box selection

function registerOverlay(key, rec) { overlays.set(key, { key, ...rec }); }
function unregisterOverlay(key) { overlays.delete(key); if (activeOverlayKey === key) activeOverlayKey = null; }

// THE selection chokepoint: an overlay reports it selected `id` (or null). Deselect
// every other overlay so only one box is ever active across the whole editor.
function overlaySelected(key, id) {
  activeOverlayKey = id ? key : (activeOverlayKey === key ? null : activeOverlayKey);
  for (const [k, rec] of overlays) if (k !== key) rec.overlay.setActive(null);
  const rec = overlays.get(key);
  if (rec && rec.kind === "window" && id) selectRegionNode(rec.winId, id);   // highlight its node
  else { selectedNodeId = null; for (const [, el] of nodeEls) el.classList.remove("selected"); drawEdges(); }
}

// Select a window box from its NODE (routes through the chokepoint so other
// overlays deselect and WASD targets it).
function selectWindowBox(winId, boxId) {
  const e = imageCanvases.get(winId);
  if (e) e.overlay.setActive(boxId);
  overlaySelected(`win:${winId}`, boxId);
}
let pendingOpenImages = [];

// Show/hide a node's spinner via a ref count, so overlapping async tasks behave.
function setNodeBusy(nodeId, on) {
  const n = (busy.get(nodeId) || 0) + (on ? 1 : -1);
  if (n <= 0) busy.delete(nodeId); else busy.set(nodeId, n);
  nodeEls.get(nodeId)?.classList.toggle("busy", (busy.get(nodeId) || 0) > 0);
  if (on) freezeRouting();   // OCR shouldn't make the node lines re-route — freeze them
}

// Run an async task while showing spinners on the given node ids.
async function withBusy(ids, fn) {
  ids.forEach((id) => setNodeBusy(id, true));
  try { return await fn(); }
  finally { ids.forEach((id) => setNodeBusy(id, false)); }
}

// `.flab` rows are <label>s for layout/a11y only — a click on the label chrome
// (text/gaps) must NOT activate the control (toggle a checkbox, focus an input).
// Cancel the label's default activation unless the click landed on the control.
document.addEventListener("click", (e) => {
  const lab = e.target.closest("label.flab");
  if (lab && !e.target.closest("input, select, textarea, button")) e.preventDefault();
}, true);

// Kill a worker from the log bar (don't let the click toggle the log open).
$("logWorkers").addEventListener("click", (ev) => {
  ev.stopPropagation();
  const b = ev.target.closest("button[data-kill]");
  if (!b) return;
  const w = workers.get(b.dataset.kill);
  if (!w) return;
  setStatus(`killing ${w.label}…`);
  try { w.kill(); } catch (e) { setStatus(String(e.message || e)); }
  unregisterWorker(b.dataset.kill);
});

// ---- autosave + layout persistence (all IO goes through persist.js) --------

function autosave(refresh = true, winId = null) {
  if (!model.profile.name) return;
  persist.content();         // debounced profile save; onContentSaved fires on success
  if (refresh) {             // a disabled node's edit passes false: it changes nothing others read
    refreshOpenPreviews(winId);   // update open preview nodes after edits (winId: only that window)
    refreshOpenDetect(winId);     // update detector/state true-false after edits
  }
  pushHistory();             // record this change for undo/redo
}

// Live node-layout state (positions/sizes/collapse/open-images) ↔ the profile. persist
// calls collectLayout() before every profile PUT, and loadGame calls hydrateLayout()
// after a load. Table column state is folded in by table.js via the injected store.
function collectLayout() {
  const L = (model.profile.layout = model.profile.layout || {});
  const nodes = {};
  for (const [id, p] of pos) {
    const n = { x: p.x, y: p.y };
    const sz = nodeSizes.get(id);
    if (sz) { n.w = sz.w; n.h = sz.h; }
    if (collapsed.has(id)) n.collapsed = true;
    nodes[id] = n;
  }
  L.nodes = nodes;
  L.open_images = [...openImages];
  L.tables = L.tables || {};
  L.groups = groups.collect();
  L.super_groups = groups.collectSuper();   // groups-of-groups travel with the profile too
  // floating panels are NOT persisted (session-only) — drop any stale saved state so it's
  // cleaned from the profile on the next write.
  delete L.float_windows;
}
function hydrateLayout() {
  pos.clear(); nodeSizes.clear(); collapsed.clear();
  const L = model.profile.layout || {};
  for (const [id, n] of Object.entries(L.nodes || {})) {
    if (Number.isFinite(n.x) && Number.isFinite(n.y)) pos.set(id, { x: n.x, y: n.y });
    if (Number.isFinite(n.w) && Number.isFinite(n.h)) nodeSizes.set(id, { w: n.w, h: n.h });
    if (n.collapsed) collapsed.add(id);
  }
  pendingOpenImages = [...(L.open_images || [])];
  groups.hydrate(L.groups);
  groups.hydrateSuper(L.super_groups);   // after groups (super groups reference group ids)
  // floating panels are session-only: never restored from the profile -> always start at their
  // defaults (all hidden). hydrate(undefined) resets each to its _default state.
  for (const [, w] of floatWins()) w.hydrate(undefined);
}

// Per-device viewport (canvas zoom/pan) ↔ the gitignored sidecar. Floating panels are not
// persisted at all now (session-only, all start hidden) — see hydrateLayout/collectLayout.
function collectLocal() {
  return { view: { panX: view.panX, panY: view.panY, zoom: view.zoom } };
}
function applyLocal(local) {
  if (local?.view && Number.isFinite(local.view.zoom)) {
    Object.assign(view, local.view);
    view.zoom = Math.max(0.15, view.zoom);   // restored manual zoom: lower bound only, no font cap
    applyView();
  }
}

// table.js persists its per-table widths/sort into the profile's layout (so they travel
// with the game), and a write schedules a layout save.
const _tableStore = {
  load: (id) => (model.profile.layout?.tables?.[id]) || {},
  save: (id, st) => {
    const L = (model.profile.layout = model.profile.layout || {});
    (L.tables = L.tables || {})[id] = st;
    persist.layout();
  },
};
setTableStore(_tableStore);
setVTableStore(_tableStore);   // VTable persists its column widths the same way
initPersist({
  model,
  collectLayout,
  collectLocal,
  onContentSaved: (err) => {
    if (err) { setStatus(err); return; }
    setStatus("saved ✓");
    refreshAllSubsetNodes();   // backend now knows new/edited subsets -> fill them (no more 404)
  },
});

// ---- groups (titled boxes around nodes; pure layout) -----------------------
// Node type from its id prefix (game | win:… | reg:… | ds:… | …) for default titles.
const _TYPE_BY_PREFIX = { win: "window", prev: "preview", reg: "region", det: "detect", sb: "scrollbar", item: "item", fld: "itemfield", tell: "itemtell", ds: "dataset", sub: "subset", price: "price", dict: "dictionary" };
function nodeTypeOf(id) { return id === "game" ? "game" : (_TYPE_BY_PREFIX[id.split(":")[0]] || null); }
groups.initGroups({
  world: () => $("ggroups"),
  superWorld: () => $("sgroups"),
  nodeRect: (id) => nodeRect(id),
  nodeType: nodeTypeOf,
  // a window's preview node is bonded to it: it shares the window's group, follows it in/out,
  // and is never grouped on its own (so it carries no detach button).
  bonds: () => (model.profile.windows || []).map((w) => ({ leader: `win:${w.id}`, follower: `prev:${w.id}` })),
  moveMembers: (ids, ev) => { const lead = ids.find((id) => pos.get(id)); if (lead) moveNodes(lead, ids.filter((x) => x !== lead), ev); },
  persist: () => persist.layout(),
  afterChange: () => { refreshDetachIcons(); syncMultiSelect(); },
  // double-click a group → frame its bounding box (reuses groupBoxes() geometry)
  zoomToGroup: (gid) => { const gb = groups.groupBoxes().find((b) => b.id === gid); if (gb) panZoomToRect(gb.box); },
  // drag the group's resize grip → scale its members, gaps intact
  startGroupResize: (gid, ev) => startGroupResize(gid, ev),
});

// All per-node UI state (position, size, collapse) is keyed by node id, so any rename
// that changes a node id must remap every one of those maps in lockstep — otherwise the
// node loses its saved slot and jumps. `remapNodeState` is the single place that does
// that; the two helpers below are the only entry points (exact id, or window-prefix).
function remapNodeState(mapId) {
  for (const store of [pos, nodeSizes]) {        // Maps: id -> {x,y} / {w,h}
    for (const id of [...store.keys()]) {
      const to = mapId(id);
      if (to && to !== id) { store.set(to, store.get(id)); store.delete(id); }
    }
  }
  for (const id of [...collapsed]) {              // Set of collapsed ids
    const to = mapId(id);
    if (to && to !== id) { collapsed.delete(id); collapsed.add(to); }
  }
  groups.remapNodes(mapId);   // carry group membership across the rename (don't detach)
}

// Carry one node's saved state to its new id after a rename, so it doesn't jump.
function movePos(oldId, newId) {
  if (oldId === newId) return;
  remapNodeState((id) => (id === oldId ? newId : null));
}

// Renaming a window changes the id embedded in ALL its child nodes, so carry every node
// whose window segment matches — one rename, the whole subtree stays put. Limited to the
// window-owned node types so it can't grab a same-named dataset node (those carry
// separately in the handler, since their stored data moves too).
const WINDOW_NODE_TYPES = new Set(["win", "prev", "reg", "det", "item", "sb"]);
function moveWindowPos(oldWin, newWin) {
  if (oldWin === newWin) return;
  remapNodeState((id) => {
    const p = id.split(":");
    return WINDOW_NODE_TYPES.has(p[0]) && p[1] === oldWin
      ? [p[0], newWin, ...p.slice(2)].join(":") : null;
  });
}

const TYPES = [["text", "text"], ["number", "number"], ["pips", "pips"], ["diamonds", "diamonds (rank)"]];
const EXTRACTS = ["whole", "number", "number_before", "number_after", "text_before", "text_after"];
const NEEDS_SEP = new Set(["number_before", "number_after", "text_before", "text_after"]);
// how the game dictionary participates in a text field's reads (FieldDef.dict_mode)
const DICT_MODES = [
  ["off", "off"],
  ["correct", "correct"],
  ["drop", "drop"],
  ["correct_drop", "correct + drop"],
];

// Conditional fallback rules (FieldRule). `when` is a predicate on the RAW read's
// shape; `then` substitutes a value or drops the record. Rules run in order, first
// match wins. Generalises the old empty / if_number / if_text one-offs.
const RULE_WHEN = [
  ["empty", "is empty"],
  ["no_digit", "has no digit"],
  ["all_digit", "is all digits"],
  ["has_digit", "has a digit"],
  ["no_letter", "has no letter"],
  ["all_letter", "is all letters"],
  ["has_letter", "has a letter"],
  ["always", "always"],
];
const RULE_THEN = [["set", "set value"], ["drop", "drop record"]];

// <option>s for a field's dictionary picker: "all" (every enabled dictionary pooled)
// + each named dictionary. `sel` is the field's pinned DictionaryDef.id ("" = pooled).
function dictOptions(sel) {
  const opts = [`<option value="" ${!sel ? "selected" : ""}>all</option>`];
  for (const d of model.profile.dictionaries || [])
    opts.push(`<option value="${esc(d.id)}" ${sel === d.id ? "selected" : ""}>${esc(d.name || d.id)}</option>`);
  return opts.join("");
}

// ---- layout ---------------------------------------------------------------

function elForPos(id) {
  return nodeEls.get(id);   // everything is a node now (image/preview/data/batches all in-node)
}

function ensurePositions() {
  // stack new nodes below the actual bottom of existing nodes AND panels in the same
  // column (panels are tall), so a new node never lands behind one.
  const colBottom = {};
  for (const [id, p] of pos) {
    if (!Number.isFinite(p.x)) continue;
    const k = Math.round(p.x);
    const h = (elForPos(id)?.offsetHeight) || 140;
    colBottom[k] = Math.max(colBottom[k] || 20, p.y + h + 18);
  }
  for (const n of model.nodes()) {
    if (pos.has(n.id)) continue;
    const x = COLX[n.type] ?? 300;
    const y = colBottom[x] || 20;
    pos.set(n.id, { x, y });
    colBottom[x] = y + 150 + 18;   // estimate height for the next one (not in DOM yet)
  }
}

// The node an edge points AT this one from (its logical parent), for placing a new node
// next to where it belongs.

// Closest free (non-overlapping) slot in a column to `nearY`. Used to drop a brand-new
// node beside its parent instead of at the far bottom of its column. `w`/`h` are the new
// node's REAL measured size (see measureNode) so the gap test fits the actual box, not a
// guess. `joinGroupId` is the group the node is ABOUT to join — its box is excluded from
// the obstacles so the node is allowed to land inside it (every other group still repels).
function freeSpot(x, nearY, w = 240, h = 160, joinGroupId = null) {
  const GAP = 18, STEP = 20;
  const rects = [];
  for (const [id, p] of pos) if (Number.isFinite(p.x)) rects.push({ x: p.x, y: p.y, w: nw(id), h: nh(id) });
  for (const g of groups.groupBoxes()) if (g.id !== joinGroupId) rects.push(g.box);   // a new node must not land inside a (foreign) group
  const free = (y) => !rects.some((o) =>
    x < o.x + o.w + GAP && x + w + GAP > o.x && y < o.y + o.h + GAP && y + h + GAP > o.y);
  for (let d = 0; d <= 8000; d += STEP) {
    for (const y of (d ? [nearY + d, nearY - d] : [nearY])) {
      if (y >= 0 && free(y)) return { x, y: snap(y) };
    }
  }
  return { x, y: Math.max(0, snap(nearY)) };
}

// Build a brand-new node OFFSCREEN purely to read its real border-box size, then discard it.
// Built UNWIRED (wire=false): wireNode side-effects (window openImage() registering into
// imageCanvases, out-port drag wiring) must NOT fire for a throwaway probe — a wired window
// probe would register imageCanvases[winId] against this detached host, so the real node's
// openImage() then early-returns and renders an empty .win-img (no canvas, no capture buttons).
// A node whose size is driven by a <canvas>/<img> only settles its aspect a frame later, so for
// those we wait two rAFs and re-measure — hence async.
async function measureNode(n) {
  const probe = buildNode(n, false);
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.left = "-99999px";
  probe.style.top = "0";
  $("gnodes").appendChild(probe);
  let dims = { w: probe.offsetWidth || 240, h: probe.offsetHeight || 160 };
  if (probe.querySelector("canvas, img")) {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    dims = { w: probe.offsetWidth || dims.w, h: probe.offsetHeight || dims.h };
  }
  probe.remove();
  return dims;
}

// Position a just-created node at the nearest free spot to its parent. Call BEFORE
// render() so ensurePositions() leaves it alone.
// world-space coords of the centre of the usable (panel-clear) viewport
function viewportCenterWorld() {
  const u = usableViewport();
  return { x: (u.left + u.w / 2 - view.panX) / view.zoom, y: (u.top + u.h / 2 - view.panY) / view.zoom };
}

// Position a just-created node. Call BEFORE render() so ensurePositions() leaves it alone.
// `srcId` is the node that SPAWNED this one (a node adding a node): the new node is placed
// just beside it and — if that source sits in a group — allowed to land inside that group's
// box (it then JOINS the group via inheritGroupFrom() after render). With no `srcId` (a
// toolbox spawn) it lands at the viewport centre, clear of every group.
// The node is prerendered (measureNode) so its REAL size drives the free-spot search.
// `at` (world-coords {x,y}) drops the node centred on a specific point — the spot the canvas
// right-click add-node menu was opened at — taking precedence over the viewport-centre default.
async function placeNewNode(id, type, srcId = null, at = null) {
  const n = model.nodes().find((x) => x.id === id);
  const dims = n ? await measureNode(n) : { w: 240, h: 160 };
  const sp = srcId && pos.get(srcId);
  // No free-spot search: a node lands exactly where it was asked for — directly BELOW its
  // spawning node (a bonded preview / subset), else centred on the click/drop point, else the
  // viewport centre. Overlaps are the user's to sort out; they asked for it placed HERE.
  let x, y;
  if (sp) { x = sp.x; y = sp.y + nh(srcId) + 24; }
  else if (at) { x = at.x - dims.w / 2; y = at.y - dims.h / 2; }
  else { const c = viewportCenterWorld(); x = c.x - dims.w / 2; y = c.y - dims.h / 2; }
  pos.set(id, { x: snap(x), y: snap(y) });
  setStatus(`created ${type} ${id.split(":").pop()}`);
}

// A node spawned by another inherits that node's group, so a "+ add" beside a grouped node
// keeps the result in the same box. Call AFTER render() — addToGroup needs the new node to
// have a live rect. Generalises the old item->field grouping; placeNewNode already parked
// the node inside the group's box, so the box just grows to hug it.
function inheritGroupFrom(newId, srcId) {
  if (!srcId) return;
  const g = groups.groupOf(srcId);
  if (g) groups.addToGroup(g.id, [newId]);
}

// ---- smooth pan to a node (cancelled by any user action) ------------------
let panAnim = null;
function cancelPan() { if (panAnim) { cancelAnimationFrame(panAnim); panAnim = null; } }
function panTo(id) {
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
function maxZoom() {
  if (_maxZoom == null) _maxZoom = MAX_FONT_PX / (parseFloat(getComputedStyle(document.body).fontSize) || 14);
  return _maxZoom;
}

// Comfortable zoom to fit a node in the viewport, with only a small margin around it
// (tight, not lots of empty space). Shared by double-click AND the node-map jump.
const FIT_FILL = 0.96;   // node spans this fraction of the viewport
const FIT_MAX = 4;       // allow zooming further in for small nodes
function fitZoom(w, h, rect) {
  return Math.min(maxZoom(), Math.max(0.15, Math.min(FIT_MAX, (rect.width * FIT_FILL) / w, (rect.height * FIT_FILL) / h)));
}

// The part of the graph viewport NOT covered by any visible, uncollapsed floating window —
// so pan/zoom centres a node in clear space instead of behind a panel. Each panel clips the
// usable box on whichever side it intrudes least (panels hug an edge, so this carves them
// off cleanly); chained/overlapping panels just clip in turn. Returns graph-local coords.
function usableViewport() {
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
function panZoomToRect(box, { fit = true } = {}) {
  if (!box || !box.w || !box.h) return;
  const u = usableViewport();   // centre in the area clear of floating panels
  const tz = fit ? fitZoom(box.w, box.h, { width: u.w, height: u.h }) : view.zoom;
  const tx = (u.left + u.w / 2) - (box.x + box.w / 2) * tz;
  const ty = (u.top + u.h / 2) - (box.y + box.h / 2) * tz;
  const sx = view.panX, sy = view.panY, sz = view.zoom, t0 = performance.now(), dur = 380;
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
}

// Smoothly pan AND zoom to centre a node (the node-map jump).
function panZoomTo(id, opts = {}) {
  const el = nodeEls.get(id), p = pos.get(id);
  if (!el || !p) return;
  panZoomToRect({ x: p.x, y: p.y, w: el.offsetWidth || 220, h: el.offsetHeight || 80 }, opts);
}

// (size-HUD readout + aspectLabel now live in dragresize.js, shared with panels)

// ---- group resize: scale members, keep their gaps intact -------------------
function memberBBox(snap) {
  let x = Infinity, y = Infinity, r = -Infinity, b = -Infinity;
  for (const n of snap) { x = Math.min(x, n.x); y = Math.min(y, n.y); r = Math.max(r, n.x + n.w); b = Math.max(b, n.y + n.h); }
  return { x, y, w: r - x, h: b - y };
}
// Group resize: each member's SIZE grows by s; every node then shifts so the empty GAP between
// nodes stays constant (a growing node must push its neighbours, not eat the gap). Members are
// assigned a column index (by x) and a row index (by y). A node is then pushed RIGHT by the
// width-growth of every node LEFT of it IN ITS ROW, and DOWN by the height-growth of every node
// ABOVE it IN ITS COLUMN — so each specific gap moves by exactly its neighbour's growth and holds
// at any drag scale, even when node sizes differ (a per-band MAX would over-shift the smaller
// ones). The leftmost column / topmost row is the anchor (shift 0).
// SIZES are GRID-stepped and read back via offsetWidth/Height so each node's own CSS constraints
// (min/max-width, item width-only + cutout aspect) apply; the post-clamp growth (dw/dh) drives
// the shift, so gaps hold even when a node hits a limit.
//
// Cluster member START coords on one axis into ordered bands (columns for x, rows for y) and
// return each node's band index. Positions are GRID-snapped, so anything within GRID/2 shares a band.
function bandIndex(snap, startOf) {
  const sorted = [...snap].sort((a, b) => startOf(a) - startOf(b));
  const idx = new Map();          // id -> band index
  let band = -1, edge = -Infinity;
  for (const n of sorted) {
    if (startOf(n) > edge + GRID / 2) band++;   // a coord past half-a-grid from the last starts a new band
    edge = startOf(n);
    idx.set(n.id, band);
  }
  return idx;
}
const G = (v) => Math.round(v / GRID) * GRID;
function applyGroupScale(snap, s) {
  const grow = new Map();   // id -> { dw, dh } actual growth after CSS clamping (0 if it can't resize)
  for (const n of snap) {
    const el = nodeEls.get(n.id), type = nodeTypeOf(n.id);
    const free = !collapsed.has(n.id) && type !== "item";   // every node resizes width AND height…
    const widthOnly = !collapsed.has(n.id) && type === "item";       // …except item: width only, height follows its aspect
    if (!el || (!free && !widthOnly)) { grow.set(n.id, { dw: 0, dh: 0 }); continue; }
    el.style.width = `${Math.max(GRID, G(n.w * s))}px`;              // CSS min/max-width clamps this
    if (free) el.style.height = `${Math.max(GRID, G(n.h * s))}px`;
    const aw = el.offsetWidth, ah = el.offsetHeight;                 // size AFTER the node's own constraints
    if (free) nodeSizes.set(n.id, { w: aw, h: ah });
    grow.set(n.id, { dw: aw - n.w, dh: ah - n.h });
  }
  const colOf = bandIndex(snap, (n) => n.x);   // column index per node (vertical stacks share one)
  const rowOf = bandIndex(snap, (n) => n.y);   // row index per node (horizontal runs share one)
  for (const n of snap) {
    let shiftX = 0, shiftY = 0;
    for (const o of snap) {
      if (o === n) continue;
      if (rowOf.get(o.id) === rowOf.get(n.id) && colOf.get(o.id) < colOf.get(n.id)) shiftX += grow.get(o.id).dw;   // left, same row
      if (colOf.get(o.id) === colOf.get(n.id) && rowOf.get(o.id) < rowOf.get(n.id)) shiftY += grow.get(o.id).dh;   // above, same column
    }
    pos.set(n.id, { x: Math.round(n.x + shiftX), y: Math.round(n.y + shiftY) });
    positionNode(n.id);
  }
}

function startGroupResize(gid, ev) {
  ev.preventDefault(); ev.stopPropagation();
  const g = groups.allGroups().find((x) => x.id === gid);
  if (!g) return;
  const snap = g.members.filter((id) => pos.get(id) && nodeEls.get(id))
    .map((id) => { const p = pos.get(id), el = nodeEls.get(id); return { id, x: p.x, y: p.y, w: el.offsetWidth, h: el.offsetHeight }; });
  if (!snap.length) return;
  const mb = memberBBox(snap), z = view.zoom, start = { x: ev.clientX, y: ev.clientY };
  const oldD = Math.hypot(mb.w, mb.h) || 1;
  cancelPan();
  let lastS = 1;
  const onMove = (e) => {
    const dx = (e.clientX - start.x) / z, dy = (e.clientY - start.y) / z;   // drag the bottom-right outward
    lastS = Math.max(0.25, Math.hypot(mb.w + dx, mb.h + dy) / oldD);
    applyGroupScale(snap, lastS);   // grid-stepped each tick
    drawEdges(); groups.renderGroups(); renderNodeViews();
    showSizeHud(mb.w * lastS, mb.h * lastS, e.clientX, e.clientY);
  };
  const onUp = () => {
    document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp);
    hideSizeHud(); persist.layout(); pushHistory();
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

// ---- render ---------------------------------------------------------------

function windowControls(w) {
  // The record key is taught per item template (key section in the item node; the teach
  // page covers grid windows). Where records flow is shown by the wire to the dataset node.
  // The toggles are slide-toggle flabs; the image selector / recapture / page nav live
  // below the canvas (built in openImage). "clicks" only shows when auto-scroll is on.
  const sc = w.scroll || {};
  return `<label class="flab" title="item rows: static tiles the data area into a fixed grid from the cell size (no OCR for location); off locates rows by OCR (a tell/locate field) — only needed for a scroll-parked list">static grid <input type="checkbox" class="winstatic" ${w.static_grid !== false ? "checked" : ""}/></label>
    <label class="flab" title="precapture auto-scrolls this window's list while recording it">auto-scroll <input type="checkbox" class="winscroll" data-k="autoscroll" ${sc.autoscroll ? "checked" : ""}/></label>
    ${sc.autoscroll ? `<label class="flab" title="wheel notches sent per auto-scroll nudge">auto-scroll clicks <input type="number" class="winscroll" data-k="clicks" value="${sc.scroll_clicks ?? 1}" min="1"/></label>` : ""}
    <label class="flab" title="attempt this window in live view">live <input type="checkbox" class="winlive" ${w.live !== false ? "checked" : ""}/></label>
    ${windowItemOrder(w)}`;
}

// Item templates listed in PRIORITY order — the top row is priority 0 (the static grid's
// base cell, which sets the grid pitch); a lower row outranks it when their cells overlap
// the same tile. Reordering IS how priority is set; the number itself is never shown. Click
// a name to jump to that item's node.
function windowItemOrder(w) {
  const items = [...(w.items || [])].sort((a, b) => (a.priority || 0) - (b.priority || 0));
  if (!items.length) return "";
  const rows = items.map((it, i) => `<div class="wi-row" data-id="${esc(it.id)}">
      <span class="wi-name" title="select this item's node">${esc(it.id)}</span>
      <button class="wimv" data-id="${esc(it.id)}" data-d="-1" ${i === 0 ? "disabled" : ""} title="move up — lower priority (top = base cell)">▲</button>
      <button class="wimv" data-id="${esc(it.id)}" data-d="1" ${i === items.length - 1 ? "disabled" : ""} title="move down — higher priority (wins tile overlaps)">▼</button>
    </div>`).join("");
  return `<div class="muted il-h wi-h" title="template priority order — the top template is the base cell (sets the grid pitch); a lower template outranks it when their cells overlap the same tile">templates</div>${rows}`;
}

// The cell size (item.box w/h, window fractions) shown as editable inputs below the cutout
// canvas. Under static grid this IS the grid pitch (column/row spacing); the cell's position
// is unused. Editing reuses setItemCellKeepingChildren so fields/tells stay visually put.
function cellSizeControls(it) {
  const b = it.box || { w: 0, h: 0 };
  const v = (n) => +(+n || 0).toFixed(4);
  // priority-0 is the static grid's base cell; a non-0 item can match its w/h so every
  // template tiles on the same pitch (only shown when this item isn't priority 0 itself)
  return `<label class="flab" title="cell width as a window fraction — the static grid's column pitch">width <input type="number" class="csize" data-k="w" step="0.001" min="0.001" value="${v(b.w)}"/></label>
    <label class="flab" title="cell height as a window fraction — the static grid's row pitch">height <input type="number" class="csize" data-k="h" step="0.001" min="0.001" value="${v(b.h)}"/></label>`;
}

// Keep the cell-size inputs in sync after a canvas cell-resize (which doesn't rebuild the node).
function syncCellSize(winId, itemId) {
  const node = nodeEls.get(`item:${winId}:${itemId}`), it = model.item(winId, itemId);
  if (!node || !it || !it.box) return;
  for (const k of ["w", "h"]) {
    const inp = node.querySelector(`.csize[data-k="${k}"]`);
    if (inp && document.activeElement !== inp) inp.value = +(+it.box[k]).toFixed(4);
  }
}

// One field's fallback-rule rows (FieldRule list). `cls` is the change-class the node
// wiring listens on; `fid` (item fields) tags each control so the wiring resolves the
// field. The value input shows only for a `set` rule (a `drop` needs none).
function ruleRows(fd, cls, fid) {
  const da = fid ? ` data-fid="${esc(fid)}"` : "";
  const rules = fd.rules || [];
  if (!rules.length) return `<div class="muted frule-empty">no rules — the read is used as-is</div>`;
  return rules.map((r, i) => {
    const whenOpts = RULE_WHEN.map(([v, t]) => `<option value="${v}" ${(r.when || "empty") === v ? "selected" : ""}>${t}</option>`).join("");
    const thenOpts = RULE_THEN.map(([v, t]) => `<option value="${v}" ${(r.then || "set") === v ? "selected" : ""}>${t}</option>`).join("");
    const showVal = (r.then || "set") === "set";
    return `<div class="frule" data-ri="${i}">
      <select class="rule-when" data-ri="${i}"${da} title="condition tested on the raw read">${whenOpts}</select>
      <select class="rule-then" data-ri="${i}"${da} title="what to do when it matches">${thenOpts}</select>
      ${showVal ? `<input class="rule-val" data-ri="${i}"${da} value="${esc(r.value || "")}" placeholder="value" title="value substituted into the field"/>` : ""}
      <button class="rule-del danger" data-ri="${i}"${da} title="remove this rule">${TRASH}</button>
    </div>`;
  }).join("");
}

// The per-field config body, SHARED by the region node and the item-field node (one
// renderer, not two copies). Inputs are grouped under .fgrp sub-headings and only the
// ones that DO something for the current type/mode are shown. `cls` is the wiring's
// change-class ("fset" | "ffset"); `fid` (item fields) tags each control.
function fieldConfigBody(fd, cls, fid) {
  const da = fid ? ` data-fid="${esc(fid)}"` : "";
  const pips = fd.type === "pips" || fd.type === "diamonds";
  const isText = fd.type === "text";
  const isNum = fd.type === "number";
  const dictOn = (fd.dict_mode || "correct") !== "off";   // dictionary actually consulted
  const hasDicts = (model.profile.dictionaries || []).length;
  const types = TYPES.map(([v, t]) => `<option value="${v}" ${fd.type === v ? "selected" : ""}>${t}</option>`).join("");
  const exs = EXTRACTS.map((v) => `<option ${(fd.extract || "whole") === v ? "selected" : ""}>${v}</option>`).join("");
  return `
    <div class="fgrp">read</div>
    <label class="flab" title="read this box in isolation: OCR only its own crop instead of picking tokens from the window-wide pass — use when a digit fuses with a neighbouring glyph (e.g. drain '8' read as '81')">isolate <input type="checkbox" class="${cls}" data-k="isolate"${da} ${fd.isolate ? "checked" : ""}/></label>
    <label class="flab">type <select class="${cls}" data-k="type"${da}>${types}</select></label>
    ${pips ? "" : `<label class="flab">extract <select class="${cls}" data-k="extract"${da}>${exs}</select></label>`}
    ${(!pips && NEEDS_SEP.has(fd.extract)) ? `<label class="flab">separator <input class="${cls}" type="text" data-k="sep"${da} value="${esc(fd.separator || "/")}"/></label>` : ""}
    <label class="flab" title="minimum OCR confidence this field must reach — a weaker read drops the whole record (0 = use the global floor)">conf <input type="number" class="${cls}" data-k="minconf"${da} step="0.05" min="0" max="1" value="${fd.min_confidence ?? 0}"/></label>
    ${isNum ? `<label class="flab" title="lowest plausible value — a read below this is a misread and drops the record (blank = no minimum)">min <input type="number" class="${cls}" data-k="min"${da} value="${fd.min ?? ""}" placeholder="(none)"/></label>
    <label class="flab" title="highest plausible value — a read above this is a misread and drops the record (blank = no maximum)">max <input type="number" class="${cls}" data-k="max"${da} value="${fd.max ?? ""}" placeholder="(none)"/></label>` : ""}
    ${isText ? `<div class="fgrp">dictionary</div>
    <label class="flab" title="off = dictionary not consulted; correct = fix words, keep unmatched; drop = no fixes, unmatched read dropped; correct + drop = fix words, unmatchable read dropped">dict <select class="${cls}" data-k="dictmode"${da}>${DICT_MODES.map(([v, t]) => `<option value="${v}" ${(fd.dict_mode || "correct") === v ? "selected" : ""}>${t}</option>`).join("")}</select></label>
    ${(hasDicts && dictOn) ? `<label class="flab" title="which authored dictionary this field snaps to (all = every enabled one pooled)">use dict <select class="${cls}" data-k="usedict"${da}>${dictOptions(fd.dictionary)}</select></label>` : ""}
    <label class="flab" title="learn the dictionary from confident reads, fuzzy-correct uncertain ones">learn <input type="checkbox" class="${cls}" data-k="learn"${da} ${fd.learn ? "checked" : ""}/></label>
    ${(fd.learn || dictOn) ? `<label class="flab" title="similarity (0-1) an uncertain read must reach to snap to a known word; higher = stricter">fuzzy <input type="number" class="${cls}" data-k="fuzzy"${da} step="0.05" min="0" max="1" value="${fd.fuzzy ?? 0.82}"/></label>` : ""}` : ""}
    <div class="fgrp">rules <button class="ruleadd"${da} title="add a fallback rule">+ rule</button></div>
    ${ruleRows(fd, cls, fid)}`;
}

// One item field is its OWN node (a child of its item node). It renders the shared
// per-field config (against the window's FieldDef) plus the row-role controls (tell /
// locate / align) that only make sense for a field inside an item template.
function itemFieldParts(n) {
  const f = n.ref, fd = n.field || { type: "text", extract: "whole", learn: false, fuzzy: 0.82 };
  const body = `${fieldConfigBody(fd, "ffset", f.id)}
    <div class="fgrp">row role</div>
    <label class="flab" title="require this field to read something — it doubles as a tell">tell <input type="checkbox" class="itell" data-fid="${f.id}" ${f.tell ? "checked" : ""}/></label>
    ${f.tell ? `<label class="flab" title="minimum OCR confidence the read must reach (0 = any)">tell conf <input type="number" class="itellconf" data-fid="${f.id}" step="0.05" min="0" max="1" value="${f.tell_conf ?? 0}"/></label>` : ""}
    ${f.tell && fd.type === "number" ? `<label class="flab" title="pass the tell even when the read carries text (e.g. a polarity glyph), not only a clean number">allow text <input type="checkbox" class="itelltext" data-fid="${f.id}" ${f.tell_allow_text ? "checked" : ""}/></label>` : ""}
    <label class="flab" title="use this field to LOCATE rows (anchor the grid) — independent of tell; a reliable text field (e.g. the name) can locate without being a tell">locate <input type="checkbox" class="iloc" data-fid="${f.id}" ${f.locate ? "checked" : ""}/></label>
    ${(f.tell || f.locate) ? `<label class="flab" title="which line of a wrapped name to anchor the row on">align <select class="itellalign" data-fid="${f.id}">${["none", "top", "center", "bottom"].map((v) => `<option ${(f.align || n.item.align || "center") === v ? "selected" : ""}>${v}</option>`).join("")}</select></label>` : ""}
    <div class="gn-foot"></div>`;
  return { title: `<input class="gi gi-id" data-k="fldid" value="${esc(f.id)}" title="field id" />`, body };
}

// One tell is its OWN node (a child of its item node). It renders the per-tell controls that
// used to live inline in the item node: kind, the kind-specific input (field for text, colour
// for color), threshold, and — only when the window locates rows by OCR (static grid off) —
// the locate toggle + its align. Mirrors itemFieldParts.
function itemTellParts(n) {
  const t = n.ref, it = n.item, w = n.win;
  const staticOn = w.static_grid !== false;   // static grid tiles rows from the cell — locate is unused
  const body = `
    <label class="flab" title="what this tell checks">kind <span class="tt-kind">${esc(t.kind)}</span></label>
    ${t.kind === "text" ? `<label class="flab" title="which field this tell reads to validate the cell">field <select class="tset" data-k="field">${(it.fields || []).map((f) => `<option ${t.field === f.field ? "selected" : ""}>${esc(f.field)}</option>`).join("")}</select></label>` : ""}
    ${t.kind === "color" ? `<label class="flab" title="the colour that must be present in the tell box">colour <input type="color" class="tset" data-k="color" value="${t.color || "#ffcc00"}"/></label>` : ""}
    <label class="flab" title="pass score (0..1) the tell must reach">threshold <input type="number" class="tset" data-k="threshold" step="0.05" min="0" max="1" value="${t.threshold ?? 0.5}"/></label>
    ${staticOn ? "" : `<label class="flab" title="use this tell to LOCATE rows (anchor the grid) — only one tell per item locates">locate <input type="checkbox" class="tloc" ${t.locate ? "checked" : ""}/></label>`}
    ${(t.locate && !staticOn) ? `<label class="flab" title="anchor on this line of a wrapped name">align <select class="tset" data-k="align">${["none", "top", "center", "bottom"].map((v) => `<option ${(t.align || it.align || "center") === v ? "selected" : ""}>${v}</option>`).join("")}</select></label>` : ""}
    <div class="gn-foot"></div>`;
  return { title: `<input class="gi gi-id" data-k="tellid" value="${esc(t.id)}" title="tell id" />`, body };
}

// Shared wiring for a field-config body's rule editor (region + item-field nodes both
// call this). `rebuild` re-renders the node body (add/remove a rule, or a then-toggle
// that shows/hides its value); `commit` persists a plain value edit without a rebuild.
function wireFieldRules(div, fd, { rebuild, commit }) {
  fd.rules = fd.rules || [];
  div.querySelector(".ruleadd")?.addEventListener("click", () => {
    fd.rules.push({ when: "empty", then: "set", value: "" });
    rebuild();
  });
  div.querySelectorAll(".rule-when").forEach((s) => s.addEventListener("change", (e) => {
    fd.rules[+e.target.dataset.ri].when = e.target.value; commit();
  }));
  div.querySelectorAll(".rule-then").forEach((s) => s.addEventListener("change", (e) => {
    fd.rules[+e.target.dataset.ri].then = e.target.value; rebuild();   // show/hide the value input
  }));
  div.querySelectorAll(".rule-val").forEach((inp) => inp.addEventListener("input", (e) => {
    fd.rules[+e.target.dataset.ri].value = e.target.value; commit();
  }));
  div.querySelectorAll(".rule-del").forEach((b) => b.addEventListener("click", (e) => {
    fd.rules.splice(+e.target.dataset.ri, 1); rebuild();
  }));
}

function itemLists(it, w) {
  // tells are their OWN nodes now — the item lists only a compact summary (id + kind + remove);
  // the full per-tell editor lives on each tell node (itemTellParts). Mirrors fieldsSummary below.
  const tellsSummary = (it.tells || []).map((t) => `<div class="ti-sum" data-tid="${esc(t.id)}" title="select this tell's node">
      <span class="ti-sum-name">${esc(t.id)}</span>
      <span class="ti-sum-kind muted">${esc(t.kind)}</span>
      <button class="ti-del danger" data-tid="${esc(t.id)}" title="remove">${TRASH}</button></div>`).join("");
  // fields flagged as tells (f.tell) show here too, read-only — they're edited in the fields
  // list below; the only action is remove, which just unchecks the field's tell flag.
  const fieldTells = (it.fields || []).filter((f) => f.tell).map((f) => `<div class="ti-row ti-fieldtell" data-fid="${esc(f.id)}">
      <span class="ti-kind">field</span>
      <span class="ti-name">${esc(f.id)}</span>
      <span class="ti-ro muted">tell · conf ${f.tell_conf ?? 0}</span>
      <button class="ti-untell danger" data-fid="${esc(f.id)}" title="stop using this field as a tell">${TRASH}</button></div>`).join("");
  // fields are their OWN nodes now — the item lists only a compact summary (name + remove);
  // the full per-field editor lives on each field node (itemFieldParts).
  const fieldsSummary = (it.fields || []).map((f) => `<div class="if-sum" data-fid="${esc(f.id)}" title="select this field's node">
      <span class="if-sum-name">${esc(f.id)}</span>
      <button class="if-del danger" data-fid="${esc(f.id)}" title="remove">${TRASH}</button></div>`).join("");
  // the cutout draw-mode buttons, split by what they draw: cell under "cell", field under
  // "fields", every tell kind under "tells". Selecting one sets the active draw kind.
  const drawBtn = ([v, label, icon, tip]) => `<button class="tool" data-kind="${v}" title="${esc(tip || `draw ${label}`)}">${icon} ${label}</button>`;
  // copy w/h from the priority-0 base cell — sits next to the cell draw button (non-base only)
  const matchBtn = (it.priority || 0) === 0 ? ""
    : `<button class="csize-match" title="copy width & height from the base cell (the top template — the static grid's base pitch)">match base</button>`;
  const cellBtns = ITEM_KINDS.filter(([v]) => v === "bbox").map(drawBtn).join("") + matchBtn;
  const fieldBtns = ITEM_KINDS.filter(([v]) => v === "field").map(drawBtn).join("");
  const tellBtns = ITEM_KINDS.filter(([v]) => v !== "bbox" && v !== "field").map(drawBtn).join("");
  return `<div class="muted il-h">cell</div>
    <div class="il-tools">${cellBtns}</div>
    ${cellSizeControls(it)}
    <div class="muted il-h">tells</div>
    <div class="il-tools">${tellBtns}</div>
    ${(tellsSummary + fieldTells) || '<div class="muted">draw a tell on the cutout</div>'}
    <div class="muted il-h">fields</div>
    <div class="il-tools">${fieldBtns}</div>
    ${fieldsSummary || '<div class="muted">draw a field on the cutout</div>'}
    ${keySection(it, w)}
    `;
}

// The item's record key (dedup identity): which fields identify a record, in what
// order, joined how. Live preview = the key the LAST cutout read would store under,
// recomputed instantly on every config edit (client mirror of the server's KeySpec);
// the server's own key shows in the read-out after the next read.
function keySection(it, w) {
  const eff = it.key || w.key || DEFAULT_KEY;
  const used = eff.fields && eff.fields.length ? eff.fields : ["name"];
  const fids = [...new Set((it.fields || []).map((f) => f.field))];
  const rows = used.map((fid, i) => `<div class="key-row" data-i="${i}">
      <select class="kfield" data-i="${i}">${(fids.includes(fid) ? fids : [fid, ...fids])
        .map((f) => `<option ${f === fid ? "selected" : ""}>${esc(f)}</option>`).join("")}</select>
      <button class="kmv" data-i="${i}" data-d="-1" ${i === 0 ? "disabled" : ""} title="earlier in the key">▲</button>
      <button class="kmv" data-i="${i}" data-d="1" ${i === used.length - 1 ? "disabled" : ""} title="later in the key">▼</button>
      <button class="kdel danger" data-i="${i}" ${used.length <= 1 ? "disabled" : ""} title="remove from the key">${TRASH}</button>
    </div>`).join("");
  const addable = fids.filter((f) => !used.includes(f));
  return `<div class="muted il-h" title="which fields identify a record — reads with the same key merge; a different key (e.g. another level) is its own record. A record missing any key part is dropped.">key</div>
    <label class="flab" title="joins the parts in the stored key">separator <input class="ksep" value="${esc(eff.sep ?? "|")}" size="2"/></label>
    ${addable.length ? `<label class="flab" title="add a field to the key">+ field <select class="kadd"><option value="">field…</option>${addable.map((f) => `<option>${esc(f)}</option>`).join("")}</select></label>` : ""}
    <label class="flab" title="treat keys differing only in case as distinct">is case-sensitive <input type="checkbox" class="kcase" ${eff.case_sensitive ? "checked" : ""}/></label>
    ${rows}`;
}

// The key the LAST cutout read would store under — recomputed instantly from the
// cached read on every key-config edit (client mirror of the server's KeySpec),
// refreshed again when the automatic cutout read lands. Empty until a read exists.
function keyPrevHTML(winId, itemId) {
  const it = model.item(winId, itemId), w = model.window(winId);
  const rd = itemReads.get(`${winId}:${itemId}`);
  if (!it || !w || !rd) return "";
  const eff = it.key || w.key || DEFAULT_KEY;
  const vals = {};
  for (const [k, v] of Object.entries(rd.fields || {})) vals[k] = v.value;
  const key = buildKey(vals, eff);
  if (key !== null) return `<b class="conf-ok">${esc(key)}</b>`;   // label ("key:") is the readout grid's job now
  const used = eff.fields && eff.fields.length ? eff.fields : ["name"];
  const miss = used.find((f) => vals[f] === null || vals[f] === undefined || vals[f] === "");
  return `<span class="tc-bad">∅ no key${miss ? ` — ${esc(miss)} read empty` : ""}</span> <span class="muted">(record dropped)</span>`;
}

// THE single update path after ANY item edit. Every item handler calls this instead of
// hand-assembling rebuild/clear/refresh/read/save combos (which drifted and kept missing a
// step). Order matters: rebuild/render the DOM first, then redraw boxes + invalidate the
// stale window grid, re-read the cutout (item readout + tints), and persist — autosave's
// refresh re-runs the open window preview so the window canvas re-detects too.
//   rebuild: rebuild the item node DOM (the edit changed which controls show)
//   render:  full graph render (the edit changed nodes/edges — id rename, dict link)
//   reread:  the edit changed what/where OCR reads (geometry, tells, fields). FALSE for
//            edits that touch neither pixels nor boxes (id rename, record-key identity) —
//            skip the costly cutout re-read + window preview re-OCR for those.
function itemChanged(winId, itemId, { rebuild = false, render: doRender = false, reread = true } = {}) {
  if (doRender) render();
  else if (rebuild) rebuildNode(`item:${winId}:${itemId}`);
  refreshItemBoxes(winId, itemId);   // item cutout boxes
  refreshImageBoxes(winId);          // window image boxes + grid guides
  if (reread) {
    clearGrid(winId);                // detected window grid is now stale
    scheduleItemRead(winId, itemId); // re-read the cutout -> readout + box tints
  }
  autosave(reread, winId);           // persist; re-run this window's preview/detect only when reread
}

// Wire an item node's id + tells/fields lists (rebuildNode re-binds these,
// preserving the live cutout canvas). Every edit funnels through itemChanged().
function wireItemControls(div, n) {
  const winId = n.win.id, itemId = n.ref.id;
  div.querySelectorAll(".csize").forEach((inp) => inp.addEventListener("change", (e) => {
    const it = model.item(winId, itemId);
    if (!it || !it.box) return;
    const k = e.target.dataset.k, v = +e.target.value;
    if (!(v > 0)) { e.target.value = +(+it.box[k]).toFixed(4); return; }   // reject 0/blank
    setItemCellKeepingChildren(winId, itemId, { ...it.box, [k]: v });   // resize, keep fields put
    itemChanged(winId, itemId);
  }));
  div.querySelector(".csize-match")?.addEventListener("click", () => {
    const it = model.item(winId, itemId);
    const base = (n.win.items || []).find((x) => (x.priority || 0) === 0);   // the grid's base cell
    if (!it || !it.box || !base || !base.box) return;
    setItemCellKeepingChildren(winId, itemId, { ...it.box, w: base.box.w, h: base.box.h });
    itemChanged(winId, itemId); syncCellSize(winId, itemId);   // copy P0 w/h, reflect in inputs
  });
  div.querySelector(".gi-id").addEventListener("change", (e) => {
    const newId = e.target.value.trim();
    if (!model.renameItem(winId, itemId, newId)) { e.target.value = itemId; return; }
    movePos(`item:${winId}:${itemId}`, `item:${winId}:${newId}`);
    itemChanged(winId, newId, { render: true, reread: false });   // id only — no pixels/boxes change
  });
  // a tell's full editor is its OWN node now; the item shows a summary. Removing a tell
  // drops its node (full render). Clicking a summary row pans to the tell node (below).
  div.querySelectorAll(".ti-del").forEach((b) => b.addEventListener("click", () => {
    model.removeItemTell(winId, itemId, b.dataset.tid);
    itemChanged(winId, itemId, { render: true });   // the tell node is gone -> re-render
  }));
  // a field-tell's remove just clears the field's tell flag (the field itself stays). Render
  // so the field's OWN node also reflects the unchecked tell.
  div.querySelectorAll(".ti-untell").forEach((b) => b.addEventListener("click", () => {
    model.setItemFieldTell(winId, itemId, b.dataset.fid, false);
    itemChanged(winId, itemId, { render: true });
  }));
  // a field's full editor is its OWN node now; the item shows a summary. Removing a field
  // drops its node (full render). Clicking a summary row pans to the field node.
  div.querySelectorAll(".if-del").forEach((b) => b.addEventListener("click", () => {
    model.removeItemField(winId, itemId, b.dataset.fid);
    itemChanged(winId, itemId, { render: true });   // the field node is gone -> re-render
  }));
  div.querySelectorAll(".if-sum").forEach((row) => row.addEventListener("mousedown", (ev) => {
    if (ev.target.closest("button")) return;
    panZoomTo(`fld:${winId}:${itemId}:${row.dataset.fid}`);
  }));
  // cutout draw-mode buttons live in the node body now: pick the active draw kind. The canvas
  // overlay reads `.tool.active` off this node (see openItemImage's kindOf).
  div.querySelectorAll(".tool").forEach((b) => b.addEventListener("click", () => {
    div.querySelectorAll(".tool").forEach((x) => x.classList.remove("active")); b.classList.add("active");
  }));
  // record-key config: mutate the item's own KeyDef (created from the effective one on
  // first edit). The key preview recomputes from the cached read; itemChanged rebuilds.
  const keyEdit = (fn) => {
    const k = model.ensureItemKey(winId, itemId);
    if (!k) return;
    fn(k);
    itemChanged(winId, itemId, { rebuild: true, reread: false });   // record identity only — no OCR change
    const out = div.querySelector(".item-readout");   // key lives in the readout now; refresh it now (the re-read is debounced)
    const rd = itemReads.get(`${winId}:${itemId}`);
    if (out && rd) out.innerHTML = itemReadout(rd, winId, itemId);
  };
  div.querySelectorAll(".kfield").forEach((s) => s.addEventListener("change", (e) =>
    keyEdit((k) => { k.fields[+e.target.dataset.i] = e.target.value; })));
  div.querySelectorAll(".kmv").forEach((b) => b.addEventListener("click", () => keyEdit((k) => {
    const i = +b.dataset.i, j = i + (+b.dataset.d);
    if (j < 0 || j >= k.fields.length) return;
    [k.fields[i], k.fields[j]] = [k.fields[j], k.fields[i]];
  })));
  div.querySelectorAll(".kdel").forEach((b) => b.addEventListener("click", () =>
    keyEdit((k) => { if (k.fields.length > 1) k.fields.splice(+b.dataset.i, 1); })));
  div.querySelector(".kadd")?.addEventListener("change", (e) => {
    if (e.target.value) keyEdit((k) => { k.fields.push(e.target.value); });
  });
  div.querySelector(".ksep")?.addEventListener("change", (e) => keyEdit((k) => { k.sep = e.target.value || "|"; }));
  div.querySelector(".kcase")?.addEventListener("change", (e) => keyEdit((k) => { k.case_sensitive = e.target.checked; }));
  // a tell summary row pans to that tell's OWN node (its box is selectable on the cutout)
  div.querySelectorAll(".ti-sum").forEach((row) => row.addEventListener("mousedown", (ev) => {
    if (ev.target.closest("button")) return;
    panZoomTo(`tell:${winId}:${itemId}:${row.dataset.tid}`);
  }));
}

// Add a freshly-created field/tell node to whatever group its item node belongs to, so a
// child drawn from an item stays grouped with it (no-op when the item isn't grouped).
function addFieldToItemGroup(winId, itemId, fid) {
  inheritGroupFrom(`fld:${winId}:${itemId}:${fid}`, `item:${winId}:${itemId}`);
}
function addTellToItemGroup(winId, itemId, tid) {
  inheritGroupFrom(`tell:${winId}:${itemId}:${tid}`, `item:${winId}:${itemId}`);
}

// On load, pull every ORPHAN item-child node (fields/tells) into its item's group, so a child
// that became its own node sits with the item it was moved from. Idempotent; an already-grouped
// child (incl. one the user moved elsewhere) is left alone. Needs nodes rendered (for rects).
function groupOrphanChildren(type) {
  const byGroup = {};
  for (const n of model.nodes()) {
    if (n.type !== type || groups.groupOf(n.id)) continue;
    const g = groups.groupOf(`item:${n.win.id}:${n.item.id}`);
    if (g) (byGroup[g.id] = byGroup[g.id] || []).push(n.id);
  }
  for (const [gid, ids] of Object.entries(byGroup)) groups.addToGroup(gid, ids);
}

// THE update path after a FIELD-node edit (mirrors itemChanged, but a field config also
// affects the item's tells-mirror/key/summary, so optionally rebuild the item node too).
//   rebuild:     the field node DOM (type/tell/locate toggled which controls show)
//   rebuildItem: the item node DOM (tell flag / conf changed -> its mirror + key)
//   render:      full graph render (id rename, dict link, node add/remove)
function fieldChanged(winId, itemId, fid, { rebuild = false, rebuildItem = false, render: doRender = false } = {}) {
  if (doRender) render();
  else {
    if (rebuild) rebuildNode(`fld:${winId}:${itemId}:${fid}`);
    if (rebuildItem) rebuildNode(`item:${winId}:${itemId}`);
  }
  refreshItemBoxes(winId, itemId);
  refreshImageBoxes(winId);
  clearGrid(winId);
  scheduleItemRead(winId, itemId);
  autosave(true, winId);
}

// Wire one item-field node: the per-field config that used to live inline in the item node.
function wireItemField(div, n) {
  const winId = n.win.id, itemId = n.item.id, fid = n.ref.id;
  div.querySelector(".gi-id").addEventListener("change", (e) => {
    const newId = e.target.value.trim();
    if (!model.renameItemField(winId, itemId, fid, newId)) { e.target.value = fid; return; }
    movePos(`fld:${winId}:${itemId}:${fid}`, `fld:${winId}:${itemId}:${newId}`);
    fieldChanged(winId, itemId, newId, { render: true });
  });
  div.querySelectorAll(".ffset").forEach((inp) => inp.addEventListener("change", (e) => {
    const f = model.itemField(winId, itemId, fid);
    const fd = f && (n.win.fields || []).find((x) => x.id === f.field);
    if (!fd) return;
    const k = e.target.dataset.k;
    let rebuild = false, doRender = false;
    if (k === "type") { fd.type = e.target.value; rebuild = true; }       // toggles extract/sep/dict/min-max
    else if (k === "extract") { fd.extract = e.target.value; rebuild = true; }  // toggles separator
    else if (k === "sep") fd.separator = e.target.value || "/";
    else if (k === "learn") { fd.learn = e.target.checked; rebuild = true; }    // toggles fuzzy
    else if (k === "fuzzy") fd.fuzzy = +e.target.value;
    else if (k === "minconf") fd.min_confidence = +e.target.value || 0;
    else if (k === "isolate") fd.isolate = e.target.checked;
    else if (k === "min") fd.min = e.target.value === "" ? null : +e.target.value;
    else if (k === "max") fd.max = e.target.value === "" ? null : +e.target.value;
    else if (k === "dictmode") { fd.dict_mode = e.target.value; rebuild = true; }  // toggles use-dict/fuzzy
    else if (k === "usedict") { fd.dictionary = e.target.value || ""; doRender = true; }   // redraw the dict link
    fieldChanged(winId, itemId, fid, { rebuild, render: doRender });
  }));
  if (n.field) wireFieldRules(div, n.field, {
    rebuild: () => fieldChanged(winId, itemId, fid, { rebuild: true }),
    commit: () => fieldChanged(winId, itemId, fid),
  });
  div.querySelector(".itell")?.addEventListener("change", (e) => {
    model.setItemFieldTell(winId, itemId, fid, e.target.checked);
    fieldChanged(winId, itemId, fid, { rebuild: true, rebuildItem: true });   // show/hide tell-conf + item mirror
  });
  div.querySelector(".itellconf")?.addEventListener("change", (e) => {
    model.setItemFieldTellConf(winId, itemId, fid, +e.target.value || 0);
    fieldChanged(winId, itemId, fid, { rebuildItem: true });
  });
  div.querySelector(".itelltext")?.addEventListener("change", (e) => {
    model.setItemFieldTellAllowText(winId, itemId, fid, e.target.checked);
    fieldChanged(winId, itemId, fid);
  });
  div.querySelector(".iloc")?.addEventListener("change", (e) => {
    model.setItemFieldLocate(winId, itemId, fid, e.target.checked);
    fieldChanged(winId, itemId, fid, { rebuild: true });   // show/hide the align dropdown
  });
  div.querySelector(".itellalign")?.addEventListener("change", (e) => {
    model.setItemFieldAlign(winId, itemId, fid, e.target.value);
    fieldChanged(winId, itemId, fid);
  });
}

// THE update path after a TELL-node edit (mirrors fieldChanged): a tell change affects the
// item's readout, the cutout boxes, the window grid (locate anchors rows), and the item
// node's tell summary — so re-OCR + persist, optionally rebuilding the tell node / full graph.
//   rebuild: the tell node DOM (a control toggled which others show)
//   render:  full graph render (id rename, locate toggle -> sibling tell nodes, node add/remove)
//   reread:  the edit changed what/where OCR reads. FALSE for id-only renames.
function tellChanged(winId, itemId, tid, { rebuild = false, render: doRender = false, reread = true } = {}) {
  if (doRender) render();
  else if (rebuild) rebuildNode(`tell:${winId}:${itemId}:${tid}`);
  refreshItemBoxes(winId, itemId);
  refreshImageBoxes(winId);
  if (reread) { clearGrid(winId); scheduleItemRead(winId, itemId); }
  autosave(reread, winId);
}

// Wire one tell node: the per-tell controls that used to live inline in the item node.
function wireItemTell(div, n) {
  const winId = n.win.id, itemId = n.item.id, tid = n.ref.id;
  div.querySelector(".gi-id").addEventListener("change", (e) => {
    const newId = e.target.value.trim();
    if (!model.renameItemTell(winId, itemId, tid, newId)) { e.target.value = tid; return; }
    movePos(`tell:${winId}:${itemId}:${tid}`, `tell:${winId}:${itemId}:${newId}`);
    tellChanged(winId, itemId, newId, { render: true, reread: false });   // id only — no pixels/boxes
  });
  div.querySelectorAll(".tset").forEach((inp) => inp.addEventListener("change", (e) => {
    const k = e.target.dataset.k;
    const v = k === "threshold" ? (+e.target.value || 0) : e.target.value;
    model.setItemTellProp(winId, itemId, tid, k, v);
    tellChanged(winId, itemId, tid);
  }));
  div.querySelector(".tloc")?.addEventListener("change", (e) => {
    // locate is single-choice across the item's tells — clear the others, set this one
    for (const t of n.item.tells || []) model.setItemTellProp(winId, itemId, t.id, "locate", false);
    model.setItemTellProp(winId, itemId, tid, "locate", e.target.checked);
    tellChanged(winId, itemId, tid, { render: true });   // align dropdown + sibling tell nodes
  });
}

// Wire the window node's controls (extracted so rebuildNode can re-bind them
// without recreating the node — which would destroy the embedded image canvas).
function wireWindowControls(div, n) {
  div.querySelector(".gi-id").addEventListener("change", async (e) => {
    const oldId = n.ref.id, newId = e.target.value.trim();
    const oldDs = model.datasetOf(n.ref);   // a default dataset (id == window id) renames with it
    if (!model.renameWindow(oldId, newId)) { e.target.value = oldId; return; }
    // The capture binding + open image are keyed by window id — carry them across so the
    // image canvas doesn't blank on rename. Move the binding (server), drop the old-keyed
    // canvas, then re-open under the new id (which loads from the moved binding).
    const game = model.profile.name, wasOpen = openImages.has(oldId);
    try {
      const caps = await api.bindingList(game, oldId);   // all image pages move with the window
      if (caps.length) { await api.setBindings(game, newId, caps); await api.setBindings(game, oldId, []); }
      if (winPage.has(oldId)) { winPage.set(newId, winPage.get(oldId)); winPage.delete(oldId); }
    } catch { /* binding move failed -> image just reloads empty, not fatal */ }
    if (imageCanvases.has(oldId)) closeImage(oldId);
    moveWindowPos(oldId, newId);            // win + all child nodes
    const newDs = model.datasetOf(n.ref);
    if (newDs !== oldDs) movePos(`ds:${oldDs}`, `ds:${newDs}`);
    // a rename changes only the id/wiring — no pixels or boxes change, so DON'T trigger the
    // all-open-windows detect/preview refresh (autosave(false)). The reopened image below
    // re-detects just the renamed window.
    render(); autosave(false);
    if (wasOpen) await openImage(newId);    // restore the image against the moved binding
  });
  div.querySelector(".winlive")?.addEventListener("change", (e) => {
    model.setWindowLive(n.ref.id, e.target.checked);
    autosave(false);          // a live-view flag changes nothing other nodes re-read
    renderLiveWindow();       // reflect in the live panel's window list
  });
  div.querySelector(".winstatic")?.addEventListener("change", (e) => {
    model.setWindowStaticGrid(n.ref.id, e.target.checked);
    [...imageCanvases.keys()].includes(n.ref.id) && clearGrid(n.ref.id);   // grid<->locator
    // static toggles whether OCR locate applies — re-bind item nodes so their locate
    // radios enable/disable to match (rebuildNode keeps each item's live cutout canvas)
    for (const it of model.window(n.ref.id)?.items || []) rebuildNode(`item:${n.ref.id}:${it.id}`);
    refreshImageBoxes(n.ref.id); autosave();   // redraw guides; re-detect on next preview
  });
  div.querySelectorAll(".winscroll").forEach((inp) => inp.addEventListener("change", (e) => {
    const k = e.target.dataset.k;
    if (k === "autoscroll") {
      model.setScrollAutoscroll(n.ref.id, e.target.checked);
      rebuildNode(`win:${n.ref.id}`);   // show/hide the "auto-scroll clicks" flab
    } else if (k === "clicks") model.setScrollClicks(n.ref.id, Math.max(1, +e.target.value || 1));
    autosave(false);   // precapture-only knobs — the reader/preview never use them, so don't re-OCR
  }));
  // reorder the item-template priority list: ▲/▼ swap a template up/down, re-numbering
  // priorities to match the new order (top = 0). The base cell may change -> reread.
  div.querySelectorAll(".wimv").forEach((b) => b.addEventListener("click", () => {
    model.moveItemPriority(n.ref.id, b.dataset.id, +b.dataset.d);
    windowItemsReordered(n.ref.id);
  }));
  // click a template name -> jump to its item node (don't swallow the ▲/▼ button clicks)
  div.querySelectorAll(".wi-row .wi-name").forEach((el) => el.addEventListener("click", (e) => {
    panZoomTo(`item:${n.ref.id}:${el.closest(".wi-row").dataset.id}`);
  }));
}

// After a priority reorder: refresh the window's ordered list (arrows/disabled), rebuild
// every item node (the priority-0 base changed -> "match base" button visibility), drop the
// stale grid (base pitch may differ), and re-run this window's preview.
function windowItemsReordered(winId) {
  rebuildNode(`win:${winId}`);
  for (const it of model.window(winId)?.items || []) rebuildNode(`item:${winId}:${it.id}`);
  clearGrid(winId);
  refreshImageBoxes(winId);
  autosave(true, winId);
}

function nodeParts(n) {
  if (n.type === "game") {
    const g = n.ref;
    return {
      title: `<input class="gi gi-id" data-k="name" value="${esc(g.name)}" title="game name" />`,
      body: `
        <label class="flab">process <input class="gi" data-k="proc" value="${esc((g.process_names || []).join(", "))}" placeholder="Warframe.x64.exe" /></label>
        <label class="flab">title hint <input class="gi" data-k="title" value="${esc(g.window_title_hint || "")}" placeholder="Warframe" /></label>`,
    };
  }
  if (n.type === "window") {
    const w = n.ref;
    return {
      title: `<input class="gi gi-id" data-k="winid" value="${esc(w.id)}" />`,
      body: `<div class="win-controls">${windowControls(w)}</div><div class="win-img"></div>`,
      ports: `<span class="port out" title="drag to a dataset to send this window's rows there"></span>`,
    };
  }
  if (n.type === "region") {
    const f = n.field || { type: "text", extract: "whole", learn: false, fuzzy: 0.82 };
    return {
      title: `<input class="gi gi-id" data-k="regid" value="${esc(n.ref.id)}" title="region / field id" />`,
      body: `${fieldConfigBody(f, "fset")}
        <div class="gn-foot"></div>`,
    };
  }
  if (n.type === "detect") {
    const a = n.ref;
    return {
      title: `<input class="gi gi-id" data-k="detid" value="${esc(a.id)}" title="detector: all must match to capture" />`,
      body: `<label class="flab">text <input class="aset" data-k="text" value="${esc(a.text || "")}" placeholder="EQUIPMENT" /></label>
        <label class="flab" title="how text is compared: partial=substring (loose); full=whole-string; exact=equal; prefix=starts-with">mode
          <select class="aset" data-k="match">
            <option value="partial" ${(a.match ?? "partial") === "partial" ? "selected" : ""}>partial</option>
            <option value="full" ${a.match === "full" ? "selected" : ""}>full</option>
            <option value="exact" ${a.match === "exact" ? "selected" : ""}>exact</option>
            <option value="prefix" ${a.match === "prefix" ? "selected" : ""}>prefix</option>
          </select></label>
        <label class="flab">read ⊆ text <input type="checkbox" class="aset" data-k="incl" ${a.included ? "checked" : ""} title="partial/prefix only: match if the read word is included in this text" /></label>
        <label class="flab">threshold <input type="number" class="aset" data-k="thr" step="0.05" min="0" max="1" value="${a.threshold ?? 0.8}" /></label>
        <label class="flab" title="hard floor: reads shorter than this never match (kills tiny-blob false hits)">min chars <input type="number" class="aset" data-k="minchars" step="1" min="0" value="${a.min_chars ?? 0}" /></label>
        <label class="flab" title="what to ignore before comparing">strip
          <select class="aset" data-k="strip">
            <option value="alnum" ${(a.strip ?? "alnum") === "alnum" ? "selected" : ""}>alnum</option>
            <option value="spaces" ${a.strip === "spaces" ? "selected" : ""}>spaces</option>
            <option value="none" ${a.strip === "none" ? "selected" : ""}>none</option>
          </select></label>
        <label class="flab">case sensitive <input type="checkbox" class="aset" data-k="case" ${a.case_sensitive ? "checked" : ""} title="off = fold case before comparing" /></label>
        <div class="detect-status muted">◯ —</div>
        <div class="gn-foot"></div>`,
    };
  }
  if (n.type === "item") {
    return { title: `<input class="gi gi-id" data-k="itemid" value="${esc(n.ref.id)}" title="item template" />`,
      body: `<div class="item-img"></div><div class="item-lists">${itemLists(n.ref, n.win)}</div>` };
  }
  if (n.type === "itemfield") return itemFieldParts(n);
  if (n.type === "itemtell") return itemTellParts(n);
  if (n.type === "scrollbar") {
    const o = n.ref.scrollbar_orientation || "vertical";
    return {
      title: "scrollbar",
      body: `<label class="flab">orientation <select class="sbset" data-k="orient">
          <option ${o === "vertical" ? "selected" : ""}>vertical</option>
          <option ${o === "horizontal" ? "selected" : ""}>horizontal</option></select></label>
        <div class="detect-status muted">position: —</div>
        <div class="gn-foot"></div>`,
    };
  }
  if (n.type === "preview") {
    // live-read node — what the current layout would read from this window. Runs OCR
    // on demand (its own button, or the image's 👁), rendered inline.
    return {
      title: `<span class="gi-id">${esc(n.ref.id)} preview</span>`,
      body: `<div class="nodehost scrollhost prev-host"><p class="muted" style="padding:8px">open the window image or edit it to preview what it reads</p></div>
        <div class="gn-foot"><button class="prevcommit" title="write these reads into the window's dataset (one revertable batch)">commit to dataset</button></div>`,
    };
  }
  if (n.type === "subset") return subsetParts(n.ref);
  if (n.type === "price") return priceParts(n.ref, model.priceSourceColumns(n.ref), model.priceJoinable(n.ref));
  if (n.type === "trigger") return triggerParts(n.ref, model);
  if (n.type === "dictionary") {
    // a named word list. Text reads snap to the closest entry (exact, then fuzzy). The
    // terms live in config/dictionaries/<source>; this node just references that file.
    const dict = n.ref;
    const count = (dict.terms || []).length;
    const src = dict.source || "—";
    const missing = !count && dict.source;   // a referenced file that resolved to nothing
    return {
      title: `<input class="gi gi-id dictname" value="${esc(dict.name || dict.id)}" title="dictionary name" />`,
      body: `<div class="muted">${count} word${count === 1 ? "" : "s"} · file <code>${esc(src)}</code>${missing ? ` <span class="warn">· file missing</span>` : ""}</div>
        <div class="nodehost scrollhost dict-host"><textarea class="dictterms" spellcheck="false" autocomplete="off" placeholder="one word per line\nNeo V11\nSoma Prime\n…">${esc((dict.terms || []).join("\n"))}</textarea></div>
        <div class="gn-foot"></div>`,
    };
  }
  // dataset — receives/stores rows, deduped by the keys the records arrive with.
  // The key itself is no concern of the dataset: it's taught on the item templates
  // (or windows) that read the records.
  const ds = n.ref;
  const noDedup = !model.datasetDedup(ds);
  const kf = model.datasetKeyField(ds);
  const keyOpts = ['<option value="">key: from windows</option>']
    .concat(model.datasetFields(ds).map((f) => `<option value="${esc(f)}"${!noDedup && kf === f ? " selected" : ""}>key: ${esc(f)}</option>`))
    .concat([`<option value="__nodedup__"${noDedup ? " selected" : ""}>no dedup (keep every read)</option>`]).join("");
  return {
    title: `<input class="gi gi-id dsrename" value="${esc(ds)}" title="dataset name" />`,
    body: `<div class="lab-grid"><label class="flab">1→many <select class="dskey" title="the key the dataset collapses many reads on (or none)">${keyOpts}</select></label></div>
      <div class="gn-foot"><button class="dssubset">+ view</button><button class="dsclone">clone</button><button class="dsclear danger">clear data</button></div>
      <div class="ds-tabs" role="tablist">
        <button class="ds-tab on" data-tab="data" role="tab">data <span class="ds-tab-n data-n"></span></button>
        <button class="ds-tab" data-tab="batches" role="tab" title="this dataset's collection/save runs">batches <span class="ds-tab-n bat-n"></span></button>
      </div>
      <div class="nodehost scrollhost data-host"><p class="muted" style="padding:8px">loading…</p></div>
      <div class="nodehost scrollhost bat-host">
        <ul class="history bat-list"><li class="muted">loading…</li></ul>
        <div class="bat-detail muted">select a batch to see its events and what applying it changes</div>
      </div>`,
    ports: `<span class="port out" title="drag to a view to feed it this dataset"></span>`,
  };
}

// how a key's many observations collapse to one displayed value (matches the backend)
const AGGREGATES = ["latest", "first", "sum", "mean", "max", "min"];

// Friendly timestamp for a dataset's last change: clock time if today, else date.
function fmtWhen(ts) {
  const t = String(ts);
  const today = new Date().toISOString().slice(0, 10);
  return t.slice(0, 10) === today ? t.slice(11, 16) : t.slice(0, 10);
}
// HH:MM:SS from an ISO timestamp — drops fractional seconds AND the timezone suffix (+00:00).
function clockTime(ts) { const m = /T(\d{2}:\d{2}:\d{2})/.exec(String(ts || "")); return m ? m[1] : ""; }

// ---- view node: join one or more datasets, then filter/derive/sort ----------

const SUB_OPS = ["contains", "icontains", "eq", "ne", "nonempty", "empty", "gt", "lt", "gte", "lte", "regex"];

function _colOpts(cols, sel) {
  return `<option value=""${sel ? "" : " selected"}>—</option>` +
    cols.map((c) => `<option${c === sel ? " selected" : ""}>${esc(c)}</option>`).join("");
}

// Last live column set a view's join actually returned (set by refreshSubsetNode). The static
// schema (model.subsetColumns) only knows columns declared on windows — orders/enrich columns
// and other dataset-fed fields aren't in it, so the config must also offer what the join shows.
const subsetLiveCols = new Map();

// Every column a view's config should list: static schema ∪ live result columns ∪ hidden
// columns. Hidden columns are STRIPPED from the live result by the backend, so without the
// last union they'd vanish from the toggle list and could never be turned back on.
function viewColumns(s) {
  const out = [];
  const add = (c) => { if (c && !out.includes(c)) out.push(c); };
  model.subsetColumns(s.id).forEach(add);
  (subsetLiveCols.get(s.id) || []).forEach(add);
  (s.hidden_columns || []).forEach(add);
  return out;
}

// Order the visible/hide toggles to MATCH the table: the vtable's live column order (which
// honours the user's column drag-reorder) first, then hidden columns (not in the table, so
// they have no table position), then any schema columns not yet seen — so the buttons read
// left-to-right exactly as the columns sit in the table.
function viewDisplayColumns(s) {
  const out = [];
  const add = (c) => { if (c && !out.includes(c)) out.push(c); };
  (vtables.get(`view:${s.id}`)?.columns || subsetLiveCols.get(s.id) || []).forEach(add);
  (s.hidden_columns || []).forEach(add);
  viewColumns(s).forEach(add);
  return out;
}

function hideTogglesHTML(s) {
  const hidden = new Set(s.hidden_columns || []);
  const toggles = viewDisplayColumns(s).map((c) => `<button class="sv-hide${hidden.has(c) ? " off" : ""}" data-col="${esc(c)}"
      title="${hidden.has(c) ? "show" : "hide"} column">${esc(c)}</button>`).join("");
  return toggles || '<span class="muted sub-empty">no columns yet</span>';
}

// Repaint + re-wire a view's visible/hide toggle row in place (no node rebuild).
function renderHideToggles(el, s) {
  const hides = el && el.querySelector(".sv-hides");
  if (hides) { hides.innerHTML = hideTogglesHTML(s); wireHideToggles(el, s); }
}

// Wire the visible/hide toggles. Standalone (not closed over wireSubset) so refreshSubsetNode
// can re-render + re-wire just this block when the live column set arrives/changes.
// Toggling does NOT rebuild the whole node (that wiped the vtable → "loading…" flash); it flips
// the button in place and re-fetches the subset, whose columns honour hidden_columns — the
// vtable then updates its columns in place and refreshSubsetNode repaints the toggles.
function wireHideToggles(host, s) {
  host.querySelectorAll(".sv-hide").forEach((b) => b.addEventListener("click", () => {
    model.toggleHiddenColumn(s.id, b.dataset.col);
    const nowHidden = (s.hidden_columns || []).includes(b.dataset.col);
    b.classList.toggle("off", nowHidden);                       // instant feedback, no node rebuild
    b.title = nowHidden ? "show column" : "hide column";
    autosave();
    refreshSubsetNode(s.id);
  }));
}

function subConfigHTML(s) {
  const cols = viewColumns(s);
  const inputs = model.subsetInputs(s);
  const free = model.joinableInputs(s);   // datasets + other views (cycle-free)
  // sources are removable pills; the "+ join source" select sits on the SAME row as them
  const chips = inputs.map((d) => `<span class="sv-input">${esc(d)}<button class="sv-rmin danger" data-ds="${esc(d)}" title="remove input">${TRASH}</button></span>`).join("");
  const addOpts = `<option value="">+ join source…</option>` + free.map((d) => `<option>${esc(d)}</option>`).join("");
  // join-on is a COLUMN dropdown, populated from the joined sources' columns once a source is
  // added (so you pick a real shared field, not a free-typed guess). Current value kept even
  // if not in the live column set yet.
  const jf = s.join_field || "name";
  const joinOpts = [...new Set([jf, ...cols])].map((c) => `<option${c === jf ? " selected" : ""}>${esc(c)}</option>`).join("");
  // join-on only matters when 2+ sources are combined; with a single source there's nothing
  // to join across, so hide the row entirely (the field still persists for when a source is added)
  const joinRow = inputs.length > 1
    ? `${labCell("join on", "shared field the sources are joined on")}<select class="sv-join">${joinOpts}</select>`
    : "";
  const aggOpts = AGGREGATES.map((a) => `<option${a === model.subsetAggregate(s.id) ? " selected" : ""}>${a}</option>`).join("");
  // the "many →" collapse only does anything when an INPUT dataset dedups (a no-dedup dataset
  // already serves one row per read) — show it only then.
  const showAgg = model.subsetInputs(s).some((inp) => !model.subsetDef(inp) && model.datasetDedup(inp));
  const aggRow = showAgg ? `${labCell("many →", "how each key's many observations collapse to one value")}<select class="sv-agg">${aggOpts}</select>` : "";
  const filters = (s.filters || []).map((f, i) => `<div class="sub-row" data-i="${i}">
      <select class="sf-field" data-i="${i}">${_colOpts(cols, f.field)}</select>
      <select class="sf-op" data-i="${i}">${SUB_OPS.map((o) => `<option${o === f.op ? " selected" : ""}>${o}</option>`).join("")}</select>
      <input class="sf-val" data-i="${i}" value="${esc(f.value || "")}" placeholder="value" />
      <button class="sf-del danger" data-i="${i}" title="remove filter">${TRASH}</button></div>`).join("");
  const derived = (s.derived || []).map((d, i) => `<div class="sub-row" data-i="${i}">
      <input class="sd-name" data-i="${i}" value="${esc(d.name || "")}" placeholder="new column" />
      <span class="muted">=</span>
      <input class="sd-tpl" data-i="${i}" value="${esc(d.template || "")}" placeholder="{=count*price_median} plat" />
      <button class="sd-del danger" data-i="${i}" title="remove column">${TRASH}</button></div>`).join("");
  // multi-column sort: primary row first, each a column + direction; applied before limit
  const sortRows = (s.sort || []).map((so, i) => `<div class="sub-row" data-i="${i}">
      <select class="ss-field" data-i="${i}">${_colOpts(cols, so.field)}</select>
      <select class="ss-dir" data-i="${i}"><option value="asc"${so.desc ? "" : " selected"}>asc</option><option value="desc"${so.desc ? " selected" : ""}>desc</option></select>
      <button class="ss-del danger" data-i="${i}" title="remove sort">${TRASH}</button></div>`).join("");
  return `
    <div class="sub-sec lab-grid">
      ${labCell("sources", "datasets or views, joined on a shared field", true)}<div class="sv-inputs">${chips}<span class="sv-input sv-add"><select class="sv-addin">${addOpts}</select></span></div>
      ${joinRow}
      ${labCell("limit", "cap the number of result rows (0 = no limit)")}<input type="number" class="sv-limit" min="0" step="1" value="${s.limit || 0}" placeholder="0" />
      ${aggRow}</div>
    <div class="sub-sec"><div class="sub-lbl">filters <span class="muted">(all must pass)</span></div>${filters}
      <button class="sub-addf">+ filter</button></div>
    <div class="sub-sec"><div class="sub-lbl">columns <span class="muted">({col} text · {=expr} math · mix freely)</span></div>${derived}
      <button class="sub-addd">+ column</button></div>
    <div class="sub-sec"><div class="sub-lbl">sort <span class="muted">(primary first; applied before limit)</span></div>${sortRows}
      <button class="sub-adds">+ sort</button></div>
    <div class="sub-sec"><div class="sub-lbl">visible <span class="muted">(click to hide/show)</span></div>
      <div class="sv-hides">${hideTogglesHTML(s)}</div></div>`;
}

function subsetParts(s) {
  const off = !!s.config_collapsed;   // persisted on the view def (rides the profile yaml)
  return {
    title: `<input class="gi gi-id subrename" value="${esc(s.id)}" title="view name" />`,
    head: `<button class="sub-cfg-tog gn-cog${off ? "" : " on"}" title="config" aria-label="toggle config">
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
          <path fill="currentColor" d="M9.405 1.05c-.413-1.4-2.397-1.4-2.81 0l-.1.34a1.464 1.464 0 0 1-2.105.872l-.31-.17c-1.283-.698-2.686.705-1.987 1.987l.169.311c.446.82.023 1.841-.872 2.105l-.34.1c-1.4.413-1.4 2.397 0 2.81l.34.1a1.464 1.464 0 0 1 .872 2.105l-.17.31c-.698 1.283.705 2.686 1.987 1.987l.311-.169a1.464 1.464 0 0 1 2.105.872l.1.34c.413 1.4 2.397 1.4 2.81 0l.1-.34a1.464 1.464 0 0 1 2.105-.872l.31.17c1.283.698 2.686-.705 1.987-1.987l-.169-.311a1.464 1.464 0 0 1 .872-2.105l.34-.1c1.4-.413 1.4-2.397 0-2.81l-.34-.1a1.464 1.464 0 0 1-.872-2.105l.17-.31c.698-1.283-.705-2.686-1.987-1.987l-.311.169a1.464 1.464 0 0 1-2.105-.872l-.1-.34zM8 10.93a2.929 2.929 0 1 1 0-5.86 2.929 2.929 0 0 1 0 5.858z"/>
        </svg></button>`,
    body: `<div class="sub-cfg${off ? " collapsed" : ""}">${subConfigHTML(s)}</div>
      <div class="nodehost scrollhost sub-host"><p class="muted" style="padding:8px">loading…</p></div>`,
    ports: `<span class="port out" title="drag to another view to feed it this view's rows"></span>`,
  };
}

// The sort/filter/join selects are built from the STATIC schema at render time — before the
// live join exposes its real columns. Repaint their options (preserving the current value)
// once the live column set changes, so every actual column is offered. Only touches the DOM
// when the set actually changed (event-driven, not a poll).
function repaintSubsetCols(el, s) {
  const cols = viewColumns(s);
  const sig = cols.join("|");
  if (el._colsig === sig) return;
  el._colsig = sig;
  for (const sel of el.querySelectorAll(".ss-field, .sf-field, .sv-join")) {
    const v = sel.value;
    sel.innerHTML = _colOpts(cols, v);
    sel.value = v;
  }
}

const _subInflight = new Set();
async function refreshSubsetNode(id) {
  const el = nodeEls.get(`sub:${id}`);
  const host = el && el.querySelector(".sub-host");
  if (!host) return;
  if (_subInflight.has(id)) return;   // its compute can be slow — never run two at once for one view
  _subInflight.add(id);
  try {
    const r = await api.getSubset(model.profile.name, id);
    const vt = vtableFor(`view:${id}`, host);
    const s = model.subsetDef(id);
    // dragging a column in the table re-orders the visible/hide buttons to match, live
    vt.onReorder = () => renderHideToggles(nodeEls.get(`sub:${id}`), s);
    // click a row to drill into the source rows that joined to produce it (one per input)
    vt.setData(r.columns || [], r.rows || [], { expander: (row) => expandSubsetRow(id, row) });
    // the live join may expose columns the static schema can't know (orders/enrich fields) —
    // cache them and re-render the visible/hide toggles so every actual column is listed.
    subsetLiveCols.set(id, r.columns || []);
    if (s) { renderHideToggles(el, s); repaintSubsetCols(el, s); }
  } catch (e) {
    // a just-added subset isn't on the backend until the profile saves (debounced) —
    // that's a transient 404, not an error; the post-save refresh fills it in.
    const msg = /\b404\b/.test(String(e.message || e)) ? "no data yet" : String(e.message || e);
    vtables.delete(`view:${id}`);
    host.innerHTML = `<p class="muted" style="padding:8px">${esc(msg)}</p>`;
  } finally { _subInflight.delete(id); }
}

function refreshAllSubsetNodes() {
  for (const s of model.profile.subsets || []) if (nodeEls.has(`sub:${s.id}`)) refreshSubsetNode(s.id);
}

// Refresh every view that READS from `ds` (directly or through an upstream view). Batch edits
// (revert / remove) change a dataset's contents WITHOUT appending a history event, so its ledger
// last_ts is unchanged and refreshLive's last_ts gate misses them — callers fixing a dataset's
// data must refresh its consumers explicitly.
function refreshDatasetConsumers(ds) {
  for (const s of model.profile.subsets || [])
    if (nodeEls.has(`sub:${s.id}`) && model.subsetReaches(s.id, ds)) refreshSubsetNode(s.id);
}

function wireSubset(div, s) {
  const recompute = () => { autosave(); refreshSubsetNode(s.id); };
  const restructure = () => { autosave(); rebuildNode(`sub:${s.id}`); };   // rebuild this node's config

  div.querySelector(".sub-cfg-tog")?.addEventListener("click", (e) => {
    const off = s.config_collapsed = !s.config_collapsed;
    div.querySelector(".sub-cfg")?.classList.toggle("collapsed", off);
    e.currentTarget.classList.toggle("on", !off);
    autosave();   // persist the fold state in the profile
  });
  div.querySelector(".subrename")?.addEventListener("change", (e) => {
    const oldId = s.id;
    if (model.renameSubset(oldId, e.target.value)) { movePos(`sub:${oldId}`, `sub:${s.id}`); render(); autosave(); }
    else e.target.value = oldId;
  });
  div.querySelector(".sub-addf")?.addEventListener("click", () => { model.addFilter(s.id); restructure(); });
  div.querySelector(".sub-addd")?.addEventListener("click", () => { model.addDerived(s.id); restructure(); });
  div.querySelector(".sub-adds")?.addEventListener("click", () => { model.addSort(s.id); restructure(); });

  // join inputs — adding/removing/swapping a source changes the wiring AND this config's own
  // source rows + join-on column list, so render() (edges) THEN restructure() (rebuild node)
  div.querySelector(".sv-addin")?.addEventListener("change", (e) => {
    if (model.addSubsetInput(s.id, e.target.value)) { render(); restructure(); }
  });
  div.querySelectorAll(".sv-rmin").forEach((b) => b.addEventListener("click", () => {
    model.removeSubsetInput(s.id, b.dataset.ds); render(); restructure();
  }));
  div.querySelector(".sv-join")?.addEventListener("change", (e) => { model.setJoinField(s.id, e.target.value.trim()); recompute(); });
  div.querySelector(".sv-agg")?.addEventListener("change", (e) => { model.setSubsetAggregate(s.id, e.target.value); recompute(); });
  div.querySelector(".sv-limit")?.addEventListener("change", (e) => { model.setSubsetLimit(s.id, e.target.value); e.target.value = s.limit || 0; recompute(); });

  // filters
  div.querySelectorAll(".sf-del").forEach((b) => b.addEventListener("click", () => { model.removeFilter(s.id, +b.dataset.i); restructure(); }));
  div.querySelectorAll(".sf-field").forEach((el) => el.addEventListener("change", (e) => { s.filters[+el.dataset.i].field = e.target.value; recompute(); }));
  div.querySelectorAll(".sf-op").forEach((el) => el.addEventListener("change", (e) => { s.filters[+el.dataset.i].op = e.target.value; recompute(); }));
  div.querySelectorAll(".sf-val").forEach((el) => el.addEventListener("change", (e) => { s.filters[+el.dataset.i].value = e.target.value; recompute(); }));

  // derived columns — editing a name changes the available column set, so restructure
  div.querySelectorAll(".sd-del").forEach((b) => b.addEventListener("click", () => { model.removeDerived(s.id, +b.dataset.i); restructure(); }));
  div.querySelectorAll(".sd-name").forEach((el) => el.addEventListener("change", (e) => { s.derived[+el.dataset.i].name = e.target.value.trim(); restructure(); }));
  div.querySelectorAll(".sd-tpl").forEach((el) => el.addEventListener("change", (e) => { s.derived[+el.dataset.i].template = e.target.value; recompute(); }));

  // sort — removing a row restructures (indices shift); field/dir just recompute
  div.querySelectorAll(".ss-del").forEach((b) => b.addEventListener("click", () => { model.removeSort(s.id, +b.dataset.i); restructure(); }));
  div.querySelectorAll(".ss-field").forEach((el) => el.addEventListener("change", (e) => { s.sort[+el.dataset.i].field = e.target.value; recompute(); }));
  div.querySelectorAll(".ss-dir").forEach((el) => el.addEventListener("change", (e) => { s.sort[+el.dataset.i].desc = e.target.value === "desc"; recompute(); }));

  // hide/show result columns — toggling changes the column set, so restructure
  wireHideToggles(div, s);
  // sort/limit removed — the table sorts itself (click a column header)

  queueMicrotask(() => refreshSubsetNode(s.id));
}

// ---- price producer node: sweeps the market into its output dataset ---------

function wirePrice(div, n) {
  // the producer panel (sweep config + controls, stored count). The out-port
  // (drag to a dataset) is wired generically by wireOutPort.
  // when a sweep ends (or is cancelled), refresh the dataset it feeds so its new batch shows
  wirePriceNode(div, model.profile.name, n.ref.dataset, n.ref.mode || "statistics", () => {
    refreshLive(); refreshDataNode(n.ref.dataset); loadBatchesNode(n.ref.dataset);
  }, hub.kick);   // sweep start/cancel -> beat the hub so the tasks panel refreshes now
  // source toggle: statistics (history) vs live orders (now). Mode swaps the body, so rebuild.
  div.querySelector(".enr-mode")?.addEventListener("change", (e) => {
    model.setPriceMode(n.ref.id, e.target.value); rebuildNode(n.id); autosave();
  });
  // which source column names the item to price (next sweep uses it — no rebuild)
  div.querySelector(".enr-keyfld-sel")?.addEventListener("change", (e) => {
    model.setPriceSourceField(n.ref.id, e.target.value); autosave();
  });
  // rename the price node (its id) — carry its saved layout slot to the new id, then re-render
  div.querySelector(".prrename")?.addEventListener("change", (e) => {
    const oldId = n.ref.id, newId = (e.target.value || "").trim();
    if (!model.renamePriceNode(oldId, newId)) { e.target.value = oldId; return; }
    movePos(`price:${oldId}`, `price:${newId}`); render(); autosave();
  });
  // add a priced-item source via the chip add-select (same input the subset uses)
  div.querySelector(".pr-addsrc")?.addEventListener("change", (e) => {
    if (e.target.value && model.addPriceSource(n.ref.id, e.target.value)) { rebuildNode(n.id); drawEdges(); autosave(); }
  });
  // unwire a priced-item source — rebuild the node so the chip goes too, and redraw the edge
  div.querySelectorAll(".pr-rmsrc").forEach((b) => b.addEventListener("click", () => {
    model.removePriceSource(n.ref.id, b.dataset.ds); rebuildNode(n.id); drawEdges(); autosave();
  }));
}

// ---- trigger node: fires price-node sweeps on a condition -------------------

function wireTrigger(div, n) {
  const t = n.ref;
  div.querySelector(".tgrename")?.addEventListener("change", (e) => {
    const oldId = t.id, newId = (e.target.value || "").trim();
    if (!model.renameTrigger(oldId, newId)) { e.target.value = oldId; return; }
    movePos(`trigger:${oldId}`, `trigger:${t.id}`); render(); autosave();
  });
  // kind swaps the body (interval/watch blocks) AND the edges, so rebuild this node then re-render
  div.querySelector(".tg-kind")?.addEventListener("change", (e) => {
    model.setTriggerKind(t.id, e.target.value); rebuildNode(n.id); render(); autosave();
  });
  div.querySelector(".tg-interval")?.addEventListener("change", (e) => { model.setTriggerInterval(t.id, e.target.value); autosave(); });
  // rebuildNode (not render) re-renders THIS node's chips — render() only builds NEW nodes,
  // so an in-place chip add/remove wouldn't show. drawEdges() drops/adds the trigger's edges
  // (watch source→trigger and trigger→price) so a chip change reflects on the canvas live.
  div.querySelector(".tg-addwatch")?.addEventListener("change", (e) => { if (model.addTriggerWatch(t.id, e.target.value)) { rebuildNode(t.id); drawEdges(); autosave(); } });
  div.querySelector(".tg-addfire")?.addEventListener("change", (e) => { if (model.addTriggerTarget(t.id, e.target.value)) { rebuildNode(t.id); drawEdges(); autosave(); } });
  div.querySelectorAll(".tg-rmwatch").forEach((b) => b.addEventListener("click", () => { model.removeTriggerWatch(t.id, b.dataset.ds); rebuildNode(t.id); drawEdges(); autosave(); }));
  div.querySelectorAll(".tg-rmtarget").forEach((b) => b.addEventListener("click", () => { model.removeTriggerTarget(t.id, b.dataset.p); rebuildNode(t.id); drawEdges(); autosave(); }));
  div.querySelector(".tg-fire")?.addEventListener("click", async () => {
    const prog = div.querySelector(".tg-prog");
    prog.textContent = "firing…";
    try { const r = await api.triggers.fire(model.profile.name, t.id); prog.textContent = `fired ${(r.started || []).length} sweep(s)`; refreshLive(); }
    catch (err) { prog.textContent = String(err.message || err); }
  });
}

export const CAN_DISABLE = new Set(["window", "item", "region", "detect", "scrollbar", "dictionary", "price", "trigger"]);
const REMOVABLE = new Set(["window", "item", "region", "detect", "scrollbar", "dictionary", "subset", "dataset", "price", "trigger"]);

// One place to remove any node; each goes through render()+autosave() so undo/redo
// records it (autosave -> pushHistory).
function removeNode(n) {
  if (n.type === "window") { closeImage(n.ref.id); model.removeWindow(n.ref.id); pos.delete(n.id); render(); autosave(); }
  else if (n.type === "item") {
    const winId = n.win.id, itemId = n.ref.id;
    closeItemImage(winId, itemId); model.removeItem(winId, itemId); pos.delete(n.id);
    clearGrid(winId); render(); refreshImageBoxes(winId); autosave();
  }
  else if (n.type === "region") { model.removeRegion(n.win.id, n.ref.id); render(); autosave(); refreshImageBoxes(n.win.id); }
  else if (n.type === "detect") { model.removeDetect(n.win.id, n.ref.id); render(); autosave(); refreshImageBoxes(n.win.id); }
  else if (n.type === "scrollbar") { model.removeScrollbar(n.win.id); render(); autosave(); refreshImageBoxes(n.win.id); }
  else if (n.type === "dictionary") { model.removeDictionary(n.ref.id); pos.delete(n.id); render(); autosave(); }
  else if (n.type === "subset") { model.removeSubset(n.ref.id); render(); autosave(); }
  else if (n.type === "price") { model.removePriceNode(n.ref.id); pos.delete(n.id); render(); autosave(); }
  else if (n.type === "trigger") { model.removeTrigger(n.ref.id); pos.delete(n.id); render(); autosave(); }
  else if (n.type === "dataset") { model.removeDatasetDef(n.ref); pos.delete(n.id); purgeDatasetData(n.ref); render(); autosave(); }
  groups.forgetNodes(new Set([n.id]));   // drop the gone node from any group
  setStatus(`deleted ${n.type} ${n.ref?.id ?? n.ref ?? ""}`.trimEnd());
}

// Purge a dataset's stored files so removing its node doesn't leave it re-spawning from
// disk on the next live refresh. A dataset node is standalone (not owned by anything) but
// is re-derived from any window still wired to it — such a node reappears (empty) until
// that window is rewired/removed.
async function purgeDatasetData(ds) {
  delete live[ds];
  try { await api.deleteDataset(model.profile.name, ds); }
  catch (e) { setStatus(`delete failed: ${e.message}`); return; }
  await refreshLive();   // re-reads the dataset list (the purged name is gone from disk)
}

// Two-click confirm on an icon button: 1st click arms it (icon -> "?"), 2nd confirms.
// Esc or a click anywhere else cancels. Listeners are torn down on confirm/cancel so a
// re-render (which rebuilds the button) doesn't leak them.
function wireConfirmRemove(btn, onConfirm) {
  let armed = false;
  const reset = () => {
    armed = false; btn.classList.remove("armed"); btn.title = "remove (click again to confirm)";
    document.removeEventListener("mousedown", onOutside, true);
    document.removeEventListener("keydown", onKey, true);
  };
  const onOutside = (e) => { if (!btn.contains(e.target)) reset(); };
  const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); reset(); } };
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (armed) { reset(); onConfirm(); return; }
    armed = true; btn.classList.add("armed"); btn.title = "click again to confirm remove";
    document.addEventListener("mousedown", onOutside, true);
    document.addEventListener("keydown", onKey, true);
  });
}

function fillNode(div, n, wire = true) {
  const isCollapsed = collapsed.has(n.id);
  const canToggle = CAN_DISABLE.has(n.type);
  const enabled = !(canToggle && n.ref && n.ref.enabled === false);
  // field nodes carrying fallback rules get a wider natural width (the rule row packs three
  // selects + a value + trash on one line) so a size RESET lands wide enough, not crushed.
  const hasRules = (n.type === "itemfield" || n.type === "region") && (n.field?.rules?.length || 0) > 0;
  const prettyDirty = prettyOverrides.isNodeDirty(n.id);
  div.className = `gnode ${n.type}${isCollapsed ? " collapsed" : ""}${enabled ? "" : " node-disabled"}${hasRules ? " has-rules" : ""}${prettyDirty ? " pretty-dirty" : ""}`;
  if (n.type === "dataset") { div.dataset.ds = n.ref; div.dataset.tab = dsTab.get(n.ref) || "data"; }
  const parts = nodeParts(n);
  const toggle = canToggle
    ? `<button type="button" class="gn-enable${enabled ? " on" : ""}" role="switch" aria-checked="${enabled}" title="enabled — turn off to skip this node during detection">
        <svg viewBox="0 0 28 16" width="28" height="16" aria-hidden="true">
          <rect class="gt-track" x="1" y="1" width="26" height="14" rx="7" />
          <circle class="gt-thumb" cx="8" cy="8" r="5" />
        </svg></button>`
    : "";
  const del = REMOVABLE.has(n.type) ? `<button class="gn-del" title="remove (click again to confirm)" aria-label="remove">
      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
        <path d="M3 4.5h10M6.4 4V2.8a.8.8 0 0 1 .8-.8h1.6a.8.8 0 0 1 .8.8V4M4.8 4.5l.5 8a1 1 0 0 0 1 .95h3.4a1 1 0 0 0 1-.95l.5-8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
      </svg></button>` : "";
  // unlock icon: detach this node from its group. Always present; shown only while the
  // node is in a group (.in-group on the node, set by refreshDetachIcons).
  const detach = `<button class="gn-detach" title="detach from group" aria-label="detach from group">
      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
        <path d="M5 7V4.5a3 3 0 0 1 5.9-.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        <rect x="3.2" y="7" width="9.6" height="6.5" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.5" />
      </svg></button>`;
  div.innerHTML = `<div class="gn-h ${parts.pulse || ""}">
      <span class="gn-disc" title="collapse/expand">${nodeIcon(n)}<button class="collapse" aria-label="collapse/expand">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
          <rect x="3.5" y="3.5" width="17" height="17" rx="5.5"/><line x1="8" y1="12" x2="16" y2="12"/><line class="cv" x1="12" y1="8" x2="12" y2="16"/>
        </svg></button></span>${detach}${parts.title}${parts.head || ""}${toggle}${del}<span class="gn-type" aria-hidden="true">${esc(n.type === "itemfield" ? "field" : n.type === "itemtell" ? "tell" : n.type)}</span><span class="gn-pretty-dirty" title="held by a pretty override — not saved to yaml">pretty</span></div>
    <div class="gn-body">${parts.body}</div>
    <span class="gn-spin" title="working…"></span>${parts.ports || ""}`;
  div.querySelector(".collapse").addEventListener("click", () => toggleCollapse(n.id));
  div.querySelector(".gn-detach").addEventListener("click", (e) => { e.stopPropagation(); groups.detachNode(n.id); });
  // a preview is bonded to its window — it has no detach button (it leaves only when the window does)
  div.classList.toggle("in-group", n.type !== "preview" && !!groups.groupOf(n.id));
  const delBtn = div.querySelector(".gn-del");
  if (delBtn) wireConfirmRemove(delBtn, () => removeNode(n));
  const tog = div.querySelector(".gn-enable");
  tog?.addEventListener("click", (e) => {
    e.stopPropagation();
    const on = tog.getAttribute("aria-checked") !== "true";   // flip current state
    tog.setAttribute("aria-checked", on);
    tog.classList.toggle("on", on);
    n.ref.enabled = on;
    div.classList.toggle("node-disabled", !on);
    const winId = n.type === "window" ? n.ref.id : n.win?.id;
    if (winId) { clearGrid(winId); refreshImageBoxes(winId); }
    autosave(on);   // disabling shouldn't trigger re-reads in other nodes
  });
  if (busy.get(n.id)) div.classList.add("busy");   // preserve spinner across rebuilds
  if (!wire) return;   // measurement probe: skip side-effecting wiring (openImage, out-port drag)
  wireNode(div, n);
  wireOutPort(div, n);   // any node with a `.port.out` drags to a dataset — one mechanism
}

// Drag a node's out-port to wire its data somewhere. ONE mechanism for every source type;
// each type contributes a `spec` describing what kind of node it drops onto (`target`),
// what committing the drop does (`onDrop(targetId)`), and what an empty-canvas drop mints
// (`onEmpty(worldPt) -> newNodeId`). Producers (window/price) feed a DATASET; datasets and
// views feed a VIEW (subset). `selfId` blocks dropping a node onto itself.
function outPortSpec(n) {
  switch (n.type) {
    case "window": return {
      target: "dataset",
      onDrop: (ds) => model.setDataset(n.ref.id, ds),
      onEmpty: (pt) => { const ds = model.addDataset(); placeAt(`ds:${ds}`, pt); model.setDataset(n.ref.id, ds); return `ds:${ds}`; },
    };
    case "price": return {
      target: "dataset",
      onDrop: (ds) => { model.setPriceDataset(n.ref.id, ds); rebuildNode(n.id); },
      onEmpty: (pt) => { const ds = model.addDataset(); placeAt(`ds:${ds}`, pt); model.setPriceDataset(n.ref.id, ds); rebuildNode(n.id); return `ds:${ds}`; },
    };
    case "dataset": return {
      // a dataset feeds a VIEW (join) or a PRICE node (price only these items)
      target: ["subset", "price"],
      onDrop: (id, ttype) => {
        if (ttype === "price") { if (model.addPriceSource(id, n.ref)) rebuildNode(`price:${id}`); }
        else if (model.addSubsetInput(id, n.ref)) refreshSubsetNode(id);
      },
      onEmpty: (pt) => { const id = model.addSubset(n.ref); placeAt(`sub:${id}`, pt); return `sub:${id}`; },
    };
    case "subset": return {
      // a view feeds another VIEW or a PRICE node (price only the rows it returns, e.g. count>0)
      target: ["subset", "price"],
      selfId: n.ref.id,
      onDrop: (id, ttype) => {
        if (ttype === "price") { if (model.addPriceSource(id, n.ref.id)) rebuildNode(`price:${id}`); }
        else if (model.addSubsetInput(id, n.ref.id)) refreshSubsetNode(id);
      },
      onEmpty: (pt) => { const id = model.addSubset(n.ref.id); placeAt(`sub:${id}`, pt); return `sub:${id}`; },
    };
    case "trigger": return {
      target: "price",
      onDrop: (pid) => { if (model.addTriggerTarget(n.ref.id, pid)) rebuildNode(n.id); },
    };
    default: return null;
  }
}

// The trigger's SECOND out-port (`.port.pwatch`, left face): drag to a dataset/view to make an
// on_change trigger watch it. Separate from the fires port so the two control lines never share a dot.
function watchPortSpec(n) {
  if (n.type !== "trigger" || n.ref.kind !== "on_change") return null;
  return {
    side: "L",
    target: ["dataset", "subset"],
    onDrop: (id) => { if (model.addTriggerWatch(n.ref.id, id)) rebuildNode(n.id); },
  };
}

function wireOutPort(div, n) {
  div._outId = n.id;
  const spec = outPortSpec(n);
  if (spec) { div._outSpec = spec; wirePortHandle(div.querySelector(".port.out"), n.id, spec); }   // reused by placePortDots
  const wspec = watchPortSpec(n);
  if (wspec) { div._watchSpec = wspec; wirePortHandle(div.querySelector(".port.pwatch"), n.id, wspec); }
}
function wirePortHandle(port, id, spec) {
  if (port) port.addEventListener("mousedown", (ev) => startWire(id, ev, spec));
}

// place a (new) node at a world-space point, grid-snapped
function placeAt(id, pt) { pos.set(id, { x: snap(pt.x), y: snap(pt.y) }); }

// the source id a drop target commits to: a dataset node's name, or a node's bare id
// (subset/price/trigger carry a prefixed node id in data-id).
function targetIdOf(el, target) {
  return target === "dataset" ? el.dataset.ds : (el.dataset.id || "").replace(/^(sub|price|trigger):/, "");
}

// Host node types that resize at the NODE level (their body fills them) — one consistent
// behaviour. Used by the initial build AND by rebuildNode to re-attach grips.
// Every node is freely resizable (width + height) EXCEPT item, which resizes width-only
// (its height follows the cutout aspect). item is special-cased in buildNode.

// Resize-handle opts shared by the initial build and every in-place rebuild. The grips live
// in the node's innerHTML, so a rebuildNode() (which rewrites innerHTML via fillNode) WIPES
// them — they must be re-added with these same opts or the node stops resizing.
function nodeResizeOpts(div, id) {
  return {
    both: true,
    zoom: () => view.zoom,
    // left-edge accessor: the node's world x lives in `pos` (canvas-zoomed) — lets the
    // shared bottom-left grip resize this node leftward with its right edge anchored
    left: (v) => { const p = pos.get(id); if (v === undefined) return p ? p.x : 0; if (p) { p.x = v; positionNode(id); } },
    onResize: () => { drawEdges(); groups.renderGroups(); },
    onSettle: () => { nodeSizes.set(id, { w: div.offsetWidth, h: div.offsetHeight }); div.classList.add("has-size"); drawEdges(); groups.renderGroups(); persist.layout(); },
    // reset dot: drop the user's size back to the node's natural CSS size (dot then hides)
    onReset: () => {
      nodeSizes.delete(id);
      div.classList.remove("has-size");
      div.style.width = ""; div.style.height = "";
      drawEdges(); groups.renderGroups(); persist.layout();
    },
  };
}

// Make a node's content host (`.nodehost`) user-resizable; the node itself stays a
// normal node (header/body identical to every other node — only the scroll box
// resizes). Restores + persists the host size, grid-snapped on release.
// Resize the NODE itself (its CSS resize handle), not an inner host — its body fills it.
function makeNodeResizable(div, id) {
  const s = nodeSizes.get(id);
  // a collapsed node is header-only (CSS) — never stamp its saved w/h inline, or the hard
  // inline size beats the collapsed CSS and the node renders full-height while "collapsed".
  if (s && !collapsed.has(id)) { if (s.w) div.style.width = `${s.w}px`; if (s.h) div.style.height = `${s.h}px`; }
  snapResize(div, nodeResizeOpts(div, id));
}

function buildNode(n, wire = true) {
  const div = document.createElement("div");
  div.id = `node-${n.id}`;
  div.dataset.id = n.id;
  fillNode(div, n, wire);
  // item + window nodes wrap a FIXED-ASPECT canvas (cutout / captured image): resize by
  // WIDTH only — height follows the image aspect (a free height would clip the canvas or
  // leave a gap). Both-axis node resize is wrong for them; the rest get it below.
  if (n.type === "item" || n.type === "window") snapResize(div, {
    onResize: () => { drawEdges(); groups.renderGroups(); }, zoom: () => view.zoom,
    left: (v) => { const p = pos.get(n.id); if (v === undefined) return p ? p.x : 0; if (p) { p.x = v; positionNode(n.id); } },
    onSettle: () => { persist.layout(); drawEdges(); groups.renderGroups(); },
  });
  // every other node resizes at the NODE level (its body fills it) — one consistent behaviour
  else makeNodeResizable(div, n.id);
  return div;
}

// Rebuild ONE node's DOM in place (used when its own layout changes, e.g. type).
function rebuildNode(id) {
  const el = nodeEls.get(id);
  const n = model.nodes().find((x) => x.id === id);
  if (!el || !n) return;
  // window nodes hold a live image canvas — rebuild only the controls, never the
  // whole node, so the canvas survives.
  if (n.type === "window") {
    const ctl = el.querySelector(".win-controls");
    if (ctl) { ctl.innerHTML = windowControls(n.ref); wireWindowControls(el, n); }
    return;
  }
  // item nodes hold a live cutout canvas — rebuild only the lists.
  if (n.type === "item") {
    const lists = el.querySelector(".item-lists");
    if (lists) { lists.innerHTML = itemLists(n.ref, n.win); wireItemControls(el, n); }
    return;
  }
  fillNode(el, n);
  // fillNode rewrote innerHTML, wiping the resize grips — re-add them. The ResizeObserver +
  // mouseup listeners from the initial snapResize stay bound to `el` (reused across rebuild);
  // only the grip DOM needs restoring, with grid snap (matching snapResize's `{...opts,snap:true}`).
  // (window + item already returned above; every remaining node type is freely resizable.)
  addResizeGrips(el, { ...nodeResizeOpts(el, n.id), snap: true });
  fitNodeHeight(el, n.id);   // a revealed input (e.g. learn -> fuzzy) may overflow the pinned height — grow to fit
}

// A node with a manually-pinned height keeps that height across a rebuild, so revealing
// extra inputs (a conditional row appearing) overflows its box. Grow the pinned height to
// enclose the content — grow-only (never shrinks a deliberately-tall node) — and persist it
// so the new size sticks and connectors/group boxes follow. No-op when not pinned or collapsed.
function fitNodeHeight(el, id) {
  if (collapsed.has(id) || !el.style.height) return;
  const body = el.querySelector(".gn-body");
  if (!body) return;
  const over = body.scrollHeight - body.clientHeight;
  if (over <= 1) return;
  const h = el.offsetHeight + over;
  el.style.height = `${h}px`;
  nodeSizes.set(id, { w: el.offsetWidth, h });
  drawEdges(); groups.renderGroups(); persist.layout();
}

function toggleCollapse(id) {
  const willCollapse = !collapsed.has(id);
  if (willCollapse) collapsed.add(id); else collapsed.delete(id);
  const el = nodeEls.get(id);
  if (el) {
    el.classList.toggle("collapsed", willCollapse);   // CSS rotates the +/- glyph off this class
    if (willCollapse) {                       // drop the hard inline w/h -> header only (CSS)
      el.style.width = ""; el.style.height = "";
    } else {                                  // expand: restore from the persisted size
      const s = nodeSizes.get(id);            // (survives reload; el._size would not)
      if (s) { if (s.w) el.style.width = `${s.w}px`; if (s.h) el.style.height = `${s.h}px`; }
    }
    el.classList.toggle("has-size", nodeSizes.has(id) && !willCollapse);   // reset dot hidden while collapsed
  }
  drawEdges();   // node size changed -> reroute its lines
  groups.renderGroups();
  persist.layout();
}

// Reconcile the node DOM with the model: add new, remove gone, reposition. Existing
// nodes keep their DOM (and input focus/values) — no wholesale rebuild.
function render() {
  ensurePositions();
  const layer = $("gnodes");
  const want = model.nodes();
  const wantIds = new Set(want.map((n) => n.id));
  for (const [id, el] of nodeEls) if (!wantIds.has(id)) { el.remove(); nodeEls.delete(id); }
  for (const n of want) {
    let el = nodeEls.get(n.id);
    if (!el) { el = buildNode(n); nodeEls.set(n.id, el); layer.appendChild(el); }
    positionNode(n.id);
  }
  drawEdges();
  resizeCanvas();
  applyView();
  openMissingItemCanvases();
  groups.renderGroups();
  refreshDetachIcons();
  syncMultiSelect();
  renderNodeViews();
}

// Item nodes always show their frozen cutout canvas; open any that aren't yet.
function openMissingItemCanvases() {
  for (const w of model.profile.windows || [])
    for (const it of w.items || [])
      if (it.cutout && !itemCanvases.has(`${w.id}:${it.id}`) && nodeEls.has(`item:${w.id}:${it.id}`))
        openItemImage(w.id, it.id);
}

function applyView() {
  $("gworld").style.transform = `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom})`;
  nmUpdateViewport();   // keep the node-map's viewport indicator in sync with pan/zoom
}

function resizeCanvas() {
  let maxX = 0, maxY = 0;
  for (const p of pos.values()) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  const w = maxX + 280, h = maxY + 200;
  for (const id of ["gworld", "gnodes"]) { const el = $(id); el.style.width = `${w}px`; el.style.height = `${h}px`; }
  for (const id of ["gedges", "gedges-top"]) { const svg = $(id); svg.setAttribute("width", w); svg.setAttribute("height", h); }
}

// ---- pan + zoom -----------------------------------------------------------

// Clear selections that live INSIDE node bodies (item-list rows, a batches node's
// picked batch) for every node that isn't `keepId` — so a node's inner selection
// doesn't linger after focus moves off it.
function clearNodeSelections(keepId = null) {
  for (const [nid, el] of nodeEls) {
    if (nid === keepId) continue;
    el.querySelectorAll(".il-sel").forEach((r) => r.classList.remove("il-sel"));
  }
  for (const ds of batchesState.keys()) {
    if (`ds:${ds}` === keepId) continue;
    const st = batchesState.get(ds);
    if (st.sel == null) continue;
    st.sel = null;
    const els = batEls(ds);
    if (els) {
      els.detail.innerHTML = "";
      els.list.querySelectorAll(".batrow.sel").forEach((li) => li.classList.remove("sel"));
    }
  }
}

function deselectAll() {
  for (const [, rec] of overlays) rec.overlay.setActive(null);   // every overlay, centrally
  document.querySelectorAll(".tool.active").forEach((b) => b.classList.remove("active"));   // drop any picked draw tool
  for (const [, el] of nodeEls) el.classList.remove("selected");
  clearNodeSelections();
  selectedNodeId = null;
  activeOverlayKey = null;
  clearMultiSelect();
  groups.clearGroupSelection();   // also drop any ctrl-selected groups
  drawEdges();
  nmSyncSelection();
}

// ---- multi-select (marquee / shift-click) ---------------------------------
// `selected` is the live set; the .multisel class shows it and the toolbar acts on it.

function setMultiSelect(ids) {
  selected.clear();
  for (const id of ids) if (nodeEls.has(id)) selected.add(id);
  syncMultiSelect();
}
function clearMultiSelect() { if (selected.size) { selected.clear(); syncMultiSelect(); } }
function syncMultiSelect() {
  for (const [id, el] of nodeEls) el.classList.toggle("multisel", selected.has(id));
  const bar = $("seltoolbar"), cnt = $("selCount"), gbtn = $("selGroupBtn");
  const ng = groups.selectedGroupIds().length;   // ctrl-selected GROUPS (for super-grouping)
  if (bar) bar.hidden = !(selected.size >= 2 || ng >= 1);
  if (cnt) cnt.textContent = ng >= 1 ? `${ng} group${ng === 1 ? "" : "s"} selected` : `${selected.size} selected`;
  // the button label mirrors what `g` would actually DO to this selection (group vs ungroup)
  if (gbtn) { const s = groupBtnState(); gbtn.textContent = s.label; gbtn.title = s.title; }
}

// Predict the group action's label/title so the toolbar button shows group vs ungroup up
// front — mirrors the branches in superGroupShortcut()/groupShortcut() exactly.
function groupBtnState() {
  const gids = groups.selectedGroupIds();
  if (gids.length) {   // ctrl-selected GROUPS -> super-group ops
    let ungroup;
    if (gids.length === 1) ungroup = !!groups.superGroupOf(gids[0]);   // lone group in a super -> detach
    else {
      const sset = new Set(gids.map((id) => groups.superGroupOf(id)).filter(Boolean));
      const loose = gids.some((id) => !groups.superGroupOf(id));
      ungroup = sset.size === 1 && !loose;   // all in ONE super, none loose -> dissolve
    }
    return ungroup
      ? { label: "⬚ ungroup", title: "dissolve the super group (hotkey: g)" }
      : { label: "⬚ super-group", title: "super-group the selected groups (hotkey: g)" };
  }
  const ids = selectionIds();
  const gset = new Set(ids.map((id) => groups.groupOf(id)).filter(Boolean));   // distinct groups in selection
  const ungrouped = ids.some((id) => !groups.groupOf(id));
  const ungroup = ids.length >= 2 && gset.size === 1 && !ungrouped;   // all share ONE group, none loose -> ungroup
  return ungroup
    ? { label: "⬚ ungroup", title: "ungroup the selection (hotkey: g)" }
    : { label: "⬚ group", title: "group the selection (hotkey: g)" };
}

// Show the unlock icon only on nodes that currently belong to a group.
function refreshDetachIcons() {
  for (const [id, el] of nodeEls) el.classList.toggle("in-group", nodeTypeOf(id) !== "preview" && !!groups.groupOf(id));
}

let suppressNextMenu = false;   // set when a right-drag pan actually moved
function startPan(ev) {
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

function updateOverlayZoom() {
  for (const [, rec] of overlays) rec.overlay.setWorldZoom(view.zoom);   // every overlay (window + item)
}

// Is the cursor over an element whose content actually overflows and can scroll? Walk up to
// the canvas; the wheel belongs to that element (native scroll), not to the canvas zoom.
function scrollableUnder(target) {
  for (let n = target; n && n.id !== "graph" && !n.classList?.contains("graphcanvas"); n = n.parentElement) {
    if (n.classList?.contains("scrollhost")) return true;
    const oy = getComputedStyle(n).overflowY;
    if ((oy === "auto" || oy === "scroll") && n.scrollHeight > n.clientHeight + 1) return true;
  }
  return false;
}

function onWheel(ev) {
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


// Double-click a node: fit it tight to the viewport and centre it (smooth, shared with
// the node-map jump so both frame a node the same way).
function zoomToNode(id) { panZoomTo(id, { fit: true }); }


// ---- per-node interaction -------------------------------------------------

function wireNode(div, n) {
  // drag-move from the node header / frame, NOT the body — so interacting with body content
  // (selects, chips, tables) never drags the node. The header + outer padding stay grab zones.
  div.addEventListener("mousedown", (ev) => {
    if (ev.button !== 0) return;   // only left-drag moves; right-drag pans the canvas
    // the collapse caret and the title input double as drag HANDLES: a real drag moves
    // the node, a plain click still toggles / edits (threshold-gated below).
    const handle = ev.target.closest(".collapse, input.gi-id");
    // node CONTENT (body, form fields, scroll areas, resize handle): NOT a drag zone. But a
    // click here STILL selects the node — without preventDefault, so inputs keep native
    // focus/caret/ctrl+A and buttons keep their own clicks.
    const onContent = !handle && ev.target.closest(".gn-body,input,select,button,a,.canvas-wrap,[contenteditable],.scrollhost");
    if (onContent) {
      if (!selected.has(n.id)) { clearMultiSelect(); focusNode(n.id); }   // select, never drag
      return;
    }
    // ctrl/cmd-click on the header/frame toggles this node in/out of the multi-selection
    if (ev.ctrlKey || ev.metaKey) {
      ev.preventDefault();
      if (selected.has(n.id)) selected.delete(n.id); else selected.add(n.id);
      syncMultiSelect();
      return;
    }
    const r = div.getBoundingClientRect();   // skip the CSS resize-handle corner (resizable nodes)
    if (ev.clientX > r.right - 18 && ev.clientY > r.bottom - 18) { focusNode(n.id); return; }
    // grabbing a node OUTSIDE the current multi-selection drops it (fresh single focus);
    // grabbing one INSIDE keeps the set so the drag moves the whole selection.
    if (!selected.has(n.id)) clearMultiSelect();
    focusNode(n.id);   // select on click / drag start (every node is focusable)
    if (handle) dragFromHandle(n.id, ev, div, handle);   // drag past threshold, else click
    else startMove(n.id, ev);
  });

  // double-click anywhere non-interactive on the node: fit + centre it
  div.addEventListener("dblclick", (ev) => {
    if (ev.target.closest("input,select,button,textarea,a,.port,.collapse")) return;
    ev.preventDefault();
    zoomToNode(n.id);
  });

  if (n.type === "game") {
    div.querySelectorAll(".gi").forEach((inp) => inp.addEventListener("change", (e) => {
      const k = e.target.dataset.k, v = e.target.value;
      if (k === "name") model.profile.name = v.trim();
      else if (k === "proc") model.profile.process_names = v.split(",").map((s) => s.trim()).filter(Boolean);
      else if (k === "title") model.profile.window_title_hint = v.trim() || null;
      autosave();
    }));
    // node creation moved to the floating "create" toolbox (see buildToolbox)
  } else if (n.type === "dictionary") {
    // the title doubles as both name and id (renamed in place)
    div.querySelector(".dictname")?.addEventListener("change", (e) => {
      const oldId = n.ref.id;
      const newName = e.target.value.trim() || oldId;
      n.ref.name = newName;
      const newId = newName.replace(/[^A-Za-z0-9._-]+/g, "_");
      if (newId !== oldId && model.renameDictionary(oldId, newId)) movePos(`dict:${oldId}`, `dict:${newId}`);
      render(); autosave();
    });
    div.querySelector(".dictterms")?.addEventListener("change", (e) => {
      n.ref.terms = e.target.value.split("\n").map((s) => s.trim()).filter(Boolean);
      rebuildNode(n.id); autosave();   // refresh the word count
    });
  } else if (n.type === "window") {
    wireWindowControls(div, n);   // out-port wiring is handled generically in wireOutPort
    openImage(n.ref.id, div);     // pass div: this runs during buildNode, before nodeEls has the node
  } else if (n.type === "preview") {
    // auto-reads on image change + any window edit; the one button commits the read to the dataset
    div.querySelector(".prevcommit")?.addEventListener("click", (e) => commitPreviewNode(n.ref.id, e.currentTarget));
  } else if (n.type === "dataset") {
    div.querySelector(".dsrename")?.addEventListener("change", async (e) => {
      const oldId = n.ref, newId = (e.target.value || "").trim();
      if (!model.renameDataset(oldId, newId)) { e.target.value = oldId; return; }
      movePos(`ds:${oldId}`, `ds:${newId}`);
      render();   // migrate the live DOM node to the new id NOW (its drag wiring binds the new
                  // id) — refreshLive below skips render when the dataset SET is unchanged, which
                  // it is after an in-place rename, so the node would otherwise keep the old id
      autosave();
      // CRITICAL: commit the renamed profile to disk BEFORE the server rename + refreshLive.
      // autosave() is debounced, so without this flush /api/flow reads the STALE profile that
      // still declares oldId -> noteDatasets re-adds it to _extraDatasets -> a ghost dataset
      // node spawns. (This is the recurring "rename spawns a duplicate" bug.)
      await persist.flush();
      try {
        await api.renameDataset(model.profile.name, oldId, newId);   // carry the stored data over
      } catch (err) {
        model.renameDataset(newId, oldId);   // roll back the profile rename; data didn't move
        movePos(`ds:${newId}`, `ds:${oldId}`);
        e.target.value = oldId; setStatus(String(err.message || err)); autosave();
        await persist.flush();   // commit the rollback too, so refreshLive doesn't resurrect newId
        render(); return;
      }
      await refreshLive();   // re-reads the dataset list (now under the new name) and re-renders
    });
    div.querySelector(".dsclone")?.addEventListener("click", () => { model.cloneDataset(n.ref); render(); autosave(); });
    div.querySelector(".dssubset")?.addEventListener("click", async () => {
      const id = model.addSubset(n.ref);
      if (id) {
        await placeNewNode(`sub:${id}`, "subset", `ds:${n.ref}`); render();
        inheritGroupFrom(`sub:${id}`, `ds:${n.ref}`); groups.renderGroups();
        autosave(); panTo(`sub:${id}`);
      }
    });
    div.querySelector(".dskey")?.addEventListener("change", async (e) => {
      const v = e.target.value;
      if (v === "__nodedup__") model.setDatasetDedup(n.ref, false);
      else model.setDatasetKeyField(n.ref, v);
      autosave();
      await persist.flush();   // re-key on disk before re-reading
      refreshDataNode(n.ref); refreshAllSubsetNodes();
    });
    const clearBtn = div.querySelector(".dsclear");
    clearBtn?.addEventListener("click", async () => {
      if (clearBtn.dataset.armed !== "1") {   // inline confirm (no blocking dialogs)
        clearBtn.dataset.armed = "1"; clearBtn.textContent = "confirm?";
        setTimeout(() => { clearBtn.dataset.armed = "0"; clearBtn.textContent = "clear data"; }, 2500);
        return;
      }
      clearBtn.dataset.armed = "0"; clearBtn.textContent = "clear data";
      try { await withBusy([n.id], () => api.clearDataset(model.profile.name, n.ref)); refreshLive(); refreshDataNode(n.ref); refreshAllBatchesNodes(); refreshAllSubsetNodes(); setStatus(`cleared ${n.ref}`); }
      catch (e) { setStatus(String(e.message || e)); }
    });
    // data | history tabs: swap the visible host; the ledger loads lazily on first open
    div.querySelectorAll(".ds-tab").forEach((tab) => tab.addEventListener("click", () => {
      const which = tab.dataset.tab;
      dsTab.set(n.ref, which);
      div.dataset.tab = which;
      div.querySelectorAll(".ds-tab").forEach((t) => t.classList.toggle("on", t === tab));
      if (which === "batches") loadBatchesNode(n.ref);   // (re)fetch the ledger when shown
    }));
    queueMicrotask(() => {
      refreshDataNode(n.ref);                              // load records into the data tab
      loadBatchesNode(n.ref);                              // load batches now so the count + list are ready before the tab is opened
    });
  } else if (n.type === "subset") {
    wireSubset(div, n.ref);
  } else if (n.type === "price") {
    wirePrice(div, n);
  } else if (n.type === "trigger") {
    wireTrigger(div, n);
  } else if (n.type === "region") {
    const fld = n.field;
    div.addEventListener("click", (ev) => {
      if (ev.target.closest("input,select,button")) return;
      selectWindowBox(n.win.id, n.ref.id);   // highlight this region's box on the image
    });
    div.querySelector(".gi-id").addEventListener("change", (e) => {
      const oldId = n.ref.id, newId = e.target.value.trim();
      if (!model.renameRegion(n.win.id, oldId, newId)) { e.target.value = oldId; return; }
      movePos(`reg:${n.win.id}:${oldId}`, `reg:${n.win.id}:${n.ref.id}`);
      render(); autosave(); refreshImageBoxes(n.win.id);
    });
    div.querySelectorAll(".fset").forEach((inp) => inp.addEventListener("change", (e) => {
      if (!fld) return;
      const k = e.target.dataset.k;
      if (k === "type") { fld.type = e.target.value; rebuildNode(n.id); }  // toggles extract/sep/dict/min-max
      else if (k === "extract") { fld.extract = e.target.value; rebuildNode(n.id); }  // toggles sep
      else if (k === "sep") fld.separator = e.target.value || "/";
      else if (k === "learn") { fld.learn = e.target.checked; rebuildNode(n.id); }  // toggles fuzzy
      else if (k === "fuzzy") fld.fuzzy = +e.target.value;
      else if (k === "isolate") fld.isolate = e.target.checked;
      else if (k === "minconf") fld.min_confidence = +e.target.value || 0;
      else if (k === "min") fld.min = e.target.value === "" ? null : +e.target.value;
      else if (k === "max") fld.max = e.target.value === "" ? null : +e.target.value;
      else if (k === "dictmode") { fld.dict_mode = e.target.value; rebuildNode(n.id); }  // toggles use-dict/fuzzy
      else if (k === "usedict") { fld.dictionary = e.target.value || ""; render(); }   // redraw the muted dict link
      autosave(true, n.win?.id);   // plain value edits: no DOM rebuild; re-OCR only this window
    }));
    if (fld) wireFieldRules(div, fld, {
      rebuild: () => { rebuildNode(n.id); autosave(true, n.win?.id); },
      commit: () => autosave(true, n.win?.id),
    });
  } else if (n.type === "detect") {
    div.addEventListener("click", (ev) => {
      if (ev.target.closest("input,select,button")) return;
      selectWindowBox(n.win.id, n.ref.id);
    });
    div.querySelector(".gi-id").addEventListener("change", (e) => {
      const oldId = n.ref.id, newId = e.target.value.trim();
      if (!model.renameDetect(n.win.id, oldId, newId)) { e.target.value = oldId; return; }
      movePos(`det:${n.win.id}:${oldId}`, `det:${n.win.id}:${n.ref.id}`);
      render(); autosave(); refreshImageBoxes(n.win.id);
    });
    div.querySelectorAll(".aset").forEach((inp) => inp.addEventListener("change", (e) => {
      const k = e.target.dataset.k;
      if (k === "text") n.ref.text = e.target.value;
      else if (k === "thr") n.ref.threshold = +e.target.value;
      else if (k === "incl") n.ref.included = e.target.checked;
      else if (k === "match") n.ref.match = e.target.value;
      else if (k === "minchars") n.ref.min_chars = Math.max(0, Math.trunc(+e.target.value) || 0);
      else if (k === "strip") n.ref.strip = e.target.value;
      else if (k === "case") n.ref.case_sensitive = e.target.checked;
      autosave(); refreshOpenDetect();
    }));
  } else if (n.type === "scrollbar") {
    div.addEventListener("click", (ev) => {
      if (ev.target.closest("input,select,button")) return;
      selectWindowBox(n.win.id, "scrollbar");
    });
    div.querySelectorAll(".sbset").forEach((inp) => inp.addEventListener("change", (e) => {
      if (e.target.dataset.k === "orient") model.setScrollbarOrientation(n.win.id, e.target.value);
      autosave();
    }));
  } else if (n.type === "item") {
    wireItemControls(div, n);
  } else if (n.type === "itemfield") {
    wireItemField(div, n);
  } else if (n.type === "itemtell") {
    wireItemTell(div, n);
  }
}

// Focus ANY node (click or drag). Drops box selection so WASD targets the node,
// highlights it + its lines. Box-backed nodes (region/detect/scrollbar) then re-select
// their box on the trailing click, so WASD keeps nudging the box for those.
function focusNode(id) {
  for (const [, rec] of overlays) rec.overlay.setActive(null);
  activeOverlayKey = null;
  // drop any picked draw tool on OTHER nodes — focusing elsewhere deselects their tools
  const keep = nodeEls.get(id);
  document.querySelectorAll(".tool.active").forEach((b) => { if (!keep || !keep.contains(b)) b.classList.remove("active"); });
  selectedNodeId = id;
  clearNodeSelections(id);   // drop any other node's inner selection
  for (const [nid, el] of nodeEls) el.classList.toggle("selected", nid === id);
  drawEdges();
  nmSyncSelection();   // mirror the selection in the node map
}

// ---- dragging -------------------------------------------------------------
// GRID, snap, addResizeGrips, beginDrag and makeDraggable are imported from dragresize.js
// — the same primitives the floating panels use.

// Node-resize coalescing state (used by snapResize's ResizeObserver). A ResizeObserver
// tick is only a real user resize when the pointer is down — track that globally.
let _resizing = false;       // a node is being resized — draw cheap straight lines, no A*/bezier
let _resizeRaf = null;       // coalesces resize-driven redraws to one per frame
let _ptrDown = false;        // is a mouse button held?
if (typeof window !== "undefined") {
  window.addEventListener("mousedown", () => { _ptrDown = true; }, true);
  window.addEventListener("mouseup", () => { _ptrDown = false; }, true);
}

// Snap a resizable element to the grid — but only when the drag is RELEASED, not while
// resizing (snapping mid-drag fights the smooth native resize). The observer just flags
// that a resize happened and runs ``onResize`` live (e.g. redraw edges); the snap fires
// on mouseup. Idempotent, so it never loops.
function snapResize(el, opts = {}) {
  const { both = false, onResize = null, onSettle = null } = opts;
  if (typeof ResizeObserver === "undefined") return;
  let dirty = false;
  // Step the size to the grid LIVE so the node never shows smooth in-between sizes.
  // Guarded (only writes when it actually changes) so it doesn't loop the observer.
  const liveSnap = () => {
    const w = snap(el.offsetWidth);
    if (Math.abs(w - el.offsetWidth) >= 1) el.style.width = `${w}px`;
    if (both) { const h = snap(el.offsetHeight); if (Math.abs(h - el.offsetHeight) >= 1) el.style.height = `${h}px`; }
  };
  new ResizeObserver(() => {
    if (el.classList && el.classList.contains("collapsed")) return;   // ignore the collapsed size
    dirty = true;
    if (_ptrDown) { _resizing = true; liveSnap(); }   // user drag → live grid-snap + cheap lines
    // one redraw per frame, not per resize event — kills the per-pixel edge-redraw lag
    if (!_resizeRaf) _resizeRaf = requestAnimationFrame(() => { _resizeRaf = null; onResize && onResize(); });
  }).observe(el);
  const finish = () => {
    if (!dirty) return;
    dirty = false; _resizing = false;
    if (_resizeRaf) { cancelAnimationFrame(_resizeRaf); _resizeRaf = null; }
    liveSnap();
    onSettle && onSettle();    // persists size + a final routed (non-straight) redraw
  };
  el.addEventListener("mouseup", finish);     // release on the element's resize handle
  window.addEventListener("mouseup", finish);  // …or release after the cursor left it
  addResizeGrips(el, { ...opts, snap: true }); // custom grips on BOTH bottom corners, grid-stepped
}

// Every node reachable by following edges OUT of `id` (its downstream subtree).
// Used for shift-drag. preview/data/batches are real nodes on edges, so they're
// included automatically.
function descendantsOf(id) {
  const out = new Set();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop();
    for (const e of model.edges()) {
      if (e.from === cur && !out.has(e.to)) { out.add(e.to); stack.push(e.to); }
    }
  }
  out.delete(id);
  return [...out];
}

function startMove(id, ev) {
  // Which other nodes ride along with the lead:
  //   • part of a multi-selection -> the whole selection
  //   • else Shift -> the subtree flowing out of this node
  let extra;
  if (selected.size > 1 && selected.has(id)) extra = [...selected].filter((x) => x !== id);
  else if (ev.shiftKey) extra = descendantsOf(id);
  else extra = [];
  moveNodes(id, extra, ev);
}

// Drag `id` (the lead, follows the cursor) plus every node in `extra` by the same world
// delta. Used by single drag, shift-subtree drag, multi-select drag, and group-title drag.
function moveNodes(id, extra, ev) {
  const p = pos.get(id);
  if (!p) return;
  const group = extra.map((gid) => ({ gid, gp: pos.get(gid) })).filter((g) => g.gp && g.gid !== id);
  const starts = group.map((g) => ({ ...g, sx: g.gp.x, sy: g.gp.y }));
  const start = { px: p.x, py: p.y };
  // Track the cursor in WORLD space off the LIVE pan/zoom every move — so a pan happening
  // at the same time as the drag shifts the world consistently and the node follows the
  // cursor instead of drifting the wrong way (the old screen-delta math ignored the pan).
  const rect = $("graph").getBoundingClientRect();
  const toWorld = (e) => ({ x: (e.clientX - rect.left - view.panX) / view.zoom, y: (e.clientY - rect.top - view.panY) / view.zoom });
  const g0 = toWorld(ev);
  setDraggingNodes(true);   // route synchronously each frame so lines track the node smoothly
  // shared drag loop (dragresize.js) — onMove does the world-space + grid-snap work
  beginDrag(ev, {
    onMove: (e) => {
      const w = toWorld(e);
      const dx = w.x - g0.x, dy = w.y - g0.y;
      p.x = snap(start.px + dx);
      p.y = snap(start.py + dy);
      positionNode(id);
      for (const g of starts) { g.gp.x = snap(g.sx + dx); g.gp.y = snap(g.sy + dy); positionNode(g.gid); }
      requestEdges();   // one edge redraw per frame, coalescing this move with others
      groups.renderGroups();   // group boxes hug their members live
    },
    onSettle: () => {
      setDraggingNodes(false);
      flushEdges();   // paint the final positions now, dropping any pending coalesced frame
      groups.absorb([id, ...extra.filter((x) => x !== id)]);   // dropped inside a group box -> join it
      resizeCanvas(); groups.renderGroups(); persist.layout(); renderNodeViews();
    },
  });
}
// Drag a node by a control that ALSO has a click action (collapse caret, title input):
// only begin moving once the cursor passes a small threshold; a plain click (no move)
// falls through to the control's own handler (toggle / focus-to-rename).
function dragFromHandle(id, ev, div, handle) {
  // shared drag loop with a 4px gate; once crossed, hand off to the real node-move loop
  const stop = beginDrag(ev, {
    threshold: 4,
    onStart: () => {
      stop();   // drop this gate loop; startMove begins its own drag loop from the same ev
      if (handle.tagName === "INPUT") { handle.blur(); window.getSelection()?.removeAllRanges(); }
      // a drag must NOT also fire the control's click (collapse toggle / input focus). The
      // trailing click fires synchronously on mouseup — catch it, then drop the guard on the
      // next tick so a later genuine click isn't eaten.
      const suppress = (ce) => { ce.stopPropagation(); ce.preventDefault(); };
      div.addEventListener("click", suppress, true);
      setTimeout(() => div.removeEventListener("click", suppress, true), 0);
      startMove(id, ev);
    },
  });
}
function positionNode(id) { const el = nodeEls.get(id); const p = pos.get(id); if (el && p) { el.style.left = `${p.x}px`; el.style.top = `${p.y}px`; el.classList.toggle("has-size", nodeSizes.has(id) && !collapsed.has(id)); } }

// Drag a wire out of a node's `.port.out`. Drop on a dataset node to wire to it, or on
// empty canvas to mint a fresh dataset there and wire to that. ``srcId`` is the source
// node id (win:… / price:…); ``onDrop(ds)`` commits the chosen target dataset.
export function startWire(srcId, ev, spec) {
  ev.preventDefault();
  ev.stopPropagation();
  const rect = $("graph").getBoundingClientRect();
  const p = pos.get(srcId);
  if (!p) return;
  const toWorld = (e) => ({ x: (e.clientX - rect.left - view.panX) / view.zoom, y: (e.clientY - rect.top - view.panY) / view.zoom });
  // Anchor the preview line at the REAL out-port dot, not an empty point. The clicked handle's
  // rendered centre is where the routed line will leave from (the dot may be fanned off the face
  // centre), so read it directly; fall back to the face's vertical centre if the rect is missing.
  const portEl = ev.currentTarget;
  const pr = portEl && portEl.getBoundingClientRect && portEl.getBoundingClientRect();
  const start = pr && pr.width
    ? toWorld({ clientX: pr.left + pr.width / 2, clientY: pr.top + pr.height / 2 })
    : { x: p.x + (spec.side === "L" ? 0 : nw(srcId)), y: p.y + nh(srcId) / 2 };
  wire = { x1: start.x, y1: start.y, x2: start.x, y2: start.y };
  // a spec may accept ONE target type ("subset") or SEVERAL (["subset","price"]) — match any.
  const targets = Array.isArray(spec.target) ? spec.target : [spec.target];
  const sel = targets.map((t) => `.gnode.${t}`).join(",");
  const onMove = (e) => { const w = toWorld(e); wire.x2 = w.x; wire.y2 = w.y; drawEdges(); };
  const onUp = (e) => {
    document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp);
    const overNode = document.elementFromPoint(e.clientX, e.clientY)?.closest(".gnode");
    const target = overNode && overNode.matches(sel) ? overNode : null;
    const dragged = Math.hypot(e.clientX - ev.clientX, e.clientY - ev.clientY) > 6;
    wire = null;   // drop the temp drag line on EVERY path before any redraw (else it ghosts)
    if (target) {
      const ttype = targets.find((t) => target.matches(`.gnode.${t}`));
      const tid = targetIdOf(target, ttype);
      if (tid != null && tid !== spec.selfId) { spec.onDrop(tid, ttype); render(); autosave(); return; }
    } else if (dragged && !overNode && spec.onEmpty) {   // empty canvas (not over another node) -> mint a node
      const newId = spec.onEmpty(toWorld(e));
      render(); autosave(); if (newId) panTo(newId);
      return;
    }
    render();
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

// ---- live + toolbar -------------------------------------------------------

async function refreshLive() {
  if (!model.profile.name) return;
  try {
    const r = await fetch(`/api/flow/${encodeURIComponent(model.profile.name)}`);
    if (!r.ok) return;
    const data = await r.json();
    const map = {};
    for (const d of data.datasets) map[d.dataset] = d;
    for (const k in map) { if (live[k]) { prevPresent[k] = live[k].present; prevLastTs[k] = live[k].last_ts; } }
    live = map;
    // Only re-render the whole graph if the set of datasets changed; otherwise
    // just update the existing dataset nodes' counts in place (no churn/flicker).
    const before = new Set(model.datasets());
    model.noteDatasets(data.datasets.map((d) => d.dataset));
    const after = model.datasets();
    if (after.length !== before.size || after.some((d) => !before.has(d))) render();
    else updateDatasetNodes();
    // the data + batches + subset nodes re-read when the dataset's LEDGER changed — keyed on
    // last_ts (every add/update/remove writes a history event), not present count alone: an
    // update batch grows the ledger without changing present, so the batches badge would
    // otherwise stay stale until the tab was clicked.
    for (const ds in map) {
      if (prevLastTs[ds] === undefined || prevLastTs[ds] === map[ds].last_ts) continue;
      if (nodeEls.has(`ds:${ds}`)) refreshDatasetNode(ds);   // one fetch -> data tab + batches tab
      // refresh every view that reads this dataset — directly OR through an upstream view
      for (const s of model.profile.subsets || [])
        if (nodeEls.has(`sub:${s.id}`) && model.subsetReaches(s.id, ds)) refreshSubsetNode(s.id);
    }
  } catch { /* ignore */ }
}

function updateDatasetNodes() {
  for (const ds of model.datasets()) {
    const el = document.getElementById(`node-ds:${ds}`);
    if (!el) continue;
    const d = live[ds] || { present: 0, last_ts: null };
    const header = el.querySelector(".gn-h");   // pulse the header when the stored count changed
    if (header && prevPresent[ds] !== undefined && prevPresent[ds] !== d.present) {
      header.classList.remove("pulse"); void header.offsetWidth; header.classList.add("pulse");
    }
  }
}

async function refreshGames(select) {
  const names = await api.listProfiles();
  $("gameSelect").innerHTML = names.map((n) => `<option>${n}</option>`).join("");
  if (select && names.includes(select)) $("gameSelect").value = select;
}

// Node view live-data refresh is driven by the HUB heartbeat (refreshLive, keyed on each
// dataset's last_ts) — ONE mechanism, no separate SSE here (that duplicated the hub and
// flooded the backend). Pretty Studio uses the SSE bus instead because it has no hub.

async function loadGame(name) {
  if (!name) return;
  await persist.flush();   // commit any pending save before switching games
  const done = timed(`load game ${name}`);
  let opened;
  try {
    opened = await persist.open(name);
  } catch (e) {
    done(String(e.message || e), "err");
    if (!conn.isOnline()) return;   // server unreachable -> conn's offline overlay owns the screen
    // a real load failure (e.g. a 500 while the server is restarting): block with a card the
    // user can act on instead of leaving a half-loaded graph and a lone log line.
    blockOverlay({
      title: `Couldn't load ${name}`,
      lines: [{ text: String(e.message || e) },
        { text: "The server may be restarting. Retry the load, or reload the page.", muted: true }],
      actions: [
        { label: "retry", primary: true, run: () => loadGame(name) },
        { label: "reload page", run: () => location.reload() },
      ],
    });
    return;
  }
  const { profile, local, migrated } = opened;
  done();
  model.load(profile);
  nodeEls.clear();
  $("gnodes").innerHTML = "";
  for (const winId of [...imageCanvases.keys()]) closeImage(winId);
  batchesState.clear();   // batches render inline per node; drop stale selection state
  selected.clear();       // drop any multi-selection from the previous game
  hydrateLayout();        // restore node positions/sizes/collapse/open-images from the profile
  applyLocal(local);      // restore canvas zoom/pan + minimap from the per-device sidecar
  render();
  await prettyOverrides.initOverrides(name);   // layer this game's transient pretty overrides onto the model
  refreshDirtyUI();
  if (prettyActive && _pretty) _pretty.setPrettyGame(name);
  // reopen saved images (canvas lives in node); awaited so boot can tell when the
  // initial image loads (and the detects they fire) have actually started. MUST run BEFORE
  // grouping orphans: grouping a NEW orphan child persists the layout, and collectLayout
  // writes open_images from the live `openImages` set — if the canvases aren't open yet that
  // set is empty and we'd save open_images:[], stranding every window's canvas on next load.
  await Promise.all(pendingOpenImages.map((winId) => (model.window(winId) ? openImage(winId) : null)));
  pendingOpenImages = [];
  groupOrphanChildren("itemfield");   // pull each item's field nodes into the item's group (idempotent)
  groupOrphanChildren("itemtell");    // …and its tell nodes
  drawEdges();                        // reflect any new group membership in the routing
  resetHistory();   // fresh undo/redo baseline for this game
  if (migrated) persist.layout();   // lock in node layout imported from legacy localStorage
  refreshLive();
  openLogStream(name);   // mirror server activity (trigger watches/fires, API fetches) into the log bar
  initFlow(name);   // (re)point the flow-blob stream at this game (clears any prior blobs)
  hub.kick();   // new game -> beat the hub so every panel re-reflects its state now
  setStatus(`loaded ${name}`);
}

$("gameSelect").addEventListener("change", (e) => loadGame(e.target.value));
// Mint a blank game profile. Called from the settings modal's "new game" section.
function createGame(name) {
  name = (name || "").trim();
  if (!name) { setStatus("enter a name"); return false; }
  model.load({ name, process_names: [], window_title_hint: null, fields: [], windows: [] });
  pos.clear(); nodeEls.clear(); $("gnodes").innerHTML = "";
  render(); autosave();
  refreshGames(name);
  return true;
}
// ---- node map (fixed overview / jump-to) ----------------------------------
// A draggable, fixed-to-screen panel that mirrors the graph two ways: a scaled MINI-MAP
// (nodes + connection lines + a viewport box) or a TEXT LIST built by walking the edges.
// Clicking any node in either view smoothly pans+zooms to it. Visibility, position and
// mode persist (global UI pref, not per-game).


buildNodeMap();
$("nodemapBtn")?.classList.toggle("active", nmState.visible);
$("nodemapBtn")?.addEventListener("click", () => setNodeMapVisible(!nmState.visible, true));
// (on-screen re-clamp + re-render on window resize is handled inside createFloatWin)

buildNodeList();
$("nodelistBtn")?.classList.toggle("active", nlState.visible);
$("nodelistBtn")?.addEventListener("click", () => setNodeListVisible(!nlState.visible, true));


buildActivity();
$("activityBtn")?.classList.toggle("active", actState.visible);
$("activityBtn")?.addEventListener("click", () => act.setVisible(!actState.visible, true));


buildTesting();
$("testingBtn")?.classList.toggle("active", testState.visible);
$("testingBtn")?.addEventListener("click", () => testWin.setVisible(!testState.visible, true));

buildToolbox();
$("createBtn")?.classList.toggle("active", tbState.visible);
$("createBtn")?.addEventListener("click", () => tb.setVisible(!tbState.visible, true));

buildPrecap();
buildLiveWindow();
$("liveBtn").classList.toggle("active", liveWinState.visible);
$("liveBtn").addEventListener("click", () => liveWin.setVisible(!liveWinState.visible, true));   // the panel's toggle drives live mode
$("precapBtn").addEventListener("click", () => {
  if (!pcState.visible && !model.profile.name) { setStatus("load a game first"); return; }
  pc.setVisible(!pcState.visible, true);
});

// Shift-clicking a panel's topbar toggle resets that panel's box (size + position) instead
// of toggling it. Capture phase so it can pre-empt the normal toggle handler above. If the
// panel is already open we reset in place and suppress the toggle (which would hide it); if
// it's closed/not-built we let the toggle open it, then reset on the next tick.
const _PANEL_TOGGLES = { liveBtn: "live", precapBtn: "precap", createBtn: "toolbox", nodemapBtn: "nodemap", nodelistBtn: "nodelist", activityBtn: "activity", testingBtn: "testing" };
for (const [btnId, panelId] of Object.entries(_PANEL_TOGGLES)) {
  $(btnId)?.addEventListener("click", (ev) => {
    if (!ev.shiftKey) return;
    const p = floatWins().get(panelId);
    if (p && p.state.visible) { ev.stopImmediatePropagation(); p.resetBox(); }
    else setTimeout(() => floatWins().get(panelId)?.resetBox(), 0);
  }, true);
}
// ---- Pretty Studio: node ⇄ pretty view switch + pretty-dirty controls -----------
// Pretty is a convenience surface in the SAME SPA; switching just swaps which container +
// topbar tools are visible. The controller is imported lazily on first switch.
let prettyActive = false;
let _pretty = null;
let _hiddenNodePanels = [];

// Node-view floating panels belong to the node view: hide them while in pretty, restore the
// ones that were open on return (open state remembered, never reset).
const _NODE_PANELS = ["nodemap", "nodelist", "activity", "testing", "toolbox", "live", "precap"];
function setNodePanelsHidden(hidden) {
  if (hidden) {
    _hiddenNodePanels = [];
    for (const id of _NODE_PANELS) { const w = floatWins().get(id); if (w && w.state.visible) { _hiddenNodePanels.push(id); w.setVisible(false); } }
  } else {
    for (const id of _hiddenNodePanels) floatWins().get(id)?.setVisible(true);
    _hiddenNodePanels = [];
  }
}

async function setPrettyView(on) {
  if (on === prettyActive) return;
  prettyActive = on;
  document.body.classList.toggle("pretty-mode", on);
  $("vtNode")?.classList.toggle("active", !on);
  $("vtPretty")?.classList.toggle("active", on);
  $("pretty")?.classList.toggle("active", on);
  if (on) {
    setNodePanelsHidden(true);   // node tools go out while pretty is up
    try {
      _pretty = _pretty || await import("../pretty/pretty.js");
      if (!_pretty.isMounted()) await _pretty.mountPretty($("pretty"), $("prettyTools"), model.profile.name);
      else await _pretty.setPrettyGame(model.profile.name);
      _pretty.activatePretty();
    } catch (e) { setStatus(`pretty: ${e.message || e}`); }
  } else {
    if (_pretty) _pretty.deactivatePretty();   // pretty tools go out
    setNodePanelsHidden(false);                // node tools come back as they were
  }
}
$("vtNode")?.addEventListener("click", () => setPrettyView(false));
$("vtPretty")?.addEventListener("click", () => setPrettyView(true));

// Show the revert/save-pretty controls only while transient overrides exist.
function refreshDirtyUI() {
  const bar = $("prettyDirtyBar");
  if (!bar) return;
  const has = prettyOverrides.hasDirty();
  bar.hidden = !has;
  const c = $("prettyDirtyCount");
  if (c) c.textContent = has ? `${prettyOverrides.dirtyCount()} pretty` : "";
}
// Armed two-click confirm (no blocking dialogs — rule 2), shared by both buttons.
function armConfirm(btn, run) {
  if (!btn) return;
  btn.addEventListener("click", () => {
    if (btn.dataset.armed !== "1") { btn.dataset.armed = "1"; btn.dataset.label = btn.textContent; btn.textContent = "confirm"; setTimeout(() => { if (btn.dataset.armed === "1") { btn.dataset.armed = "0"; btn.textContent = btn.dataset.label; } }, 2500); return; }
    btn.dataset.armed = "0"; btn.textContent = btn.dataset.label || btn.textContent; run();
  });
}
armConfirm($("prettyRevertBtn"), () => prettyOverrides.revertAll());
armConfirm($("prettySaveBtn"), () => prettyOverrides.commit());

prettyOverrides.setOverrideHooks({
  rebuildNode: (id) => { if (nodeEls.has(id)) rebuildNode(id); },
  onChange: refreshDirtyUI,
  persistFlush: () => persist.flush(),
});
setScrubHook(prettyOverrides.scrubForSave);

$("selGroupBtn").addEventListener("click", () => groupShortcut());

// The current selection the group action operates on: the multi-select set if any,
// else the single focused node.
function selectionIds() {
  if (selected.size) return [...selected].filter((id) => nodeEls.has(id));
  if (selectedNodeId && nodeEls.has(selectedNodeId)) return [selectedNodeId];
  return [];
}

// Group/ungroup the selection. SHARED by the toolbar button and the `g` hotkey so both
// behave identically:
//   • 1 node, grouped            -> detach it
//   • 2+, all share ONE group, some ungrouped -> add the ungrouped ones to that group
//   • 2+, all share ONE group, none ungrouped -> ungroup everything
//   • 2+, otherwise (no group / many groups)   -> form a new group out of them
// Super-group the ctrl-selected GROUPS, with the SAME ruleset groups use for nodes:
//   • 1 group, in a super group        -> detach it
//   • 2+, all in ONE super group, some out -> add the loose ones
//   • 2+, all in ONE super group, none out -> dissolve the super group
//   • 2+, otherwise                     -> form a new super group
function superGroupShortcut() {
  const gids = groups.selectedGroupIds();
  if (!gids.length) return false;
  if (gids.length === 1) {
    if (groups.superGroupOf(gids[0])) { groups.detachGroups(gids); setStatus("removed from super group"); }
    else { const sg = groups.createSuperGroup(gids); if (sg) setStatus("super-grouped 1 group"); }   // a super group of one is allowed
    groups.clearGroupSelection();
    return true;
  }
  const sset = new Set(gids.map((id) => groups.superGroupOf(id)).filter(Boolean));
  const loose = gids.filter((id) => !groups.superGroupOf(id));
  if (sset.size === 1) {
    const sg = [...sset][0];
    if (loose.length) { groups.addToSuper(sg.id, loose); setStatus(`added ${loose.length} to super group`); }
    else { groups.detachGroups(gids); setStatus("super group dissolved"); }
  } else {
    const sg = groups.createSuperGroup(gids);
    if (sg) setStatus(`super-grouped ${sg.groups.length} groups`);
  }
  groups.clearGroupSelection();
  return true;
}

function groupShortcut() {
  if (groups.selectedGroupIds().length) { superGroupShortcut(); return; }   // groups selected -> super-group them
  const ids = selectionIds();
  if (!ids.length) return;
  if (ids.length === 1) {
    if (groups.groupOf(ids[0])) { groups.detachNode(ids[0]); setStatus("detached from group"); }
    else { const g = groups.createGroup(ids); if (g) setStatus("grouped 1 node"); }   // a group of one is allowed
    return;
  }
  const gset = new Set(ids.map((id) => groups.groupOf(id)).filter(Boolean));   // distinct groups in the selection
  const ungrouped = ids.filter((id) => !groups.groupOf(id));
  if (gset.size === 1) {
    const g = [...gset][0];
    if (ungrouped.length) { groups.addToGroup(g.id, ungrouped); setStatus(`added ${ungrouped.length} to group`); }
    else { groups.detachNodes(ids); setStatus("ungrouped"); clearMultiSelect(); }
  } else {
    const g = groups.createGroup(ids);   // pulls members out of any prior group
    if (g) { setStatus(`grouped ${g.members.length} nodes`); clearMultiSelect(); }
  }
}
$("selClearBtn").addEventListener("click", () => deselectAll());
// Settings modal (cog): new-game creation, OCR controls, and a backups section — all
// built fresh per-open and wired here (no persistent holder; the modal owns its DOM).
$("settingsBtn")?.addEventListener("click", () => {
  const wrap = document.createElement("div");
  wrap.className = "settings";
  wrap.innerHTML = `
    <section class="set-sec">
      <h4>general</h4>
      <div class="set-row">
        <input id="newGameName" placeholder="new game name" />
        <button id="newGameBtn">create</button>
      </div>
    </section>
    <section class="set-sec">
      <h4>OCR</h4>
      <label class="set-row" title="OCR device — GPU needs onnxruntime-gpu + CUDA. Auto: CPU for editing, GPU for the precapture batch.">
        <span>device</span>
        <select id="ocrDevice"><option value="auto">Auto (CPU; GPU for precapture)</option><option value="cpu">CPU</option><option value="gpu">GPU</option></select>
      </label>
      <label class="set-row" title="downscale big frames before OCR — faster + far less GPU memory">
        <span>downscale</span>
        <select id="ocrScale">
          <option value="1">1× full</option>
          <option value="2">½ (¼ pixels)</option>
          <option value="4">¼ (1/16 pixels)</option>
        </select>
      </label>
    </section>
    <section class="set-sec set-backups"><h4>backups</h4><div></div></section>`;

  const name = model.profile.name;
  const handle = openModal({ title: "settings", size: "medium", node: wrap });

  // new game
  const ngName = wrap.querySelector("#newGameName");
  const submitGame = () => { if (createGame(ngName.value)) handle.close(); };
  wrap.querySelector("#newGameBtn").addEventListener("click", submitGame);
  ngName.addEventListener("keydown", (e) => { if (e.key === "Enter") submitGame(); });

  // OCR device + downscale
  wireOcrControls(wrap);

  // backups (restoring re-saves the backup live -> reload it fresh)
  const bkHost = wrap.querySelector(".set-backups > div");
  if (name) {
    buildBackups(bkHost, name, {
      onRestored: () => { loadGame(name); setStatus("restored backup"); },
      signal: handle.signal, close: handle.close,
    });
  } else {
    bkHost.innerHTML = `<div class="muted bk-pad">load a game to see its backups</div>`;
  }
});
$("graph").addEventListener("mousedown", (ev) => {
  // right-drag pans ANYWHERE (even over nodes/canvas), except form controls so
  // their native menus still work. Don't preventDefault — a plain right click
  // must still open the context menu; only an actual drag suppresses it.
  if (ev.button === 2) { if (!ev.target.closest("input,select,textarea")) startPan(ev); return; }
  // left-drag on empty canvas: rubber-band multi-select (a plain click clears).
  if (ev.button === 0 && !ev.target.closest(".gnode, .ggroup")) startMarquee(ev);
});
// double-click a group's BACKGROUND (or a super group's) → frame it. The group box is
// pointer-events:none so single clicks/drags fall through to the canvas (pan/marquee); we
// hit-test the dblclick against the world rects instead. Innermost (smallest) wins, so a
// group inside a super group frames the group. Node dblclick is handled on the node itself.
$("graph").addEventListener("dblclick", (ev) => {
  if (ev.target.closest(".gnode")) return;
  const box = $("graph").getBoundingClientRect();
  const wx = (ev.clientX - box.left - view.panX) / view.zoom;
  const wy = (ev.clientY - box.top - view.panY) / view.zoom;
  const inside = (b) => wx >= b.x && wx <= b.x + b.w && wy >= b.y && wy <= b.y + b.h;
  let hit = null;
  for (const gb of [...(groups.superGroupBoxes?.() || []), ...groups.groupBoxes()])
    if (inside(gb.box) && (!hit || gb.box.w * gb.box.h < hit.box.w * hit.box.h)) hit = gb;
  if (hit) panZoomToRect(hit.box);
});

// Rubber-band selection: drag a rectangle on empty canvas to select every node it
// touches. Highlights live; commits on release. A press with no drag clears selection.
function startMarquee(ev) {
  const box = $("graph").getBoundingClientRect();
  const el = $("marquee");
  const s = { x: ev.clientX, y: ev.clientY };
  // screen point -> world (matches moveNodes' toWorld)
  const toWorld = (cx, cy) => ({ x: (cx - box.left - view.panX) / view.zoom, y: (cy - box.top - view.panY) / view.zoom });
  let moved = false;
  const caught = () => {
    const a = toWorld(s.x, s.y), b = toWorld(_mx, _my);
    const x1 = Math.min(a.x, b.x), y1 = Math.min(a.y, b.y), x2 = Math.max(a.x, b.x), y2 = Math.max(a.y, b.y);
    const hit = [];
    for (const [id] of nodeEls) {
      const r = nodeRect(id);
      if (r && r.x < x2 && r.x + r.w > x1 && r.y < y2 && r.y + r.h > y1) hit.push(id);
    }
    return hit;
  };
  let _mx = s.x, _my = s.y;
  const onMove = (e) => {
    _mx = e.clientX; _my = e.clientY;
    if (!moved && Math.hypot(_mx - s.x, _my - s.y) < 4) return;
    if (!moved) { moved = true; el.hidden = false; deselectAll(); }
    const left = Math.min(s.x, _mx) - box.left, top = Math.min(s.y, _my) - box.top;
    el.style.left = `${left}px`; el.style.top = `${top}px`;
    el.style.width = `${Math.abs(_mx - s.x)}px`; el.style.height = `${Math.abs(_my - s.y)}px`;
    const hit = new Set(caught());
    for (const [id, nel] of nodeEls) nel.classList.toggle("multisel", hit.has(id));
  };
  const onUp = () => {
    document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp);
    el.hidden = true;
    if (moved) setMultiSelect(caught());
    else deselectAll();
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}
// Suppress on window (capture) not #graph: a pan tracks via document mousemove, so the
// release — and thus the native contextmenu — can land on a node panel, modal, or even
// outside #graph, where a graph-scoped listener would never see it.
window.addEventListener("contextmenu", (ev) => {
  if (suppressNextMenu) { ev.preventDefault(); suppressNextMenu = false; return; }   // a pan-drag just ended
  // Right-click empty canvas → add-node menu (same primitive as pretty's add-widget). The new
  // node spawns at the world point under the cursor. Clicks on nodes/groups/floating panels/
  // form controls fall through to the native menu. Capture phase + the suppress check above run
  // before this, so a pan-drag never opens the menu.
  if (ev.shiftKey) return;   // shift+right-click is reserved -> no add-node menu (native too)
  if (!ev.target.closest("#graph")) return;
  if (ev.target.closest(".gnode, .ggroup, .floatwin, input, select, textarea")) return;
  ev.preventDefault();
  const box = $("graph").getBoundingClientRect();
  const at = { x: (ev.clientX - box.left - view.panX) / view.zoom, y: (ev.clientY - box.top - view.panY) / view.zoom };
  const gid = groups.groupAt(at.x, at.y);   // opened over a group's box -> new node joins it
  const ready = () => { if (model.profile.name) return true; setStatus("load a game first"); return false; };
  // icons + tints come from the ONE shared source (node_icons / graph.css --ntint) so a menu row
  // reads in the same glyph + colour as the node it mints (rule 7).
  openContextMenu(ev.clientX, ev.clientY, [
    { icon: iconFor("window"),     title: "window",      tint: "var(--accent)",       onClick: () => ready() && createWindowNode(at, gid) },
    { icon: iconFor("price"),      title: "price node",  tint: "var(--warn)",         onClick: () => ready() && createPriceNode(at, gid) },
    { icon: iconFor("trigger"),    title: "trigger",     tint: "var(--trigger-line)", onClick: () => ready() && createTriggerNode(at, gid) },
    { icon: iconFor("dictionary"), title: "dictionary",  tint: "var(--purple)",       onClick: () => ready() && createDictionaryNode(at, gid) },
  ]);
}, true);
$("graph").addEventListener("wheel", onWheel, { passive: false });
// any user action cancels an in-flight smooth pan-to-new-node
$("graph").addEventListener("pointerdown", cancelPan, true);
$("graph").addEventListener("wheel", cancelPan, { capture: true, passive: true });
window.addEventListener("keydown", cancelPan, true);

// WASD moves the selected rectangle; Shift+WASD resizes it (A/D width, W/S height).
// Ignored while typing in a field.
const NUDGE = { w: [0, -1], a: [-1, 0], s: [0, 1], d: [1, 0] };
const MINB = 0.004;
document.addEventListener("keydown", (ev) => {
  if (["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
  if (ev.ctrlKey || ev.metaKey) {
    const k = ev.key.toLowerCase();
    if (k === "z" && !ev.shiftKey) { ev.preventDefault(); undo(); return; }
    if (k === "y" || (k === "z" && ev.shiftKey)) { ev.preventDefault(); redo(); return; }
  }
  // g: group / ungroup the selection (same logic as the toolbar button)
  if (ev.key.toLowerCase() === "g" && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
    groupShortcut(); ev.preventDefault(); return;
  }
  const dir = NUDGE[ev.key.toLowerCase()];
  if (!dir) return;
  // No active box but a node is selected → WASD moves the NODE, one grid step.
  const rec = overlays.get(activeOverlayKey);
  if (!rec) {
    if (selectedNodeId && pos.has(selectedNodeId)) {
      const p = pos.get(selectedNodeId);
      p.x = snap(p.x + dir[0] * GRID); p.y = snap(p.y + dir[1] * GRID);
      positionNode(selectedNodeId); drawEdges(); persist.layout();
      ev.preventDefault();
    }
    return;
  }
  // Otherwise operate on whichever overlay holds the live box selection (window OR item).
  const ov = rec.overlay;
  const b = ov.boxes.find((x) => x.id === ov.activeId);
  if (!b) return;
  // step exactly ONE image pixel, so it's the same feel on any canvas size
  const sx = 1 / (ov.canvas.width || 1000), sy = 1 / (ov.canvas.height || 1000);
  if (ev.shiftKey) {
    b.w = Math.min(Math.max(MINB, b.w + dir[0] * sx), 1 - b.x);
    b.h = Math.min(Math.max(MINB, b.h + dir[1] * sy), 1 - b.y);
  } else {
    b.x = Math.min(Math.max(0, b.x + dir[0] * sx), 1 - b.w);
    b.y = Math.min(Math.max(0, b.y + dir[1] * sy), 1 - b.h);
  }
  rec.persist(b);
  rec.refresh();
  ov.render();        // reflect the nudge on the overlay immediately
  drawEdges(); autosave();
  ev.preventDefault();
});

function persistBox(winId, b) {
  const box = { x: b.x, y: b.y, w: b.w, h: b.h };
  if (b.role === "detect") model.setDetectBox(winId, b.id, box);
  else if (b.role === "scrollbar") model.setScrollbar(winId, box);
  else if (b.role === "data_area") model.setDataArea(winId, box);
  else model.setRegionBox(winId, b.id, box);
}

// ---- init -----------------------------------------------------------------

// Show the topbar kill-GPU button only while a GPU OCR session is actually LOADED
// (holding VRAM) — `ocr.gpu_active`, not merely "GPU is selected". The heartbeat hub
// pushes the device slice every beat, so the button (re)appears on its own when a read
// rebuilds the GPU session and hides after a kill frees it. Idempotent: touches the DOM
// only on a real change (steady-state ticks mutate nothing — CLAUDE.md hard rule 1).
function syncKillGpu(ocr) {
  const k = $("killGpuBtn"); if (!k) return;
  const hidden = !(ocr && ocr.gpu_active);
  if (k.hidden !== hidden) k.hidden = hidden;
}

// Wire the persistent topbar kill-GPU button once at startup. Visibility is driven by the
// heartbeat hub thereafter; one upfront fetch seeds it before the first beat lands.
async function initKillGpu() {
  const killBtn = $("killGpuBtn");
  if (!killBtn) return;
  killBtn.addEventListener("click", async () => {
    const done = timed("kill GPU OCR");
    killBtn.disabled = true;
    killBtn.classList.add("reading");
    try { const r = await api.ocr.releaseGpu(); syncKillGpu(r); done("freed; reloads on next use"); }
    catch (e) { done(String(e.message || e), "err"); }
    finally { killBtn.classList.remove("reading"); killBtn.disabled = false; }
  });
  hub.subscribe((s) => syncKillGpu(s.ocr));
  try { syncKillGpu(await api.ocr.getDevice()); } catch { /* ignore */ }
}

// Wire the OCR device + downscale selects inside a freshly-built settings modal.
async function wireOcrControls(root) {
  const sel = root.querySelector("#ocrDevice");
  if (!sel) return;
  try {
    const st = await api.ocr.getDevice();
    const gpuOpt = sel.querySelector('option[value="gpu"]');
    const autoOpt = sel.querySelector('option[value="auto"]');
    // GPU + Auto both need CUDA (Auto bursts to GPU for the batch); grey them out without it
    gpuOpt.disabled = !st.gpu_available;
    if (autoOpt) autoOpt.disabled = !st.gpu_available;
    if (!st.gpu_available) gpuOpt.textContent = "GPU (n/a)";
    sel.value = st.mode || st.device;   // the select reflects the MODE, not the live device
    syncKillGpu(st);
    sel.addEventListener("change", async () => {
      const done = timed(`OCR device → ${sel.value}`);
      // Keep the user's pick; only correct it if the server reports a different MODE. (Never
      // fall back to the live device — under "auto" that's cpu and would yank the dropdown.)
      try { const r = await api.ocr.setDevice(sel.value); if (r.mode) sel.value = r.mode; syncKillGpu(r); done(); }
      catch (e) { done(String(e.message || e), "err"); }
    });
    const scaleSel = root.querySelector("#ocrScale");
    if (scaleSel) {
      scaleSel.value = String(st.scale || 1);
      scaleSel.addEventListener("change", async () => {
        const done = timed(`OCR downscale → ${scaleSel.value}×`);
        try { const r = await api.ocr.setScale(scaleSel.value); scaleSel.value = String(r.scale || 1); done(); }
        catch (e) { done(String(e.message || e), "err"); }
      });
    }
  } catch { /* ignore */ }
}

// ---- boot veil: full-page spinner until the initial load has settled ----------
const veil = {
  drop() {
    const v = document.getElementById("bootveil");
    if (!v) return;
    v.classList.add("fade");
    setTimeout(() => v.remove(), 300);
  },
};

// Wait until the boot round of OCR work (detects/previews fired by reopening images)
// has DRAINED — quiet for a stretch, not just momentarily empty between two reads.
// Hard cap so a hung server can't keep the veil up forever.
async function bootSettle(maxMs = 30000, quietMs = 600) {
  const t0 = performance.now();
  let quiet = 0;
  while (performance.now() - t0 < maxMs) {
    const busy = detectBusy.size + previewBusy.size + detectAgain.size + previewAgain.size;
    quiet = busy ? 0 : quiet + 150;
    if (quiet >= quietMs) return;
    await new Promise((res) => setTimeout(res, 150));
  }
}

// Full-screen blocking error card with a title, message lines, and one or more action
// buttons. The ONE such overlay — startup-halt and a failed game-load both build on it (don't
// copy the markup). `lines` = [{text, muted?}]; `actions` = [{label, primary?, run}]. A click
// removes the overlay BEFORE running, so a `run` that rebuilds it (retry) starts clean. Only
// one is ever shown at a time (an existing card is replaced).
function blockOverlay({ title, lines = [], actions = [] }) {
  document.querySelector(".startup-halt")?.remove();
  const o = document.createElement("div");
  o.className = "startup-halt";
  const body = lines.map((l) => `<p${l.muted ? ' class="muted"' : ""}>${esc(l.text)}</p>`).join("");
  o.innerHTML = `<div class="startup-halt-box"><h3>${esc(title)}</h3>${body}
    <div class="halt-actions">${actions.map((a, i) =>
      `<button class="startup-halt-retry${a.primary ? "" : " ghost"}" data-i="${i}">${esc(a.label)}</button>`).join("")}</div></div>`;
  actions.forEach((a, i) => o.querySelector(`[data-i="${i}"]`).addEventListener("click", () => { o.remove(); a.run(); }));
  document.body.appendChild(o);
  return o;
}

// Block the whole UI with an unmissable message and refuse to continue.
function haltStartup(msg) {
  veil.drop();   // the halt overlay must be visible (the veil sits above it)
  log(msg, "err");
  blockOverlay({
    title: "Background OCR still running",
    lines: [{ text: msg },
      { text: "Nothing was loaded. Kill the stray worker (or the python process), then retry.", muted: true }],
    actions: [{ label: "retry", primary: true, run: () => location.reload() }],
  });
}

// On page load, kill any background OCR worker from a prior session and WAIT for it to
// die. Do NOT load the graph until it's confirmed gone — a stray worker keeps hammering
// the GPU/game and is the thing you'd otherwise have to hunt down in Task Manager.
async function killStrayOcrThenBoot() {
  setLogOpen(true);   // show the log history during boot so initial-load progress is visible
  try {
    log("stopping stray OCR…");
    const r = await api.precapture.killAll();
    if (r.alive && r.alive.length) {
      haltStartup(`OCR worker for ${r.alive.join(", ")} would not stop within the timeout.`);
      return;   // refuse to proceed
    }
    if (r.killed && r.killed.length) setStatus(`stopped stray OCR: ${r.killed.join(", ")}`);
  } catch (e) {
    if (!conn.isOnline()) {           // server unreachable, not an OCR problem
      veil.drop();                    // conn shows its own offline overlay; reconnect reloads
      return;
    }
    haltStartup(`Could not confirm background OCR was stopped: ${e.message || e}`);
    return;   // can't verify -> don't proceed
  }
  try {
    log("loading profile…");
    await refreshGames();
    if ($("gameSelect").value) await loadGame($("gameSelect").value);
    initKillGpu();
    hub.init(() => model.profile.name);   // single backend heartbeat for every panel
    hub.start();
    log("first read…");
    await bootSettle();
  } catch (e) {
    if (!conn.isOnline()) { veil.drop(); return; }   // dropped mid-boot -> offline overlay handles it
    log(String(e.message || e), "err");   // boot hiccup: show the page anyway
  }
  booted = true;
  veil.drop();
  setLogOpen(false);   // boot done -> collapse the log back to its one-line bar
}

// Until the initial load completes, a reconnect can't just "resume" — the graph was
// never loaded. Reload to run boot cleanly. After boot, a reconnect simply lets the
// gated pollers pick back up (conn.js hides the overlay), no reload needed.
let booted = false;
conn.onChange((up) => { if (up && !booted) location.reload(); });

killStrayOcrThenBoot();

// ---- exports consumed by panel modules (imported back from "./main.js") ----
export {
  focusNode, panZoomTo, panZoomToRect, autosave, placeNewNode, render, panTo,
  refreshLive, clockTime,
  refreshAllSubsetNodes, refreshDatasetConsumers,
  rebuildNode, setNodeBusy, withBusy, registerOverlay, unregisterOverlay,
  overlaySelected, selectWindowBox, persistBox, syncCellSize, itemChanged,
  keyPrevHTML, addFieldToItemGroup, addTellToItemGroup, inheritGroupFrom,
};
