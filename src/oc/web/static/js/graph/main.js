// Node-view home: edit a game's structure as a graph (Game → Windows → Fields →
// Datasets), drag to arrange, drag-wire a window to a dataset, edit inline, and
// watch live dataset counts. Box drawing happens on each node's inline canvas.
import * as api from "../api.js";
import * as conn from "../conn.js";
import * as hub from "../hub.js";
import { h, frag, svg, TRASH, labCell, srcRow, observeResize, kv, subhead, gspan, trashBtn } from "../dom.js";
import { listBlock } from "./list_block.js";
import { sourcesInput } from "./sources_input.js";
import { makeArmed } from "./armbtn.js";
import { nodeIcon, iconFor } from "./node_icons.js";
import { openModal } from "../modal.js";
import { since } from "../datefmt.js";
import { log, timed, setLogOpen, mirrorConsole } from "../log.js";

mirrorConsole();   // surface uncaught errors + console.error/warn in the log bar (no devtools needed)
import { wireProducerNode } from "./producer_node.js";
import { GRID, snap, snapUp, showSizeHud, hideSizeHud, addResizeGrips, beginDrag } from "./dragresize.js";
import { floatWins } from "./floatwin.js";
import { playSound } from "./sound.js";
import { setTableStore } from "./table.js";
import { setVTableStore, reapplyPersistedVTables, vtableById, liveVTables } from "../vtable.js";
import { initPersist, persist, setScrubHook } from "./persist.js";
import * as prettyOverrides from "../pretty/overrides.js";
import { buildBackups } from "./backups.js";
import * as groups from "./groups.js";
import { initTitlebar } from "../titlebar.js";
import { openLogStream } from "../logstream.js";

initTitlebar();   // custom window chrome — no-op outside the desktop window

import {
    $, setStatus, model, pos, nodeEls, collapsed, view, selected, nodeSizes, openImages,
    imageCanvases, itemCanvases, busy, overlays,
    prevPresent, prevLastTs, dsTab, clearGrid, nw, nh, boot,
} from "./state.js";
import {
    drawEdges, requestEdges, flushEdges, nodeRect, freezeRouting,
    setDraggingNodes,
} from "./routing.js";
import { initFlow } from "./flow.js";
import {
    cancelPan, panTo, panZoomTo, panZoomToRect, zoomToNode, viewportCenterWorld,
    applyView, resizeCanvas, onWheel, startPan, consumePanSuppress, MIN_ZOOM,
} from "./camera.js";
import { movePos, moveWindowPos, moveItemPos, renameNode, forgetNodeState } from "./node_lifecycle.js";
import { imageTextInspector } from "./toast_node.js";
import { nodeParts, windowControls, gamePriority, itemLists, _colOpts, satToggleBtn, slideToggle, vtShowRemoved, rectEditBtn, aggregateSelect } from "./node_parts.js";
import { renderTriggerHistory } from "./history_node.js";
import { refreshRegister } from "./register_node.js";
import * as dsevents from "./dsevents.js";
import { wireTools, clearTools } from "./drawtool.js";
import { singleFlight } from "../singleflight.js";
import {
    nmState, nlState, buildNodeMap, buildNodeList, setNodeMapVisible, setNodeListVisible,
    nmSyncSelection, renderNodeViews,
} from "./panels/nodemap.js";
import { act, actState, buildActivity } from "./panels/activity.js";
import { testWin, testState, buildTesting } from "./panels/testing.js";
import { statsWin, statsState, buildStats } from "./panels/stats.js";
import { dbWin, dbState, buildDBStruct } from "./panels/dbstruct.js";
import {
    tb, tbState, buildToolbox,
    createWindowNode, createProducerNode, createTriggerNode, createDictionaryNode, createFileSourceNode,
    createToastNode, createSoundNode, createActionNode, createRegisterNode, createDatasetNode, createSubsetNode,
} from "./panels/toolbox.js";
import { openContextMenu } from "../ctxmenu.js";
import {
    vtables, vtableFor, refreshDataNode, refreshDatasetNode, expandSubsetRow,
    collapseVtablesExcept,
    batchesState, batEls, loadBatchesNode,
} from "./panels/datanodes.js";
import {
    pc, pcState, buildPrecap, fmtBytes,
} from "./panels/precap.js";
import { pushHistory, resetHistory, undo, redo, hist } from "./history.js";
import { createHistoryPanel } from "../history_panel.js";
import { workers, unregisterWorker } from "./workers.js";
import {
    closeImage, openImage, openAtlasImage, armPreprocessPick, refreshDetect, nodeIdOf,
    closeItemImage, setItemCellKeepingChildren, openItemImage, refreshItemBoxes,
    scheduleItemRead, refreshItemReadout,
    ocrBusyCount,
    commitPreviewNode,
    scheduleWindowRead,
    refreshImageBoxes, refreshGridPreview, selectRegionNode, refreshRuleTrace, refreshReadoutValues,
    RECT_TYPES, toggleRectEditor, rectEditCanvasSync, editBox,
} from "./imaging.js";
import * as rectTxn from "./rect_txn.js";
import {
    liveWin, liveWinState, buildLiveWindow, renderLiveWindow, syncLiveFromServer, applyLiveInterval, syncWpDots,
    liveCollecting,
} from "./panels/livewin.js";

const COLX = { game: 20, window: 300, filesource: 460, trigger: 560, action: 620, register: 660, producer: 700, preview: 1580, region: 600, detect: 600, state: 600, scrollbar: 600, item: 600, itemfield: 850, itemtell: 1080, dataset: 900, subset: 1900, vttable: 2300, prod: 1080, dictionary: 20 };
// Nodes resized on the WIDTH axis only — height always fits content (never stamped/restored).
// item/window wrap a fixed-aspect canvas; dataset/subset/price are config-only, reworked often
// with visibility-toggleable inputs, so a frozen height would clip or leave dead space.
// Only the fixed-aspect canvas nodes are width-only (height follows their image aspect).
// Every other node — incl. the config nodes (dataset/subset/producer) — is freely resizable.
const WIDTH_ONLY_NODES = new Set(["item", "window", "game", "atlas"]);
const FLOW_FALLBACK_MS = 15000;   // safety-net /api/flow poll; the dataset-change bus is the real mechanism
// One-shot boot prefetch: every dataset detail + subset view fetched in a SINGLE /details request
// before the nodes are built, so each node renders from this map instead of firing its own fetch
// (collapses the per-node fan-out — and the same source dataset fetched once per consumer — into
// one request). Null except during a game load; the live path fetches per-node as before.
let _bootDetails = null;
export let live = {};             // dataset -> {present,total,last_op,last_ts} (read by datanodes/refreshLive)
export let wire = null;           // active drag-wire {winId, x1,y1} (read by routing.drawEdges)
export let selectedNodeId = null; // node whose line(s) are highlighted (read by routing.selClsFor)
// Setter so modules that only IMPORT this binding (imaging.js) can update it — an imported
// `let` is read-only in the importer, so a direct assignment there throws.
export function setSelectedNodeId(v) { selectedNodeId = v; }

// Central registry of EVERY drawing overlay lives in state.js; selection, deselection, and
// box hotkeys are handled in ONE place here — any new overlay registers and gets
// cross-deselect + WASD for free. rec = { overlay, kind, winId, itemId?, persist(box), refresh() }.
let activeOverlayKey = null;        // which overlay holds the live box selection

// THE ONE WASD nudge convention, shared by every mover: WASD = move one step, Shift+WASD =
// resize (A/D width, W/S height). Both the graph handler (nodes + registry box overlays) and the
// toast-image element editor read this SAME map — no per-editor copy, no divergent modifier.
const NUDGE = { w: [0, -1], a: [-1, 0], s: [0, 1], d: [1, 0] };

function registerOverlay(key, rec) { overlays.set(key, { key, ...rec }); }
function unregisterOverlay(key) { overlays.delete(key); if (activeOverlayKey === key) activeOverlayKey = null; }

// THE selection chokepoint: an overlay reports it selected `id` (or null). Deselect
// every other overlay so only one box is ever active across the whole editor.
function overlaySelected(key, id) {
    activeOverlayKey = id ? key : (activeOverlayKey === key ? null : activeOverlayKey);
    for (const [k, rec] of overlays) if (k !== key) rec.overlay.setActive(null);
    const rec = overlays.get(key);
    // A canvas box click (onSelect) routes here with the overlay key. Highlight the box's node.
    const winKey = key.startsWith("win:");
    if (id && (rec ? rec.kind === "window" : winKey))
        selectRegionNode(rec ? rec.winId : key.slice(4), id);   // highlight its node
    else { selectedNodeId = null; for (const [, el] of nodeEls) el.classList.remove("selected"); drawEdges(); }
}

// Switch a detector between kinds by toggling the discriminating fields (the model infers
// kind from which are set — see detectKind in node_parts). text=OCR; color/border=cheap.
function setDetectKind(a, kind) {
    if (kind === "text") { a.text = a.text ?? ""; delete a.color; delete a.width; }
    else {                                  // color or border (both cheap, no OCR)
        delete a.text;
        a.color = a.color ?? ""; a.tolerance = a.tolerance ?? 32;
        if (kind === "border") a.width = a.width || 0.1; else delete a.width;
    }
}
let pendingOpenImages = [];

// Show/hide a node's spinner via a ref count, so overlapping async tasks behave. Also locks the
// body against KEYBOARD input, not just mouse: the CSS `.gnode.busy > .gn-body` rule
// (pointer-events:none) only blocks pointer interaction — an input already focused when the node
// went busy would keep taking keystrokes, and Tab can still focus INTO a pointer-events:none
// subtree (pointer-events has no effect on tab order). `inert` is the one attribute that blocks
// pointer AND keyboard AND tab-focus, and — per the HTML spec — forcibly blurs anything already
// focused inside the subtree the moment it's set, so a mid-edit input doesn't keep accepting input.
function setNodeBusy(nodeId, on) {
    const n = (busy.get(nodeId) || 0) + (on ? 1 : -1);
    if (n <= 0) busy.delete(nodeId); else busy.set(nodeId, n);
    const el = nodeEls.get(nodeId);
    const isBusy = (busy.get(nodeId) || 0) > 0;
    el?.classList.toggle("busy", isBusy);
    const body = el?.querySelector(".gn-body");
    if (body) body.inert = isBusy;
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

// autosave(changed): persist the profile, then re-run detect/OCR ONLY for the window the edit
// can affect — resolved by following the graph (model.windowOf). Pass the edited node's id (a
// window id, or any reg/det/sb/item/fld/tell id under it). A data-plane node id (ds/sub/
// producer/src/trigger/dict) or null/omitted resolves to no window -> nothing re-fires. This
// is the safe default: a forgotten arg persists only, it can never fan out to all windows.
// scheduleWindowRead (imaging.js) is the ONE shared settle clock for preview+detect(+trace/item
// reads) — a genuine all-windows refresh calls it with no id.
function autosave(changed = null) {
    if (!model.profile.name) return;
    persist.content();                 // debounced profile save; onContentSaved fires on success
    const win = model.windowOf(changed);
    if (win) scheduleWindowRead(win);  // edit lies in this window's subgraph -> re-read just it
    pushHistory();                     // record this change for undo/redo
}

// Live node-layout state (positions/sizes/collapse/open-images) ↔ the profile. persist
// calls collectLayout() before every profile PUT, and loadGame calls hydrateLayout()
// after a load. Table column state is folded in by table.js via the injected store.
function collectLayout() {
    const L = (model.profile.layout = model.profile.layout || {});
    const nodes = {};
    for (const [id, p] of pos) {
        if (!nodeEls.has(id)) continue;   // orphan coord (deleted/renamed node) — don't re-persist it
        const n = { x: p.x, y: p.y };
        const sz = nodeSizes.get(id);
        if (sz) { n.w = sz.w; n.h = sz.h; if (sz.custW !== undefined) n.custW = sz.custW; if (sz.custH !== undefined) n.custH = sz.custH; }
        if (collapsed.has(id)) n.collapsed = true;
        nodes[id] = n;
    }
    L.nodes = nodes;
    L.open_images = [...openImages];
    L.satellites = model.satelliteIds();       // which preview / vt-table followers are shown (opt-in)
    L.tables = L.tables || {};
    L.groups = groups.collect();
    L.super_groups = groups.collectSuper();   // groups-of-groups travel with the profile too
    L.sub_groups = groups.collectSub();        // groups-within-a-group travel with the profile too
    L.schemes = groups.collectSchemes();       // user-added colour schemes travel with the profile too
    // floating panels are NOT persisted (session-only) — drop any stale saved state so it's
    // cleaned from the profile on the next write.
    delete L.float_windows;
}
// Node-spatial layout ONLY (positions/sizes/collapse, groups, satellites, open-image LIST).
// SHARED by the initial load and by an undo/redo restore (CLAUDE.md rule 7) — everything here is
// in-history state the user asked to keep. Deliberately does NOT reset the floating panels (that's
// session-only, load path only): an undo must never yank the history panel itself shut.
function hydrateNodeLayout() {
    pos.clear(); nodeSizes.clear(); collapsed.clear();
    const L = model.profile.layout || {};
    for (const [id, n] of Object.entries(L.nodes || {})) {
        if (Number.isFinite(n.x) && Number.isFinite(n.y)) pos.set(id, { x: n.x, y: n.y });
        // >0, not just finite: a legacy 0,0 (from the old zero-box settle bug) means "no saved
        // size" — storing it would block the real size from ever applying (0 is falsy downstream).
        if (n.w > 0 && n.h > 0) nodeSizes.set(id, { w: n.w, h: n.h, custW: n.custW, custH: n.custH });
        if (n.collapsed) collapsed.add(id);
    }
    pendingOpenImages = [...(L.open_images || [])];
    model.setSatellites(L.satellites);     // restore which preview / vt-table followers are shown
    groups.hydrateSchemes(L.schemes);      // user-added colour schemes (before any popover opens)
    groups.hydrate(L.groups);
    groups.hydrateSuper(L.super_groups);   // after groups (super groups reference group ids)
    groups.hydrateSub(L.sub_groups);       // after groups (sub groups reference a parent group + its nodes)
}
function hydrateLayout() {
    hydrateNodeLayout();
    // floating panels are session-only: never restored from the profile -> always start at their
    // defaults (all hidden). hydrate(undefined) resets each to its _default state. LOAD path only.
    for (const [, w] of floatWins()) w.hydrate(undefined);
}

// Open/close window image canvases to match `pendingOpenImages` (set by hydrateNodeLayout from the
// restored layout). Used by an undo/redo restore so "which window images are open" travels with
// history. Must run AFTER render() so openImage can resolve each window node's live host.
async function reconcileOpenImages() {
    const want = new Set(pendingOpenImages);
    pendingOpenImages = [];
    for (const winId of [...openImages]) if (!want.has(winId)) closeImage(winId);   // close the ones no longer wanted
    await Promise.all([...want].map((winId) =>
        (!openImages.has(winId) && model.window(winId) ? openImage(winId) : null)));
}

// Per-device viewport (canvas zoom/pan) ↔ the gitignored sidecar. Floating panels are not
// persisted at all now (session-only, all start hidden) — see hydrateLayout/collectLayout.
function collectLocal() {
    return { view: { panX: view.panX, panY: view.panY, zoom: view.zoom } };
}
function applyLocal(local) {
    if (local?.view && Number.isFinite(local.view.zoom)) {
        Object.assign(view, local.view);
        view.zoom = Math.max(MIN_ZOOM, view.zoom);   // restored manual zoom: lower bound only, no font cap
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
    // a pure layout move (drag/resize/collapse/group/open-image/satellite/table width) is an
    // undoable edit now, so the layout funnel records history too (config edits push via autosave).
    recordHistory: () => pushHistory(),
    onContentSaved: (err) => {
        if (err) { setStatus(err); return; }
        setStatus("saved ✓");
        refreshChangedSubsetNodes();   // backend now knows new/edited subsets -> fill ONLY those (no more 404)
    },
});

// ---- groups (titled boxes around nodes; pure layout) -----------------------
// Node type from its id prefix (game | win:… | reg:… | ds:… | …) for default titles.
const _TYPE_BY_PREFIX = { win: "window", prev: "preview", vt: "vttable", vtd: "vttable", prod: "vttable", hist: "vttable", reg: "region", register: "register", ro: "readout", det: "detect", sb: "scrollbar", item: "item", fld: "itemfield", tell: "itemtell", ds: "dataset", sub: "subset", producer: "producer", trigger: "trigger", action: "action", dict: "dictionary", src: "filesource", toast: "toast", sound: "sound" };
function nodeTypeOf(id) { return id === "game" ? "game" : id === "atlas" ? "atlas" : (_TYPE_BY_PREFIX[id.split(":")[0]] || null); }
groups.initGroups({
    world: () => $("ggroups"),
    superWorld: () => $("sgroups"),
    zoom: () => view.zoom,   // current camera scale, so a fresh group box picks the right border width
    nodeRect: (id) => nodeRect(id),
    nodeType: nodeTypeOf,
    // every visible satellite (a window's preview, a dataset/subset's vt-table) is bonded to its
    // parent: it shares the parent's group, follows it in/out, and is never grouped on its own.
    bonds: () => model.satelliteBonds(),
    subWorld: () => $("subgroups"),
    moveMembers: (ids, ev) => { const lead = ids.find((id) => pos.get(id)); if (lead) moveNodes(lead, ids.filter((x) => x !== lead), ev); },
    persist: () => persist.layout(),
    afterChange: () => { syncMultiSelect(); },
    // double-click a group → frame its bounding box (reuses groupBoxes() geometry)
    zoomToGroup: (gid) => { const gb = groups.groupBoxes().find((b) => b.id === gid); if (gb) panZoomToRect(gb.box, { onlyIn: true }); },
    // drag the group's resize grip → resize the group's container box (sets explicit w/h)
    startGroupResize: (gid, ev) => startGroupResize(gid, ev),
});

// Node identity / per-id state (rename + delete carry, the rename flow) lives in node_lifecycle.js
// — see the imports at the top of this file.

// Node body builders (windowControls/itemLists/fieldConfigBody/nodeParts/keyPrevNode/…) live in node_parts.js

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
    // inherit the source's SUBGROUP too, so a box drawn on a window inside a subgroup joins it
    const sg = groups.subgroupOf(srcId);
    if (sg) groups.addToSubgroup(sg.id, [newId]);
}

// pan/zoom camera (panTo/panZoomTo/applyView/resizeCanvas/onWheel/…) lives in camera.js

// ---- group resize: resize the group's CONTAINER box (sets explicit w/h) -----
// Dragging the bottom-right grip resizes the group box itself, NOT its members: it writes an
// explicit g.w / g.h (grid-stepped) that groupBox() honours instead of auto-hugging the members.
// The box's top-left stays pinned to the members, so the grip grows the box down + right from
// there. Both axes can later be cleared back to "auto" independently from the settings panel.
const GROUP_MIN = GRID * 4;   // floor so a group box can't collapse to nothing while dragging
function startGroupResize(gid, ev) {
    ev.preventDefault(); ev.stopPropagation();
    const g = groups.allGroups().find((x) => x.id === gid);
    if (!g) return;
    const gb = groups.groupBoxes().find((b) => b.id === gid);
    if (!gb) return;
    const w0 = gb.box.w, h0 = gb.box.h, z = view.zoom, start = { x: ev.clientX, y: ev.clientY };
    cancelPan();
    let lw = w0, lh = h0;
    const onMove = (e) => {
        const dx = (e.clientX - start.x) / z, dy = (e.clientY - start.y) / z;   // drag the bottom-right outward
        lw = Math.max(GROUP_MIN, snap(w0 + dx));
        lh = Math.max(GROUP_MIN, snap(h0 + dy));
        g.w = lw; g.h = lh;
        groups.renderGroups();
        requestEdges();   // box changed -> gates + the group's hard obstacle moved: re-path (coalesced 1/frame)
        showSizeHud(lw, lh, e.clientX, e.clientY);
    };
    const onUp = () => {
        document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp);
        hideSizeHud(); flushEdges(); persist.layout(); pushHistory();   // final clean re-path on settle
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
}

// ---- render ---------------------------------------------------------------





// Keep the cell-size inputs in sync after a canvas cell-resize (which doesn't rebuild the node).
function syncCellSize(winId, itemId) {
    const node = nodeEls.get(`item:${winId}:${itemId}`), it = model.item(winId, itemId);
    if (!node || !it || !it.box) return;
    for (const k of ["w", "h"]) {
        const inp = node.querySelector(`.csize[data-k="${k}"]`);
        if (inp && document.activeElement !== inp) inp.value = +(+it.box[k]).toFixed(4);
    }
}





// Shared wiring for a field's RULE PIPELINE editor (region / item-field / readout nodes all
// call this). `rebuild` re-renders the node body (structure changed: add/remove/reorder a rule,
// or a when/then whose operands differ); `commit` persists a plain operand edit in place;
// `retrace` re-runs the live `in → out` trace under each row. A structural change rebuilds the
// DOM, so `rebuild` re-traces itself (the caller wires that); a plain commit re-traces here.
// Cross-field rule clipboard: "copy" stashes a field's whole pipeline here, "paste" replaces
// another field's rules with a deep clone of it (survives across nodes for this session).
let ruleClipboard = [];

