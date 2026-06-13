// Node-view home: edit a game's structure as a graph (Game → Windows → Fields →
// Datasets), drag to arrange, drag-wire a window to a dataset, edit inline, and
// watch live dataset counts. Box drawing stays on the canvas (teach.html link).
import * as api from "../api.js";
import { esc } from "../dom.js";
import { openModal } from "../modal.js";
import { Overlay } from "../overlay.js";
import { log, timed, setLogOpen } from "../log.js";
import { GraphModel } from "./model.js";
import { EdgeRouter, polylinePath } from "./route.js";
import { buildKey, DEFAULT_KEY } from "../keys.js";
import { priceParts, wirePriceNode } from "./price_node.js";
import { GRID, snap, showSizeHud, hideSizeHud, addResizeGrips, beginDrag } from "./dragresize.js";
import { createFloatWin, floatWins } from "./floatwin.js";
import { triggerParts } from "./trigger_node.js";
import { openDictionaryPicker } from "./dict_picker.js";
import { enhanceTable, setTableStore } from "./table.js";
import { VTable, setVTableStore } from "../vtable.js";
import { initPersist, persist } from "./persist.js";
import { openBackupsModal } from "./backups.js";
import * as groups from "./groups.js";

const $ = (id) => document.getElementById(id);
const setStatus = (m) => log(m);   // #status is gone — the log bar shows messages now
const model = new GraphModel();
const pos = new Map();            // node id -> {x,y}
const nodeEls = new Map();        // node id -> DOM element (built once, reused)
const collapsed = new Set();      // collapsed node ids
const view = { panX: 0, panY: 0, zoom: 1 };  // canvas pan/zoom
const COLX = { game: 20, window: 300, trigger: 560, price: 700, preview: 1580, region: 600, detect: 600, state: 600, scrollbar: 600, dataset: 900, subset: 1900, dictionary: 20 };
let live = {};                    // dataset -> {present,total,last_op,last_ts}
const prevPresent = {};
const prevLastTs = {};            // dataset -> last ledger event ts (changes on ANY batch)
const dsTab = new Map();          // dataset -> "data" | "history" (which tab the merged node shows)
let timer = null;
let wire = null;                  // active drag-wire {winId, x1,y1}
let selectedNodeId = null;        // node whose line(s) are highlighted
const selected = new Set();       // multi-selected node ids (marquee / shift-click)
const imageCanvases = new Map();  // winId -> { wrap, overlay, canvas } (drawing surface)
const itemCanvases = new Map();   // `winId:itemId` -> { host, canvas, overlay, + coord maps }

// Central registry of EVERY drawing overlay, so selection, deselection, and box
// hotkeys are handled in ONE place — any new overlay just registers here and gets
// cross-deselect + WASD for free. rec = { overlay, kind, winId, itemId?, persist(box), refresh() }.
const overlays = new Map();
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
const openImages = new Set();     // winIds whose image is loaded into the window node (persisted)
const nodeSizes = new Map();      // node id -> {w,h} for resizable nodes (persisted)
let pendingOpenImages = [];
const busy = new Map();            // node id -> active-work count (drives the spinner)
const gridPreviews = new Map();    // winId -> live-detected field boxes (dashed grid)
const gridReads = new Map();        // winId -> per-cell read values {x,y,w,h,text,confidence}
const itemReads = new Map();        // "winId:itemId" -> last cutout read {fields,tells,valid,cell}

// Show/hide a node's spinner via a ref count, so overlapping async tasks behave.
function setNodeBusy(nodeId, on) {
  const n = (busy.get(nodeId) || 0) + (on ? 1 : -1);
  if (n <= 0) busy.delete(nodeId); else busy.set(nodeId, n);
  nodeEls.get(nodeId)?.classList.toggle("busy", (busy.get(nodeId) || 0) > 0);
}
// Run an async task while showing spinners on the given node ids.
async function withBusy(ids, fn) {
  ids.forEach((id) => setNodeBusy(id, true));
  try { return await fn(); }
  finally { ids.forEach((id) => setNodeBusy(id, false)); }
}

// ---- background worker registry -------------------------------------------
// Anything doing real background work — the backend precapture worker, the live
// re-read loop, future long jobs — registers here. The log bar then shows a live
// count on its far right plus a per-worker emergency kill button.
const workers = new Map();   // id -> { label, kill }
function registerWorker(id, label, kill) {
  const w = workers.get(id);
  if (w) { w.kill = kill; if (w.label === label) return; w.label = label; }   // same label -> nothing visible changed
  else workers.set(id, { label, kill });
  renderWorkers();
}
function unregisterWorker(id) { if (workers.delete(id)) renderWorkers(); }

