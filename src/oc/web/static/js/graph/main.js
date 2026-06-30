// Node-view home: edit a game's structure as a graph (Game → Windows → Fields →
// Datasets), drag to arrange, drag-wire a window to a dataset, edit inline, and
// watch live dataset counts. Box drawing stays on the canvas (ui.html link).
import * as api from "../api.js";
import * as conn from "../conn.js";
import * as hub from "../hub.js";
import { h, frag, svg, TRASH, labCell } from "../dom.js";
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
import { setVTableStore } from "../vtable.js";
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
    itemReads, prevPresent, prevLastTs, dsTab, clearGrid, nw, nh, boot,
} from "./state.js";
import {
    drawEdges, requestEdges, flushEdges, nodeRect, freezeRouting,
    setDraggingNodes,
} from "./routing.js";
import { initFlow } from "./flow.js";
import {
    cancelPan, panTo, panZoomTo, panZoomToRect, zoomToNode, viewportCenterWorld,
    applyView, resizeCanvas, onWheel, startPan, consumePanSuppress,
} from "./camera.js";
import { movePos, moveWindowPos, moveItemPos, renameNode, forgetNodeState } from "./node_lifecycle.js";
import { nodeParts, windowControls, itemLists, _colOpts, satToggleBtn, slideToggle, vtShowRemoved } from "./node_parts.js";
import * as dsevents from "./dsevents.js";
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
    createDatasetNode, createSubsetNode,
} from "./panels/toolbox.js";
import { openContextMenu } from "../ctxmenu.js";
import {
    vtables, vtableFor, refreshDataNode, refreshDatasetNode, expandSubsetRow,
    batchesState, batEls, loadBatchesNode,
} from "./panels/datanodes.js";
import {
    pc, pcState, buildPrecap,
} from "./panels/precap.js";
import { pushHistory, resetHistory, undo, redo } from "./history.js";
import { workers, unregisterWorker } from "./workers.js";
import {
    closeImage, openImage,
    closeItemImage, setItemCellKeepingChildren, openItemImage, refreshItemBoxes,
    scheduleItemRead, itemReadout,
    previewBusy, previewAgain,
    commitPreviewNode,
    detectBusy, detectAgain, _detectPending,
    _detectAll, refreshOpenDetect, _previewPending, _previewAll, refreshOpenPreviews,
    refreshImageBoxes, refreshGridPreview, selectRegionNode,
} from "./imaging.js";
import {
    liveWin, liveWinState, buildLiveWindow, renderLiveWindow, syncLiveFromServer,
} from "./panels/livewin.js";

const COLX = { game: 20, window: 300, filesource: 460, trigger: 560, producer: 700, preview: 1580, region: 600, detect: 600, state: 600, scrollbar: 600, item: 600, itemfield: 850, itemtell: 1080, dataset: 900, subset: 1900, vttable: 2300, dictionary: 20 };
// Nodes resized on the WIDTH axis only — height always fits content (never stamped/restored).
// item/window wrap a fixed-aspect canvas; dataset/subset/price are config-only, reworked often
// with visibility-toggleable inputs, so a frozen height would clip or leave dead space.
// Only the fixed-aspect canvas nodes are width-only (height follows their image aspect).
// Every other node — incl. the config nodes (dataset/subset/producer) — is freely resizable.
const WIDTH_ONLY_NODES = new Set(["item", "window"]);
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