function wireFieldRules(div, fd, { rebuild, commit, retrace }) {
    fd.rules = fd.rules || [];
    const doTrace = () => retrace?.(div);   // hand the live node body over (see refreshRuleTrace)
    const rule = (e) => fd.rules[+e.target.dataset.ri];
    const edit = (e, k) => { rule(e)[k] = e.target.value; commit(); doTrace(); };
    const editNum = (e, k) => { rule(e)[k] = +e.target.value; commit(); doTrace(); };

    div.querySelector(".ruleadd")?.addEventListener("click", () => {
        fd.rules.push({ when: "always", then: "set", value: "" });
        rebuild();
    });
    div.querySelector(".rulecopy")?.addEventListener("click", () => {
        ruleClipboard = structuredClone(fd.rules);   // stash a deep copy
        // enable EVERY paste button now something's on the clipboard (paste is cross-node, so a
        // sibling node's button — rendered before this copy — must un-disable too)
        document.querySelectorAll(".rulepaste").forEach((pb) => { pb.disabled = false; });
    });
    const pasteBtn = div.querySelector(".rulepaste");
    if (pasteBtn) {
        pasteBtn.disabled = !ruleClipboard.length;   // nothing copied yet -> nothing to paste
        pasteBtn.addEventListener("click", () => {
            if (!ruleClipboard.length) return;
            fd.rules = structuredClone(ruleClipboard);   // paste REPLACES all current rules
            rebuild();
        });
    }
    div.querySelectorAll(".rulemv").forEach((b) => b.addEventListener("click", (e) => {
        const i = +e.currentTarget.dataset.ri, j = i + +e.currentTarget.dataset.d;
        if (j < 0 || j >= fd.rules.length) return;
        const [r] = fd.rules.splice(i, 1); fd.rules.splice(j, 0, r); rebuild();   // reorder = pipeline order
    }));
    // when / then change the row's operands -> rebuild; the rest are plain in-place edits
    div.querySelectorAll(".rule-when").forEach((s) => s.addEventListener("change", (e) => { rule(e).when = e.target.value; rebuild(); }));
    div.querySelectorAll(".rule-then").forEach((s) => s.addEventListener("change", (e) => { rule(e).then = e.target.value; rebuild(); }));
    div.querySelectorAll(".rule-dmode").forEach((s) => s.addEventListener("change", (e) => { rule(e).dict_mode = e.target.value; rebuild(); }));
    div.querySelectorAll(".rule-strategy").forEach((s) => s.addEventListener("change", (e) => { rule(e).strategy = e.target.value; rebuild(); }));   // toggles the sep input
    div.querySelectorAll(".rule-arg").forEach((inp) => inp.addEventListener("input", (e) => edit(e, "arg")));
    div.querySelectorAll(".rule-val").forEach((inp) => inp.addEventListener("input", (e) => edit(e, "value")));
    div.querySelectorAll(".rule-sep").forEach((inp) => inp.addEventListener("input", (e) => edit(e, "sep")));
    div.querySelectorAll(".rule-udict").forEach((s) => s.addEventListener("change", (e) => edit(e, "dict_id")));
    div.querySelectorAll(".rule-fuzzy").forEach((inp) => inp.addEventListener("change", (e) => editNum(e, "fuzzy")));
    // delete is an armed two-click (rule 2): first click turns it yellow, a click anywhere else
    // or Escape resets it, a second click removes the rule.
    div.querySelectorAll(".rule-del").forEach((b) => armConfirm(b, () => {
        fd.rules.splice(+b.dataset.ri, 1); rebuild();
    }, { silent: true, resetOnOutside: true }));
    doTrace();   // paint the trace for the freshly-built rows (uses the live body, not a nodeEls lookup)
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
    autosave(reread ? winId : null);           // persist; re-run this window's preview/detect only when reread
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
    // min-coverage (occlusion guard) — stored as a 0..1 fraction, edited as a %. Re-read so the
    // canvas immediately reflects which cells the new threshold dismisses.
    div.querySelectorAll(".ccover").forEach((inp) => inp.addEventListener("change", (e) => {
        const it = model.item(winId, itemId);
        if (!it) return;
        const axis = e.target.dataset.k;
        model.setItemCover(winId, itemId, axis, +e.target.value || 0);
        itemChanged(winId, itemId);
    }));
    // terminator toggle — pure config (no pixels change), so persist without a re-read
    div.querySelector(".iterm")?.addEventListener("change", (e) => {
        model.setItemTerminator(winId, itemId, e.target.checked);
        itemChanged(winId, itemId, { reread: false });
    });
    div.querySelector(".gi-id").addEventListener("change", (e) => {
        renameNode(e.target, itemId,
            () => model.renameItem(winId, itemId, e.target.value.trim()),
            () => moveItemPos(winId, itemId, n.ref.id),   // carry the item AND its field/tell child nodes (no jump)
            () => { itemChanged(winId, n.ref.id, { render: true, reread: false }); rebuildNode(`win:${winId}`); });   // id only — no pixels/boxes change; refresh the window's items list too
    });
    // the merged fields/tells table has no indirect removal buttons — a field/tell is removed on
    // its OWN node. A row click just pans to that child node (its box is selectable on the cutout).
    div.querySelectorAll(".mr-row").forEach((row) => row.addEventListener("mousedown", () => {
        if (row.dataset.fid) panZoomTo(`fld:${winId}:${itemId}:${row.dataset.fid}`);
        else if (row.dataset.tid) panZoomTo(`tell:${winId}:${itemId}:${row.dataset.tid}`);
    }));
    // cutout draw-mode buttons live in the node body now: pick the active draw kind. The canvas
    // overlay reads the armed tool off this node (see openItemImage's kindOf). wireTools marks the
    // whole node as the tool host so right-click / Escape / click-outside can drop the tool centrally.
    wireTools(div);
    // record-key config: mutate the item's own KeyDef (created from the effective one on
    // first edit). The key preview recomputes from the cached read; itemChanged rebuilds.
    const keyEdit = (fn) => {
        const k = model.ensureItemKey(winId, itemId);
        if (!k) return;
        fn(k);
        itemChanged(winId, itemId, { rebuild: true, reread: false });   // record identity only — no OCR change
        refreshItemReadout(winId, itemId);   // the key lives in the merged table now; refresh it (the re-read is debounced)
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
    // fill the freshly-built merged table from the last cached read (the canvas may be closed, so
    // refreshItemBoxes wouldn't run) — subsequent reads update it in place via refreshItemBoxes.
    refreshItemReadout(winId, itemId);
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
    autosave(winId);
}

// Wire one item-field node: the per-field config that used to live inline in the item node.
function wireItemField(div, n) {
    const winId = n.win.id, itemId = n.item.id, fid = n.ref.id;
    div.querySelector(".gi-id").addEventListener("change", (e) => {
        renameNode(e.target, fid,
            () => model.renameItemField(winId, itemId, fid, e.target.value.trim()),
            () => movePos(`fld:${winId}:${itemId}:${fid}`, `fld:${winId}:${itemId}:${n.ref.id}`),
            () => fieldChanged(winId, itemId, n.ref.id, { render: true }));
    });
    // Only the capture/confidence knobs live on the field body now; all value processing is
    // authored in the rule pipeline (wired below). `type` rebuilds so the rule menus re-filter.
    div.querySelectorAll(".ffset").forEach((inp) => inp.addEventListener("change", (e) => {
        const f = model.itemField(winId, itemId, fid);
        const fd = f && (n.win.fields || []).find((x) => x.id === f.field);
        if (!fd) return;
        const k = e.target.dataset.k;
        let rebuild = false;
        if (k === "type") { fd.type = e.target.value; rebuild = true; }       // re-filters the rule menus
        else if (k === "minconf") fd.min_confidence = +e.target.value || 0;
        else if (k === "isolate") fd.isolate = e.target.checked;
        else if (k === "glyph_check") fd.glyph_check = e.target.checked;
        fieldChanged(winId, itemId, fid, { rebuild });
    }));
    if (n.field) wireFieldRules(div, n.field, {
        rebuild: () => fieldChanged(winId, itemId, fid, { rebuild: true }),
        commit: () => fieldChanged(winId, itemId, fid),
        retrace: (el) => refreshRuleTrace(winId, n.field.id, n.id, el),
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
    div.querySelector(".itellalignx")?.addEventListener("change", (e) => {
        model.setItemFieldAlignX(winId, itemId, fid, e.target.value);
        fieldChanged(winId, itemId, fid);   // x-anchor changes where columns land -> re-read
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
    autosave(reread ? winId : null);
}

// Wire one tell node: the per-tell controls that used to live inline in the item node.
function wireItemTell(div, n) {
    const winId = n.win.id, itemId = n.item.id, tid = n.ref.id;
    div.querySelector(".gi-id").addEventListener("change", (e) => {
        renameNode(e.target, tid,
            () => model.renameItemTell(winId, itemId, tid, e.target.value.trim()),
            () => movePos(`tell:${winId}:${itemId}:${tid}`, `tell:${winId}:${itemId}:${n.ref.id}`),
            () => tellChanged(winId, itemId, n.ref.id, { render: true, reread: false }));   // id only — no pixels/boxes
    });
    // the tell's KIND: swaps which kind-specific controls show (rebuild this node) and what the
    // merged table shows (rebuild the item node). A re-read reflects the new check.
    div.querySelector(".tkind")?.addEventListener("change", (e) => {
        model.setItemTellProp(winId, itemId, tid, "kind", e.target.value);
        rebuildNode(`item:${winId}:${itemId}`);   // merged table shows the kind
        tellChanged(winId, itemId, tid, { rebuild: true });
    });
    div.querySelectorAll(".tset").forEach((inp) => inp.addEventListener("change", (e) => {
        const k = e.target.dataset.k;
        let prop = k, v;
        if (k === "threshold") v = +e.target.value || 0;
        else if (k === "width") v = Math.max(0, Math.min(0.5, +e.target.value || 0));
        else if (k === "margin") v = Math.max(0, Math.min(1, +e.target.value || 0));
        else if (k === "minchars") { prop = "min_chars"; v = Math.max(0, Math.trunc(+e.target.value) || 0); }
        else if (k === "case") { prop = "case_sensitive"; v = e.target.checked; }
        else if (k === "field") v = e.target.value || null;   // blank "—" => no field => check ANY column
        else v = e.target.value;
        model.setItemTellProp(winId, itemId, tid, prop, v);
        // margin grows the search crop — redraw this template tell's reference preview to show it
        if (k === "margin" && n.ref.kind === "template") drawTellTemplateRef(div, n);
        // text empty<->set adds/removes the match knobs; mode change shows/hides "read ⊆ text"
        // (ignored by full/exact) -> rebuild this node's body in both cases
        tellChanged(winId, itemId, tid, (k === "text" || k === "match") ? { rebuild: true } : {});
    }));
    // sync hex text <-> color swatch on color/border tells
    const _colorSpan = div.querySelector(".aset-color");
    if (_colorSpan) {
        const _hex = _colorSpan.querySelector("input[type='text']");
        const _picker = _colorSpan.querySelector("input[type='color']");
        if (_hex && _picker) {
            _hex.addEventListener("input", () => { _picker.value = _hex.value || "#000000"; });
            _picker.addEventListener("input", () => { _hex.value = _picker.value; });
        }
    }
    div.querySelector(".tloc")?.addEventListener("change", (e) => {
        // locate is single-choice across the item's tells — clear the others, set this one
        for (const t of n.item.tells || []) model.setItemTellProp(winId, itemId, t.id, "locate", false);
        model.setItemTellProp(winId, itemId, tid, "locate", e.target.checked);
        tellChanged(winId, itemId, tid, { render: true });   // align dropdown + sibling tell nodes
    });
    if (n.ref.kind === "template") drawTellTemplateRef(div, n);
}

// A 'template' tell matches a saved sub-image: the tell box cropped from the item's frozen
// cutout. Draw that exact crop into the tell node so the user sees its reference (mirrors the
// cell-rel→cutout-fraction mapping the reader uses in read_cutout / item_templates).
function drawTellTemplateRef(div, n) {
    const cv = div.querySelector(".tt-ref-canvas");
    const it = n.item, t = n.ref;
    if (!cv || !it.cutout || !it.cutout_box) return;
    const cb = it.cutout_box, ib = it.box;
    if (!(cb.w > 0 && cb.h > 0 && ib.w > 0 && ib.h > 0)) return;
    const iw = ib.w / cb.w, ih = ib.h / cb.h;          // cell size in cutout fractions
    const ox = (ib.x - cb.x) / cb.w, oy = (ib.y - cb.y) / cb.h;
    const fx = ox + t.box.x * iw, fy = oy + t.box.y * ih, fw = t.box.w * iw, fh = t.box.h * ih;
    const m = Math.max(0, t.margin ?? 0.25);           // search margin (per side, fraction of the box)
    const img = new Image();
    img.onload = () => {
        const W = img.naturalWidth, H = img.naturalHeight;
        // the actual tell box, in source pixels — this is what template matching saves/compares
        const bx = fx * W, by = fy * H, bw = Math.max(1, fw * W), bh = Math.max(1, fh * H);
        // the search region the live reader scans = box grown by the margin on every side, clamped
        // to the image. The box is drawn as an outline inside it so the margin band is visible.
        const ex = Math.max(0, bx - bw * m), ey = Math.max(0, by - bh * m);
        const eR = Math.min(W, bx + bw * (1 + m)), eB = Math.min(H, by + bh * (1 + m));
        const sx = Math.round(ex), sy = Math.round(ey);
        const sw = Math.max(1, Math.round(eR) - sx), sh = Math.max(1, Math.round(eB) - sy);
        // supersample the backing to ~>=220px wide at an INTEGER scale, so the pixel-art crop
        // stays crisp AND the dimension label drawn on top is legible (not 30px-tall text)
        const scale = Math.max(1, Math.ceil(220 / sw));
        const BW = sw * scale, BH = sh * scale;
        cv.width = BW; cv.height = BH;
        const ctx = cv.getContext("2d");
        ctx.imageSmoothingEnabled = false;                          // nearest-neighbour: keep the crop pixelated
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, BW, BH);
        // outline the actual box inside the margin-grown crop (skip when margin is 0 — box == crop)
        if (m > 0) {
            ctx.imageSmoothingEnabled = true;
            ctx.strokeStyle = "rgba(120,180,255,0.95)";
            ctx.lineWidth = Math.max(1, scale);
            ctx.strokeRect((bx - sx) * scale + ctx.lineWidth / 2, (by - sy) * scale + ctx.lineWidth / 2,
                bw * scale - ctx.lineWidth, bh * scale - ctx.lineWidth);
        }
        // the crop's NATIVE pixel size (what template matching actually compares), bottom-left
        ctx.imageSmoothingEnabled = true;                           // smooth glyphs
        const txt = `${Math.round(bw)}×${Math.round(bh)}`, fs = Math.max(9, Math.round(BW * 0.05)), pad = fs * 0.3;
        ctx.font = `${fs}px system-ui`;
        const tw = ctx.measureText(txt).width, plateH = fs + pad * 2;
        ctx.fillStyle = "rgba(0,0,0,0.65)";
        ctx.fillRect(0, BH - plateH, tw + pad * 2, plateH);         // readable plate behind the text
        ctx.fillStyle = "#fff";
        ctx.textBaseline = "bottom";
        ctx.fillText(txt, pad, BH - pad);
    };
    img.src = api.cutoutUrl(model.profile.name, it.cutout);
}

// Redraw the live reference crop for every template tell of an item — called when the CELL or a
// tell box resizes/moves (which shifts the crop region), so each tell node's preview tracks its
// box without a full node rebuild. Cheap: only template tells, and the cutout image is cached.
function refreshItemTemplateRefs(winId, itemId) {
    const it = model.item(winId, itemId), w = model.window(winId);
    if (!it || !w) return;
    for (const t of it.tells || []) {
        if (t.kind !== "template") continue;
        const el = nodeEls.get(`tell:${winId}:${itemId}:${t.id}`);
        if (el) drawTellTemplateRef(el, { item: it, ref: t, win: w });
    }
}

// Wire the window node's controls (extracted so rebuildNode can re-bind them
// without recreating the node — which would destroy the embedded image canvas).
function wireWindowControls(div, n) {
    div.querySelector(".gi-id").addEventListener("change", async (e) => {
        const oldId = n.ref.id, newId = e.target.value.trim();
        const oldDs = model.datasetOf(n.ref);   // explicit dataset (if any) is independent of the window id
        if (!model.renameWindow(oldId, newId)) { e.target.value = oldId; return; }
        // The capture binding + open image are keyed by window id — carry them across so the
        // image canvas doesn't blank on rename. Move the binding (server), drop the old-keyed
        // canvas, then re-open under the new id (which loads from the moved binding). winPage rides
        // moveWindowPos below (remapNodeState carries every per-id store, this one included).
        const game = model.profile.name, wasOpen = openImages.has(oldId);
        try {
            const caps = await api.bindingList(game, oldId);   // all image pages move with the window
            if (caps.length) { await api.setBindings(game, newId, caps); await api.setBindings(game, oldId, []); }
        } catch { /* binding move failed -> image just reloads empty, not fatal */ }
        if (imageCanvases.has(oldId)) closeImage(oldId);
        moveWindowPos(oldId, newId);            // win + all child nodes (pos/size/collapse/tab/winPage/…)
        const newDs = model.datasetOf(n.ref);
        if (oldDs && newDs && newDs !== oldDs) movePos(`ds:${oldDs}`, `ds:${newDs}`);
        // a rename changes only the id/wiring — no pixels or boxes change, so DON'T trigger the
        // all-open-windows detect/preview refresh (autosave(null)). The reopened image below
        // re-detects just the renamed window.
        render();
        rebuildNode("game");   // refresh the game node's window-priority list — render() leaves an existing node body put
        autosave(null);
        if (wasOpen) await openImage(newId);    // restore the image against the moved binding
    });
    div.querySelector(".winlive")?.addEventListener("change", (e) => {
        model.setWindowLive(n.ref.id, e.target.checked);
        model._syncWindowPriority();   // add/drop this window from the game node's priority list
        rebuildNode("game");           // reflect the add/drop in the priority list now
        autosave(null);          // a live-view flag changes nothing other nodes re-read
        renderLiveWindow();       // reflect in the live panel's window list
    });
    div.querySelector(".winstatic")?.addEventListener("change", (e) => {
        model.setWindowStaticGrid(n.ref.id, e.target.checked);
        [...imageCanvases.keys()].includes(n.ref.id) && clearGrid(n.ref.id);   // grid<->locator
        // static toggles whether OCR locate applies — re-bind item nodes so their locate
        // radios enable/disable to match (rebuildNode keeps each item's live cutout canvas)
        for (const it of model.window(n.ref.id)?.items || []) rebuildNode(`item:${n.ref.id}:${it.id}`);
        refreshImageBoxes(n.ref.id); autosave(n.ref.id);   // redraw guides; re-detect this window only
    });
    div.querySelectorAll(".winscroll").forEach((inp) => inp.addEventListener("change", (e) => {
        const k = e.target.dataset.k;
        if (k === "autoscroll") {
            model.setScrollAutoscroll(n.ref.id, e.target.checked);
            rebuildNode(`win:${n.ref.id}`);   // show/hide the "auto-scroll clicks" flab
        } else if (k === "clicks") model.setScrollClicks(n.ref.id, Math.max(1, +e.target.value || 1));
        autosave(null);   // precapture-only knobs — the reader/preview never use them, so don't re-OCR
    }));
    // Text appearance (window-level OCR preprocess). Every knob changes what OCR SEES, so
    // autosave(winId) re-reads THIS window (unlike the precapture-only scroll knobs above).
    div.querySelector(".ppmode")?.addEventListener("change", (e) => {
        model.setPreprocessMode(n.ref.id, e.target.value);
        rebuildNode(`win:${n.ref.id}`);   // show/hide the colour controls for `color` mode
        autosave(n.ref.id);
    });
    div.querySelector(".pptol")?.addEventListener("input", (e) => {
        model.setPreprocessTolerance(n.ref.id, +e.target.value); autosave(n.ref.id);
    });
    div.querySelector(".ppscale")?.addEventListener("change", (e) => {
        model.setPreprocessScale(n.ref.id, +e.target.value || 1); autosave(n.ref.id);
    });
    div.querySelector(".pp-pick")?.addEventListener("click", () => armPreprocessPick(n.ref.id));
    div.querySelector(".pp-add")?.addEventListener("click", () => {
        const el = div.querySelector(".pp-hex"); const v = el.value.trim();
        if (/^#?[0-9a-fA-F]{6}$/.test(v)) {
            model.addPreprocessColor(n.ref.id, v.startsWith("#") ? v : `#${v}`);
            rebuildNode(`win:${n.ref.id}`); autosave(n.ref.id);
        }
    });
    div.querySelectorAll(".pp-cx").forEach((b) => b.addEventListener("click", () => {
        model.removePreprocessColor(n.ref.id, +b.dataset.i);
        rebuildNode(`win:${n.ref.id}`); autosave(n.ref.id);
    }));
    // reorder the item-template priority list: ▲/▼ swap a template up/down, re-numbering
    // priorities to match the new order (top = highest, bottom = 0 base). Base may change -> reread.
    div.querySelectorAll(".wimv").forEach((b) => b.addEventListener("click", () => {
        model.moveItemPriority(n.ref.id, b.dataset.id, +b.dataset.d);
        windowItemsReordered(n.ref.id);
    }));
    // click a template name -> jump to its item node (don't swallow the ▲/▼ button clicks)
    div.querySelectorAll(".wi-row .wi-name").forEach((el) => el.addEventListener("click", (e) => {
        panZoomTo(`item:${n.ref.id}:${el.closest(".wi-row").dataset.id}`);
    }));
    wireDetectsSection(div, n.ref.id);   // combine mode + per-detector polarity + name jumps
}

// The game node's window-priority list: ▲/▼ reorder (highest-priority on top) + click a name to
// jump to that window's node. Reorder persists window_priority and refreshes the list's disabled
// states. Bound on the initial build and re-bound by the _LIVE_SECTIONS rebuild (div = node el).
function wireGamePriority(div) {
    div.querySelectorAll(".wpmv").forEach((b) => b.addEventListener("click", () => {
        if (model.moveWindowPriority(b.dataset.id, +b.dataset.d)) {
            rebuildNode("game");   // refresh order + ▲/▼ disabled ends
            autosave(null);        // priority only steers the live classifier — no node re-OCR
        }
    }));
    div.querySelectorAll(".wp-row .wp-name").forEach((el) => el.addEventListener("click", () => {
        panZoomTo(`win:${el.closest(".wp-row").dataset.id}`);
    }));
    syncWpDots();   // paint the freshly-built dots to current live recognition (no wait for the next tick)
}

// The detectors section (mode select + polarity selects + name jumps) on a window node. A
// change re-runs detect for that window (autosave re-OCRs it) so .wd-status/.wd-verdict refresh.
function wireDetectsSection(div, ownerId) {
    const saveDet = () => autosave(ownerId);
    div.querySelector(".wd-mode")?.addEventListener("change", (e) => {
        model.setDetectMode(ownerId, e.target.value); saveDet();
    });
    div.querySelectorAll(".wd-neg").forEach((sel) => sel.addEventListener("change", (e) => {
        model.setDetectNegate(ownerId, e.target.dataset.id, e.target.value === "absent"); saveDet();
    }));
    div.querySelectorAll(".wd-row .wd-name").forEach((el) => el.addEventListener("click", () => {
        panZoomTo(`det:${ownerId}:${el.closest(".wd-row").dataset.id}`);
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
    autosave(winId);
}


// the aggregate <select> itself lives in node_parts.js — ONE primitive shared with the dataset
// node's own "many → one" policy (rule 7). Here it's rendered with "" = inherit that policy.


// ---- subset node: join one or more datasets, then filter/derive/sort ----------

const SUB_OPS = ["contains", "icontains", "eq", "ne", "nonempty", "empty", "gt", "lt", "gte", "lte", "regex"];

// how a source combines beyond a plain key-matched join (matches JoinSource.mode in models.py)
const SOURCE_MODES = ["join", "exclude", "mark", "broadcast"];
const SOURCE_MODE_LABEL = {
    join: "join (key-match)", exclude: "exclude (anti-join)",
    mark: "mark (semi-join, annotate)", broadcast: "broadcast (merge onto every row)",
};



// Last live column set a subset's join actually returned (set by refreshSubsetNode). The static
// schema (model.subsetColumns) only knows columns declared on windows — orders/enrich columns
// and other dataset-fed fields aren't in it, so the config must also offer what the join shows.
const subsetLiveCols = new Map();

// Every column a subset's config should list: static schema ∪ live result columns ∪ hidden
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

function hideToggleNodes(s) {
    const hidden = new Set(s.hidden_columns || []);
    const cols = viewDisplayColumns(s);
    if (!cols.length) return h("span", { class: "muted sub-empty" }, "no columns yet");
    return cols.map((c) => h("button", {
        class: `sv-hide${hidden.has(c) ? " off" : ""}`, dataset: { col: c },
        title: `${hidden.has(c) ? "show" : "hide"} column`,
    }, c));
}

// Repaint + re-wire a subset's visible/hide toggle row in place (no node rebuild).
function renderHideToggles(el, s) {
    const hides = el && el.querySelector(".sv-hides");
    if (hides) { hides.replaceChildren(...[hideToggleNodes(s)].flat()); wireHideToggles(el, s); }
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
        autosave(null);   // hiding a view column changes nothing any window OCRs
        refreshSubsetNode(s.id);
    }));
}

// Client mirror of oc.store.textnorm.norm_text — same step order (lower -> strip punct -> drop
// whole words -> collapse whitespace), so the join-settings preview matches what the backend keys on.
function normPreview(jn, value) {
    let s = String(value || "");
    if (jn.case_insensitive) s = s.toLowerCase();
    if (jn.strip_punct) s = s.replace(/[^\w\s]+/g, " ");
    const words = jn.strip_words || [];
    if (words.length) {
        const drop = new Set(words.map((w) => (jn.case_insensitive ? w.toLowerCase() : w)));
        s = s.split(/\s+/).filter(Boolean).filter((t) => !drop.has(jn.case_insensitive ? t.toLowerCase() : t)).join(" ");
    }
    if (jn.collapse_ws) s = s.replace(/\s+/g, " ").trim();
    return s;
}

// One source's per-source join config (a block within the subset's "sources" grid). Each input
// carries its OWN join field / match-norm / many->one aggregate / required flag. Returns null when
// the source has nothing to configure (a single non-dedup dataset source) so no empty block shows.
//   • `joined` (2+ sources) -> show join-on column, required, and match knobs (once a field is set);
//   • a dataset source that dedups -> show its "many →" collapse;
//   • a subset source / no-dedup dataset -> no aggregate row (it already serves one row per key).
function sourceCfgNode(s, ds, joined) {
    const isView = !!model.subsetDef(ds);
    const src = model.subsetSource(s.id, ds) || {};
    const jf = src.join_field || "";
    const showAgg = !isView && model.datasetDedup(ds);
    if (!joined && !showAgg) return null;   // single non-dedup source: nothing to configure
    const cols = model.inputColumns(ds);
    // source header spans BOTH grid columns (gspan) — a shared node subheading above its settings
    const rows = [h("span", { class: "gspan sv-src-h", title: "this source's settings" }, ds)];
    // "many ->" is the read/collapse policy, NOT a join input — render it FIRST, above the join config,
    // so it doesn't read as a join knob.
    if (showAgg) {
        rows.push(labCell("many →", "how this source's many observations collapse to one value; inherit = the dataset's own policy"),
            aggregateSelect(model.sourceAggregate(s.id, ds), {
                cls: "sv-sagg", ds, all: true,
                inherit: model.sourceAggregateEffective(s.id, ds),   // names what "" resolves to
                title: "how THIS source's many observations collapse when the view reads them" }));
    }
    if (joined) {
        const mode = src.mode || "join";
        const modeOpts = SOURCE_MODES.map((m) => h("option", { value: m, selected: m === mode },
            m === mode ? `<${SOURCE_MODE_LABEL[m]}>` : SOURCE_MODE_LABEL[m]));
        rows.push(labCell("mode", "how this source combines into the join — see the option list"),
            h("select", { class: "sv-smode", dataset: { ds } }, modeOpts));
        // broadcast merges onto every row unkeyed -- no join key to configure at all.
        if (mode !== "broadcast") {
            const joinOpts = [h("option", { value: "", selected: !jf }, "(no join)"),
                ...[...new Set([jf, ...cols])].filter(Boolean).map((c) => h("option", { value: c, selected: c === jf }, c === jf ? `<${c}>` : c))];
            rows.push(labCell("join on", "this source's column used as the join key; (no join) stacks its rows"),
                h("select", { class: "sv-sjoin", dataset: { ds } }, joinOpts));
            if (jf) {
                // required only gates a plain join's output presence -- meaningless for exclude/mark,
                // which never affect whether a key survives on their own.
                if (mode === "join") {
                    rows.push(labCell("required", "key must exist in this source (inner-style); off = optional outer fill"),
                        h("input", { type: "checkbox", class: "sv-sreq", dataset: { ds }, checked: !!src.required }));
                }
                const jn = model.sourceJoinNorm(s.id, ds);
                const ckRow = (lbl, title, cls, on) => frag(labCell(lbl, title),
                    h("input", { type: "checkbox", class: cls, dataset: { ds }, checked: !!on }));
                rows.push(
                    ckRow("ignore case", "fold case before matching", "sn-ci", jn.case_insensitive),
                    ckRow("strip punc", "strip punctuation (collapse to spaces)", "sn-punct", jn.strip_punct),
                    ckRow("collapse ws", "runs of whitespace -> one space, trimmed", "sn-ws", jn.collapse_ws),
                    labCell("drop words", "whole words removed from this side; space- or comma-separated"),
                    h("input", { type: "text", class: "sn-words", dataset: { ds }, value: (jn.strip_words || []).join(" "), placeholder: "(none)" }));
                // live worked example: a REAL sample join value from this source, transformed by the knobs
                // above. Filled async (fillNormSamples) since the sample is fetched; updates in place as the
                // knobs change. Shows a "no data" note when the source has no value to preview.
                rows.push(labCell("example", "how these settings canonicalise a real join value from this source", false, "eg-lab"),
                    h("span", { class: "sv-norm-eg", dataset: { ds, jf } }, h("span", { class: "muted" }, "loading…")));
            }
        }
    }
    return frag(...rows);
}

// Repaint ONE source's worked example in place from the current knobs + the cached sample
// (`el._sample`, set by fillNormSamples). `_sample === undefined` -> still loading; `null` -> the
// source had no value to preview; a string -> show `"raw" → normalised`. Event-driven (knob/keystroke),
// never a steady-state poll, so replaceChildren here is fine.
function renderNormEg(el, sid) {
    const ds = el.dataset.ds;
    const jn = model.sourceJoinNorm(sid, ds);
    const many = (el._samples?.length || 0) > 1;   // clickable only when there's another to show
    el.classList.toggle("clickable", many);
    el.title = many ? "click for another example" : "";
    if (el._sample === undefined) { el.replaceChildren(h("span", { class: "muted" }, "loading example…")); return; }
    if (el._sample === null) { el.replaceChildren(h("span", { class: "muted" }, `no ${el.dataset.jf} data to preview`)); return; }
    el.replaceChildren(el._sample, h("span", { class: "eg-arrow" }, " → "), normPreview(jn, el._sample) || "∅");
}

// Fetch real sample join values for every source's worked example, then render each. Collects every
// DISTINCT non-empty value in the source's join column (its own rows for a dataset, computed rows for
// a subset) into `el._samples` so clicking the example cycles through them (cycleNormEg); the first is
// shown. Failures / empty sources resolve to the "no data" state, never an error.
async function fillNormSamples(div, s) {
    const game = encodeURIComponent(model.profile.name);
    await Promise.all([...div.querySelectorAll(".sv-norm-eg")].map(async (el) => {
        const ds = el.dataset.ds, jf = el.dataset.jf;
        const seen = new Set(), list = [];
        try {
            const isView = !!model.subsetDef(ds);
            // boot batch already carries every source's rows — sample from it (no extra fetch); the
            // live path (post-boot edits) has no prefetch and fetches the one source it needs.
            const cached = isView ? _bootDetails?.subsets?.[ds] : _bootDetails?.datasets?.[ds];
            const data = cached || await (await fetch(`/api/flow/${game}/${isView ? "subset" : "dataset"}/${encodeURIComponent(ds)}`)).json();
            const recs = isView ? (data.rows || []) : (data.records || []);
            for (const r of recs) { const v = r[jf]; if (v != null && String(v).trim() !== "" && !seen.has(String(v))) { seen.add(String(v)); list.push(String(v)); } }
        } catch { /* leave empty -> "no data" */ }
        el._samples = list;
        el._sampleIdx = 0;
        el._sample = list.length ? list[0] : null;
        renderNormEg(el, s.id);
    }));
}

// Advance a worked example to its NEXT distinct sample (wraps). No-op with <2 samples.
function cycleNormEg(el, sid) {
    const list = el._samples || [];
    if (list.length < 2) return;
    el._sampleIdx = ((el._sampleIdx | 0) + 1) % list.length;
    el._sample = list[el._sampleIdx];
    renderNormEg(el, sid);
}

// Reshape flat name/value rows (e.g. a register's readout mirror) into wide rows by shared
// id-prefix, applied right after the join, before filter/derive/sort (PivotSpec in models.py).
// The suffix VOCABULARY (`attributes`) is authored here as a free-typed box, never hardcoded —
// mirrors the existing "drop words" convention (setSourceStripWords) for the same reason.
function pivotCfgNode(s) {
    const on = model.pivotEnabled(s.id);
    const rows = [
        labCell("pivot", "reshape flat name/value rows into wide rows by shared id-prefix (e.g. a register's readout mirror)"),
        h("input", { type: "checkbox", class: "sv-pivot-on", checked: on }),
    ];
    if (on) {
        const p = model.subsetPivot(s.id);
        rows.push(
            h("span", { class: "gspan sv-src-h", title: "pivot settings" }, "pivot"),
            labCell("name field", "column holding each flat row's id (e.g. \"slot_1_school\")"),
            h("input", { type: "text", class: "sv-pivot-namefield", value: p.name_field || "name", placeholder: "name" }),
            labCell("value field", "column holding each flat row's value"),
            h("input", { type: "text", class: "sv-pivot-valuefield", value: p.value_field || "value", placeholder: "value" }),
            labCell("key column", "output column name for the shared prefix"),
            h("input", { type: "text", class: "sv-pivot-keycol", value: p.key_column || "slot", placeholder: "slot" }),
            labCell("attributes", "taught id SUFFIXES, longest match wins; space- or comma-separated (e.g. _name _drain _school); a row matching none is dropped"),
            h("input", { type: "text", class: "sv-pivot-attrs", value: (p.attributes || []).join(" "), placeholder: "_name _drain _school" }));
    }
    return frag(...rows);
}

function subConfigNode(s) {
    const cols = viewColumns(s);
    const inputs = model.subsetInputs(s);
    const free = model.joinableInputs(s);   // datasets + other subsets (cycle-free)
    // sources are removable pills + a "+ join source" select — the SHARED sources-input widget
    // (rule 7 — same as producer sources / dict feeds).
    // join is PER-SOURCE now: each input carries its own join column, match-norm, many->one
    // collapse, and required flag (see model JoinSource). One config block per source.
    const joined = inputs.length > 1;
    const srcCfgs = inputs.map((ds) => sourceCfgNode(s, ds, joined)).filter(Boolean);
    // filters / derived / sort are three add-delete lists — all on the shared listBlock primitive
    // (rule 7); each supplies only its per-row cells + wiring classes, so main.js handlers still key
    // off .sf-*/.sd-*/.ss-* + data-i as before.
    const filters = listBlock({ items: s.filters, rowClass: "sub-row", del: { cls: "sf-del", title: "remove filter" },
        render: (f, i) => [
            h("select", { class: "sf-field", dataset: { i } }, _colOpts(cols, f.field)),
            h("select", { class: "sf-op", dataset: { i } }, SUB_OPS.map((o) => h("option", { selected: o === f.op }, o === f.op ? `<${o}>` : o))),
            h("input", { class: "sf-val", dataset: { i }, value: f.value || "", placeholder: "value" })] });
    const derived = listBlock({ items: s.derived, rowClass: "sub-row", del: { cls: "sd-del", title: "remove column" },
        render: (d, i) => [
            h("input", { class: "sd-name", dataset: { i }, value: d.name || "", placeholder: "new column" }),
            h("span", { class: "muted" }, "="),
            h("input", { class: "sd-tpl", dataset: { i }, value: d.template || "", placeholder: "{=count*price_median|round:0} plat" })] });
    // multi-column sort: primary row first, each a column + direction; applied before limit
    const sortRows = listBlock({ items: s.sort, rowClass: "sub-row", del: { cls: "ss-del", title: "remove sort" },
        render: (so, i) => [
            h("select", { class: "ss-field", dataset: { i } }, _colOpts(cols, so.field)),
            h("select", { class: "ss-dir", dataset: { i } },
                h("option", { value: "asc", selected: !so.desc }, !so.desc ? "<asc>" : "asc"),
                h("option", { value: "desc", selected: !!so.desc }, !!so.desc ? "<desc>" : "desc"))] });
    // label + its inline "+" add button — a col-1 cell for the ONE node grid (matches labCell),
    // so filters/columns/sort/visible line up in the same label column as sources/limit/latest.
    const addLbl = (text, title, addCls, addTitle) =>
        h("span", { class: "lab sub-lbl", title }, text, h("button", { class: addCls, title: addTitle }, "+"));
    // ONE grid for the whole config: sources, per-source join, limit/latest, then filters/columns/
    // sort/visible — every label in col 1, its control(s) in col 2.
    return h("div", { class: "lab-grid" },
        srcRow("sources", "datasets or subsets; each joins on its own field",
            sourcesInput({ chips: inputs.map((ds) => ({ value: ds, node: model.refNode(ds) })), free,
                addLabel: "+ join source", rmTitle: "remove input" })),
        ...srcCfgs,
        // close the per-source section so the view-level rows below (limit, latest batch) don't
        // read as part of the last source's block
        ...(srcCfgs.length ? [h("div", { class: "gspan sv-sec-end" })] : []),
        labCell("limit", "cap the number of result rows (0 = no limit)"),
        h("input", { type: "number", class: "sv-limit", min: "0", step: "1", value: s.limit || 0, placeholder: "0" }),
        labCell("latest batch", "only pull rows from each source's most recent collection batch (applied before everything else)"),
        h("input", { type: "checkbox", class: "sv-latest", checked: !!s.latest_batch }),
        pivotCfgNode(s),
        addLbl("filters", "all must pass", "sub-addf", "add filter"),
        h("div", { class: "sub-rows" }, filters),
        addLbl("columns", "{col} text · {=expr} math · |round:N decimals · mix freely", "sub-addd", "add column"),
        h("div", { class: "sub-rows" }, derived),
        addLbl("sort", "primary first; applied before limit", "sub-adds", "add sort"),
        h("div", { class: "sub-rows" }, sortRows),
        labCell("visible", "click to hide/show", false, "vis-lab"),
        h("div", { class: "sv-hides" }, hideToggleNodes(s)));
}

function subsetParts(s) {
    // config is always visible now (no fold toggle); the head button toggles the records-grid
    // satellite (vt:sub:<id>), the same opt-in follower datasets get.
    return {
        title: h("input", { class: "gi gi-id subrename", value: s.id, title: "subset name" }),
        head: satToggleBtn(`vt:sub:${s.id}`, "vttable"),
        body: subConfigNode(s),
        ports: h("span", { class: "port out", title: "drag to another subset to feed it this subset's rows" }),
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
    for (const sel of el.querySelectorAll(".ss-field, .sf-field")) {
        const v = sel.value;
        sel.replaceChildren(..._colOpts(cols, v));
        sel.value = v;
    }
}

// Its compute can be slow — never run two at once for one subset, but a request that arrives
// mid-compute must re-run once after (never dropped), so a view tracking a live sweep lands on
// the FINAL data instead of stalling on a stale mid-sweep snapshot.
// `pre` (an already-computed view, e.g. from the one-shot boot batch) renders without a network
// round-trip; omit it for the live path and it fetches its own.
function refreshSubsetNode(id, pre = null) { singleFlight(`sub:${id}`, (ctx) => _refreshSubsetNode(id, pre, ctx)); }
async function _refreshSubsetNode(id, pre, { superseded } = {}) {
    const el = nodeEls.get(`sub:${id}`);                              // config node (hide toggles live here)
    const vtId = `vt:sub:${id}`;
    const host = nodeEls.get(vtId)?.querySelector(".sub-host");       // records grid — opt-in satellite
    if (!el && !host) return;
    // spin the records-grid satellite while its rows are being recomputed (only when it's shown)
    const vtShown = !!host;
    if (vtShown) setNodeBusy(vtId, true);
    try {
        const r = pre || await api.getSubset(model.profile.name, id);
        // a newer request is already queued behind us — its result supersedes ours; skip the
        // paint and let the trailing rerun (singleflight.js) write the fresh one instead.
        if (superseded?.()) return;
        const s = model.subsetDef(id);
        if (host) {
            const vt = vtableFor(`view:${id}`, host);
            // dragging a column in the table re-orders the visible/hide buttons to match, live
            vt.onReorder = () => renderHideToggles(nodeEls.get(`sub:${id}`), s);
            // click a row to drill into the source rows that joined to produce it (one per input)
            vt.setData(r.columns || [], r.rows || [], { expander: (row) => expandSubsetRow(id, row) });
        }
        // the live join may expose columns the static schema can't know (orders/enrich fields) —
        // cache them and re-render the visible/hide toggles so every actual column is listed.
        subsetLiveCols.set(id, r.columns || []);
        if (s && el) { renderHideToggles(el, s); repaintSubsetCols(el, s); }
    } catch (e) {
        if (superseded?.()) return;
        // a just-added subset isn't on the backend until the profile saves (debounced) —
        // that's a transient 404, not an error; the post-save refresh fills it in.
        const msg = /\b404\b/.test(String(e.message || e)) ? "no data yet" : String(e.message || e);
        vtables.delete(`view:${id}`);
        if (host) host.replaceChildren(h("p", { class: "muted", style: "padding:8px" }, msg));
    } finally {
        if (vtShown) setNodeBusy(vtId, false);
    }
}

// ---- coalesced live refresh (storm control) -------------------------------
// Each open dataset/subset node refetching itself on every live change is N concurrent slow
// /dataset + /subset requests — a "storm" on a rename or a sweep, since singleFlight keys are
// per-node and so DON'T coalesce across nodes. Instead COLLECT the changed ids, debounce briefly,
// and pull them all in ONE POST /flow/details — the same batched, memo-shared endpoint the boot
// prefetch uses (a dataset feeding many views opens/parses once, not once per consumer). The
// per-node refresh still runs, but fed a prefetched `pre` so it does no network of its own; a
// dataset/subset missing from the batch (or a failed batch) falls back to its own fetch.
const _refDs = new Set(), _refSub = new Set();
let _refTimer = null;
function queueNodeRefresh({ datasets = [], subsets = [] } = {}) {
    // spin the CONFIG node's header the moment it's queued, not only once the batch fetch below
    // actually starts — a node "about to refresh" should already show it's about to refresh.
    // Guarded by `!has` so a burst of pushes for the same id before the debounce fires doesn't
    // inflate the busy refcount (flushNodeRefresh clears it exactly once per queued id).
    for (const d of datasets) if (d) {
        if (!_refDs.has(d) && nodeEls.has(`ds:${d}`)) setNodeBusy(`ds:${d}`, true);
        _refDs.add(d);
    }
    for (const s of subsets) if (s) {
        if (!_refSub.has(s) && nodeEls.has(`sub:${s}`)) setNodeBusy(`sub:${s}`, true);
        _refSub.add(s);
    }
    if (_refTimer === null) _refTimer = setTimeout(flushNodeRefresh, 120);   // coalesce a burst into one batch
}
async function flushNodeRefresh() {
    _refTimer = null;
    const queuedDs = [..._refDs], queuedSub = [..._refSub];   // snapshot before clearing — clears the queue-time busy set above, whatever the outcome
    const dss = queuedDs.filter((d) => nodeEls.has(`vt:ds:${d}`) || nodeEls.has(`ds:${d}`));
    const subs = queuedSub.filter((s) => nodeEls.has(`vt:sub:${s}`) || nodeEls.has(`sub:${s}`));
    _refDs.clear(); _refSub.clear();
    try {
        if (!dss.length && !subs.length) return;
        let details = null;
        try { details = await api.flowDetails(model.profile.name, dss, subs); } catch { /* batch failed -> per-node fetch */ }
        for (const d of dss) { const pre = details?.datasets?.[d] || null; refreshDataNode(d, pre); loadBatchesNode(d, pre); }
        for (const s of subs) refreshSubsetNode(s, details?.subsets?.[s] || null);
    } finally {
        // drop the queue-time header spinner now the batch fetch settled and the per-node
        // refreshes above have been kicked off — each carries its own satellite spinner
        // (setNodeBusy on vt:ds:/vt:sub:) for the rest of its own repaint work.
        for (const d of queuedDs) if (nodeEls.has(`ds:${d}`)) setNodeBusy(`ds:${d}`, false);
        for (const s of queuedSub) if (nodeEls.has(`sub:${s}`)) setNodeBusy(`sub:${s}`, false);
    }
}

function refreshAllSubsetNodes() {
    queueNodeRefresh({ subsets: (model.profile.subsets || []).map((s) => s.id) });
}

// Snapshot of each subset's serialized definition at the last load/save. The post-save refresh
// must recompute ONLY subsets whose definition actually changed — otherwise EVERY content save
// (a toast nudge, a window box, any unrelated edit) recomputed every open subset: each is a
// server view-join + a full satellite-table DOM rebuild, and doing all of them (~140ms server +
// hundreds of rows of layout thrash) on every keystroke was pinning the CPU. Seeded at load so an
// unrelated save refreshes nothing; a genuinely new/edited subset differs from the snapshot and is
// the only one filled (its whole purpose — a just-added subset 404s until the profile saves).
let _subsetSig = new Map();
function _subsetSigs() {
    const m = new Map();
    for (const s of model.profile.subsets || []) m.set(s.id, JSON.stringify(s));
    return m;
}
function seedSubsetSig() { _subsetSig = _subsetSigs(); }
function refreshChangedSubsetNodes() {
    const cur = _subsetSigs();
    const changed = [];
    for (const [id, sig] of cur) if (_subsetSig.get(id) !== sig) changed.push(id);
    _subsetSig = cur;
    if (changed.length) queueNodeRefresh({ subsets: changed });
}

// Refresh every subset that READS from `ds` (directly or through an upstream subset). Batch edits
// (revert / remove) change a dataset's contents WITHOUT appending a history event, so its ledger
// last_ts is unchanged and refreshLive's last_ts gate misses them — callers fixing a dataset's
// data must refresh its consumers explicitly.
function refreshDatasetConsumers(ds) {
    for (const s of model.profile.subsets || [])
        if (nodeEls.has(`sub:${s.id}`) && model.subsetReaches(s.id, ds)) refreshSubsetNode(s.id);
}

// Two-stage armed removal for a sources-input chip's trash (CLAUDE.md rule 2 — no confirm()).
// ONE helper every wired-source list's remove wiring calls (rule 7) — the pill turns `.armed`
// (yellow) on the first click within `container`, and `onFire(value)` (the actual model mutation
// + rebuild/edges/autosave the caller needs) runs only on a second click within the arm window.
// `selector` scopes to one chip list (default the generic "sv-rmin" trash class; a node with more
// than one sources-input list — e.g. a trigger's targets/watch/readout-watch — gives each its own
// class so their removals don't cross-fire).
function wireArmedRemove(container, selector, onFire) {
    container.querySelectorAll(selector).forEach((b) => {
        const pill = b.closest(".sv-input");
        const armed = makeArmed({
            onArm: () => pill.classList.add("armed"),
            onTimeout: () => pill.classList.remove("armed"),
            onFire: () => onFire(b.dataset.val),
        });
        b.addEventListener("click", (e) => { e.stopPropagation(); armed.trigger(); });
    });
}

function wireSubset(div, s) {
    // subset edits are subset-only — they never change any window's image/regions/detect, so
    // autosave(null): persist + refresh THIS view, never re-OCR the open windows.
    const recompute = () => { autosave(null); refreshSubsetNode(s.id); };
    const restructure = () => { autosave(null); rebuildNode(`sub:${s.id}`); };   // rebuild this node's config
    div.querySelector(".subrename")?.addEventListener("change", (e) => {
        const oldId = s.id;
        renameNode(e.target, oldId,
            () => model.renameSubset(oldId, e.target.value),
            () => movePos(`sub:${oldId}`, `sub:${s.id}`),
            async () => {
                render(); autosave(null);
                // render()'s queued fetch for vt:sub:<newId> races the DEBOUNCED autosave: the backend
                // still serves the old (or no) def -> 404 "no data yet" and the grid never refills.
                // Flush the renamed def, then refetch this subset's records under the new id.
                await persist.flush();
                refreshSubsetNode(s.id);
            });
    });
    div.querySelector(".sub-addf")?.addEventListener("click", () => { model.addFilter(s.id); restructure(); });
    div.querySelector(".sub-addd")?.addEventListener("click", () => { model.addDerived(s.id); restructure(); });
    div.querySelector(".sub-adds")?.addEventListener("click", () => { model.addSort(s.id); restructure(); });

    // join inputs — adding/removing/swapping a source changes the wiring AND this config's own
    // source rows + join-on column list, so render() (edges) THEN restructure() (rebuild node)
    div.querySelector(".sv-addin")?.addEventListener("change", (e) => {
        if (model.addSubsetInput(s.id, e.target.value)) { render(); restructure(); }
    });
    wireArmedRemove(div, ".sv-rmin", (val) => {
        model.removeSubsetInput(s.id, val); render(); restructure();
    });
    // PER-SOURCE join config — each control carries its source id in dataset.ds. Setting/clearing a
    // source's join field toggles its required + match rows, so rebuild the node (restructure);
    // the other knobs just re-canonicalise/recompute the view.
    div.querySelectorAll(".sv-sjoin").forEach((el) => el.addEventListener("change", (e) => { model.setSourceJoinField(s.id, el.dataset.ds, e.target.value.trim()); restructure(); }));
    div.querySelectorAll(".sv-sreq").forEach((el) => el.addEventListener("change", (e) => { model.setSourceRequired(s.id, el.dataset.ds, e.target.checked); recompute(); }));
    // switching mode toggles which rows show (required/join-on/norm), so rebuild the node
    div.querySelectorAll(".sv-smode").forEach((el) => el.addEventListener("change", (e) => { model.setSourceMode(s.id, el.dataset.ds, e.target.value); restructure(); }));
    div.querySelectorAll(".sv-sagg").forEach((el) => el.addEventListener("change", (e) => { model.setSourceAggregate(s.id, el.dataset.ds, e.target.value); recompute(); }));
    // norm knobs re-render the worked example IN PLACE (realtime) — no node rebuild, no refetch (the
    // sample is cached on the eg element) — then recompute() refreshes the actual joined view.
    const egFor = (ds) => div.querySelector(`.sv-norm-eg[data-ds="${CSS.escape(ds)}"]`);
    const previewNorm = (ds) => { const eg = egFor(ds); if (eg) renderNormEg(eg, s.id); };
    div.querySelectorAll(".sn-ci").forEach((el) => el.addEventListener("change", (e) => { model.setSourceJoinNorm(s.id, el.dataset.ds, { case_insensitive: e.target.checked }); previewNorm(el.dataset.ds); recompute(); }));
    div.querySelectorAll(".sn-punct").forEach((el) => el.addEventListener("change", (e) => { model.setSourceJoinNorm(s.id, el.dataset.ds, { strip_punct: e.target.checked }); previewNorm(el.dataset.ds); recompute(); }));
    div.querySelectorAll(".sn-ws").forEach((el) => el.addEventListener("change", (e) => { model.setSourceJoinNorm(s.id, el.dataset.ds, { collapse_ws: e.target.checked }); previewNorm(el.dataset.ds); recompute(); }));
    // drop-words: preview live on every keystroke (input); commit the view recompute on blur (change)
    div.querySelectorAll(".sn-words").forEach((el) => {
        el.addEventListener("input", () => { model.setSourceStripWords(s.id, el.dataset.ds, el.value); previewNorm(el.dataset.ds); });
        el.addEventListener("change", () => { model.setSourceStripWords(s.id, el.dataset.ds, el.value); recompute(); });
    });
    fillNormSamples(div, s);   // sample each source's real join value, then render its example
    div.querySelectorAll(".sv-norm-eg").forEach((el) => el.addEventListener("click", () => cycleNormEg(el, s.id)));
    div.querySelector(".sv-latest")?.addEventListener("change", (e) => { model.setSubsetLatestBatch(s.id, e.target.checked); recompute(); });
    div.querySelector(".sv-limit")?.addEventListener("change", (e) => { model.setSubsetLimit(s.id, e.target.value); e.target.value = s.limit || 0; recompute(); });

    // pivot: toggling it changes which rows show (the name/value/key/attributes inputs), so
    // rebuild the node; editing its fields just recomputes the view.
    div.querySelector(".sv-pivot-on")?.addEventListener("change", (e) => { model.setSubsetPivotEnabled(s.id, e.target.checked); restructure(); });
    div.querySelector(".sv-pivot-namefield")?.addEventListener("change", (e) => { model.setSubsetPivotField(s.id, "name_field", e.target.value.trim()); recompute(); });
    div.querySelector(".sv-pivot-valuefield")?.addEventListener("change", (e) => { model.setSubsetPivotField(s.id, "value_field", e.target.value.trim()); recompute(); });
    div.querySelector(".sv-pivot-keycol")?.addEventListener("change", (e) => { model.setSubsetPivotField(s.id, "key_column", e.target.value.trim()); recompute(); });
    div.querySelector(".sv-pivot-attrs")?.addEventListener("change", (e) => { model.setSubsetPivotAttributes(s.id, e.target.value); recompute(); });

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

    queueMicrotask(() => refreshSubsetNode(s.id, _bootDetails?.subsets?.[s.id] || null));
}

// ---- producer node: fetches external data into its output dataset -----------

function wireProducer(div, n) {
    const id = n.ref.id;
    const save = () => autosave(null);                       // value-only edit
    const rebuild = () => { rebuildNode(n.id); drawEdges(); autosave(null); };   // body/edges change
    const structural = () => { rebuildNode(n.id); render(); autosave(null); };  // output columns change -> rebuild THIS body (removed row) + refresh downstream
    const fieldI = (el) => +el.closest(".pr-field").dataset.i;
    const collectMap = (kind) => {
        const obj = {};
        div.querySelectorAll(`.pr-map-row[data-kind="${kind}"]`).forEach((r) => {
            const k = r.querySelector(".pr-map-k").value.trim();
            if (k) obj[k] = r.querySelector(".pr-map-v").value;
        });
        return obj;
    };

    // the producer panel (config + controls). The out-port (drag to a dataset) is wired by wireOutPort.
    // when a refresh ends (or is cancelled), refresh the dataset it feeds so its new batch shows.
    wireProducerNode(div, model.profile.name, n.ref.dataset, n.ref.mode || "",
        n.ref.type || "http", () => {
            refreshLive(); refreshDataNode(n.ref.dataset); loadBatchesNode(n.ref.dataset);
        }, hub.kick);   // refresh start/cancel -> beat the hub so the tasks panel refreshes now

    // backend picker (http). Switching swaps the body AND the output columns.
    div.querySelector(".prtype")?.addEventListener("change", (e) => { model.setProducerType(id, e.target.value); structural(); });
    // rename the producer node (its id) — carry its saved layout slot to the new id, then re-render
    div.querySelector(".prrename")?.addEventListener("change", (e) => {
        const oldId = id;
        renameNode(e.target, oldId,
            () => model.renameProducer(oldId, (e.target.value || "").trim()),
            () => movePos(`producer:${oldId}`, `producer:${n.ref.id}`),
            () => { render(); autosave(null); });
    });
    // producer-level knobs
    div.querySelector(".pr-throttle")?.addEventListener("change", (e) => { model.setProducerThrottle(id, e.target.value); save(); });
    div.querySelector(".pr-mode")?.addEventListener("change", (e) => { model.setProducerMode(id, e.target.value); save(); });
    div.querySelector(".pr-enabled")?.addEventListener("change", (e) => { model.setProducerEnabled(id, e.target.checked); save(); });

    // request
    div.querySelector(".pr-method")?.addEventListener("change", (e) => { model.setHttpMethod(id, e.target.value); save(); });
    div.querySelector(".pr-url")?.addEventListener("change", (e) => { model.setHttpUrl(id, e.target.value); save(); });
    div.querySelector(".pr-timeout")?.addEventListener("change", (e) => { model.setHttpTimeout(id, e.target.value); save(); });
    // headers/query maps: recompute the whole {k:v} from the rows, then rebuild so a fresh add-row appears
    div.querySelectorAll(".pr-map-k, .pr-map-v").forEach((el) => el.addEventListener("change", () => {
        const kind = el.closest(".pr-map-row").dataset.kind;
        model.setProducerMap(id, kind, collectMap(kind)); rebuild();
    }));
    div.querySelectorAll(".pr-map-del").forEach((b) => b.addEventListener("click", () => {
        const kind = b.dataset.kind; b.closest(".pr-map-row").remove();
        model.setProducerMap(id, kind, collectMap(kind)); rebuild();
    }));

    // key transform (+ catalogue sub-panel appears/vanishes -> rebuild)
    div.querySelector(".pr-keytransform")?.addEventListener("change", (e) => { model.setHttpKeyTransform(id, e.target.value); rebuild(); });
    div.querySelector(".pr-keyencode")?.addEventListener("change", (e) => { model.setHttpKeyEncode(id, e.target.checked); save(); });
    const catMap = { "pr-cat-url": "url", "pr-cat-items": "items_path", "pr-cat-name": "name_path",
                     "pr-cat-key": "key_path", "pr-cat-fuzzy": "fuzzy", "pr-cat-ttl": "ttl_days" };
    for (const [cls, key] of Object.entries(catMap)) {
        div.querySelector(`.${cls}`)?.addEventListener("change", (e) => {
            const v = (key === "fuzzy" || key === "ttl_days") ? parseFloat(e.target.value) || 0 : e.target.value;
            model.setHttpCatalogue(id, { [key]: v }); save();
        });
    }
    div.querySelector(".pr-cat-hints")?.addEventListener("change", (e) => {
        model.setHttpCatalogue(id, { suffix_hints: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) }); save();
    });

    // response mapping
    div.querySelector(".pr-root")?.addEventListener("change", (e) => { model.setHttpRoot(id, e.target.value); save(); });
    // list-mode explode paths — adding/removing the first level flips list mode, so rebuild the body
    div.querySelector(".pr-exp-add")?.addEventListener("click", () => { model.addHttpExplode(id); rebuild(); });
    div.querySelectorAll(".pr-exp-del").forEach((b) => b.addEventListener("click", () => { model.removeHttpExplode(id, +b.closest(".pr-exp-row").dataset.i); rebuild(); }));
    div.querySelectorAll(".pr-exp-v").forEach((el) => el.addEventListener("change", () => { model.setHttpExplode(id, +el.closest(".pr-exp-row").dataset.i, el.value.trim()); save(); }));
    div.querySelector(".pr-f-add")?.addEventListener("click", () => { model.addHttpField(id); rebuild(); });
    div.querySelectorAll(".pr-f-del").forEach((b) => b.addEventListener("click", () => { model.removeHttpField(id, +b.dataset.i); structural(); }));
    div.querySelectorAll(".pr-f-out").forEach((el) => el.addEventListener("change", () => { model.setHttpField(id, fieldI(el), { out_field: el.value.trim() }); structural(); }));
    div.querySelectorAll(".pr-f-path").forEach((el) => el.addEventListener("change", () => { model.setHttpField(id, fieldI(el), { path: el.value }); save(); }));
    div.querySelectorAll(".pr-f-tmpl").forEach((el) => el.addEventListener("change", () => { model.setHttpField(id, fieldI(el), { template: el.value }); save(); }));
    div.querySelectorAll(".pr-f-type").forEach((el) => el.addEventListener("change", () => { model.setHttpField(id, fieldI(el), { type: el.value }); save(); }));
    div.querySelectorAll(".pr-f-req").forEach((el) => el.addEventListener("change", () => { model.setHttpField(id, fieldI(el), { required: el.checked }); save(); }));
    div.querySelectorAll(".pr-f-arr").forEach((el) => el.addEventListener("change", () => { model.toggleHttpFieldArray(id, fieldI(el), el.checked); rebuild(); }));
    div.querySelectorAll(".pr-fa-pluck").forEach((el) => el.addEventListener("change", () => { model.setHttpFieldArray(id, fieldI(el), { pluck: el.value }); save(); }));
    div.querySelectorAll(".pr-fa-agg").forEach((el) => el.addEventListener("change", () => { model.setHttpFieldArray(id, fieldI(el), { agg: el.value }); save(); }));
    div.querySelectorAll(".pr-fa-depth").forEach((el) => el.addEventListener("change", () => { model.setHttpFieldArray(id, fieldI(el), { depth: parseInt(el.value, 10) || 1 }); save(); }));
    // a filter row/button with NO data-i belongs to the producer's row_filter (null), not a field's
    // array reduction — the one place the shared filterList() primitive's two callers diverge.
    const fltI = (el) => (el.dataset.i === undefined ? null : +el.dataset.i);
    div.querySelectorAll(".pr-ff-add").forEach((b) => b.addEventListener("click", () => { model.addHttpFilter(id, fltI(b)); rebuild(); }));
    div.querySelectorAll(".pr-ff-del").forEach((b) => b.addEventListener("click", () => { model.removeHttpFilter(id, fltI(b), +b.dataset.fi); rebuild(); }));
    div.querySelectorAll(".pr-ffilt").forEach((row) => {
        const i = fltI(row), fi = +row.dataset.fi;
        const opSel = row.querySelector(".pr-ff-op"), valIn = row.querySelector(".pr-ff-val");
        row.querySelector(".pr-ff-path")?.addEventListener("change", (e) => { model.setHttpFilter(id, i, fi, { path: e.target.value }); save(); });
        // op and value co-normalize (in/nin take a list), so commit both together
        opSel?.addEventListener("change", () => { model.setHttpFilter(id, i, fi, { op: opSel.value, value: valIn.value }); save(); });
        valIn?.addEventListener("change", () => { model.setHttpFilter(id, i, fi, { op: opSel.value, value: valIn.value }); save(); });
    });

    // which source column names the item (next sweep uses it — no rebuild)
    div.querySelector(".enr-keyfld-sel")?.addEventListener("change", (e) => { model.setProducerSourceField(id, e.target.value); save(); });
    // add an item source via the chip add-select (same input the subset uses)
    div.querySelector(".pr-addsrc")?.addEventListener("change", (e) => {
        if (e.target.value && model.addProducerSource(id, e.target.value)) rebuild();
    });
    // unwire an item source — rebuild the node so the chip goes too, and redraw the edge
    wireArmedRemove(div, ".pr-rmsrc", (val) => { model.removeProducerSource(id, val); rebuild(); });
}

// ---- producer preview satellite: resolved inputs + output schema + live test-fetch ----
// Not polled: fetched once on mount (inputs/columns) and on demand (the test-fetch button).
function wireProducerPreview(div, r) {
    const game = model.profile.name;
    const cols = div.querySelector(".pp-cols");
    const host = div.querySelector(".pp-inputs");
    const result = div.querySelector(".pp-result");
    const btn = div.querySelector(".pp-probe");
    const itemIn = div.querySelector(".pp-item");

    async function loadPreview() {
        try {
            const p = await api.prices.preview(game, r.dataset);
            cols.replaceChildren(h("span", "outputs: "), h("strong", (p.columns || []).join(", ") || "—"));
            const rows = p.inputs || [];
            const list = h("table", { class: "pp-table" },
                h("tr", h("th", "item"), h("th", "→ key")),
                ...rows.map((it) => h("tr", h("td", it.name),
                    h("td", it.key || h("span", { class: "muted" }, "no match")))));
            const cap = p.total > rows.length ? h("p", { class: "muted", style: "padding:4px 8px" }, `showing ${rows.length} of ${p.total}`) : null;
            host.replaceChildren(rows.length ? frag(list, cap) : h("p", { class: "muted", style: "padding:8px" }, "no source items (wire a source dataset in)"));
        } catch (e) { host.replaceChildren(h("p", { class: "muted", style: "padding:8px" }, String(e.message || e))); }
    }

    async function probe() {
        btn.disabled = true; btn.classList.add("reading");
        result.replaceChildren(h("p", { class: "muted", style: "padding:4px 8px" }, "fetching…"));
        try {
            const d = await api.prices.probe(game, r.dataset, itemIn.value.trim());
            if (d.error) { result.replaceChildren(h("p", { class: "err", style: "padding:4px 8px" }, d.error)); return; }
            result.replaceChildren(
                h("div", { class: "pp-kv", style: "padding:4px 8px" },
                    h("div", h("strong", d.name || "—"), " → ", h("code", d.key || "?")),
                    d.url ? h("div", { class: "muted", style: "word-break:break-all" }, d.url) : null),
                h("div", { class: "pp-map", style: "padding:4px 8px" }, h("strong", "mapped: "),
                    h("code", JSON.stringify(d.mapped || {}))),
                h("details", { style: "padding:4px 8px" },
                    h("summary", { class: "muted" }, "raw sample"),
                    h("pre", { class: "pp-raw" }, JSON.stringify(d.sample, null, 1))));
        } catch (e) { result.replaceChildren(h("p", { class: "err", style: "padding:4px 8px" }, String(e.message || e))); }
        finally { btn.disabled = false; btn.classList.remove("reading"); }
    }

    btn?.addEventListener("click", probe);
    itemIn?.addEventListener("keydown", (e) => { if (e.key === "Enter") probe(); });
    queueMicrotask(loadPreview);
}

// ---- trigger node: fires price-node sweeps on a condition -------------------

function wireTrigger(div, n) {
    const t = n.ref;
    div.querySelector(".tgrename")?.addEventListener("change", (e) => {
        const oldId = t.id;
        renameNode(e.target, oldId,
            () => model.renameTrigger(oldId, (e.target.value || "").trim()),
            () => movePos(`trigger:${oldId}`, `trigger:${t.id}`),
            () => { render(); autosave(null); });
    });
    // kind swaps the body (interval/watch blocks) AND the edges, so rebuild this node then re-render
    div.querySelector(".tg-kind")?.addEventListener("change", (e) => {
        model.setTriggerKind(t.id, e.target.value); rebuildNode(n.id); render(); autosave(null);
    });
    div.querySelector(".tg-interval")?.addEventListener("change", (e) => { model.setTriggerInterval(t.id, e.target.value); autosave(null); });
    // rebuildNode (not render) re-renders THIS node's chips — render() only builds NEW nodes,
    // so an in-place chip add/remove wouldn't show. drawEdges() drops/adds the trigger's edges
    // (watch source→trigger and trigger→price) so a chip change reflects on the canvas live.
    div.querySelector(".tg-addwatch")?.addEventListener("change", (e) => { if (model.addTriggerWatch(t.id, e.target.value)) { rebuildNode(n.id); drawEdges(); autosave(null); } });
    // on_readout: watched readouts (chips + edges) + the threshold condition
    div.querySelector(".tg-addvarwatch")?.addEventListener("change", (e) => { if (model.addTriggerReadoutWatch(t.id, e.target.value)) { rebuildNode(n.id); drawEdges(); autosave(null); } });
    wireArmedRemove(div, ".tg-rmvarwatch", (val) => { model.removeTriggerReadoutWatch(t.id, val); rebuildNode(n.id); drawEdges(); autosave(null); });
    div.querySelector(".tg-varop")?.addEventListener("change", (e) => { model.setTriggerReadoutOp(t.id, e.target.value); autosave(null); });
    div.querySelector(".tg-varval")?.addEventListener("change", (e) => { model.setTriggerReadoutValue(t.id, e.target.value); autosave(null); });
    div.querySelector(".tg-addfire")?.addEventListener("change", (e) => { if (model.addTriggerTarget(t.id, e.target.value)) { rebuildNode(n.id); drawEdges(); autosave(null); } });
    wireArmedRemove(div, ".tg-rmwatch", (val) => { model.removeTriggerWatch(t.id, val); rebuildNode(n.id); drawEdges(); autosave(null); });
    wireArmedRemove(div, ".tg-rmtarget", (val) => { model.removeTriggerTarget(t.id, val); rebuildNode(n.id); drawEdges(); autosave(null); });
    // throttle: minimum ms between fires (empty = none). Rebuild so the input re-normalises (null -> placeholder).
    div.querySelector(".tg-throttle")?.addEventListener("change", (e) => { model.setTriggerThrottle(t.id, e.target.value); rebuildNode(n.id); autosave(null); });
    div.querySelector(".tg-fire")?.addEventListener("click", async () => {
        const prog = div.querySelector(".tg-prog");
        prog.textContent = "firing…";
        try { const r = await api.triggers.fire(model.profile.name, t.id); const n = (r.started || []).length, sk = (r.skipped || []).length; prog.textContent = n ? `fired ${n} target(s)` : sk ? `already sweeping (${sk} skipped)` : "no targets to fire"; refreshLive(); hub.kick(); }
        catch (err) { prog.textContent = String(err.message || err); }
    });
    // fill the history satellite when it's open (this runs on every render, incl. right after the
    // satellite is toggled on — the parent trigger rebuilds and populates its follower, exactly like
    // a dataset/subset fills its vt-table satellite). No-op when the satellite is hidden.
    renderTriggerHistory(t.id);
}

// ---- toast node: raise an OS desktop notification when fired ---------------

function wireToast(div, n) {
    const x = n.ref;
    const $ = (sel) => div.querySelector(sel);
    $(".toastrename")?.addEventListener("change", (e) => {
        const oldId = x.id;
        renameNode(e.target, oldId,
            () => model.renameToast(oldId, (e.target.value || "").trim()),
            () => movePos(`toast:${oldId}`, `toast:${x.id}`),
            () => { render(); autosave(null); });
    });
    $(".tn-app")?.addEventListener("change", (e) => { model.setToastProp(x.id, "app_name", e.target.value); autosave(null); });
    $(".tn-duration")?.addEventListener("change", (e) => { model.setToastProp(x.id, "duration", e.target.value); autosave(null); });
    $(".tn-icon")?.addEventListener("change", (e) => { model.setToastProp(x.id, "icon", e.target.value); autosave(null); });
    $(".tn-attr")?.addEventListener("change", (e) => { model.setToastProp(x.id, "attribution", e.target.value); autosave(null); });
    // rich-text blocks: content + per-block style/align/max-lines edits persist in place; add /
    // remove / reorder rebuild the node body (the block list + its indices change).
    div.querySelectorAll(".tn-bk-content").forEach((el) => el.addEventListener("change", (e) => { model.setToastText(x.id, +el.dataset.i, "content", e.target.value); autosave(null); }));
    div.querySelectorAll(".tn-bk-style").forEach((el) => el.addEventListener("change", (e) => { model.setToastText(x.id, +el.dataset.i, "style", e.target.value); autosave(null); }));
    div.querySelectorAll(".tn-bk-align").forEach((el) => el.addEventListener("change", (e) => { model.setToastText(x.id, +el.dataset.i, "align", e.target.value); autosave(null); }));
    div.querySelectorAll(".tn-bk-max").forEach((el) => el.addEventListener("change", (e) => { model.setToastText(x.id, +el.dataset.i, "max_lines", e.target.value); autosave(null); }));
    $(".tn-bk-add")?.addEventListener("click", () => { model.addToastText(x.id); rebuildNode(n.id); autosave(null); });
    div.querySelectorAll(".tn-bk-del").forEach((b) => b.addEventListener("click", () => { model.removeToastText(x.id, +b.dataset.i); rebuildNode(n.id); autosave(null); }));
    div.querySelectorAll(".tn-bk-up").forEach((b) => b.addEventListener("click", () => { if (model.moveToastText(x.id, +b.dataset.i, -1)) { rebuildNode(n.id); autosave(null); } }));
    div.querySelectorAll(".tn-bk-dn").forEach((b) => b.addEventListener("click", () => { if (model.moveToastText(x.id, +b.dataset.i, 1)) { rebuildNode(n.id); autosave(null); } }));
    // generated image editors — one wiring pass per image section (scoped by data-i), plus "+ image"
    div.querySelectorAll(".tn-img").forEach((sec) => wireToastImage(sec, x, n));
    div.querySelector(".tn-img-add")?.addEventListener("click", () => { model.addToastImage(x.id); rebuildNode(n.id); autosave(null); });
    // sources row: add/remove a wired data feeder (readout/dataset/subset) — the picker twin of
    // dragging a node's out-port here. Rebuild refreshes the pills + the {{token}} chips; drawEdges
    // adds/drops the source's data edge.
    $(".tn-addsrc")?.addEventListener("change", (e) => { if (model.addToastSource(x.id, e.target.value)) { rebuildNode(n.id); drawEdges(); autosave(null); } });
    wireArmedRemove(div, ".tn-rmsrc", (val) => { model.removeToastSource(x.id, val); rebuildNode(n.id); drawEdges(); autosave(null); });
    // token chips: click to COPY the source's {{token}} to the clipboard, ready to paste into any
    // text block or image text line (the palette sits below the images, away from the fields).
    div.querySelectorAll(".tn-rotoken").forEach((b) => b.addEventListener("click", async () => {
        const token = `{{${b.dataset.token}}}`;
        try { await navigator.clipboard.writeText(token); setStatus(`copied ${token}`); }
        catch { setStatus(`copy failed — ${token}`); }
    }));
    // slide toggles are native checkboxes now — read `.checked` on change
    $(".tn-muted")?.addEventListener("change", (e) => {
        model.setToastProp(x.id, "muted", e.currentTarget.checked); autosave(null);
    });
    $(".tn-showicon")?.addEventListener("change", (e) => {
        model.setToastProp(x.id, "show_icon", e.currentTarget.checked); autosave(null);
    });
    // test button: pop the toast now with its current config (mirrors the trigger's ↻ fire). The
    // server reads the toast from the SAVED profile, so commit the live field values + FLUSH the
    // pending save first — no need to defocus an input before clicking test.
    $(".tn-test")?.addEventListener("click", async () => {
        div.querySelectorAll(".tn-bk-content").forEach((el) => model.setToastText(x.id, +el.dataset.i, "content", el.value));
        for (const [sel, key] of [[".tn-app", "app_name"], [".tn-icon", "icon"], [".tn-attr", "attribution"]]) {
            const el = $(sel); if (el) model.setToastProp(x.id, key, el.value);
        }
        autosave(null);
        try { await persist.flush(); await api.toasts.test(model.profile.name, x.id); }
        catch (err) { setStatus(`toast test failed: ${err.message || err}`); }
    });
}

// Wire ONE generated-image editor section. `sec` is the `.tn-img` element (data-i = image index).
// The text elements are edited through a mini-inspector: the preview overlays a clickable box on
// every element, and the compact list + boxes SELECT which element the inspector edits (its full
// controls). Field edits persist + autosave + repreview (debounced); structural changes (bg type,
// add/remove element/image) rebuild the node so indices + conditional controls stay correct.
// 9-point code ("tl".."br") -> [fx, fy] fractions of a box (mirrors toast_image._frac server-side).
function _frac9(code) {
    const c = (code || "tl").toLowerCase();
    const v = { t: 0, m: 0.5, b: 1 }[c[0]] ?? 0;
    const hh = { l: 0, c: 0.5, r: 1 }[c[1]] ?? 0;
    return [hh, v];
}
// resize handle directions (edges + corners), like the OCR-cell canvas overlay
const _TN_HANDLES = [["nw", -1, -1], ["n", 0, -1], ["ne", 1, -1], ["e", 1, 0],
    ["se", 1, 1], ["s", 0, 1], ["sw", -1, 1], ["w", -1, 0]];

// canonicalise a typed hex ("#abc" -> "#aabbcc", "abc123" -> "#abc123"); null = reject (not 3/6 hex)
const normHex = (v) => { v = (v || "").trim().replace(/^#?/, "#"); if (/^#[0-9a-fA-F]{6}$/.test(v)) return v.toLowerCase(); if (/^#[0-9a-fA-F]{3}$/.test(v)) return ("#" + v[1] + v[1] + v[2] + v[2] + v[3] + v[3]).toLowerCase(); return null; };
// Wire a colorPair (native picker `cls` + linked hex text `cls`-hex) inside `root`, kept in sync:
// edit either, the other follows; `apply(hex)` persists. Returns a setter that pushes a value into
// both inputs (so a caller e.g. the border side-picker can repoint them).
function bindColorPair(root, cls, apply) {
    const c = root.querySelector(cls), tx = root.querySelector(cls + "-hex");
    c?.addEventListener("input", () => { if (tx) tx.value = c.value; apply(c.value); });
    tx?.addEventListener("change", () => { const n = normHex(tx.value); if (n) { c.value = n; tx.value = n; apply(n); } });
    return (v) => { if (c) c.value = v || "#000000"; if (tx) tx.value = v || ""; };
}

function wireToastImage(sec, x, n) {
    const idx = +sec.dataset.i;
    const q = (s) => sec.querySelector(s);
    let pvTimer = null;
    let pvSeq = 0;          // monotonically rising id: only the LATEST request's response is applied
    let curBoxes = [];      // per-element pixel boxes from the last preview (image-space)
    let scale = { sx: 1, sy: 1 };   // display px per image px, from the last layout
    let sel = model.toastImageSel(x.id, idx);   // selected element index (null when no elements)
    let bdSide = "";                 // active border side in the inspector ("" = base/all)
    let syncInspector = null;        // reconcile-in-place fn (assigned once by wireInspector)
    const im = () => model.toastImage(x.id, idx);
    const texts = () => (im() || {}).texts || [];
    const nw = () => (im() || {}).width || 1;      // image size in image px
    const nh = () => (im() || {}).height || 1;
    const boxByI = (i) => curBoxes.find((b) => b.i === i);
    const focusPv = () => q(".tn-img-pv")?.focus();
    // px delta -> the image's stored unit (px, or % of the image dimension), as an int.
    const toUnit = (px, dim) => Math.round((im() || {}).unit === "pct" ? px / dim * 100 : px);
    const unitMin = () => ((im() || {}).unit === "pct" ? 1 : 4);
    const setText = (i, k, v) => model.setToastImageText(x.id, idx, i, k, v);

    // ---- anchor guides: an SVG overlay drawing the selected element's anchor leg (target point ->
    // the element's own corner), so anchoring reads like pretty's cue layer. Redrawn on select/drag.
    const drawGuides = (i) => {
        const g = q(".tn-guides"); if (!g) return;
        const b = i == null ? null : boxByI(i);
        if (!b) { g.replaceChildren(); return; }
        const t = texts()[i] || {};
        const a = t.anchor || { to: "", corner: "tl", target: "tl" };
        let tb = { x: 0, y: 0, w: nw(), h: nh() };                 // anchor target = image, or a sibling
        if (a.to !== "" && a.to != null) { const sb = boxByI(+a.to); if (sb) tb = sb; }
        const [tfx, tfy] = _frac9(a.target); const [cfx, cfy] = _frac9(a.corner);
        const tp = [(tb.x + tfx * tb.w) * scale.sx, (tb.y + tfy * tb.h) * scale.sy];
        const cp = [(b.x + cfx * b.w) * scale.sx, (b.y + cfy * b.h) * scale.sy];
        g.replaceChildren(
            svg("line", { x1: tp[0], y1: tp[1], x2: cp[0], y2: cp[1], class: "tn-guide-leg" }),
            svg("circle", { cx: tp[0], cy: tp[1], r: 3.5, class: "tn-guide-t" }),
            svg("rect", { x: cp[0] - 3, y: cp[1] - 3, width: 6, height: 6, class: "tn-guide-c" }));
    };

    // px value of a stored coord in the image's unit (inverse of toUnit) — for local box resolve.
    const unitToPx = (v, dim) => ((im() || {}).unit === "pct" ? Math.round((v || 0) / 100 * dim) : (v || 0));
    // resolve one element's box (image px) straight from the model — mirrors the server so the
    // overlay can be moved/resized LOCALLY during a drag/nudge without a server round-trip.
    // mirror the server's _fixed: a match_w/match_h (sibling index) WINS, scaled by match_*_pct;
    // else an explicit width/height; else null = auto (fall back to the last server box's size).
    const rawLocal = (i, axis) => { const b = boxByI(i); return b ? (axis === "w" ? b.w : b.h) : 0; };
    const fixedLocal = (i, axis, stack) => {
        const t = texts()[i]; if (!t) return null;
        const ref = String((axis === "w" ? t.match_w : t.match_h) || "").trim();
        if (ref === "image") {   // match the image canvas size on this axis, scaled by the percent
            const base = axis === "w" ? nw() : nh();
            const pct = (axis === "w" ? t.match_w_pct : t.match_h_pct) || 100;
            return base ? Math.max(1, Math.round(base * pct / 100)) : null;
        }
        if (/^-?\d+$/.test(ref)) {
            const j = +ref;
            if (j >= 0 && j < texts().length && j !== i && !stack.has(j)) {
                const base = fixedLocal(j, axis, new Set(stack).add(i)) ?? rawLocal(j, axis);
                if (base) {
                    const pct = (axis === "w" ? t.match_w_pct : t.match_h_pct) || 100;
                    return Math.max(1, Math.round(base * pct / 100));
                }
            }
        }
        const explicit = axis === "w" ? unitToPx(t.width, nw()) : unitToPx(t.height, nh());
        return explicit > 0 ? explicit : null;
    };
    const resolveLocal = (i) => {
        const t = texts()[i]; if (!t) return null;
        const b0 = boxByI(i); const W = nw(), H = nh();
        const fw = fixedLocal(i, "w", new Set()), fh = fixedLocal(i, "h", new Set());
        const sw = fw != null ? fw : (b0 ? b0.w : 1), sh = fh != null ? fh : (b0 ? b0.h : 1);
        const a = t.anchor || { to: "", corner: "tl", target: "tl" };
        let tb = { x: 0, y: 0, w: W, h: H };
        if (a.to !== "" && a.to != null) { const sb = boxByI(+a.to); if (sb) tb = sb; }
        const [tfx, tfy] = _frac9(a.target); const [cfx, cfy] = _frac9(a.corner);
        return { x: Math.round(tb.x + tfx * tb.w - cfx * sw + unitToPx(t.x, W)),
                 y: Math.round(tb.y + tfy * tb.h - cfy * sh + unitToPx(t.y, H)), w: sw, h: sh };
    };
    // repaint the selected box + guides locally from the model (no server); update curBoxes too so
    // guides and later local resolves stay consistent through a continuous drag/nudge.
    const paintSel = () => {
        if (sel == null) return;
        const b = resolveLocal(sel); if (!b) return;
        const cb = boxByI(sel); if (cb) { cb.x = b.x; cb.y = b.y; cb.w = b.w; cb.h = b.h; }
        const el = sec.querySelector(`.tn-img-boxes .tn-box[data-i="${sel}"]`);
        if (el) { const { sx, sy } = scale; el.style.left = `${(b.x * sx).toFixed(1)}px`; el.style.top = `${(b.y * sy).toFixed(1)}px`;
            el.style.width = `${Math.max(6, b.w * sx).toFixed(1)}px`; el.style.height = `${Math.max(6, b.h * sy).toFixed(1)}px`; }
        drawGuides(sel);
    };
    let _raf = 0;
    const rafPaint = () => { if (_raf) return; _raf = requestAnimationFrame(() => { _raf = 0; paintSel(); }); };
    // defer the expensive save + server re-render until edits settle, so holding WASD or dragging
    // fires ONE render+save at the end, not one per step (the overlay updates live via paintSel).
    // Moving/resizing/nudging an element is a rect edit, so it rides the SAME transaction every box
    // overlay uses (rect_txn.js): the drag only paints, and Enter / the ✓ button / a click outside
    // the node runs the expensive save + server re-render ONCE for the whole batch; Escape puts every
    // touched element back. Unlike a canvas box this editor WRITES the model live (resolveLocal reads
    // it back to place the overlay without a round-trip), so the clean state is a snapshot, not the
    // model — `txnSnap` holds each element's geometry as it was before this batch touched it.
    const TXN_KEY = `toast:${x.id}:${idx}`;
    const txnSnap = new Map();   // element index -> {x, y, width, height} before the batch
    const toastSpec = () => ({
        host: q(".tn-img-pv"),
        isOutside: (t) => !sec.closest(".gnode")?.contains(t),
        commit: () => { txnSnap.clear(); autosave(null); refreshPreview(); },
        restore: () => {
            for (const [i, g] of txnSnap) for (const k of ["x", "y", "width", "height"]) setText(i, k, g[k]);
            txnSnap.clear();
            syncGeomInputs(); rafPaint();
        },
    });
    // Call BEFORE the first setText of a gesture: opens/extends the batch and snapshots the element's
    // pre-edit geometry exactly once.
    const beginEdit = (i) => {
        rectTxn.begin(TXN_KEY, toastSpec);
        const t = texts()[i];
        if (t && !txnSnap.has(i)) txnSnap.set(i, { x: t.x, y: t.y, width: t.width, height: t.height });
    };
    const touchEdit = (i) => {
        const t = texts()[i];
        if (t) rectTxn.touch(i, { role: "toast", x: t.x || 0, y: t.y || 0, w: t.width || 0, h: t.height || 0 });
    };

    // one draggable/resizable overlay box for element b.i
    const makeBox = (b) => {
        const sx = scale.sx, sy = scale.sy;
        const nameOf = (bi) => { const t = texts()[bi]; const c = (t?.content || "").trim(); return `${bi + 1}: ${c || "(empty)"}`; };
        const d = h("div", { class: "tn-box" + (b.i === sel ? " sel" : ""), dataset: { i: b.i },
            title: "drag to move · drag an edge to resize · click to select (click again to deselect)",
            style: `left:${(b.x * sx).toFixed(1)}px;top:${(b.y * sy).toFixed(1)}px;width:${Math.max(6, b.w * sx).toFixed(1)}px;height:${Math.max(6, b.h * sy).toFixed(1)}px` },
            h("span", { class: "tn-box-lab" }, nameOf(b.i)));
        // MOVE: press inside (not on a handle) -> beginDrag (shared loop). A press w/o drag on an
        // UNselected box selects it; the same press on the ALREADY-selected box toggles it off
        // (deselect -> pick back to "(none)"). A real drag never deselects.
        d.addEventListener("mousedown", (ev) => {
            if (ev.button !== 0 || ev.target.classList.contains("tn-box-h")) return;
            ev.preventDefault();
            const wasSel = (b.i === sel);
            selectLine(b.i); focusPv();
            let dragged = false;
            document.addEventListener("mouseup", () => { if (!dragged && wasSel) selectLine(null); }, { once: true });
            const t = texts()[b.i]; if (!t) return;
            const ox = t.x, oy = t.y;
            beginDrag(ev, { threshold: 3, cursor: "grabbing",
                onStart: () => { dragged = true; },
                onMove: (e) => {
                    beginEdit(b.i);
                    setText(b.i, "x", ox + toUnit((e.clientX - ev.clientX) / sx, nw()));
                    setText(b.i, "y", oy + toUnit((e.clientY - ev.clientY) / sy, nh()));
                    rafPaint();                              // local overlay only — no server render
                },
                onSettle: () => { syncGeomInputs(); touchEdit(b.i); } });
        });
        // RESIZE: 8 edge/corner handles, each a beginDrag adjusting width/height (+ x/y for top/left).
        for (const [k, hx, hy] of _TN_HANDLES) {
            const g = h("div", { class: `tn-box-h tn-box-${k}`, dataset: { d: k } });
            g.addEventListener("mousedown", (ev) => {
                if (ev.button !== 0) return;
                ev.preventDefault(); ev.stopPropagation(); selectLine(b.i); focusPv();
                const t = texts()[b.i]; if (!t) return;
                // seed from the stored size, or the auto (measured) box when width/height is 0
                const seedW = t.width || toUnit(b.w, nw()), seedH = t.height || toUnit(b.h, nh());
                const o = { x: t.x, y: t.y, w: seedW, h: seedH };
                beginDrag(ev, { threshold: 0, cursor: getComputedStyle(g).cursor,
                    onMove: (e) => {
                        beginEdit(b.i);
                        const ux = toUnit((e.clientX - ev.clientX) / sx, nw()), uy = toUnit((e.clientY - ev.clientY) / sy, nh());
                        const mn = unitMin();
                        let nx = o.x, ny = o.y, nwd = o.w, nhd = o.h;
                        if (hx > 0) nwd = Math.max(mn, o.w + ux);
                        if (hx < 0) { nx = o.x + ux; nwd = Math.max(mn, o.w - ux); }
                        if (hy > 0) nhd = Math.max(mn, o.h + uy);
                        if (hy < 0) { ny = o.y + uy; nhd = Math.max(mn, o.h - uy); }
                        // a matched axis is locked to the match target — dragging it must NOT write a
                        // (dead, then persisted) width/height. Skip both x and size on a matched axis.
                        if (hx && !t.match_w) { setText(b.i, "x", nx); setText(b.i, "width", nwd); }
                        if (hy && !t.match_h) { setText(b.i, "y", ny); setText(b.i, "height", nhd); }
                        rafPaint();                          // local overlay only — no server render
                    },
                    onSettle: () => { syncGeomInputs(); touchEdit(b.i); } });
            });
            d.appendChild(g);
        }
        return d;
    };
    // Lay the draggable boxes over the preview, scaling image-space px -> the displayed img size.
    const layoutBoxes = () => {
        const el = q(".tn-img-preview"); const ov = q(".tn-img-boxes");
        if (!el || !ov) return;
        const iw = el.naturalWidth, ih = el.naturalHeight;
        if (!iw || !ih) { ov.replaceChildren(); return; }
        // the img is width:100% + height:auto -> UNIFORMLY scaled (aspect preserved), so sy == sx.
        // Derive the displayed height from clientWidth; DON'T read clientHeight — after a canvas-size
        // change it can still hold the old value in the load handler, leaving boxes mis-scaled.
        const cw = el.clientWidth, s = cw / iw, ch = ih * s;
        scale = { sx: s, sy: s };
        ov.style.width = `${cw}px`; ov.style.height = `${ch}px`;
        const gv = q(".tn-guides"); if (gv) { gv.setAttribute("width", cw); gv.setAttribute("height", ch); }
        ov.replaceChildren(...curBoxes.map((b) => makeBox(b)));
        drawGuides(sel);
        // A server frame carries the box positions AS OF the request it answered — stale if the
        // user kept nudging (WASD/drag) while it rendered. Re-snap the selected box to the CURRENT
        // model so a late frame never yanks it back to where it was when the request left.
        if (sel != null) paintSel();
    };
    const refreshPreview = () => {
        clearTimeout(pvTimer);
        pvTimer = setTimeout(async () => {
            const spec = im();
            const el = q(".tn-img-preview");
            if (!el || !spec) return;   // render even when placement=none: the design stays visible
            // Reserve the slot's height up front from the canvas size (img is width:100% + height:auto,
            // so aspect-ratio fixes the height before/while the frame loads) — the box never collapses
            // during the fetch or a swap, so nothing below it jumps. Matches the server's render aspect.
            if (spec.width && spec.height) el.style.aspectRatio = `${spec.width} / ${spec.height}`;
            // Debounce collapses a burst into one request, but a render slower than the debounce
            // window lets several overlap. Tag each with a sequence id and, when a response lands,
            // drop it if a newer request has since started — the stale frame never overwrites the
            // latest, and its object URL is revoked so it doesn't leak.
            const seq = ++pvSeq;
            const res = await api.toasts.previewImage(model.profile.name, spec);
            if (seq !== pvSeq) { if (res && res.url) URL.revokeObjectURL(res.url); return; }
            if (res && res.url) {
                // Decode the new frame OFF-DOM first, then swap. Assigning el.src straight away blanks
                // the on-screen <img> until the new blob decodes — a blank img collapses to height:0,
                // so the whole node jerks down and back (layout shift). Pre-decoding warms the blob so
                // the visible swap is instant, and we keep the OLD url alive until after the swap.
                const pre = new Image();
                pre.src = res.url;
                try { await pre.decode(); } catch { /* superseded/aborted decode — swap anyway, load fires */ }
                if (seq !== pvSeq) { URL.revokeObjectURL(res.url); return; }
                const old = el._u;
                curBoxes = res.boxes || [];
                el._u = res.url; el.src = res.url;
                if (old) URL.revokeObjectURL(old);   // revoke the previous frame only after it's replaced
                if (el.complete && el.naturalWidth) layoutBoxes();   // warmed decode: lay out now
            }
        }, 250);
    };
    // the new frame's true dimensions are known on load -> (re)lay the boxes then
    q(".tn-img-preview")?.addEventListener("load", layoutBoxes);
    // select element `j`: persist the (transient) selection, re-point the inspector + highlights in
    // place (no preview refetch — the image is unchanged, only which element is active).
    const selectLine = (j) => {
        model.setToastImageSel(x.id, idx, j); sel = j;
        sec.querySelectorAll(".tn-img-boxes .tn-box").forEach((b) => b.classList.toggle("sel", j != null && +b.dataset.i === j));
        const pk = sec.querySelector(".tn-il-pick"); if (pk) pk.value = j == null ? "" : String(j);
        if (syncInspector) syncInspector(j);   // reconcile the existing inspector, don't rebuild it
        drawGuides(j);
    };
    // click on the empty preview (not on a box) deselects the element — but clicking the inspector
    // never deselects (those clicks don't reach the preview), so editing the element still works.
    q(".tn-img-preview")?.addEventListener("mousedown", (ev) => { if (ev.button === 0) selectLine(null); });
    // click ANYWHERE outside this image's editor (another node, the canvas, another image) also
    // deselects it — so the selection isn't stuck when you move on. Clicks inside this section
    // (preview/boxes/inspector/pick) are handled by their own wiring above, never here. The listener
    // self-removes once this section is torn down by a rebuild (its `sec` leaves the document).
    // remember the last press so the focus-leave handler below can tell a genuine "left the editor"
    // blur from one that merely lands on a non-focusable gap INSIDE the inspector (keep editing) or is
    // a right-click (never deselects). This document-capture mousedown runs BEFORE the focusout it fires.
    let downInInsp = false, downRight = false;
    const outsideDeselect = (ev) => {
        if (!document.contains(sec)) { document.removeEventListener("mousedown", outsideDeselect, true); return; }
        downRight = ev.button !== 0;
        downInInsp = !downRight && sec.contains(ev.target) && !!ev.target.closest?.(".tn-il-insp");
        if (ev.button === 0 && sel != null && !sec.contains(ev.target)) selectLine(null);
    };
    document.addEventListener("mousedown", outsideDeselect, true);
    // The box overlay + guides reveal on `.tn-img:focus-within` (graph.css) — so the MOMENT focus
    // leaves this section they visually disappear. The inspector is driven by `sel`, which a click on
    // a non-focusable gap OUTSIDE the inspector (blurs the preview, doesn't reach outsideDeselect) never
    // clears — box looks deselected while the inspector stays populated. Tie the two to ONE boundary:
    // focus leaving the section IS a real deselect — but a gap-click still inside the inspector (mid
    // edit) and any right-click must NOT trip it (relatedTarget is null for a non-focusable gap either
    // way, so the recorded click target — not where focus landed — is what disambiguates).
    sec.addEventListener("focusout", (ev) => {
        if (downRight || downInInsp) return;
        if (sel != null && !sec.contains(ev.relatedTarget)) selectLine(null);
    });
    // keep the inspector's x/y/w/h number inputs in step with a model change from mouse/keyboard.
    const syncGeomInputs = () => {
        const t = texts()[sel]; if (!t) return;
        const set = (cls, v) => { const el = q(cls); if (el && document.activeElement !== el) el.value = v; };
        set(".tn-il-x", t.x ?? 0); set(".tn-il-y", t.y ?? 0);
        set(".tn-il-w", t.width || ""); set(".tn-il-h", t.height || "");
    };
    // Changing the anchor (to / corner / target) must keep the element visually PUT: back-solve a new
    // x/y offset so the resolved box top-left stays where it is now, then apply the anchor change.
    const reanchor = (i, key, val) => {
        rectTxn.commitIfDirty();   // back-solving x/y off the CURRENT box: land any pending nudge first
        const t = texts()[i]; const b = boxByI(i);
        if (!t || !b) { model.setToastImageAnchor(x.id, idx, i, key, val); autosave(null); refreshPreview(); return; }
        const a = { to: "", corner: "tl", target: "tl", ...(t.anchor || {}), [key]: val };
        let tb = { x: 0, y: 0, w: nw(), h: nh() };
        if (a.to !== "" && a.to != null) { const sb = boxByI(+a.to); if (sb) tb = sb; }
        const [tfx, tfy] = _frac9(a.target); const [cfx, cfy] = _frac9(a.corner);
        const offX = b.x - (tb.x + tfx * tb.w) + cfx * b.w;   // offset that lands the box back at (b.x,b.y)
        const offY = b.y - (tb.y + tfy * tb.h) + cfy * b.h;
        model.setToastImageAnchor(x.id, idx, i, key, val);
        setText(i, "x", toUnit(offX, nw())); setText(i, "y", toUnit(offY, nh()));
        syncGeomInputs(); autosave(null); refreshPreview();
    };
    // WASD nudges the selected element; Shift+WASD resizes it (A/D width, W/S height) — the SAME
    // convention every other box in the editor uses (shared NUDGE map), no per-editor modifier.
    // Scoped to the focused preview so it never fights the page or other images. Held keys only paint
    // the local overlay; the (expensive) save + server re-render waits for the rect transaction to
    // commit (Enter / ✓ / clicking outside the node), so a held key is one render, never one per repeat.
    q(".tn-img-pv")?.addEventListener("keydown", (e) => {
        if (sel == null) return;
        const dir = NUDGE[e.key.toLowerCase()]; if (!dir) return;
        e.preventDefault(); e.stopPropagation();   // don't let the graph's WASD also move the node
        const t = texts()[sel]; if (!t) return;
        beginEdit(sel);
        const [ux, uy] = dir;
        if (e.shiftKey) {                           // resize — matches every box overlay's Shift+WASD
            // a matched axis is locked to its match target — don't write a dead width/height on it.
            if (ux && !t.match_w) setText(sel, "width", Math.max(1, (t.width || 0) + ux));
            if (uy && !t.match_h) setText(sel, "height", Math.max(1, (t.height || 0) + uy));
        } else {                                    // move
            if (ux) setText(sel, "x", (t.x || 0) + ux);
            if (uy) setText(sel, "y", (t.y || 0) + uy);
        }
        syncGeomInputs(); rafPaint(); touchEdit(sel);   // local overlay now; the batch commits on Enter/✓/click-out
    });
    // wire the mini-inspector's controls (exactly one set exists in `sec`); rebound after each
    // selection replaces the inspector node.
    const wireInspector = () => {
        // Target the CURRENTLY selected element (`sel`), not the control's build-time data-i: the
        // inspector DOM is reconciled in place on a selection change (syncInspector), so a control's
        // own data-i goes stale — writing x/y/w/h/etc. to the previously selected element. Every other
        // handler below already keys off `sel`; these must too.
        // The four GEOMETRY fields are just another way to move the box, so they join the same rect
        // transaction the drag/nudge opens (paint now, one save + one server render at commit) instead
        // of re-rendering per keystroke. Everything else (content, size, z) still applies immediately.
        const GEOM = new Set(["x", "y", "width", "height"]);
        const line = (cls, key) => sec.querySelectorAll(cls).forEach((el) => el.addEventListener("input", () => {
            if (GEOM.has(key)) { beginEdit(sel); setText(sel, key, el.value); rafPaint(); touchEdit(sel); return; }
            setText(sel, key, el.value); autosave(null); refreshPreview();
        }));
        line(".tn-il-content", "content"); line(".tn-il-x", "x"); line(".tn-il-y", "y");
        line(".tn-il-size", "size"); line(".tn-il-w", "width"); line(".tn-il-h", "height");
        line(".tn-il-z", "z_index");   // stacking order — only affects paint order, so repreview (no box repaint)
        // per-row reset: restore that row's field(s) to the element defaults, then reconcile the
        // inspector + overlay in place (syncInspector repaints every control incl. border/anchor).
        sec.querySelectorAll(".tn-il-rst").forEach((b) => b.addEventListener("click", () => {
            if (sel == null) return;
            model.resetToastImageTextRow(x.id, idx, sel, b.dataset.row);
            syncInspector(sel); paintSel(); autosave(null); refreshPreview();
        }));
        sec.querySelectorAll(".tn-il-wrap").forEach((el) => el.addEventListener("change", () => { setText(sel, "wrap", el.checked); autosave(null); refreshPreview(); }));
        sec.querySelectorAll(".tn-il-over").forEach((el) => el.addEventListener("change", () => { setText(sel, "overflow", el.checked); autosave(null); refreshPreview(); }));
        sec.querySelectorAll(".tn-il-cond").forEach((el) => el.addEventListener("change", () => { setText(sel, "disable_if_empty", el.checked); autosave(null); refreshPreview(); }));
        // match this element's width / height to a sibling's resolved size ("" = own size), scaled by
        // the adjacent percent input (100 = full, 50 = half).
        // paintSel() gives the box overlay its new matched size instantly; the server re-render (text
        // re-fit) follows debounced. syncGeomInputs keeps the w/h number fields honest.
        const matchEdit = (key, v) => {
            setText(sel, key, v); syncGeomInputs(); paintSel(); autosave(null); refreshPreview();
            // picking/clearing a match flips whether that axis's dimension input + percent are read —
            // toggle their disabled state live (syncInspector does the same on the next reconcile).
            if (key === "match_w") { const w = q(".tn-il-w"); if (w) w.disabled = !!v; const p = q(".tn-il-mwp"); if (p) p.disabled = !v; }
            if (key === "match_h") { const hh = q(".tn-il-h"); if (hh) hh.disabled = !!v; const p = q(".tn-il-mhp"); if (p) p.disabled = !v; }
        };
        sec.querySelector(".tn-il-mw")?.addEventListener("change", (e) => matchEdit("match_w", e.target.value));
        sec.querySelector(".tn-il-mh")?.addEventListener("change", (e) => matchEdit("match_h", e.target.value));
        sec.querySelector(".tn-il-mwp")?.addEventListener("input", (e) => matchEdit("match_w_pct", e.target.value));
        sec.querySelector(".tn-il-mhp")?.addEventListener("input", (e) => matchEdit("match_h_pct", e.target.value));
        // colour = native picker + linked hex text, kept in sync (edit either). Returns a bound
        // hex-setter so a caller (e.g. the border side-picker) can push a new value into both.
        const cpair = (cls, apply) => bindColorPair(sec, cls, apply);
        const setTextColor = cpair(".tn-il-color", (v) => { setText(sel, "color", v); autosave(null); refreshPreview(); });
        const setBgColor = cpair(".tn-il-bg", (v) => { setText(sel, "bg_color", v); autosave(null); refreshPreview(); });
        // font family
        sec.querySelector(".tn-il-font")?.addEventListener("change", (e) => { setText(sel, "font_family", e.target.value); autosave(null); refreshPreview(); });
        // bold / italic / underline toggles
        sec.querySelectorAll(".tn-il-biu .tn-biu-b").forEach((b) => b.addEventListener("click", () => {
            const k = b.dataset.k, on = !(texts()[sel] || {})[k];
            b.classList.toggle("on", on); setText(sel, k, on); autosave(null); refreshPreview();
        }));
        // 9-point align grid
        sec.querySelectorAll(".tn-il-align .tn-nine-b").forEach((b) => b.addEventListener("click", () => {
            sec.querySelectorAll(".tn-il-align .tn-nine-b").forEach((o) => o.classList.remove("on"));
            b.classList.add("on"); setText(sel, "align", b.dataset.code); autosave(null); refreshPreview();
        }));
        // per-side border editor: a side picker retargets the w/color/style controls (bdSide is
        // hoisted to the section scope so the reconcile can reset it when the selection changes).
        const syncBorder = () => {
            const t = texts()[sel] || {};
            const src = bdSide ? ((t.border_sides || {})[bdSide] || t.border || {}) : (t.border || {});
            const w = q(".tn-bd-w"), s = q(".tn-bd-s");
            if (w) w.value = src.w ?? 0; if (s) s.value = src.style || "solid";
            setBdColor(src.color || "#ffffff");   // push into the picker + its hex text
        };
        // accent each side button whose border is set (w>0); "all" reflects the base border
        const refreshSetFlags = () => {
            const t = texts()[sel] || {};
            sec.querySelectorAll(".tn-bd-side").forEach((o) => {
                const sv = o.dataset.side;
                const set = sv ? ((t.border_sides || {})[sv]?.w > 0) : ((t.border || {}).w > 0);
                o.classList.toggle("set", !!set);
            });
        };
        sec.querySelectorAll(".tn-bd-side").forEach((b) => b.addEventListener("click", () => {
            bdSide = b.dataset.side;
            sec.querySelectorAll(".tn-bd-side").forEach((o) => o.classList.toggle("on", o === b));
            syncBorder();
        }));
        const bd = (cls, key, ev) => q(cls)?.addEventListener(ev, (e) => { model.setToastImageBorder(x.id, idx, sel, bdSide, key, e.target.value); refreshSetFlags(); autosave(null); refreshPreview(); });
        bd(".tn-bd-w", "w", "input"); bd(".tn-bd-s", "style", "change");
        const setBdColor = cpair(".tn-bd-c", (v) => { model.setToastImageBorder(x.id, idx, sel, bdSide, "color", v); refreshSetFlags(); autosave(null); refreshPreview(); });
        // anchor: target select + this/target 9-point grids. reanchor() keeps the element visually put.
        sec.querySelector(".tn-anch-to")?.addEventListener("change", (e) => {
            reanchor(sel, "to", e.target.value);   // grids stay enabled for the image (pins to the canvas)
        });
        const anchGrid = (cls, key) => sec.querySelectorAll(`${cls} .tn-nine-b`).forEach((b) => b.addEventListener("click", () => {
            sec.querySelectorAll(`${cls} .tn-nine-b`).forEach((o) => o.classList.remove("on"));
            b.classList.add("on"); reanchor(sel, key, b.dataset.code);
        }));
        anchGrid(".tn-anch-corner", "corner"); anchGrid(".tn-anch-target", "target");
        // delete the selected element (the inspector's one trash button) -> shift selection + rebuild
        sec.querySelector(".tn-il-del")?.addEventListener("click", () => {
            const j = model.toastImageSel(x.id, idx); if (j == null) return;
            model.removeToastImageText(x.id, idx, j);
            model.setToastImageSel(x.id, idx, texts().length ? Math.max(0, Math.min(texts().length - 1, j)) : null);
            rebuildNode(n.id); autosave(null);
        });
        // reconcile the EXISTING inspector DOM to element j (or off = null) — reuse elements, never
        // rebuild from scratch on a selection change (rule 1). Captures the wired helpers above.
        syncInspector = (j) => {
            const insp = sec.querySelector(".tn-il-insp"); if (!insp) return;
            const offNow = j == null, e = offNow ? {} : (texts()[j] || {});
            insp.classList.toggle("tn-il-off", offNow);
            insp.dataset.i = offNow ? 0 : j;
            const head = insp.querySelector(".tn-il-insp-h .muted"); if (head) head.textContent = offNow ? "no element selected" : `element ${j + 1}`;
            const setV = (cls, v) => { const el = insp.querySelector(cls); if (el && document.activeElement !== el) el.value = v; };
            setV(".tn-il-content", e.content || ""); setV(".tn-il-size", e.size ?? 20);
            setV(".tn-il-x", e.x ?? 0); setV(".tn-il-y", e.y ?? 0);
            setV(".tn-il-w", e.width || ""); setV(".tn-il-h", e.height || ""); setV(".tn-il-font", e.font_family || "");
            setV(".tn-il-z", e.z_index ?? 0);
            const wr = insp.querySelector(".tn-il-wrap"); if (wr) wr.checked = e.wrap !== false;
            const ov = insp.querySelector(".tn-il-over"); if (ov) ov.checked = !!e.overflow;
            const cd = insp.querySelector(".tn-il-cond"); if (cd) cd.checked = !!e.disable_if_empty;
            // rebuild each match select's sibling <option>s (self excluded), then set the current value
            const matchOpts = (cls, cur) => {
                const s = insp.querySelector(cls); if (!s) return;
                const opts = [h("option", { value: "" }, "—"), h("option", { value: "image" }, "image")];
                for (let k = 0; k < texts().length; k++) if (k !== j)
                    opts.push(h("option", { value: String(k) }, `${k + 1}: ${(texts()[k].content || "").trim() || "(empty)"}`));
                s.replaceChildren(...opts); s.value = cur || "";
            };
            matchOpts(".tn-il-mw", e.match_w); matchOpts(".tn-il-mh", e.match_h);
            setV(".tn-il-mwp", e.match_w_pct ?? 100); setV(".tn-il-mhp", e.match_h_pct ?? 100);
            // a match on an axis WINS over its own width/height (dimension input dead); a match-percent
            // is inert with no match. Disable the inputs that aren't read, so nothing edits a dead value.
            const dis = (cls, on) => { const el = insp.querySelector(cls); if (el) el.disabled = on; };
            dis(".tn-il-w", !!e.match_w); dis(".tn-il-h", !!e.match_h);
            dis(".tn-il-mwp", !e.match_w); dis(".tn-il-mhp", !e.match_h);
            insp.querySelectorAll(".tn-il-biu .tn-biu-b").forEach((b) => b.classList.toggle("on", !!e[b.dataset.k]));
            setTextColor(e.color || "#ffffff"); setBgColor(e.bg_color || "#000000");
            const acode = { left: "tl", center: "tc", right: "tr" }[e.align] || e.align || "tl";
            insp.querySelectorAll(".tn-il-align .tn-nine-b").forEach((b) => b.classList.toggle("on", b.dataset.code === acode));
            bdSide = "";   // reset the border side-picker to the base for the new element
            insp.querySelectorAll(".tn-bd-side").forEach((o) => o.classList.toggle("on", o.dataset.side === ""));
            refreshSetFlags(); syncBorder();
            const a = e.anchor || { to: "", corner: "tl", target: "tl" };
            const toSel = insp.querySelector(".tn-anch-to");
            if (toSel) {   // rebuild only the sibling <option>s (self excluded), not the whole inspector
                const opts = [h("option", { value: "" }, "image")];
                for (let k = 0; k < texts().length; k++) if (k !== j) opts.push(h("option", { value: String(k) }, `element ${k + 1}`));
                toSel.replaceChildren(...opts); toSel.value = a.to || "";
            }
            insp.querySelectorAll(".tn-anch-corner .tn-nine-b").forEach((b) => b.classList.toggle("on", b.dataset.code === (a.corner || "tl")));
            insp.querySelectorAll(".tn-anch-target .tn-nine-b").forEach((b) => b.classList.toggle("on", b.dataset.code === (a.target || "tl")));
        };
    };
    q(".tn-img-addtext")?.addEventListener("click", () => {
        model.addToastImageText(x.id, idx);
        model.setToastImageSel(x.id, idx, texts().length - 1);   // open the new element in the inspector
        rebuildNode(n.id); autosave(null);
    });
    q(".tn-img-clone")?.addEventListener("click", () => {
        const j = model.toastImageSel(x.id, idx); if (j == null) return;
        const nj = model.cloneToastImageText(x.id, idx, j);
        if (nj != null) model.setToastImageSel(x.id, idx, nj);   // open the clone
        rebuildNode(n.id); autosave(null);
    });
    // element picker dropdown — jump to an element, or "(none)" to deselect
    q(".tn-il-pick")?.addEventListener("change", (e) => selectLine(e.target.value === "" ? null : +e.target.value));
    // placement (hero/inline/none) — no layout change, just persist + (nothing to repreview)
    q(".tn-img-place")?.addEventListener("change", (e) => { model.setToastImageProp(x.id, idx, "placement", e.target.value); autosave(null); });
    // unit toggle (px / % of image) — convert stored coords so the on-screen design is preserved
    q(".tn-img-unit")?.addEventListener("change", (e) => { model.convertToastImageUnit(x.id, idx, e.target.value); rebuildNode(n.id); autosave(null); });
    q(".tn-img-del")?.addEventListener("click", () => { model.removeToastImage(x.id, idx); rebuildNode(n.id); autosave(null); });
    // scalar props (size + gradient colours/angle) — persist + repreview on input
    const scalar = (s, key) => q(s)?.addEventListener("input", (e) => { model.setToastImageProp(x.id, idx, key, e.target.value); autosave(null); refreshPreview(); });
    scalar(".tn-img-w", "width"); scalar(".tn-img-h2", "height"); scalar(".tn-img-angle", "angle");
    // bg colours are colorPairs (picker + linked hex text) — edit either, kept in sync
    const imgColor = (key) => (v) => { model.setToastImageProp(x.id, idx, key, v); autosave(null); refreshPreview(); };
    bindColorPair(sec, ".tn-img-c1", imgColor("color1")); bindColorPair(sec, ".tn-img-c2", imgColor("color2"));
    // bg type flips which controls show (color2/angle) -> rebuild the node body, then repreview
    q(".tn-img-bgtype")?.addEventListener("change", (e) => { model.setToastImageProp(x.id, idx, "bg_type", e.target.value); rebuildNode(n.id); autosave(null); });
    wireInspector();
    refreshPreview();   // initial paint (also runs after a rebuild re-wires the section)
}

// ---- sound node: play an audio file (in the browser) when fired ------------

function wireSound(div, n) {
    const x = n.ref;
    const $ = (sel) => div.querySelector(sel);
    $(".sndrename")?.addEventListener("change", (e) => {
        const oldId = x.id;
        renameNode(e.target, oldId,
            () => model.renameSound(oldId, (e.target.value || "").trim()),
            () => movePos(`sound:${oldId}`, `sound:${x.id}`),
            () => { render(); autosave(null); });
    });
    $(".sn-file")?.addEventListener("change", (e) => { model.setSoundFile(x.id, e.target.value); autosave(null); });
    // volume is a segmented meter now (confMeter) — it dispatches `change` on drag; the bar shows
    // its own level, so there's no separate % label to sync. autosave coalesces the writes.
    $(".sn-volume")?.addEventListener("change", (e) => {
        model.setSoundVolume(x.id, e.target.value);
        autosave(null);
    });
    // ▶ audition the sound now at the current volume (also unlocks browser autoplay for later auto-fires)
    $(".sn-test")?.addEventListener("click", () => {
        const s = model.soundNode(x.id);
        if (!s?.file) return;
        playSound(s.file, s.volume ?? 1);
    });
}

// ---- action node: clear / clone / move a dataset's data when fired ----------

function wireAction(div, n) {
    const x = n.ref;
    const $ = (sel) => div.querySelector(sel);
    $(".acrename")?.addEventListener("change", (e) => {
        const oldId = x.id;
        renameNode(e.target, oldId,
            () => model.renameAction(oldId, (e.target.value || "").trim()),
            () => movePos(`action:${oldId}`, `action:${x.id}`),
            () => { render(); autosave(null); });
    });
    // action kind: rebuild so the dest select shows/hides for clone/move; edges follow (dest edge)
    $(".ac-action")?.addEventListener("change", (e) => { model.setActionKind(x.id, e.target.value); rebuildNode(n.id); drawEdges(); autosave(null); });
    $(".ac-addds")?.addEventListener("change", (e) => { if (model.addActionDataset(x.id, e.target.value)) { rebuildNode(n.id); drawEdges(); autosave(null); } });
    wireArmedRemove(div, ".ac-rmds", (val) => { model.removeActionDataset(x.id, val); rebuildNode(n.id); drawEdges(); autosave(null); });
    $(".ac-dest")?.addEventListener("change", (e) => { model.setActionDest(x.id, e.target.value); drawEdges(); autosave(null); });
    // manual fire: run the action NOW on its target dataset(s) via the same funnel a trigger uses.
    // Transient feedback by swapping the button label (no progress line on the node).
    $(".ac-fire")?.addEventListener("click", async (e) => {
        const btn = e.currentTarget; btn.disabled = true; btn.textContent = "firing…";
        try { const r = await api.actions.fire(model.profile.name, x.id); btn.textContent = r.ran ? "fired ✓" : "no-op"; refreshLive(); }
        catch (err) { btn.textContent = String(err.message || err); }
        finally { setTimeout(() => { btn.textContent = "↻ fire"; btn.disabled = false; }, 1500); }
    });
}

// ---- register node: hold wired readouts' live values in an in-memory keyed map --------

function wireRegister(div, n) {
    const x = n.ref;
    const $ = (sel) => div.querySelector(sel);
    $(".regrename")?.addEventListener("change", (e) => {
        const oldId = x.id;
        renameNode(e.target, oldId,
            () => model.renameRegister(oldId, (e.target.value || "").trim()),
            () => movePos(`register:${oldId}`, `register:${x.id}`),
            () => { render(); autosave(null); });
    });
    // readout source chips: add via the "+ readout" select, remove via each chip's trash. Rebuild so
    // the chips + edges follow; the readout out-port drag hits the SAME model.addRegisterSource path.
    $(".reg-addsrc")?.addEventListener("change", (e) => { if (model.addRegisterSource(x.id, e.target.value)) { rebuildNode(n.id); drawEdges(); autosave(null); } });
    wireArmedRemove(div, ".reg-rmsrc", (val) => { model.removeRegisterSource(x.id, val); rebuildNode(n.id); drawEdges(); autosave(null); });
    // clear the held map server-side (armed two-click, no blocking dialog). Values live only in the
    // running session, so this just empties that map; the table repopulates as readouts are read.
    const clearBtn = $(".regclear");
    clearBtn?.addEventListener("click", async () => {
        if (clearBtn.dataset.armed !== "1") {
            clearBtn.dataset.armed = "1"; clearBtn.textContent = "confirm?";
            setTimeout(() => { clearBtn.dataset.armed = "0"; clearBtn.textContent = "clear data"; }, 2500);
            return;
        }
        clearBtn.dataset.armed = "0"; clearBtn.textContent = "clear data";
        try {
            await withBusy([n.id], () => api.clearRegister(model.profile.name, x.id));
            refreshRegister(x.id);
            setStatus(`cleared ${x.id}`);
        } catch (e) { setStatus(String(e.message || e)); }
    });
    // show the persisted map immediately on (re)build — a page load with a running/prior session
    // has data even before the next heartbeat tick.
    queueMicrotask(() => refreshRegister(x.id));
}

// ---- file-source node: parse a game log/config file into its dataset --------

function wireSource(div, n) {
    const s = n.ref;
    const $ = (sel) => div.querySelector(sel);

    // The parse preview now lives in the source's opt-in data-table satellite (vt:src:<id>), not the
    // node body — edits refresh it through refreshSourcePreview (a no-op when the satellite is hidden,
    // so a closed table costs nothing). Edit-driven + debounced — NEVER a poll/timer (steady-state-
    // zero-DOM rule); the only redraws are user edits. The satellite's own build kicks the first read.
    let pvTimer = null;
    const schedulePreview = () => { clearTimeout(pvTimer); pvTimer = setTimeout(() => refreshSourcePreview(s.id), 300); };

    $(".srcrename")?.addEventListener("change", (e) => {
        const oldId = s.id;
        renameNode(e.target, oldId,
            () => model.renameFileSource(oldId, (e.target.value || "").trim()),
            () => movePos(`src:${oldId}`, `src:${s.id}`),
            () => { render(); autosave(null); });
    });
    // format/watch swap the body (extraction UI / throttle / tail) -> rebuild then re-preview
    $(".src-format")?.addEventListener("change", (e) => { model.setSourceFormat(s.id, e.target.value); rebuildNode(n.id); autosave(null); });
    $(".src-watch")?.addEventListener("change", (e) => { model.setSourceProp(s.id, "watch", e.target.value); rebuildNode(n.id); autosave(null); });
    // plain edits: store + preview, no rebuild (keep input focus)
    $(".src-filename")?.addEventListener("change", (e) => { model.setSourceProp(s.id, "filename", e.target.value); autosave(null); schedulePreview(); });
    $(".src-path")?.addEventListener("change", (e) => { model.setSourceProp(s.id, "path", e.target.value); autosave(null); schedulePreview(); });
    $(".src-throttle")?.addEventListener("change", (e) => { model.setSourceProp(s.id, "throttle_s", e.target.value); autosave(null); });
    // slide toggles are native checkboxes now — the new state is `.checked` after the change event
    const flipSlide = (e) => { e.stopPropagation(); return e.currentTarget.checked; };
    // tail on/off rebuilds the node so the "tail lines" count input shows/hides with it
    $(".src-tail")?.addEventListener("change", (e) => { model.setSourceProp(s.id, "tail", flipSlide(e)); rebuildNode(n.id); autosave(null); schedulePreview(); });
    $(".src-taillines")?.addEventListener("change", (e) => {
        const v = parseInt(e.target.value, 10);
        model.setSourceProp(s.id, "tail_lines", Number.isNaN(v) || v < 1 ? 1 : v);
        autosave(null); schedulePreview();
    });
    $(".src-linepos")?.addEventListener("change", (e) => { model.setSourceProp(s.id, "line_position", flipSlide(e)); autosave(null); });

    // line filters (match clauses). add/remove change the parse output, so they refresh the preview
    // too — not just the inline edits below (the bug was removals leaving the preview stale).
    $(".src-addm")?.addEventListener("click", () => { model.addSourceMatch(s.id); rebuildNode(n.id); autosave(null); schedulePreview(); });
    div.querySelectorAll(".src-rmm").forEach((b) => b.addEventListener("click", () => { model.removeSourceMatch(s.id, +b.dataset.i); rebuildNode(n.id); autosave(null); schedulePreview(); }));
    div.querySelectorAll(".mset").forEach((inp) => inp.addEventListener("change", (e) => {
        model.setSourceMatch(s.id, +e.target.dataset.i, e.target.dataset.k,
            e.target.type === "checkbox" ? e.target.checked : e.target.value);
        autosave(null); schedulePreview();
    }));

    // extraction fields. add/remove change which columns the parse emits -> refresh the preview too.
    $(".src-addf")?.addEventListener("click", () => { model.addSourceField(s.id); rebuildNode(n.id); autosave(null); schedulePreview(); });
    div.querySelectorAll(".src-rmf").forEach((b) => b.addEventListener("click", () => { model.removeSourceField(s.id, +b.dataset.i); rebuildNode(n.id); autosave(null); schedulePreview(); }));
    div.querySelectorAll(".fset2").forEach((inp) => inp.addEventListener("change", (e) => {
        const k = e.target.dataset.k;
        model.setSourceFieldProp(s.id, +e.target.dataset.i, k,
            e.target.type === "checkbox" ? e.target.checked : e.target.value);
        if (k === "method") { rebuildNode(n.id); autosave(null); schedulePreview(); }   // method swaps its own inputs + changes the parse
        else { autosave(null); schedulePreview(); }
    }));
    // show the ␣ flag live while a delimiter holds a whitespace-only value (else it looks empty)
    div.querySelectorAll(".src-delim").forEach((inp) => inp.addEventListener("input", (e) => {
        const ws = e.target.value.length > 0 && e.target.value.trim() === "";
        e.target.closest(".src-delim-wrap")?.classList.toggle("has-ws", ws);
    }));
    // per-field "required" gn-slide — flips whether an invalid value dismisses the row; re-preview
    div.querySelectorAll(".src-req").forEach((tog) => tog.addEventListener("change", (e) => {
        const on = flipSlide(e);
        model.setSourceFieldProp(s.id, +e.currentTarget.dataset.i, "required", on);
        autosave(null); schedulePreview();
    }));

    // auto-find the file across generic OS locations — opens a modal that runs the search,
    // lists hits, previews a clicked file's contents, and pins the chosen one as the path.
    $(".src-find")?.addEventListener("click", () => openFindModal($, s, schedulePreview));
    // read the file now (writes to the dataset). The read runs in the BACKGROUND server-side (a big
    // log can take many seconds) — the request returns at once and the rows stream into the dataset
    // live via the change bus, so there's nothing to spin on or cancel here. Progress goes to the
    // log bar (the node carries no progress strip anymore), so it reads alongside every other event.
    $(".src-read")?.addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        try {
            const r = await api.sources.read(model.profile.name, s.id);
            log(r.busy ? `${s.id}: already reading…`
                : `${s.id}: reading → ${s.dataset || "(no dataset)"}, rows fill in live`, r.busy ? "warn" : "run");
        } catch (err) {
            log(`${s.id}: ${err.message || err}`, "err");
        } finally {
            btn.disabled = false;
        }
    });
    // "auto-resolve" inspects the file's data and proposes extraction columns the user then refines
    $(".src-resolve")?.addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        const done = timed(`${s.id}: auto-resolve`);
        try {
            const r = await api.sources.resolve(model.profile.name, s);
            const fields = r.fields || [];
            const added = model.mergeSourceFields(s.id, fields);   // append-only: never drops existing fields
            if (!added) { done(`(${fields.length ? "nothing new" : (r.note || "no columns found")})`, "warn"); return; }
            rebuildNode(n.id); autosave(null);
            done(`(+${added} field${added === 1 ? "" : "s"})`, "ok");
            showSatellite(`vt:src:${s.id}`); refreshSourcePreview(s.id);
        } catch (err) {
            done(String(err.message || err), "err");
        } finally {
            btn.disabled = false;
        }
    });
}

// Refresh a file source's parse-preview satellite (vt:src:<id>): re-run the live preview and render
// its rows + count line into the satellite. A no-op when the satellite is hidden (no node to fill).
// singleFlight per source so a burst of edits coalesces and the LATEST request wins (never dropped).
function refreshSourcePreview(id) { singleFlight(`srcpv:${id}`, () => _refreshSourcePreview(id)); }
// ONE preview fetch feeds BOTH satellites: vt:src (kept rows) and vtd:src (rows a required field
// dismissed). Either may be hidden — we just skip the missing host. No-op when neither is shown.
async function _refreshSourcePreview(id) {
    const kept = nodeEls.get(`vt:src:${id}`);
    const dism = nodeEls.get(`vtd:src:${id}`);
    if ((!kept && !dism) || !model.profile.name) return;
    const s = model.fileSource(id);
    if (!s) return;
    // render one satellite's host from a row list + a meta line
    const fill = (node, vtId, rows, meta, empty) => {
        if (!node) return;
        const host = node.querySelector(".src-host"), info = node.querySelector(".src-prev-info");
        if (!host) return;
        if (rows.length) renderPreview(host, rows);
        else host.replaceChildren(h("p", { class: "muted", style: "padding:8px" }, empty));
        if (info) info.textContent = meta;
    };
    if (kept) setNodeBusy(`vt:src:${id}`, true);
    if (dism) setNodeBusy(`vtd:src:${id}`, true);
    try {
        const r = await api.sources.preview(model.profile.name, s);
        const rows = r.rows || [], dropped = r.dismissed || [];
        const le = r.line_ending ? ` · ${r.line_ending}` : "";
        const noFile = r.path === null && !rows.length && !dropped.length;
        fill(kept, `vt:src:${id}`, rows,
            noFile ? (r.note || "file not found") : `${r.matched} row(s) · ${r.total} line(s)${le}`,
            r.note || "no rows");
        fill(dism, `vtd:src:${id}`, dropped,
            noFile ? (r.note || "file not found") : `${r.dismissed_count ?? dropped.length} dismissed · ${r.total} line(s)${le}`,
            "no dismissed rows — every matched line passed its required fields");
    } catch (e) {
        const msg = String(e.message || e);
        for (const node of [kept, dism]) if (node) {
            const host = node.querySelector(".src-host"), info = node.querySelector(".src-prev-info");
            if (info) info.textContent = msg;
            host?.replaceChildren(h("p", { class: "muted", style: "padding:8px" }, msg));
        }
    } finally {
        if (kept) setNodeBusy(`vt:src:${id}`, false);
        if (dism) setNodeBusy(`vtd:src:${id}`, false);
    }
}

// Auto-find picker (modal): runs the search, lists hits on the left, previews a clicked file's
// contents on the right, and pins the chosen one as the explicit path. Closing the modal aborts
// the search AND any in-flight content peek (handle.signal + onClose). All user-driven — never a
// poll/tick, so a full rebuild per click is fine.
function openFindModal($, s, schedulePreview) {
    if (!model.profile.name) return;
    const listEl = h("div", { class: "find-list" }, h("div", { class: "find-status muted" }, "searching…"));
    const viewEl = h("div", { class: "find-view" }, h("div", { class: "find-status muted" }, "select a file to preview its contents"));
    const wrap = h("div", { class: "find-modal" }, listEl, viewEl);

    let viewCtl = null;
    const handle = openModal({
        title: `auto-find${s.filename ? ": " + s.filename : ""}`, size: "large",
        node: wrap, onClose: () => viewCtl?.abort(),    // handle.signal aborts find; this aborts the peek
    });

    const choose = (path) => {
        model.setSourceProp(s.id, "path", path);
        const pin = $(".src-path"); if (pin) pin.value = path;
        const found = $(".src-found"); if (found) found.textContent = path;
        autosave(null); schedulePreview();
        handle.close();
    };

    async function showFile(c, btn) {
        listEl.querySelectorAll(".find-item.sel").forEach((x) => x.classList.remove("sel"));
        btn.classList.add("sel");
        viewCtl?.abort(); viewCtl = new AbortController();
        viewEl.replaceChildren(
            h("div", { class: "find-vhead" },
                h("span", { class: "find-vpath" }, c.path),
                h("button", { class: "find-use", onClick: () => choose(c.path) }, "use this file")),
            h("pre", { class: "find-pre muted" }, "loading…"));
        try {
            const r = await api.sources.peek(model.profile.name, c.path, viewCtl.signal);
            const pre = viewEl.querySelector(".find-pre");
            pre.classList.remove("muted");
            pre.textContent = (r.text || "") + (r.truncated ? "\n…(truncated)" : "");
        } catch (e) {
            if (e.name === "AbortError") return;
            const pre = viewEl.querySelector(".find-pre"); if (pre) pre.textContent = String(e.message || e);
        }
    }

    (async () => {
        try {
            const r = await api.sources.find(model.profile.name, { filename: s.filename, roots: s.roots }, handle.signal);
            const cands = r.candidates || [];
            if (!cands.length) { listEl.replaceChildren(h("div", { class: "find-status muted" }, "none found")); return; }
            listEl.replaceChildren(...cands.slice(0, 50).map((c) => {
                const b = h("button", { class: "find-item" },
                    h("span", { class: "find-path" }, c.path),
                    h("span", { class: "find-meta muted" }, `${(c.size / 1024).toFixed(0)} KB · ${since(new Date(c.mtime * 1000).toISOString())}`));
                b.addEventListener("click", () => showFile(c, b));
                return b;
            }));
        } catch (e) {
            if (e.name === "AbortError") return;
            listEl.replaceChildren(h("div", { class: "find-status muted" }, String(e.message || e)));
        }
    })();
}

// small read-only preview table (capped) of the rows the current rules produce. Edit-driven
// (never a steady-state tick), so a full rebuild here is fine.
const SRC_LINE_COL = "__line__";   // preview-only column carrying the raw source line (see sources route)
function renderPreview(host, rows) {
    if (!host) return;
    if (!rows.length) { host.replaceChildren(); return; }
    const cols = [];
    for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
    // show the raw source line FIRST (traces a row back to its file line), with a friendly header
    // and a muted monospace look — it's context, not an extracted field.
    const li = cols.indexOf(SRC_LINE_COL);
    if (li >= 0) { cols.splice(li, 1); cols.unshift(SRC_LINE_COL); }
    const isLine = (c) => c === SRC_LINE_COL;
    const cap = 50;
    host.replaceChildren(h("table", { class: "src-ptab" },
        h("thead", h("tr", cols.map((c) => h("th", { class: isLine(c) ? "src-pline" : "" }, isLine(c) ? "line" : c)))),
        h("tbody", rows.slice(0, cap).map((r) =>
            h("tr", cols.map((c) => h("td", { class: isLine(c) ? "src-pline" : "" }, r[c] == null ? "" : String(r[c]))))))));
}

export const CAN_DISABLE = new Set(["window", "item", "region", "detect", "scrollbar", "dictionary", "producer", "trigger", "filesource", "action"]);
// Denylist, NOT allowlist: every node type is removable EXCEPT these. Inverted on purpose so a new
// functional node type is deletable by default — the recurring bug was forgetting to add each new
// type to an allowlist. Only the profile-root nodes (game, atlas) and toggle-only satellites
// (preview, vttable) are protected here; a satellite is dismissed via its toggle, never "deleted".
const UNREMOVABLE = new Set(["game", "atlas", "preview", "vttable"]);
const isRemovable = (type) => !!type && !UNREMOVABLE.has(type);

// One place to remove any node; each goes through render()+autosave() so undo/redo
// records it (autosave -> pushHistory).
// Per-type removal as data, not a re-copied render/cleanup block: `kill` mutates the model (+ any
// pre-render teardown like closing a live canvas); `after` is the follow-up (autosave variant +
// side effects). The shared render + forgetNodeState (drops every per-id store) + status line run
// ONCE for every type. re-OCR only the affected window (autosave winId) — removing a region/detect/
// scrollbar/item changes THAT window's read, never the others; window-less types pass autosave(null).
function removeNode(n) {
    const win = n.win?.id;
    const PLAN = {
        window:     { kill: () => { closeImage(n.ref.id); model.removeWindow(n.ref.id); }, after: () => autosave(null) },
        item:       { kill: () => { closeItemImage(win, n.ref.id); model.removeItem(win, n.ref.id); clearGrid(win); }, after: () => { refreshImageBoxes(win); autosave(win); } },
        region:     { kill: () => model.removeRegion(win, n.ref.id), after: () => { autosave(win); refreshImageBoxes(win); } },
        readout:   { kill: () => model.removeReadout(win, n.ref.id), after: () => { rebuildReadoutConsumers(); autosave(win); refreshImageBoxes(win); } },
        detect:     { kill: () => model.removeDetect(win, n.ref.id), after: () => { rebuildNode(nodeIdOf(win)); autosave(win); refreshImageBoxes(win); } },
        scrollbar:  { kill: () => model.removeScrollbar(win), after: () => { autosave(win); refreshImageBoxes(win); } },
        itemfield:  { kill: () => model.removeItemField(win, n.item.id, n.ref.id), after: () => itemChanged(win, n.item.id, { reread: true }) },
        itemtell:   { kill: () => model.removeItemTell(win, n.item.id, n.ref.id), after: () => itemChanged(win, n.item.id, { reread: true }) },
        dictionary: { kill: () => model.removeDictionary(n.ref.id), after: () => autosave(null) },
        subset:     { kill: () => model.removeSubset(n.ref.id), after: () => autosave(null) },
        producer:   { kill: () => model.removeProducer(n.ref.id), after: () => autosave(null) },
        trigger:    { kill: () => model.removeTrigger(n.ref.id), after: () => autosave(null) },
        toast:      { kill: () => model.removeToast(n.ref.id), after: () => autosave(null) },
        sound:      { kill: () => model.removeSound(n.ref.id), after: () => autosave(null) },
        action:     { kill: () => model.removeAction(n.ref.id), after: () => autosave(null) },
        register:   { kill: () => model.removeRegister(n.ref.id), after: () => autosave(null) },
        filesource: { kill: () => model.removeFileSource(n.ref.id), after: () => autosave(null) },
        dataset:    { kill: () => { model.removeDataset(n.ref); purgeDatasetData(n.ref); }, after: () => autosave(null) },
    };
    const plan = PLAN[n.type];
    // isRemovable (denylist) let this node through, so a missing PLAN entry is a bug in a NEW node
    // type, not an intentionally-protected node — warn instead of no-opping silently.
    if (!plan) { console.warn(`removeNode: no removal plan for type "${n.type}" (add one to PLAN)`); return; }
    // Every node WIRED to this one shows the link in its own body (a producer's source chip, a
    // subset's input row, a trigger's target/watch chip). render() only BUILDS missing nodes — it
    // never re-fills an existing node — so those connected bodies keep the stale chip after the model
    // ref is cleared. Capture the neighbours from the live edges BEFORE kill, rebuild the survivors
    // AFTER, so a removal updates every connected party, not just the wire.
    const neighbours = neighbourIds(n.id);
    plan.kill();
    render();
    forgetNodeState(n.id);   // drop ALL live state for the gone node (one place — twin of remapNodeState)
    for (const id of neighbours) if (nodeEls.has(id)) rebuildNode(id);
    plan.after();
    setStatus(`deleted ${n.type} ${n.ref?.id ?? n.ref ?? ""}`.trimEnd());
}

// Node ids wired to `id` in EITHER direction, from the current model edges. Caller must read this
// BEFORE mutating the model, while the edges to the doomed node still exist.
function neighbourIds(id) {
    const out = new Set();
    for (const e of model.edges()) {
        if (e.from === id) out.add(e.to);
        else if (e.to === id) out.add(e.from);
    }
    out.delete(id);
    return out;
}

// Purge a dataset's stored files so removing its node doesn't leave it re-spawning from
// disk on the next live refresh. The profile-side feeders (windows/producers/sources) are
// already unwired by model.removeDataset, so the id can't re-derive client- or server-side;
// this just clears the on-disk records that purge-on-delete is for.
async function purgeDatasetData(ds) {
    delete live[ds];
    try { await api.deleteDataset(model.profile.name, ds); }
    catch (e) { setStatus(`delete failed: ${e.message}`); return; }
    await refreshLive();   // re-reads the dataset list (the purged name is gone from disk)
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
    if (n.type === "dataset") div.dataset.ds = n.ref;   // out-port drop target id (tabs moved to the vt-table satellite)
    const parts = nodeParts(n);
    // the enable toggle (gn-enable checkbox) — only on toggleable node types; null otherwise. Its
    // .gn-enable class + `.checked` state are read by the post-build wiring below.
    const toggle = canToggle
        ? slideToggle({ on: enabled, cls: "gn-enable", title: "enabled — turn off to skip this node during detection" })
        : null;
    // delete + detach moved to the selection toolbar (act on the selection); nodes carry
    // neither button anymore — select a node (or several) and use the toolbar.
    const typeLabel = n.type === "itemfield" ? "field"
        : n.type === "itemtell" ? "tell"   // kind now lives in the node's own dropdown, not the tag
        : n.type;
    div.replaceChildren(
        h("div", { class: `gn-h ${parts.pulse || ""}` },
            h("span", { class: "gn-disc", title: "collapse/expand" },
                nodeIcon(n),
                h("button", { class: "collapse", "aria-label": "collapse/expand" },
                    svg("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "aria-hidden": "true" },
                        svg("rect", { x: "3.5", y: "3.5", width: "17", height: "17", rx: "5.5" }),
                        svg("line", { x1: "8", y1: "12", x2: "16", y2: "12" }),
                        svg("line", { class: "cv", x1: "12", y1: "8", x2: "12", y2: "16" })))),
            parts.title, parts.head, toggle,
            RECT_TYPES.has(n.type) ? rectEditBtn() : null,
            h("span", { class: "gn-type", "aria-hidden": "true" }, typeLabel),
            h("span", { class: "gn-pretty-dirty", title: "held by a pretty override — not saved to yaml" }, "pretty"),
            // tiny loader — lives IN the header (not a full-node overlay), shown by .gnode.busy.
            // The body locks (CSS .gnode.busy > .gn-body) while it spins.
            h("span", { class: "gn-hspin", title: "working…" })),
        // body is ONE two-column grid (`.gn-grid`) — every builder emits flat wrapped-label +
        // control children into it (rule 7: one body layout). Action buttons live in the
        // separate `.gn-foot` slot below (parts.foot), never inside the body grid.
        h("div", { class: "gn-body" }, h("div", { class: "gn-grid" }, parts.body)),
        // spread so a missing foot contributes NOTHING — replaceChildren stringifies a bare
        // `null` arg into a "null" text node (unlike h(), which skips it).
        ...(parts.foot ? [h("div", { class: "gn-foot" }, parts.foot)] : []),
        ...(parts.ports ? [parts.ports] : []));   // vttable nodes have no ports — replaceChildren would stringify undefined to a "undefined" text node
    div.querySelector(".collapse").addEventListener("click", () => toggleCollapse(n.id));
    const tog = div.querySelector(".gn-enable");
    tog?.addEventListener("change", (e) => {
        e.stopPropagation();
        const on = e.currentTarget.checked;   // native checkbox state
        n.ref.enabled = on;
        div.classList.toggle("node-disabled", !on);
        const winId = n.type === "window" ? n.ref.id : n.win?.id;
        if (winId) { clearGrid(winId); refreshImageBoxes(winId); }
        // a toggled detector changes the owner's detects section (its row greys / un-greys, and
        // the game gate's enabled count) — rebuild that section; autosave (below) re-runs detect
        // for the verdict on the SAME shared settle clock (scheduleWindowRead), so this doesn't
        // also fire an immediate, un-coalesced detect of its own.
        if (n.type === "detect" && winId) rebuildNode(nodeIdOf(winId));
        autosave(winId);   // window id (or undefined for data-plane) -> scoped; re-fires only on enable
    });
    // satellite show/hide (preview on a window; vt-table on a dataset/subset) — one handler for
    // every node that carries the head button. Toggling rebuilds the graph so the follower node +
    // its dotted edge appear/disappear; a freshly shown one is parked just right of its parent.
    // a node may carry MORE than one satellite toggle (a file source has preview + dismissed) —
    // wire every one, not just the first.
    div.querySelectorAll(".gn-sat-tog").forEach((tog) => tog.addEventListener("click", (e) => {
        e.stopPropagation();
        const btn = e.currentTarget;
        const on = model.toggleSatellite(btn.dataset.sat);
        paintSatToggle(btn, on);   // render() keeps existing node DOM, so flip the button by hand
        applySatellite(btn.dataset.sat, on);
        // opening a preview satellite = the setup changed -> read the window's bound image now,
        // instead of waiting for the next picture change / edit (it used to sit on the placeholder)
        if (on && btn.dataset.sat.startsWith("prev:")) scheduleWindowRead(btn.dataset.sat.slice(5));
    }));
    // rect-edit toggle: reveals typed x/y/w/h for this node's box (imaging.js owns the open/
    // apply/cancel transaction — one editor open at a time, synced with the canvas it draws on).
    div.querySelector(".gn-rectbtn")?.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleRectEditor(div, n);
    });
    // wired-source chip pills (sv-input, sources_input.js): click the pill BODY (not its trash)
    // to pan+zoom the canvas to the source node it represents — one generic handler for every
    // node's sources-input lists (rule 7), since the behaviour never varies by list. The
    // mousedown stopPropagation keeps this click from also selecting the HOST node (a pill lives
    // in `.gn-body`, which the drag/select handler below would otherwise treat as node content).
    div.querySelectorAll(".sv-input[data-node]").forEach((pill) => {
        pill.addEventListener("mousedown", (e) => { if (!e.target.closest(".sv-rmin")) e.stopPropagation(); });
        pill.addEventListener("click", (e) => { if (!e.target.closest(".sv-rmin")) panZoomTo(pill.dataset.node); });
    });
    if (busy.get(n.id)) {   // preserve spinner + keyboard lock across rebuilds (fillNode just built a fresh .gn-body)
        div.classList.add("busy");
        const body = div.querySelector(".gn-body");
        if (body) body.inert = true;
    }
    if (!wire) return;   // measurement probe: skip side-effecting wiring (openImage, out-port drag)
    wireNode(div, n);
    wireOutPort(div, n);   // any node with a `.port.out` drags to a dataset — one mechanism
}