// Reconcile the indicator IN PLACE — never rebuild innerHTML (the precapture poll
// re-registers every 700ms; rebuilding would restart the spinner animation and churn
// the buttons every tick). Fixed spinner + count are made once; buttons are reused.
let wkSpin = null, wkCount = null;
const workerBtns = new Map();   // id -> <button>
function renderWorkers() {
  const el = $("logWorkers");
  if (!el) return;
  el.hidden = workers.size === 0;
  if (!wkSpin) {
    wkSpin = document.createElement("span"); wkSpin.className = "lw-spin";
    wkCount = document.createElement("span"); wkCount.className = "lw-count";
    el.append(wkSpin, wkCount);
  }
  wkCount.textContent = `${workers.size} worker${workers.size === 1 ? "" : "s"}`;
  for (const [id, btn] of workerBtns) if (!workers.has(id)) { btn.remove(); workerBtns.delete(id); }
  for (const [id, w] of workers) {
    let btn = workerBtns.get(id);
    if (!btn) {
      btn = document.createElement("button");
      btn.className = "lw-kill"; btn.dataset.kill = id; btn.title = "emergency stop";
      el.appendChild(btn); workerBtns.set(id, btn);
    }
    if (btn._label !== w.label) { btn.textContent = `⨯ ${w.label}`; btn._label = w.label; }
  }
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

function autosave(refresh = true) {
  if (!model.profile.name) return;
  persist.content();         // debounced profile save; onContentSaved fires on success
  if (refresh) {             // a disabled node's edit passes false: it changes nothing others read
    refreshOpenPreviews();   // update any open preview nodes after edits
    refreshOpenDetect();     // update detector/state true-false after edits
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
  // floating panels (node map / activity / precapture) travel with the profile
  const fw = {};
  for (const [id, w] of floatWins()) fw[id] = w.collect();
  L.float_windows = fw;
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
  const fw = L.float_windows || {};
  for (const [id, w] of floatWins()) w.hydrate(fw[id]);   // resets to defaults when absent
}

// Per-device viewport (canvas zoom/pan) ↔ the gitignored sidecar. Floating panels used to
// live here too; they're in the profile YAML now (layout.float_windows), via floatWins().
function collectLocal() {
  return { view: { panX: view.panX, panY: view.panY, zoom: view.zoom } };
}
function applyLocal(local) {
  if (local?.view && Number.isFinite(local.view.zoom)) { Object.assign(view, local.view); applyView(); }
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
const _TYPE_BY_PREFIX = { win: "window", prev: "preview", reg: "region", det: "detect", sb: "scrollbar", item: "item", ds: "dataset", sub: "subset", price: "price", dict: "dictionary" };
function nodeTypeOf(id) { return id === "game" ? "game" : (_TYPE_BY_PREFIX[id.split(":")[0]] || null); }
groups.initGroups({
  world: () => $("ggroups"),
  nodeRect: (id) => nodeRect(id),
  nodeType: nodeTypeOf,
  moveMembers: (ids, ev) => { const lead = ids.find((id) => pos.get(id)); if (lead) moveNodes(lead, ids.filter((x) => x !== lead), ev); },
  persist: () => persist.layout(),
  afterChange: () => { refreshDetachIcons(); syncMultiSelect(); },
  // double-click a group → frame its bounding box (reuses groupBoxes() geometry)
  zoomToGroup: (gid) => { const gb = groups.groupBoxes().find((b) => b.id === gid); if (gb) panZoomToRect(gb.box); },
  // drag the group's resize grip → scale its members, gaps intact
  startGroupResize: (gid, ev) => startGroupResize(gid, ev),
});

// ---- undo / redo (full history of the profile) -----------------------------
// Layout is EXCLUDED from history (snapState strips it) so undo/redo is config-only —
// moving a node never becomes an undo step, and undo never shuffles the canvas.

let history = [];
let hIndex = -1;
let restoring = false;
function snapState() { const { layout, ...rest } = model.profile; return JSON.stringify(rest); }
function pushHistory() {
  if (restoring) return;
  const s = snapState();
  if (hIndex >= 0 && history[hIndex] === s) return;   // no change
  history = history.slice(0, hIndex + 1);
  history.push(s);
  if (history.length > 200) history.shift();
  hIndex = history.length - 1;
}
function resetHistory() { history = [snapState()]; hIndex = 0; }
function applyHistory() {
  restoring = true;
  const layout = model.profile.layout;     // carry layout across the reload (it's not in history)
  model.load(JSON.parse(history[hIndex]));
  model.profile.layout = layout;
  render();
  for (const winId of imageCanvases.keys()) { refreshImageBoxes(winId); refreshDetect(winId); }
  persist.content();
  restoring = false;
}
function undo() { if (hIndex > 0) { hIndex--; applyHistory(); setStatus("undo"); } }
function redo() { if (hIndex < history.length - 1) { hIndex++; applyHistory(); setStatus("redo"); } }
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
function parentOf(id) { for (const e of model.edges()) if (e.to === id) return e.from; return null; }

// Closest free (non-overlapping) slot in a column to `nearY`. Used to drop a brand-new
// node beside its parent instead of at the far bottom of its column.
function freeSpot(x, nearY, w = 240, h = 160) {
  const GAP = 18, STEP = 20;
  const rects = [];
  for (const [id, p] of pos) if (Number.isFinite(p.x)) rects.push({ x: p.x, y: p.y, w: nw(id), h: nh(id) });
  const free = (y) => !rects.some((o) =>
    x < o.x + o.w + GAP && x + w + GAP > o.x && y < o.y + o.h + GAP && y + h + GAP > o.y);
  for (let d = 0; d <= 8000; d += STEP) {
    for (const y of (d ? [nearY + d, nearY - d] : [nearY])) {
      if (y >= 0 && free(y)) return { x, y: snap(y) };
    }
  }
  return { x, y: Math.max(0, snap(nearY)) };
}

// Position a just-created node at the nearest free spot to its parent. Call BEFORE
// render() so ensurePositions() leaves it alone.
function placeNewNode(id, type) {
  const par = parentOf(id);
  const nearY = (par && pos.get(par)?.y) ?? 20;
  pos.set(id, freeSpot(COLX[type] ?? 300, nearY));
  setStatus(`created ${type} ${id.split(":").pop()}`);
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

// Comfortable zoom to fit a node in the viewport, with only a small margin around it
// (tight, not lots of empty space). Shared by double-click AND the node-map jump.
const FIT_FILL = 0.96;   // node spans this fraction of the viewport
const FIT_MAX = 4;       // allow zooming further in for small nodes
function fitZoom(w, h, rect) {
  return Math.min(8, Math.max(0.15, Math.min(FIT_MAX, (rect.width * FIT_FILL) / w, (rect.height * FIT_FILL) / h)));
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
// Scale members' SIZE by s and reposition so inter-node GAPS stay EXACTLY constant (not
// scaled). A node shifts by the ACTUAL size-growth of the nodes that are both fully before it
// on an axis AND overlap it on the other axis (same row for x, same column for y) — so only a
// genuine left/up neighbour pushes it, growth isn't double-counted across rows, and a node
// that doesn't resize (non-host) contributes zero so the gap around it is untouched. Anchored
// at the leftmost/topmost node; computed from the original snapshot each tick (no drift).
const overlapY = (a, b) => a.y < b.y + b.h && a.y + a.h > b.y;   // share vertical extent → same row
const overlapX = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x;   // share horizontal extent → same column
// SIZES are GRID-stepped (clean steps, like the node grips); POSITIONS are NOT re-snapped —
// each node moves by the EXACT cumulative growth of the nodes packed before it, so a gap (the
// difference of two shifted edges that share those growth terms) stays byte-for-byte the same.
// (Grid-snapping each position independently was the bug: two roundings on one gap drifted it.)
// Each target size is written to the DOM and read back via offsetWidth/Height, so the browser
// applies that node's own CSS constraints (min/max-width, item width-only + cutout aspect); the
// post-clamp growth (dw/dh) is what shifts later nodes, so gaps hold even when a node hits a limit.
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
  for (const n of snap) {
    let shiftX = 0, shiftY = 0;
    for (const o of snap) {
      if (o === n) continue;
      if (o.x + o.w <= n.x + 0.5 && overlapY(o, n)) shiftX += grow.get(o.id).dw;   // fully left, same row
      if (o.y + o.h <= n.y + 0.5 && overlapX(o, n)) shiftY += grow.get(o.id).dh;   // fully above, same column
    }
    pos.set(n.id, { x: Math.round(n.x + shiftX), y: Math.round(n.y + shiftY) });   // exact chain, no re-snap
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
    drawEdges(); groups.renderGroups(); renderNodeMap();
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
  // The record key is taught per item template (key section in the item node; the
  // teach page covers grid windows). Where records flow is shown by the wire to the
  // dataset node, so the window node itself only carries the image/delete actions.
  return `<div class="gn-foot"><button class="imgbtn">📷 image</button></div>`;
}

// The tells + fields list shown under an item node's cutout canvas. Item fields
// carry the SAME per-field config as the old region nodes (type/extract/sep/learn/
// fuzzy/empty/pips) — edited here against the window's FieldDef.
function itemLists(it, w) {
  const fieldDef = (fid) => (w.fields || []).find((x) => x.id === fid) || { type: "text", extract: "whole", learn: false, fuzzy: 0.82 };
  const tells = (it.tells || []).map((t) => `<div class="ti-row" data-tid="${t.id}">
      <span class="ti-kind">${esc(t.kind)}</span>
      <label class="ti-loc" title="use to locate rows"><input type="radio" name="loc-${esc(it.id)}" class="iset" data-k="locate" data-tid="${t.id}" ${t.locate ? "checked" : ""}/>loc</label>
      ${t.kind === "text" ? `<select class="iset" data-k="field" data-tid="${t.id}">${(it.fields || []).map((f) => `<option ${t.field === f.field ? "selected" : ""}>${esc(f.field)}</option>`).join("")}</select>` : ""}
      ${t.kind === "color" ? `<input type="color" class="iset" data-k="color" data-tid="${t.id}" value="${t.color || "#ffcc00"}"/>` : ""}
      ${t.locate ? `<select class="iset" data-k="align" data-tid="${t.id}" title="anchor on this line of a wrapped name">${["none", "top", "center", "bottom"].map((v) => `<option ${(t.align || it.align || "center") === v ? "selected" : ""}>${v}</option>`).join("")}</select>` : ""}
      <input type="number" class="iset" data-k="threshold" data-tid="${t.id}" step="0.05" min="0" max="1" value="${t.threshold ?? 0.5}" title="threshold"/>
      <button class="ti-del danger" data-tid="${t.id}">×</button></div>`).join("");
  const fields = (it.fields || []).map((f) => {
    const fd = fieldDef(f.field);
    const types = TYPES.map(([v, t]) => `<option value="${v}" ${fd.type === v ? "selected" : ""}>${t}</option>`).join("");
    const exs = EXTRACTS.map((v) => `<option ${(fd.extract || "whole") === v ? "selected" : ""}>${v}</option>`).join("");
    const pips = fd.type === "pips" || fd.type === "diamonds";
    return `<div class="if-row" data-fid="${f.id}">
      <div class="if-head"><input class="iset-fid" data-fid="${f.id}" value="${esc(f.id)}"/><button class="if-del danger" data-fid="${f.id}">×</button></div>
      <label class="flab">type <select class="ffset" data-fid="${f.id}" data-k="type">${types}</select></label>
      ${pips ? "" : `<label class="flab">extract <select class="ffset" data-fid="${f.id}" data-k="extract">${exs}</select></label>`}
      ${(!pips && NEEDS_SEP.has(fd.extract)) ? `<label class="flab">separator <input class="ffset" type="text" data-fid="${f.id}" data-k="sep" value="${esc(fd.separator || "/")}"/></label>` : ""}
      <label class="flab">learn <input type="checkbox" class="ffset" data-fid="${f.id}" data-k="learn" ${fd.learn ? "checked" : ""}/></label>
      <label class="flab" title="require this field to read something — it doubles as a tell">tell <input type="checkbox" class="itell" data-fid="${f.id}" ${f.tell ? "checked" : ""}/></label>
      ${f.tell ? `<label class="flab" title="minimum OCR confidence the read must reach (0 = any)">tell conf <input type="number" class="itellconf" data-fid="${f.id}" step="0.05" min="0" max="1" value="${f.tell_conf ?? 0}"/></label>` : ""}
      ${f.tell ? `<label class="flab" title="if this field locates rows: which line of a wrapped name to anchor on">align <select class="itellalign" data-fid="${f.id}">${["none", "top", "center", "bottom"].map((v) => `<option ${(f.align || it.align || "center") === v ? "selected" : ""}>${v}</option>`).join("")}</select></label>` : ""}
      <label class="flab">fuzzy <input type="number" class="ffset" data-fid="${f.id}" data-k="fuzzy" step="0.05" min="0" max="1" value="${fd.fuzzy ?? 0.82}"/></label>
      <label class="flab" title="value used when the read is truly empty (no text, no numbers)">if empty <input class="ffset" data-fid="${f.id}" data-k="empty" value="${esc(fd.empty || "")}" placeholder="(blank)"/></label>
      ${fd.type === "text" ? `<label class="flab" title="value substituted when the read is numbers">if number <input class="ffset" data-fid="${f.id}" data-k="ifnum" value="${esc(fd.if_number ?? "")}" placeholder="(off)"/></label>
      <label class="flab" title="checked: fire when the read merely contains a digit; unchecked: only an all-number read">any digit <input type="checkbox" class="ffset" data-fid="${f.id}" data-k="ifnumany" ${fd.if_number_any ? "checked" : ""}/></label>
      <label class="flab" title="off = dictionary not consulted; correct = fix words, keep unmatched; drop = no fixes, unmatched read dropped; correct + drop = fix words, unmatchable read dropped">dict <select class="ffset" data-fid="${f.id}" data-k="dictmode">${DICT_MODES.map(([v, t]) => `<option value="${v}" ${(fd.dict_mode || "correct") === v ? "selected" : ""}>${t}</option>`).join("")}</select></label>
      ${(model.profile.dictionaries || []).length ? `<label class="flab" title="which authored dictionary this field snaps to (all = every enabled one pooled)">use dict <select class="ffset" data-fid="${f.id}" data-k="usedict">${dictOptions(fd.dictionary)}</select></label>` : ""}` : ""}
      ${fd.type === "number" ? `<label class="flab" title="value substituted when the read is text">if text <input class="ffset" data-fid="${f.id}" data-k="iftext" value="${esc(fd.if_text ?? "")}" placeholder="(off)"/></label>
      <label class="flab" title="checked: fire when the read merely contains a letter; unchecked: only an all-text read">any letter <input type="checkbox" class="ffset" data-fid="${f.id}" data-k="iftextany" ${fd.if_text_any ? "checked" : ""}/></label>` : ""}
    </div>`;
  }).join("");
  return `<label class="flab" title="when templates overlap the same tile, higher priority wins">priority <input type="number" class="iprio" step="1" value="${it.priority || 0}"></label>
    <div class="muted il-h">tells</div>${tells || '<div class="muted">draw a tell on the cutout</div>'}
    <div class="muted il-h">fields</div>${fields || '<div class="muted">draw a field on the cutout</div>'}
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
      <button class="kdel danger" data-i="${i}" ${used.length <= 1 ? "disabled" : ""} title="remove from the key">✕</button>
    </div>`).join("");
  const addable = fids.filter((f) => !used.includes(f));
  return `<div class="muted il-h" title="which fields identify a record — reads with the same key merge; a different key (e.g. another level) is its own record. A record missing any key part is dropped.">key</div>
    ${rows}
    <div class="key-row">
      ${addable.length ? `<select class="kadd"><option value="">+ field…</option>${addable.map((f) => `<option>${esc(f)}</option>`).join("")}</select>` : ""}
      <label class="flab" title="joins the parts in the stored key">sep <input class="ksep" value="${esc(eff.sep ?? "|")}" size="2"/></label>
      <label class="flab" title="treat keys differing only in case as distinct">case <input type="checkbox" class="kcase" ${eff.case_sensitive ? "checked" : ""}/></label>
    </div>
    <div class="key-prev" title="the key the last read would store under">${keyPrevHTML(w.id, it.id)}</div>`;
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
  if (key !== null) return `→ <b class="conf-ok">${esc(key)}</b>`;
  const used = eff.fields && eff.fields.length ? eff.fields : ["name"];
  const miss = used.find((f) => vals[f] === null || vals[f] === undefined || vals[f] === "");
  return `<span class="tc-bad">∅ no key${miss ? ` — ${esc(miss)} read empty` : ""}</span> <span class="muted">(record dropped)</span>`;
}

// Wire an item node's id + tells/fields lists (rebuildNode re-binds these,
// preserving the live cutout canvas).
function wireItemControls(div, n) {
  const winId = n.win.id, itemId = n.ref.id;
  // any tell/field config edit re-reads the cutout (bubbles after the specific handler
  // that updated the model, so the read reflects the new setting). Debounced.
  div.addEventListener("change", () => scheduleItemRead(winId, itemId));
  div.querySelector(".gi-id").addEventListener("change", (e) => {
    const newId = e.target.value.trim();
    if (!model.renameItem(winId, itemId, newId)) { e.target.value = itemId; return; }
    movePos(`item:${winId}:${itemId}`, `item:${winId}:${newId}`);
    render(); autosave();
  });
  div.querySelectorAll(".iset").forEach((inp) => inp.addEventListener("change", (e) => {
    const tid = e.target.dataset.tid, k = e.target.dataset.k;
    let v = e.target.value;
    if (k === "locate") { for (const t of n.ref.tells) t.locate = false; v = e.target.checked; }
    else if (k === "threshold") v = +e.target.value || 0;
    model.setItemTellProp(winId, itemId, tid, k, v);
    if (k === "locate") rebuildNode(n.id);   // show/hide the per-tell align dropdown
    gridPreviews.delete(winId); gridReads.delete(winId); refreshImageBoxes(winId); autosave();
  }));
  // persist the field a text tell's dropdown is SHOWING (the default option never
  // fires a change, so it'd otherwise stay unset and reject every row)
  div.querySelectorAll('.iset[data-k="field"]').forEach((sel) => {
    const t = model.itemTell(winId, itemId, sel.dataset.tid);
    if (t && !t.field && sel.value) { t.field = sel.value; autosave(); }
  });
  div.querySelectorAll(".ti-del").forEach((b) => b.addEventListener("click", () => {
    model.removeItemTell(winId, itemId, b.dataset.tid);
    refreshItemBoxes(winId, itemId); rebuildNode(n.id); gridPreviews.delete(winId); gridReads.delete(winId); autosave();
  }));
  div.querySelectorAll(".iset-fid").forEach((inp) => inp.addEventListener("change", (e) => {
    model.renameItemField(winId, itemId, e.target.dataset.fid, e.target.value.trim());
    refreshItemBoxes(winId, itemId); rebuildNode(n.id); gridPreviews.delete(winId); gridReads.delete(winId); autosave();
  }));
  // per-field config (same as the old region node): edits the window FieldDef
  div.querySelectorAll(".ffset").forEach((inp) => inp.addEventListener("change", (e) => {
    const f = model.itemField(winId, itemId, e.target.dataset.fid);
    const fd = f && (n.win.fields || []).find((x) => x.id === f.field);
    if (!fd) return;
    const k = e.target.dataset.k;
    if (k === "type") { fd.type = e.target.value; rebuildNode(n.id); }       // toggles extract/sep/pips
    else if (k === "extract") { fd.extract = e.target.value; rebuildNode(n.id); }  // toggles separator
    else if (k === "sep") fd.separator = e.target.value || "/";
    else if (k === "learn") fd.learn = e.target.checked;
    else if (k === "fuzzy") fd.fuzzy = +e.target.value;
    else if (k === "empty") fd.empty = e.target.value || null;
    else if (k === "ifnum") fd.if_number = e.target.value || null;
    else if (k === "ifnumany") fd.if_number_any = e.target.checked;
    else if (k === "iftext") fd.if_text = e.target.value || null;
    else if (k === "iftextany") fd.if_text_any = e.target.checked;
    else if (k === "dictmode") fd.dict_mode = e.target.value;
    else if (k === "usedict") { fd.dictionary = e.target.value || ""; render(); }   // redraw the muted dict link
    gridPreviews.delete(winId); gridReads.delete(winId); autosave();
  }));
  div.querySelectorAll(".if-del").forEach((b) => b.addEventListener("click", () => {
    model.removeItemField(winId, itemId, b.dataset.fid);
    refreshItemBoxes(winId, itemId); rebuildNode(n.id); gridPreviews.delete(winId); gridReads.delete(winId); autosave();
  }));
  div.querySelectorAll(".itell").forEach((inp) => inp.addEventListener("change", (e) => {
    model.setItemFieldTell(winId, itemId, e.target.dataset.fid, e.target.checked);
    rebuildNode(n.id);   // show/hide the tell-conf input
    gridPreviews.delete(winId); gridReads.delete(winId); autosave();
  }));
  div.querySelectorAll(".itellconf").forEach((inp) => inp.addEventListener("change", (e) => {
    model.setItemFieldTellConf(winId, itemId, e.target.dataset.fid, +e.target.value || 0);
    gridPreviews.delete(winId); gridReads.delete(winId); autosave();
  }));
  div.querySelectorAll(".itellalign").forEach((sel) => sel.addEventListener("change", (e) => {
    model.setItemFieldAlign(winId, itemId, e.target.dataset.fid, e.target.value);
    gridPreviews.delete(winId); gridReads.delete(winId); refreshImageBoxes(winId); autosave();
  }));
  const prio = div.querySelector(".iprio");
  if (prio) prio.addEventListener("change", (e) => {
    model.setItemPriority(winId, itemId, parseInt(e.target.value, 10) || 0);
    gridPreviews.delete(winId); gridReads.delete(winId); refreshImageBoxes(winId); autosave();
  });
  // record-key config: mutate the item's own KeyDef (created from the effective one on
  // first edit) and rebuild the node — the key preview recomputes instantly from the
  // cached read; no OCR needed.
  const keyEdit = (fn) => {
    const k = model.ensureItemKey(winId, itemId);
    if (!k) return;
    fn(k);
    rebuildNode(n.id); autosave();
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
  // Click a tell/field row to SELECT its box on the cutout — the only way to reach a
  // box that's drawn under another. Routes through the chokepoint (highlights it,
  // deselects others, enables WASD).
  const selectItemBox = (boxId, row) => {
    const ent = itemCanvases.get(`${winId}:${itemId}`);
    if (ent) ent.overlay.setActive(boxId);
    overlaySelected(`item:${winId}:${itemId}`, boxId);
    div.querySelectorAll(".ti-row,.if-row").forEach((r) => r.classList.remove("il-sel"));
    row.classList.add("il-sel");
  };
  div.querySelectorAll(".ti-row").forEach((row) => row.addEventListener("mousedown", (ev) => {
    if (ev.target.closest("input,select,button,label")) return;
    selectItemBox(row.dataset.tid, row);
  }));
  div.querySelectorAll(".if-row").forEach((row) => row.addEventListener("mousedown", (ev) => {
    if (ev.target.closest("input,select,button")) return;
    selectItemBox(row.dataset.fid, row);
  }));
}

// Wire the window node's controls (extracted so rebuildNode can re-bind them
// without recreating the node — which would destroy the embedded image canvas).
function wireWindowControls(div, n) {
  div.querySelector(".gi-id").addEventListener("change", (e) => {
    const oldId = n.ref.id, newId = e.target.value.trim();
    const oldDs = model.datasetOf(n.ref);   // a default dataset (id == window id) renames with it
    if (!model.renameWindow(oldId, newId)) { e.target.value = oldId; return; }
    moveWindowPos(oldId, newId);            // win + all child nodes
    const newDs = model.datasetOf(n.ref);
    if (newDs !== oldDs) movePos(`ds:${oldDs}`, `ds:${newDs}`);
    render(); autosave();
  });
  div.querySelector(".imgbtn").addEventListener("click", () => openCaptureModal(n.ref.id));
  updateImageLabel(n.ref.id, div.querySelector(".imgbtn"));   // show the bound filename
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
    const types = TYPES.map(([v, t]) => `<option value="${v}" ${f.type === v ? "selected" : ""}>${t}</option>`).join("");
    const exs = EXTRACTS.map((v) => `<option ${(f.extract || "whole") === v ? "selected" : ""}>${v}</option>`).join("");
    const pips = f.type === "pips" || f.type === "diamonds";
    return {
      title: `<input class="gi gi-id" data-k="regid" value="${esc(n.ref.id)}" title="region / field id" />`,
      body: `<label class="flab">type <select class="fset" data-k="type">${types}</select></label>
        ${pips ? "" : `<label class="flab">extract <select class="fset" data-k="extract">${exs}</select></label>`}
        ${(!pips && NEEDS_SEP.has(f.extract)) ? `<label class="flab">separator <input class="fset" type="text" data-k="sep" value="${esc(f.separator || "/")}" /></label>` : ""}
        <label class="flab">learn <input type="checkbox" class="fset" data-k="learn" ${f.learn ? "checked" : ""}/></label>
        <label class="flab">fuzzy <input type="number" class="fset" data-k="fuzzy" step="0.05" min="0" max="1" value="${f.fuzzy ?? 0.82}"/></label>
        <label class="flab" title="value used when the read is truly empty (no text, no numbers)">if empty <input class="fset" data-k="empty" value="${esc(f.empty || "")}" placeholder="(blank)" /></label>
        ${f.type === "text" ? `<label class="flab" title="value substituted when the read is numbers">if number <input class="fset" data-k="ifnum" value="${esc(f.if_number ?? "")}" placeholder="(off)" /></label>
        <label class="flab" title="checked: fire when the read merely contains a digit; unchecked: only an all-number read">any digit <input type="checkbox" class="fset" data-k="ifnumany" ${f.if_number_any ? "checked" : ""}/></label>
        <label class="flab" title="off = dictionary not consulted; correct = fix words, keep unmatched; drop = no fixes, unmatched read dropped; correct + drop = fix words, unmatchable read dropped">dict <select class="fset" data-k="dictmode">${DICT_MODES.map(([v, t]) => `<option value="${v}" ${(f.dict_mode || "correct") === v ? "selected" : ""}>${t}</option>`).join("")}</select></label>
        ${(model.profile.dictionaries || []).length ? `<label class="flab" title="which authored dictionary this field snaps to (all = every enabled one pooled)">use dict <select class="fset" data-k="usedict">${dictOptions(f.dictionary)}</select></label>` : ""}` : ""}
        ${f.type === "number" ? `<label class="flab" title="value substituted when the read is text">if text <input class="fset" data-k="iftext" value="${esc(f.if_text ?? "")}" placeholder="(off)" /></label>
        <label class="flab" title="checked: fire when the read merely contains a letter; unchecked: only an all-text read">any letter <input type="checkbox" class="fset" data-k="iftextany" ${f.if_text_any ? "checked" : ""}/></label>` : ""}
        <div class="gn-foot"></div>`,
    };
  }
  if (n.type === "detect") {
    const a = n.ref;
    return {
      title: `<input class="gi gi-id" data-k="detid" value="${esc(a.id)}" title="detector: all must match to capture" />`,
      body: `<label class="flab">text <input class="aset" data-k="text" value="${esc(a.text || "")}" placeholder="EQUIPMENT" /></label>
        <label class="flab">read ⊆ text <input type="checkbox" class="aset" data-k="incl" ${a.included ? "checked" : ""} title="match if the read word is included in this text" /></label>
        <label class="flab">threshold <input type="number" class="aset" data-k="thr" step="0.05" min="0" max="1" value="${a.threshold ?? 0.8}" /></label>
        <div class="detect-status muted">◯ —</div>
        <div class="gn-foot"></div>`,
    };
  }
  if (n.type === "item") {
    return { title: `<input class="gi gi-id" data-k="itemid" value="${esc(n.ref.id)}" title="item template" />`,
      body: `<div class="item-img"></div><div class="item-lists">${itemLists(n.ref, n.win)}</div>` };
  }
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
      body: `<div class="gn-foot"><button class="prevrun">↻ read</button></div>
      <div class="nodehost scrollhost prev-host"><p class="muted" style="padding:8px">↻ read to preview what this window reads</p></div>`,
    };
  }
  if (n.type === "subset") return subsetParts(n.ref);
  if (n.type === "price") return priceParts(n.ref);
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
  const agg = model.datasetAggregate(ds);
  const aggOpts = AGGREGATES.map((a) => `<option${a === agg ? " selected" : ""}>${a}</option>`).join("");
  return {
    title: `<input class="gi gi-id dsrename" value="${esc(ds)}" title="dataset name" />`,
    body: `<label class="flab ds-agg" title="how each key's many observations collapse to one value">many → <select class="dsagg">${aggOpts}</select></label>
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
  const chips = inputs.map((d) => `<span class="sv-input">${esc(d)}<button class="sv-rmin danger" data-ds="${esc(d)}" title="remove input">✕</button></span>`).join("")
    || '<span class="muted sub-empty">none — add a source to join</span>';
  const addOpts = `<option value="">+ join source…</option>` + free.map((d) => `<option>${esc(d)}</option>`).join("");
  const filters = (s.filters || []).map((f, i) => `<div class="sub-row" data-i="${i}">
      <select class="sf-field" data-i="${i}">${_colOpts(cols, f.field)}</select>
      <select class="sf-op" data-i="${i}">${SUB_OPS.map((o) => `<option${o === f.op ? " selected" : ""}>${o}</option>`).join("")}</select>
      <input class="sf-val" data-i="${i}" value="${esc(f.value || "")}" placeholder="value" />
      <button class="sf-del danger" data-i="${i}" title="remove filter">✕</button></div>`).join("");
  const derived = (s.derived || []).map((d, i) => `<div class="sub-row" data-i="${i}">
      <input class="sd-name" data-i="${i}" value="${esc(d.name || "")}" placeholder="new column" />
      <span class="muted">=</span>
      <input class="sd-tpl" data-i="${i}" value="${esc(d.template || "")}" placeholder="{=count*price_median} plat" />
      <button class="sd-del danger" data-i="${i}" title="remove column">✕</button></div>`).join("");
  return `
    <div class="sub-sec"><div class="sub-lbl">sources <span class="muted">(datasets or views, joined on key)</span></div>
      <div class="sv-inputs">${chips}</div>
      <div class="sub-row"><select class="sv-addin">${addOpts}</select>
        <label class="flab">join on <input class="sv-join" value="${esc(s.join_field || "name")}" placeholder="name" /></label></div></div>
    <div class="sub-sec"><div class="sub-lbl">filters <span class="muted">(all must pass)</span></div>${filters}
      <button class="sub-addf">+ filter</button></div>
    <div class="sub-sec"><div class="sub-lbl">columns <span class="muted">({col} text · {=expr} math · mix freely)</span></div>${derived}
      <button class="sub-addd">+ column</button></div>
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

async function refreshSubsetNode(id) {
  const el = nodeEls.get(`sub:${id}`);
  const host = el && el.querySelector(".sub-host");
  if (!host) return;
  try {
    const r = await api.getSubset(model.profile.name, id);
    const vt = vtableFor(`view:${id}`, host);
    const s = model.subsetDef(id);
    // dragging a column in the table re-orders the visible/hide buttons to match, live
    vt.onReorder = () => renderHideToggles(nodeEls.get(`sub:${id}`), s);
    vt.setData(r.columns || [], r.rows || []);
    // the live join may expose columns the static schema can't know (orders/enrich fields) —
    // cache them and re-render the visible/hide toggles so every actual column is listed.
    subsetLiveCols.set(id, r.columns || []);
    if (s) renderHideToggles(el, s);
  } catch (e) {
    // a just-added subset isn't on the backend until the profile saves (debounced) —
    // that's a transient 404, not an error; the post-save refresh fills it in.
    const msg = /\b404\b/.test(String(e.message || e)) ? "no data yet" : String(e.message || e);
    vtables.delete(`view:${id}`);
    host.innerHTML = `<p class="muted" style="padding:8px">${esc(msg)}</p>`;
  }
}

function refreshAllSubsetNodes() {
  for (const s of model.profile.subsets || []) if (nodeEls.has(`sub:${s.id}`)) refreshSubsetNode(s.id);
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

  // join inputs — adding/removing a dataset changes the wiring, so render()
  div.querySelector(".sv-addin")?.addEventListener("change", (e) => {
    if (model.addSubsetInput(s.id, e.target.value)) { render(); autosave(); refreshSubsetNode(s.id); }
  });
  div.querySelectorAll(".sv-rmin").forEach((b) => b.addEventListener("click", () => {
    model.removeSubsetInput(s.id, b.dataset.ds); render(); autosave(); refreshSubsetNode(s.id);
  }));
  div.querySelector(".sv-join")?.addEventListener("change", (e) => { model.setJoinField(s.id, e.target.value.trim()); recompute(); });

  // filters
  div.querySelectorAll(".sf-del").forEach((b) => b.addEventListener("click", () => { model.removeFilter(s.id, +b.dataset.i); restructure(); }));
  div.querySelectorAll(".sf-field").forEach((el) => el.addEventListener("change", (e) => { s.filters[+el.dataset.i].field = e.target.value; recompute(); }));
  div.querySelectorAll(".sf-op").forEach((el) => el.addEventListener("change", (e) => { s.filters[+el.dataset.i].op = e.target.value; recompute(); }));
  div.querySelectorAll(".sf-val").forEach((el) => el.addEventListener("change", (e) => { s.filters[+el.dataset.i].value = e.target.value; recompute(); }));

  // derived columns — editing a name changes the available column set, so restructure
  div.querySelectorAll(".sd-del").forEach((b) => b.addEventListener("click", () => { model.removeDerived(s.id, +b.dataset.i); restructure(); }));
  div.querySelectorAll(".sd-name").forEach((el) => el.addEventListener("change", (e) => { s.derived[+el.dataset.i].name = e.target.value.trim(); restructure(); }));
  div.querySelectorAll(".sd-tpl").forEach((el) => el.addEventListener("change", (e) => { s.derived[+el.dataset.i].template = e.target.value; recompute(); }));

  // hide/show result columns — toggling changes the column set, so restructure
  wireHideToggles(div, s);
  // sort/limit removed — the table sorts itself (click a column header)

  queueMicrotask(() => refreshSubsetNode(s.id));
}

// ---- price producer node: sweeps the market into its output dataset ---------

function wirePrice(div, n) {
  // the full producer panel (sweep, stored count, movers, history chart). The out-port
  // (drag to a dataset) is wired generically by wireOutPort.
  // when a sweep ends (or is cancelled), refresh the dataset it feeds so its new batch shows
  wirePriceNode(div, model.profile.name, n.ref.dataset, n.ref.mode || "statistics", () => {
    refreshLive(); refreshDataNode(n.ref.dataset); loadBatchesNode(n.ref.dataset);
  });
  // source toggle: statistics (history) vs live orders (now). Mode swaps the body, so rebuild.
  div.querySelector(".enr-mode")?.addEventListener("change", (e) => {
    model.setPriceMode(n.ref.id, e.target.value); rebuildNode(n.id); autosave();
  });
  // rename the price node (its id) — carry its saved layout slot to the new id, then re-render
  div.querySelector(".prrename")?.addEventListener("change", (e) => {
    const oldId = n.ref.id, newId = (e.target.value || "").trim();
    if (!model.renamePriceNode(oldId, newId)) { e.target.value = oldId; return; }
    movePos(`price:${oldId}`, `price:${newId}`); render(); autosave();
  });
  // unwire a priced-item source (the dataset/view it prices) — removes the input edge
  div.querySelectorAll(".pr-rmsrc").forEach((b) => b.addEventListener("click", () => {
    model.removePriceSource(n.ref.id, b.dataset.ds); render(); autosave();
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
  // so an in-place chip add/remove wouldn't show. drawEdges() drops/adds the trigger→price line.
  div.querySelector(".tg-addwatch")?.addEventListener("change", (e) => { if (model.addTriggerWatch(t.id, e.target.value)) { rebuildNode(t.id); autosave(); } });
  div.querySelectorAll(".tg-rmwatch").forEach((b) => b.addEventListener("click", () => { model.removeTriggerWatch(t.id, b.dataset.ds); rebuildNode(t.id); autosave(); }));
  div.querySelectorAll(".tg-rmtarget").forEach((b) => b.addEventListener("click", () => { model.removeTriggerTarget(t.id, b.dataset.p); rebuildNode(t.id); drawEdges(); autosave(); }));
  div.querySelector(".tg-fire")?.addEventListener("click", async () => {
    const prog = div.querySelector(".tg-prog");
    prog.textContent = "firing…";
    try { const r = await api.triggers.fire(model.profile.name, t.id); prog.textContent = `fired ${(r.started || []).length} sweep(s)`; refreshLive(); }
    catch (err) { prog.textContent = String(err.message || err); }
  });
}

const CAN_DISABLE = new Set(["window", "item", "region", "detect", "scrollbar", "dictionary", "price", "trigger"]);
const REMOVABLE = new Set(["window", "item", "region", "detect", "scrollbar", "dictionary", "subset", "dataset", "price", "trigger"]);

// One place to remove any node; each goes through render()+autosave() so undo/redo
// records it (autosave -> pushHistory).
function removeNode(n) {
  if (n.type === "window") { closeImage(n.ref.id); model.removeWindow(n.ref.id); pos.delete(n.id); render(); autosave(); }
  else if (n.type === "item") {
    const winId = n.win.id, itemId = n.ref.id;
    closeItemImage(winId, itemId); model.removeItem(winId, itemId); pos.delete(n.id);
    gridPreviews.delete(winId); gridReads.delete(winId); render(); refreshImageBoxes(winId); autosave();
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

function fillNode(div, n) {
  const isCollapsed = collapsed.has(n.id);
  const canToggle = CAN_DISABLE.has(n.type);
  const enabled = !(canToggle && n.ref && n.ref.enabled === false);
  div.className = `gnode ${n.type}${isCollapsed ? " collapsed" : ""}${enabled ? "" : " node-disabled"}`;
  if (n.type === "dataset") { div.dataset.ds = n.ref; div.dataset.tab = dsTab.get(n.ref) || "data"; }
  const parts = nodeParts(n);
  const toggle = canToggle
    ? `<button type="button" class="gn-enable${enabled ? " on" : ""}" role="switch" aria-checked="${enabled}" title="enabled — turn off to skip this node during detection">
        <svg viewBox="0 0 28 16" width="28" height="16" aria-hidden="true">
          <rect class="gt-track" x="1" y="1" width="26" height="14" rx="7" />
          <circle class="gt-thumb" cx="8" cy="8" r="5" />
        </svg></button>`
    : "";
  const del = REMOVABLE.has(n.type) ? `<button class="gn-del danger" title="remove (click again to confirm)" aria-label="remove">
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
      <button class="collapse" title="collapse/expand">${isCollapsed ? "▸" : "▾"}</button>${parts.title}${parts.head || ""}${detach}${toggle}${del}</div>
    <div class="gn-body">${parts.body}</div>
    <span class="gn-spin" title="working…"></span>${parts.ports || ""}`;
  div.querySelector(".collapse").addEventListener("click", () => toggleCollapse(n.id));
  div.querySelector(".gn-detach").addEventListener("click", (e) => { e.stopPropagation(); groups.detachNode(n.id); });
  div.classList.toggle("in-group", !!groups.groupOf(n.id));
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
    if (winId) { gridPreviews.delete(winId); gridReads.delete(winId); refreshImageBoxes(winId); }
    autosave(on);   // disabling shouldn't trigger re-reads in other nodes
  });
  if (busy.get(n.id)) div.classList.add("busy");   // preserve spinner across rebuilds
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

function wireOutPort(div, n) {
  const port = div.querySelector(".port.out");
  if (!port) return;
  const spec = outPortSpec(n);
  if (!spec) return;
  div._outSpec = spec; div._outId = n.id;   // reused by placePortDots to wire per-line dots
  port.addEventListener("mousedown", (ev) => startWire(n.id, ev, spec));
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
    onSettle: () => { nodeSizes.set(id, { w: div.offsetWidth, h: div.offsetHeight }); drawEdges(); groups.renderGroups(); persist.layout(); },
    // reset dot: drop the user's size back to the node's natural CSS size
    onReset: () => {
      nodeSizes.delete(id);
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

function buildNode(n) {
  const div = document.createElement("div");
  div.id = `node-${n.id}`;
  div.dataset.id = n.id;
  fillNode(div, n);
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
}

function toggleCollapse(id) {
  const willCollapse = !collapsed.has(id);
  if (willCollapse) collapsed.add(id); else collapsed.delete(id);
  const el = nodeEls.get(id);
  if (el) {
    el.classList.toggle("collapsed", willCollapse);
    const b = el.querySelector(".collapse"); if (b) b.textContent = willCollapse ? "▸" : "▾";
    if (willCollapse) {                       // drop the hard inline w/h -> header only (CSS)
      el.style.width = ""; el.style.height = "";
    } else {                                  // expand: restore from the persisted size
      const s = nodeSizes.get(id);            // (survives reload; el._size would not)
      if (s) { if (s.w) el.style.width = `${s.w}px`; if (s.h) el.style.height = `${s.h}px`; }
    }
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
  renderNodeMap();
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
  for (const [, el] of nodeEls) el.classList.remove("selected");
  clearNodeSelections();
  selectedNodeId = null;
  activeOverlayKey = null;
  clearMultiSelect();
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
  const bar = $("seltoolbar"), cnt = $("selCount");
  if (bar) bar.hidden = selected.size < 2;
  if (cnt) cnt.textContent = `${selected.size} selected`;
}

// Show the unlock icon only on nodes that currently belong to a group.
function refreshDetachIcons() {
  for (const [id, el] of nodeEls) el.classList.toggle("in-group", !!groups.groupOf(id));
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

function onWheel(ev) {
  // a SELECTED preview, or the batches ledger, scrolls its content; everywhere else zoom
  if (ev.target.closest(".scrollhost")) return;
  ev.preventDefault();
  const rect = $("graph").getBoundingClientRect();
  const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
  const old = view.zoom;
  const z = Math.min(8, Math.max(0.15, old * (ev.deltaY < 0 ? 1.1 : 1 / 1.1)));
  // keep the world point under the cursor fixed
  view.panX = mx - (mx - view.panX) * (z / old);
  view.panY = my - (my - view.panY) * (z / old);
  view.zoom = z;
  applyView(); updateOverlayZoom(); persist.local();
}

const nw = (id) => nodeEls.get(id)?.offsetWidth || 220;   // node width (right edge)
const nh = (id) => nodeEls.get(id)?.offsetHeight || 80;   // node height

// Double-click a node: fit it tight to the viewport and centre it (smooth, shared with
// the node-map jump so both frame a node the same way).
function zoomToNode(id) { panZoomTo(id, { fit: true }); }

// Bezier whose tangents leave each endpoint along an outward direction (L/R/T/B) so
// the line starts the right way. This is the LIVE line: shown while a node is being
// dragged (follows the cursor), and the shape a routed line morphs out of on settle.
const _OFFK = (x1, y1, x2, y2) => Math.max(30, Math.hypot(x2 - x1, y2 - y1) * 0.4);
const _DIROFF = { L: [-1, 0], R: [1, 0], T: [0, -1], B: [0, 1] };
function dirBezierCtrls(x1, y1, d1, x2, y2, d2) {
  const k = _OFFK(x1, y1, x2, y2);
  const a = _DIROFF[d1] || [0, 0], b = _DIROFF[d2] || [0, 0];
  return [[x1 + a[0] * k, y1 + a[1] * k], [x2 + b[0] * k, y2 + b[1] * k]];
}
function dirBezierD(x1, y1, d1, x2, y2, d2) {
  const [c1, c2] = dirBezierCtrls(x1, y1, d1, x2, y2, d2);
  return `M ${x1} ${y1} C ${c1[0]} ${c1[1]}, ${c2[0]} ${c2[1]}, ${x2} ${y2}`;
}
function sampleDirBezier(x1, y1, d1, x2, y2, d2, n) {
  const [c1, c2] = dirBezierCtrls(x1, y1, d1, x2, y2, d2);
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push([u * u * u * x1 + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * x2,
              u * u * u * y1 + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * y2]);
  }
  return out;
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
const straightD = (pts) => "M " + pts.map((p) => `${Math.round(p[0] * 10) / 10} ${Math.round(p[1] * 10) / 10}`).join(" L ");

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

// Centre point of one named side of a rect.
function portOnSide(r, side) {
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  if (side === "R") return [r.x + r.w, cy];
  if (side === "L") return [r.x, cy];
  if (side === "B") return [cx, r.y + r.h];
  return [cx, r.y];   // "T"
}
const sidesFrom = (ra, rb, d1, d2) => ({ p1: portOnSide(ra, d1), d1, p2: portOnSide(rb, d2), d2 });

// The (≤2) sides of a rect whose outward normal points toward (tx,ty): the only sides
// worth considering for an edge heading that way (a back-facing side would U-turn).
function sideCandidates(tx, ty) {
  const c = [];
  if (Math.abs(tx) >= 1) c.push(tx > 0 ? "R" : "L");
  if (Math.abs(ty) >= 1) c.push(ty > 0 ? "B" : "T");
  return c.length ? c : ["R"];
}

// Let the ROUTER pick the best pair of sides for a link, not raw distance: score every
// sensible (sideA,sideB) by its actual A* route cost and take the cheapest. A faint bias
// toward the geometric facing breaks ties so a clear straight shot isn't traded for an
// equal-cost detour, and the choice doesn't flicker frame to frame.
function bestSides(router, ra, rb, relax = false) {
  const dx = (rb.x + rb.w / 2) - (ra.x + ra.w / 2), dy = (rb.y + rb.h / 2) - (ra.y + ra.h / 2);
  const aC = sideCandidates(dx, dy), bC = sideCandidates(-dx, -dy);
  const fac = facingSides(ra, rb);
  let best = null, bestCost = Infinity;
  for (const d1 of aC) for (const d2 of bC) {
    let cost = router.routeCost(portOnSide(ra, d1), d1, portOnSide(rb, d2), d2, relax);
    if (d1 === fac.d1 && d2 === fac.d2) cost *= 0.98;   // tie-break toward the facing pair
    if (cost < bestCost) { bestCost = cost; best = { d1, d2 }; }
  }
  return best || { d1: fac.d1, d2: fac.d2 };
}
// Router-chosen sides per link key, persisted across passes so drawEdges() and
// runRouting() agree on each line's ports (the route cache keys off them).
const sidePick = new Map();

const nodeRect = (id) => { const p = pos.get(id); return p && { x: p.x, y: p.y, w: nw(id), h: nh(id) }; };

// ---- one unified link list -------------------------------------------------
// EVERY connection in the view is the same thing: a line between two NODES — always to
// the node rect, never to a box on the image. They all flow through buildLinks →
// routing → drawn on a persistent per-link <path>. No bespoke per-kind drawing.
function selClsFor(aId, bId) {
  return selectedNodeId && (aId === selectedNodeId || bId === selectedNodeId) ? " sel" : "";
}

// Build the descriptor for every line. `aId`/`bId` name each rect's owner (used to
// fan endpoints that share a node side); `ra`/`rb` are the world rects.
// A data edge always leaves its source node's `.port.out` handle. Every source that draws
// one — window, price, dataset, view (subset) — anchors its data line at the port dot and
// gets the animated flow. (Keep this prefix set in sync with `outPortSpec`.)
const PORT_OUT_SRC = ["win:", "price:", "ds:", "sub:"];
// a data edge leaves its source's out-port; a trigger's control edge leaves the trigger's out-port too
const fromPortOut = (aId, kind) =>
  (kind === "data" && PORT_OUT_SRC.some((p) => aId.startsWith(p))) ||
  (kind === "trigger" && aId.startsWith("trigger:"));
function buildLinks() {
  const links = [];
  const add = (key, aId, bId, top, kind, ra, rb) => {
    if (!ra || !rb) return;
    const port = fromPortOut(aId, kind);
    const tgt = bId.startsWith("sub:") ? " toview" : "";
    links.push({ key, aId, bId, top, port, cls: `gedge ${kind}${port ? " flow" : ""}${tgt}${selClsFor(aId, bId)}`, ra, rb });
  };
  for (const e of model.edges())
    add(`${e.from} ${e.to}`, e.from, e.to, !!selClsFor(e.from, e.to), e.kind, nodeRect(e.from), nodeRect(e.to));
  computePorts(links);
  return links;
}

// Pick each line's port + side, then fan endpoints that share a node side so they sit
// one GAP apart instead of all stacking on the side's midpoint.
const GAP = () => ROUTE.cell * 2;   // preferred spacing: fanned endpoints AND parallel bundles (a line can still squeeze to 1 cell between two)
// both node ids belong to the same (non-null) group
function sameGroup(aId, bId) { const g = groups.groupOf(aId); return !!g && g === groups.groupOf(bId); }
function computePorts(links) {
  for (const l of links) {
    // use the router's chosen sides when it has scored this link, else the geometric facing
    const pick = sidePick.get(l.key);
    const f = pick ? sidesFrom(l.ra, l.rb, pick.d1, pick.d2) : facingSides(l.ra, l.rb);
    l.p1 = f.p1; l.d1 = f.d1; l.p2 = f.p2; l.d2 = f.d2;
    l.align = false;
    l.relax = sameGroup(l.aId, l.bId);   // grouped lines route with relaxed clearance
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
      const spread = Math.max(0, Math.min(span - gap, (n - 1) * gap));   // keep ports on the edge
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

// Per-line out-ports: EVERY data line leaving a node gets its OWN dot at its start, so a node
// that fans out N lines shows N dots (one per line) instead of all lines sharing a single dot.
// The base `.port.out` is dot #0 (and the drag handle); extra dots are cloned + wired the same
// way. Each dot FOLLOWS its line — routing (facingSides + fan) picks the start coord, the dot
// moves onto that exact node-relative point. A node with no outgoing line keeps its default dot.
function ensurePortDots(node, count) {
  const base = node.querySelector(".port.out");
  if (!base) return [];
  let extras = [...node.querySelectorAll(".port.out.port-extra")];
  while (extras.length < count - 1) {                 // grow the pool
    const d = base.cloneNode(false);                  // listeners aren't cloned — wire below
    d.classList.add("port-extra");
    if (node._outSpec && node._outId) d.addEventListener("mousedown", (ev) => startWire(node._outId, ev, node._outSpec));
    node.appendChild(d); extras.push(d);
  }
  for (let i = count - 1; i < extras.length; i++) extras[i].remove();   // shrink the pool
  return [base, ...extras.slice(0, Math.max(0, count - 1))];
}

function placePortDots(links) {
  const bySrc = new Map();   // source node id -> its outgoing port-lines
  for (const l of links) {
    if (!l.port) continue;
    (bySrc.get(l.aId) || bySrc.set(l.aId, []).get(l.aId)).push(l);
  }
  // source nodes with NO outgoing line: drop extras + reset the base dot to its CSS default
  for (const [id, node] of nodeEls) {
    if (bySrc.has(id)) continue;
    node.querySelectorAll(".port.out.port-extra").forEach((d) => d.remove());
    const base = node.querySelector(".port.out");
    if (base && base.style.left) { base.style.cssText = ""; base.classList.remove("sel"); }
  }
  for (const [aId, ls] of bySrc) {
    const node = nodeEls.get(aId);
    if (!node) continue;
    const dots = ensurePortDots(node, ls.length);
    ls.forEach((l, i) => {
      const dot = dots[i]; if (!dot) return;
      // -1: the dot is absolutely positioned in the node's PADDING box (inside its 1px
      // border), but l.p1/ra are border-box world coords — without it the dot sits 1px off
      dot.style.left = `${l.p1[0] - l.ra.x - 1}px`;
      dot.style.top = `${l.p1[1] - l.ra.y - 1}px`;
      dot.style.right = "auto";
      dot.style.transform = "translate(-50%, -50%)";
      const sel = l.cls.includes(" sel");
      dot.classList.toggle("sel", sel);   // edge selected (either end) -> accent (CSS)
      // match the dot to the colour of the line leaving it (clear inline when selected so the
      // .sel accent rule wins): data lines are orange, trigger control lines are the warn hue
      dot.style.background = sel ? "" : (l.cls.includes("trigger") ? "var(--warn)" : "#ff8c2b");
    });
  }
}

// Persistent <path> per link (NOT rebuilt each draw) — lets a line keep its identity
// so it can follow the cursor live, then morph into its routed shape on settle.
const edgeEls = new Map();   // link key -> <path>
let wireEl = null;
let tweenRoutes = false;     // set by runRouting so the NEXT draw morphs the lines that changed
let _resizing = false;       // a node is being resized — draw cheap straight lines, no A*/bezier
let _resizeRaf = null;       // coalesces resize-driven redraws to one per frame
let _ptrDown = false;        // is a mouse button held? (a ResizeObserver tick is only a user
if (typeof window !== "undefined") {                          // resize when the pointer is down)
  window.addEventListener("mousedown", () => { _ptrDown = true; }, true);
  window.addEventListener("mouseup", () => { _ptrDown = false; }, true);
}

function edgeEl(key, layer) {
  let el = edgeEls.get(key);
  if (!el) { el = document.createElementNS(SVGNS, "path"); edgeEls.set(key, el); }
  if (el.parentNode !== layer) layer.appendChild(el);
  return el;
}
function cancelMorph(el) { if (el && el._raf) { cancelAnimationFrame(el._raf); el._raf = null; } }
function setRouted(el, pts) {
  cancelMorph(el);
  el._geo = pts; el._routed = true;
  el.setAttribute("d", polylinePath(pts, ROUTE.corners, ROUTE.radius));
}
function setBezier(el, l) {
  cancelMorph(el);
  el._geo = sampleDirBezier(l.p1[0], l.p1[1], l.d1, l.p2[0], l.p2[1], l.d2, 24);
  el._routed = false;
  el.setAttribute("d", dirBezierD(l.p1[0], l.p1[1], l.d1, l.p2[0], l.p2[1], l.d2));
}

const MORPH_MS = 150, MORPH_N = 32;
function startMorph(el, toPts) {
  const from = resamplePoly(el._geo && el._geo.length ? el._geo : toPts, MORPH_N);
  const to = resamplePoly(toPts, MORPH_N);
  cancelMorph(el);
  const t0 = performance.now();
  const tick = (now) => {
    let t = (now - t0) / MORPH_MS; if (t < 0) t = 0; if (t > 1) t = 1;
    const e = t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;   // easeInOutQuad
    el.setAttribute("d", straightD(from.map((p, i) => [p[0] + (to[i][0] - p[0]) * e, p[1] + (to[i][1] - p[1]) * e])));
    if (t < 1) el._raf = requestAnimationFrame(tick);
    else { el._raf = null; setRouted(el, toPts); }   // land on the crisp rounded route
  };
  el._raf = requestAnimationFrame(tick);
}
// cache route still matches the link's live ports? (node not moved since it was routed)
function routeFresh(c, l) { return c.k === `${rnd(l.p1)}${l.d1}${rnd(l.p2)}${l.d2}`; }
function geoChanged(el, pts) {
  if (!el._routed || !el._geo || el._geo.length !== pts.length) return true;
  for (let i = 0; i < pts.length; i++)
    if (Math.abs(el._geo[i][0] - pts[i][0]) > 0.5 || Math.abs(el._geo[i][1] - pts[i][1]) > 0.5) return true;
  return false;
}

let drawSig = "";   // link signature for THIS draw (compared against the route cache's)
function drawEdges() {
  const svg = $("gedges"), top = $("gedges-top");
  const links = buildLinks();
  placePortDots(links);   // move each out-port dot onto where its line actually starts
  drawSig = ROUTE.enabled ? linksSig(links) : "";
  const used = new Set();
  for (const l of links) {
    used.add(l.key);
    const el = edgeEl(l.key, l.top ? top : svg);
    el.setAttribute("class", l.cls);
    const c = routeCache.get(l.key);
    if (c && c.pts.length >= 2 && routeFresh(c, l)) {        // have a current route for this line
      if (tweenRoutes && geoChanged(el, c.pts)) startMorph(el, c.pts);
      else if (!el._raf && geoChanged(el, c.pts)) setRouted(el, c.pts);   // only redraw if it changed; leave morphs alone
    } else {
      setBezier(el, l);   // stale route (node moved/resized) → live bezier, then A* re-routes to 90°
    }
  }
  for (const [k, el] of edgeEls) if (!used.has(k)) { cancelMorph(el); el.remove(); edgeEls.delete(k); }
  if (wire) {
    if (!wireEl) wireEl = document.createElementNS(SVGNS, "path");
    if (wireEl.parentNode !== svg) svg.appendChild(wireEl);
    wireEl.setAttribute("class", "gedge wire");
    const dx = Math.max(30, (wire.x2 - wire.x1) / 2);
    wireEl.setAttribute("d", `M ${wire.x1} ${wire.y1} C ${wire.x1 + dx} ${wire.y1}, ${wire.x2 - dx} ${wire.y2}, ${wire.x2} ${wire.y2}`);
  } else if (wireEl) { wireEl.remove(); wireEl = null; }
  tweenRoutes = false;
  scheduleRouting();   // always pathfind — lines stay routed (90°) during resize too
}

// ---- live line routing -----------------------------------------------------
// Pathfinding runs every animation frame, as fast as the browser will paint:
// drawEdges() paints direct beziers instantly for any line whose route is stale and
// requests a recompute; the A* then fires on the next rAF and repaints with neat
// routed paths — so lines re-route LIVE under a drag, not only on settle. Routing is
// incremental + cached (only links whose deps changed re-run) and gated by a layout
// signature, so a frame where nothing moved is a no-op and the loop idles.
const ROUTE = {
  enabled: true,
  corners: "curve",   // "curve" | "square" — internal toggle (window.__route.corners)
  cell: 10,           // grid resolution (world px) — fine enough to squeeze a line between two others
  clearWanted: 5,     // cells of breathing room a line prefers around nodes
  radius: 14,         // corner rounding for "curve"
};
// internal handles: tweak ROUTE in the console, __reroute() to force a recompute
// (e.g. after flipping __route.corners to "square").
if (typeof window !== "undefined") {
  window.__route = ROUTE;
  window.__reroute = () => { routeCache = new Map(); routeHash = ""; drawEdges(); };   // force a full recompute
}

const SVGNS = "http://www.w3.org/2000/svg";
let routeCache = new Map();     // link key -> { pts:[[x,y]…], sig } (sig = its own deps)
let routeHash = "";             // global layout signature of the last pass (cheap change gate)
let routeRaf = null;            // pending requestAnimationFrame handle (one in flight at a time)

// Everything physical is an obstacle: nodes AND panels. Lines weave around all of
// them, not just the two rects they connect.
function obstacleRects() {
  const out = [];
  for (const n of model.nodes()) { const r = nodeRect(n.id); if (r) out.push(r); }
  for (const t of groups.titleRects()) out.push(t);   // lines prefer not to cross a group title
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
  return s;
}

function scheduleRouting() {
  if (!ROUTE.enabled) return;
  if (drawSig === routeHash) return;   // routes already current (drawSig set in drawEdges)
  if (routeRaf) return;                // one recompute already queued for the next frame
  routeRaf = requestAnimationFrame(runRouting);
}

// A link's OWN dependency signature: its endpoints + only the obstacles whose rect
// touches the region its route can occupy (endpoints + last path, padded by the
// clearance margin). So a node moving on the far side of the graph leaves this
// unchanged — that link is NOT rerouted.
function linkDeps(link, obs) {
  const M = ROUTE.cell * (ROUTE.clearWanted + 2);
  let minx = Math.min(link.p1[0], link.p2[0]), maxx = Math.max(link.p1[0], link.p2[0]);
  let miny = Math.min(link.p1[1], link.p2[1]), maxy = Math.max(link.p1[1], link.p2[1]);
  const prev = routeCache.get(link.key);
  if (prev) for (const p of prev.pts) {
    if (p[0] < minx) minx = p[0]; else if (p[0] > maxx) maxx = p[0];
    if (p[1] < miny) miny = p[1]; else if (p[1] > maxy) maxy = p[1];
  }
  minx -= M; miny -= M; maxx += M; maxy += M;
  let s = `${rnd(link.p1)}${link.d1}${rnd(link.p2)}${link.d2}|`;
  for (const o of obs)
    if (o.x < maxx && o.x + o.w > minx && o.y < maxy && o.y + o.h > miny) s += `${o.x},${o.y},${o.w},${o.h};`;
  return s;
}

function runRouting() {
  routeRaf = null;                     // this frame's pass is running; let drawEdges queue the next one
  const links = buildLinks();          // route the layout as it stands NOW
  const sig = linksSig(links);
  if (sig === routeHash) return;
  let routeSig = sig;
  const obs = obstacleRects();
  try {
    const router = new EdgeRouter(obs, { cell: ROUTE.cell, clearWanted: ROUTE.clearWanted });
    // For the links whose neighbourhood changed, let the router choose the cheapest pair
    // of node sides (not raw distance), then re-fan the ports with the new sides. Bounded
    // to the changed links so it costs the same order as the routing itself.
    let sidesChanged = false;
    for (const l of links) {
      const c = routeCache.get(l.key);
      if (c && c.sig === linkDeps(l, obs)) continue;           // neighbourhood unchanged → keep its side
      const best = bestSides(router, l.ra, l.rb, sameGroup(l.aId, l.bId));
      const prev = sidePick.get(l.key);
      if (!prev || prev.d1 !== best.d1 || prev.d2 !== best.d2) { sidePick.set(l.key, best); sidesChanged = true; }
    }
    if (sidesChanged) { computePorts(links); routeSig = linksSig(links); }

    // split into links whose deps are unchanged (keep their cached path) and the rest
    const fresh = new Map(), dirty = [];
    for (const l of links) {
      const lsig = linkDeps(l, obs);
      const c = routeCache.get(l.key);
      if (c && c.sig === lsig) fresh.set(l.key, c);
      else { l._sig = lsig; dirty.push(l); }
    }
    for (const c of fresh.values()) router.stampPath(c.pts);   // reserve the kept corridors so dirty links avoid them
    dirty.sort((a, b) => spanOf(a) - spanOf(b));               // shortest first: short links lock in straight
    for (const l of dirty)
      fresh.set(l.key, { pts: router.route(l.p1, l.d1, l.p2, l.d2, l.relax), sig: l._sig, k: `${rnd(l.p1)}${l.d1}${rnd(l.p2)}${l.d2}` });
    routeCache = fresh;                                        // also drops keys for links that vanished
    for (const k of sidePick.keys()) if (!fresh.has(k)) sidePick.delete(k);   // forget vanished links
    routeHash = routeSig;
  } catch (err) {
    setStatus(`route failed: ${err.message}`);   // surface instead of silently using beziers
    return;
  }
  // No morph: routing reruns every frame, so a dragged line's route is already current
  // each paint — setRouted snaps it crisply. (Morph was for the old debounced settle.)
  drawEdges();
}

function spanOf(l) {
  return Math.abs(l.p2[0] - l.p1[0]) + Math.abs(l.p2[1] - l.p1[1]);
}

// ---- per-node interaction -------------------------------------------------

function wireNode(div, n) {
  // drag-move from anywhere on the node except interactive controls (so all
  // edges/padding/labels work, not just the header)
  div.addEventListener("mousedown", (ev) => {
    if (ev.button !== 0) return;   // only left-drag moves; right-drag pans the canvas
    // the collapse caret and the title input double as drag HANDLES: a real drag moves
    // the node, a plain click still toggles / edits (threshold-gated below).
    const handle = ev.target.closest(".collapse, input.gi-id");
    if (!handle && ev.target.closest("input,select,button,a,.canvas-wrap,[contenteditable],.scrollhost")) return;  // .canvas-wrap: resize handle; .scrollhost: scroll/edit node content
    const r = div.getBoundingClientRect();   // skip the CSS resize-handle corner (resizable nodes)
    if (ev.clientX > r.right - 18 && ev.clientY > r.bottom - 18) return;
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
  } else if (n.type === "preview") {
    div.querySelector(".prevrun")?.addEventListener("click", () => refreshPreview(n.ref.id));
  } else if (n.type === "dataset") {
    div.querySelector(".dsrename")?.addEventListener("change", async (e) => {
      const oldId = n.ref, newId = (e.target.value || "").trim();
      if (!model.renameDataset(oldId, newId)) { e.target.value = oldId; return; }
      movePos(`ds:${oldId}`, `ds:${newId}`);
      render();   // migrate the live DOM node to the new id NOW (its drag wiring binds the new
                  // id) — refreshLive below skips render when the dataset SET is unchanged, which
                  // it is after an in-place rename, so the node would otherwise keep the old id
      autosave();
      try {
        await api.renameDataset(model.profile.name, oldId, newId);   // carry the stored data over
      } catch (err) {
        model.renameDataset(newId, oldId);   // roll back the profile rename; data didn't move
        movePos(`ds:${newId}`, `ds:${oldId}`);
        e.target.value = oldId; setStatus(String(err.message || err)); autosave();
        render(); return;
      }
      await refreshLive();   // re-reads the dataset list (now under the new name) and re-renders
    });
    div.querySelector(".dsagg")?.addEventListener("change", (e) => {
      model.setDatasetAggregate(n.ref, e.target.value);   // how the 'many' collapses
      autosave(); refreshDataNode(n.ref);                 // server recomputes values under the new policy
    });
    div.querySelector(".dsclone")?.addEventListener("click", () => { model.cloneDataset(n.ref); render(); autosave(); });
    div.querySelector(".dssubset")?.addEventListener("click", () => {
      const id = model.addSubset(n.ref);
      if (id) { placeNewNode(`sub:${id}`, "subset"); render(); autosave(); panTo(`sub:${id}`); }
    });
    const clearBtn = div.querySelector(".dsclear");
    clearBtn?.addEventListener("click", async () => {
      if (clearBtn.dataset.armed !== "1") {   // inline confirm (no blocking dialogs)
        clearBtn.dataset.armed = "1"; clearBtn.textContent = "confirm?";
        setTimeout(() => { clearBtn.dataset.armed = "0"; clearBtn.textContent = "clear data"; }, 2500);
        return;
      }
      try { await api.clearDataset(model.profile.name, n.ref); refreshLive(); refreshDataNode(n.ref); refreshAllBatchesNodes(); refreshAllSubsetNodes(); setStatus(`cleared ${n.ref}`); }
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
      if (dsTab.get(n.ref) === "batches") loadBatchesNode(n.ref);   // restore an open batches tab
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
      if (k === "type") { fld.type = e.target.value; rebuildNode(n.id); }  // toggles extract/sep
      else if (k === "extract") { fld.extract = e.target.value; rebuildNode(n.id); }  // toggles sep
      else if (k === "sep") fld.separator = e.target.value || "/";
      else if (k === "learn") fld.learn = e.target.checked;
      else if (k === "fuzzy") fld.fuzzy = +e.target.value;
      else if (k === "empty") fld.empty = e.target.value || null;
      else if (k === "ifnum") fld.if_number = e.target.value || null;
      else if (k === "ifnumany") fld.if_number_any = e.target.checked;
      else if (k === "iftext") fld.if_text = e.target.value || null;
      else if (k === "iftextany") fld.if_text_any = e.target.checked;
      else if (k === "dictmode") fld.dict_mode = e.target.value;
      else if (k === "usedict") { fld.dictionary = e.target.value || ""; render(); }   // redraw the muted dict link
      autosave();   // plain value edits: no DOM rebuild
    }));
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
      autosave(); refreshOpenDetect();
    }));
  } else if (n.type === "scrollbar") {
    div.addEventListener("click", (ev) => {
      if (ev.target.closest("input,select,button")) return;
      selectWindowBox(n.win.id, "scrollbar");
    });
    div.querySelector(".sbset").addEventListener("change", (e) => { model.setScrollbarOrientation(n.win.id, e.target.value); autosave(); });
  } else if (n.type === "item") {
    wireItemControls(div, n);
  }
}

// ---- dataset records (rendered inline in the dataset node body) ----

function dataHost(ds) {
  const el = nodeEls.get(`ds:${ds}`);
  return el && el.querySelector(".data-host");
}
// refresh every dataset node that currently exists (after save / clear / live change)
function refreshAllDataNodes() {
  for (const ds of model.datasets()) if (nodeEls.has(`ds:${ds}`)) refreshDataNode(ds);
}
// One VTable per data/subset node host (virtualized + searchable). Recreated if the host
// element was rebuilt by a node re-render.
const vtables = new Map();
function vtableFor(key, host) {
  let vt = vtables.get(key);
  if (vt && vt.host === host) return vt;
  if (vt) vt.destroy();
  host.innerHTML = "";
  vt = new VTable(host, key);
  vtables.set(key, vt);
  return vt;
}

const VT_META = ["present", "first_seen", "last_seen", "key", "_count"];   // not shown as columns

// Show a count badge on a dataset node's tab (data → item count, batches → batch count).
function setTabCount(ds, sel, n) {
  const el = nodeEls.get(`ds:${ds}`)?.querySelector(sel);
  if (el) el.textContent = n != null ? `${n}` : "";
}

async function refreshDataNode(ds) {
  const host = dataHost(ds);
  if (!host) return;
  try {
    const r = await fetch(`/api/flow/${encodeURIComponent(model.profile.name)}/dataset/${encodeURIComponent(ds)}`);
    const recs = (await r.json()).records || [];
    const cols = [...new Set(recs.flatMap((rec) => Object.keys(rec)))].filter((c) => !VT_META.includes(c));
    vtableFor(`ds:${ds}`, host).setData(cols, recs, {
      rowClass: (row) => (row.present ? "" : "gone"),
      expander: (row) => expandObservations(ds, row),   // drill into its observations inline
    });
    setTabCount(ds, ".data-n", recs.length);   // item count on the data tab
  } catch (e) { vtables.delete(`ds:${ds}`); host.innerHTML = `<p class="muted" style="padding:8px">${esc(String(e))}</p>`; }
}

// Inline drill-down: a dataset record aggregates "many" observations under its key — fetch
// them and return a detail node the VTable parks under the clicked row.
async function expandObservations(ds, row) {
  const node = document.createElement("div");
  node.className = "vt-detail-inner";
  const key = row && row.key;
  if (!key) { node.innerHTML = `<p class="muted">no key</p>`; return node; }
  try {
    const r = await fetch(`/api/flow/${encodeURIComponent(model.profile.name)}/dataset/${encodeURIComponent(ds)}/observations?key=${encodeURIComponent(key)}`);
    const obs = (await r.json()).observations || [];
    const cols = [...new Set(obs.flatMap((o) => Object.keys(o)))];
    const head = cols.map((c) => `<th>${esc(c)}</th>`).join("");
    const rows = obs.map((o) => `<tr>${cols.map((c) => `<td>${esc(o[c] == null ? "" : String(o[c]))}</td>`).join("")}</tr>`).join("");
    node.innerHTML = `<div class="vt-detail-lbl">${obs.length} observation${obs.length === 1 ? "" : "s"} · ${esc(key)}</div>
      <table class="grid-table zebra vt-detail-tbl"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
  } catch (e) { node.innerHTML = `<p class="muted">${esc(String(e.message || e))}</p>`; }
  return node;
}

// A dataset record aggregates "many" observations under its key — open them in a modal.
// (kept as an alternative to the inline drill-down above; not currently wired)
async function showRecordMany(ds, key, count) {
  if (!key) return;
  const node = document.createElement("div");
  node.className = "vt-modal-host";
  openModal({ title: `${ds}: ${key}${count ? ` · ${count} observations` : ""}`, size: "data", node });
  try {
    const r = await fetch(`/api/flow/${encodeURIComponent(model.profile.name)}/dataset/${encodeURIComponent(ds)}/observations?key=${encodeURIComponent(key)}`);
    const obs = (await r.json()).observations || [];
    const cols = [...new Set(obs.flatMap((o) => Object.keys(o)))];
    new VTable(node).setData(cols, obs);
  } catch (e) { node.innerHTML = `<p class="muted" style="padding:8px">${esc(String(e))}</p>`; }
}

// ---- batches node (ledger + per-batch contents/preview, embedded in the node) ----

const batchesState = new Map();   // ds -> { sel, events } (selection + event cache per node)

function batEls(ds) {
  const el = nodeEls.get(`ds:${ds}`);   // batches live in the merged dataset node's history tab
  return el && { list: el.querySelector(".bat-list"), detail: el.querySelector(".bat-detail") };
}
function batState(ds) {
  if (!batchesState.has(ds)) batchesState.set(ds, { sel: null, events: {} });
  return batchesState.get(ds);
}

// (re)fetch the ledger and paint it into the node body — called on build and whenever
// the dataset's batches change (save / revert / edit / remove). No refresh button.
async function loadBatchesNode(ds) {
  const els = batEls(ds);
  if (!els) return;
  try {
    const r = await fetch(`/api/flow/${encodeURIComponent(model.profile.name)}/dataset/${encodeURIComponent(ds)}`);
    const batches = (await r.json()).batches || [];
    renderBatchesList(ds, batches);
    setTabCount(ds, ".bat-n", batches.length);   // batch count on the batches tab
  } catch (e) { els.list.innerHTML = `<li class="muted">${esc(String(e))}</li>`; }
}

// refresh every batches node that currently exists
function refreshAllBatchesNodes() {
  for (const ds of model.datasets()) if (nodeEls.has(`ds:${ds}`)) loadBatchesNode(ds);
}

function renderBatchesList(ds, batches) {
  const els = batEls(ds);
  if (!els) return;
  const st = batState(ds);
  els.list.parentElement?.classList.toggle("bat-empty", !batches.length);   // drop the box framing when empty
  if (!batches.length) { els.list.innerHTML = '<li class="muted">no batches yet</li>'; els.detail.innerHTML = ""; st.sel = null; return; }
  els.list.innerHTML = batches.map((b) => {
    const parts = [b.adds ? `+${b.adds}` : "", b.updates ? `~${b.updates}` : "", b.removes ? `−${b.removes}` : ""].filter(Boolean).join(" ");
    const keys = (b.keys || []).slice(0, 4).join(", ") + (b.count > 4 ? " …" : "");
    const app = `<label class="led-apply" title="apply this batch to the dataset (uncheck to revert it)"><input type="checkbox" class="led-toggle" data-batch="${b.batch}"${b.reverted ? "" : " checked"}> applied</label>`;
    const rm = `<button class="led-remove danger" data-batch="${b.batch}" title="permanently delete this batch from the ledger">remove</button>`;
    return `<li class="batrow ${b.reverted ? "reverted" : ""}${st.sel === b.batch ? " sel" : ""}" data-batch="${b.batch}">
      <span class="muted">${esc(clockTime(b.ts))}</span> <b>#${b.batch}</b>
      <span class="muted batmeta" title="${parts} · ${b.count} · ${esc(keys)}">${parts} · ${b.count} · ${esc(keys)}</span> ${app} ${rm}</li>`;
  }).join("");
  // select on row click (but not when hitting the checkbox/remove)
  els.list.querySelectorAll(".batrow").forEach((li) => li.addEventListener("click", (ev) => {
    if (ev.target.closest(".led-apply,.led-remove")) return;
    selectBatch(ds, +li.dataset.batch);
  }));
  els.list.querySelectorAll(".led-toggle").forEach((cb) => cb.addEventListener("change", async () => {
    cb.disabled = true;
    try {
      await api.revertDatasetBatch(model.profile.name, ds, +cb.dataset.batch, !cb.checked);
      refreshLive(); refreshDataNode(ds); loadBatchesNode(ds);
    } catch (e) { cb.disabled = false; cb.checked = !cb.checked; setStatus(String(e.message || e)); }
  }));
  els.list.querySelectorAll(".led-remove").forEach((b) => b.addEventListener("click", async () => {
    if (b.dataset.armed !== "1") { b.dataset.armed = "1"; b.textContent = "sure?"; setTimeout(() => { b.dataset.armed = "0"; b.textContent = "remove"; }, 2500); return; }
    try {
      if (st.sel === +b.dataset.batch) { st.sel = null; els.detail.innerHTML = ""; }
      await api.removeDatasetBatch(model.profile.name, ds, +b.dataset.batch);
      refreshLive(); refreshDataNode(ds); loadBatchesNode(ds);
    } catch (e) { setStatus(String(e.message || e)); }
  }));
  if (st.sel != null && batches.some((b) => b.batch === st.sel)) selectBatch(ds, st.sel);
  else if (st.sel != null) { st.sel = null; els.detail.innerHTML = ""; }
}

async function selectBatch(ds, batch) {
  const els = batEls(ds);
  if (!els) return;
  const st = batState(ds);
  st.sel = batch;
  els.list.querySelectorAll(".batrow").forEach((li) => li.classList.toggle("sel", +li.dataset.batch === batch));
  els.detail.innerHTML = '<p class="muted">loading…</p>';
  try {
    renderBatchDetail(ds, await api.batchDetail(model.profile.name, ds, batch));
  } catch (e) { els.detail.innerHTML = `<p class="muted">${esc(String(e))}</p>`; }
}

function renderBatchDetail(ds, bd) {
  const els = batEls(ds);
  if (!els) return;
  const events = bd.events || [];
  const preview = bd.preview || [];

  // preview — what applying this batch changes in the dataset (read-only diff table)
  const pvRows = preview.map((p) => {
    if (p.kind === "add") return `<tr class="pv-add"><td>add</td><td>${esc(p.key)}</td><td>${esc(fmtVals(p.after))}</td></tr>`;
    if (p.kind === "remove") return `<tr class="pv-remove"><td>remove</td><td>${esc(p.key)}</td><td>${esc(fmtVals(p.before))}</td></tr>`;
    const diff = Object.entries(p.changed || {}).map(([f, [o, nv]]) => `${esc(f)}: ${esc(o ?? "∅")} → ${esc(nv ?? "∅")}`).join("; ");
    return `<tr class="pv-update"><td>update</td><td>${esc(p.key)}</td><td>${diff}</td></tr>`;
  }).join("");
  const pvTable = preview.length
    ? `<table class="grid-table zebra pv-table"><thead><tr><th>change</th><th>key</th><th>detail</th></tr></thead><tbody>${pvRows}</tbody></table>`
    : '<p class="muted">applying this batch changes nothing</p>';

  // event contents — read-only VTable (search/sort/resize), no editing
  els.detail.innerHTML = `<h4 class="ds-h">Batch #${bd.batch} · ${events.length} events</h4>
    <div class="bat-ev-host"></div>
    <h4 class="ds-h">Applying this batch would…</h4>${pvTable}`;
  const evHost = els.detail.querySelector(".bat-ev-host");
  if (!events.length) { evHost.innerHTML = '<p class="muted" style="padding:8px">no events</p>'; return; }
  const cols = ["id", "op", ...new Set(events.flatMap((e) => Object.keys(e.values || {})))];
  const rows = events.map((e) => ({ id: e.id, op: e.op, reverted: e.reverted, ...(e.values || {}) }));
  vtableFor(`bat:${ds}`, evHost).setData(cols, rows, { rowClass: (row) => (row.reverted ? "reverted" : "") });
}

function fmtVals(v) {
  if (!v) return "";
  return Object.entries(v).map(([k, val]) => `${k}=${val}`).join(", ");
}

// ---- precapture floating window -------------------------------------------
// A floating panel (built like the node map) rather than a modal, so it can be moved and
// left open while you work the game. Hiding it does NOT stop the worker — it keeps running
// in the background and is tracked/cancellable from the Activity panel; reopening rehydrates.

let pc = null;             // the createFloatWin instance (built once)
let pcNode = null;         // the .precap body element handlers operate on
let pcSig = null;          // current AbortController signal (new each show → aborts on hide)
let pcCtl = null;          // current AbortController
let precapLast = null;     // last status drawn — so view switches can redraw without a fetch
let precapPoll = null;
let precapBusy = false;   // recording/processing/paused
let precapStopping = false;   // a stop/cancel was clicked, awaiting the worker to wind down
let precapLastPhase = null;
let precapSessions = [];   // saved recording sessions [{id,label,frames,processed,records,saved_at,active}]
let precapView = null;     // which item is selected: "new" (record inputs) or "loaded" (a session)
let precapPage = null;     // which page is shown: "list" (session list) or "detail" (the selected pane)
const pcState = { visible: false, x: null, y: null, w: null, h: null };

const _pcDraw = (st) => { precapLast = st; renderPrecap(pcNode, st); };
const _pcRun = async (fn) => {
  try { _pcDraw(await fn()); }
  catch (e) { if (e.name !== "AbortError") setStatus(String(e.message || e)); }   // ignore hide-aborts
};
// refresh the saved-session list (and the active status it returns)
const _pcLoadSessions = async () => {
  const game = model.profile.name; if (!game) return;
  try { const r = await api.precapture.sessions(game, pcSig); precapSessions = r.sessions || []; _pcDraw(r.status); }
  catch (e) { if (e.name !== "AbortError") setStatus(String(e.message || e)); }
};
// a session op returns { sessions, status } — update both at once
const _pcSessAct = async (p) => {
  try { const r = await p; precapSessions = r.sessions || precapSessions; _pcDraw(r.status); }
  catch (e) { if (e.name !== "AbortError") setStatus(String(e.message || e)); }
};

function buildPrecap() {
  if (pc) return;
  pcNode = document.createElement("div");
  pcNode.className = "precap";
  pcNode.innerHTML = `<p class="muted" style="padding:12px">loading…</p>`;
  pc = createFloatWin({
    id: "precap", title: "precapture", state: pcState, bothAxes: true,
    onShow: showPrecap, onHide: hidePrecap, onPersist: () => persist.layout(),
  });
  pc.body.appendChild(pcNode);

  // Inline rename: swap the session's name span for an <input>, commit on Enter/blur,
  // cancel on Escape — no blocking prompt(). Restores the span so reconcile resumes.
  const beginRename = (row, sid) => {
    const game = model.profile.name;
    const nameEl = row.querySelector(".pc-sess-name");
    if (!nameEl || row._editing) return;
    row._editing = true;
    const input = document.createElement("input");
    input.className = "pc-sess-rename"; input.value = row.dataset.label || "";
    nameEl.replaceWith(input);
    input.focus(); input.select();
    let done = false;
    const finish = (commit) => {
      if (done) return; done = true;
      row._editing = false;
      input.replaceWith(nameEl);   // reconcile refreshes the span's text on the next draw
      const label = input.value.trim();
      if (commit && label !== (row.dataset.label || ""))
        _pcSessAct(api.precapture.renameSession(game, sid, label, pcSig));
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); finish(false); }
    });
    input.addEventListener("blur", () => finish(true));
  };

  // one delegated handler for every control (buttons AND the clickable session rows)
  pcNode.addEventListener("click", (ev) => {
    if (ev.target.closest("input, textarea")) return;   // never let a field click trigger an action
    const b = ev.target.closest("[data-act]");
    if (!b) return;
    const game = model.profile.name; if (!game) return;
    const a = b.dataset.act, sid = b.dataset.sid;
    // session-list actions are locked while a worker runs
    if (precapBusy && (a === "newsess" || a === "loadsess" || a === "rensess" || a === "delsess")) return;
    const mf = +pcNode.querySelector(".pc-frames")?.value || 300;
    const iv = +pcNode.querySelector(".pc-interval")?.value || 0;
    const label = pcNode.querySelector(".pc-label")?.value || "";
    const as = !!pcNode.querySelector(".pc-autoscroll")?.checked;
    const clk = +pcNode.querySelector(".pc-clicks")?.value || 1;
    if (a === "recstop" || a === "cancel") { precapStopping = true; b.disabled = true; b.textContent = "stopping…"; }
    if (a === "back") { precapPage = "list"; if (precapLast) _pcDraw(precapLast); }
    else if (a === "newsess") { precapView = "new"; precapPage = "detail"; if (precapLast) _pcDraw(precapLast); }
    // recordStart creates+persists a new session server-side, so leave the "new" pane at
    // once and show it as the active loaded session (its row appears via loadSessions)
    else if (a === "record") { precapView = "loaded"; _pcRun(async () => { const st = await api.precapture.recordStart(game, mf, iv, label, as, clk, pcSig); _pcLoadSessions(); return st; }); }
    else if (a === "recstop") _pcRun(() => api.precapture.recordStop(game, pcSig));
    else if (a === "process") _pcRun(() => api.precapture.processStart(game, pcSig));
    else if (a === "pause") _pcRun(() => api.precapture.pause(game, true, pcSig));
    else if (a === "resume") _pcRun(() => api.precapture.pause(game, false, pcSig));
    else if (a === "cancel") _pcRun(() => api.precapture.cancel(game, pcSig));
    else if (a === "save") {
      b.classList.add("reading"); b.disabled = true;   // spinner until the commit returns
      (async () => {
        try {
          const r = await api.precapture.save(game, pcSig);
          refreshLive(); refreshAllDataNodes(); refreshAllBatchesNodes(); refreshAllSubsetNodes();
          setStatus(`committed ${JSON.stringify(r.written)}`); _pcLoadSessions(); _pcDraw(r.status);
        } catch (e) {
          if (e.name !== "AbortError") { setStatus(String(e.message || e)); if (precapLast) _pcDraw(precapLast); }   // redraw clears the spinner
        }
      })();
    }
    else if (a === "loadsess") { precapView = "loaded"; precapPage = "detail"; _pcSessAct(api.precapture.loadSession(game, sid, pcSig)); }
    else if (a === "delsess") _pcSessAct(api.precapture.deleteSession(game, sid, pcSig));
    else if (a === "rensess") beginRename(b.closest(".pc-sess"), sid);
  });

  // live auto-scroll toggle (checkbox shown while recording) — server is the source of
  // truth; each poll re-reflects st.autoscroll, so a give-up server-side unchecks it here.
  pcNode.addEventListener("change", (ev) => {
    const game = model.profile.name; if (!game) return;
    if (!ev.target.closest(".pc-autoscroll-live, .pc-clicks-live")) return;
    const on = !!pcNode.querySelector(".pc-autoscroll-live")?.checked;
    const clicks = +pcNode.querySelector(".pc-clicks-live")?.value || 1;
    _pcRun(() => api.precapture.setAutoscroll(game, on, clicks, pcSig));
  });
}

async function showPrecap() {
  const game = model.profile.name;
  if (!game) { setStatus("load a game first"); pc.setVisible(false); return; }
  setLiveMode(false);                         // mutually exclusive with live
  precapOpen = true;
  precapStopping = false; precapView = null; precapPage = null;
  $("precapBtn").classList.add("active");
  pc.el.querySelector(".fw-title").textContent = `precapture: ${game}`;
  pcCtl = new AbortController(); pcSig = pcCtl.signal;
  await _pcLoadSessions();
  // poll ONLY while a worker is actually running (recording/processing/paused) — when
  // idle/recorded/done/saved nothing changes server-side except via user actions, which
  // already redraw, so hitting status every 700ms then just pounds the server for nothing.
  if (precapPoll) clearInterval(precapPoll);
  precapPoll = setInterval(async () => {
    if (!precapBusy) return;
    try { _pcDraw(await api.precapture.status(model.profile.name, pcSig)); } catch { /* ignore */ }
  }, 700);
}

// Hiding the panel does NOT cancel the worker (the Activity panel monitors/cancels it).
// Just stop polling and abort in-flight fetches; reopening rehydrates from the server.
function hidePrecap() {
  if (precapPoll) { clearInterval(precapPoll); precapPoll = null; }
  if (pcCtl) { pcCtl.abort(); pcCtl = null; }
  unregisterWorker("precap");
  precapOpen = false; precapStopping = false;
  $("precapBtn").classList.remove("active");
}

// Staged-data preview: one VTable per dataset (virtualized + searchable), reconciled IN
// PLACE so the 700ms poll doesn't churn the tables or reset scroll/search — each dataset's
// section + host is reused; setData only fires when its sample actually changes.
function renderPrecapData(dataEl, datasets) {
  datasets = datasets || [];
  if (!dataEl._ds) {
    dataEl._ds = new Map();   // dataset -> { section, label, host, _sig }
    dataEl._empty = document.createElement("p");
    dataEl._empty.className = "muted"; dataEl._empty.style.padding = "8px";
    dataEl._empty.textContent = "no data staged yet — process the frames to read them";
  }
  if (!datasets.length) {
    for (const [k, e] of dataEl._ds) { vtables.get(`pc:${k}`)?.destroy(); vtables.delete(`pc:${k}`); e.section.remove(); dataEl._ds.delete(k); }
    if (!dataEl.contains(dataEl._empty)) dataEl.appendChild(dataEl._empty);
    return;
  }
  if (dataEl.contains(dataEl._empty)) dataEl._empty.remove();
  // drop sections whose dataset is gone
  const want = new Set(datasets.map((d) => d.dataset));
  for (const [k, e] of dataEl._ds) if (!want.has(k)) { vtables.get(`pc:${k}`)?.destroy(); vtables.delete(`pc:${k}`); e.section.remove(); dataEl._ds.delete(k); }

  for (const d of datasets) {
    let e = dataEl._ds.get(d.dataset);
    if (!e) {
      const section = document.createElement("div"); section.className = "pc-ds";
      const label = document.createElement("div"); label.className = "pc-ds-h";
      const host = document.createElement("div"); host.className = "pc-ds-vt";
      section.append(label, host);
      e = { section, label, host, _sig: null }; dataEl._ds.set(d.dataset, e);
    }
    dataEl.appendChild(e.section);   // (re)append in server order
    const meta = `${d.count} row${d.count === 1 ? "" : "s"}`;
    if (e.label._meta !== meta) { e.label.innerHTML = `<b>${esc(d.dataset)}</b> <span class="muted">${esc(meta)}</span>`; e.label._meta = meta; }
    const rows = d.sample || [];
    const sig = `${d.count}|${JSON.stringify(rows)}`;   // skip setData when nothing changed (poll churn)
    if (e._sig === sig) continue;
    e._sig = sig;
    const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    const vt = vtableFor(`pc:${d.dataset}`, e.host);
    vt.pinned = null;   // fit the container height (datasets share pc-data, then scroll)
    vt.setData(cols, rows);
  }
}

function renderPrecap(node, st) {
  const phase = st.phase || "idle";
  const recording = phase === "recording";
  const processing = phase === "processing";
  const paused = phase === "paused";
  precapBusy = recording || processing || paused;   // gate modal dismissal
  // surface the backend worker in the log bar with an emergency kill
  if (precapBusy) registerWorker("precap", `precapture ${phase}`, () => api.precapture.cancel(model.profile.name).catch(() => {}));
  else unregisterWorker("precap");
  if (phase !== precapLastPhase) {                   // log phase transitions
    if (phase === "recording") log("precapture: recording…", "run");
    else if (phase === "recorded") log(`precapture: recorded ${st.frames} frames`, "ok");
    else if (phase === "processing") log("precapture: processing…", "run");
    else if (phase === "done") { const t = st.timing || {}; log(`precapture done: ${st.processed} frames · ${t.ms_per_frame || 0} ms/frame on ${t.device || "cpu"} (decode ${t.decode_ms || 0} · classify ${t.classify_ms || 0} · read ${t.read_ms || 0}) · ${st.fps}/s · ${st.read || 0} rows read`, "ok"); }
    else if (phase === "cancelled") log("precapture: cancelled", "warn");
    else if (phase === "saved") log("precapture: committed", "ok");
    // recording just finished -> flip to the loaded session's controls (process / save /
    // delete) so the just-recorded frames are ready to work with, on the detail page
    if (precapLastPhase === "recording" && phase !== "recording") { precapView = "loaded"; precapPage = "detail"; }
    precapLastPhase = phase;
  }
  // first paint: pick the pane from what's on disk — a session with frames opens loaded,
  // otherwise the new-recording pane
  if (precapView === null) precapView = (st.session && st.frames) ? "loaded" : "new";
  // a loaded session that vanished (deleted, none left) falls back to the new pane
  if (precapView === "loaded" && !st.session) precapView = "new";
  // first paint: a running worker opens straight to the detail page, otherwise the list
  if (precapPage === null) precapPage = precapBusy ? "detail" : "list";

  // closing always works now and cancels the run — say so on the button
  const x = node.closest(".modal")?.querySelector(".modal-x");
  if (x) x.title = precapBusy ? "close & cancel the run (Esc)" : "close (Esc)";
  if (!precapBusy) precapStopping = false;   // worker wound down -> clear the stopping state
  const pct = st.frames ? Math.round((100 * st.processed) / st.frames) : 0;
  const staged = (st.datasets || []).reduce((n, d) => n + d.count, 0);
  const busyRun = processing || paused;
  const canProcess = st.frames > 0 && !recording && !processing && !paused;

  // Paged skeleton built ONCE — list page = session list; detail page = back bar + the
  // selected pane. One page is shown at a time (precapPage); the back button returns to list.
  if (!node.querySelector(".pc-main")) {
    node.innerHTML = `<div class="pc-main">
        <div class="pc-page pc-page-list"><div class="pc-left"></div></div>
        <div class="pc-page pc-page-detail">
          <div class="pc-detail-head"><button class="pc-back" data-act="back" title="back to sessions">←</button><span class="pc-detail-title"></span><button class="pc-detail-del danger" data-act="delsess" title="delete session" hidden>×</button></div>
          <div class="pc-right"></div>
        </div>
      </div>`;
  }
  const onList = precapPage === "list";
  node.querySelector(".pc-page-list").hidden = !onList;
  node.querySelector(".pc-page-detail").hidden = onList;
  renderPrecapLeft(node.querySelector(".pc-left"), st);
  // detail-page heading reflects the selected pane
  const dTitle = node.querySelector(".pc-detail-title");
  if (dTitle) dTitle.textContent = precapView === "new" ? "new session"
    : (st.session ? (st.label || fmtCaptureTime(st.session)) : "session");
  // delete (×) lives in the detail head — only for a loaded session, locked while busy
  const dDel = node.querySelector(".pc-detail-del");
  if (dDel) {
    dDel.hidden = precapView !== "loaded" || !st.session;
    dDel.dataset.sid = st.session || "";
    dDel.disabled = (recording || busyRun) || !st.session;
  }

  // The right pane's STRUCTURE depends only on which pane is shown and whether a worker
  // is running. Rebuild its innerHTML only when that shape changes — otherwise the 700ms
  // poll would clobber the record inputs and steal focus while the user types in them.
  const right = node.querySelector(".pc-right");
  const shape = `${precapView}|${recording}|${busyRun}`;
  if (right.dataset.shape !== shape) {
    right.dataset.shape = shape;
    right.innerHTML = precapView === "new"
      ? `<div class="pc-opts">
           <label class="flab">max frames <input type="number" class="pc-frames" value="300" min="1"></label>
           <label class="flab">interval ms <input type="number" class="pc-interval" value="0" min="0"></label>
           <label class="flab">label <input type="text" class="pc-label" placeholder="(optional)"></label>
           <label class="flab pc-as-lab" title="scroll the game's list automatically after each captured frame; stops & unchecks itself at the end of the list">auto-scroll <input type="checkbox" class="pc-autoscroll"></label>
           <label class="flab" title="wheel notches sent per scroll">clicks <input type="number" class="pc-clicks" value="1" min="1"></label>
         </div>
         <div class="pc-ctl"></div>`
      : `<div class="pc-bar"></div>
         <div class="pc-ctl"></div>
         <div class="pc-progress"><div class="pc-fill"></div></div>
         <div class="pc-recog"></div>
         <div class="pc-data"></div>`;
  }

  const tm = st.timing || {};
  // A paused worker can be EITHER a recording (auto-scroll hit the list end) or a
  // processing run; st.kind disambiguates so the right counters/controls show.
  const recPaused = paused && st.kind === "recording";   // recording, auto-paused at list end
  const procLive = processing || (paused && st.kind === "processing");
  const recLive = recording || recPaused;
  // Live counters ONLY — show numbers while a worker is actually moving them. A recording
  // shows its frame count; a processing run shows processed/read/fps + timing. An
  // idle/done/just-loaded session shows nothing (static text is just noise).
  const stats = [];
  if (recLive || procLive) stats.push(`${st.frames} frames`);
  if (procLive) stats.push(`${st.processed} processed`, `${st.read || 0} read`, `${st.fps} /s`);
  const bar = right.querySelector(".pc-bar");   // absent in the new-session pane
  if (bar) bar.innerHTML = `
    ${stats.length ? `<span class="muted">${stats.join(" · ")}</span>` : ""}
    ${procLive ? `<span class="muted">· ${tm.ms_per_frame || 0} ms/frame (${esc(tm.device || "cpu")})</span>` : ""}
    ${procLive && st.window ? `<span class="conf-good" title="window/state recognised this frame">· ${esc(st.window)}/${esc(st.state)}</span>` : ""}
    ${recPaused ? `<span class="conf-warn">⏸ auto-scroll reached the list end — resume to retry, or uncheck it</span>` : ""}
    ${st.warning ? `<span class="conf-warn">⚠ ${esc(st.warning)}</span>` : ""}
    ${st.error ? `<span class="conf-bad">${esc(st.error)}</span>` : ""}`;
  // recognition tally: per-window/state frame counts (the "" key is a miss — no window matched)
  const recogEl = right.querySelector(".pc-recog");
  if (recogEl) {
    const rec = st.recognized || [];
    recogEl.innerHTML = rec.map((r) =>
      `<span class="pc-recog-chip${r.miss ? " miss" : ""}">${r.miss ? "no match" : esc(r.key)} · ${r.count}</span>`).join("");
  }
  // progress bar matters only WHILE processing — gone once done so it doesn't linger
  const prog = right.querySelector(".pc-progress");
  if (prog) {
    prog.hidden = !procLive;
    right.querySelector(".pc-fill").style.width = `${pct}%`;
  }

  // the record inputs are only present (and only editable) in the new-session pane
  right.querySelectorAll(".pc-opts input").forEach((i) => { i.disabled = recording; });

  // live auto-scroll controls — shown both while recording and while auto-paused, so the
  // user can toggle/adjust or just resume from the list end
  const asCtl = `<label class="flab pc-as-lab" title="toggle auto-scroll live; reaching the list end pauses the recording">auto-scroll <input type="checkbox" class="pc-autoscroll-live" ${st.autoscroll ? "checked" : ""}></label><label class="flab" title="wheel notches sent per scroll (live)">clicks <input type="number" class="pc-clicks-live" value="${st.scroll_clicks || 1}" min="1"></label>`;

  const justSaved = phase === "saved";
  const anyRun = recording || busyRun;   // any worker running -> save/delete locked
  let ctl;
  if (precapView === "new") {
    // recording immediately flips to the loaded pane, so the new pane is just the trigger
    ctl = `<button data-act="record"><span class="ic ic-rec">●</span> record</button>`;
  } else {
    const proc = precapStopping ? `<button disabled>stopping…</button>`
      : recording ? `<button data-act="recstop"><span class="ic ic-rec">■</span> stop recording</button>${asCtl}`
      : processing ? `<button data-act="pause">‖ pause</button>`
      : paused ? `<button data-act="resume">► resume</button>${recPaused ? asCtl : ""}`
      : `<button data-act="process" ${canProcess ? "" : "disabled"}>process${st.frames ? ` ${st.frames}` : ""}</button>`;
    const cancel = busyRun && !precapStopping ? `<button data-act="cancel" class="danger">cancel</button>` : "";
    const save = `<button data-act="save" class="${justSaved ? "pc-saved" : ""}" ${(staged && !precapStopping && !anyRun && !justSaved) ? "" : "disabled"}>${justSaved ? "committed" : `commit${staged ? ` ${staged}` : ""}`}</button>`;
    ctl = `${proc}${cancel}${save}`;
  }
  const ctlEl = right.querySelector(".pc-ctl");
  // don't clobber a live INPUT the user is editing (the clicks field) on a poll tick;
  // a focused button must NOT block the rebuild (else post-save state wouldn't render)
  const editing = ctlEl.contains(document.activeElement) && document.activeElement.matches("input");
  if (!editing) ctlEl.innerHTML = ctl;

  const data = right.querySelector(".pc-data");
  if (data) renderPrecapData(data, st.datasets);
}

// The left pane: "＋ new session" (the record-inputs pane) on top, then every saved
// recording, newest first. The selected item is highlighted; switching is locked while a
// worker is busy. Loading is whole-row; ✎ renames. Delete lives in the right pane.
//
// Reconciled IN PLACE — never rebuild innerHTML (like renderWorkers). The poll redraws on
// every busy tick; wiping the list would churn buttons and steal focus each tick. The new
// button + header are made once; rows are a keyed map, reused/reordered/updated in place.
function renderPrecapLeft(left, st) {
  if (!left._rows) {
    left._new = document.createElement("button");
    left._new.className = "pc-sess-new"; left._new.dataset.act = "newsess";
    left._new.title = "record a new session"; left._new.textContent = "＋ new session";
    const h = document.createElement("div");
    h.className = "pc-sess-h muted"; h.textContent = "sessions";
    left.append(left._new, h);
    left._rows = new Map();   // sid -> { row, load, ren }
  }
  left._new.classList.toggle("active", precapView === "new");
  left._new.disabled = precapBusy;

  // drop rows whose session is gone
  const want = new Set(precapSessions.map((s) => s.id));
  for (const [sid, r] of left._rows) if (!want.has(sid)) { r.row.remove(); left._rows.delete(sid); }

  for (const s of precapSessions) {
    let r = left._rows.get(s.id);
    if (!r) {
      const row = document.createElement("div");
      row.className = "pc-sess"; row.dataset.act = "loadsess"; row.dataset.sid = s.id; row.title = "load this session";
      const name = document.createElement("span"); name.className = "pc-sess-name";
      const meta = document.createElement("span"); meta.className = "muted pc-sess-meta";
      const ren = document.createElement("button");
      ren.className = "pc-sess-ren"; ren.dataset.act = "rensess"; ren.dataset.sid = s.id; ren.title = "rename"; ren.textContent = "✎";
      row.append(name, meta, ren);
      r = { row, name, meta, ren }; left._rows.set(s.id, r);
    }
    left.appendChild(r.row);   // (re)append in list order -> DOM order tracks newest-first
    r.row.dataset.label = s.label || "";   // source of truth for the rename input
    r.row.classList.toggle("active", precapView === "loaded" && s.id === st.session);
    if (!r.row._editing) {     // don't clobber the rename input mid-edit
      const nm = s.label || fmtCaptureTime(s.id);
      if (r.name.textContent !== nm) r.name.textContent = nm;
    }
    const meta = `${s.frames}f · ${s.records || 0} rec${s.saved_at ? ' · <span class="tc-ok">committed</span>' : ""}`;
    if (r.meta._html !== meta) { r.meta.innerHTML = meta; r.meta._html = meta; }   // touch DOM only on change
    r.ren.disabled = precapBusy;
  }
}

// Capture filenames are "YYYYMMDD-HHMMSS-ffffff.jpg" — pull the time out for display.
function fmtCaptureTime(name) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(name);
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : name;
}

// Pick which stashed capture a window opens with — a thumbnail grid of every stash.
async function openCaptureModal(winId) {
  const game = model.profile.name;
  const node = document.createElement("div");
  node.innerHTML = `<p class="muted" style="padding:12px">loading…</p>`;
  const modal = openModal({ title: `${winId} — choose capture`, size: "data", node });
  try {
    const [caps, binds] = await Promise.all([api.listCaptures(game), api.getBindings(game)]);
    const current = binds[winId];
    const grid = caps.map((name) => `
      <button class="cap-cell ${name === current ? "sel" : ""}" data-name="${esc(name)}" title="${esc(name)}">
        <img loading="lazy" src="${api.captureUrl(game, name)}" alt="" />
        <span class="cap-time">${esc(fmtCaptureTime(name))}</span>
      </button>`).join("");
    node.innerHTML = `<div class="cap-head"><button class="cap-new">📷 capture new</button>
        <span class="muted">${caps.length} stashed</span></div>
      ${caps.length ? `<div class="cap-grid">${grid}</div>` : '<p class="cap-empty">no stashed captures yet</p>'}`;
    node.querySelectorAll(".cap-cell").forEach((b) =>
      b.addEventListener("click", async () => { await chooseCapture(winId, b.dataset.name); modal.close(); }));
    node.querySelector(".cap-new").addEventListener("click", async () => {
      modal.close();
      if (!imageCanvases.has(winId)) await openImage(winId);
      await loadImage(winId, true);   // grab a fresh window capture + bind it
    });
  } catch (e) {
    node.innerHTML = `<p class="muted" style="padding:12px">${esc(String(e))}</p>`;
  }
}

async function chooseCapture(winId, name) {
  await api.bindCapture(model.profile.name, winId, name);
  if (!imageCanvases.has(winId)) await openImage(winId);   // openImage -> loadImage uses the binding
  else await loadImage(winId, false);
  updateImageLabel(winId);
}

// ---- window image / region drawing (in-graph) -----------------------------

const KINDS = [["item", "item", "▣"], ["data_area", "data area", "▭"], ["detect", "detect", "◎"], ["scrollbar", "scrollbar", "↕"]];
// kinds drawn INSIDE an item node (on its frozen cutout): the cell + fields + tells
const ITEM_KINDS = [["bbox", "cell", "▣"], ["field", "field", "▦"], ["filled", "filled", "▩"], ["text", "text", "T"], ["color", "color", "◐"], ["template", "template", "⧉"], ["diamonds", "diamonds", "◆"]];

// Show the bound capture's filename on the image button, so the user can tell
// which picture this window is looking at.
async function updateImageLabel(winId, btn) {
  btn = btn || nodeEls.get(`win:${winId}`)?.querySelector(".imgbtn");
  if (!btn) return;
  try {
    const name = (await api.getBindings(model.profile.name))[winId];
    btn.textContent = name ? `📷 ${name}` : "📷 image";
    btn.title = name || "capture image";
  } catch { /* ignore */ }
}

function closeImage(winId) {
  const e = imageCanvases.get(winId);
  if (e && e.host) e.host.innerHTML = "";
  imageCanvases.delete(winId);
  unregisterOverlay(`win:${winId}`);
  openImages.delete(winId);
  drawEdges();
  persist.layout();
}

// The image surface lives INSIDE the window node's `.win-img` host — one node.
async function openImage(winId) {
  const node = nodeEls.get(`win:${winId}`);
  const host = node && node.querySelector(".win-img");
  if (!host) return;
  host.innerHTML = `<div class="imgtools">
      <span class="tools">${KINDS.map(([v, label, icon], i) => `<button class="tool ${i === 0 ? "active" : ""}" data-kind="${v}" title="draw ${label}">${icon} ${label}</button>`).join("")}</span>
      <span class="spacer"></span><button class="imgprev">👁</button><button class="imgcap">recapture</button><button class="imgclose">×</button></div>
    <div class="canvas-wrap"><canvas></canvas></div>`;
  const canvas = host.querySelector("canvas");
  const kindOf = () => host.querySelector(".tool.active")?.dataset.kind || "region";
  const overlay = new Overlay(canvas, {
    onCreate: (geom) => {
      const k = kindOf();
      if (k === "item") { createItemFromGeom(winId, geom); return; }   // freeze + spawn item node
      let newDetect = null;
      if (k === "detect") newDetect = model.addDetect(winId, geom);
      else if (k === "scrollbar") model.setScrollbar(winId, geom);
      else if (k === "data_area") model.setDataArea(winId, geom);
      else model.addRegion(winId, geom);
      gridPreviews.delete(winId); gridReads.delete(winId);   // layout changed → detected grid is stale
      render(); refreshImageBoxes(winId); autosave();
      if (newDetect) prefillDetectText(winId, newDetect);
    },
    onChange: (box) => {
      const r = box.role;
      if (r === "detect") model.setDetectBox(winId, box.id, box);
      else if (r === "scrollbar") model.setScrollbar(winId, box);
      else if (r === "data_area") model.setDataArea(winId, box);
      else if (r === "item") { model.setItemBox(winId, box.id, box); refreshItemBoxes(winId, box.id); }
      else model.setRegionBox(winId, box.id, box);
      gridPreviews.delete(winId); gridReads.delete(winId);   // layout changed → detected grid is stale
      refreshImageBoxes(winId); drawEdges(); autosave();
    },
    onSelect: (id) => overlaySelected(`win:${winId}`, id),
  });
  imageCanvases.set(winId, { host, canvas, overlay });
  registerOverlay(`win:${winId}`, { overlay, kind: "window", winId,
    persist: (b) => persistBox(winId, b), refresh: () => refreshImageBoxes(winId) });
  overlay.setWorldZoom(view.zoom);
  openImages.add(winId);
  persist.layout();
  host.querySelectorAll(".tool").forEach((btn) => btn.addEventListener("click", () => {
    host.querySelectorAll(".tool").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
  }));
  host.querySelector(".imgclose").addEventListener("click", () => closeImage(winId));
  host.querySelector(".imgcap").addEventListener("click", () => loadImage(winId, true));
  host.querySelector(".imgprev").addEventListener("click", () => refreshPreview(winId));
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => drawEdges()).observe(canvas.parentElement);
  await loadImage(winId, false);
  refreshDetect(winId);
  drawEdges();
}