// autosave(changed): persist the profile, then re-run detect/OCR ONLY for the window the edit
// can affect — resolved by following the graph (model.windowOf). Pass the edited node's id (a
// window id, or any reg/det/sb/item/fld/tell id under it). A data-plane node id (ds/sub/
// producer/src/trigger/dict) or null/omitted resolves to no window -> nothing re-fires. This
// is the safe default: a forgotten arg persists only, it can never fan out to all windows.
// A genuine all-windows refresh (image load/recapture/page nav) calls refreshOpen*(null)
// DIRECTLY (imaging.js) — autosave is no longer one of those callers.
function autosave(changed = null) {
    if (!model.profile.name) return;
    persist.content();                 // debounced profile save; onContentSaved fires on success
    const win = model.windowOf(changed);
    if (win) {                         // edit lies in this window's subgraph -> re-read just it
        refreshOpenPreviews(win);
        refreshOpenDetect(win);
    }
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
        if (sz) { n.w = sz.w; n.h = sz.h; }
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
    // floating panels are NOT persisted (session-only) — drop any stale saved state so it's
    // cleaned from the profile on the next write.
    delete L.float_windows;
}
function hydrateLayout() {
    pos.clear(); nodeSizes.clear(); collapsed.clear();
    const L = model.profile.layout || {};
    for (const [id, n] of Object.entries(L.nodes || {})) {
        if (Number.isFinite(n.x) && Number.isFinite(n.y)) pos.set(id, { x: n.x, y: n.y });
        // >0, not just finite: a legacy 0,0 (from the old zero-box settle bug) means "no saved
        // size" — storing it would block the real size from ever applying (0 is falsy downstream).
        if (n.w > 0 && n.h > 0) nodeSizes.set(id, { w: n.w, h: n.h });
        if (n.collapsed) collapsed.add(id);
    }
    pendingOpenImages = [...(L.open_images || [])];
    model.setSatellites(L.satellites);     // restore which preview / vt-table followers are shown
    groups.hydrate(L.groups);
    groups.hydrateSuper(L.super_groups);   // after groups (super groups reference group ids)
    groups.hydrateSub(L.sub_groups);       // after groups (sub groups reference a parent group + its nodes)
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
const _TYPE_BY_PREFIX = { win: "window", prev: "preview", vt: "vttable", reg: "region", det: "detect", sb: "scrollbar", item: "item", fld: "itemfield", tell: "itemtell", ds: "dataset", sub: "subset", producer: "producer", trigger: "trigger", dict: "dictionary" };
function nodeTypeOf(id) { return id === "game" ? "game" : (_TYPE_BY_PREFIX[id.split(":")[0]] || null); }
groups.initGroups({
    world: () => $("ggroups"),
    superWorld: () => $("sgroups"),
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
    zoomToGroup: (gid) => { const gb = groups.groupBoxes().find((b) => b.id === gid); if (gb) panZoomToRect(gb.box); },
    // drag the group's resize grip → scale its members, gaps intact
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
const G = snapUp;   // group-scale sizes round UP too, so a scaled node never clips its content
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





// Keep the cell-size inputs in sync after a canvas cell-resize (which doesn't rebuild the node).
function syncCellSize(winId, itemId) {
    const node = nodeEls.get(`item:${winId}:${itemId}`), it = model.item(winId, itemId);
    if (!node || !it || !it.box) return;
    for (const k of ["w", "h"]) {
        const inp = node.querySelector(`.csize[data-k="${k}"]`);
        if (inp && document.activeElement !== inp) inp.value = +(+it.box[k]).toFixed(4);
    }
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
    div.querySelector(".gi-id").addEventListener("change", (e) => {
        renameNode(e.target, itemId,
            () => model.renameItem(winId, itemId, e.target.value.trim()),
            () => moveItemPos(winId, itemId, n.ref.id),   // carry the item AND its field/tell child nodes (no jump)
            () => itemChanged(winId, n.ref.id, { render: true, reread: false }));   // id only — no pixels/boxes change
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
        if (out && rd) out.replaceChildren(itemReadout(rd, winId, itemId));
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
        render(); autosave(null);
        if (wasOpen) await openImage(newId);    // restore the image against the moved binding
    });
    div.querySelector(".winlive")?.addEventListener("change", (e) => {
        model.setWindowLive(n.ref.id, e.target.checked);
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
    // detects section: combine mode + per-detector polarity. Both change the live verdict, so
    // autosave(winId) re-runs detect for ONLY this window (refreshes .wd-status/.wd-verdict).
    div.querySelector(".wd-mode")?.addEventListener("change", (e) => {
        model.setDetectMode(n.ref.id, e.target.value); autosave(n.ref.id);
    });
    div.querySelectorAll(".wd-neg").forEach((sel) => sel.addEventListener("change", (e) => {
        model.setDetectNegate(n.ref.id, e.target.dataset.id, e.target.value === "absent"); autosave(n.ref.id);
    }));
    // click a detect name -> jump to its detect node (where its text/threshold live)
    div.querySelectorAll(".wd-row .wd-name").forEach((el) => el.addEventListener("click", () => {
        panZoomTo(`det:${n.ref.id}:${el.closest(".wd-row").dataset.id}`);
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


// how a key's many observations collapse to one displayed value (matches the backend)
const AGGREGATES = ["latest", "first", "sum", "mean", "max", "min", "all"];
// friendly labels for the "many →" options (value stays the policy string)
const AGG_LABEL = { all: "all (no collapse)" };


// ---- subset node: join one or more datasets, then filter/derive/sort ----------

const SUB_OPS = ["contains", "icontains", "eq", "ne", "nonempty", "empty", "gt", "lt", "gte", "lte", "regex"];



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
    // source header spans BOTH grid columns (gspan), a full-width band above its settings
    const rows = [h("span", { class: "lab lab-top gspan sv-src-h", title: "this source's settings" }, ds)];
    // "many ->" is the read/collapse policy, NOT a join input — render it FIRST, above the join config,
    // so it doesn't read as a join knob.
    if (showAgg) {
        const aggOpts = AGGREGATES.map((a) => h("option", { value: a, selected: a === model.sourceAggregate(s.id, ds) }, AGG_LABEL[a] || a));
        rows.push(labCell("many →", "how this source's many observations collapse to one value"),
            h("select", { class: "sv-sagg", dataset: { ds } }, aggOpts));
    }
    if (joined) {
        const joinOpts = [h("option", { value: "", selected: !jf }, "(no join)"),
            ...[...new Set([jf, ...cols])].filter(Boolean).map((c) => h("option", { value: c, selected: c === jf }, c))];
        rows.push(labCell("join on", "this source's column used as the join key; (no join) stacks its rows"),
            h("select", { class: "sv-sjoin", dataset: { ds } }, joinOpts));
        if (jf) {
            rows.push(labCell("required", "key must exist in this source (inner-style); off = optional outer fill"),
                h("label", { class: "flab" }, h("input", { type: "checkbox", class: "sv-sreq", dataset: { ds }, checked: !!src.required })));
            const jn = model.sourceJoinNorm(s.id, ds);
            const ckRow = (lbl, title, cls, on) => frag(labCell(lbl, title),
                h("label", { class: "flab" }, h("input", { type: "checkbox", class: cls, dataset: { ds }, checked: !!on })));
            rows.push(
                ckRow("ignore case", "fold case before matching", "sn-ci", jn.case_insensitive),
                ckRow("strip punctuation", "drop punctuation (collapse to spaces)", "sn-punct", jn.strip_punct),
                ckRow("collapse spaces", "runs of whitespace -> one space, trimmed", "sn-ws", jn.collapse_ws),
                labCell("drop words", "whole words removed from this side; space- or comma-separated"),
                h("input", { type: "text", class: "sn-words", dataset: { ds }, value: (jn.strip_words || []).join(" "), placeholder: "e.g. relic" }));
            // live worked example: a REAL sample join value from this source, transformed by the knobs
            // above. Filled async (fillNormSamples) since the sample is fetched; updates in place as the
            // knobs change. Shows a "no data" note when the source has no value to preview.
            rows.push(labCell("example", "how these settings canonicalise a real join value from this source"),
                h("span", { class: "sv-norm-eg", dataset: { ds, jf } }, h("span", { class: "muted" }, "loading…")));
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
    if (el._sample === undefined) { el.replaceChildren(h("span", { class: "muted" }, "loading example…")); return; }
    if (el._sample === null) { el.replaceChildren(h("span", { class: "muted" }, `no ${el.dataset.jf} data to preview`)); return; }
    el.replaceChildren(`${el._sample} → ${normPreview(jn, el._sample) || "∅"}`);
}

// Fetch a real sample join value for every source's worked example, then render each. The sample is
// the first non-empty value in the source's join column (its own rows for a dataset, computed rows
// for a subset). Failures / empty sources resolve to the "no data" state, never an error.
async function fillNormSamples(div, s) {
    const game = encodeURIComponent(model.profile.name);
    await Promise.all([...div.querySelectorAll(".sv-norm-eg")].map(async (el) => {
        const ds = el.dataset.ds, jf = el.dataset.jf;
        let sample = null;
        try {
            const isView = !!model.subsetDef(ds);
            // boot batch already carries every source's rows — sample from it (no extra fetch); the
            // live path (post-boot edits) has no prefetch and fetches the one source it needs.
            const cached = isView ? _bootDetails?.subsets?.[ds] : _bootDetails?.datasets?.[ds];
            const data = cached || await (await fetch(`/api/flow/${game}/${isView ? "subset" : "dataset"}/${encodeURIComponent(ds)}`)).json();
            const recs = isView ? (data.rows || []) : (data.records || []);
            for (const r of recs) { const v = r[jf]; if (v != null && String(v).trim() !== "") { sample = String(v); break; } }
        } catch { /* leave null -> "no data" */ }
        el._sample = sample;
        renderNormEg(el, s.id);
    }));
}

function subConfigNode(s) {
    const cols = viewColumns(s);
    const inputs = model.subsetInputs(s);
    const free = model.joinableInputs(s);   // datasets + other subsets (cycle-free)
    // sources are removable pills; the "+ join source" select sits on the SAME row as them
    const chips = inputs.map((d) => h("span", { class: "sv-input" }, d,
        h("button", { class: "sv-rmin danger", dataset: { ds: d }, title: "remove input" }, TRASH())));
    const addOpts = [h("option", { value: "" }, "+ join source"), free.map((d) => h("option", d))];
    // join is PER-SOURCE now: each input carries its own join column, match-norm, many->one
    // collapse, and required flag (see model JoinSource). One config block per source.
    const joined = inputs.length > 1;
    const srcCfgs = inputs.map((ds) => sourceCfgNode(s, ds, joined)).filter(Boolean);
    const filters = (s.filters || []).map((f, i) => h("div", { class: "sub-row", dataset: { i } },
        h("select", { class: "sf-field", dataset: { i } }, _colOpts(cols, f.field)),
        h("select", { class: "sf-op", dataset: { i } }, SUB_OPS.map((o) => h("option", { selected: o === f.op }, o))),
        h("input", { class: "sf-val", dataset: { i }, value: f.value || "", placeholder: "value" }),
        h("button", { class: "sf-del danger", dataset: { i }, title: "remove filter" }, TRASH())));
    const derived = (s.derived || []).map((d, i) => h("div", { class: "sub-row", dataset: { i } },
        h("input", { class: "sd-name", dataset: { i }, value: d.name || "", placeholder: "new column" }),
        h("span", { class: "muted" }, "="),
        h("input", { class: "sd-tpl", dataset: { i }, value: d.template || "", placeholder: "{=count*price_median} plat" }),
        h("button", { class: "sd-del danger", dataset: { i }, title: "remove column" }, TRASH())));
    // multi-column sort: primary row first, each a column + direction; applied before limit
    const sortRows = (s.sort || []).map((so, i) => h("div", { class: "sub-row", dataset: { i } },
        h("select", { class: "ss-field", dataset: { i } }, _colOpts(cols, so.field)),
        h("select", { class: "ss-dir", dataset: { i } },
            h("option", { value: "asc", selected: !so.desc }, "asc"),
            h("option", { value: "desc", selected: !!so.desc }, "desc")),
        h("button", { class: "ss-del danger", dataset: { i }, title: "remove sort" }, TRASH())));
    return frag(
        h("div", { class: "sub-sec lab-grid" },
            labCell("sources", "datasets or subsets; each joins on its own field", true),
            h("div", { class: "sv-inputs" }, chips,
                h("span", { class: "sv-input sv-add" }, h("select", { class: "sv-addin" }, addOpts))),
            ...srcCfgs,
            // close the per-source section so the view-level rows below (limit, latest batch) don't
            // read as part of the last source's block
            ...(srcCfgs.length ? [h("div", { class: "gspan sv-sec-end" })] : []),
            labCell("limit", "cap the number of result rows (0 = no limit)"),
            h("input", { type: "number", class: "sv-limit", min: "0", step: "1", value: s.limit || 0, placeholder: "0" }),
            labCell("latest batch only", "only pull rows from each source's most recent collection batch (applied before everything else)"),
            h("label", { class: "flab" }, h("input", { type: "checkbox", class: "sv-latest", checked: !!s.latest_batch }))),
        h("div", { class: "sub-sec" },
            h("div", { class: "sub-lbl", title: "all must pass" }, "filters", h("button", { class: "sub-addf", title: "add filter" }, "+")), filters),
        h("div", { class: "sub-sec" },
            h("div", { class: "sub-lbl", title: "{col} text · {=expr} math · mix freely" }, "columns", h("button", { class: "sub-addd", title: "add column" }, "+")), derived),
        h("div", { class: "sub-sec" },
            h("div", { class: "sub-lbl", title: "primary first; applied before limit" }, "sort", h("button", { class: "sub-adds", title: "add sort" }, "+")), sortRows),
        h("div", { class: "sub-sec" },
            h("div", { class: "sub-lbl", title: "click to hide/show" }, "visible"),
            h("div", { class: "sv-hides" }, hideToggleNodes(s))));
}

function subsetParts(s) {
    // config is always visible now (no fold toggle); the head button toggles the records-grid
    // satellite (vt:sub:<id>), the same opt-in follower datasets get.
    return {
        title: h("input", { class: "gi gi-id subrename", value: s.id, title: "subset name" }),
        head: satToggleBtn(`vt:sub:${s.id}`, "vttable"),
        body: h("div", { class: "sub-cfg" }, subConfigNode(s)),
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
function refreshSubsetNode(id, pre = null) { singleFlight(`sub:${id}`, () => _refreshSubsetNode(id, pre)); }
async function _refreshSubsetNode(id, pre) {
    const el = nodeEls.get(`sub:${id}`);                              // config node (hide toggles live here)
    const vtId = `vt:sub:${id}`;
    const host = nodeEls.get(vtId)?.querySelector(".sub-host");       // records grid — opt-in satellite
    if (!el && !host) return;
    // spin the records-grid satellite while its rows are being recomputed (only when it's shown)
    const vtShown = !!host;
    if (vtShown) setNodeBusy(vtId, true);
    try {
        const r = pre || await api.getSubset(model.profile.name, id);
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
    for (const d of datasets) if (d) _refDs.add(d);
    for (const s of subsets) if (s) _refSub.add(s);
    if (_refTimer === null) _refTimer = setTimeout(flushNodeRefresh, 120);   // coalesce a burst into one batch
}
async function flushNodeRefresh() {
    _refTimer = null;
    const dss = [..._refDs].filter((d) => nodeEls.has(`vt:ds:${d}`) || nodeEls.has(`ds:${d}`));
    const subs = [..._refSub].filter((s) => nodeEls.has(`vt:sub:${s}`) || nodeEls.has(`sub:${s}`));
    _refDs.clear(); _refSub.clear();
    if (!dss.length && !subs.length) return;
    let details = null;
    try { details = await api.flowDetails(model.profile.name, dss, subs); } catch { /* batch failed -> per-node fetch */ }
    for (const d of dss) { const pre = details?.datasets?.[d] || null; refreshDataNode(d, pre); loadBatchesNode(d, pre); }
    for (const s of subs) refreshSubsetNode(s, details?.subsets?.[s] || null);
}

function refreshAllSubsetNodes() {
    queueNodeRefresh({ subsets: (model.profile.subsets || []).map((s) => s.id) });
}

// Refresh every subset that READS from `ds` (directly or through an upstream subset). Batch edits
// (revert / remove) change a dataset's contents WITHOUT appending a history event, so its ledger
// last_ts is unchanged and refreshLive's last_ts gate misses them — callers fixing a dataset's
// data must refresh its consumers explicitly.
function refreshDatasetConsumers(ds) {
    for (const s of model.profile.subsets || [])
        if (nodeEls.has(`sub:${s.id}`) && model.subsetReaches(s.id, ds)) refreshSubsetNode(s.id);
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
    div.querySelectorAll(".sv-rmin").forEach((b) => b.addEventListener("click", () => {
        model.removeSubsetInput(s.id, b.dataset.ds); render(); restructure();
    }));
    // PER-SOURCE join config — each control carries its source id in dataset.ds. Setting/clearing a
    // source's join field toggles its required + match rows, so rebuild the node (restructure);
    // the other knobs just re-canonicalise/recompute the view.
    div.querySelectorAll(".sv-sjoin").forEach((el) => el.addEventListener("change", (e) => { model.setSourceJoinField(s.id, el.dataset.ds, e.target.value.trim()); restructure(); }));
    div.querySelectorAll(".sv-sreq").forEach((el) => el.addEventListener("change", (e) => { model.setSourceRequired(s.id, el.dataset.ds, e.target.checked); recompute(); }));
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
    div.querySelector(".sv-latest")?.addEventListener("change", (e) => { model.setSubsetLatestBatch(s.id, e.target.checked); recompute(); });
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

    queueMicrotask(() => refreshSubsetNode(s.id, _bootDetails?.subsets?.[s.id] || null));
}

// ---- producer node: fetches external data into its output dataset -----------

function wireProducer(div, n) {
    // the producer panel (refresh config + controls, stored count). The out-port
    // (drag to a dataset) is wired generically by wireOutPort.
    // when a refresh ends (or is cancelled), refresh the dataset it feeds so its new batch shows
    wireProducerNode(div, model.profile.name, n.ref.dataset, n.ref.mode || "statistics",
        n.ref.type || "warframe_market", () => {
            refreshLive(); refreshDataNode(n.ref.dataset); loadBatchesNode(n.ref.dataset);
        }, hub.kick);   // refresh start/cancel -> beat the hub so the tasks panel refreshes now
    // backend picker (warframe_market | relic). Switching swaps the body, so rebuild.
    div.querySelector(".prtype")?.addEventListener("change", (e) => {
        model.setProducerType(n.ref.id, e.target.value); rebuildNode(n.id); drawEdges(); autosave(null);
    });
    // source toggle: statistics (history) vs live orders (now). Mode swaps the body, so rebuild.
    div.querySelector(".enr-mode")?.addEventListener("change", (e) => {
        model.setProducerMode(n.ref.id, e.target.value); rebuildNode(n.id); autosave(null);
    });
    // which source column names the item to price (next sweep uses it — no rebuild)
    div.querySelector(".enr-keyfld-sel")?.addEventListener("change", (e) => {
        model.setProducerSourceField(n.ref.id, e.target.value); autosave(null);
    });
    // rename the producer node (its id) — carry its saved layout slot to the new id, then re-render
    div.querySelector(".prrename")?.addEventListener("change", (e) => {
        const oldId = n.ref.id;
        renameNode(e.target, oldId,
            () => model.renameProducer(oldId, (e.target.value || "").trim()),
            () => movePos(`producer:${oldId}`, `producer:${n.ref.id}`),
            () => { render(); autosave(null); });
    });
    // add a priced-item source via the chip add-select (same input the subset uses)
    div.querySelector(".pr-addsrc")?.addEventListener("change", (e) => {
        if (e.target.value && model.addProducerSource(n.ref.id, e.target.value)) { rebuildNode(n.id); drawEdges(); autosave(null); }
    });
    // unwire a priced-item source — rebuild the node so the chip goes too, and redraw the edge
    div.querySelectorAll(".pr-rmsrc").forEach((b) => b.addEventListener("click", () => {
        model.removeProducerSource(n.ref.id, b.dataset.ds); rebuildNode(n.id); drawEdges(); autosave(null);
    }));
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
    div.querySelector(".tg-sound")?.addEventListener("change", (e) => { model.setTriggerSound(t.id, e.target.value); autosave(null); });
    // volume slider: `input` (not change) so the % label tracks the live drag; autosave coalesces the writes
    div.querySelector(".tg-volume")?.addEventListener("input", (e) => {
        model.setTriggerVolume(t.id, e.target.value);
        const n = div.querySelector(".tg-volnum"); if (n) n.textContent = `${Math.round((model.trigger(t.id)?.volume ?? 1) * 100)}%`;
        autosave(null);
    });
    // ▶ audition the currently-selected sound at the current volume (also unlocks browser autoplay for later auto-fires)
    div.querySelector(".tg-sound-preview")?.addEventListener("click", () => { playSound(div.querySelector(".tg-sound")?.value, model.trigger(t.id)?.volume ?? 1); });
    // rebuildNode (not render) re-renders THIS node's chips — render() only builds NEW nodes,
    // so an in-place chip add/remove wouldn't show. drawEdges() drops/adds the trigger's edges
    // (watch source→trigger and trigger→price) so a chip change reflects on the canvas live.
    div.querySelector(".tg-addwatch")?.addEventListener("change", (e) => { if (model.addTriggerWatch(t.id, e.target.value)) { rebuildNode(t.id); drawEdges(); autosave(null); } });
    div.querySelector(".tg-addfire")?.addEventListener("change", (e) => { if (model.addTriggerTarget(t.id, e.target.value)) { rebuildNode(t.id); drawEdges(); autosave(null); } });
    div.querySelectorAll(".tg-rmwatch").forEach((b) => b.addEventListener("click", () => { model.removeTriggerWatch(t.id, b.dataset.ds); rebuildNode(t.id); drawEdges(); autosave(null); }));
    div.querySelectorAll(".tg-rmtarget").forEach((b) => b.addEventListener("click", () => { model.removeTriggerTarget(t.id, b.dataset.p); rebuildNode(t.id); drawEdges(); autosave(null); }));
    div.querySelector(".tg-fire")?.addEventListener("click", async () => {
        const prog = div.querySelector(".tg-prog");
        prog.textContent = "firing…";
        try { const r = await api.triggers.fire(model.profile.name, t.id); prog.textContent = `fired ${(r.started || []).length} sweep(s)`; refreshLive(); }
        catch (err) { prog.textContent = String(err.message || err); }
    });
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
    $(".src-tail")?.addEventListener("change", (e) => { model.setSourceProp(s.id, "tail", e.target.checked); autosave(null); schedulePreview(); });
    $(".src-linepos")?.addEventListener("change", (e) => { model.setSourceProp(s.id, "line_position", e.target.checked); autosave(null); });

    // line filters (match clauses)
    $(".src-addm")?.addEventListener("click", () => { model.addSourceMatch(s.id); rebuildNode(n.id); autosave(null); });
    div.querySelectorAll(".src-rmm").forEach((b) => b.addEventListener("click", () => { model.removeSourceMatch(s.id, +b.dataset.i); rebuildNode(n.id); autosave(null); }));
    div.querySelectorAll(".mset").forEach((inp) => inp.addEventListener("change", (e) => {
        model.setSourceMatch(s.id, +e.target.dataset.i, e.target.dataset.k,
            e.target.type === "checkbox" ? e.target.checked : e.target.value);
        autosave(null); schedulePreview();
    }));

    // extraction fields
    $(".src-addf")?.addEventListener("click", () => { model.addSourceField(s.id); rebuildNode(n.id); autosave(null); });
    div.querySelectorAll(".src-rmf").forEach((b) => b.addEventListener("click", () => { model.removeSourceField(s.id, +b.dataset.i); rebuildNode(n.id); autosave(null); }));
    div.querySelectorAll(".fset2").forEach((inp) => inp.addEventListener("change", (e) => {
        const k = e.target.dataset.k;
        model.setSourceFieldProp(s.id, +e.target.dataset.i, k,
            e.target.type === "checkbox" ? e.target.checked : e.target.value);
        if (k === "method") { rebuildNode(n.id); autosave(null); }   // method swaps its own inputs
        else { autosave(null); schedulePreview(); }
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
    // "preview" reveals the data-table satellite (and refreshes it if it's already shown)
    $(".src-prevbtn")?.addEventListener("click", () => { showSatellite(`vt:src:${s.id}`); refreshSourcePreview(s.id); });
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
async function _refreshSourcePreview(id) {
    const vtId = `vt:src:${id}`;
    const node = nodeEls.get(vtId);
    if (!node || !model.profile.name) return;   // satellite not shown -> nothing to render
    const host = node.querySelector(".src-host");
    const info = node.querySelector(".src-prev-info");
    const s = model.fileSource(id);
    if (!s || !host) return;
    setNodeBusy(vtId, true);
    try {
        const r = await api.sources.preview(model.profile.name, s);
        renderPreview(host, r.rows || []);
        if (!(r.rows || []).length) host.replaceChildren(h("p", { class: "muted", style: "padding:8px" }, r.note || "no rows"));
        const le = r.line_ending ? ` · ${r.line_ending}` : "";
        if (info) info.textContent = (r.path === null && !(r.rows || []).length)
            ? (r.note || "file not found") : `${r.matched} row(s) · ${r.total} line(s)${le}`;
    } catch (e) {
        if (info) info.textContent = String(e.message || e);
        host.replaceChildren(h("p", { class: "muted", style: "padding:8px" }, String(e.message || e)));
    } finally {
        setNodeBusy(vtId, false);
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
function renderPreview(host, rows) {
    if (!host) return;
    if (!rows.length) { host.replaceChildren(); return; }
    const cols = [];
    for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
    const cap = 50;
    host.replaceChildren(h("table", { class: "src-ptab" },
        h("thead", h("tr", cols.map((c) => h("th", c)))),
        h("tbody", rows.slice(0, cap).map((r) =>
            h("tr", cols.map((c) => h("td", r[c] == null ? "" : String(r[c]))))))));
}

export const CAN_DISABLE = new Set(["window", "item", "region", "detect", "scrollbar", "dictionary", "producer", "trigger", "filesource"]);
const REMOVABLE = new Set(["window", "item", "itemfield", "itemtell", "region", "detect", "scrollbar", "dictionary", "subset", "dataset", "producer", "trigger", "filesource"]);

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
        detect:     { kill: () => model.removeDetect(win, n.ref.id), after: () => { rebuildNode(`win:${win}`); autosave(win); refreshImageBoxes(win); } },
        scrollbar:  { kill: () => model.removeScrollbar(win), after: () => { autosave(win); refreshImageBoxes(win); } },
        itemfield:  { kill: () => model.removeItemField(win, n.item.id, n.ref.id), after: () => itemChanged(win, n.item.id, { reread: true }) },
        itemtell:   { kill: () => model.removeItemTell(win, n.item.id, n.ref.id), after: () => itemChanged(win, n.item.id, { reread: true }) },
        dictionary: { kill: () => model.removeDictionary(n.ref.id), after: () => autosave(null) },
        subset:     { kill: () => model.removeSubset(n.ref.id), after: () => autosave(null) },
        producer:   { kill: () => model.removeProducer(n.ref.id), after: () => autosave(null) },
        trigger:    { kill: () => model.removeTrigger(n.ref.id), after: () => autosave(null) },
        filesource: { kill: () => model.removeFileSource(n.ref.id), after: () => autosave(null) },
        dataset:    { kill: () => { model.removeDataset(n.ref); purgeDatasetData(n.ref); }, after: () => autosave(null) },
    };
    const plan = PLAN[n.type];
    if (!plan) return;
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
    // the enable slide-toggle (gn-enable) — only on toggleable node types; null otherwise. Its
    // .gn-enable class / aria-checked / state class are read by the post-build wiring below.
    const toggle = canToggle
        ? slideToggle({ on: enabled, cls: "gn-enable", title: "enabled — turn off to skip this node during detection" })
        : null;
    // delete + detach moved to the selection toolbar (act on the selection); nodes carry
    // neither button anymore — select a node (or several) and use the toolbar.
    const typeLabel = n.type === "itemfield" ? "field"
        : n.type === "itemtell" ? `tell: ${n.ref.kind}`   // merge the kind into the type tag -> "TELL: TEXT"
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
            h("span", { class: "gn-type", "aria-hidden": "true" }, typeLabel),
            h("span", { class: "gn-pretty-dirty", title: "held by a pretty override — not saved to yaml" }, "pretty")),
        h("div", { class: "gn-body" }, parts.body),
        h("span", { class: "gn-spin", title: "working…" }),
        ...(parts.ports ? [parts.ports] : []));   // vttable nodes have no ports — replaceChildren would stringify undefined to a "undefined" text node
    div.querySelector(".collapse").addEventListener("click", () => toggleCollapse(n.id));
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
        autosave(winId);   // window id (or undefined for data-plane) -> scoped; re-fires only on enable
    });
    // satellite show/hide (preview on a window; vt-table on a dataset/subset) — one handler for
    // every node that carries the head button. Toggling rebuilds the graph so the follower node +
    // its dotted edge appear/disappear; a freshly shown one is parked just right of its parent.
    div.querySelector(".gn-sat-tog")?.addEventListener("click", (e) => {
        e.stopPropagation();
        const btn = e.currentTarget;
        const on = model.toggleSatellite(btn.dataset.sat);
        paintSatToggle(btn, on);   // render() keeps existing node DOM, so flip the button by hand
        applySatellite(btn.dataset.sat, on);
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
// subsets feed a SUBSET. `selfId` blocks dropping a node onto itself.
function outPortSpec(n) {
    switch (n.type) {
        case "window": return {
            target: "dataset",
            onDrop: (ds) => model.setDataset(n.ref.id, ds),
            onEmpty: (pt) => { const ds = model.addDataset(); placeAt(`ds:${ds}`, pt); model.setDataset(n.ref.id, ds); return `ds:${ds}`; },
        };
        case "producer": return {
            target: "dataset",
            onDrop: (ds) => { model.setProducerDataset(n.ref.id, ds); rebuildNode(n.id); },
            onEmpty: (pt) => { const ds = model.addDataset(); placeAt(`ds:${ds}`, pt); model.setProducerDataset(n.ref.id, ds); rebuildNode(n.id); return `ds:${ds}`; },
        };
        case "dataset": return {
            // a dataset feeds a SUBSET (join) or a PRODUCER node (price only these items)
            target: ["subset", "producer"],
            onDrop: (id, ttype) => {
                if (ttype === "producer") { if (model.addProducerSource(id, n.ref)) rebuildNode(`producer:${id}`); }
                // rebuild the subset node (its sources chips + join-on list), not just refresh the
                // vtable — same as the in-panel add (.sv-addin); rebuild re-queues the refresh.
                else if (model.addSubsetInput(id, n.ref)) rebuildNode(`sub:${id}`);
            },
            onEmpty: (pt) => { const id = model.addSubset(n.ref); placeAt(`sub:${id}`, pt); return `sub:${id}`; },
        };
        case "subset": return {
            // a subset feeds another SUBSET or a PRODUCER node (price only the rows it returns, e.g. count>0)
            target: ["subset", "producer"],
            selfId: n.ref.id,
            onDrop: (id, ttype) => {
                if (ttype === "producer") { if (model.addProducerSource(id, n.ref.id)) rebuildNode(`producer:${id}`); }
                else if (model.addSubsetInput(id, n.ref.id)) rebuildNode(`sub:${id}`);
            },
            onEmpty: (pt) => { const id = model.addSubset(n.ref.id); placeAt(`sub:${id}`, pt); return `sub:${id}`; },
        };
        case "filesource": return {
            target: "dataset",
            onDrop: (ds) => { model.setSourceDataset(n.ref.id, ds); rebuildNode(n.id); },
            onEmpty: (pt) => { const ds = model.addDataset(); placeAt(`ds:${ds}`, pt); model.setSourceDataset(n.ref.id, ds); rebuildNode(n.id); return `ds:${ds}`; },
        };
        case "trigger": return {
            // a trigger fires a PRODUCER node (sweep/refresh) or a FILE SOURCE (read)
            target: ["producer", "filesource"],
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
    const btn = nodeEls.get(model.satelliteParent(satId))?.querySelector(".gn-sat-tog");
    if (btn) paintSatToggle(btn, true);
    applySatellite(satId, true);
}

// the source id a drop target commits to: a dataset node's name, or a node's bare id
// (subset/price/trigger carry a prefixed node id in data-id).
function targetIdOf(el, target) {
    return target === "dataset" ? el.dataset.ds : (el.dataset.id || "").replace(/^(sub|producer|trigger|src):/, "");
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
function nodeResizeOpts(div, id, { widthOnly = false } = {}) {
    return {
        both: !widthOnly,
        zoom: () => view.zoom,
        // left-edge accessor: the node's world x lives in `pos` (canvas-zoomed) — lets the
        // shared bottom-left grip resize this node leftward with its right edge anchored
        left: (v) => { const p = pos.get(id); if (v === undefined) return p ? p.x : 0; if (p) { p.x = v; positionNode(id); } },
        onResize: () => { drawEdges(); groups.renderGroups(); },
        onSettle: () => { nodeSizes.set(id, { w: div.offsetWidth, h: div.offsetHeight }); div.classList.add("has-size"); drawEdges(); groups.renderGroups(); persist.layout(); },
        // reset dot: drop the user's size back to the node's natural CSS size, then snap that UP
        // to the grid. Snapping DOWN would shrink the node below its natural size and clip content,
        // so always round up — the reset size is the smallest grid-aligned box that still fits.
        // (widthOnly nodes never stamp height — it follows the aspect.)
        onReset: () => {
            div.style.width = ""; if (!widthOnly) div.style.height = "";   // measure the natural CSS size
            const w = snapUp(div.offsetWidth);
            div.style.width = `${w}px`;
            const h = widthOnly ? div.offsetHeight : snapUp(div.offsetHeight);
            if (!widthOnly) div.style.height = `${h}px`;
            nodeSizes.set(id, { w, h });
            drawEdges(); groups.renderGroups(); persist.layout();
        },
    };
}

// Make a node user-resizable: restore its saved size, then attach the grips (NODE itself, its
// body fills it). Restores + persists through nodeSizes — grid-snapped on release — so a
// rebuild, RENAME (render() destroys + rebuilds; movePos carries nodeSizes to the new id), or
// reload all keep the user's size. `widthOnly` (item/window) restores width only; height is
// aspect-driven, so it's never stamped inline.
function makeNodeResizable(div, id, { widthOnly = false } = {}) {
    const s = nodeSizes.get(id);
    // a collapsed node is header-only (CSS) — never stamp its saved w/h inline, or the hard
    // inline size beats the collapsed CSS and the node renders full-height while "collapsed".
    if (s && !collapsed.has(id)) { if (s.w) div.style.width = `${s.w}px`; if (!widthOnly && s.h) div.style.height = `${s.h}px`; }
    snapResize(div, nodeResizeOpts(div, id, { widthOnly }));
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
    // fillNode rewrote the node's DOM, wiping the resize grips — re-add them. The ResizeObserver +
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
            els.detail.replaceChildren();
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
function syncMultiSelect() {
    for (const [id, el] of nodeEls) el.classList.toggle("multisel", selected.has(id));
    const bar = $("seltoolbar"), cnt = $("selCount"), gbtn = $("selGroupBtn");
    const ng = groups.selectedGroupIds().length;   // ctrl-selected GROUPS (for super-grouping)
    const ids = selectionIds();                    // selected nodes (single focus OR multi-select set)
    const nsel = ids.length;
    if (bar) bar.hidden = !(nsel >= 1 || ng >= 1);
    if (cnt) cnt.textContent = ng >= 1 ? `${ng} group${ng === 1 ? "" : "s"} selected` : `${nsel} selected`;
    // the button label mirrors what `g` would actually DO to this selection (group vs ungroup)
    const gstate = groupBtnState();
    if (gbtn) { const gl = gbtn.querySelector(".sel-lbl"); if (gl) gl.textContent = gstate.label; else gbtn.textContent = gstate.label; gbtn.title = gstate.title; }
    // subgroup shows only when the whole selection sits inside ONE group (a subgroup is scoped to a
    // single parent group); its label mirrors what the action would do (subgroup vs ungroup).
    const sgb = $("selSubgroupBtn");
    if (sgb) {
        const ss = subgroupBtnState(ids);
        sgb.hidden = !ss;
        if (ss) { const sl = sgb.querySelector(".sel-lbl"); if (sl) sl.textContent = ss.label; sgb.title = ss.title; }
    }
    // detach shows only when something in the selection is grouped AND the group button isn't
    // already offering "ungroup" — when it is (whole selection == one full group), detach would do
    // the exact same detachNodes(ids), so two buttons would mean one action. detach's reason to
    // exist is the mixed selection (some loose / many groups), where the group button flips to
    // "group"/"add" instead; there it's the only way to pull the grouped ones OUT.
    const det = $("selDetachBtn"), del = $("selDeleteBtn");
    if (det) det.hidden = gstate.label === "ungroup" || !ids.some((id) => groups.groupOf(id));
    if (del) {
        del.hidden = !ids.some((id) => REMOVABLE.has(nodeTypeOf(id)));
        if (del.dataset.armed === "1") { del.dataset.armed = "0"; const dl = del.querySelector(".sel-lbl"); if (dl) dl.textContent = del.dataset.label || dl.textContent; }
    }
    drawEdges();   // selection changed -> repaint so selected nodes' lines pick up the `sel` colour
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
            ? { label: "ungroup", title: "dissolve the super group (hotkey: g)" }
            : { label: "super-group", title: "super-group the selected groups (hotkey: g)" };
    }
    const ids = selectionIds();
    const gset = new Set(ids.map((id) => groups.groupOf(id)).filter(Boolean));   // distinct groups in selection
    const ungrouped = ids.some((id) => !groups.groupOf(id));
    const ungroup = ids.length >= 1 && gset.size === 1 && !ungrouped;   // share ONE group, none loose -> ungroup/detach
    return ungroup
        ? { label: "ungroup", title: "ungroup the selection (hotkey: g)" }
        : { label: "group", title: "group the selection (hotkey: g)" };
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
        // id input is click-to-arm: block native focus on the FIRST click (just arm + select);
        // a second click on the same armed input falls through to native focus → editing.
        if (handle && handle.matches?.("input.gi-id") && handle !== armedGiId) {
            ev.preventDefault();   // suppress focus/caret on this click
            armedGiId = handle;
        }
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
            autosave(null);   // process/title/name affect window LOCATION, not stashed-image OCR
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
            render(); autosave(null);
        });
        div.querySelector(".dictterms")?.addEventListener("change", (e) => {
            n.ref.terms = e.target.value.split("\n").map((s) => s.trim()).filter(Boolean);
            rebuildNode(n.id); autosave(null);   // refresh the word count
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
        div.querySelector(".dsclone")?.addEventListener("click", () => { model.cloneDataset(n.ref); render(); autosave(null); });
        div.querySelector(".dskey")?.addEventListener("change", async (e) => {
            const v = e.target.value;
            if (v === "__nodedup__") model.setDatasetDedup(n.ref, false);
            else model.setDatasetKeyField(n.ref, v);
            autosave(null);
            await persist.flush();   // re-key on disk before re-reading
            refreshDataNode(n.ref); refreshAllSubsetNodes();
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
        if (r.kind === "source") {
            queueMicrotask(() => refreshSourcePreview(r.id));   // parse the source's current rules into the table
        } else if (r.kind === "subset") {
            const pre = _bootDetails?.subsets?.[r.id] || null;
            queueMicrotask(() => refreshSubsetNode(r.id, pre));
        } else {
            const rmTog = div.querySelector(".vt-showrm");   // "show removed" header slide toggle
            rmTog?.addEventListener("click", (e) => {
                e.stopPropagation();
                const on = rmTog.getAttribute("aria-checked") !== "true";
                rmTog.setAttribute("aria-checked", on);
                rmTog.classList.toggle("on", on);
                vtShowRemoved.set(r.ds, on);
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
    } else if (n.type === "filesource") {
        wireSource(div, n);
    } else if (n.type === "region") {
        const fld = n.field;
        div.addEventListener("click", (ev) => {
            if (ev.target.closest("input,select,button")) return;
            selectWindowBox(n.win.id, n.ref.id);   // highlight this region's box on the image
        });
        div.querySelector(".gi-id").addEventListener("change", (e) => {
            const oldId = n.ref.id;
            renameNode(e.target, oldId,
                () => model.renameRegion(n.win.id, oldId, e.target.value.trim()),
                () => movePos(`reg:${n.win.id}:${oldId}`, `reg:${n.win.id}:${n.ref.id}`),
                () => { render(); autosave(n.win.id); refreshImageBoxes(n.win.id); });   // re-OCR only this window
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
            autosave(n.win?.id);   // plain value edits: no DOM rebuild; re-OCR only this window
        }));
        if (fld) wireFieldRules(div, fld, {
            rebuild: () => { rebuildNode(n.id); autosave(n.win?.id); },
            commit: () => autosave(n.win?.id),
        });
    } else if (n.type === "detect") {
        div.addEventListener("click", (ev) => {
            if (ev.target.closest("input,select,button")) return;
            selectWindowBox(n.win.id, n.ref.id);
        });
        div.querySelector(".gi-id").addEventListener("change", (e) => {
            const oldId = n.ref.id;
            renameNode(e.target, oldId,
                () => model.renameDetect(n.win.id, oldId, e.target.value.trim()),
                () => movePos(`det:${n.win.id}:${oldId}`, `det:${n.win.id}:${n.ref.id}`),
                () => { render(); rebuildNode(`win:${n.win.id}`); autosave(n.win.id); refreshImageBoxes(n.win.id); });
        });
        div.querySelectorAll(".aset").forEach((inp) => inp.addEventListener("change", (e) => {
            const k = e.target.dataset.k;
            if (k === "text") n.ref.text = e.target.value;
            else if (k === "thr") n.ref.threshold = +e.target.value;
            else if (k === "match") n.ref.match = e.target.value;
            else if (k === "minchars") n.ref.min_chars = Math.max(0, Math.trunc(+e.target.value) || 0);
            else if (k === "strip") n.ref.strip = e.target.value;
            else if (k === "case") n.ref.case_sensitive = e.target.checked;
            // mode change shows/hides "read ⊆ text" (ignored by full/exact) -> rebuild the body
            if (k === "match") rebuildNode(n.id);
            autosave(n.win.id);   // a detector knob re-runs detect for ONLY this window
        }));
    } else if (n.type === "scrollbar") {
        div.addEventListener("click", (ev) => {
            if (ev.target.closest("input,select,button,.sb-cut")) return;
            selectWindowBox(n.win.id, "scrollbar");
        });
        wireScrollbar(div, n);
    } else if (n.type === "item") {
        wireItemControls(div, n);
    } else if (n.type === "itemfield") {
        wireItemField(div, n);
    } else if (n.type === "itemtell") {
        wireItemTell(div, n);
    }
}

// Scrollbar node: orientation + visible-rows, the cutout list (rows-from-top, remove,
// drag-reorder), capture, and auto-learn. All calibration knobs are collector-only -> save
// without re-OCR.
function wireScrollbar(div, n) {
    const winId = n.win.id;
    // re-fit the gain from the cutouts after any change, refresh the node, save, and re-read the
    // window image so its row-index labels update (works even with the preview node closed).
    const relearn = () => { model.learnScrollGain(winId); rebuildNode(n.id); autosave(null); refreshGridPreview(winId); };
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
    const keep = nodeEls.get(id);
    document.querySelectorAll(".tool.active").forEach((b) => { if (!keep || !keep.contains(b)) b.classList.remove("active"); });
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
        const w = snapUp(el.offsetWidth);
        if (Math.abs(w - el.offsetWidth) >= 1) el.style.width = `${w}px`;
        if (both) { const h = snapUp(el.offsetHeight); if (Math.abs(h - el.offsetHeight) >= 1) el.style.height = `${h}px`; }
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
        // The window-mouseup listener outlives the node: loadGame wipes #gnodes (detaching every
        // element) but these closures stay bound to `window`, and a hidden graph (pretty view) keeps
        // them attached at zero size. A detached/hidden node reports offsetWidth/Height 0 — persisting
        // that would store {w:0,h:0}, which hydrate keeps (0 is finite) but makeNodeResizable can't
        // re-apply (0 is falsy), so every node loads at default size. Never settle a zero-box node.
        if (!el.isConnected) { window.removeEventListener("mouseup", finish); return; }   // torn-down node: drop the leaked listener
        if (!el.offsetWidth || !el.offsetHeight) { dirty = false; return; }                // hidden (e.g. pretty view): don't settle a zero box
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
            if (tid != null && tid !== spec.selfId) { spec.onDrop(tid, ttype); render(); autosave(null); return; }
        } else if (dragged && !overNode && spec.onEmpty) {   // empty canvas (not over another node) -> mint a node
            const newId = spec.onEmpty(toWorld(e));
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
    // and re-fire once this fetch completes (the detectAgain/previewAgain idiom).
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
const _PANEL_TOGGLES = { liveBtn: "live", precapBtn: "precap", createBtn: "toolbox", nodemapBtn: "nodemap", nodelistBtn: "nodelist", activityBtn: "activity", testingBtn: "testing", statsBtn: "stats", dbstructBtn: "dbstruct" };
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
const _NODE_PANELS = ["nodemap", "nodelist", "activity", "testing", "stats", "dbstruct", "toolbox", "live", "precap"];
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
    // Buttons with an icon keep it in a `.sel-ic` span; only the `.sel-lbl` text arms/disarms so
    // the icon survives (a whole-button textContent swap would wipe the SVG). Plain buttons fall
    // back to button textContent.
    const lbl = btn.querySelector(".sel-lbl");
    const get = () => (lbl ? lbl.textContent : btn.textContent);
    const set = (t) => { if (lbl) lbl.textContent = t; else btn.textContent = t; };
    btn.addEventListener("click", () => {
        if (btn.dataset.armed !== "1") { btn.dataset.armed = "1"; btn.dataset.label = get(); set("confirm"); setTimeout(() => { if (btn.dataset.armed === "1") { btn.dataset.armed = "0"; set(btn.dataset.label); } }, 2500); return; }
        btn.dataset.armed = "0"; set(btn.dataset.label || get()); run();
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
$("selSubgroupBtn")?.addEventListener("click", () => subgroupShortcut());

// Detach every selected node that's in a group. Mirrors the per-node unlock icon that
// used to live on each node — now one toolbar action over the whole selection.
$("selDetachBtn").addEventListener("click", () => {
    const ids = selectionIds().filter((id) => groups.groupOf(id));
    if (!ids.length) return;
    groups.detachNodes(ids);
    setStatus(`detached ${ids.length} node${ids.length === 1 ? "" : "s"}`);
});

// Delete every removable node in the selection. Each goes through removeNode() so undo/redo
// records it, same path the old per-node trash button used. SHARED by the armed toolbar button
// and the Delete/Backspace hotkey so both behave identically (rule 7).
function deleteSelection() {
    const byId = new Map(model.nodes().map((n) => [n.id, n]));
    const targets = selectionIds().map((id) => byId.get(id)).filter((n) => n && REMOVABLE.has(n.type));
    if (!targets.length) return;
    for (const n of targets) removeNode(n);   // each renders + autosaves; undo records each
    deselectAll();
}
// Toolbar: armed two-click (rule 2) — a mis-click shouldn't nuke a node.
armConfirm($("selDeleteBtn"), deleteSelection);

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

// Predict the subgroup action's label, and gate the toolbar button: a subgroup is only offered
// when the WHOLE selection sits inside ONE group (it's scoped to a single parent group). Returns
// null when not offerable. Mirrors the group ruleset (subgroup vs add vs ungroup).
function subgroupBtnState(ids) {
    if (!ids.length) return null;
    const gset = new Set(ids.map((id) => groups.groupOf(id)).filter(Boolean));
    if (gset.size !== 1) return null;                       // not all in exactly one group
    const parent = [...gset][0];
    if (!ids.every((id) => parent.members.includes(id))) return null;
    const subs = new Set(ids.map((id) => groups.subgroupOf(id)).filter(Boolean));
    const loose = ids.filter((id) => !groups.subgroupOf(id));
    if (subs.size === 1 && !loose.length) return { label: "ungroup", title: "dissolve this subgroup" };
    if (subs.size === 1 && loose.length) return { label: "subgroup", title: "add the loose nodes to the subgroup" };
    if (ids.length === 1 && subs.size === 1) return { label: "ungroup", title: "remove from subgroup" };
    return { label: "subgroup", title: "sub-group the selection within its group" };
}

// Sub-group the selection inside its (single) parent group, with the SAME ruleset groups use:
//   • 1 node in a subgroup            -> detach it
//   • 2+, all in ONE subgroup, some loose -> add the loose ones
//   • 2+, all in ONE subgroup, none loose -> dissolve the subgroup
//   • otherwise                       -> form a new subgroup
function subgroupShortcut() {
    const ids = selectionIds();
    if (!subgroupBtnState(ids)) { setStatus("subgroup: select nodes that share one group"); return; }
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
    const wrap = h("div", { class: "settings" },
        h("section", { class: "set-sec" },
            h("h4", "general"),
            h("div", { class: "set-row" },
                h("input", { id: "newGameName", placeholder: "new game name" }),
                h("button", { id: "newGameBtn" }, "create"))),
        h("section", { class: "set-sec" },
            h("h4", "capture"),
            h("label", { class: "set-row", title: "How frames are grabbed from the game window. WGC reads the DWM-composited surface (no per-grab game re-render); PrintWindow re-renders the window each grab; MSS grabs the screen region. Options come from the live registry." },
                h("span", "backend"),
                h("select", { id: "captureBackend" }))),
        h("section", { class: "set-sec" },
            h("h4", "OCR"),
            h("label", { class: "set-row", title: "OCR device — GPU needs onnxruntime-gpu + CUDA. Auto: CPU for editing, GPU for the precapture batch." },
                h("span", "device"),
                h("select", { id: "ocrDevice" },
                    h("option", { value: "auto" }, "Auto (CPU; GPU for precapture)"),
                    h("option", { value: "cpu" }, "CPU"),
                    h("option", { value: "gpu" }, "GPU")))),
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
    // icons + tints come from the ONE shared source (node_icons / graph.css --ntint) so a menu row
    // reads in the same glyph + colour as the node it mints (rule 7).
    openContextMenu(ev.clientX, ev.clientY, [
        { icon: iconFor("window"),     title: "window",      tint: "var(--accent)",       onClick: () => ready() && createWindowNode(at) },
        { icon: iconFor("dataset"),    title: "dataset",     tint: "var(--ok)",           onClick: () => ready() && createDatasetNode(at) },
        { icon: iconFor("subset"),     title: "subset",      tint: "var(--purple)",       onClick: () => ready() && createSubsetNode(at) },
        { icon: iconFor("producer"),   title: "producer node",  tint: "var(--warn)",      onClick: () => ready() && createProducerNode(at) },
        { icon: iconFor("filesource"), title: "file source", tint: "var(--accent)",       onClick: () => ready() && createFileSourceNode(at) },
        { icon: iconFor("trigger"),    title: "trigger",     tint: "var(--trigger-line)", onClick: () => ready() && createTriggerNode(at) },
        { icon: iconFor("dictionary"), title: "dictionary",  tint: "var(--purple)",       onClick: () => ready() && createDictionaryNode(at) },
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
    // Delete: delete the selection (same path as the toolbar button; undo restores).
    // No arm needed — Ctrl+Z brings it back, and a key takes intent the way a stray click doesn't.
    if (ev.key === "Delete" && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
        if (!selectionIds().length) return;
        deleteSelection(); ev.preventDefault(); return;
    }
    const dir = NUDGE[ev.key.toLowerCase()];
    if (!dir) return;
    // No active box but a node is selected → WASD moves the NODE one grid step;
    // Shift+WASD resizes it one grid step (A/D width, W/S height) — same grip the drag
    // handle drives, so it persists + redraws edges identically.
    const rec = overlays.get(activeOverlayKey);
    if (!rec) {
        if (selectedNodeId && pos.has(selectedNodeId)) {
            const el = nodeEls.get(selectedNodeId);
            if (ev.shiftKey) {
                // collapsed nodes are header-only and item nodes follow their cutout aspect,
                // so neither takes a height step (item still resizes width).
                if (el && !collapsed.has(selectedNodeId)) {
                    const type = nodeTypeOf(selectedNodeId);
                    const cur = nodeSizes.get(selectedNodeId) || { w: el.offsetWidth, h: el.offsetHeight };
                    if (dir[0]) el.style.width = `${Math.max(GRID, snap(cur.w + dir[0] * GRID))}px`;
                    if (dir[1] && type !== "item") el.style.height = `${Math.max(GRID, snap(cur.h + dir[1] * GRID))}px`;
                    nodeSizes.set(selectedNodeId, { w: el.offsetWidth, h: el.offsetHeight });
                    el.classList.add("has-size");
                    drawEdges(); groups.renderGroups(); persist.layout();
                }
            } else {
                const p = pos.get(selectedNodeId);
                p.x = snap(p.x + dir[0] * GRID); p.y = snap(p.y + dir[1] * GRID);
                positionNode(selectedNodeId); drawEdges(); persist.layout();
            }
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
    drawEdges(); autosave(rec.winId);   // nudging a box re-OCRs ONLY its window
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
// only on a real change (steady-state ticks mutate nothing).
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
    const sel = root.querySelector("#captureBackend");
    if (!sel) return;
    try {
        const st = await api.captureBackend.getBackend();
        sel.replaceChildren(...(st.names || []).map((n) =>
            h("option", { value: n }, CAPTURE_LABELS[n] || n)));
        sel.value = st.name;
        sel.addEventListener("change", async () => {
            const done = timed(`capture backend → ${sel.value}`);
            try { const r = await api.captureBackend.setBackend(sel.value); if (r.name) sel.value = r.name; done(); }
            catch (e) { done(String(e.message || e), "err"); }
        });
    } catch { /* ignore */ }
}

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
    } catch { /* ignore */ }
}

// Wire one OCR pacing control (a <select> or number <input>) to its api setter, echoing the
// server's canonical value back into the element. The det-downscale + GPU-yield controls live
// only in the LIVE panel (livewin.js); these helpers are exported there so its two controls
// share one wiring path (rule 7). Caller seeds the element's value first; this only attaches
// the change handler.
function wireOcrScale(el) {
    el.addEventListener("change", async () => {
        const done = timed(`OCR downscale → ${el.value}×`);
        try { const r = await api.ocr.setScale(el.value); el.value = String(r.scale || 1); done(); }
        catch (e) { done(String(e.message || e), "err"); }
    });
}
function wireOcrYield(el) {
    el.addEventListener("change", async () => {
        const ms = Math.max(0, parseFloat(el.value) || 0);
        const done = timed(`OCR GPU yield → ${ms}ms`);
        try { const r = await api.ocr.setYield(ms); el.value = String(r.yield_ms ?? 0); done(); }
        catch (e) { done(String(e.message || e), "err"); }
    });
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
    setLogOpen(true);   // show the log history during boot so initial-load progress is visible
    // During boot, mirror EVERY api request into the log bar so the initial-load sequence (and any
    // stuck/slow endpoint) is visible live. Cleared once booted so steady state isn't noisy.
    api.onApiRequest((ev) => {
        if (booted) return;
        if (ev.phase === "start") log(`→ ${ev.method} ${ev.path}`);
        else log(`${ev.ok ? "✓" : "✗"} ${ev.method} ${ev.path} · ${ev.ms}ms${ev.ok ? "" : " " + (ev.reason || "failed")}`, ev.ok ? undefined : "err");
    });
    // a tripped circuit breaker (an endpoint that kept timing out) surfaces here so the user learns
    // why a panel went quiet — it auto-recovers when the endpoint responds again.
    if (!window._apiGuardWired) { window._apiGuardWired = true; window.addEventListener("api-guard", (e) => { setStatus(String(e.detail)); log(String(e.detail), "err"); }); }
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
        model.sounds = await api.sounds.list().catch(() => []);   // trigger-sound picker options (global, once)
        if ($("gameSelect").value) await loadGame($("gameSelect").value);
        // ?view=pretty (the desktop window passes it) boots into the pretty dashboard;
        // a plain browser has no param and stays on the node view.
        if (new URLSearchParams(location.search).get("view") === "pretty") setPrettyView(true);
        initKillGpu();
        hub.init(() => model.profile.name);   // single backend heartbeat for every panel
        hub.start();
        log("first read…");
        await bootSettle();
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
    refreshLive, subsetParts, wireOcrScale, wireOcrYield,
    refreshAllSubsetNodes, refreshDatasetConsumers,
    rebuildNode, setNodeBusy, withBusy, registerOverlay, unregisterOverlay,
    overlaySelected, selectWindowBox, persistBox, syncCellSize, itemChanged,
    addFieldToItemGroup, addTellToItemGroup, inheritGroupFrom,
    refreshItemTemplateRefs,
};