// Drag a node's out-port to wire its data somewhere. ONE mechanism for every source type;
// each type contributes a `spec` describing what kind of node it drops onto (`target`),
// what committing the drop does (`onDrop(targetId)`), and what an empty-canvas drop mints
// (`onEmpty(worldPt) -> newNodeId`). Producers (window/price) feed a DATASET; datasets and
// subsets feed a SUBSET. `selfId` blocks dropping a node onto itself.
// onDrop/onEmpty are PURE model mutations — startWire's onUp rebuilds both the source and the
// drop-target node itself after calling these, so no spec here needs its own rebuildNode.
function outPortSpec(n) {
    switch (n.type) {
        case "window": return {
            target: "dataset",
            onDrop: (ds) => model.setDataset(n.ref.id, ds),
            onEmpty: (pt) => { const ds = model.addDataset(); placeAt(`ds:${ds}`, pt); model.setDataset(n.ref.id, ds); return `ds:${ds}`; },
        };
        case "producer": return {
            target: "dataset",
            onDrop: (ds) => model.setProducerDataset(n.ref.id, ds),
            onEmpty: (pt) => { const ds = model.addDataset(); placeAt(`ds:${ds}`, pt); model.setProducerDataset(n.ref.id, ds); return `ds:${ds}`; },
        };
        case "dataset": return {
            // a dataset feeds a SUBSET (join), a PRODUCER node (price only these items), a
            // DICTIONARY (push its column values in as terms), or a TOAST ({{dataset:id}} tokens)
            target: ["subset", "producer", "dictionary", "toast"],
            onDrop: (id, ttype) => {
                if (ttype === "producer") model.addProducerSource(id, n.ref);
                else if (ttype === "dictionary") model.addDictFeed(id, n.ref);
                else if (ttype === "toast") model.addToastSource(id, `dataset:${n.ref}`);
                else model.addSubsetInput(id, n.ref);
            },
            onEmpty: (pt) => { const id = model.addSubset(n.ref); placeAt(`sub:${id}`, pt); return `sub:${id}`; },
        };
        case "subset": return {
            // a subset feeds another SUBSET, a PRODUCER node (price the rows it returns), or a
            // TOAST ({{subset:id}} tokens)
            target: ["subset", "producer", "toast"],
            selfId: n.ref.id,
            onDrop: (id, ttype) => {
                if (ttype === "producer") model.addProducerSource(id, n.ref.id);
                else if (ttype === "toast") model.addToastSource(id, `subset:${n.ref.id}`);
                else model.addSubsetInput(id, n.ref.id);
            },
            onEmpty: (pt) => { const id = model.addSubset(n.ref.id); placeAt(`sub:${id}`, pt); return `sub:${id}`; },
        };
        case "readout": return {
            // a readout feeds a TOAST its live value as a {{readout:id}} token, or a REGISTER that
            // holds its latest value in an in-memory keyed map
            target: ["toast", "register"],
            onDrop: (id, ttype) => {
                const ref = `readout:${n.ref.id}`;
                if (ttype === "register") model.addRegisterSource(id, ref);
                else model.addToastSource(id, ref);
            },
            onEmpty: (pt) => { const id = model.addRegister(); model.addRegisterSource(id, `readout:${n.ref.id}`); placeAt(`register:${id}`, pt); return `register:${id}`; },
        };
        case "register": return {
            // a register OPTIONALLY mirrors its held map into a DATASET too (RegisterDef.persist),
            // so that state becomes joinable/excludable like any other dataset — same wiring shape
            // as window/producer/filesource -> dataset.
            target: "dataset",
            onDrop: (ds) => model.setRegisterPersist(n.ref.id, ds),
            onEmpty: (pt) => { const ds = model.addDataset(); placeAt(`ds:${ds}`, pt); model.setRegisterPersist(n.ref.id, ds); return `ds:${ds}`; },
        };
        case "filesource": return {
            target: "dataset",
            onDrop: (ds) => model.setSourceDataset(n.ref.id, ds),
            onEmpty: (pt) => { const ds = model.addDataset(); placeAt(`ds:${ds}`, pt); model.setSourceDataset(n.ref.id, ds); return `ds:${ds}`; },
        };
        case "trigger": return {
            // a trigger fires a PRODUCER (sweep), FILE SOURCE (read), TOAST (notify), SOUND (play), or ACTION (dataset op)
            target: ["producer", "filesource", "toast", "sound", "action"],
            onDrop: (pid) => model.addTriggerTarget(n.ref.id, pid),
        };
        case "action": return {
            // an action node operates on the DATASET(s) it's wired to
            target: "dataset",
            onDrop: (ds) => model.addActionDataset(n.ref.id, ds),
        };
        default: return null;
    }
}