// ---- item template nodes (frozen cutout + cell-relative fields/tells) ------

// Drawing an "item" box on the fullscreen image freezes that crop and spawns a node.
async function createItemFromGeom(winId, geom) {
  const game = model.profile.name;
  const cap = (await api.getBindings(game))[winId];
  if (!cap) { setStatus("recapture the window first"); return; }
  let cut;
  try { cut = await api.itemCutout(game, cap, geom); }
  catch (e) { setStatus(String(e.message || e)); return; }
  const itemId = model.addItem(winId, { cutout: cut.name, cutout_box: geom, box: geom });
  gridPreviews.delete(winId); gridReads.delete(winId);
  render(); refreshImageBoxes(winId); autosave();
  openItemImage(winId, itemId);
}

function closeItemImage(winId, itemId) {
  const key = `${winId}:${itemId}`;
  const e = itemCanvases.get(key);
  if (e && e.host) e.host.innerHTML = "";
  itemCanvases.delete(key);
  itemReads.delete(key);
  clearTimeout(itemReadTimers.get(key)); itemReadTimers.delete(key); itemReadAgain.delete(key);
  unregisterOverlay(`item:${winId}:${itemId}`);
  drawEdges();
}

// Build the cutout canvas inside an item node and wire drawing of cell/fields/tells.
function openItemImage(winId, itemId) {
  const node = nodeEls.get(`item:${winId}:${itemId}`);
  const host = node && node.querySelector(".item-img");
  if (!host) return;
  const it = model.item(winId, itemId);
  if (!it || !it.cutout_box) return;
  host.innerHTML = `<div class="imgtools">
      <span class="tools">${ITEM_KINDS.map(([v, label, icon]) => `${v === "filled" ? '<span class="tool-div" title="tells"></span>' : ""}<button class="tool ${v === "field" ? "active" : ""}" data-kind="${v}" title="draw ${label}">${icon} ${label}</button>`).join("")}</span>
      <span class="spacer"></span></div>
    <div class="item-readout muted"></div>
    <div class="canvas-wrap"><canvas></canvas></div>`;
  const canvas = host.querySelector("canvas");
  const cb = it.cutout_box;
  const cut2win = (b) => ({ x: cb.x + b.x * cb.w, y: cb.y + b.y * cb.h, w: b.w * cb.w, h: b.h * cb.h });
  const win2cut = (b) => ({ x: (b.x - cb.x) / cb.w, y: (b.y - cb.y) / cb.h, w: b.w / cb.w, h: b.h / cb.h });
  const ibox = () => model.item(winId, itemId).box;
  const win2rel = (b) => { const ib = ibox(); return { x: (b.x - ib.x) / ib.w, y: (b.y - ib.y) / ib.h, w: b.w / ib.w, h: b.h / ib.h }; };
  const rel2win = (b) => { const ib = ibox(); return { x: ib.x + b.x * ib.w, y: ib.y + b.y * ib.h, w: b.w * ib.w, h: b.h * ib.h }; };
  const kindOf = () => host.querySelector(".tool.active")?.dataset.kind || "field";

  const overlay = new Overlay(canvas, {
    onCreate: (geom) => {                       // geom in cutout fractions
      const w = cut2win(geom);
      const k = kindOf();
      if (k === "bbox") model.setItemBox(winId, itemId, w);
      else if (k === "field") model.addItemField(winId, itemId, win2rel(w));
      else model.addItemTell(winId, itemId, k, win2rel(w));   // filled/text/color/template
      gridPreviews.delete(winId); gridReads.delete(winId);
      refreshItemBoxes(winId, itemId); refreshImageBoxes(winId); rebuildNode(`item:${winId}:${itemId}`); autosave();
      scheduleItemRead(winId, itemId);
    },
    onChange: (box) => {                        // box in cutout fractions + role/id
      const w = cut2win(box);
      if (box.role === "bbox") model.setItemBox(winId, itemId, w);
      else if (box.role === "field") model.setItemFieldBox(winId, itemId, box.id, win2rel(w));
      else model.setItemTellBox(winId, itemId, box.id, win2rel(w));
      gridPreviews.delete(winId); gridReads.delete(winId);
      refreshItemBoxes(winId, itemId); refreshImageBoxes(winId); autosave();
      scheduleItemRead(winId, itemId);
    },
    onSelect: (id) => overlaySelected(`item:${winId}:${itemId}`, id),
  });
  itemCanvases.set(`${winId}:${itemId}`, { host, canvas, overlay, cut2win, win2cut, win2rel, rel2win });
  // central registry: cross-deselect + WASD for the item's boxes
  const persistItem = (b) => {
    const w = cut2win(b);
    if (b.role === "bbox") model.setItemBox(winId, itemId, w);
    else if (b.role === "field") model.setItemFieldBox(winId, itemId, b.id, win2rel(w));
    else model.setItemTellBox(winId, itemId, b.id, win2rel(w));
    gridPreviews.delete(winId); gridReads.delete(winId);
    scheduleItemRead(winId, itemId);
  };
  registerOverlay(`item:${winId}:${itemId}`, { overlay, kind: "item", winId, itemId,
    persist: persistItem, refresh: () => { refreshItemBoxes(winId, itemId); refreshImageBoxes(winId); } });
  overlay.setWorldZoom(view.zoom);
  host.querySelectorAll(".tool").forEach((b) => b.addEventListener("click", () => {
    host.querySelectorAll(".tool").forEach((x) => x.classList.remove("active")); b.classList.add("active");
  }));
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => drawEdges()).observe(canvas.parentElement);

  const img = new Image();
  img.onload = () => {
    canvas.parentElement.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
    overlay.setImage(img); refreshItemBoxes(winId, itemId); drawEdges();
    scheduleItemRead(winId, itemId);   // show what current settings extract, right away
  };
  img.src = api.cutoutUrl(model.profile.name, it.cutout);
  drawEdges();
}

// Draw the cell + fields + tells on the item's cutout canvas (in cutout fractions).
function refreshItemBoxes(winId, itemId) {
  const ent = itemCanvases.get(`${winId}:${itemId}`);
  const it = model.item(winId, itemId);
  if (!ent || !it) return;
  // last read of this cutout, if any: pass/fail per tell + the extracted field values
  const rd = itemReads.get(`${winId}:${itemId}`);
  const tellPass = {};
  for (const t of rd?.tells || []) tellPass[t.id] = t.pass;
  const mark = (id) => (id in tellPass ? (tellPass[id] ? " ✓" : " ✗") : "");
  const boxes = [{ id: "__bbox", role: "bbox", ...ent.win2cut(it.box) }];   // the tiling cell
  // label fields/tells with their role so the cutout shows what each box does: a field
  // flagged tell shows "⊙tell" + its align; a locating tell shows "loc" + align. After a
  // read, a tell/field-tell box also shows ✓/✗ for whether it passed.
  for (const f of it.fields || []) {
    const al = f.align || it.align || "center";
    const label = `${f.id}${f.tell ? ` ⊙tell·${al}${mark(f.id)}` : ""}`;
    boxes.push({ id: f.id, label, role: "field", field: f.field, ...ent.win2cut(ent.rel2win(f.box)) });
  }
  for (const t of it.tells || []) {
    const al = t.align || it.align || "center";
    const label = `${t.id}${t.locate ? ` loc·${al}` : ""}${mark(t.id)}`;
    boxes.push({ id: t.id, label, role: t.kind === "text" ? "detect" : "scrollbar", ...ent.win2cut(ent.rel2win(t.box)) });
  }
  ent.overlay.setBoxes(boxes);
  // the extracted field values, drawn over their boxes tinted by confidence (same as the
  // window preview). The read returns boxes already in cutout fractions.
  const reads = rd ? Object.values(rd.fields).filter((f) => f.box)
    .map((f) => ({ ...f.box, text: f.value, confidence: f.confidence, substituted: f.substituted })) : [];
  ent.overlay.setPreview(reads);
}