// The trigger's SECOND out-port (`.port.pwatch`, left face): drag to a dataset/view to make an
// on_change trigger watch it. Separate from the fires port so the two control lines never share a dot.
function watchPortSpec(n) {
    if (n.type !== "trigger") return null;
    if (n.ref.kind === "on_change") return {
        side: "L",
        target: ["dataset", "subset"],
        onDrop: (id) => model.addTriggerWatch(n.ref.id, id),
    };
    if (n.ref.kind === "on_readout") return {
        side: "L",
        target: ["readout"],
        // the dropped id is the readout NODE id (ro:<win>:<vid>) — the watch stores the bare vid
        onDrop: (id) => model.addTriggerReadoutWatch(n.ref.id, String(id).split(":").pop()),
    };
    return null;
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

// Park a freshly-shown satellite (preview / vt-table) just to the right of its parent, unless it
// already has a saved slot. Only sets pos when the parent is laid out; otherwise ensurePositions
// falls back to the type's COLX column.
function placeSatelliteNear(satId) {
    if (pos.has(satId)) return;
    const r = nodeRect(model.satelliteParent(satId));
    if (r) placeAt(satId, { x: r.x + r.w + 60, y: r.y });
}

// Update a satellite-toggle button's look to match its on/off state (render() leaves the parent
// node's DOM in place, so the button is flipped by hand).
function paintSatToggle(btn, on) {
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-pressed", on);
    const t = `${on ? "hide" : "show"} ${btn.dataset.sat.startsWith("prev:") ? "preview" : "data table"}`;
    btn.title = t; btn.setAttribute("aria-label", t);
}

// Apply a satellite's new visibility: (re)build the graph so the follower node + its dotted edge
// appear/disappear, seat it in its parent's group/subgroup, and persist (layout sidecar only).
function applySatellite(satId, on) {
    if (on) placeSatelliteNear(satId);          // set pos BEFORE render so ensurePositions keeps it
    else groups.forgetNodes(new Set([satId]));  // hidden -> drop it from any group/subgroup (no stale member id)
    render();
    if (on) groups.reflowFollowers();           // shown -> seat it in its parent's group/subgroup
    persist.layout();   // satellite visibility rides the layout sidecar, never the yaml
}

// Ensure a satellite is shown (no-op if already), syncing its parent's toggle button. Used by
// flows that need the satellite present to render into it (e.g. the image's "preview all").
export function showSatellite(satId) {
    if (model.satelliteOn(satId)) return;
    model.toggleSatellite(satId);
    // pick THIS satellite's toggle by id — a node can carry several (file source: preview + dismissed)
    const btn = nodeEls.get(model.satelliteParent(satId))?.querySelector(`.gn-sat-tog[data-sat="${satId}"]`);
    if (btn) paintSatToggle(btn, true);
    applySatellite(satId, true);
}

// the source id a drop target commits to: a dataset node's name, or a node's bare id
// (subset/price/trigger carry a prefixed node id in data-id).
function targetIdOf(el, target) {
    return target === "dataset" ? el.dataset.ds : (el.dataset.id || "").replace(/^(sub|producer|trigger|src|dict|toast|sound|register):/, "");
}

// Host node types that resize at the NODE level (their body fills them) — one consistent
// behaviour. Used by the initial build AND by rebuildNode to re-attach grips.
// Every node is freely resizable (width + height) EXCEPT item, which resizes width-only
// (its height follows the cutout aspect). item is special-cased in buildNode.

// Resize-handle opts shared by the initial build and every in-place rebuild. The grips live
// inside the node's DOM, so a rebuildNode() (which replaces the node's children via fillNode)
// WIPES them — they must be re-added with these same opts or the node stops resizing.
// `widthOnly`: item + window nodes wrap a FIXED-ASPECT canvas (cutout / captured image), so
// they resize by WIDTH only — height follows the image aspect. Same primitive, one flag; never
// a separate resize path (their size persists through nodeSizes like every other node).
// Size a freely-resizable node to a grid target (w×h) WITHOUT a hard width/height where it can be
// avoided. GROW (target ≥ natural box): a soft `min-width`/`min-height` opens the box out to the
// grid line — the content keeps its natural size and the flex body fills the extra room (breathing
// space), so nothing is locked to a stamped pixel box. SHRINK (target < natural): the content can't
// be squeezed, so set a hard width/height and the flex body SCROLLS (never clips). Clears any prior
// inline size first so the natural box (CSS min-width respected) is what's measured. After it runs,
// offsetWidth/Height land on the grid, so snapResize's live-snap sees no gap and doesn't fight it.
// Soft-grow / hard-shrink for ONE axis. Caller must have already cleared THIS axis's inline
// size + min so `el.offset*` reads the natural box. GROW (target ≥ natural) -> soft min (content
// fills the extra room); SHRINK -> hard size (body scrolls). Returns true=soft, false=hard.
// The single primitive both the drag-settle (settleAxis) and keyboard nudge build on (rule 7).
function sizeAxisToGrid(el, axis, target) {
    const nat = axis === "w" ? el.offsetWidth : el.offsetHeight;   // natural (this axis already cleared)
    if (target >= nat) { el.style[axis === "w" ? "minWidth" : "minHeight"] = `${target}px`; return true; }
    el.style[axis === "w" ? "width" : "height"] = `${target}px`; return false;
}
// Settle ONE axis on grip release: clear the axis to expose its natural (grid-fit) size, then only
// STAMP a size when the target DIFFERS from it, reusing sizeAxisToGrid for the grow(min)/shrink(hard)
// decision. Landing exactly on natural leaves the axis UNSTAMPED: nothing to record, no reset dot, so
// a drag back to the fit size is as if the axis was never sized. Returns { size, soft, cust }.
function settleAxis(el, axis, target) {
    el.style[axis === "w" ? "width" : "height"] = ""; el.style[axis === "w" ? "minWidth" : "minHeight"] = "";
    const nat = snapUp(axis === "w" ? el.offsetWidth : el.offsetHeight);   // grid-fit size at content
    if (target === nat) return { size: nat, soft: true, cust: false };     // exactly natural -> leave cleared
    return { size: target, soft: sizeAxisToGrid(el, axis, target), cust: true };
}
// Settle both axes (targets captured BEFORE any clear — clearing width reflows height).
function settleGridSize(el, wTarget, hTarget) {
    return { w: settleAxis(el, "w", wTarget), h: settleAxis(el, "h", hTarget) };
}
// One-axis keyboard nudge: clear THIS axis (so the natural box is re-measured) WITHOUT touching
// the other axis, then re-apply through the same soft/hard rule. A naive style.width set silently
// no-ops when a prior grow left a min-width ≥ the target — clearing it first is the whole fix.
function nudgeAxisToGrid(el, axis, target) {
    if (axis === "w") { el.style.width = ""; el.style.minWidth = ""; }
    else { el.style.height = ""; el.style.minHeight = ""; }
    return sizeAxisToGrid(el, axis, target);
}
// Re-apply a size decision recorded by settleAxis/resetNodeAxis WITHOUT re-measuring the natural box.
// Restore must be deterministic: re-measuring (as the settle path does) can drift a hair (scrollbar /
// font reflow) and flip a soft-grow dim into the hard-shrink branch — which is exactly what left a
// reset source node hard-sized + scrollable after a later full render() / page reload. `soft*` !==
// false means a min (grow, content always fits); false means a hard size (shrink, body scrolls).
function applySavedSize(el, s) {
    clearGridSize(el);
    // only re-stamp an axis the user actually customized — a natural axis (custW/H === false) stays
    // unstamped so it flows to content, matching what onSettle stored. Legacy entries lack the flags
    // (undefined) -> stamp, preserving old behaviour.
    if (s.w && s.custW !== false) { if (s.softW !== false) el.style.minWidth = `${s.w}px`; else el.style.width = `${s.w}px`; }
    if (s.h && s.custH !== false) { if (s.softH !== false) el.style.minHeight = `${s.h}px`; else el.style.height = `${s.h}px`; }
}
// drop all inline grid sizing (back to the natural box: CSS width + content height)
function clearGridSize(el) { el.style.width = ""; el.style.height = ""; el.style.minWidth = ""; el.style.minHeight = ""; }
// The box size that fits the node's content with NO scroll in EITHER axis. offsetWidth/Height alone
// isn't enough: the body clips wide content into a HORIZONTAL scroll (the node's CSS width is fixed,
// so content wider than it overflows rather than widening the box). Add back whatever the body can't
// currently show, so a reset can size the node to actually contain its content.
function naturalBox(el) {
    const body = el.querySelector(".gn-body");
    const hOver = body ? Math.max(0, body.scrollWidth - body.clientWidth) : 0;
    const vOver = body ? Math.max(0, body.scrollHeight - body.clientHeight) : 0;
    return { w: el.offsetWidth + hOver, h: el.offsetHeight + vOver };
}

function nodeResizeOpts(div, id, { widthOnly = false } = {}) {
    return {
        both: !widthOnly,
        zoom: () => view.zoom,
        // left-edge accessor: the node's world x lives in `pos` (canvas-zoomed) — lets the
        // shared bottom-left grip resize this node leftward with its right edge anchored
        left: (v) => { const p = pos.get(id); if (v === undefined) return p ? p.x : 0; if (p) { p.x = v; positionNode(id); } },
        // A resize moves a node's geometry exactly like a drag does, so it MUST get the SAME line
        // treatment — freeze the routed paths (greying any whose endpoint floats off the resized
        // edge) and re-route ONCE on settle — not a live A* reroute every frame (the forked path
        // that made resize wiggle differently from a drag). These callbacks fire ONLY from the grip
        // loop (a real user drag); a programmatic resize (reset/refit) never enters this path, and the
        // node-level ResizeObserver (snapResize) only repaints edges — it never freezes or snaps.
        // resize START: freeze the CURRENT rendered size (which may be held by a soft min) into a
        // hard px box, THEN drop the mins. Capturing the size before clearing the mins is the whole
        // point — clear-then-measure would already have collapsed the node to content. This makes the
        // drag start exactly where the node sits, so it no longer jumps + desyncs from the cursor.
        onResizeStart: () => {
            const w = div.offsetWidth, h = div.offsetHeight;
            div.style.minWidth = ""; div.style.minHeight = "";
            div.style.width = `${w}px`;
            if (!widthOnly) div.style.height = `${h}px`;
            // freeze line routing for THIS node up front — exactly like a node drag does at its start
            // (moveNodes -> setDraggingNodes). Doing it here, not lazily in onResize, means the very
            // first redraw greys this node's out-edges before the pointer has moved (rule 7: same as drag).
            setDraggingNodes(true, [id]); requestEdges();
            // The live drag is SMOOTH (no grid step, no glide) — easing width/height while the pointer
            // drags the grip makes the dragged edge lag the cursor (felt like the resize "resisted").
            // Grid snap happens exactly once, on release (onSettle). WASD/move keep their glide.
        },
        // Fires only from the grip loop (a live user drag). Keep the soft grid mins cleared so a
        // prior grow's min-width/height can't block a shrink, and freeze routing like a node drag.
        onResize: () => { div.style.minWidth = ""; div.style.minHeight = ""; setDraggingNodes(true, [id]); requestEdges(); groups.renderGroups(); },
        // Settle to the grid, but only KEEP a size on an axis that ends up different from its natural
        // (grid-fit) box — an axis dragged back to natural is left unstamped and un-customized, so it
        // shows no reset dot; a node natural on BOTH axes drops its entry entirely (as if never sized).
        // widthOnly nodes (item/window) wrap a fixed-aspect canvas — width only, height aspect-driven.
        // The grip loop fires this ONCE on release (passing {w,h} moved flags we don't need — it
        // settles both axes idempotently regardless).
        onSettle: () => {
            if (widthOnly) {
                const wTarget = snapUp(div.offsetWidth);   // quantize to the grid once, on release
                div.style.width = ""; div.style.minWidth = "";
                const natW = div.offsetWidth;
                if (Math.abs(wTarget - natW) < 1) nodeSizes.delete(id);   // back at natural -> unstamped
                else { div.style.width = `${wTarget}px`; nodeSizes.set(id, { w: wTarget, h: div.offsetHeight, softW: false, softH: false, custW: true, custH: false }); }
            } else {
                const { w, h } = settleGridSize(div, snapUp(div.offsetWidth), snapUp(div.offsetHeight));
                if (w.cust || h.cust) nodeSizes.set(id, { w: w.size, h: h.size, softW: w.soft, softH: h.soft, custW: w.cust, custH: h.cust });
                else nodeSizes.delete(id);   // natural on both axes -> as if never sized
            }
            markNodeSized(div, id); setDraggingNodes(false); flushEdges(); groups.renderGroups(); persist.layout();
        },
        // reset dots (one per axis): drop the user's size on THAT axis, then snap the node's NATURAL
        // size UP to the grid using a soft min set DIRECTLY (not via the settle path). snapUp always
        // rounds UP, so the min is always ≥ the natural box — the box only grows to the grid line, so
        // content ALWAYS fits (never scrollable) and there's never a hard width/height. Setting the min
        // straight from this one measurement avoids re-measuring the natural box — a second
        // measurement can drift (scrollbar/reflow) and wrongly pick the hard-shrink branch, which is what
        // left a reset source node hard-sized and scrollable. Pre-snapping here also stops a later event
        // (e.g. unfocusing an input) from grid-snapping + jumping the node. Each callback touches only its
        // own axis, keeping the other's user size; Shift-click (handled in addResizeGrips) fires both.
        onResetW: () => resetNodeAxis(div, id, "w", widthOnly),
        // widthOnly nodes (item/window) have an aspect-driven height that's never stamped inline —
        // there's nothing to reset, so they get no height dot.
        onResetH: widthOnly ? null : () => resetNodeAxis(div, id, "h", false),
    };
}

// Reset ONE axis of a node back to its content-fitting, grid-snapped soft min (see onResetW/onResetH).
// Clears only that axis's inline sizing so the other axis keeps the user's size, then merges the new
// dim into the recorded nodeSizes so a later render()/reload restores it deterministically.
function resetNodeAxis(div, id, axis, widthOnly) {
    if (axis === "w") { div.style.width = ""; div.style.minWidth = ""; }
    else { div.style.height = ""; div.style.minHeight = ""; }
    const nb = naturalBox(div);   // size to CONTENT (incl. overflow), not the clipped box
    const s = nodeSizes.get(id) || {};
    if (axis === "w") {
        const w = snapUp(nb.w);
        div.style.minWidth = `${w}px`;
        if (widthOnly) div.style.width = `${w}px`;   // item/window keep a hard inline width
        s.w = w; s.softW = true; s.custW = false;   // back at natural -> nothing left to reset (hide the dot)
    } else {
        const h = snapUp(nb.h);
        div.style.minHeight = `${h}px`;
        s.h = h; s.softH = true; s.custH = false;   // soft min (grow to grid) -> restore re-applies as min, never hard
    }
    nodeSizes.set(id, s);
    markNodeSized(div, id);
    drawEdges(); groups.renderGroups(); persist.layout();
}

// Reveal each axis's reset control only when that axis carries a user-set size a reset would undo,
// driven by the nodeSizes entry's custW/custH (set true by a grip/keyboard resize of that axis,
// cleared by resetNodeAxis). Legacy/loaded entries may lack the flags (undefined) -> treated as set
// so nothing regresses until the user next touches the node. Also owns the whole-node has-size gate,
// so every has-size toggle site funnels through this one helper (rule 7).
function markNodeSized(el, id) {
    const s = nodeSizes.get(id);
    const sized = !!s && !collapsed.has(id);
    el.classList.toggle("has-size", sized);
    el.classList.toggle("rz-has-w", sized && s.custW !== false);
    el.classList.toggle("rz-has-h", sized && s.custH !== false);
}

// Make a node user-resizable: restore its saved size, then attach the grips (NODE itself, its
// body fills it). Restores + persists through nodeSizes — grid-snapped on release — so a
// rebuild, RENAME (render() destroys + rebuilds; movePos carries nodeSizes to the new id), or
// reload all keep the user's size. `widthOnly` (item/window) restores width only; height is
// aspect-driven, so it's never stamped inline.
function makeNodeResizable(div, id, { widthOnly = false } = {}) {
    const s = nodeSizes.get(id);
    // a collapsed node is header-only (CSS) — never stamp its saved w/h, or it beats the collapsed
    // CSS and renders full-height while "collapsed". widthOnly nodes (item/window) keep a hard inline
    // width (their height is aspect-driven); every other node restores its saved size via the RECORDED
    // soft/hard decision (applySavedSize), NOT by re-measuring — re-measuring can drift a soft-grow
    // dim into a hard-shrink one, which scrolled a reset node after a render/reload (the repeat bug).
    if (s && !collapsed.has(id)) {
        if (widthOnly) { if (s.w && s.custW !== false) div.style.width = `${s.w}px`; }
        else applySavedSize(div, s);
    }
    snapResize(div, nodeResizeOpts(div, id, { widthOnly }));
}

// Re-apply saved node SIZES to already-rendered nodes — render() re-applies position every pass
// but size is stamped only at buildNode, so an undo/redo (which rewrites `nodeSizes` via
// hydrateNodeLayout) wouldn't otherwise resize a REUSED node. Clears the inline size first so a
// node that's now natural (no saved size in the restored snapshot) resets to content size. Mirrors
// makeNodeResizable's restore branch exactly (widthOnly nodes stamp width only).
function reapplyNodeSizes() {
    for (const [id, el] of nodeEls) {
        el.style.width = ""; el.style.height = ""; el.style.minWidth = ""; el.style.minHeight = "";
        const s = nodeSizes.get(id);
        if (s && !collapsed.has(id)) {
            if (WIDTH_ONLY_NODES.has(nodeTypeOf(id))) { if (s.w && s.custW !== false) el.style.width = `${s.w}px`; }
            else applySavedSize(el, s);
        }
        markNodeSized(el, id);
    }
}

function buildNode(n, wire = true) {
    const div = document.createElement("div");
    div.id = `node-${n.id}`;
    div.dataset.id = n.id;
    fillNode(div, n, wire);
    // ONE resize path for every node. `widthOnly` nodes (item/window) never stamp a height — it
    // follows their fixed-aspect canvas. Every other node is freely resizable: the grip stamps an
    // inline height, reset/reload re-fits to content (height:auto for config nodes), and the body
    // scrolls if dragged smaller than its content.
    makeNodeResizable(div, n.id, { widthOnly: WIDTH_ONLY_NODES.has(n.type) });
    return div;
}

// window/item nodes wrap a LIVE canvas (captured image / cutout) that a full node rebuild
// would destroy — so they rebuild only their inner controls section in place, keeping the canvas.
// Both kinds are the same shape (host selector + body builder + re-wire); one table, not two
// copies. A new live-canvas node type is a row here, never another `if (n.type === …)` branch.
// `build` returns a NODE/frag for the controls section (replaceChildren'd into `sel`).
const _LIVE_SECTIONS = {
    window: { sel: ".win-controls", build: (n) => windowControls(n.ref), wire: wireWindowControls },
    item:   { sel: ".item-lists", build: (n) => itemLists(n.ref, n.win), wire: wireItemControls },
    // game node: rebuild only the window-priority list, leaving the name/process/title inputs put
    game:   { sel: ".game-priority", build: () => gamePriority(), wire: wireGamePriority },
};

// Rebuild ONE node's DOM in place (used when its own layout changes, e.g. type).
function rebuildNode(id) {
    const el = nodeEls.get(id);
    const n = model.nodes().find((x) => x.id === id);
    if (!el || !n) return;
    const live = _LIVE_SECTIONS[n.type];
    if (live) {   // keep the live canvas: rebuild + re-wire only the controls section
        const host = el.querySelector(live.sel);
        if (host) { host.replaceChildren(live.build(n)); live.wire(el, n); }
        return;
    }
    fillNode(el, n);
    // fillNode rewrote the node's DOM, wiping the resize grips — re-add them with the SAME opts as
    // creation (snapResize), grip-side onSettle included. snapResize's ResizeObserver only glues edges
    // on reflow; it does NOT settle/reroute (no mouseup/finish), so the grip loop's onSettle is the
    // ONLY thing that clears the drag freeze and reroutes on release. Dropping it here left a rebuilt
    // node's resize with no reroute after release (draggingNodes stuck true, lines frozen).
    // (window + item already returned above; every remaining node type is freely resizable.)
    addResizeGrips(el, { ...nodeResizeOpts(el, n.id), snap: true });
    fitNodeHeight(el, n.id);   // a revealed input (e.g. dict -> fuzzy) may overflow the pinned height — grow to fit
}

// Toast nodes (their readout token chips), on_readout trigger nodes (their watch-var dropdown),
// and register nodes (their "+ readout" add-select) all list model.readouts(), built ONCE per
// node body. A readout added/removed/renamed elsewhere leaves those bodies stale — render()
// reconciles, it never rebuilds a body. Sweep them from ONE helper so every readout mutation
// site stays in lock-step (rule 7). rebuildNode is a no-op for a node not currently in the DOM,
// so this is safe to call unconditionally.
export function rebuildReadoutConsumers() {
    for (const t of model.profile.toasts || []) rebuildNode(`toast:${t.id}`);
    for (const t of model.profile.triggers || []) rebuildNode(`trigger:${t.id}`);
    for (const id of model.registers()) rebuildNode(`register:${id}`);
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
    nodeSizes.set(id, { ...nodeSizes.get(id), w: el.offsetWidth, h });   // keep softW/H + custW/H
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
        markNodeSized(el, id);   // reset dots hidden while collapsed; per-axis when expanded
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
    syncMultiSelect();
    renderNodeViews();
    // When the set of dataset/subset ids changes (add/rename/remove, or a producer/source
    // discovering one at runtime), the sibling nodes that list every id in a <select> — trigger
    // watch/dataset-action, producer source picker, subset join-source — are built ONCE and go
    // stale (this reconcile reuses bodies, never rebuilds them). Rebuild them on a set change.
    // Also fold in each subset's OWN source-id list: a source add/remove (e.g. via undo/redo)
    // changes what that subset's sources list shows without changing the id SET, so key on it
    // too or the gate below never reopens for that edit and the sources list goes stale.
    const dsKey = [...model.datasets(), " ",
        ...(model.profile.subsets || []).map((s) => `${s.id}<${model.subsetInputs(s).join(",")}`)].join("");
    if (dsKey !== _lastDsSetKey) { _lastDsSetKey = dsKey; rebuildDatasetConsumers(); }
    // A toast's token chips list the FIELDS/COLUMNS of its wired sources — those change without the
    // dataset/subset id SET changing (add a field to a window, a derived column to a subset), so the
    // dsKey gate above misses them. Toasts are few; rebuild their bodies every render so the chips
    // (and the add-source select) always reflect the current columns. rebuildNode no-ops when the
    // node isn't in the DOM, and message edits never call render(), so this can't eat a caret.
    for (const t of model.profile.toasts || []) rebuildNode(`toast:${t.id}`);
    // Same problem, one level up: a DATASET's own "sources" chip list names whichever window/
    // producer/file-source/register feeds it BY ID — renaming ANY of those feeders changes that
    // id but not the dataset id SET, so the dsKey gate above misses it too (the dataset node's id
    // never changed, so the top loop just repositions it — never rebuilds its body). Datasets are
    // few; rebuild every one's body every render, same trade-off as the toast fix above.
    for (const d of model.datasets()) rebuildNode(`ds:${d}`);
}
let _lastDsSetKey = null;

// Rebuild every node whose body lists the dataset/subset id set in a dropdown — the delete/add/
// rename-safe twin of rebuildReadoutConsumers (rule 7). rebuildNode no-ops for an absent node.
function rebuildDatasetConsumers() {
    for (const t of model.profile.triggers || []) rebuildNode(`trigger:${t.id}`);
    for (const p of model.profile.producers || []) rebuildNode(`producer:${p.id}`);
    for (const s of model.profile.subsets || []) rebuildNode(`sub:${s.id}`);
}

// Item nodes always show their frozen cutout canvas; open any that aren't yet.
function openMissingItemCanvases() {
    for (const w of model.profile.windows || [])
        for (const it of w.items || [])
            if (it.cutout && !itemCanvases.has(`${w.id}:${it.id}`) && nodeEls.has(`item:${w.id}:${it.id}`))
                openItemImage(w.id, it.id);
}



// ---- pan + zoom -----------------------------------------------------------

// Clear selections that live INSIDE node bodies (item-list rows, a batches node's
// picked batch) for every node that isn't `keepId` — so a node's inner selection
// doesn't linger after focus moves off it.
function clearNodeSelections(keepId = null) {
    collapseVtablesExcept(keepId);   // fold any open vt-table row on a node losing focus
    for (const [nid, el] of nodeEls) {
        if (nid === keepId) continue;
        el.querySelectorAll(".il-sel").forEach((r) => r.classList.remove("il-sel"));
    }
    for (const ds of batchesState.keys()) {
        // the batches ledger lives in the vt-table satellite (`vt:ds:${ds}`), not the dataset
        // node — keep its selection when EITHER is focused, else focusing the satellite wipes
        // its own picked batch (breaks click-to-deselect; strands the detail on "loading…").
        if (`ds:${ds}` === keepId || `vt:ds:${ds}` === keepId) continue;
        const st = batchesState.get(ds);
        if (st.sel == null) continue;
        st.sel = null;
        const els = batEls(ds);
        if (els) {
            els.detail.replaceChildren();
            els.list.querySelectorAll(".batrow.sel").forEach((li) => li.classList.remove("sel"));
        }
    }
}

function deselectAll() {
    for (const [, rec] of overlays) rec.overlay.setActive(null);   // every overlay, centrally
    clearTools();   // drop any armed draw tool on every surface
    for (const [, el] of nodeEls) el.classList.remove("selected");
    clearNodeSelections();
    selectedNodeId = null;
    activeOverlayKey = null;
    clearMultiSelect();
    groups.clearGroupSelection();   // also drop any ctrl-selected groups
    syncMultiSelect();   // recompute toolbar visibility — clearMultiSelect skips it when the
                                              // set was already empty (single-focus deselect), leaving the bar stuck
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
// ---- selection toolbar: ONE shared predictor for all three grouping tiers (rule 7) -----------
// Every tier button (group / subgroup / super) derives its label, icon and tooltip from tierState()
// — a PURE function of the member SET, so the button never changes meaning with selection ORDER
// (item 7), and each tier's ungroup carries a distinct label + icon (items 2, 3).
const _selSvg = (...kids) => svg("svg", { viewBox: "0 0 16 16", width: 14, height: 14, "aria-hidden": "true",
    fill: "none", stroke: "currentColor", "stroke-width": "1.4", "stroke-linecap": "round", "stroke-linejoin": "round" }, ...kids);
const _selRect = (x, y, w, hh) => svg("rect", { x, y, width: w, height: hh, rx: "2" });
// base glyph per tier: group = one box, sub = box with a nested box, super = two offset boxes
const SEL_ICON = {
    group: () => _selSvg(_selRect(2.5, 2.5, 11, 11)),
    sub: () => _selSvg(_selRect(2.5, 2.5, 11, 11), _selRect(6.5, 6.5, 6.5, 6.5)),
    super: () => _selSvg(_selRect(2, 4.5, 9, 9), _selRect(5, 2, 9, 9)),
};
// ungroup adds a slash across the tier glyph — a distinct icon per tier for every ungroup (item 3)
function selIcon(kind, verb) {
    const g = SEL_ICON[kind]();
    if (verb === "ungroup") g.append(svg("line", { x1: "2.5", y1: "13.5", x2: "13.5", y2: "2.5" }));
    return g;
}
const SEL_LABELS = {
    group: { make: "group", add: "add to group", ungroup: "ungroup" },
    sub: { make: "subgroup", add: "add to subgroup", ungroup: "unsubgroup" },
    super: { make: "super-group", add: "add to super group", ungroup: "un-super" },
};
const SEL_TITLES = {
    group: { make: "group the selection", add: "add the loose nodes to the group", ungroup: "ungroup the selection" },
    sub: { make: "sub-group the selection within its group", add: "add the loose nodes to the subgroup", ungroup: "dissolve / leave this subgroup" },
    super: { make: "super-group the selected groups", add: "add the loose groups to the super group", ungroup: "dissolve / leave the super group" },
};
// Predict a tier action from its member ids + the "which record holds this id" lookup. Pure in the
// SET of ids (order-independent, item 7): 1 shared holder & none loose -> ungroup; 1 shared holder
// & some loose -> add; otherwise -> make a new record. Returns null when nothing is selected.
function tierState(ids, holderOf, kind) {
    if (!ids.length) return null;
    const holders = new Set(ids.map(holderOf).filter(Boolean));
    const loose = ids.some((id) => !holderOf(id));
    const verb = (holders.size === 1 && !loose) ? "ungroup" : (holders.size === 1 && loose) ? "add" : "make";
    return { verb, kind, label: SEL_LABELS[kind][verb], title: SEL_TITLES[kind][verb] };
}
// A subgroup is only offerable when the WHOLE selection sits inside ONE group (scoped to a single
// parent group). Then it follows the same predictor.
function subOfferable(ids) {
    if (!ids.length) return false;
    const gset = new Set(ids.map((id) => groups.groupOf(id)).filter(Boolean));
    if (gset.size !== 1) return false;
    const parent = [...gset][0];
    return ids.every((id) => parent.members.includes(id));
}
function subState(ids) { return subOfferable(ids) ? tierState(ids, groups.subgroupOf, "sub") : null; }
// Set a `.sel-lbl` span's text and hide it when empty — an empty label still eats padding/gap
// (icon-only buttons) so it must collapse, not just blank. One writer for every sel-lbl set.
function setSelLbl(lbl, text) { if (!lbl) return; lbl.textContent = text || ""; lbl.hidden = !text; }
// Paint a tier button from a state (or hide it). Icon, label + tooltip all come from the state.
function applyTierBtn(btn, state) {
    if (!btn) return;
    btn.hidden = !state;
    if (!state) return;
    const ic = btn.querySelector(".sel-ic"); if (ic) ic.replaceChildren(selIcon(state.kind, state.verb));
    setSelLbl(btn.querySelector(".sel-lbl"), state.label);
    btn.title = state.title;
}
function syncMultiSelect() {
    for (const [id, el] of nodeEls) el.classList.toggle("multisel", selected.has(id));
    const bar = $("seltoolbar"), cnt = $("selCount");
    const gids = groups.selectedGroupIds();   // ctrl-selected GROUPS (super-grouping channel)
    const ng = gids.length;
    const ids = selectionIds();               // selected nodes (single focus OR multi-select set)
    const nsel = ids.length;
    const groupMode = ng >= 1;                 // ctrl-selected groups -> super ops (node buttons hide)
    const wasHidden = bar ? bar.hidden : true;
    if (bar) bar.hidden = !(nsel >= 1 || ng >= 1);
    // replay the slide-in only on the hidden->shown edge (never on a steady-state selection tick)
    if (bar && wasHidden && !bar.hidden) { bar.classList.remove("slidein"); void bar.offsetWidth; bar.classList.add("slidein"); }
    if (cnt) cnt.textContent = groupMode ? `${ng} group${ng === 1 ? "" : "s"} selected` : `${nsel} selected`;
    // SUPER lives on its own button + channel; GROUP/SUB/detach/delete act on the node selection.
    applyTierBtn($("selSuperBtn"), groupMode ? tierState(gids, groups.superGroupOf, "super") : null);
    const gs = groupMode ? null : tierState(ids, groups.groupOf, "group");
    applyTierBtn($("selGroupBtn"), gs);
    applyTierBtn($("selSubgroupBtn"), groupMode ? null : subState(ids));
    // detach shows only for a MIXED node selection (some grouped) where the group button offers
    // group/add rather than ungroup — else the two buttons would do the same detach.
    const det = $("selDetachBtn"), del = $("selDeleteBtn"), cln = $("selCloneBtn");
    if (det) det.hidden = groupMode || !gs || gs.verb === "ungroup" || !ids.some((id) => groups.groupOf(id));
    if (cln) cln.hidden = groupMode || !ids.some((id) => CLONEABLE.has(nodeTypeOf(id)));
    if (del) {
        del.hidden = groupMode || !ids.some((id) => isRemovable(nodeTypeOf(id)));
        if (del.dataset.armed === "1") { del.dataset.armed = "0"; const dl = del.querySelector(".sel-lbl"); if (dl) setSelLbl(dl, del.dataset.label ?? dl.textContent); }   // label is legitimately "" now (icon-only) -> ?? not ||
    }
    if (bar) collapseSeparators(bar);   // hide any `.sel-sep` that now borders nothing (unremovable node, group-mode, etc.)
    drawEdges();   // selection changed -> repaint so selected nodes' lines pick up the `sel` colour
}

// A `.sel-sep` divides button groups; it means nothing unless a real (non-hidden) button is visible
// in the run immediately before AND after it. Walk each side outward, stopping at the next sep (so
// only the adjacent group counts — this also collapses doubled seps when a whole middle group hides).
// Only <button>s count as content: the `.sel-count` span is always present and must not prop a sep up.
function collapseSeparators(bar) {
    const kids = [...bar.children];
    const isSep = (el) => el.classList.contains("sel-sep");
    const groupHasBtn = (from, dir) => {
        for (let i = from; i >= 0 && i < kids.length; i += dir) {
            if (isSep(kids[i])) return false;                      // adjacent group boundary
            if (kids[i].tagName === "BUTTON" && !kids[i].hidden) return true;
        }
        return false;
    };
    for (let i = 0; i < kids.length; i++) {
        if (!isSep(kids[i])) continue;
        const show = groupHasBtn(i - 1, -1) && groupHasBtn(i + 1, 1);
        if (kids[i].hidden === show) kids[i].hidden = !show;       // write only on change
    }
}



// Is the cursor over an element whose content actually overflows and can scroll? Walk up to
// the canvas; the wheel belongs to that element (native scroll), not to the canvas zoom.



// Double-click a node: fit it tight to the viewport and centre it (smooth, shared with
// the node-map jump so both frame a node the same way).


// ---- per-node interaction -------------------------------------------------

// The node-title id input (`input.gi-id`) is "click-to-arm": a first click only
// selects the node (focus is blocked); a SECOND click on the same already-armed
// input focuses it for editing. Any mousedown elsewhere disarms + blurs, so an id
// is never edited by accident while panning/selecting. One global capture listener
// drives the disarm (fires before the node's own bubble-phase mousedown).
let armedGiId = null;
function disarmGiId() {
    if (armedGiId) { armedGiId.blur(); armedGiId = null; }
}
document.addEventListener("mousedown", (ev) => {
    if (armedGiId && ev.target !== armedGiId) disarmGiId();
}, true);

function wireNode(div, n) {
    // drag-move from the node header / frame, NOT the body — so interacting with body content
    // (selects, chips, tables) never drags the node. The header + outer padding stay grab zones.
    div.addEventListener("mousedown", (ev) => {
        if (ev.button !== 0) {
            // ONLY a left second-click may edit the id. A non-left press on the id input would
            // otherwise focus it natively (no arm needed) -> instant edit; suppress that focus.
            // preventDefault (not stopPropagation) so the press still bubbles to pan the canvas.
            if (ev.target.closest("input.gi-id")) ev.preventDefault();
            return;   // only left-drag moves; right-drag pans the canvas
        }
        // ctrl/cmd-click ANYWHERE on the node (header, frame, OR body content) toggles it in/out
        // of the multi-selection and NEVER drags — handled first so body fields don't swallow it.
        if (ev.ctrlKey || ev.metaKey) {
            ev.preventDefault();
            // seed the multi-select set with the currently single-focused node so a ctrl-click
            // on a 2nd node ADDS to the selection instead of dropping the 1st.
            if (!selected.size && selectedNodeId && nodeEls.has(selectedNodeId)) selected.add(selectedNodeId);
            if (selected.has(n.id)) selected.delete(n.id); else selected.add(n.id);
            syncMultiSelect();
            return;
        }
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
        const r = div.getBoundingClientRect();   // skip the CSS resize-handle corner (resizable nodes)
        if (ev.clientX > r.right - 18 && ev.clientY > r.bottom - 18) { focusNode(n.id); return; }
        // grabbing a node OUTSIDE the current multi-selection drops it (fresh single focus);
        // grabbing one INSIDE keeps the set so the drag moves the whole selection.
        if (!selected.has(n.id)) clearMultiSelect();
        focusNode(n.id);   // select on click / drag start (every node is focusable)
        // id input is click-to-arm: block native focus on the FIRST click (just arm + select);
        // a second (left) click on the same armed input falls through to native focus → editing.
        if (handle && handle.matches?.("input.gi-id")) {
            if (handle !== armedGiId) {
                ev.preventDefault();   // first click: suppress focus/caret, just arm
                armedGiId = handle;
            } else {
                // second click: native focus lands after this handler — preselect the whole id so
                // typing replaces it. Guard on activeElement so a drag (which blurs) doesn't reselect.
                const el = handle;
                setTimeout(() => { if (document.activeElement === el) el.select(); }, 0);
            }
        }
        if (handle) dragFromHandle(n.id, ev, div, handle);   // drag past threshold, else click
        else startMove(n.id, ev);
    });

    // double-click anywhere non-interactive on the node: fit + centre it
    div.addEventListener("dblclick", (ev) => {
        // a fast arm+edit on the id input registers as a native dblclick — it must EDIT, not
        // pan/zoom. Do nothing here so the second click's native focus (+ preselect) stands.
        // Pan/zoom-to-node is still available by double-clicking the node body/header padding.
        if (ev.target.closest("input.gi-id")) return;
        if (ev.target.closest("input,select,button,textarea,a,.port,.collapse,.sv-norm-eg")) return;
        ev.preventDefault();
        zoomToNode(n.id);
    });

    if (n.type === "game") {
        div.querySelectorAll(".gi").forEach((inp) => inp.addEventListener("change", (e) => {
            const k = e.target.dataset.k, v = e.target.value;
            if (k === "name") model.profile.name = v.trim();
            else if (k === "proc") model.profile.process_names = v.split(",").map((s) => s.trim()).filter(Boolean);
            else if (k === "title") model.profile.window_title_hint = v.trim() || null;
            autosave(null);   // process/title/name affect window LOCATION, not stashed-image OCR
        }));
        wireGamePriority(div);   // window-priority list ▲/▼ + name jumps
        // node creation moved to the floating "create" toolbox (see buildToolbox)
    } else if (n.type === "atlas") {
        openAtlasImage(div);   // mount the cutout-atlas image surface + taught glyph/symbol list
    } else if (n.type === "dictionary") {
        // the title doubles as both name and id (renamed in place)
        div.querySelector(".dictname")?.addEventListener("change", (e) => {
            const oldId = n.ref.id;
            const newName = e.target.value.trim() || oldId;
            n.ref.name = newName;
            const newId = newName.replace(/[^A-Za-z0-9._-]+/g, "_");
            if (newId !== oldId && model.renameDictionary(oldId, newId)) movePos(`dict:${oldId}`, `dict:${newId}`);
            render(); autosave(null);
        });
        div.querySelector(".dictterms")?.addEventListener("change", (e) => {
            if (e.target.readOnly) return;   // fed dictionaries derive their terms; ignore edits
            n.ref.terms = e.target.value.split("\n").map((s) => s.trim()).filter(Boolean);
            rebuildNode(n.id); autosave(null);   // refresh the word count
        });
        // Dictionary feeds: pick which of a wired dataset's columns become terms. The pull runs
        // server-side on save (oc.learn.dict_feed), so after saving we re-fetch the derived list.
        const refetchFedTerms = async () => {
            if (!n.ref.source) return;
            await persist.flush();   // let the save's re-pull land first
            try {
                const { terms } = await api.dictionaries.get(n.ref.source);
                model.setDictionaryTerms(n.ref.id, terms || []); rebuildNode(n.id);
            } catch { /* keep the current list on error */ }
        };
        div.querySelectorAll(".dfcol").forEach((el) => el.addEventListener("change", () => {
            model.toggleDictFeedColumn(n.ref.id, el.dataset.ds, el.dataset.col);
            autosave(null); refetchFedTerms();
        }));
        // wiring a source in/out of the sources-input widget changes an edge (render) AND the
        // node's chips + per-source column blocks (rebuild) — mirror the subset add/remove path.
        div.querySelector(".sv-addin")?.addEventListener("change", (e) => {
            if (model.addDictFeed(n.ref.id, e.target.value)) { render(); rebuildNode(n.id); autosave(null); refetchFedTerms(); }
        });
        wireArmedRemove(div, ".sv-rmin", (val) => {
            model.removeDictFeed(n.ref.id, val);
            render(); rebuildNode(n.id); autosave(null); refetchFedTerms();
        });
    } else if (n.type === "window") {
        wireWindowControls(div, n);   // out-port wiring is handled generically in wireOutPort
        openImage(n.ref.id, div);     // pass div: this runs during buildNode, before nodeEls has the node
    } else if (n.type === "preview") {
        // auto-reads on image change + any window edit; the one button commits the read to the dataset
        div.querySelector(".prevcommit")?.addEventListener("click", (e) => commitPreviewNode(n.ref.id, e.currentTarget));
    } else if (n.type === "dataset") {
        // sources chips: add via the "+ source" select, remove via each chip's trash. Both paths
        // call the SAME model setters the drag-a-window/producer/file-source-onto-this-dataset
        // wiring already uses, so the two ways of wiring stay in sync (rebuild re-queues edges).
        div.querySelector(".ds-addsrc")?.addEventListener("change", (e) => {
            if (model.addDatasetSource(n.ref, e.target.value)) { rebuildNode(n.id); drawEdges(); autosave(null); }
        });
        wireArmedRemove(div, ".ds-rmsrc", (val) => {
            model.removeDatasetSource(n.ref, val);
            rebuildNode(n.id); drawEdges(); autosave(null);
        });
        div.querySelector(".dsrename")?.addEventListener("change", async (e) => {
            const oldId = n.ref, newId = (e.target.value || "").trim();
            if (!model.renameDataset(oldId, newId)) { e.target.value = oldId; return; }
            movePos(`ds:${oldId}`, `ds:${newId}`);
            render();   // migrate the live DOM node to the new id NOW (its drag wiring binds the new
                                    // id) — refreshLive below skips render when the dataset SET is unchanged, which
                                    // it is after an in-place rename, so the node would otherwise keep the old id
            autosave(null);
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
                e.target.value = oldId; setStatus(String(err.message || err)); autosave(null);
                await persist.flush();   // commit the rollback too, so refreshLive doesn't resurrect newId
                render(); return;
            }
            await refreshLive();   // re-reads the dataset list (now under the new name) and re-renders
            // refreshLive's gates MISS this rename: the dataset SET is unchanged (renamed in place) so it
            // takes the no-render branch, and newId has no prior last_ts so its per-ds refetch is skipped.
            // render()'s queued fetch ran BEFORE the server moved the data (empty). Re-pull the renamed
            // node's records/batches + its subset consumers — COALESCED, so this and the server-rename
            // change echo collapse into one batched /flow/details instead of a storm of per-node fetches.
            queueNodeRefresh({ datasets: [newId], subsets: (model.profile.subsets || []).map((s) => s.id) });
        });
        // Any key change re-keys the ledger on disk, so flush BEFORE re-reading this node + its views.
        const rekeyDataset = async () => { autosave(null); await persist.flush(); refreshDataNode(n.ref); refreshAllSubsetNodes(); };
        div.querySelector(".dskey")?.addEventListener("change", async (e) => {
            const v = e.target.value;
            if (v === "__nodedup__") model.setDatasetDedup(n.ref, false);
            else if (v === "__concat__") model.setDatasetKeyMode(n.ref, "concat");
            else if (v === "") model.setDatasetKeyMode(n.ref, "auto");
            else model.setDatasetKeyField(n.ref, v);
            rebuildNode(n.id);   // show/hide the concat editor for the new mode
            await rekeyDataset();
        });
        // The dataset's OWN many→one policy. Changing it re-materialises `current` under the new
        // aggregate, and every view that INHERITS it now reads a different value — so flush and
        // re-read this node and its consumers, exactly like a key change.
        div.querySelector(".dsagg")?.addEventListener("change", async (e) => {
            model.setDatasetAggregate(n.ref, e.target.value);
            await rekeyDataset();
        });
        // Concat-key editor: field checkboxes + the four canonicalisation knobs (present only in concat mode).
        div.querySelectorAll(".dskf").forEach((el) => el.addEventListener("change", () => {
            model.toggleDatasetKeyField(n.ref, el.dataset.field); rekeyDataset();
        }));
        for (const [cls, key] of [[".dsk-ci", "case_insensitive"], [".dsk-punct", "strip_punct"], [".dsk-ws", "collapse_ws"]])
            div.querySelector(cls)?.addEventListener("change", (e) => {
                model.setDatasetKeyNorm(n.ref, { [key]: e.target.checked }); rekeyDataset();
            });
        div.querySelector(".dsk-words")?.addEventListener("change", (e) => {
            model.setDatasetKeyNorm(n.ref, { strip_words: e.target.value.split(/\s+/).map((s) => s.trim()).filter(Boolean) });
            rekeyDataset();
        });
        div.querySelector(".dsbatch")?.addEventListener("change", (e) => {
            model.setDatasetBatchMode(n.ref, e.target.value);
            autosave(null);
        });
        div.querySelector(".dssync")?.addEventListener("change", (e) => {
            model.setDatasetSyncMode(n.ref, e.target.value);
            autosave(null);
        });
        const clearBtn = div.querySelector(".dsclear");
        clearBtn?.addEventListener("click", async () => {
            if (clearBtn.dataset.armed !== "1") {   // inline confirm (no blocking dialogs)
                clearBtn.dataset.armed = "1"; clearBtn.textContent = "confirm?";
                setTimeout(() => { clearBtn.dataset.armed = "0"; clearBtn.textContent = "clear data"; }, 2500);
                return;
            }
            clearBtn.dataset.armed = "0"; clearBtn.textContent = "clear data";
            // Clearing ONE dataset only changes THAT dataset (+ its subset consumers). Refresh just
            // those, coalesced through one batched /details — NOT refreshAll* across every node (the
            // GET storm). The clear's own change-push dedups into the same batch. scheduleRefreshLive
            // (debounced) updates the count badge once.
            try {
                await withBusy([n.id], () => api.clearDataset(model.profile.name, n.ref));
                const subs = (model.profile.subsets || []).filter((s) => model.subsetReaches(s.id, n.ref)).map((s) => s.id);
                queueNodeRefresh({ datasets: [n.ref], subsets: subs });
                scheduleRefreshLive();
                setStatus(`cleared ${n.ref}`);
            } catch (e) { setStatus(String(e.message || e)); }
        });
    } else if (n.type === "vttable") {
        // the records grid satellite: fill it once built. Subset variant carries the view host;
        // dataset variant carries the data + batches hosts AND the data|batches selector (the tabs
        // live ABOVE the table here, not on the dataset node).
        const r = n.ref;
        if (r.kind === "producer") {
            wireProducerPreview(div, r);
        } else if (r.kind === "source" || r.kind === "sourcedismissed") {
            queueMicrotask(() => refreshSourcePreview(r.id));   // parse the source's rules into BOTH satellites
        } else if (r.kind === "subset") {
            const pre = _bootDetails?.subsets?.[r.id] || null;
            queueMicrotask(() => refreshSubsetNode(r.id, pre));
        } else {
            const rmTog = div.querySelector(".vt-showrm");   // "show removed" header toggle (checkbox)
            rmTog?.addEventListener("change", (e) => {
                e.stopPropagation();
                vtShowRemoved.set(r.ds, e.currentTarget.checked);
                refreshDataNode(r.ds);   // re-filter the table (and the data-tab count) to match
            });
            const cur = dsTab.get(r.ds) || "data";
            div.dataset.tab = cur;   // CSS hides the inactive host
            div.querySelectorAll(".ds-tab").forEach((t) => t.classList.toggle("on", t.dataset.tab === cur));
            // data | history tabs: pick which table shows; the ledger loads lazily on first open
            div.querySelectorAll(".ds-tab").forEach((tab) => tab.addEventListener("click", () => {
                const which = tab.dataset.tab;
                dsTab.set(r.ds, which);
                div.dataset.tab = which;
                div.querySelectorAll(".ds-tab").forEach((t) => t.classList.toggle("on", t === tab));
                if (which === "batches") loadBatchesNode(r.ds);   // (re)fetch the ledger when shown
            }));
            const pre = _bootDetails?.datasets?.[r.ds] || null;
            queueMicrotask(() => { refreshDataNode(r.ds, pre); loadBatchesNode(r.ds, pre); });
        }
    } else if (n.type === "subset") {
        wireSubset(div, n.ref);
    } else if (n.type === "producer") {
        wireProducer(div, n);
    } else if (n.type === "trigger") {
        wireTrigger(div, n);
    } else if (n.type === "toast") {
        wireToast(div, n);
    } else if (n.type === "sound") {
        wireSound(div, n);
    } else if (n.type === "action") {
        wireAction(div, n);
    } else if (n.type === "register") {
        wireRegister(div, n);
    } else if (n.type === "filesource") {
        wireSource(div, n);
    } else if (n.type === "region") {
        const fld = n.field;
        div.querySelector(".gi-id").addEventListener("change", (e) => {
            const oldId = n.ref.id;
            renameNode(e.target, oldId,
                () => model.renameRegion(n.win.id, oldId, e.target.value.trim()),
                () => movePos(`reg:${n.win.id}:${oldId}`, `reg:${n.win.id}:${n.ref.id}`),
                () => { render(); autosave(n.win.id); refreshImageBoxes(n.win.id); });   // re-OCR only this window
        });
        // Only the capture/confidence knobs live on the field body now; all value processing is
        // authored in the rule pipeline (wired below). `type` rebuilds so the rule menus re-filter.
        div.querySelectorAll(".fset").forEach((inp) => inp.addEventListener("change", (e) => {
            if (!fld) return;
            const k = e.target.dataset.k;
            if (k === "type") { fld.type = e.target.value; rebuildNode(n.id); }  // re-filters the rule menus
            else if (k === "isolate") fld.isolate = e.target.checked;
            else if (k === "glyph_check") fld.glyph_check = e.target.checked;
            else if (k === "minconf") fld.min_confidence = +e.target.value || 0;
            autosave(n.win?.id);   // plain value edits: no DOM rebuild; re-OCR only this window
        }));
        if (fld) wireFieldRules(div, fld, {
            rebuild: () => { rebuildNode(n.id); autosave(n.win?.id); },
            commit: () => autosave(n.win?.id),
            retrace: (el) => refreshRuleTrace(n.win.id, fld.id, n.id, el),
        });
    } else if (n.type === "detect") {
        const owner = n.win.id;                         // window id, or "game" for the gate
        const isGate = owner === "game";
        const ownerNode = nodeIdOf(owner);
        // persist a detector edit: window detectors re-OCR their window; gate detectors just
        // save + re-run the cheap gate (autosave(null) doesn't re-read a window).
        const saveDet = () => { if (isGate) { autosave(null); refreshDetect("game"); } else autosave(owner); };
        div.querySelector(".gi-id").addEventListener("change", (e) => {
            const oldId = n.ref.id;
            renameNode(e.target, oldId,
                () => model.renameDetect(owner, oldId, e.target.value.trim()),
                () => movePos(`det:${owner}:${oldId}`, `det:${owner}:${n.ref.id}`),
                () => { render(); rebuildNode(ownerNode); saveDet(); refreshImageBoxes(owner); });
        });
        div.querySelectorAll(".aset").forEach((inp) => inp.addEventListener("change", (e) => {
            const k = e.target.dataset.k;
            if (k === "kind") { setDetectKind(n.ref, e.target.value); rebuildNode(n.id); refreshImageBoxes(owner); saveDet(); return; }
            if (k === "text") n.ref.text = e.target.value;
            else if (k === "color") { n.ref.color = e.target.value.trim(); rebuildNode(n.id); }
            else if (k === "colorpick") { n.ref.color = e.target.value; rebuildNode(n.id); }
            else if (k === "tol") n.ref.tolerance = Math.max(0, Math.trunc(+e.target.value) || 0);
            else if (k === "width") n.ref.width = Math.max(0, +e.target.value || 0);
            else if (k === "thr") n.ref.threshold = +e.target.value;
            else if (k === "match") n.ref.match = e.target.value;
            else if (k === "minchars") n.ref.min_chars = Math.max(0, Math.trunc(+e.target.value) || 0);
            else if (k === "strip") n.ref.strip = e.target.value;
            else if (k === "case") n.ref.case_sensitive = e.target.checked;
            // mode change shows/hides "read ⊆ text" (ignored by full/exact) -> rebuild the body
            if (k === "match") rebuildNode(n.id);
            saveDet();   // a detector knob re-runs detect for ONLY this owner
        }));
    } else if (n.type === "scrollbar") {
        wireScrollbar(div, n);
    } else if (n.type === "item") {
        wireItemControls(div, n);
    } else if (n.type === "itemfield") {
        wireItemField(div, n);
    } else if (n.type === "itemtell") {
        wireItemTell(div, n);
    } else if (n.type === "readout") {
        wireReadout(div, n);
    }
}

// Readout node (self-contained): its name (what a trigger watches) + the inline read-config
// (`.roset` on the linked FieldDef, exactly like a region node).
function wireReadout(div, n) {
    const winId = n.win.id, vid = n.ref.id;
    const fld = n.field;
    // With live mode OFF the collector isn't feeding values, so read this readout's value off the
    // current image. `refetch` = immediate (node just opened — show a value right away, matches
    // scheduleItemRead's img.onload pattern). `scheduleRefetch` = an EDIT changed the read config —
    // queue it on the shared window-read clock (scheduleWindowRead) instead of firing its own
    // separate un-debounced fetch, so it settles in the SAME beat as the rest of that edit's fallout.
    const refetch = () => { if (!liveCollecting()) refreshReadoutValues(winId); };
    const scheduleRefetch = () => { if (!liveCollecting()) scheduleWindowRead(winId, { readouts: true }); };
    div.querySelector(".gi-id")?.addEventListener("change", (e) => {
        renameNode(e.target, vid,
            () => model.renameReadout(winId, vid, e.target.value.trim()),
            () => movePos(`ro:${winId}:${vid}`, `ro:${winId}:${n.ref.id}`),
            () => { render(); rebuildReadoutConsumers(); autosave(winId); });   // repoint toast chips + watch dropdown
    });
    // inline read-config, edited straight on the FieldDef (like a region). Only the
    // capture/confidence knobs live here; value processing is the rule pipeline (wired below).
    div.querySelectorAll(".roset").forEach((inp) => inp.addEventListener("change", (e) => {
        if (!fld) return;
        const k = e.target.dataset.k;
        if (k === "type") { fld.type = e.target.value; rebuildNode(n.id); }  // re-filters the rule menus
        else if (k === "isolate") fld.isolate = e.target.checked;
        else if (k === "glyph_check") fld.glyph_check = e.target.checked;
        else if (k === "minconf") fld.min_confidence = +e.target.value || 0;
        autosave(winId);
        scheduleRefetch();   // read config changed -> re-read the value off the current image
    }));
    if (fld) wireFieldRules(div, fld, {
        rebuild: () => { rebuildNode(n.id); autosave(winId); },
        commit: () => { autosave(winId); scheduleRefetch(); },
        retrace: (el) => refreshRuleTrace(winId, fld.id, n.id, el),
    });
    refetch();   // initial value off the current image (no-op while the collector is running)
}

// Scrollbar node: orientation + visible-rows, the cutout list (rows-from-top, remove,
// drag-reorder), capture, and auto-learn. All calibration knobs are collector-only -> save
// without re-OCR.
function wireScrollbar(div, n) {
    const winId = n.win.id;
    // re-fit the gain from the cutouts after any change, refresh the node, save, and re-read the
    // window image so its row-index labels update (works even with the preview node closed).
    // refreshImageBoxes: the cutout count decides the box's locked flag on the window canvas.
    const relearn = () => { model.learnScrollGain(winId); rebuildNode(n.id); autosave(null); refreshGridPreview(winId); refreshImageBoxes(winId); };
    div.querySelectorAll(".sbset").forEach((inp) => inp.addEventListener("change", (e) => {
        if (e.target.dataset.k === "orient") { model.setScrollbarOrientation(winId, e.target.value); autosave(winId); }
    }));
    div.querySelectorAll(".sbcut[data-k='rows']").forEach((inp) => inp.addEventListener("change", (e) => {
        model.setScrollSampleRows(winId, +e.target.dataset.i, e.target.value); relearn();
    }));
    div.querySelectorAll(".sbcut-rm").forEach((b) => b.addEventListener("click", () => {
        model.removeScrollSample(winId, +b.dataset.i); relearn();
    }));
    div.querySelector(".sb-capture")?.addEventListener("click", () =>
        captureScrollCutout(n).catch((err) => setStatus(String(err.message || err), "err")));
    wireCutoutDrag(div, n);
}

// Crop the scrollbar region out of the open window image into a new cutout, ask the server for
// the thumb position, and add it as a calibration sample.
async function captureScrollCutout(n) {
    const winId = n.win.id;
    const src = imageCanvases.get(winId)?.overlay?.img;   // the raw window image (client area)
    if (!src || !src.naturalWidth) throw new Error("open the window image first (scroll it to a known position)");
    const box = model.scrollbar(winId);
    if (!box) throw new Error("draw a scrollbar box first");
    const cw = src.naturalWidth, ch = src.naturalHeight;
    const sx = Math.max(0, Math.round(box.x * cw)), sy = Math.max(0, Math.round(box.y * ch));
    const sw = Math.max(1, Math.round(box.w * cw)), sh = Math.max(1, Math.round(box.h * ch));
    const off = document.createElement("canvas");
    off.width = sw; off.height = sh;
    off.getContext("2d").drawImage(src, sx, sy, sw, sh, 0, 0, sw, sh);
    const img = off.toDataURL("image/png");
    const orientation = model.window(winId)?.scroll?.scrollbar_orientation || "vertical";
    let pos = null, conf = null, px = null;
    try { const r = await api.scrollPos(img, orientation); pos = r.pos; conf = r.conf; px = r.thumb_px; }
    catch (e) { setStatus(`thumb read failed: ${e.message || e}`, "warn"); }
    model.addScrollSample(winId, { img, rows: 0, pos, conf, px });
    model.learnScrollGain(winId);             // re-fit with the new cutout
    rebuildNode(`sb:${winId}:scrollbar`);
    autosave(null);
    refreshGridPreview(winId);                // re-read the window image -> row-index labels update
    refreshImageBoxes(winId);                 // first cutout locks the box on the window canvas
}

// HTML5 drag-reorder of the cutout rows (drop onto another row moves before it).
function wireCutoutDrag(div, n) {
    const list = div.querySelector(".sb-cuts");
    if (!list) return;
    let from = null;
    list.querySelectorAll(".sb-cut").forEach((row) => {
        row.addEventListener("dragstart", (e) => { from = +row.dataset.i; e.dataTransfer.effectAllowed = "move"; });
        row.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; });
        row.addEventListener("drop", (e) => {
            e.preventDefault();
            const to = +row.dataset.i;
            if (from != null && from !== to) {
                model.moveScrollSample(n.win.id, from, to);
                model.learnScrollGain(n.win.id);   // reorder is cosmetic for the fit, but keep it in sync
                rebuildNode(n.id); autosave(null);
            }
            from = null;
        });
    });
}