// Re-read the cutout whenever its settings change, debounced and coalesced: config
// edits fire a burst of change events and OCR is heavy, so wait for the dust to settle
// and never run two reads for the same item at once (queue a single re-run instead).
const itemReadTimers = new Map();   // "winId:itemId" -> debounce timer
const itemReadBusy = new Set();     // items with a read in flight
const itemReadAgain = new Set();    // items whose settings changed mid-read
function scheduleItemRead(winId, itemId, delay = 500) {
  const key = `${winId}:${itemId}`;
  clearTimeout(itemReadTimers.get(key));
  itemReadTimers.set(key, setTimeout(() => { itemReadTimers.delete(key); runItemRead(winId, itemId); }, delay));
}

// Read the item's frozen cutout with the current settings and show what it extracts:
// field values tinted on the canvas + a compact tell/validity read-out under the toolbar.
async function runItemRead(winId, itemId) {
  const key = `${winId}:${itemId}`;
  if (!itemCanvases.has(key)) return;
  if (itemReadBusy.has(key)) { itemReadAgain.add(key); return; }   // re-run once after
  itemReadBusy.add(key);
  const node = nodeEls.get(`item:${winId}:${itemId}`);
  const out = node?.querySelector(".item-readout");
  if (out && !out.innerHTML) out.innerHTML = "reading…";
  const done = timed(`item read ${key}`);
  try {
    const res = await api.itemRead(previewProfileFor(winId), model.profile.name, winId, itemId);
    itemReads.set(key, res);
    refreshItemBoxes(winId, itemId);
    if (out) out.innerHTML = itemReadout(res);
    const kp = node?.querySelector(".key-prev");   // key section's preview tracks the new read
    if (kp) kp.innerHTML = keyPrevHTML(winId, itemId);
    done(res.valid ? "· valid" : "· rejected");
  } catch (e) {
    done(String(e.message || e), "err");
    if (out) out.innerHTML = `<span class="tc-bad">${esc(String(e.message || e))}</span>`;
  } finally {
    itemReadBusy.delete(key);
    if (itemReadAgain.has(key)) { itemReadAgain.delete(key); runItemRead(winId, itemId); }
  }
}