// Focus ANY node (click or drag). Drops box selection so WASD targets the node,
// highlights it + its lines. Box-backed nodes (region/detect/scrollbar) then re-select
// their box on the trailing click, so WASD keeps nudging the box for those.
function focusNode(id) {
    for (const [, rec] of overlays) rec.overlay.setActive(null);
    activeOverlayKey = null;
    // drop any picked draw tool on OTHER nodes — focusing elsewhere deselects their tools
    clearTools(nodeEls.get(id));
    selectedNodeId = id;
    clearNodeSelections(id);   // drop any other node's inner selection
    for (const [nid, el] of nodeEls) el.classList.toggle("selected", nid === id);
    drawEdges();
    syncMultiSelect();   // a single focused node also shows the selection toolbar (count + group/clear)
    nmSyncSelection();   // mirror the selection in the node map
}

// ---- dragging -------------------------------------------------------------
// GRID, snap, addResizeGrips, beginDrag and makeDraggable are imported from dragresize.js
// — the same primitives the floating panels use.

// Make a node resizable. The grip loop (dragresize.js) is the SOLE resize authority: it resizes
// SMOOTHLY during the drag and quantizes to the grid exactly ONCE, on release, via `opts.onSettle`
// — which also fires when the cursor is released off the grip (its mouseup is document-level). The
// ResizeObserver here does NOT snap or settle; its only job is to keep edges glued to the node when
// its box changes for reasons OTHER than a grip drag (image load, content reflow, an input losing
// focus). Snapping from an observer was the old jump-on-unfocus bug — a ResizeObserver can't tell a
// user grip-drag from an incidental reflow, so it must never write size or settle.
function snapResize(el, opts = {}) {
    observeResize(el, () => { requestEdges(); groups.renderGroups(); }, { gate: true });   // reflow (image load / content) -> edges follow AND boxes re-hug the node's new size; never snaps
    addResizeGrips(el, opts);   // custom grips on BOTH bottom corners; they own snap-on-release
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
    // the moved nodes ease left/top to each 20px grid cell instead of teleporting (.snapping CSS)
    const moved = [id, ...starts.map((g) => g.gid)];
    setDraggingNodes(true, moved);   // freeze line routing during the drag (invalidating lines a
                                     // dragged node touches or crosses); re-route once on settle
    for (const mid of moved) nodeEls.get(mid)?.classList.add("snapping");
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
            for (const mid of moved) nodeEls.get(mid)?.classList.remove("snapping");
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
function positionNode(id) { const el = nodeEls.get(id); const p = pos.get(id); if (el && p) { el.style.left = `${p.x}px`; el.style.top = `${p.y}px`; markNodeSized(el, id); } }

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
    // a spec may accept ONE target type ("subset") or SEVERAL (["subset","producer"]) — match any.
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
            if (tid != null && tid !== spec.selfId) {
                spec.onDrop(tid, ttype);
                // refresh BOTH ends here — the ONE place a wire commits — so no onDrop/onEmpty
                // needs its own rebuild. render() only builds MISSING nodes; it never re-fills an
                // already-present node's body (e.g. a dataset's derived "sources" chips), so the
                // drop target would otherwise go stale.
                rebuildNode(srcId); rebuildNode(target.dataset.id);
                render(); autosave(null); return;
            }
        } else if (dragged && !overNode && spec.onEmpty) {   // empty canvas (not over another node) -> mint a node
            const newId = spec.onEmpty(toWorld(e));
            rebuildNode(srcId);   // the new target node is built fresh by render() below
            render(); autosave(null); if (newId) panTo(newId);
            return;
        }
        render();
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
}