// Compact one-line summary of a cutout read: validity + each field's value + tell chips.
function itemReadout(res) {
  const status = res.valid ? '<span class="tc-ok">✓ valid</span>' : '<span class="tc-bad">✗ rejected</span>';
  const fields = Object.entries(res.fields || {}).map(([k, v]) => {
    const cls = v.substituted ? "conf-sub" : v.confidence >= 0.8 ? "conf-ok" : v.confidence >= 0.5 ? "conf-warn" : "conf-bad";
    return `<span class="ir-f">${esc(k)}=<b class="${cls}">${esc(String(v.value ?? "∅"))}</b></span>`;
  }).join(" ");
  const tells = (res.tells || []).map(tellChip).join(" ");
  return `${status} ${fields}${tells ? " · " + tells : ""}`;
}

function selectRegionNode(winId, boxId) {
  const ids = [`reg:${winId}:${boxId}`, `det:${winId}:${boxId}`, `st:${winId}:${boxId}`, `sb:${winId}:${boxId}`];
  selectedNodeId = ids.find((id) => nodeEls.has(id)) || null;
  for (const [id, el] of nodeEls) el.classList.toggle("selected", id === selectedNodeId);
  drawEdges();   // restyle the selected node's line
}

// Focus ANY node (click or drag). Drops box selection so WASD targets the node,
// highlights it + its lines. Box-backed nodes (region/detect/scrollbar) then re-select
// their box on the trailing click, so WASD keeps nudging the box for those.
function focusNode(id) {
  for (const [, rec] of overlays) rec.overlay.setActive(null);
  activeOverlayKey = null;
  selectedNodeId = id;
  clearNodeSelections(id);   // drop any other node's inner selection
  for (const [nid, el] of nodeEls) el.classList.toggle("selected", nid === id);
  drawEdges();
  nmSyncSelection();   // mirror the selection in the node map
}

// ---- live preview node (what the current setup would read) ------------------

function prevHost(winId) {
  const el = nodeEls.get(`prev:${winId}`);
  return el && el.querySelector(".prev-host");
}

function previewProfileFor(winId) {
  const w = model.window(winId);
  return { ...model.profile, windows: w ? [w] : [] };
}

// Coalesce reads: at most ONE OCR request per window is ever in flight. Clicking
// "read" again while one runs doesn't stack another (which would serialize on the OCR
// lock and starve the server threadpool) — it just flags a single re-run with the
// latest inputs once the current one returns. The button stays live.
const previewBusy = new Set();        // winId -> a read is in flight
const previewAgain = new Map();       // winId -> live flag of a queued re-run
// disable + spin the read buttons for this window (preview node + image toolbar) while
// an OCR read runs, so it's obvious it's working and the button can't be re-fired.
function setReadBusy(winId, on) {
  const pnode = nodeEls.get(`prev:${winId}`), wnode = nodeEls.get(`win:${winId}`);
  const btns = [...(pnode?.querySelectorAll(".prevrun") || []), ...(wnode?.querySelectorAll(".imgprev") || [])];
  for (const b of btns) { b.disabled = on; b.classList.toggle("reading", on); }
}
async function refreshPreview(winId, live = false) {
  const host = prevHost(winId);
  if (!host) return;
  host.dataset.ran = "1";   // marks it for live re-reads
  if (previewBusy.has(winId)) { previewAgain.set(winId, live); return; }   // already reading → re-run once after
  previewBusy.add(winId);
  setReadBusy(winId, true);
  if (!live) host.innerHTML = `<p class="muted" style="padding:8px">reading…</p>`;
  const done = timed(`OCR preview ${winId}`);
  try {
    const cap = live ? null : (await api.getBindings(model.profile.name))[winId];
    const res = await api.preview(previewProfileFor(winId), model.profile.name, cap);
    host.innerHTML = previewTable(res.cells);
    setGridFromPreview(winId, res);   // same OCR pass drives the dashed grid
    done(`· ${(res.cells || []).length} cells`);
  } catch (e) {
    done(String(e.message || e), "err");
    host.innerHTML = `<p class="muted" style="padding:8px">${esc(String(e.message || e))}</p>`;
  } finally {
    previewBusy.delete(winId);
    if (previewAgain.has(winId)) {   // a click landed mid-read → run once more (button stays busy, no flicker)
      const lv = previewAgain.get(winId); previewAgain.delete(winId); refreshPreview(winId, lv);
    } else {
      setReadBusy(winId, false);
    }
  }
}

function tellChip(t) {
  // one tell's outcome: "id score/threshold" tinted by pass/fail
  const thr = t.threshold == null ? "" : `<span class="muted">/${t.threshold}</span>`;
  const title = t.detail ? ` title="${esc(t.detail)}"` : "";
  return `<span class="tell-chip ${t.pass ? "tc-ok" : "tc-bad"}"${title}>${esc(t.id)} ${t.score}${thr}</span>`;
}

// "empty" -> "if empty", "if_number" -> "if number" — the badge shown instead of a
// confidence % when a configured fallback produced the value (config, not a read)
const subLabel = (r) => `if ${String(r).replace(/^if_/, "").replace(/_/g, " ")}`;

function previewCell(v) {
  if (!v) return "<td>—</td>";
  if (v.substituted) {
    return `<td class="conf-sub" title="${esc(v.raw || "(empty)")} → ${subLabel(v.substituted)}">${esc(v.value ?? "∅")}</td>`;
  }
  const cls = v.confidence >= 0.8 ? "conf-ok" : v.confidence >= 0.5 ? "conf-warn" : "conf-bad";
  return `<td class="${cls}" title="${esc(v.raw || "")}">${esc(v.value ?? "∅")}</td>`;
}