// ---- live + toolbar -------------------------------------------------------

let refreshLiveInFlight = false;
let refreshLiveAgain = false;
async function refreshLive() {
    if (!model.profile.name) return;
    // A push that lands DURING an in-flight fetch must not be dropped — the last write of an
    // async sweep (prices) often arrives while we're still fetching the previous event, and
    // losing it would strand the final data until some later unrelated event. Mark "run again"
    // and re-fire once this fetch completes (the same "Busy/Again" idiom singleFlight hoists).
    if (refreshLiveInFlight) { refreshLiveAgain = true; return; }
    refreshLiveInFlight = true;
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
            // refresh every subset that reads this dataset — directly OR through an upstream subset
            for (const s of model.profile.subsets || [])
                if (nodeEls.has(`sub:${s.id}`) && model.subsetReaches(s.id, ds)) refreshSubsetNode(s.id);
        }
    } catch { /* ignore */ }
    finally {
        refreshLiveInFlight = false;
        if (refreshLiveAgain) { refreshLiveAgain = false; scheduleRefreshLive(); }   // a push arrived mid-fetch -> run once more
    }
}

// Coalesce a burst of dataset-change pushes (a sweep writes several datasets ~at once) into a
// single /api/flow refetch. refreshLive already diffs per-dataset last_ts, so one call after the
// burst refreshes exactly the nodes whose ledger grew.
let _liveDebounce = null;
function scheduleRefreshLive() {
    clearTimeout(_liveDebounce);
    _liveDebounce = setTimeout(refreshLive, 200);
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
    $("gameSelect").replaceChildren(...names.map((n) => h("option", n)));
    if (select && names.includes(select)) $("gameSelect").value = select;
}

// Node view live-data refresh is PUSH-driven: the shared dataset-change bus (dsevents) calls
// scheduleRefreshLive on every write (live collection, sweeps, commits, edits, restores), so
// node tables update the instant a dataset's ledger changes — no per-beat /api/flow poll. The
// server coalesces ~1s/dataset and the client debounces the burst, so a heavy sweep refetches
// at most ~once/second. A slow interval (FLOW_FALLBACK_MS) is a safety net for missed events /
// reconnect gaps only, NOT the mechanism. (An earlier version polled /api/flow every hub beat;
// that ran even at idle and, with the old full-state read, was the page's heaviest request.)

async function loadGame(name) {
    if (!name) return;
    boot.phase = true;   // reopened images read the server OCR cache (no engine touch) until the load settles
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
    seedSubsetSig();        // baseline subset defs so an unrelated save recomputes NO subset (only new/edited ones diff)
    nodeEls.clear();
    $("gnodes").replaceChildren();
    for (const winId of [...imageCanvases.keys()]) closeImage(winId);
    batchesState.clear();   // batches render inline per node; drop stale selection state
    selected.clear();       // drop any multi-selection from the previous game
    hydrateLayout();        // restore node positions/sizes/collapse/open-images from the profile
    applyLocal(local);      // restore canvas zoom/pan + minimap from the per-device sidecar
    // Prefetch every node's data in ONE request before building the nodes, so each node renders
    // from `_bootDetails` instead of firing its own fetch (and a dataset feeding many views is
    // fetched once, not once per consumer). Best-effort: on failure nodes fall back to per-node fetch.
    try {
        // Bound the boot prefetch: a huge/slow dataset must not hold the whole boot. If it doesn't
        // land fast, give up the batch and let each node lazy-fetch its own data after render.
        const ac = new AbortController();
        const to = setTimeout(() => ac.abort(), 6000);
        try { _bootDetails = await api.flowDetails(name, model.datasets(), (model.profile.subsets || []).map((s) => s.id), ac.signal); }
        finally { clearTimeout(to); }
    } catch { _bootDetails = null; }
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
    _bootDetails = null;   // node build (+ its queued refreshes) consumed it; live refreshes fetch fresh
    groupOrphanChildren("itemfield");   // pull each item's field nodes into the item's group (idempotent)
    groupOrphanChildren("itemtell");    // …and its tell nodes
    drawEdges();                        // reflect any new group membership in the routing
    resetHistory();   // fresh undo/redo baseline for this game
    if (migrated) persist.layout();   // lock in node layout imported from legacy localStorage
    refreshLive();
    syncLiveFromServer();   // adopt a server collector still running from before a page reload (toggle reflects it)
    openLogStream(name);   // mirror server activity (trigger watches/fires, API fetches) into the log bar
    dsevents.setGame(name);   // (re)point the shared dataset-change bus (drives node refresh + flow blobs)
    initFlow(name);   // (re)point the flow-blob stream at this game (clears any prior blobs)
    hub.kick();   // new game -> beat the hub so every panel re-reflects its state now
    setStatus(`loaded ${name}`);
}