function previewTable(cells) {
  const all = cells || [];
  const hasItems = all.some((c) => Array.isArray(c.tells));
  if (!hasItems) {
    const kept = all.filter(cellKept);
    if (!kept.length) return `<p class="muted" style="padding:8px">0 rows</p>`;
    const fieldIds = [...new Set(kept.flatMap((c) => Object.keys(c.fields)))];
    const head = fieldIds.map((f) => `<th>${esc(f)}</th>`).join("");
    const rows = kept.slice(0, 200).map((c) => `<tr>${fieldIds.map((f) => previewCell(c.fields[f])).join("")}</tr>`).join("");
    return `<div class="prev-count muted">${kept.length} row${kept.length === 1 ? "" : "s"}</div>
      <table class="grid-table"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
  }

  // item-template diagnostics: show EVERY cell that read something (so rejected arcanes
  // are visible), with its template, status, reject reason, and per-tell scores.
  const read = all.filter((c) => Object.values(c.fields).some((f) => f && f.value !== null && f.value !== "" && f.value !== undefined));
  if (!read.length) return `<p class="muted" style="padding:8px">0 cells read any data</p>`;
  read.sort((a, b) => (b.valid === true) - (a.valid === true));
  const fieldIds = [...new Set(read.flatMap((c) => Object.keys(c.fields)))];
  const head = `<th></th><th>item</th>${fieldIds.map((f) => `<th>${esc(f)}</th>`).join("")}<th>tells</th><th>reason</th>`;
  const rows = read.slice(0, 300).map((c) => {
    const status = c.valid ? '<span class="tc-ok">✓</span>'
      : c.tells_pass ? '<span class="tc-warn">◌</span>' : '<span class="tc-bad">✗</span>';
    const fcols = fieldIds.map((f) => previewCell(c.fields[f])).join("");
    const tells = (c.tells || []).map(tellChip).join(" ");
    return `<tr class="${c.valid ? "" : "prev-rej"}"><td>${status}</td><td>${esc(c.item || "")}</td>${fcols}<td>${tells}</td><td class="muted">${esc(c.reason || "")}</td></tr>`;
  }).join("");
  const nValid = read.filter((c) => c.valid).length;
  return `<div class="prev-count muted">${nValid} kept · ${read.length} read · ✓ kept, ◌ tells pass but lost overlap, ✗ tell failed</div>
    <table class="grid-table"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
}

async function prefillDetectText(winId, detectId) {
  try {
    const b = await api.getBindings(model.profile.name);
    const res = await api.detect(previewProfileFor(winId), model.profile.name, b[winId]);
    const info = res.detect?.[detectId];
    const a = model.detect(winId, detectId);
    if (a && !a.text && info && info.read && info.read !== "(template)") {
      a.text = info.read;
      render(); autosave();
    }
  } catch { /* ignore */ }
}

// Coalesce detect the same way as preview: at most one in flight per window, with a
// single queued re-run. Without this, live mode would enqueue a detect every round and
// they'd stack on the OCR queue until each takes tens of seconds.
const detectBusy = new Set();
const detectAgain = new Map();
async function refreshDetect(winId, live = false) {
  if (detectBusy.has(winId)) { detectAgain.set(winId, live); return; }
  detectBusy.add(winId);
  // spinner on every node whose value this detect refreshes
  const ids = [`win:${winId}`, ...model.detects(winId).map((a) => `det:${winId}:${a.id}`)];
  if (model.scrollbar(winId)) ids.push(`sb:${winId}:scrollbar`);
  const done = timed(`detect ${winId}`);
  try {
    await withBusy(ids, async () => {
      try {
        const cap = live ? null : (await api.getBindings(model.profile.name))[winId];
        const res = await api.detect(previewProfileFor(winId), model.profile.name, cap);
        for (const [aid, info] of Object.entries(res.detect || {})) setDetectStatus(`det:${winId}:${aid}`, info);
        for (const [sid, info] of Object.entries(res.states || {})) setDetectStatus(`st:${winId}:${sid}`, info);
        const sbEl = nodeEls.get(`sb:${winId}:scrollbar`);
        const sbSpan = sbEl && sbEl.querySelector(".detect-status");
        if (sbSpan) {
          const sb = res.scrollbar;
          sbSpan.textContent = sb == null ? "position: —"
            : `position: ${Math.round(sb.pos * 100)}% · ${sb.px}px · ${Math.round(sb.conf * 100)}%`;
        }
        done();
      } catch (e) { done(String(e.message || e), "err"); }
    });
  } finally {
    detectBusy.delete(winId);
    if (detectAgain.has(winId)) { const lv = detectAgain.get(winId); detectAgain.delete(winId); refreshDetect(winId, lv); }
  }
}
function setDetectStatus(nodeId, info) {
  const el = nodeEls.get(nodeId);
  const span = el && el.querySelector(".detect-status");
  if (!span) return;
  const conf = info.score != null ? ` (${Math.round(info.score * 100)}%)` : "";
  span.textContent = (info.matched ? "✓ true" : "✗ false") + conf + (info.read ? ` — "${info.read}"` : "");
  span.className = "detect-status " + (info.matched ? "conf-ok" : "conf-bad");
}
let detectT = null;
function refreshOpenDetect() {
  clearTimeout(detectT);
  detectT = setTimeout(() => {
    for (const winId of imageCanvases.keys())
      if (model.window(winId)?.enabled !== false) refreshDetect(winId);   // skip disabled windows
  }, 700);
}

let previewT = null;
function refreshOpenPreviews() {
  clearTimeout(previewT);
  previewT = setTimeout(() => {
    for (const w of model.profile.windows || []) {
      if (w.enabled === false) continue;   // a disabled window reads nothing — don't re-run it
      const host = prevHost(w.id);
      // re-read the node's OWN bound image (live=false), not a fresh game grab — an edit
      // (a box, a dictionary toggle) shouldn't need the game running, and forcing a live
      // capture 404s "game window not found" when it isn't.
      if (host && host.dataset.ran === "1") refreshPreview(w.id, false);
    }
  }, 700);
}


async function loadImage(winId, recapture) {
  const entry = imageCanvases.get(winId);
  if (!entry) return;
  const game = model.profile.name;
  let url = null;
  const done = timed(`${recapture ? "recapture" : "load image"} ${winId}`);
  setNodeBusy(`win:${winId}`, true);   // capturing/fetching the image
  try {
    if (!recapture) {
      const b = await api.getBindings(game);
      if (b[winId]) url = api.captureUrl(game, b[winId]);
    }
    if (!url) {
      const c = await api.capture(game);          // capture + bind newest
      await api.bindCapture(game, winId, c.name);
      url = c.url;
    }
  } catch (e) { done(String(e.message || e), "err"); setStatus(String(e.message || e)); setNodeBusy(`win:${winId}`, false); return; }
  const img = new Image();
  img.onload = () => {
    done();
    setNodeBusy(`win:${winId}`, false);
    // keep the canvas area at the image aspect ratio so resizing always fits
    entry.canvas.parentElement.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
    entry.overlay.setImage(img);
    refreshImageBoxes(winId);
    drawEdges();
    refreshGridPreview(winId);   // draw the grid where rows actually are in this capture
    updateImageLabel(winId);     // button shows the (possibly new) filename
    // the image changed → re-read it only if the preview node was already run (avoid
    // OCR work nobody asked for)
    if (prevHost(winId)?.dataset.ran === "1") refreshPreview(winId);
    if (recapture) refreshDetect(winId);   // fresh pixels → re-evaluate detectors too
  };
  img.onerror = () => setNodeBusy(`win:${winId}`, false);
  img.src = url;
}

function refreshImageBoxes(winId) {
  const entry = imageCanvases.get(winId);
  if (!entry) return;
  // data area first: drawn under everything and lowest hit priority, so the field
  // regions inside it stay selectable.
  const boxes = [];
  const da = model.dataArea(winId);
  if (da) boxes.push({ id: "__data_area", role: "data_area", ...da });
  for (const r of model.regions(winId)) boxes.push({ id: r.id, role: "region", field: r.field, ...r.box });
  for (const a of model.detects(winId)) boxes.push({ id: a.id, role: "detect", ...a.search });
  // item template box is NOT drawn here — it's the authored cell at one spot, which
  // isn't where detection actually reads; the live grid (below) shows the real cells
  const sb = model.scrollbar(winId);
  if (sb) boxes.push({ id: "scrollbar", role: "scrollbar", ...sb });
  entry.overlay.setBoxes(boxes);
  // prefer the live-detected grid (rows found in the actual capture); fall back to
  // the live-detected grid (where items were actually located this capture)
  entry.overlay.setGridPreview(gridPreviews.get(winId) || []);
  entry.overlay.setPreview(gridReads.get(winId) || []);   // value + confidence per cell
}

// Fetch where the rows ACTUALLY are by OCR-ing the capture, and draw that grid.
// This is what makes the dashed grid follow a scrolled list instead of guessing.
async function refreshGridPreview(winId, live = false) {
  const entry = imageCanvases.get(winId);
  if (!entry) return;
  try {
    const cap = live ? null : (await api.getBindings(model.profile.name))[winId];
    const res = await api.preview(previewProfileFor(winId), model.profile.name, cap);
    setGridFromPreview(winId, res);
  } catch { /* ignore */ }
}

// A cell is a real, kept row: it passed its item tells (valid) AND read some data.
function cellKept(c) {
  if (c.valid === false) return false;
  return Object.values(c.fields).some((f) => f.value !== null && f.value !== undefined && f.value !== "");
}

// Pull the detected per-field boxes + their read values out of a preview response.
// Only kept cells, so blank/invalid slots don't scatter dashes across the image.
function setGridFromPreview(winId, res) {
  if (!res || !res.cells) return;
  const kept = res.cells.filter(cellKept);
  const boxes = kept.flatMap((c) => Object.values(c.fields).map((f) => f.box)).filter(Boolean);
  // what each cell actually read (value + confidence) — shown on the window canvas
  const reads = kept.flatMap((c) => Object.values(c.fields)
    .filter((f) => f.box)
    .map((f) => ({
      ...f.box,
      text: f.value,
      confidence: f.confidence,
      substituted: f.substituted || null,
    })));
  // which item template matched: its id centred on each cell, white on black
  reads.push(...kept.filter((c) => c.box && c.item).map((c) => ({ ...c.box, cell: c.box, text: c.item })));
  if (boxes.length) gridPreviews.set(winId, boxes); else gridPreviews.delete(winId);
  if (reads.length) gridReads.set(winId, reads); else gridReads.delete(winId);
  refreshImageBoxes(winId);
}


// ---- dragging -------------------------------------------------------------
// GRID, snap, addResizeGrips, beginDrag and makeDraggable are imported from dragresize.js
// — the same primitives the floating panels use.

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
  // shared drag loop (dragresize.js) — onMove does the world-space + grid-snap work
  beginDrag(ev, {
    onMove: (e) => {
      const w = toWorld(e);
      const dx = w.x - g0.x, dy = w.y - g0.y;
      p.x = snap(start.px + dx);
      p.y = snap(start.py + dy);
      positionNode(id);
      for (const g of starts) { g.gp.x = snap(g.sx + dx); g.gp.y = snap(g.sy + dy); positionNode(g.gid); }
      drawEdges();
      groups.renderGroups();   // group boxes hug their members live
    },
    onSettle: () => {
      groups.absorb([id, ...extra.filter((x) => x !== id)]);   // dropped inside a group box -> join it
      resizeCanvas(); groups.renderGroups(); persist.layout(); renderNodeMap();
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
function positionNode(id) { const el = nodeEls.get(id); const p = pos.get(id); if (el && p) { el.style.left = `${p.x}px`; el.style.top = `${p.y}px`; } }

// Drag a wire out of a node's `.port.out`. Drop on a dataset node to wire to it, or on
// empty canvas to mint a fresh dataset there and wire to that. ``srcId`` is the source
// node id (win:… / price:…); ``onDrop(ds)`` commits the chosen target dataset.
function startWire(srcId, ev, spec) {
  ev.preventDefault();
  ev.stopPropagation();
  const rect = $("graph").getBoundingClientRect();
  const p = pos.get(srcId);
  if (!p) return;
  const rx = nw(srcId);   // right edge — where the out-port sits
  wire = { x1: p.x + rx, y1: p.y + 28, x2: p.x + rx, y2: p.y + 28 };
  // a spec may accept ONE target type ("subset") or SEVERAL (["subset","price"]) — match any.
  const targets = Array.isArray(spec.target) ? spec.target : [spec.target];
  const sel = targets.map((t) => `.gnode.${t}`).join(",");
  const toWorld = (e) => ({ x: (e.clientX - rect.left - view.panX) / view.zoom, y: (e.clientY - rect.top - view.panY) / view.zoom });
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
      if (nodeEls.has(`ds:${ds}`)) refreshDataNode(ds);
      if (nodeEls.has(`ds:${ds}`)) loadBatchesNode(ds);
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

async function loadGame(name) {
  if (!name) return;
  await persist.flush();   // commit any pending save before switching games
  const done = timed(`load game ${name}`);
  const { profile, local, migrated } = await persist.open(name);
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
  // reopen saved images (canvas lives in node); awaited so boot can tell when the
  // initial image loads (and the detects they fire) have actually started
  await Promise.all(pendingOpenImages.map((winId) => (model.window(winId) ? openImage(winId) : null)));
  pendingOpenImages = [];
  resetHistory();   // fresh undo/redo baseline for this game
  if (migrated) persist.layout();   // lock in node layout imported from legacy localStorage
  refreshLive();
  setStatus(`loaded ${name}`);
}

$("gameSelect").addEventListener("change", (e) => loadGame(e.target.value));
$("newGameBtn").addEventListener("click", () => {
  const name = $("newGameName").value.trim();
  if (!name) return setStatus("enter a name");
  model.load({ name, process_names: [], window_title_hint: null, fields: [], windows: [] });
  pos.clear(); nodeEls.clear(); $("gnodes").innerHTML = "";
  render(); autosave();
  refreshGames(name);
});
// ---- node map (fixed overview / jump-to) ----------------------------------
// A draggable, fixed-to-screen panel that mirrors the graph two ways: a scaled MINI-MAP
// (nodes + connection lines + a viewport box) or a TEXT LIST built by walking the edges.
// Clicking any node in either view smoothly pans+zooms to it. Visibility, position and
// mode persist (global UI pref, not per-game).

const NM_TYPE = { win: "window", prev: "preview", reg: "region", det: "detect",
  sb: "scrollbar", item: "item", ds: "dataset", sub: "subset",
  price: "price", dict: "dictionary" };
const NM_COLOR = { game: "#7aa2f7", window: "#9ece6a", preview: "#56b6c2", region: "#e0af68",
  detect: "#bb9af7", scrollbar: "#f7768e", item: "#7dcfff", dataset: "#e5c07b",
  subset: "#73daca", price: "#ff9e64", dictionary: "#a9b1d6" };
const nmTypeOf = (id) => (id === "game" ? "game" : NM_TYPE[id.split(":")[0]] || "node");
const nmColor = (id) => NM_COLOR[nmTypeOf(id)] || "#9aa5ce";

function nodeLabel(n) {
  switch (n.type) {
    case "game": return n.ref.name || "game";
    case "window": return n.ref.id;
    case "preview": return `${n.ref.id} ▸ preview`;
    case "region": return n.ref.id + (n.field ? ` → ${n.field.id}` : "");
    case "detect": return `detect: ${n.ref.id}`;
    case "scrollbar": return "scrollbar";
    case "item": return n.ref.id;
    case "dataset": return n.ref;
    case "subset": return n.ref.id;
    case "price": return n.ref.id;
    case "dictionary": return n.ref.name || n.ref.id;
    default: return n.id;
  }
}

// Compact id for a map box (no decorations — the box is tiny).
function nodeShort(n) {
  switch (n.type) {
    case "game": return n.ref.name || "game";
    case "preview": return "preview";
    case "scrollbar": return "scroll";
    case "dataset": return n.ref;
    default: return n.ref?.id ?? n.id;
  }
}

// Largest font that fits ``label`` in a ``bw``×``bh`` box, trying both orientations and
// picking whichever is bigger (so a tall box gets vertical text). ~0.58em per char.
function nmFit(label, bw, bh) {
  const n = Math.max(1, label.length), CW = 0.58, PAD = 0.86;
  const fh = Math.min(bh * PAD, (bw * PAD) / (n * CW));   // horizontal
  const fv = Math.min(bw * PAD, (bh * PAD) / (n * CW));   // rotated 90°
  return { fs: Math.min(11, Math.max(fh, fv)), vertical: fv > fh };
}

let nm = null;            // the createFloatWin instance (built once at startup)
let nmTransform = null;   // last map projection {ox,oy,s} for the viewport indicator
// Node-map panel state. Persisted in the profile YAML (layout.float_windows.nodemap) via
// the shared float-window machinery — hydrateLayout feeds it in, collectLayout writes it
// back. `mode` + `sizes` are nodemap's own extras carried in the same blob: `sizes` keeps
// each mode's box (map auto-fits its height to the graph, list is freely resized) so
// toggling restores the entering mode's box instead of carrying one over the other.
const nmState = { visible: false, x: null, y: null, w: null, h: null, mode: "map",
  sizes: { map: { w: null, h: null }, list: { w: null, h: null } } };

// Restore the active mode's saved box into nmState.w/h, then apply. Width always; height
// only in list mode (map height is recomputed by nmFitPanelHeight on render).
function applyNmModeSize() {
  const sz = (nmState.sizes && nmState.sizes[nmState.mode]) || {};
  if (Number.isFinite(sz.w)) nmState.w = sz.w;
  // map mode: drop the height so applySize leaves it to nmFitPanelHeight (auto-fit)
  nmState.h = (nmState.mode === "list" && Number.isFinite(sz.h)) ? sz.h
    : (nmState.mode === "list" ? nmState.h : null);
  nm.applySize();
}

function buildNodeMap() {
  if (nm) return;
  nm = createFloatWin({
    id: "nodemap",
    title: nmState.mode === "list" ? "node list" : "node map",
    headerExtra: `<button class="nm-mode" title="toggle map / list view">${nmState.mode === "list" ? "▤" : "⊞"}</button>`,
    state: nmState,
    bothAxes: () => nmState.mode === "list",   // list: free width+height; map: width only
    onResize: () => {
      if (!nmState.visible || !nm.el.offsetWidth) return;
      nmState.sizes[nmState.mode] = { w: nm.el.offsetWidth, h: nm.el.offsetHeight };   // per-mode box
      renderNodeMap();   // map: refit to new size; list: cheap re-render
    },
    onShow: () => { $("nodemapBtn")?.classList.toggle("active", true); nmSyncHeader(); applyNmModeSize(); renderNodeMap(); },
    onHide: () => { $("nodemapBtn")?.classList.toggle("active", false); },
    onPersist: () => persist.layout(),
  });
  nm.el.querySelector(".nm-mode").addEventListener("click", () =>
    setNodeMapMode(nmState.mode === "map" ? "list" : "map"));
  // jump-to: click a node in either view -> select + smooth pan/zoom; a group row -> frame it
  nm.body.addEventListener("click", (ev) => {
    const g = ev.target.closest("[data-gid]");
    if (g) { const gb = groups.groupBoxes().find((b) => b.id === g.dataset.gid); if (gb) panZoomToRect(gb.box); return; }
    const t = ev.target.closest("[data-id]");
    if (!t) return;
    const id = t.dataset.id;
    if (!nodeEls.has(id)) return;
    focusNode(id); panZoomTo(id); nmSyncSelection();
  });
}

// Reflect the current mode on the header (title text + toggle glyph).
function nmSyncHeader() {
  nm.el.querySelector(".nm-mode").textContent = nmState.mode === "list" ? "▤" : "⊞";
  nm.el.querySelector(".fw-title").textContent = nmState.mode === "list" ? "node list" : "node map";
}

function setNodeMapVisible(on) {
  nm.setVisible(on);   // toggles the button + renders via onShow/onHide
}
function setNodeMapMode(mode) {
  if (mode === nmState.mode) return;
  const right = nm.el.offsetLeft + nm.el.offsetWidth;   // pin right edge so the toggle button stays put
  if (nm.el.offsetWidth) nmState.sizes[nmState.mode] = { w: nm.el.offsetWidth, h: nm.el.offsetHeight };  // stash leaving box
  nmState.mode = mode;
  nmSyncHeader();
  applyNmModeSize();           // restore the entering mode's box
  renderNodeMap();
  nm.place(right - nm.el.offsetWidth, nm.el.offsetTop);   // re-anchor by the right edge
  persist.layout();
}

function nmSyncSelection() {
  if (!nm) return;
  nm.el.querySelectorAll("[data-id]").forEach((e) => e.classList.toggle("sel", e.dataset.id === selectedNodeId));
}

function renderNodeMap() {
  if (!nm || !nmState.visible) return;
  const body = nm.body;
  body.classList.toggle("nm-bmap", nmState.mode === "map");   // centre the wrapped svg
  if (nmState.mode === "list") nmRenderList(body); else nmRenderMap(body);
}

function nmRenderMap(body) {
  const ids = [...pos.keys()].filter((id) => nodeEls.has(id) && Number.isFinite(pos.get(id).x));
  if (!ids.length) { body.innerHTML = `<div class="nm-empty">no nodes</div>`; nmTransform = null; return; }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const rects = ids.map((id) => {
    const p = pos.get(id), w = nw(id), h = nh(id);
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + w); maxY = Math.max(maxY, p.y + h);
    return { id, x: p.x, y: p.y, w, h };
  });
  // Resizing drives WIDTH only; the panel height is then locked to the content's aspect
  // (nmFitPanelHeight) so the map always fills the panel exactly — no empty space.
  const availW = Math.max(120, (body.clientWidth || 276) - 12), PAD = 8;
  const spanX = Math.max(1, maxX - minX), spanY = Math.max(1, maxY - minY);
  const s = (availW - 2 * PAD) / spanX;        // fit to width; height follows
  const W = availW, H = spanY * s + 2 * PAD;   // svg wraps content tightly
  const ox = PAD - minX * s, oy = PAD - minY * s;
  nmTransform = { ox, oy, s };
  const X = (v) => ox + v * s, Y = (v) => oy + v * s;
  const labels = new Map(model.nodes().map((n) => [n.id, nodeShort(n)]));
  // Build edges from the ROUTED geometry (orthogonal polylines), never the live DOM paths
  // which can be mid-bezier during a morph. Uncached links fall back to a straight segment —
  // still never a bezier. World coords, reprojected by one group transform (same as X/Y).
  const edgePaths = buildLinks().map((l) => {
    const c = routeCache.get(l.key);
    const pts = (c && c.pts && c.pts.length >= 2) ? c.pts : [l.p1, l.p2];
    const d = polylinePath(pts, ROUTE.corners, ROUTE.radius);
    return d && !d.includes("NaN") ? `<path d="${d}" />` : "";
  }).join("");
  const node = (r) => {
    const bw = Math.max(2, r.w * s), bh = Math.max(2, r.h * s);
    const x = X(r.x), y = Y(r.y), cx = x + bw / 2, cy = y + bh / 2;
    const lbl = labels.get(r.id) || r.id;
    const rect = `<rect class="nm-n${r.id === selectedNodeId ? " sel" : ""}" data-id="${esc(r.id)}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="1.5" fill="${nmColor(r.id)}"><title>${esc(lbl)}</title></rect>`;
    // size the label to fit; rotate it 90° when that lets it be bigger; hide if it'd be unreadable
    const f = nmFit(lbl, bw, bh);
    const text = f.fs >= 3
      ? `<text class="nm-lbl" x="${cx.toFixed(1)}" y="${cy.toFixed(1)}" font-size="${f.fs.toFixed(1)}"${f.vertical ? ` transform="rotate(90 ${cx.toFixed(1)} ${cy.toFixed(1)})"` : ""}>${esc(lbl)}</text>`
      : "";
    return rect + text;
  };
  // Group boxes (behind everything), hugging their members just like the live layer.
  const groupSvg = groups.groupBoxes().map((gp) => {
    const x = X(gp.box.x), y = Y(gp.box.y), w = gp.box.w * s, h = gp.box.h * s;
    const style = gp.outline.style;
    const stroke = style === "none" ? "none" : gp.outline.color;
    const dash = style === "dashed" ? ` stroke-dasharray="4 3"` : style === "dotted" ? ` stroke-dasharray="1 3"` : "";
    return `<rect class="nm-group" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${gp.bg}" stroke="${stroke}"${dash}><title>${esc(gp.title)}</title></rect>`;
  }).join("");
  // The viewport indicator is a plain DIV moved with a CSS transform (compositor-only) — it
  // must NOT be an SVG element whose geometry attributes are rewritten each pan frame, since
  // that forces a layout, and with this huge DOM each layout is ~3ms (the pan lag).
  body.innerHTML = `<div class="nm-wrap" style="width:${W.toFixed(1)}px;height:${H.toFixed(1)}px;">
    <svg class="nm-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
      <g class="nm-groups">${groupSvg}</g>
      <g class="nm-edges" transform="translate(${ox.toFixed(2)} ${oy.toFixed(2)}) scale(${s.toFixed(4)})">${edgePaths}</g>
      <g class="nm-nodes">${rects.map(node).join("")}</g></svg>
    <div class="nm-vp"></div>
  </div>`;
  nmUpdateViewport();
  nmFitPanelHeight(H);   // shrink/grow the panel height to the content -> no empty space
}

// Lock the panel height to the map content (map mode) so resizing width never leaves a
// vertical gap. Height-only write: the next ResizeObserver tick re-renders with the same
// width and converges (no loop).
function nmFitPanelHeight(svgH) {
  if (!nm || nmState.mode !== "map" || nmState.collapsed) return;   // collapsed owns its height
  const headerH = nm.el.querySelector(".fw-head")?.offsetHeight || 28;
  const targetH = Math.round(svgH + 12 + headerH + 2);   // body padding + header + borders
  if (Math.abs(nm.el.offsetHeight - targetH) > 1) {
    nm.el.style.height = `${targetH}px`; nmState.h = targetH;
  }
}

function nmRenderList(body) {
  const nodes = model.nodes();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const kids = new Map();
  for (const e of model.edges()) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue;
    if (!kids.has(e.from)) kids.set(e.from, []);
    kids.get(e.from).push(e.to);
  }
  // edge-tree walk over a node SUBSET: local roots (no in-subset parent) first, then leftovers
  const orderWalk = (subset) => {
    const indeg = new Map(); for (const id of subset) indeg.set(id, 0);
    for (const e of model.edges()) if (subset.has(e.from) && subset.has(e.to)) indeg.set(e.to, (indeg.get(e.to) || 0) + 1);
    const seen = new Set(), out = [];
    const walk = (id, depth) => {
      if (seen.has(id) || !subset.has(id)) return;
      seen.add(id);
      const n = byId.get(id); if (!n) return;
      out.push({ id, depth, label: nodeLabel(n), type: n.type });
      for (const c of (kids.get(id) || [])) walk(c, depth + 1);
    };
    for (const id of subset) if ((indeg.get(id) || 0) === 0) walk(id, 0);
    for (const id of subset) walk(id, 0);
    return out;
  };

  // groups first (header + their members, indented one level), then everything ungrouped
  const rows = [], grouped = new Set();
  for (const g of groups.allGroups()) {
    const sub = new Set(g.members.filter((id) => byId.has(id)));
    if (!sub.size) continue;
    for (const id of sub) grouped.add(id);
    rows.push({ group: true, gid: g.id, label: g.title || g.id, color: g.outline?.color });
    for (const r of orderWalk(sub)) rows.push({ ...r, depth: r.depth + 1 });
  }
  const ungrouped = new Set(nodes.map((n) => n.id).filter((id) => !grouped.has(id)));
  for (const r of orderWalk(ungrouped)) rows.push(r);

  body.innerHTML = `<div class="nm-list">${rows.map((r) => r.group
    ? `<div class="nm-row nm-grp" data-gid="${esc(r.gid)}" title="zoom to group">
         <span class="nm-gswatch" style="border-color:${r.color || "#9aa5ce"}"></span>${esc(r.label)}</div>`
    : `<div class="nm-row${r.id === selectedNodeId ? " sel" : ""}" data-id="${esc(r.id)}" style="padding-left:${6 + r.depth * 14}px">
         <span class="nm-dot" style="background:${NM_COLOR[r.type] || "#9aa5ce"}"></span>${esc(r.label)}</div>`).join("")
    || `<div class="nm-empty">no nodes</div>`}</div>`;
}

// Cache the graph viewport box — nmUpdateViewport runs every pan FRAME, and reading
// getBoundingClientRect right after applyView writes the transform forces a sync layout
// (the pan lag). The box only changes on resize, so cache and invalidate there.
let _graphBox = null;
function graphBox() { return _graphBox || (_graphBox = $("graph").getBoundingClientRect()); }
window.addEventListener("resize", () => { _graphBox = null; });

function nmUpdateViewport() {
  if (!nm || !nmState.visible || nmState.mode !== "map" || !nmTransform) return;
  const vp = nm.el.querySelector(".nm-vp"); if (!vp) return;
  const rect = graphBox();
  const { ox, oy, s } = nmTransform;
  const x = ox + (-view.panX / view.zoom) * s, y = oy + (-view.panY / view.zoom) * s;
  const w = Math.max(0, (rect.width / view.zoom) * s), h = Math.max(0, (rect.height / view.zoom) * s);
  // width/height only change on ZOOM (not pan) — set them rarely; the per-frame pan update
  // is a pure transform (no layout/paint of the box)
  if (vp._w !== w || vp._h !== h) { vp.style.width = `${w.toFixed(1)}px`; vp.style.height = `${h.toFixed(1)}px`; vp._w = w; vp._h = h; }
  vp.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
}

buildNodeMap();
$("nodemapBtn")?.classList.toggle("active", nmState.visible);
$("nodemapBtn")?.addEventListener("click", () => setNodeMapVisible(!nmState.visible));
// (on-screen re-clamp + re-render on window resize is handled inside createFloatWin)

// ---- activity panel (live sweeps + precapture) ----------------------------
// A floating window listing every running background job for the current game — price
// sweeps and the precapture worker — fetched from /api/activity while it's open. The
// network fetch runs every 1s while the window is focused, every 60s when it's backgrounded
// (plus right after an action that changes state); a 1s local ticker re-renders the cached
// payload in between so countdowns stay live without hammering the server. Rows reconcile in
// place (keyed map) so neither churns the DOM.
const actState = { visible: false, x: null, y: null, w: null, h: null };
let act = null;
let actTick = null;          // 1s local ticker
let actData = null;          // last fetched payload (re-rendered locally between fetches)
let actAt = 0;               // Date.now() of that fetch, used to age the countdowns
let actPolling = false;      // in-flight fetch guard
const actRows = new Map();   // job key -> { row, title, prog }
let actEmpty = null;         // the reused "nothing active" placeholder (never innerHTML)

function buildActivity() {
  if (act) return;
  act = createFloatWin({
    id: "activity", title: "tasks", state: actState, bothAxes: true,
    onShow: () => { $("activityBtn")?.classList.toggle("active", true); startActivityPoll(); },
    onHide: () => { $("activityBtn")?.classList.toggle("active", false); stopActivityPoll(); },
    onPersist: () => persist.layout(),
  });
  act.body.innerHTML = `<div class="act-list"></div>`;
  actEmpty = document.createElement("div"); actEmpty.className = "act-empty"; actEmpty.textContent = "nothing active";
  // one delegated handler for every row's button (cancel a job, or fire a trigger now)
  act.body.addEventListener("click", (ev) => {
    const game = model.profile.name; if (!game) return;
    const c = ev.target.closest("button[data-cancel]");
    if (c && !c.disabled) {
      c.disabled = true; c.textContent = "cancelling…";
      const p = c.dataset.cancel === "sweep" ? api.prices.cancel(game, c.dataset.ds) : api.precapture.cancel(game);
      p.catch(() => {}).finally(() => setTimeout(pollActivity, 300));   // state changed -> refresh
      return;
    }
    const f = ev.target.closest("button[data-fire]");
    if (f && !f.disabled) {
      f.disabled = true; f.textContent = "firing…";
      api.triggers.fire(game, f.dataset.fire).catch(() => {})
        .finally(() => { f.disabled = false; f.textContent = "fire"; pollActivity(); });   // refresh next-fire time
    }
  });
}

// Human-readable duration: 45s / 5m / 5m 30s / 2h 10m.
function fmtDur(s) {
  s = Math.max(0, Math.round(s || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), rs = s % 60;
  if (m < 60) return rs ? `${m}m ${rs}s` : `${m}m`;
  const h = Math.floor(m / 60), rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

function stopActivityPoll() { if (actTick) { clearInterval(actTick); actTick = null; } }

// Fetch from the server and render fresh. Cheap-guarded so overlapping calls (a 10s tick
// landing on an action-triggered refresh) don't stack.
async function pollActivity() {
  if (actPolling || !actState.visible) return;
  const game = model.profile.name;
  if (!game) { actData = { sweeps: [], precapture: null }; actAt = Date.now(); renderActivity(actData, 0); return; }
  actPolling = true;
  try { actData = await api.activity.get(game); actAt = Date.now(); renderActivity(actData, 0); }
  catch { /* ignore transient errors */ }
  finally { actPolling = false; }
}

// any interval trigger whose countdown has just hit zero since the last fetch -> it fired,
// so the server state changed and a refresh is due (don't wait out the 10s)
function actDueForRefresh(elapsed) {
  return (actData?.triggers || []).some((t) => t.kind === "interval" && (t.next_in || 0) > 0 && (t.next_in - elapsed) <= 0);
}

function startActivityPoll() {
  stopActivityPoll();
  pollActivity();   // immediate fetch on open
  actTick = setInterval(() => {
    if (!actState.visible) return;
    const elapsed = (Date.now() - actAt) / 1000;
    // network refresh cadence: 1s while the window is focused, 60s when it's in the
    // background. Also refresh as soon as a countdown elapses. Otherwise just re-render the
    // cached payload so the "fires in …" times keep ticking down locally (no server hit).
    const every = document.hasFocus() ? 1 : 60;
    if (elapsed >= every || (elapsed >= 1.5 && actDueForRefresh(elapsed))) pollActivity();
    else if (actData) renderActivity(actData, elapsed);
  }, 1000);
}

// Map a raw status object to display row specs. Each job: { key, title, prog, cls?, action? }
// where action is {type:"cancel",kind,ds?} | {type:"fire",id} | null.
function activityJobs(data, elapsed = 0) {
  const jobs = [];
  for (const s of (data.sweeps || [])) {
    jobs.push({
      key: `sweep:${s.dataset}`, action: { type: "cancel", kind: "sweep", ds: s.dataset },
      title: `sweep · ${s.dataset}`,
      prog: `${s.done}/${s.total || "…"} · ${s.fetched} ok${s.failed ? ` · ${s.failed} failed` : ""}${s.cancel ? " · cancelling…" : ""}${s.last ? ` · ${s.last}` : ""}`,
    });
  }
  const p = data.precapture;
  if (p) {
    const recog = p.window ? ` · ${p.window}/${p.state}` : "";
    const prog = p.phase === "recording" ? `${p.frames} frames`
      : `${p.processed}/${p.frames} · ${p.read || 0} read · ${p.fps}/s${recog}`;
    jobs.push({ key: "precap", action: { type: "cancel", kind: "precap" }, title: `precapture · ${p.phase}`, prog });
  }
  for (const t of (data.triggers || [])) {
    const running = (t.targets || []).some((x) => x.running);
    let prog;
    if (t.kind === "interval") {
      const remaining = Math.max(0, (t.next_in || 0) - elapsed);   // age locally between fetches
      prog = running ? "firing now…"
        : remaining <= 0 ? `due… · every ${fmtDur(t.interval_s)}`
        : `fires in ${fmtDur(remaining)} · every ${fmtDur(t.interval_s)}`;
    } else if (t.kind === "on_change") {
      prog = `on change: ${(t.watch || []).join(", ") || "—"}${running ? " · firing now…" : ""}`;
    } else { prog = t.kind; }
    jobs.push({ key: `trigger:${t.id}`, cls: "act-trigger", action: { type: "fire", id: t.id },
      title: `trigger · ${t.id}`, prog });
  }
  return jobs;
}

function renderActivity(data, elapsed = 0) {
  if (!act) return;
  const list = act.body.querySelector(".act-list");
  const jobs = activityJobs(data, elapsed);
  const want = new Set(jobs.map((j) => j.key));
  for (const [key, r] of actRows) if (!want.has(key)) { r.row.remove(); actRows.delete(key); }
  if (!jobs.length) {
    if (!actEmpty.isConnected) list.appendChild(actEmpty);   // reuse the placeholder, no innerHTML
    return;
  }
  if (actEmpty.isConnected) actEmpty.remove();
  let i = 0;
  for (const j of jobs) {
    let r = actRows.get(j.key);
    if (!r) {
      const row = document.createElement("div"); row.className = `act-row${j.cls ? ` ${j.cls}` : ""}`;
      const body = document.createElement("div"); body.className = "act-body";
      const title = document.createElement("div"); title.className = "act-title";
      const prog = document.createElement("div"); prog.className = "act-prog";
      body.append(title, prog);
      row.append(body);
      // button is stable per key (sweep/precap → cancel, trigger → fire)
      if (j.action?.type === "cancel") {
        const btn = document.createElement("button");
        btn.className = "act-cancel"; btn.textContent = "cancel";
        btn.dataset.cancel = j.action.kind; if (j.action.ds) btn.dataset.ds = j.action.ds;
        row.append(btn);
      } else if (j.action?.type === "fire") {
        const btn = document.createElement("button");
        btn.className = "act-fire"; btn.textContent = "fire";
        btn.dataset.fire = j.action.id;
        row.append(btn);
      }
      r = { row, title, prog }; actRows.set(j.key, r);
    }
    // place at slot i ONLY if it isn't already there — no needless detach/reattach (which
    // flashes as a "recreate" in devtools + thrashes layout every tick)
    const at = list.children[i];
    if (at !== r.row) list.insertBefore(r.row, at || null);
    i++;
    if (r.title.textContent !== j.title) r.title.textContent = j.title;
    if (r.prog.textContent !== j.prog) r.prog.textContent = j.prog;
  }
}

buildActivity();
$("activityBtn")?.classList.toggle("active", actState.visible);
$("activityBtn")?.addEventListener("click", () => act.setVisible(!actState.visible));

// ---- node-creation toolbox ------------------------------------------------
// Top-level node creation (window / price / trigger / dictionary) lives in this floating
// panel instead of cluttering the game node. Each button mints a node, drops it in a free
// spot, and pans to it. Contextual creation (datasets/views via wire-drag, regions/items by
// drawing on a window image) stays where the context is.
const tbState = { visible: false, x: null, y: null, w: null, h: null };
let tb = null;

function createWindowNode() {
  const id = model.addWindow();   // default id; renamed in the window node
  if (id) { placeNewNode(`win:${id}`, "window"); render(); autosave(); panTo(`win:${id}`); }
}
function createPriceNode() {
  const id = model.addPriceNode();   // independent producer -> "prices" dataset
  if (id) { placeNewNode(`price:${id}`, "price"); render(); autosave(); panTo(`price:${id}`); }
}
function createTriggerNode() {
  const id = model.addTrigger();   // fires price-node sweeps on a condition
  if (id) { placeNewNode(`trigger:${id}`, "trigger"); render(); autosave(); panTo(`trigger:${id}`); }
}
function createDictionaryNode() {
  openDictionaryPicker({
    used: new Set((model.profile.dictionaries || []).map((d) => d.source)),
    // existing word file: re-use its node if already on the graph, else reference it
    // (fetch its terms so the new node shows them straight away).
    onPick: async (source) => {
      const existing = model.dictionaryBySource(source);
      if (existing) { panTo(`dict:${existing.id}`); return; }
      let terms = [];
      try { ({ terms } = await api.dictionaries.get(source)); } catch { /* missing file -> 0 terms */ }
      const id = model.addDictionary({ source, terms });
      if (id) { placeNewNode(`dict:${id}`, "dictionary"); render(); autosave(); panTo(`dict:${id}`); }
    },
    onCreate: (name) => {
      const id = model.addDictionary({ name });
      if (id) { placeNewNode(`dict:${id}`, "dictionary"); render(); autosave(); panTo(`dict:${id}`); }
    },
  });
}

function buildToolbox() {
  if (tb) return;
  tb = createFloatWin({
    id: "toolbox", title: "create", state: tbState, bothAxes: true,
    onShow: () => $("createBtn")?.classList.toggle("active", true),
    onHide: () => $("createBtn")?.classList.toggle("active", false),
    onPersist: () => persist.layout(),
  });
  tb.body.innerHTML = `<div class="tb-list">
    <button class="tb-btn" data-create="window">+ window</button>
    <button class="tb-btn" data-create="price">+ price node</button>
    <button class="tb-btn" data-create="trigger">+ trigger</button>
    <button class="tb-btn" data-create="dictionary">+ dictionary</button>
  </div>`;
  tb.body.addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-create]");
    if (!b) return;
    if (!model.profile.name) { setStatus("load a game first"); return; }
    const k = b.dataset.create;
    if (k === "window") createWindowNode();
    else if (k === "price") createPriceNode();
    else if (k === "trigger") createTriggerNode();
    else if (k === "dictionary") createDictionaryNode();
  });
}
buildToolbox();
$("createBtn")?.classList.toggle("active", tbState.visible);
$("createBtn")?.addEventListener("click", () => tb.setVisible(!tbState.visible));

buildPrecap();
$("liveBtn").addEventListener("click", () => setLiveMode(!liveOn));
$("precapBtn").addEventListener("click", () => {
  if (!pcState.visible && !model.profile.name) { setStatus("load a game first"); return; }
  pc.setVisible(!pcState.visible);
});
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
function groupShortcut() {
  const ids = selectionIds();
  if (!ids.length) return;
  if (ids.length === 1) {
    if (groups.groupOf(ids[0])) { groups.detachNode(ids[0]); setStatus("detached from group"); }
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
$("backupsBtn").addEventListener("click", () => {
  const name = model.profile.name;
  if (!name) return setStatus("load a game first");
  // restoring re-saves the backup live (server snapshots current first) -> reload it fresh
  openBackupsModal(name, () => { loadGame(name); setStatus("restored backup"); });
});
$("graph").addEventListener("mousedown", (ev) => {
  // right-drag pans ANYWHERE (even over nodes/canvas), except form controls so
  // their native menus still work. Don't preventDefault — a plain right click
  // must still open the context menu; only an actual drag suppresses it.
  if (ev.button === 2) { if (!ev.target.closest("input,select,textarea")) startPan(ev); return; }
  // left-drag on empty canvas: rubber-band multi-select (a plain click clears).
  if (ev.button === 0 && !ev.target.closest(".gnode, .ggroup")) startMarquee(ev);
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
  if (suppressNextMenu) { ev.preventDefault(); suppressNextMenu = false; }   // a pan-drag just ended
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
// Live = re-read open windows continuously (view only, no saving). Saving is a
// deliberate precapture step now. live and precapture are mutually exclusive.
// ---- live processing stats (top bar) --------------------------------------
let liveOn = false, precapOpen = false;
let liveFrames = 0, liveT0 = 0, liveFps = 0, liveProcessing = false, liveLast = "";
function showLiveStats(on) {
  const el = $("livestats");
  if (!el) return;
  el.hidden = !on;
  liveFrames = 0; liveT0 = on ? performance.now() : 0; liveFps = 0;
  if (!on) el.textContent = "";
  else renderLiveStats();
}
function renderLiveStats() {
  const now = performance.now();
  if (liveT0 && now - liveT0 >= 1000) {            // recompute rate over a ~1s window
    liveFps = (liveFrames * 1000) / (now - liveT0);
    liveFrames = 0; liveT0 = now;
  }
  const el = $("livestats");
  if (!el || el.hidden) return;
  const state = liveProcessing ? "processing" : "idle";
  el.innerHTML = `<span class="live-dot ${liveProcessing ? "on" : ""}"></span>${state} · ${liveFps.toFixed(1)} img/s${liveLast ? ` · ${esc(liveLast)}` : ""}`;
}

// Self-paced: a round AWAITS its detect+preview before the next is scheduled, so live
// mode adapts to how fast OCR actually is and never piles requests on the OCR queue
// (a fixed interval would stack them until each took tens of seconds).
async function liveTick() {
  if (!liveOn) return;
  refreshLive();   // dataset counts
  const game = model.profile.name;
  if (game) {
    liveProcessing = true; renderLiveStats();
    for (const [winId, entry] of imageCanvases) {
      if (!liveOn) break;
      try {
        const { url } = await api.capture(game, false);   // live frame, not stashed
        const img = new Image();
        img.onload = () => { entry.overlay.setImage(img); refreshImageBoxes(winId); };
        img.src = url;
        liveFrames++;                                      // count captured frames for img/s
      } catch { /* window gone */ }
      await refreshDetect(winId, true);
      if (prevHost(winId)?.dataset.ran === "1") await refreshPreview(winId, true);
    }
    liveProcessing = false; renderLiveStats();
  }
  if (liveOn) timer = setTimeout(liveTick, 200);   // next round only AFTER this one drained
}

function setLiveMode(on) {
  if (on && precapOpen) return;          // mutually exclusive with precapture
  if (on === liveOn) return;             // no change → don't double-start the loop or log twice
  liveOn = on;
  $("liveBtn").classList.toggle("active", on);
  if (timer) { clearTimeout(timer); timer = null; }
  showLiveStats(on);
  if (on) {
    log("live mode started", "run");
    registerWorker("live", "live view", () => setLiveMode(false));
    liveTick();   // kick off the self-paced loop
  } else {
    log("live mode stopped");
    unregisterWorker("live");
  }
}

// ---- init -----------------------------------------------------------------

async function initOcrDevice() {
  const sel = $("ocrDevice");
  if (!sel) return;
  try {
    const st = await api.ocr.getDevice();
    const gpuOpt = sel.querySelector('option[value="gpu"]');
    gpuOpt.disabled = !st.gpu_available;
    if (!st.gpu_available) gpuOpt.textContent = "GPU (n/a)";
    sel.value = st.device;
    sel.addEventListener("change", async () => {
      const done = timed(`OCR device → ${sel.value}`);
      try { const r = await api.ocr.setDevice(sel.value); sel.value = r.device; done(); }
      catch (e) { done(String(e.message || e), "err"); }
    });
    const scaleSel = $("ocrScale");
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
  msg(t) { const m = document.getElementById("bootveilMsg"); if (m) m.textContent = t; },
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

// Block the whole UI with an unmissable message and refuse to continue.
function haltStartup(msg) {
  veil.drop();   // the halt overlay must be visible (the veil sits above it)
  log(msg, "err");
  const o = document.createElement("div");
  o.className = "startup-halt";
  o.innerHTML = `<div class="startup-halt-box"><h3>Background OCR still running</h3>
    <p>${esc(msg)}</p>
    <p class="muted">Nothing was loaded. Kill the stray worker (or the python process), then retry.</p>
    <button class="startup-halt-retry">retry</button></div>`;
  document.body.appendChild(o);
  o.querySelector(".startup-halt-retry").addEventListener("click", () => location.reload());
}

// On page load, kill any background OCR worker from a prior session and WAIT for it to
// die. Do NOT load the graph until it's confirmed gone — a stray worker keeps hammering
// the GPU/game and is the thing you'd otherwise have to hunt down in Task Manager.
async function killStrayOcrThenBoot() {
  setLogOpen(true);   // show the log history during boot so initial-load progress is visible
  try {
    veil.msg("stopping stray OCR…");
    const r = await api.precapture.killAll();
    if (r.alive && r.alive.length) {
      haltStartup(`OCR worker for ${r.alive.join(", ")} would not stop within the timeout.`);
      return;   // refuse to proceed
    }
    if (r.killed && r.killed.length) setStatus(`stopped stray OCR: ${r.killed.join(", ")}`);
  } catch (e) {
    haltStartup(`Could not confirm background OCR was stopped: ${e.message || e}`);
    return;   // can't verify -> don't proceed
  }
  try {
    veil.msg("loading profile…");
    await refreshGames();
    if ($("gameSelect").value) await loadGame($("gameSelect").value);
    initOcrDevice();
    veil.msg("first read…");
    await bootSettle();
  } catch (e) {
    log(String(e.message || e), "err");   // boot hiccup: show the page anyway
  }
  veil.drop();
  setLogOpen(false);   // boot done -> collapse the log back to its one-line bar
}
killStrayOcrThenBoot();