$("gameSelect").addEventListener("change", async (e) => {
    await loadGame(e.target.value);
    await bootSettle();   // let the reopened images' cached reads drain, then re-OCR fresh on edits
    boot.phase = false;
});
// Mint a blank game profile. Called from the settings modal's "new game" section.
function createGame(name) {
    name = (name || "").trim();
    if (!name) { setStatus("enter a name"); return false; }
    model.load({ name, process_names: [], window_title_hint: null, fields: [], windows: [] });
    pos.clear(); nodeEls.clear(); $("gnodes").replaceChildren();
    render(); autosave(null);
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

buildStats();
$("statsBtn")?.classList.toggle("active", statsState.visible);
$("statsBtn")?.addEventListener("click", () => statsWin.setVisible(!statsState.visible, true));

buildDBStruct();
$("dbstructBtn")?.classList.toggle("active", dbState.visible);
$("dbstructBtn")?.addEventListener("click", () => dbWin.setVisible(!dbState.visible, true));

// edit-history panel: the node graph's own history (independent of Pretty's). Reads the graph
// `hist` instance; clicking a row travels there. Session-only geometry like the other panels.
const histState = { visible: false, x: null, y: null, w: 300, h: null, collapsed: false };
const histWin = createHistoryPanel({
    hist, id: "history", title: "edit history", state: histState,
    onPersist: () => persist.layout(),
    onShow: () => $("historyBtn")?.classList.toggle("active", true),
    onHide: () => $("historyBtn")?.classList.toggle("active", false),
});
$("historyBtn")?.classList.toggle("active", histState.visible);
$("historyBtn")?.addEventListener("click", () => histWin.setVisible(!histState.visible, true));

// read-only e2e introspection (playwright), same convention as window.__routes (routing.js).
// `edit` drives the REAL funnel (model mutate + render + autosave -> pushHistory) so the test
// exercises the production path, not the history engine in isolation.
if (typeof window !== "undefined") {
    window.__nodeHistory = {
        state: () => ({ index: hist.index(), len: hist.entries().length, labels: hist.entries().map((e) => e.label) }),
        booting: () => boot.phase,
        datasets: () => model.datasets(),
        edit: (name) => { const id = model.addDataset(name || "e2e_ds"); render(); autosave(null); return id; },
        // layout edit through the REAL funnel (pos update + persist.layout -> recordHistory)
        nodePos: (id) => { const p = pos.get(id); return p ? { x: p.x, y: p.y } : null; },
        moveNode: (id, x, y) => { pos.set(id, { x, y }); render(); persist.layout(); },
        // node SIZE through the real funnel (nodeSizes + persist.layout -> record). offsetWidth/Height
        // are unscaled local layout px.
        nodeSize: (id) => { const el = nodeEls.get(id); return el ? { w: el.offsetWidth, h: el.offsetHeight } : null; },
        resizeNode: (id, w, h) => {
            nodeSizes.set(id, { w, h, custW: true, custH: true, softW: false, softH: false });
            const el = nodeEls.get(id); if (el) { applySavedSize(el, nodeSizes.get(id)); markNodeSized(el, id); }
            persist.layout();
        },
        // vttable column width through the real funnel: write the store, apply live, persist -> record.
        firstTable: () => { const v = liveVTables()[0]; return v && v.columns[0] ? { id: v.id, col: v.columns[0], width: v.widths[v.columns[0]] ?? null } : null; },
        tableWidth: (id, col) => { const v = vtableById(id); return v ? (v.widths[col] ?? null) : null; },
        tableDomWidth: (id, colName) => { const v = vtableById(id); if (!v) return null; const i = v.columns.indexOf(colName); const c = i >= 0 && v.head && v.head.children[i]; return c ? c.offsetWidth : null; },
        tableCols: (id) => { const v = vtableById(id); return v ? v.columns.slice() : null; },
        tableSort: (id) => { const v = vtableById(id); if (!v) return null; return { col: v.sortCol != null ? v.columns[v.sortCol] : null, dir: v.sortDir }; },
        // first VISIBLE row's value for a column — proves the ROWS actually reordered, not just the arrow
        tableFirstRow: (id, colName) => { const v = vtableById(id); if (!v || !v.filtered.length) return null; return v.filtered[0].values[colName] ?? null; },
        setTableSort: (id, colName, dir) => {
            const v = vtableById(id); if (!v) return; const i = v.columns.indexOf(colName); if (i < 0) return;
            v.sortCol = i; v.sortDir = dir; v._sortView(); v._renderHead(); v._render(); v._saveSort();   // real sort-commit path (persists -> records)
        },
        setTableWidth: (id, col, px) => {
            const L = (model.profile.layout = model.profile.layout || {});
            const t = (L.tables = L.tables || {}); const st = (t[id] = t[id] || {}); (st.widths = st.widths || {})[col] = px;
            reapplyPersistedVTables(); persist.layout();
        },
        undo: () => undo(), redo: () => redo(), jump: (i) => hist.jumpTo(i),
    };
}

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
const _PANEL_TOGGLES = { liveBtn: "live", precapBtn: "precap", createBtn: "toolbox", nodemapBtn: "nodemap", nodelistBtn: "nodelist", activityBtn: "activity", testingBtn: "testing", statsBtn: "stats", dbstructBtn: "dbstruct", historyBtn: "history" };
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
const _NODE_PANELS = ["nodemap", "nodelist", "activity", "testing", "stats", "dbstruct", "history", "toolbox", "live", "precap"];
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
// Armed two-click confirm (no blocking dialogs — rule 2), the ONE shared arm helper (rule 7).
// `silent`: don't swap the label to "confirm" — the armed state is signalled by CSS alone (an
// icon-only delete just turns yellow; a "confirm" word would force the empty label wide).
// `resetOnOutside`: disarm on ANY click that isn't this button, or on Escape (instead of the
// default 2.5s auto-disarm) — for a delete sitting in a live list where a stray timeout is worse
// than an explicit dismiss.
function armConfirm(btn, run, { silent = false, resetOnOutside = false } = {}) {
    if (!btn) return;
    // Buttons with an icon keep it in a `.sel-ic` span; only the `.sel-lbl` text arms/disarms so
    // the icon survives (a whole-button textContent swap would wipe the SVG). Plain buttons fall
    // back to button textContent.
    const lbl = btn.querySelector(".sel-lbl");
    const get = () => (lbl ? lbl.textContent : btn.textContent);
    const set = (t) => { if (silent) return; if (lbl) setSelLbl(lbl, t); else btn.textContent = t; };
    let timer = null, offGlobal = null;
    const disarm = () => {
        if (btn.dataset.armed !== "1") return;
        btn.dataset.armed = "0"; set(btn.dataset.label ?? get());
        clearTimeout(timer); offGlobal?.(); offGlobal = null;
    };
    const arm = () => {
        btn.dataset.armed = "1"; btn.dataset.label = get(); set("confirm");
        if (!resetOnOutside) { timer = setTimeout(disarm, 2500); return; }
        // capture phase so we disarm before the outside target handles its own click
        const onDown = (e) => { if (e.target !== btn && !btn.contains(e.target)) disarm(); };
        const onKey = (e) => { if (e.key === "Escape") disarm(); };
        document.addEventListener("pointerdown", onDown, true);
        document.addEventListener("keydown", onKey, true);
        offGlobal = () => { document.removeEventListener("pointerdown", onDown, true); document.removeEventListener("keydown", onKey, true); };
    };
    btn.addEventListener("click", () => {
        if (btn.dataset.armed !== "1") { arm(); return; }
        disarm(); run();
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

// Renaming a graph id (dataset/subset/window/field/item/trigger/producer) repoints its
// structured refs in the profile, but the Pretty doc references ids inside {{token}} strings
// in a separate file — sweep those too so a rename never leaves a stale, empty-resolving token.
model.setRenameHook((r) => { api.repointPretty(model.profile.name, [r]); });

$("selGroupBtn").addEventListener("click", () => groupShortcut());
$("selSubgroupBtn")?.addEventListener("click", () => subgroupShortcut());
$("selSuperBtn")?.addEventListener("click", () => superGroupShortcut());

// Remove every selected node from its group. Mirrors the per-node unlock icon that
// used to live on each node — now one toolbar action over the whole selection.
$("selDetachBtn").addEventListener("click", () => {
    const ids = selectionIds().filter((id) => groups.groupOf(id));
    if (!ids.length) return;
    groups.detachNodes(ids);
    setStatus(`removed ${ids.length} node${ids.length === 1 ? "" : "s"} from group`);
});

// Delete every removable node in the selection. Each goes through removeNode() so undo/redo
// records it, same path the old per-node trash button used. SHARED by the armed toolbar button
// and the Delete/Backspace hotkey so both behave identically (rule 7).
function deleteSelection() {
    const byId = new Map(model.nodes().map((n) => [n.id, n]));
    const targets = selectionIds().map((id) => byId.get(id)).filter((n) => n && isRemovable(n.type));
    if (!targets.length) return;
    for (const n of targets) removeNode(n);   // each renders + autosaves; undo records each
    deselectAll();
}
// Toolbar: armed two-click (rule 2) — a mis-click shouldn't nuke a node. Silent: the yellow
// armed background is the confirm cue; no "confirm" label (keeps the button icon-only).
armConfirm($("selDeleteBtn"), deleteSelection, { silent: true });

// Clone every cloneable node in the selection. Each clone is a full independent copy under a
// fresh non-colliding id; the copies become the new selection so you can drag them off together.
// Non-destructive, so no armed two-click (unlike delete).
const CLONE = {
    window: (n) => model.cloneWindow(n.ref.id),
    dataset: (n) => model.cloneDataset(n.ref),
    subset: (n) => model.cloneSubset(n.ref.id),
    producer: (n) => model.cloneProducer(n.ref.id),
    trigger: (n) => model.cloneTrigger(n.ref.id),
    action: (n) => model.cloneAction(n.ref.id),
    filesource: (n) => model.cloneFileSource(n.ref.id),
    dictionary: (n) => model.cloneDictionary(n.ref.id),
};
const CLONEABLE = new Set(Object.keys(CLONE));
function cloneSelection() {
    const byId = new Map(model.nodes().map((n) => [n.id, n]));
    const targets = selectionIds().map((id) => byId.get(id)).filter((n) => n && CLONEABLE.has(n.type));
    if (!targets.length) return;
    const newIds = targets.map((n) => { const id = CLONE[n.type](n); return id ? nodeIdOfType(n.type, id) : null; }).filter(Boolean);
    render(); autosave(null);
    selected.clear();
    for (const id of newIds) if (nodeEls.has(id)) selected.add(id);
    syncMultiSelect();
    setStatus(`cloned ${targets.length} node${targets.length === 1 ? "" : "s"} — click to place`);
    carryClones(newIds);   // grab the fresh copies onto the cursor; next click/key drops them
}
// After a clone the fresh copies ride the cursor (keeping their relative offsets) until the
// user's next mouse click OR key press, which drops them where they are. That terminating
// event is swallowed (preventDefault + stopPropagation) so the drop click doesn't also
// select/drag a node underneath and a drop key doesn't fire a shortcut.
function carryClones(ids) {
    ids = ids.filter((id) => nodeEls.has(id) && pos.get(id));
    if (!ids.length) return;
    const btn = $("selCloneBtn"); btn?.classList.add("cloning");
    const rect = $("graph").getBoundingClientRect();
    const toWorld = (e) => ({ x: (e.clientX - rect.left - view.panX) / view.zoom, y: (e.clientY - rect.top - view.panY) / view.zoom });
    const lead = pos.get(ids[0]);
    const offs = ids.map((id) => { const p = pos.get(id); return { id, dx: p.x - lead.x, dy: p.y - lead.y }; });
    setDraggingNodes(true, ids);   // freeze routing while the copies float
    for (const id of ids) nodeEls.get(id)?.classList.add("snapping");
    document.body.style.cursor = "grabbing";
    const move = (e) => {
        const w = toWorld(e);
        for (const o of offs) { const p = pos.get(o.id); if (!p) continue; p.x = snap(w.x + o.dx); p.y = snap(w.y + o.dy); positionNode(o.id); }
        requestEdges(); groups.renderGroups();
    };
    const drop = (e) => {
        e.preventDefault(); e.stopPropagation();
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mousedown", drop, true);
        document.removeEventListener("keydown", drop, true);
        document.body.style.cursor = "";
        btn?.classList.remove("cloning");
        for (const id of ids) nodeEls.get(id)?.classList.remove("snapping");
        setDraggingNodes(false);
        flushEdges();
        groups.absorb(ids);   // dropped inside a group box -> join it
        resizeCanvas(); groups.renderGroups(); persist.layout(); renderNodeViews();
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mousedown", drop, true);   // capture: beat node/canvas handlers
    document.addEventListener("keydown", drop, true);
}
$("selCloneBtn").addEventListener("click", cloneSelection);
// entity id -> node id (mirror of the `<type>:<id>` derivation in model.nodes()).
function nodeIdOfType(type, id) { return type === "dataset" ? `ds:${id}` : type === "filesource" ? `src:${id}` : type === "subset" ? `sub:${id}` : type === "window" ? `win:${id}` : type === "dictionary" ? `dict:${id}` : `${type}:${id}`; }

// The current selection the group action operates on: the multi-select set if any,
// else the single focused node.
function selectionIds() {
    if (selected.size) return [...selected].filter((id) => nodeEls.has(id));
    if (selectedNodeId && nodeEls.has(selectedNodeId)) return [selectedNodeId];
    return [];
}

// Group/ungroup the selection. Backs the toolbar group button:
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
        if (sg) setStatus(`super-grouped ${sg.members.length} groups`);
    }
    return true;
}

// Sub-group the selection inside its (single) parent group, with the SAME ruleset groups use:
//   • 1 node in a subgroup            -> detach it
//   • 2+, all in ONE subgroup, some loose -> add the loose ones
//   • 2+, all in ONE subgroup, none loose -> dissolve the subgroup
//   • otherwise                       -> form a new subgroup
function subgroupShortcut() {
    const ids = selectionIds();
    if (!subOfferable(ids)) { setStatus("subgroup: select nodes that share one group"); return; }
    const subs = new Set(ids.map((id) => groups.subgroupOf(id)).filter(Boolean));
    const loose = ids.filter((id) => !groups.subgroupOf(id));
    if (subs.size === 1) {
        const sg = [...subs][0];
        if (loose.length) { groups.addToSubgroup(sg.id, loose); setStatus(`added ${loose.length} to subgroup`); }
        else { groups.detachFromSub(ids); setStatus("subgroup dissolved"); }
    } else {
        const sg = groups.createSubgroup(ids);
        if (sg) { setStatus(`sub-grouped ${sg.members.length} node${sg.members.length === 1 ? "" : "s"}`); }
        else setStatus("subgroup: nodes must share one group");
    }
}

function groupShortcut() {
    if (groups.selectedGroupIds().length) { superGroupShortcut(); return; }   // groups selected -> super-group them
    const ids = selectionIds();
    if (!ids.length) return;
    if (ids.length === 1) {
        if (groups.groupOf(ids[0])) { groups.detachNode(ids[0]); setStatus("removed from group"); }
        else { const g = groups.createGroup(ids); if (g) setStatus("grouped 1 node"); }   // a group of one is allowed
        return;
    }
    const gset = new Set(ids.map((id) => groups.groupOf(id)).filter(Boolean));   // distinct groups in the selection
    const ungrouped = ids.filter((id) => !groups.groupOf(id));
    if (gset.size === 1) {
        const g = [...gset][0];
        if (ungrouped.length) { groups.addToGroup(g.id, ungrouped); setStatus(`added ${ungrouped.length} to group`); }
        else { groups.detachNodes(ids); setStatus("ungrouped"); }
    } else {
        const g = groups.createGroup(ids);   // pulls members out of any prior group
        if (g) setStatus(`grouped ${g.members.length} nodes`);
    }
}
$("selClearBtn").addEventListener("click", () => deselectAll());
// Settings modal (cog): new-game creation, OCR controls, and a backups section — all
// built fresh per-open and wired here (no persistent holder; the modal owns its DOM).
$("settingsBtn")?.addEventListener("click", () => {
    const wrap = h("div", { class: "settings" },
        h("section", { class: "set-sec" },
            h("h4", "general"),
            h("div", { class: "set-row" },
                h("input", { id: "newGameName", placeholder: "new game name" }),
                h("button", { id: "newGameBtn" }, "create"))),
        h("section", { class: "set-sec" },
            h("h4", "capture"),
            // Capture is a per-grab focus switch: a foreground grabber (game on top) and a
            // background grabber (occluded). Set both the same for single-backend capture.
            h("label", { class: "set-row", title: "How frames are grabbed while the game IS the focused window — cheapest wins (MSS: CPU BitBlt, no GPU). Options come from the live registry." },
                h("span", "foreground"),
                h("select", { id: "captureFg" })),
            h("label", { class: "set-row", title: "How frames are grabbed while the game is backgrounded/occluded — must read the window's own surface (PrintWindow: GPU-light, re-renders; WGC: GPU-streamed, no re-render). Set the same as foreground for single-backend capture." },
                h("span", "background"),
                h("select", { id: "captureBg" }))),
        h("section", { class: "set-sec" },
            h("h4", "OCR"),
            h("label", { class: "set-row", title: "OCR device — GPU needs onnxruntime-gpu + CUDA. Auto: CPU for editing, GPU for the precapture batch." },
                h("span", "device"),
                h("select", { id: "ocrDevice" },
                    h("option", { value: "auto" }, "Auto (CPU; GPU for precapture)"),
                    h("option", { value: "cpu" }, "CPU"),
                    h("option", { value: "gpu" }, "GPU"))),
            // Where OCR inference ACTUALLY runs. The device select above is the CUDA cpu/gpu
            // MODE; it reads "cpu" even when OCR runs on a non-NVIDIA GPU via DirectML (the
            // iGPU path), which is confusing — this line states the real compute target.
            h("div", { class: "set-row muted", id: "ocrComputeRow", hidden: true, title: "The inference engine + adapter OCR is running on right now." },
                h("span", "running on"),
                h("span", { id: "ocrComputeLbl" }, "")),
            // Backend-specific knobs: hidden until the server reports the engine has them.
            h("label", { class: "set-row", id: "ocrEngineRow", hidden: true, title: "Inference engine for the ppocr5 OCR backend. OpenVINO is often the faster CPU path on Intel; only installed runtimes are listed. Takes effect on the next read (model rebuilds lazily)." },
                h("span", "engine"),
                h("select", { id: "ocrEngine" })),
            h("label", { class: "set-row", id: "ocrThreadsRow", hidden: true, title: "CPU threads each OCR inference may use. 0 = one per core (fastest reads, starves a running game); low values keep reads polite at some latency cost. Takes effect on the next read." },
                h("span", "cpu threads"),
                h("input", { id: "ocrThreads", type: "number", min: "0", max: "64", step: "1" })),
            // Detection downscale — only shown when the live engine has the knob.
            h("label", { class: "set-row", id: "ocrScaleRow", hidden: true, title: "Detection downscale — the DETECTION pass is the biggest single GPU burst per read; ½ = a quarter of the detect pixels = a much shorter stall. Recognition still crops from the full-detail frame, so text quality holds. Applies live to a running collector." },
                h("span", "downscale"),
                h("select", { id: "ocrScale" },
                    h("option", { value: "1" }, "1× full"),
                    h("option", { value: "2" }, "1/2 (1/4 px)"),
                    h("option", { value: "4" }, "1/4 (1/16 px)"))),
            h("label", { class: "set-row", id: "ocrGpuMemRow", hidden: true, title: "Hard VRAM ceiling (GB) for the GPU OCR session — it can never hold more than this. Too low and a big detect fails to allocate; 3 clears real 4K workloads. Applies on the next GPU session build." },
                h("span", "gpu mem cap (GB)"),
                h("input", { id: "ocrGpuMem", type: "number", min: "0.5", max: "64", step: "0.5" }))),
        h("section", { class: "set-sec" },
            h("h4", "live collection"),
            h("label", { class: "set-row", title: "Frame limiter — minimum milliseconds between collector reads. 0 (or blank) = as fast as possible (more CPU/GPU). Persists across restarts; a running collector restarts in place so it applies immediately." },
                h("span", "frame limit (ms)"),
                h("input", { id: "liveLimit", type: "number", min: "0", step: "10", placeholder: "0" }))),
        h("section", { class: "set-sec set-backups" }, h("h4", "backups"), h("div")));

    const name = model.profile.name;
    const handle = openModal({ title: "settings", size: "medium", node: wrap });

    // new game
    const ngName = wrap.querySelector("#newGameName");
    const submitGame = () => { if (createGame(ngName.value)) handle.close(); };
    wrap.querySelector("#newGameBtn").addEventListener("click", submitGame);
    ngName.addEventListener("keydown", (e) => { if (e.key === "Enter") submitGame(); });

    // capture backend
    wireCaptureControls(wrap);

    // OCR device + downscale
    wireOcrControls(wrap);

    // live frame limiter — persisted server-side; a running collector restarts in place so it
    // applies immediately (applyLiveInterval, exported by livewin, owns that restart).
    const limIn = wrap.querySelector("#liveLimit");
    if (limIn) {
        api.live.getInterval(handle.signal).then((r) => {
            const ms = Math.round((r.interval || 0) * 1000);
            limIn.value = ms > 0 ? String(ms) : "";
        }).catch(() => {});
        limIn.addEventListener("change", async () => {
            const ms = parseFloat(limIn.value);
            const secs = Number.isFinite(ms) && ms > 0 ? ms / 1000 : 0;
            if (secs === 0) limIn.value = "";
            const done = timed(`live frame limit → ${secs ? Math.round(secs * 1000) + "ms" : "off"}`);
            try { const r = await api.live.setInterval(secs); await applyLiveInterval(r.interval); done(); }
            catch (e) { done(String(e.message || e), "err"); }
        });
    }

    // backups (restoring re-saves the backup live -> reload it fresh)
    const bkHost = wrap.querySelector(".set-backups > div");
    if (name) {
        buildBackups(bkHost, name, {
            onRestored: () => { loadGame(name); setStatus("restored backup"); },
            signal: handle.signal, close: handle.close,
        });
    } else {
        bkHost.replaceChildren(h("div", { class: "muted bk-pad" }, "load a game to see its backups"));
    }
});
// Right-drag pans from ANYWHERE over the graph, incl. over inputs/selects/textareas. CAPTURE
// phase on window so it runs before any descendant's mousedown — a meter bar / group cog /
// resize grip / form control that stopPropagation()s the press can no longer swallow the pan.
// Don't preventDefault — a plain right click must still open the native context menu; only an
// actual drag suppresses it (startPan sets suppressNextMenu, read by the contextmenu handler).
window.addEventListener("mousedown", (ev) => {
    if (ev.button !== 2) return;
    if (!ev.target.closest("#graph")) return;
    const cleared = clearTools();   // right-click disarms any draw tool
    // a click (not just a drag) that just disarmed a tool must also suppress the upcoming
    // contextmenu — else the native/add-node menu pops up right after, over the canvas.
    startPan(ev, { forceSuppress: cleared });
}, true);
$("graph").addEventListener("mousedown", (ev) => {
    // left-drag on empty canvas: rubber-band multi-select (a plain click clears).
    if (ev.button === 0 && !ev.target.closest(".gnode, .ggroup")) startMarquee(ev);
});
// Click-outside disarms the draw tool: a left press anywhere NOT inside a drawing surface (its
// canvas or its own toolbar/compose controls) drops the armed tool. Capture phase so it runs
// before the canvas's own mousedown (which stops propagation) — a press ON the canvas is inside a
// toolhost, so it's kept and draws; a press on the surface's buttons (glyph save, item fields) is
// also inside, so it's kept; anything else clears. Central, tool-agnostic (rule 7).
document.addEventListener("mousedown", (ev) => {
    if (ev.button !== 0) return;   // right-click is handled on the graph mousedown above
    if (ev.target.closest("[data-toolhost]")) return;
    clearTools();
}, true);
// double-click a group's BACKGROUND (or a super group's) → frame it. The group box is
// pointer-events:none so single clicks/drags fall through to the canvas (pan/marquee); we
// hit-test the dblclick against the world rects instead. Innermost (smallest) wins, so a
// group inside a super group frames the group. Node dblclick is handled on the node itself.
$("graph").addEventListener("dblclick", (ev) => {
    if (ev.target.closest(".gnode")) return;
    // a control living on a group box (title input, group/ungroup + colour buttons) must not
    // double as a canvas zoom target — only an empty box double-click frames the group.
    if (ev.target.closest("button, input, select, textarea, a")) return;
    const box = $("graph").getBoundingClientRect();
    const wx = (ev.clientX - box.left - view.panX) / view.zoom;
    const wy = (ev.clientY - box.top - view.panY) / view.zoom;
    const inside = (b) => wx >= b.x && wx <= b.x + b.w && wy >= b.y && wy <= b.y + b.h;
    let hit = null;
    for (const gb of [...(groups.superGroupBoxes?.() || []), ...groups.groupBoxes(), ...(groups.subGroupBoxes?.() || [])])
        if (inside(gb.box) && (!hit || gb.box.w * gb.box.h < hit.box.w * hit.box.h)) hit = gb;
    if (hit) panZoomToRect(hit.box, { onlyIn: true });
});

// Rubber-band selection: drag a rectangle on empty canvas to select every node it
// touches. Highlights live; commits on release. A press with no drag clears selection.
function startMarquee(ev) {
    // ctrl/cmd-marquee is ADDITIVE: it toggles every caught node against the EXISTING selection
    // (nodes already selected get removed, fresh ones added) instead of replacing it.
    const additive = ev.ctrlKey || ev.metaKey;
    const base = new Set(selectionIds());
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
        // additive keeps the prior selection on-screen; plain replace clears it on first drag
        if (!moved) { moved = true; el.hidden = false; if (!additive) deselectAll(); }
        const left = Math.min(s.x, _mx) - box.left, top = Math.min(s.y, _my) - box.top;
        el.style.left = `${left}px`; el.style.top = `${top}px`;
        el.style.width = `${Math.abs(_mx - s.x)}px`; el.style.height = `${Math.abs(_my - s.y)}px`;
        const hit = new Set(caught());
        // additive: a node is lit when membership in base XOR the marquee differs (toggle)
        for (const [id, nel] of nodeEls)
            nel.classList.toggle("multisel", additive ? (base.has(id) !== hit.has(id)) : hit.has(id));
    };
    const onUp = () => {
        document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp);
        el.hidden = true;
        if (moved) {
            const hit = new Set(caught());
            setMultiSelect(additive ? [...nodeEls.keys()].filter((id) => base.has(id) !== hit.has(id)) : [...hit]);
        } else if (!additive) deselectAll();   // ctrl-click on empty canvas keeps the selection
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
}
// Suppress on window (capture) not #graph: a pan tracks via document mousemove, so the
// release — and thus the native contextmenu — can land on a node panel, modal, or even
// outside #graph, where a graph-scoped listener would never see it.
window.addEventListener("contextmenu", (ev) => {
    if (consumePanSuppress()) { ev.preventDefault(); return; }   // a pan-drag just ended
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
    // A menu-created node spawns UNGROUPED. The menu can only open over empty canvas (the early
    // return above skips .gnode/.ggroup, and group boxes are pointer-events:none), so a click never
    // lands on a group MEMBER — the only geometric hit was a group's invisible bbox GAP, which
    // silently absorbed the new node into a group the user didn't aim at. Drag a node into a group
    // to add it (groups.absorb on drop); creation no longer joins by geometry.
    const ready = () => { if (model.profile.name) return true; setStatus("load a game first"); return false; };
    // icons AND tints come from the ONE shared source keyed by type id — the glyph via iconFor and
    // the colour via that type's own node var (--nt-<type>, the same token graph.css maps onto the
    // node's --nt). So a menu row always reads in the exact glyph + colour of the node it mints and
    // can never drift from it (rule 7). Add a node type = add one row here, nothing else.
    const ADD_ITEMS = [
        ["window", "window", createWindowNode],
        ["dataset", "dataset", createDatasetNode],
        ["subset", "subset", createSubsetNode],
        ["producer", "producer", createProducerNode],
        ["filesource", "file source", createFileSourceNode],
        ["trigger", "trigger", createTriggerNode],
        ["toast", "toast", createToastNode],
        ["sound", "sound", createSoundNode],
        ["action", "action", createActionNode],
        ["register", "register", createRegisterNode],
        ["dictionary", "dictionary", createDictionaryNode],
    ];
    openContextMenu(ev.clientX, ev.clientY, ADD_ITEMS.map(([type, title, make]) => ({
        icon: iconFor(type), title, tint: `var(--nt-${type})`,
        onClick: () => ready() && make(at),
    })));
}, true);
$("graph").addEventListener("wheel", onWheel, { passive: false });
// any user action cancels an in-flight smooth pan-to-new-node
$("graph").addEventListener("pointerdown", cancelPan, true);
$("graph").addEventListener("wheel", cancelPan, { capture: true, passive: true });
window.addEventListener("keydown", cancelPan, true);

// Briefly arm the grid-glide transition for a DISCRETE (keyboard) step. A grip drag holds
// `.snapping` across the whole drag (down..up); a WASD step has no down/up, so add the class and
// drop it once the ~90ms ease has run — re-pressing restarts the timer so a burst keeps gliding.
// Same class + transition as the drag path (rule 7). Timeout slightly > the transition duration.
const _snapTimers = new WeakMap();
function glideStep(el) {
    if (!el) return;
    el.classList.add("snapping");
    clearTimeout(_snapTimers.get(el));
    _snapTimers.set(el, setTimeout(() => el.classList.remove("snapping"), 140));
}

// WASD moves the selected rectangle; Shift+WASD resizes it (A/D width, W/S height).
// Ignored while typing in a field. NUDGE (the shared dir map) is declared at module scope.
const MINB = 0.004;
document.addEventListener("keydown", (ev) => {
    if (prettyActive) return;   // pretty view owns the keyboard (incl. its OWN undo/redo) while up
    if (["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
    // a focused toast-image preview owns WASD for nudging its element — don't also move the node
    if (document.activeElement?.closest?.(".tn-img-pv")) return;
    // Escape disarms any drawing tool (a tool-input's own Escape is handled above — INPUT bails first).
    if (ev.key === "Escape") { if (clearTools()) { ev.preventDefault(); return; } }
    if (ev.ctrlKey || ev.metaKey) {
        const k = ev.key.toLowerCase();
        if (k === "z" && !ev.shiftKey) { ev.preventDefault(); undo(); return; }
        if (k === "y" || (k === "z" && ev.shiftKey)) { ev.preventDefault(); redo(); return; }
    }
    // (no group hotkey: the group/subgroup/super actions live only on the toolbar buttons — the
    // single-key semantics couldn't be pinned down across the three tiers.)
    // Delete: delete the selection (same path as the toolbar button; undo restores).
    // No arm needed — Ctrl+Z brings it back, and a key takes intent the way a stray click doesn't.
    if (ev.key === "Delete" && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
        if (!selectionIds().length) return;
        deleteSelection(); ev.preventDefault(); return;
    }
    // Shift+R: reset any manual resize on every selected node (same as pressing its reset dots —
    // snaps each axis back to its natural content box). Only touches nodes that carry a saved size.
    if (ev.shiftKey && ev.key.toLowerCase() === "r" && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
        if (overlays.get(activeOverlayKey)) return;   // a live box overlay owns the keys
        const selIds = selectionIds().filter((id) => nodeSizes.has(id) && !collapsed.has(id) && nodeEls.has(id));
        for (const id of selIds) {
            const div = nodeEls.get(id);
            const widthOnly = WIDTH_ONLY_NODES.has(nodeTypeOf(id));
            resetNodeAxis(div, id, "w", widthOnly);
            if (!widthOnly) resetNodeAxis(div, id, "h", false);
        }
        if (selIds.length) ev.preventDefault();
        return;
    }
    const dir = NUDGE[ev.key.toLowerCase()];
    if (!dir) return;
    // No active box but a node is selected → WASD moves the NODE one grid step;
    // Shift+WASD resizes it one grid step (A/D width, W/S height) — same grip the drag
    // handle drives, so it persists + redraws edges identically.
    const rec = overlays.get(activeOverlayKey);
    if (!rec) {
        if (ev.shiftKey) {
            // Shift+WASD RESIZES every selected node one grid step (A/D width, W/S height) — same
            // grip the drag handle drives, so each persists + redraws edges identically. Collapsed
            // nodes (header-only) are skipped; widthOnly nodes (item/window) take width only.
            const stepResize = (id) => {
                const el = nodeEls.get(id);
                if (!el || collapsed.has(id)) return false;
                const prev = nodeSizes.get(id) || {};
                if (WIDTH_ONLY_NODES.has(nodeTypeOf(id))) {
                    // item/window wrap a fixed-aspect canvas -> HARD width only, height aspect-driven.
                    if (dir[0]) { el.style.minWidth = ""; el.style.width = `${Math.max(GRID, snap(el.offsetWidth + dir[0] * GRID))}px`; }
                    nodeSizes.set(id, { w: el.offsetWidth, h: el.offsetHeight, softW: false, softH: false, custW: !!dir[0] || !!prev.custW, custH: false });
                } else {
                    // re-apply through the SAME soft-grow/hard-shrink primitive the drag uses — a raw
                    // style.width set is blocked by a prior grow's min-width and silently no-ops.
                    let softW = prev.softW, softH = prev.softH;
                    if (dir[0]) softW = nudgeAxisToGrid(el, "w", Math.max(GRID, snap(el.offsetWidth + dir[0] * GRID)));
                    if (dir[1]) softH = nudgeAxisToGrid(el, "h", Math.max(GRID, snap(el.offsetHeight + dir[1] * GRID)));
                    // only the nudged axis becomes customized (reveals its reset per-axis)
                    nodeSizes.set(id, { w: el.offsetWidth, h: el.offsetHeight, softW, softH, custW: !!dir[0] || !!prev.custW, custH: !!dir[1] || !!prev.custH });
                }
                markNodeSized(el, id);
                return true;
            };
            const selIds = selectionIds().filter((id) => pos.has(id));
            if (selIds.length) {
                let any = false;
                for (const id of selIds) if (stepResize(id)) any = true;
                if (any) {
                    // resize is instant (no glide) → the box is already at its final size, so route +
                    // persist right away; no freeze/settle wait needed.
                    flushEdges();
                    groups.renderGroups();
                    persist.layout();
                }
                ev.preventDefault();
            }
        } else {
            // WASD MOVES the whole selection one grid step (every selected node, not just the focus),
            // mirroring how a multi-select drag moves the set. selectionIds() = the multi-select set
            // if any, else the single focused node.
            const selIds = selectionIds().filter((id) => pos.has(id));
            if (selIds.length) {
                for (const id of selIds) {
                    const p = pos.get(id);
                    p.x = snap(p.x + dir[0] * GRID); p.y = snap(p.y + dir[1] * GRID);
                    const el = nodeEls.get(id); if (el) glideStep(el);
                    positionNode(id);
                }
                drawEdges(); groups.renderGroups(); persist.layout();
                ev.preventDefault();
            }
        }
        return;
    }
    // Otherwise operate on whichever overlay holds the live box selection (window OR item).
    const ov = rec.overlay;
    const b = ov.boxes.find((x) => x.id === ov.activeId);
    if (!b || b.locked) return;   // a locked box (calibrated scrollbar) never nudges
    // Mouse-driven box edits are already blocked while the owning node is busy (the canvas lives
    // inside .gn-body, which CSS locks via pointer-events:none — see .gnode.busy). WASD bypasses
    // that entirely (it's a document keydown, no pointer event involved), so it needs its OWN
    // check here — otherwise a rect on a loading window/item could still be nudged by keyboard.
    const busyId = rec.kind === "window" ? nodeIdOf(rec.winId)
        : rec.kind === "item" ? `item:${rec.winId}:${rec.itemId}`
        : rec.kind === "atlas" ? "atlas" : null;
    if (busyId && busy.get(busyId)) return;
    // step exactly ONE image-native pixel. Use the IMAGE's natural size, NOT canvas.width — the
    // canvas backing is supersampled (up to 8× when zoomed in), so keying off it made a press move
    // a fraction of a pixel that shrank further the more you zoomed, reading as "WASD does nothing".
    const iw = ov.img?.naturalWidth || ov.canvas.width || 1000;
    const ih = ov.img?.naturalHeight || ov.canvas.height || 1000;
    const sx = 1 / iw, sy = 1 / ih;
    if (ev.shiftKey) {
        b.w = Math.min(Math.max(MINB, b.w + dir[0] * sx), 1 - b.x);
        b.h = Math.min(Math.max(MINB, b.h + dir[1] * sy), 1 - b.y);
    } else {
        b.x = Math.min(Math.max(0, b.x + dir[0] * sx), 1 - b.w);
        b.y = Math.min(Math.max(0, b.y + dir[1] * sy), 1 - b.h);
    }
    ov.render();        // reflect the nudge on the overlay immediately
    // A nudge only PAINTS: it joins this surface's rect batch and settles on Enter / ✓ / clicking
    // out (rect_txn.js). Holding W for a second is then one model write, one save, one re-OCR and
    // one undo step — not thirty. The atlas surface has no batch (nothing to re-read), so it keeps
    // writing straight through.
    if (rec.kind === "window" || rec.kind === "item") editBox(activeOverlayKey, b);
    else {
        rec.persist(b); rec.refresh();
        drawEdges(); autosave(rec.winId);
        rectEditCanvasSync(activeOverlayKey);
    }
    ev.preventDefault();
});


// ---- init -----------------------------------------------------------------

// Show the topbar kill-GPU button only while a GPU OCR session is actually LOADED
// (holding VRAM) — `ocr.gpu_active`, not merely "GPU is selected". The heartbeat hub
// pushes the device slice every beat, so the button (re)appears on its own when a read
// rebuilds the GPU session and hides after a kill frees it. Idempotent: touches the DOM
// only on a real change (steady-state ticks mutate nothing).
function syncKillGpu(ocr) {
    const k = $("killGpuBtn"); if (!k) return;
    // A LOADED GPU OCR session — CUDA (gpu_active) OR DirectML (dml_active, e.g. the iGPU).
    // gpu_mem sums this process's dedicated VRAM across adapters, so it already reports the
    // iGPU's footprint; the button frees either session via release().
    const hidden = !(ocr && (ocr.gpu_active || ocr.dml_active));
    if (k.hidden !== hidden) k.hidden = hidden;
    // VRAM readout beside the button: the server process's dedicated GPU memory
    // (gpu_mem, bytes; null when unreadable). Same visibility as the button, and
    // textContent-only updates so steady-state beats mutate nothing.
    const lbl = $("gpuMemLbl"); if (!lbl) return;
    const memHidden = hidden || typeof ocr.gpu_mem !== "number";
    if (lbl.hidden !== memHidden) lbl.hidden = memHidden;
    const txt = memHidden ? "" : fmtBytes(ocr.gpu_mem);
    if (lbl.textContent !== txt) lbl.textContent = txt;
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
    // Live node refresh is PUSH and TARGETED: the bus names exactly which dataset changed, so we
    // refetch THAT dataset's node (data + batches) and every subset reading it DIRECTLY — never gated
    // on refreshLive's /api/flow last_ts diff, which can stick (a stale last_ts) and strand the data
    // tab on old rows while the batches tab — fetched unconditionally — stays correct. A write from
    // ANY path (on_change sweep, live collection, manual edit) thus lands in the tables at once.
    // scheduleRefreshLive still runs for structure/counts (brand-new or removed datasets).
    dsevents.subscribe((dataset) => {
        scheduleRefreshLive();
        if (!dataset) return;
        // Coalesce this dataset + every subset reading it into the batched refresh, so a sweep that
        // touches many datasets (or a rename's change echo) collapses to ONE /flow/details instead
        // of a fetch per node. queueNodeRefresh de-dups against the rename's explicit enqueue too.
        const subs = (model.profile.subsets || [])
            .filter((s) => model.subsetReaches(s.id, dataset)).map((s) => s.id);
        queueNodeRefresh({ datasets: [dataset], subsets: subs });
    });
    // Safety net only: catch any event missed across a stream reconnect. Slow on purpose — the
    // push bus is the mechanism, not this. Skipped while offline (conn.js gates the overlay).
    setInterval(() => { if (model.profile.name && conn.isOnline()) refreshLive(); }, FLOW_FALLBACK_MS);
    try { syncKillGpu(await api.ocr.getDevice()); } catch { /* ignore */ }
}

// Wire the OCR device + downscale selects inside a freshly-built settings modal.
// Friendly labels for the registry backend names; an unknown name falls back to itself,
// so a newly-registered backend still shows (just without a hand-written blurb).
const CAPTURE_LABELS = {
    wgc: "WGC (composited, no re-render)",
    printwindow: "PrintWindow (re-renders window)",
    mss: "MSS (screen region)",
};

async function wireCaptureControls(root) {
    const fgSel = root.querySelector("#captureFg"), bgSel = root.querySelector("#captureBg");
    if (!fgSel || !bgSel) return;
    try {
        const st = await api.captureBackend.getBackend();
        // Both grabbers pick from the same plain-backend list (sub_names).
        const opts = () => (st.sub_names || []).map((n) => h("option", { value: n }, CAPTURE_LABELS[n] || n));
        fgSel.replaceChildren(...opts());
        bgSel.replaceChildren(...opts());
        function sync(s) {
            if (s.foreground) fgSel.value = s.foreground;
            if (s.background) bgSel.value = s.background;
        }
        sync(st);
        const change = async () => {
            const done = timed(`capture: ${fgSel.value} fg / ${bgSel.value} bg`);
            try { sync(await api.captureBackend.setBackend({ foreground: fgSel.value, background: bgSel.value })); done(); }
            catch (e) { done(String(e.message || e), "err"); }
        };
        fgSel.addEventListener("change", change);
        bgSel.addEventListener("change", change);
    } catch { /* ignore */ }
}

async function wireOcrControls(root) {
    const sel = root.querySelector("#ocrDevice");
    if (!sel) return;
    try {
        const st = await api.ocr.getDevice();
        const gpuOpt = sel.querySelector('option[value="gpu"]');
        const autoOpt = sel.querySelector('option[value="auto"]');
        const GPU_LBL = gpuOpt ? gpuOpt.textContent : "GPU";
        const AUTO_LBL = autoOpt ? autoOpt.textContent : "Auto";
        // GPU + Auto need CUDA AND an engine that honours it. No CUDA install -> "(n/a)";
        // an engine that can't use CUDA (OpenVINO runs CPU/iGPU) -> "(n/a: OpenVINO)". Either
        // way the device switch would be a no-op, so grey them out. Re-run when the engine
        // changes (cuda_capable is per-engine).
        function gateDevice(s) {
            const noCuda = !s.gpu_available, noEngine = s.cuda_capable === false;
            if (gpuOpt) {
                gpuOpt.disabled = noCuda || noEngine;
                gpuOpt.textContent = noCuda ? "GPU (n/a)" : noEngine ? "GPU (n/a: OpenVINO)" : GPU_LBL;
            }
            if (autoOpt) {
                autoOpt.disabled = noCuda || noEngine;
                autoOpt.textContent = noEngine ? "Auto (n/a: OpenVINO)" : AUTO_LBL;
            }
        }
        // "running on" line: the ACTUAL compute target, so DirectML (iGPU) never reads as
        // "cpu". Prefers a live session (gpu_active/dml_active); falls back to what the config
        // WILL run on the next read when the lazy session isn't built yet.
        const computeRow = root.querySelector("#ocrComputeRow"), computeLbl = root.querySelector("#ocrComputeLbl");
        function computeTarget(s) {
            if (s.dml_active || s.dml_requested) return "GPU · DirectML" + (s.dml_active ? "" : " (loads on next read)");
            if (s.gpu_active) return "GPU · CUDA";
            if (s.mode === "gpu" && s.gpu_available && s.cuda_capable !== false) return "GPU · CUDA (loads on next read)";
            if (s.engine_type === "openvino") return "CPU / iGPU · OpenVINO";
            return "CPU";
        }
        function syncCompute(s) {
            if (!computeRow || !computeLbl) return;
            const txt = computeTarget(s);
            if (computeLbl.textContent !== txt) computeLbl.textContent = txt;
            if (computeRow.hidden) computeRow.hidden = false;
        }
        gateDevice(st);
        sel.value = st.mode || st.device;   // the select reflects the MODE, not the live device
        syncKillGpu(st);
        syncCompute(st);
        sel.addEventListener("change", async () => {
            const done = timed(`OCR device → ${sel.value}`);
            // Keep the user's pick; only correct it if the server reports a different MODE. (Never
            // fall back to the live device — under "auto" that's cpu and would yank the dropdown.)
            try { const r = await api.ocr.setDevice(sel.value); if (r.mode) sel.value = r.mode; syncKillGpu(r); syncCompute(r); done(); }
            catch (e) { done(String(e.message || e), "err"); }
        });

        // Backend-specific knobs: the state reports null for anything the live engine
        // lacks, so a control only appears when it would actually do something.
        const engRow = root.querySelector("#ocrEngineRow"), engSel = root.querySelector("#ocrEngine");
        if (engRow && st.engine_type && (st.engine_types || []).length) {
            engRow.hidden = false;
            engSel.replaceChildren(...st.engine_types.map((n) => h("option", { value: n }, n)));
            engSel.value = st.engine_type;
            engSel.addEventListener("change", async () => {
                const done = timed(`OCR engine → ${engSel.value}`);
                // GPU/Auto availability is per-engine (OpenVINO can't use CUDA), so re-gate
                // the device select from the fresh state the switch returns.
                try {
                    const r = await api.ocr.setEngineType(engSel.value);
                    if (r.engine_type) engSel.value = r.engine_type;
                    gateDevice(r); syncKillGpu(r); syncCompute(r);
                    done();
                } catch (e) { done(String(e.message || e), "err"); }
            });
        }
        const thRow = root.querySelector("#ocrThreadsRow"), thIn = root.querySelector("#ocrThreads");
        if (thRow && st.threads != null) {
            thRow.hidden = false;
            thIn.value = String(st.threads);
            thIn.addEventListener("change", async () => {
                const done = timed(`OCR cpu threads → ${thIn.value || 0}`);
                try { const r = await api.ocr.setThreads(Math.max(0, parseInt(thIn.value, 10) || 0)); thIn.value = String(r.threads ?? 0); done(); }
                catch (e) { done(String(e.message || e), "err"); }
            });
        }
        const scRow = root.querySelector("#ocrScaleRow"), scSel = root.querySelector("#ocrScale");
        if (scRow && st.scale != null) {   // null => engine has no downscale knob -> stay hidden
            scRow.hidden = false;
            scSel.value = String(st.scale || 1);
            wireOcrScale(scSel);   // shared wiring helper (rule 7)
        }
        const gmRow = root.querySelector("#ocrGpuMemRow"), gmIn = root.querySelector("#ocrGpuMem");
        if (gmRow && st.gpu_mem_gb != null) {
            gmRow.hidden = false;
            gmIn.value = String(st.gpu_mem_gb);
            gmIn.addEventListener("change", async () => {
                const done = timed(`OCR gpu mem cap → ${gmIn.value} GB`);
                try { const r = await api.ocr.setGpuMemGb(parseFloat(gmIn.value) || 3); gmIn.value = String(r.gpu_mem_gb ?? 3); done(); }
                catch (e) { done(String(e.message || e), "err"); }
            });
        }
    } catch { /* ignore */ }
}

// Wire the OCR detection-downscale <select> to its api setter, echoing the server's canonical
// value back into the element. Lives in the settings modal (was the live panel). Caller seeds
// the element's value first; this only attaches the change handler.
function wireOcrScale(el) {
    el.addEventListener("change", async () => {
        const done = timed(`OCR downscale → ${el.value}×`);
        try { const r = await api.ocr.setScale(el.value); el.value = String(r.scale || 1); done(); }
        catch (e) { done(String(e.message || e), "err"); }
    });
}

// ---- debug launch: ?debug=1 skips the slow/heavy boot ceremony ----------------
// A dev/inspect launch that comes up instantly by defaulting every slow-or-noisy boot
// step OFF. Each piece is individually toggleable so you can turn just one back on:
//   /?debug=1                every slow step off (fastest: bare shell, no OCR touched)
//   /?debug=1&load=1         load the game but skip the kill/settle waits + veil/log
//   /?debug=1&settle=1       load AND wait for boot OCR to drain (but no kill/veil/log)
//   /?kill=1&veil=1&...      force any single step back on regardless of debug
// Booleans read "0"/"false" as off, anything else (incl. bare "?veil") as on.
const _dq = new URLSearchParams(location.search);
const _flag = (k, dflt) => { const v = _dq.get(k); return v === null ? dflt : (v !== "0" && v !== "false"); };
const dbg = { on: _flag("debug", false) };
// when debug is on each slow step defaults OFF; `load` stays on (an empty shell is rarely useful).
dbg.kill    = _flag("kill",    !dbg.on);   // kill+await any stray OCR worker from a prior session
dbg.settle  = _flag("settle",  !dbg.on);   // block the veil until the boot OCR round drains (bootSettle)
dbg.veil    = _flag("veil",    !dbg.on);   // full-page boot spinner
dbg.bootlog = _flag("bootlog", !dbg.on);   // expand the log bar + mirror every request during boot
dbg.load    = _flag("load",    true);      // load the selected game at all (off ⇒ empty graph, instant)
if (dbg.on) log(`debug launch: kill=${dbg.kill} settle=${dbg.settle} veil=${dbg.veil} bootlog=${dbg.bootlog} load=${dbg.load}`);

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
        const busy = ocrBusyCount();
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
    const o = h("div", { class: "startup-halt" },
        h("div", { class: "startup-halt-box" },
            h("h3", title),
            lines.map((l) => h("p", { class: l.muted ? "muted" : null }, l.text)),
            h("div", { class: "halt-actions" },
                actions.map((a) => h("button", {
                    class: `startup-halt-retry${a.primary ? "" : " ghost"}`,
                    onClick: () => { o.remove(); a.run(); },
                }, a.label)))));
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
    if (!dbg.veil) veil.drop();   // debug launch: no full-page spinner
    if (dbg.bootlog) setLogOpen(true);   // show the log history during boot so initial-load progress is visible
    // During boot, mirror EVERY api request into the log bar so the initial-load sequence (and any
    // stuck/slow endpoint) is visible live. Cleared once booted so steady state isn't noisy.
    if (dbg.bootlog) api.onApiRequest((ev) => {
        if (booted) return;
        if (ev.phase === "start") log(`→ ${ev.method} ${ev.path}`);
        else log(`${ev.ok ? "✓" : "✗"} ${ev.method} ${ev.path} · ${ev.ms}ms${ev.ok ? "" : " " + (ev.reason || "failed")}`, ev.ok ? undefined : "err");
    });
    // a tripped circuit breaker (an endpoint that kept timing out) surfaces here so the user learns
    // why a panel went quiet — it auto-recovers when the endpoint responds again.
    if (!window._apiGuardWired) { window._apiGuardWired = true; window.addEventListener("api-guard", (e) => { setStatus(String(e.detail)); log(String(e.detail), "err"); }); }
    if (dbg.kill) try {
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
        model.sounds = await api.sounds.list().catch(() => []);   // trigger-sound picker options (global, once)
        if (dbg.load && $("gameSelect").value) await loadGame($("gameSelect").value);
        // ?view=pretty (the desktop window passes it) boots into the pretty dashboard;
        // a plain browser has no param and stays on the node view.
        if (new URLSearchParams(location.search).get("view") === "pretty") setPrettyView(true);
        initKillGpu();
        hub.init(() => model.profile.name);   // single backend heartbeat for every panel
        hub.start();
        log("first read…");
        if (dbg.settle) await bootSettle();
        boot.phase = false;   // boot OCR drained -> later reads/edits re-OCR fresh (cache write-through)
    } catch (e) {
        if (!conn.isOnline()) { veil.drop(); return; }   // dropped mid-boot -> offline overlay handles it
        log(String(e.message || e), "err");   // boot hiccup: show the page anyway
    }
    booted = true;
    api.onApiRequest(null);   // stop mirroring requests into the log bar (boot done)
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
    focusNode, autosave, placeNewNode, render,
    collectLayout, hydrateNodeLayout, reconcileOpenImages, reapplyNodeSizes,   // used by history.js restore
    refreshLive, subsetParts, wireOcrScale,
    refreshAllSubsetNodes, refreshDatasetConsumers,
    rebuildNode, setNodeBusy, withBusy, registerOverlay, unregisterOverlay,
    overlaySelected, syncCellSize, itemChanged,
    addFieldToItemGroup, addTellToItemGroup, inheritGroupFrom,
    refreshItemTemplateRefs,
};
