// Node-view home: edit a game's structure as a graph (Game → Windows → Fields →
// Datasets), drag to arrange, drag-wire a window to a dataset, edit inline, and
// watch live dataset counts. Box drawing happens on each node's inline canvas.
import * as api from "../api.js";
import * as conn from "../conn.js";
import * as hub from "../hub.js";
import { h, frag, svg, observeResize } from "../dom.js";
import { makeArmed } from "./armbtn.js";
import { nodeIcon, iconFor } from "./node_icons.js";
import { openModal } from "../modal.js";
import { registerKey, onOutside, SCOPE } from "../inputbus.js";
import { since } from "../datefmt.js";
import { log, timed, setLogOpen, mirrorConsole } from "../log.js";

mirrorConsole();   // surface uncaught errors + console.error/warn in the log bar (no devtools needed)
import { GRID, snap, snapUp, showSizeHud, hideSizeHud, addResizeGrips, beginDrag } from "./dragresize.js";
import { floatWins } from "./floatwin.js";
import { wireSound, stopAllForgePreview } from "./sound_wire.js";
import { wireToast } from "./toast_wire.js";
import {
    syncCellSize, itemChanged, wireItemControls, wireItemField, wireItemTell,
    groupOrphanChildren, addFieldToItemGroup, addTellToItemGroup, refreshItemTemplateRefs,
} from "./item_wire.js";
import {
    subsetParts, refreshSubsetNode, refreshAllSubsetNodes, refreshDatasetConsumers,
    queueNodeRefresh, refreshChangedSubsetNodes, seedSubsetSig, wireSubset,
} from "./subset_wire.js";
import {
    wireProducer, wireProducerPreview, wireTrigger, wireAction, wireRegister, wireSource,
    refreshSourcePreview,
} from "./io_wire.js";
import { setTableStore } from "./table.js";
import { setVTableStore, reapplyPersistedVTables, vtableById, liveVTables } from "../vtable.js";
import { initPersist, persist, setScrubHook } from "./persist.js";
import { openConflictModal } from "./conflictmodal.js";
import * as prettyOverrides from "../pretty/overrides.js";
import { buildBackups } from "./backups.js";
import * as groups from "./groups.js";
import { initTitlebar } from "../titlebar.js";
import { openLogStream } from "../logstream.js";

initTitlebar();   // custom window chrome — no-op outside the desktop window

import {
    $, setStatus, model, pos, nodeEls, collapsed, view, selected, nodeSizes, openImages,
    imageCanvases, itemCanvases, busy, overlays,
    prevPresent, prevLastTs, dsTab, clearGrid, nw, nh, boot, afterBoot, flushBoot, nextFrame,
} from "./state.js";
import {
    drawEdges, requestEdges, flushEdges, nodeRect, freezeRouting,
    setDraggingNodes,
} from "./routing.js";
import { initFlow } from "./flow.js";
import { mountCanvasLayers } from "./edgecanvas.js";
import { showGuides, flashGuides, clearGuides } from "./guides.js";
import {
    cancelPan, panTo, panZoomTo, panZoomToRect, zoomToNode, viewportCenterWorld,
    applyView, resizeCanvas, onWheel, startPan, consumePanSuppress, MIN_ZOOM,
    zoomStep, fitAllZoom,
} from "./camera.js";
import { centreMost, nearestInDir } from "./keynav.js";
import { drawLive, lockLive, clearNavArrow } from "./navarrow.js";
import { movePos, moveWindowPos, renameNode, forgetNodeState } from "./node_lifecycle.js";
import { nodeParts, windowControls, gamePriority, itemLists, slideToggle, vtShowRemoved, rectEditBtn } from "./node_parts.js";
import * as dsevents from "./dsevents.js";
import { clearTools } from "./drawtool.js";
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
    refreshDataNode, refreshDatasetNode, collapseVtablesExcept,
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
    closeItemImage, openItemImage,
    ocrBusyCount,
    commitPreviewNode,
    scheduleWindowRead, flushWindowRead,
    refreshImageBoxes, refreshGridPreview, selectRegionNode, refreshRuleTrace, refreshReadoutValues,
    RECT_TYPES, toggleRectEditor, rectEditCanvasSync, editBox,
} from "./imaging.js";
import * as rectTxn from "./edit_txn.js";
import * as nodeTxn from "./node_txn.js";
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
export let _bootDetails = null;
export let live = {};             // dataset -> {present,total,last_op,last_ts} (read by datanodes/refreshLive)
export let wire = null;           // active drag-wire {winId, x1,y1} (read by routing.drawEdges)
export let selectedNodeId = null; // node whose line(s) are highlighted (read by routing.selClsFor)
let sizeClip = null;              // size clipboard {w,h} for the toolbar copy/paste-size buttons
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
    persist.content();                 // debounced profile save; ALSO records the undo snapshot
    const win = model.windowOf(changed);
    if (win) scheduleWindowRead(win);  // edit lies in this window's subgraph -> re-read just it
}

// ---- deferred node-config edits (node_txn.js) -------------------------------
// autosave() above is what makes a node lock itself mid-edit: it schedules the window read, whose
// setNodeBusy sets `inert` on the body and force-blurs the focused input. So a config edit paints
// live but stashes its autosave, running it once on ✓ / Enter / a click outside the card. Escape
// puts the snapshot back.
//
// THE rule for which handlers join a transaction (apply it mechanically):
//   autosave(<window id>) -> the edit re-runs OCR for that window, so it LOCKS the node -> defer.
//   autosave(null)        -> persist only, nothing re-reads, nothing locks -> stay immediate, and
//                            commit any pending edit first so the two never interleave.
// Renames / node add+delete also stay immediate: they call render() and change node identity,
// which a snapshot can't put back.

// A commit is the end of the edit burst, so don't make the user sit through the debounces that
// exist only to coalesce one: light the node's loader in THIS frame, push the profile save and the
// queued OCR read out immediately, and drop the loader when that work settles.
//
// The loader can't be left to the downstream fetches: they only spin a node they happen to touch,
// and a window with no open image canvas runs no detect at all — so a commit could produce no
// visible acknowledgement whatsoever. Spinning the committing node covers every path.
nodeTxn.setCommitHook((nodeId, runAftermath) => {
    setNodeBusy(nodeId, true);
    try { runAftermath(); }              // queues the save + the window read
    finally {
        Promise.all([flushWindowRead(), persist.flush()])
            .catch(() => {})             // errors surface through their own paths; never strand the spinner
            .finally(() => setNodeBusy(nodeId, false));
    }
});

// Which live objects a node's edits mutate, and how to resync its DOM after a revert. A
// region/itemfield/readout spans TWO objects: its own `ref` plus the window-level FieldDef
// (model.fieldOf) that carries the rule pipeline. Note a FieldDef may be shared by several
// regions — reverting reverts it for all of them, exactly as the forward edit already changed it
// for all of them.
function nodeTxnSpec(n) {
    const rebuild = () => rebuildNode(n.id);
    switch (n.type) {
        case "detect": case "scrollbar": case "itemtell": case "item": case "subset":
            return { targets: () => [n.ref], rebuild };
        case "region": case "itemfield": case "readout":
            return { targets: () => [n.ref, n.field], rebuild };
        case "window": {
            const w = n.ref;
            return {
                // NOT the whole window: cloning it would replace its items/regions arrays and
                // dangle every child node's `ref` into them. Only the subtrees edited here.
                targets: () => [model.preprocess(w.id), { obj: w, keys: ["static_grid"] }],
                // mirror the .winstatic cascade: item nodes show their locate radios only for a
                // non-static grid, so they must re-bind when static_grid goes back.
                rebuild: () => {
                    rebuildNode(`win:${w.id}`);
                    for (const it of model.window(w.id)?.items || []) rebuildNode(`item:${w.id}:${it.id}`);
                    refreshImageBoxes(w.id);
                },
            };
        }
        default:
            return null;   // node type with no deferrable config (game, dataset, trigger, …)
    }
}

// Wrap one config handler: snapshot (first edit only), mutate live, stash the aftermath.
// `tag` collapses repeats — N keystrokes under "read" leave ONE save + ONE OCR pass queued.
// A node type with no spec just runs straight through, unchanged.
export function nodeEdit(nodeId, tag, mutate, aftermath) {
    if (!nodeTxn.armed(nodeId)) {      // already armed => skip the model.nodes() scan (this runs per keystroke)
        const n = model.nodes().find((x) => x.id === nodeId);
        const spec = n && nodeTxnSpec(n);
        if (!spec) { mutate(); aftermath(); return; }   // node type with nothing deferrable
        nodeTxn.arm(nodeId, () => spec);   // must precede the mutation — it clones the clean state
    }
    mutate();
    nodeTxn.defer(nodeId, tag, aftermath);
}

// Bind a value control so its edit registers on every keystroke (`input`), not only when the field
// blurs (`change`). A text/number input fires `change` on BLUR, so a change-only binding armed the
// transaction too late: the ✓/✕ bar appeared only once you left the input, and clicking outside ran
// the commit (on pointerdown) a beat BEFORE the blur delivered the edit.
//
// The handler is called for both events and must be idempotent. It receives `live` = true for the
// per-keystroke pass, where it MUST NOT rebuild the node body — replacing the DOM mid-keystroke
// destroys the caret. Reshaping work waits for the `change` pass.
const onValueEdit = (el, fn) => {
    el.addEventListener("input", (e) => fn(e, true));
    el.addEventListener("change", (e) => fn(e, false));
};

// The `edit` callback wireFieldRules expects, bound to one node's transaction. `rebuild` reshapes
// the row's controls immediately (a new operand, an added/removed row) — mid-transaction, so it
// neither saves nor ends the edit; `reattach` in rebuildNode keeps the ✓/✕ bar alive across it.
const rulesEdit = (nodeId, aftermath) => (mutate, { rebuild = false } = {}) =>
    nodeEdit(nodeId, "read", () => { mutate(); if (rebuild) rebuildNode(nodeId); }, aftermath);

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
        if (sz) {
            n.w = sz.w; n.h = sz.h;
            if (sz.custW !== undefined) n.custW = sz.custW;
            if (sz.custH !== undefined) n.custH = sz.custH;
            if (sz.softW !== undefined) n.softW = sz.softW;
            if (sz.softH !== undefined) n.softH = sz.softH;
        }
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
        if (n.w > 0 && n.h > 0) nodeSizes.set(id, { w: n.w, h: n.h, custW: n.custW, custH: n.custH, softW: n.softW, softH: n.softH });
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
    // A save lost the race against a structural change made elsewhere (another tab, an
    // external edit) — show the conflict modal instead of silently clobbering it.
    onConflict: (payload, wasContent) => {
        const name = model.profile.name;
        openConflictModal(name, payload, {
            onOverwrite: () => persist.overwrite(wasContent),
            // Discard this tab's pending edit and reload the server's copy. loadGame's
            // `discard` flag skips persist.flush() (which would just resubmit the stale
            // edit and re-trigger this same conflict) in favour of dropping it outright.
            onLoadServer: () => loadGame(name, { discard: true }),
        });
    },
});

// ---- groups (titled boxes around nodes; pure layout) -----------------------
// Node type from its id prefix (game | win:… | reg:… | ds:… | …) for default titles.
const _TYPE_BY_PREFIX = { win: "window", prev: "preview", vt: "vttable", vtd: "vttable", prod: "vttable", hist: "vttable", reg: "region", register: "register", ro: "readout", det: "detect", sb: "scrollbar", item: "item", fld: "itemfield", tell: "itemtell", ds: "dataset", sub: "subset", producer: "producer", trigger: "trigger", action: "action", dict: "dictionary", src: "filesource", toast: "toast", sound: "sound" };
export function nodeTypeOf(id) { return id === "game" ? "game" : id === "atlas" ? "atlas" : (_TYPE_BY_PREFIX[id.split(":")[0]] || null); }
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
        hideSizeHud(); flushEdges(); persist.layout();   // final clean re-path on settle (persist.layout records the undo snapshot)
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
}

// ---- render ---------------------------------------------------------------





// Keep the cell-size inputs in sync after a canvas cell-resize (which doesn't rebuild the node).





// Shared wiring for a field's RULE PIPELINE editor (region / item-field / readout nodes all
// call this). `rebuild` re-renders the node body (structure changed: add/remove/reorder a rule,
// or a when/then whose operands differ); `commit` persists a plain operand edit in place;
// `retrace` re-runs the live `in → out` trace under each row. A structural change rebuilds the
// DOM, so `rebuild` re-traces itself (the caller wires that); a plain commit re-traces here.
// Cross-field rule clipboard: "copy" stashes a field's whole pipeline here, "paste" replaces
// another field's rules with a deep clone of it (survives across nodes for this session).
let ruleClipboard = [];

// `edit(mutate, { rebuild })` is the ONE way a rule row changes the model: the caller wraps it in
// its node's transaction (nodeEdit), which must clone the clean state BEFORE `mutate` runs — so
// every handler here hands its mutation over rather than performing it and reporting after.
// `rebuild: true` means the row's controls change shape (new operands, a row added/removed), so
// the node body is rebuilt — mid-transaction, without saving, and without ending the transaction.
function wireFieldRules(div, fd, { edit, retrace }) {
    fd.rules = fd.rules || [];
    const doTrace = () => retrace?.(div);   // hand the live node body over (see refreshRuleTrace)
    const rule = (e) => fd.rules[+e.target.dataset.ri];
    const editVal = (e, k) => { edit(() => { rule(e)[k] = e.target.value; }); doTrace(); };
    const editNum = (e, k) => { edit(() => { rule(e)[k] = +e.target.value; }); doTrace(); };
    const restructure = (mutate) => edit(mutate, { rebuild: true });

    div.querySelector(".ruleadd")?.addEventListener("click", () => {
        restructure(() => fd.rules.push({ when: "always", then: "set", value: "" }));
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
            restructure(() => { fd.rules = structuredClone(ruleClipboard); });   // paste REPLACES all current rules
        });
    }
    div.querySelectorAll(".rulemv").forEach((b) => b.addEventListener("click", (e) => {
        const i = +e.currentTarget.dataset.ri, j = i + +e.currentTarget.dataset.d;
        if (j < 0 || j >= fd.rules.length) return;
        restructure(() => { const [r] = fd.rules.splice(i, 1); fd.rules.splice(j, 0, r); });   // reorder = pipeline order
    }));
    // when / then change the row's operands -> rebuild; the rest are plain in-place edits
    div.querySelectorAll(".rule-when").forEach((s) => s.addEventListener("change", (e) => restructure(() => { rule(e).when = e.target.value; })));
    div.querySelectorAll(".rule-then").forEach((s) => s.addEventListener("change", (e) => restructure(() => { rule(e).then = e.target.value; })));
    div.querySelectorAll(".rule-dmode").forEach((s) => s.addEventListener("change", (e) => restructure(() => { rule(e).dict_mode = e.target.value; })));
    div.querySelectorAll(".rule-strategy").forEach((s) => s.addEventListener("change", (e) => restructure(() => { rule(e).strategy = e.target.value; })));   // toggles the sep input
    div.querySelectorAll(".rule-arg").forEach((inp) => inp.addEventListener("input", (e) => editVal(e, "arg")));
    div.querySelectorAll(".rule-val").forEach((inp) => inp.addEventListener("input", (e) => editVal(e, "value")));
    div.querySelectorAll(".rule-sep").forEach((inp) => inp.addEventListener("input", (e) => editVal(e, "sep")));
    div.querySelectorAll(".rule-udict").forEach((s) => s.addEventListener("change", (e) => editVal(e, "dict_id")));
    div.querySelectorAll(".rule-fuzzy").forEach((inp) => inp.addEventListener("change", (e) => editNum(e, "fuzzy")));
    // delete is an armed two-click (rule 2): first click turns it yellow, a click anywhere else
    // or Escape resets it, a second click removes the rule.
    div.querySelectorAll(".rule-del").forEach((b) => armConfirm(b, () => {
        restructure(() => fd.rules.splice(+b.dataset.ri, 1));
    }, { silent: true, resetOnOutside: true }));
    doTrace();   // paint the trace for the freshly-built rows (uses the live body, not a nodeEls lookup)
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
    // this window's OCR-firing edits (preprocess + static grid) defer as one transaction
    const winEdit = (mutate) => nodeEdit(n.id, "read", mutate, () => autosave(n.ref.id));
    div.querySelector(".winlive")?.addEventListener("change", (e) => {
        nodeTxn.commitIfDirty();   // autosave(null) knob: nothing re-reads, so it never joined the txn — land one first
        model.setWindowLive(n.ref.id, e.target.checked);
        model._syncWindowPriority();   // add/drop this window from the game node's priority list
        rebuildNode("game");           // reflect the add/drop in the priority list now
        autosave(null);          // a live-view flag changes nothing other nodes re-read
        renderLiveWindow();       // reflect in the live panel's window list
    });
    div.querySelector(".winstatic")?.addEventListener("change", (e) => {
        winEdit(() => {
            model.setWindowStaticGrid(n.ref.id, e.target.checked);
            [...imageCanvases.keys()].includes(n.ref.id) && clearGrid(n.ref.id);   // grid<->locator
            // static toggles whether OCR locate applies — re-bind item nodes so their locate
            // radios enable/disable to match (rebuildNode keeps each item's live cutout canvas)
            for (const it of model.window(n.ref.id)?.items || []) rebuildNode(`item:${n.ref.id}:${it.id}`);
            refreshImageBoxes(n.ref.id);   // redraw guides; re-detect this window only, on commit
        });
    });
    div.querySelectorAll(".winscroll").forEach((inp) => inp.addEventListener("change", (e) => {
        nodeTxn.commitIfDirty();   // precapture-only knob (autosave(null)) — stays immediate
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
        winEdit(() => {
            model.setPreprocessMode(n.ref.id, e.target.value);
            rebuildNode(`win:${n.ref.id}`);   // show/hide the colour controls for `color` mode
        });
    });
    div.querySelector(".pptol")?.addEventListener("input", (e) => {
        winEdit(() => model.setPreprocessTolerance(n.ref.id, +e.target.value));
    });
    div.querySelector(".ppscale")?.addEventListener("change", (e) => {
        winEdit(() => model.setPreprocessScale(n.ref.id, +e.target.value || 1));
    });
    div.querySelector(".pp-pick")?.addEventListener("click", () => armPreprocessPick(n.ref.id));
    div.querySelector(".pp-add")?.addEventListener("click", () => {
        const el = div.querySelector(".pp-hex"); const v = el.value.trim();
        if (/^#?[0-9a-fA-F]{6}$/.test(v)) winEdit(() => {
            model.addPreprocessColor(n.ref.id, v.startsWith("#") ? v : `#${v}`);
            rebuildNode(`win:${n.ref.id}`);
        });
    });
    div.querySelectorAll(".pp-cx").forEach((b) => b.addEventListener("click", () => {
        winEdit(() => {
            model.removePreprocessColor(n.ref.id, +b.dataset.i);
            rebuildNode(`win:${n.ref.id}`);
        });
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
    const hasRules = ((n.type === "itemfield" || n.type === "region") && (n.field?.rules?.length || 0) > 0)
        || (n.type === "sound" && !!n.ref?.synth);   // a sound node's open forge wants the wider width too
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
    // whether .gn-hctl actually has anything in it (same three sources built below) — types with
    // none (game, toast, sound, register, atlas, preview, vttable) get an empty cluster, so the
    // type label must stay put on hover instead of fading into nothing (graph.css .gn-has-ctl).
    const hasHoverCtl = !!(parts.head || toggle || RECT_TYPES.has(n.type));
    div.replaceChildren(
        h("div", { class: `gn-h ${hasHoverCtl ? "gn-has-ctl " : ""}${parts.pulse || ""}` },
            h("span", { class: "gn-disc", title: "collapse/expand" },
                nodeIcon(n),
                h("button", { class: "collapse", "aria-label": "collapse/expand" },
                    svg("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "aria-hidden": "true" },
                        svg("rect", { x: "3.5", y: "3.5", width: "17", height: "17", rx: "5.5" }),
                        svg("line", { x1: "8", y1: "12", x2: "16", y2: "12" }),
                        svg("line", { class: "cv", x1: "12", y1: "8", x2: "12", y2: "16" })))),
            parts.title, parts.headfix,
            // hover-only controls (satellite toggles, enable, rect-edit) all sink into ONE
            // reveal container (`.gn-hctl`, graph.css) instead of each carrying its own
            // opacity rule -- count/mix varies per node type, so the container (not per-button
            // placement) is what governs "hidden takes no space, shown shifts nothing" (rule 7).
            h("span", { class: "gn-hctl" },
                parts.head, toggle,
                RECT_TYPES.has(n.type) ? rectEditBtn() : null),
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
// A trigger's history satellite (`hist:<id>`) shows session-only data (trigger_history.py's ring
// is wiped on restart) — its height is otherwise content-driven (custH:false), so a just-reloaded,
// still-empty panel collapses to the .hist-host CSS floor (120px) even though it was resized taller
// last session. Dataset/subset vt-table satellites persist their rows, so their content-driven
// height is trustworthy and must NOT get this floor.
const isTransientSatellite = (id) => id.startsWith("hist:");
// Stamp a min-height floor from the LAST saved height on a transient satellite whose height was
// never explicitly customized (custH:false) — applySavedSize leaves that axis unstamped (by
// design, for content-driven nodes), so without this the node shows its true saved size only until
// content empties it out. custH:true nodes are already handled by applySavedSize; left alone here.
function applySatelliteHeightFloor(el, id, s) {
    if (s?.h && s.custH === false && isTransientSatellite(id)) el.style.minHeight = `${s.h}px`;
}
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
    // A register's body is a square-slot memory bank — resetting it means "make the grid as square
    // as possible", not "fit the content column". Both dots (and the shift-both) resize BOTH axes to
    // the square box; the per-axis branch below never runs for it.
    if (nodeTypeOf(id) === "register") { resetRegisterSquare(div, id); return; }
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

// Reset a register node to the size where its square-slot bank tiles as close to a SQUARE as its
// slot count allows: cols = ceil(sqrt(N)) so the grid is a touch wider than tall and any leftover
// (N not a perfect rectangle) falls to the bottom row as empty space (never a ragged right edge).
// The membank's layout() then reflows to exactly `cols` columns for this box. Cell size = the slots'
// current rendered size, so a reset re-tiles them without rescaling. Sets BOTH axes hard so it
// persists across render/reload (register width is otherwise CSS-fixed at 220px).
function resetRegisterSquare(div, id) {
    const host = div.querySelector(".data-host");
    const grid = host?.querySelector(".membank");
    const N = grid ? grid.children.length : 0;
    if (!host || !N) { div.style.width = ""; div.style.height = ""; div.style.minWidth = ""; div.style.minHeight = ""; return; }
    const gap = 4;
    const cell = grid.children[0].offsetWidth || 4.6 * 16;   // slots are square (aspect-ratio 1/1)
    const cols = Math.max(1, Math.ceil(Math.sqrt(N)));
    const rows = Math.ceil(N / cols);
    const chromeW = div.offsetWidth - host.clientWidth;      // header/ports/footer + paddings + border
    const chromeH = div.offsetHeight - host.clientHeight;
    const w = snapUp(cols * cell + (cols - 1) * gap + chromeW);
    const h = snapUp(rows * cell + (rows - 1) * gap + chromeH);
    div.style.minWidth = ""; div.style.minHeight = "";
    div.style.width = `${w}px`; div.style.height = `${h}px`;
    nodeSizes.set(id, { w, h, softW: false, softH: false, custW: true, custH: true });
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
        else { applySavedSize(div, s); applySatelliteHeightFloor(div, id, s); }
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
            else { applySavedSize(el, s); applySatelliteHeightFloor(el, id, s); }
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
        return;   // the ✓/✕ bar sits on the card, outside the swapped section — it survives
    }
    fillNode(el, n);
    // fillNode did `div.replaceChildren(...)`, throwing away a pending edit's ✓/✕ bar. Put it
    // back: a structural edit (adding a rule row, switching a rule's `when`) rebuilds the body
    // mid-transaction and must not look like the transaction ended.
    nodeTxn.reattach(id);
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
    // size copy shows for a single selected node; paste shows only once a size is copied and there's
    // a resizable target. (Both hidden in group-mode — those buttons act on the node selection.) Set
    // BEFORE collapseSeparators so their group's separators fold from the fresh state, not last tick's.
    const cpy = $("selCopySizeBtn"), pst = $("selPasteSizeBtn");
    if (cpy) cpy.hidden = groupMode || nsel !== 1;
    if (pst) pst.hidden = groupMode || !sizeClip || !ids.some(isSizeTarget);
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
        // Same boot-freeze cause as the "window" branch above (separate function, same eager-open
        // pattern) — skip during boot, loadGame's staggered open-images loop opens it instead.
        if (!boot.phase) openAtlasImage(div);   // mount the cutout-atlas image surface + taught glyph/symbol list
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
        // Every window's image auto-opens on build (pass div: this runs during buildNode, before
        // nodeEls has the node). During BOOT this used to fire for all ~9 windows back-to-back
        // inside render()'s one synchronous pass — the actual freeze that made the concurrent
        // overrides/bindings fetches (continuations queued behind it) look catastrophically slow;
        // staggering loadGame's separate pendingOpenImages loop alone did nothing because THIS was
        // the call that actually ran first. loadGame's boot fan-out (staggered via nextFrame) now
        // owns opening every window's image during boot — skip the eager call here so it isn't
        // done twice (openImage is idempotent, but skipping avoids the redundant no-op path).
        if (!boot.phase) openImage(n.ref.id, div);
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
            afterBoot(() => refreshSourcePreview(r.id));   // parse the source's rules into BOTH satellites
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
            nodeTxn.commitIfDirty();   // rename render()s + changes node identity — land any pending edit first
            renameNode(e.target, oldId,
                () => model.renameRegion(n.win.id, oldId, e.target.value.trim()),
                () => movePos(`reg:${n.win.id}:${oldId}`, `reg:${n.win.id}:${n.ref.id}`),
                () => { render(); autosave(n.win.id); refreshImageBoxes(n.win.id); });   // re-OCR only this window
        });
        // Only the capture/confidence knobs live on the field body now; all value processing is
        // authored in the rule pipeline (wired below). `type` rebuilds so the rule menus re-filter.
        div.querySelectorAll(".fset").forEach((inp) => onValueEdit(inp, (e, live) => {
            if (!fld) return;
            const k = e.target.dataset.k;
            nodeEdit(n.id, "read", () => {
                if (k === "type") { fld.type = e.target.value; if (!live) rebuildNode(n.id); }  // re-filters the rule menus
                else if (k === "isolate") fld.isolate = e.target.checked;
                else if (k === "glyph_check") fld.glyph_check = e.target.checked;
                else if (k === "minconf") fld.min_confidence = +e.target.value || 0;
            }, () => autosave(n.win?.id));   // re-OCR only this window, once on commit
        }));
        if (fld) wireFieldRules(div, fld, {
            edit: rulesEdit(n.id, () => autosave(n.win?.id)),
            retrace: (el) => refreshRuleTrace(n.win.id, fld.id, n.id, el),
        });
    } else if (n.type === "detect") {
        const owner = n.win.id;                         // window id, or "game" for the gate
        const isGate = owner === "game";
        const ownerNode = nodeIdOf(owner);
        // persist a detector edit: window detectors re-OCR their window; gate detectors just
        // save + re-run the cheap gate (autosave(null) doesn't re-read a window). BOTH branches
        // end in a detect pass that spins this very node, so both defer to the transaction.
        const saveDet = () => { if (isGate) { autosave(null); refreshDetect("game"); } else autosave(owner); };
        div.querySelector(".gi-id").addEventListener("change", (e) => {
            const oldId = n.ref.id;
            nodeTxn.commitIfDirty();   // a rename render()s + changes node identity — land any pending knob edit first
            renameNode(e.target, oldId,
                () => model.renameDetect(owner, oldId, e.target.value.trim()),
                () => movePos(`det:${owner}:${oldId}`, `det:${owner}:${n.ref.id}`),
                () => { render(); rebuildNode(ownerNode); saveDet(); refreshImageBoxes(owner); });
        });
        div.querySelectorAll(".aset").forEach((inp) => onValueEdit(inp, (e, live) => {
            const k = e.target.dataset.k;
            nodeEdit(n.id, "read", () => {
                if (k === "kind") { setDetectKind(n.ref, e.target.value); if (!live) rebuildNode(n.id); refreshImageBoxes(owner); return; }
                if (k === "text") n.ref.text = e.target.value;
                else if (k === "color") { n.ref.color = e.target.value.trim(); if (!live) rebuildNode(n.id); }
                else if (k === "colorpick") { n.ref.color = e.target.value; if (!live) rebuildNode(n.id); }
                else if (k === "tol") n.ref.tolerance = Math.max(0, Math.trunc(+e.target.value) || 0);
                else if (k === "width") n.ref.width = Math.max(0, +e.target.value || 0);
                else if (k === "thr") n.ref.threshold = +e.target.value;
                else if (k === "match") n.ref.match = e.target.value;
                else if (k === "minchars") n.ref.min_chars = Math.max(0, Math.trunc(+e.target.value) || 0);
                else if (k === "strip") n.ref.strip = e.target.value;
                else if (k === "case") n.ref.case_sensitive = e.target.checked;
                // mode change shows/hides "read ⊆ text" (ignored by full/exact) -> rebuild the body
                if (k === "match" && !live) rebuildNode(n.id);
            }, saveDet);   // a detector knob re-runs detect for ONLY this owner — once, on commit
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
    // current image. `refetch` = immediate (node just OPENED — show a value right away, matches
    // scheduleItemRead's img.onload pattern). Only fired below when no edit txn is armed on this
    // node: fillNode re-runs this wiring on every rebuildNode (a type change, a rule add/remove),
    // and an unconditional refetch() there would OCR the box WHILE the edit is still uncommitted —
    // worse, /api/preview also feeds live registers, so a persist-set register would silently write
    // the dataset mid-edit. `scheduleRefetch` = an EDIT changed the read config — queue it on the
    // shared window-read clock (scheduleWindowRead) instead of firing its own separate un-debounced
    // fetch, so it settles in the SAME beat as the rest of that edit's fallout, once committed.
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
    div.querySelectorAll(".roset").forEach((inp) => onValueEdit(inp, (e, live) => {
        if (!fld) return;
        const k = e.target.dataset.k;
        nodeEdit(n.id, "read", () => {
            if (k === "type") { fld.type = e.target.value; if (!live) rebuildNode(n.id); }  // re-filters the rule menus
            else if (k === "isolate") fld.isolate = e.target.checked;
            else if (k === "glyph_check") fld.glyph_check = e.target.checked;
            else if (k === "minconf") fld.min_confidence = +e.target.value || 0;
        }, () => { autosave(winId); scheduleRefetch(); });   // read config changed -> re-read the value off the current image
    }));
    if (fld) wireFieldRules(div, fld, {
        edit: rulesEdit(n.id, () => { autosave(winId); scheduleRefetch(); }),
        retrace: (el) => refreshRuleTrace(winId, fld.id, n.id, el),
    });
    // initial value off the current image — but ONLY on a genuine node-open, not a mid-edit
    // rebuild. While a config txn is armed the read is deferred to commit (scheduleRefetch
    // aftermath); firing here would OCR uncommitted. Mirrors the armed-gate in refreshRuleTrace.
    if (!nodeTxn.armed(n.id)) refetch();
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
    let pos = null, conf = null, px = null, file = null;
    try {
        const r = await api.scrollPos(model.profile.name, img, orientation);
        pos = r.pos; conf = r.conf; px = r.thumb_px; file = r.name;
    } catch (e) { setStatus(`thumb read failed: ${e.message || e}`, "warn"); }
    if (!file) { setStatus("cutout save failed — not added", "err"); return; }
    model.addScrollSample(winId, { file, rows: 0, pos, conf, px });
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
    // reflow (image load / content) -> edges follow AND boxes re-hug the node's new size; never snaps.
    // Skipped during boot: every window's image load + content mount fires this on all N nodes behind
    // the veil, and renderGroups reads each member's rect -> N * (30 forced layouts) of pure thrash for
    // a screen nobody sees. finishBoot() runs the ONE real edge+group pass when the veil drops.
    observeResize(el, () => { if (boot.phase) return; requestEdges(); groups.renderGroups(); }, { gate: true });
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
            showGuides(moved);   // live alignment guides to whatever the moving cluster lines up with
        },
        onSettle: () => {
            for (const mid of moved) nodeEls.get(mid)?.classList.remove("snapping");
            setDraggingNodes(false);
            flushEdges();   // paint the final positions now, dropping any pending coalesced frame
            groups.absorb([id, ...extra.filter((x) => x !== id)]);   // dropped inside a group box -> join it
            resizeCanvas(); groups.renderGroups(); persist.layout(); renderNodeViews();
            flashGuides(moved);   // keep the resting alignment shown briefly, then fade
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

async function loadGame(name, { discard = false } = {}) {
    if (!name) return;
    boot.phase = true;   // reopened images read the server OCR cache (no engine touch) until the load settles
    document.body.classList.add("booting");   // freeze all CSS motion but the veil spinner while it covers the screen (overlays.css)
    // `discard` is the conflict modal's "load server" path: the model still holds an
    // unsaved edit that just lost a 409. persist.flush() would resubmit it and hit the
    // SAME conflict again (infinite loop) — drop it instead, unflushed, and let the
    // normal load below (model.load below replaces the profile wholesale) adopt the
    // server's copy.
    if (discard) persist.discardPending();
    else await persist.flush();   // commit any pending save before switching games
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
    nodeTxn.abandon();   // a pending edit belongs to the OUTGOING profile's objects — drop it, don't carry it across
    model.load(profile);
    seedSubsetSig();        // baseline subset defs so an unrelated save recomputes NO subset (only new/edited ones diff)
    nodeEls.clear();
    $("gnodes").replaceChildren();
    for (const winId of [...imageCanvases.keys()]) closeImage(winId);
    batchesState.clear();   // batches render inline per node; drop stale selection state
    selected.clear();       // drop any multi-selection from the previous game
    clearGuides();          // wipe alignment guides drawn against the outgoing game's nodes
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
    log(`[diag] render start t=${performance.now().toFixed(1)} boot=${boot.phase}`, "dim");
    { const d = timed("render"); render(); d(); }   // diagnostic: which boot phase actually eats the wall-time
    log(`[diag] render end / overrides start t=${performance.now().toFixed(1)}`, "dim");
    { const d = timed("apply overrides"); await prettyOverrides.initOverrides(name); d(); }   // layer this game's transient pretty overrides onto the model
    log(`[diag] overrides end t=${performance.now().toFixed(1)}`, "dim");
    refreshDirtyUI();
    if (prettyActive && _pretty) _pretty.setPrettyGame(name);
    // reopen saved images (canvas lives in node); awaited so boot can tell when the
    // initial image loads (and the detects they fire) have actually started. MUST run BEFORE
    // grouping orphans: grouping a NEW orphan child persists the layout, and collectLayout
    // writes open_images from the live `openImages` set — if the canvases aren't open yet that
    // set is empty and we'd save open_images:[], stranding every window's canvas on next load.
    {
        // Stagger the per-window canvas/overlay builds (each openImage's SYNCHRONOUS prefix)
        // across frames instead of firing all of them in one synchronous burst — that burst
        // was the main-thread freeze that made the concurrent overrides/bindings fetches look
        // slow (their continuations queued behind it). openImage is still CALLED immediately
        // each iteration (so its image load starts right away, concurrent with the others) —
        // only the wait between calls is deferred to the next paint.
        // Every window's image opens on boot (buildNode used to do this unconditionally per
        // window — see its `if (!boot.phase) openImage(...)` guard); iterate ALL windows here,
        // not just `pendingOpenImages` (that list is the undo/redo restore channel — see
        // reconcileOpenImages — and can legitimately lag a window added since the last save).
        const d = timed("open images");
        const opens = [openAtlasImage()];   // separate function/branch (fillNode's "atlas" case), same gate+stagger
        await nextFrame();
        for (const w of model.profile.windows) {
            opens.push(openImage(w.id));
            await nextFrame();
        }
        await Promise.all(opens);
        d();
    }
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
    mountCanvasLayers();   // mount the edge/group canvas renderer once (idempotent)
    hub.kick();   // new game -> beat the hub so every panel re-reflects its state now
    setStatus(`loaded ${name}`);
}

// Boot is over: run the ONE deferred layout pass and fire the held-back fetches. Both boot-end
// sites (initial page load + game switch) call this so they never drift (rule 7). Edge routing AND
// group boxes are skipped all through boot (behind the veil) — this is where they get their single
// real pass, so the graph is correct the instant the veil drops.
function finishBoot() {
    boot.phase = false;
    document.body.classList.remove("booting");   // veil is about to drop -> let CSS motion run again
    drawEdges();            // routing was frozen throughout boot (routing.js) -> the one real pass now
    groups.renderGroups();  // group boxes were skipped throughout boot -> hug members once now
    flushBoot();            // fire the summary/register/preview fetches deferred during boot
}

$("gameSelect").addEventListener("change", async (e) => {
    await loadGame(e.target.value);
    await bootSettle();   // let the reopened images' cached reads drain, then re-OCR fresh on edits
    finishBoot();
});
// Mint a blank game profile. Called from the settings modal's "new game" section.
function createGame(name) {
    name = (name || "").trim();
    if (!name) { setStatus("enter a name"); return false; }
    nodeTxn.abandon();   // a pending edit belongs to the OUTGOING profile's objects
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
    stopAllForgePreview();   // don't leave a forge loop sounding across a node<->pretty switch
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
        // disarm on an outside press OR Escape — the one shared outside-dismiss primitive (capture,
        // so we disarm before the outside target handles its own click).
        offGlobal = onOutside(btn, disarm, { escape: true, escapePriority: 70 });
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
    let offKey = null;
    const drop = (e) => {
        e.preventDefault(); e.stopPropagation();
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mousedown", drop, true);
        offKey?.(); offKey = null;
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
    // Any key also drops the carried clones — on the central bus at priority 500 (above the graph
    // shortcuts' 20) and CONSUMING, so the terminating key can't also fire WASD/undo/etc.
    offKey = registerKey({
        combo: "*", scope: SCOPE.GRAPH, priority: 500, allowInField: true,
        run: (e) => { drop(e); return true; }, stop: true,
    });
}
$("selCloneBtn").addEventListener("click", cloneSelection);

// ---- size copy / paste (selection toolbar) --------------------------------
// A session clipboard holding one node's rendered box. Copy grabs the single selected node's
// size; paste stamps it onto every resizable node in the (possibly multi-) selection at once,
// through the SAME nodeSizes funnel a grip resize / __nodeHistory.resizeNode uses. `sizeClip`
// ({w,h} in unscaled local px, or null until a size is copied) is declared up top with the other
// selection scalars so syncMultiSelect can read it without a TDZ hazard.
// a node can take a pasted size when it's a real, non-collapsed card (collapsed = header-only).
function isSizeTarget(id) { return nodeEls.has(id) && !collapsed.has(id); }
function copySize() {
    const id = selectionIds()[0];   // copy is offered only for a single selected node
    const el = id && nodeEls.get(id);
    if (!el) return;
    sizeClip = { w: el.offsetWidth, h: el.offsetHeight };
    setStatus(`size copied — ${Math.round(sizeClip.w)} x ${Math.round(sizeClip.h)}`);
    syncMultiSelect();   // reveal the paste button now a size exists
}
function pasteSize() {
    if (!sizeClip) return;
    const w = snapUp(sizeClip.w), h = snapUp(sizeClip.h);   // quantize to the grid like a grip settle
    const targets = selectionIds().filter(isSizeTarget);
    if (!targets.length) return;
    for (const id of targets) {
        // widthOnly nodes (item/window/game/atlas) wrap a fixed-aspect canvas — stamp width only.
        const s = WIDTH_ONLY_NODES.has(nodeTypeOf(id))
            ? { w, custW: true, custH: false, softW: false, softH: false }
            : { w, h, custW: true, custH: true, softW: false, softH: false };
        nodeSizes.set(id, s);
        const el = nodeEls.get(id);
        if (el) { applySavedSize(el, s); markNodeSized(el, id); }
    }
    flushEdges(); groups.renderGroups(); persist.layout();   // re-route + record undo + save
    setStatus(`pasted size to ${targets.length} node${targets.length === 1 ? "" : "s"}`);
}
$("selCopySizeBtn").addEventListener("click", copySize);
$("selPasteSizeBtn").addEventListener("click", pasteSize);

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
// Any key cancels an in-flight smooth pan-to-node — top priority + non-consuming so it runs before
// every other shortcut, exactly as the old window-capture keydown did (now on the central bus).
registerKey({ combo: "*", scope: SCOPE.ANY, priority: 1000, allowInField: true, run: (ev) => { cancelPan(ev); return false; } });

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

// ---- keyboard node-navigation (arrows pan, Enter selects, Tab traps inside a node) ----------
// Arrow keys walk the graph WITHOUT selecting: plain arrows step node-to-node, Shift+arrows step
// between top-level GROUPS (never sub/super groups). While one or more arrows are HELD a big arrow
// is drawn from the current anchor to the candidate target (the neighbour in the held direction);
// two arrows aim diagonally. The camera pans there once EVERY arrow is released. Pressing arrows
// again mid-pan does NOT stop it — it redirects to the next hop and STACKS another arrow (the prior
// hop's arrow stays, screen-fixed, as a breadcrumb) until the whole run settles and all clear.
// `navAnchor` is the nav cursor (node OR group id), distinct from the actual selection.
let navAnchor = null, navAnchorMode = false;   // cursor id + which mode it belongs to (false=node, true=group)
let navGroupMode = false;                       // the current chain's mode (fixed on its first held arrow)
let _lastEsc = 0;                 // performance.now() of the previous Escape (double-tap = fit-all)
const heldArrows = new Set();     // arrow keys currently down
let navTarget = null;             // the id the held arrows point at (panned to on release)
const ARROW = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };

// {id, centre} of every navigable item for the mode, and the world rect of one — node bodies for
// node-mode, top-level group boxes (groups.groupBoxes() excludes sub/super) for group-mode.
function navCentres(groupMode) {
    const out = [];
    if (groupMode) {
        for (const g of groups.groupBoxes()) out.push({ id: g.id, x: g.box.x + g.box.w / 2, y: g.box.y + g.box.h / 2 });
    } else {
        for (const [id, p] of pos) {
            const el = nodeEls.get(id);
            if (el) out.push({ id, x: p.x + el.offsetWidth / 2, y: p.y + el.offsetHeight / 2 });
        }
    }
    return out;
}
function nodeCentres() { return navCentres(false); }
function navRectOf(id, groupMode) {
    if (groupMode) { const g = groups.groupBoxes().find((b) => b.id === id); return g ? g.box : null; }
    const p = pos.get(id), el = nodeEls.get(id);
    return p && el ? { x: p.x, y: p.y, w: el.offsetWidth, h: el.offsetHeight } : null;
}
// The summed direction of the currently held arrows.
function heldDir() {
    let dx = 0, dy = 0;
    for (const k of heldArrows) { const v = ARROW[k]; dx += v[0]; dy += v[1]; }
    return [dx, dy];
}

// Recompute the candidate target for the held direction and (re)draw the LIVE preview arrow to it
// (leaving any locked breadcrumb arrows in place).
function updateNavPreview() {
    const [dx, dy] = heldDir();
    const gm = navGroupMode;
    const centres = navCentres(gm);
    if ((!dx && !dy) || !centres.length) { navTarget = null; drawLive(null); return; }
    // reuse the anchor only if it still exists in THIS mode's set; else seed from the centre-most item
    let anchorId = (navAnchor && navAnchorMode === gm && centres.some((c) => c.id === navAnchor)) ? navAnchor : null;
    if (!anchorId) { const c = viewportCenterWorld(); anchorId = centreMost(centres, c.x, c.y); }
    const from = centres.find((c) => c.id === anchorId);
    const next = from && nearestInDir(centres, from, dx, dy);
    navTarget = next || null;
    const to = next && centres.find((c) => c.id === next);
    if (from && to) drawLive({ x: from.x, y: from.y }, { x: to.x, y: to.y }, navColor(from.id, gm), navColor(to.id, gm));
    else drawLive(null);
}

// The colour to tint a nav arrow's end at a given item: a node's own tint (--nt, resolved), a
// group's outline/fill colour, or the accent as a fallback.
function navColor(id, groupMode) {
    if (groupMode) {
        const g = groups.allGroups().find((x) => x.id === id);   // raw record: outline/bg are colour strings
        return (g && (typeof g.outline === "string" && g.outline || g.bg)) || cssVarColor("--accent");
    }
    const el = nodeEls.get(id);
    const c = el && getComputedStyle(el).getPropertyValue("--nt").trim();
    return c || cssVarColor("--accent");
}
function cssVarColor(name) { return getComputedStyle(document.body).getPropertyValue(name).trim() || "#4da3ff"; }

// All arrows released: pan to the candidate (no selection). The live arrow LOCKS in place (so a
// mid-pan re-press stacks a new one over it); each locked arrow then dies on its OWN timer.
function commitNav() {
    const target = navTarget, gm = navGroupMode; navTarget = null;
    const rect = target && navRectOf(target, gm);
    if (rect) {
        navAnchor = target; navAnchorMode = gm;
        lockLive();                                            // this hop's arrow -> its own death timer
        panZoomToRect(rect, { fit: false });                   // redirects a pan already in flight (no stop)
    } else drawLive(null);
}

// Tab is trapped INSIDE the selected node: while a node is focus-selected (and no box overlay owns
// the keys), Tab / Shift+Tab cycle only its own focusable controls, wrapping at the ends, instead
// of walking out into the rest of the page. Own listener (capture) because the main keydown handler
// bails on focused inputs — Tab must keep working while a field inside the node has focus.
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
function nodeFocusables(el) {
    return [...el.querySelectorAll(FOCUSABLE)].filter((c) => c.offsetParent !== null && !c.closest("[inert]"));
}
// allowInField: Tab must keep cycling even while a field INSIDE the node has focus (the whole point of
// the trap), so it opts out of the registry's input-field bail. Consuming via return (preventDefault
// blocks native tabbing); GRAPH scope replaces the prettyActive bail.
registerKey({
    match: (ev) => ev.key === "Tab", scope: SCOPE.GRAPH, priority: 65, allowInField: true,
    when: () => !overlays.get(activeOverlayKey) && !!(selectedNodeId && nodeEls.get(selectedNodeId)),
    run: (ev) => {
        const el = nodeEls.get(selectedNodeId);
        const items = nodeFocusables(el);
        if (!items.length) { ev.preventDefault(); return true; }  // trap even with nothing to land on
        let i = items.indexOf(document.activeElement);
        if (i === -1) i = ev.shiftKey ? 0 : -1;              // focus outside the node -> enter at an end
        const next = (i + (ev.shiftKey ? -1 : 1) + items.length) % items.length;
        items[next].focus();
        ev.preventDefault(); return true;
    },
});

// Releasing arrows drives the node-nav pan. Commit on the FIRST release using the direction held up
// to that instant, then drop every remaining held key: a diagonal is two keys, and the user can't
// release both on the exact same tick — waiting for the last release would re-preview the lone
// still-held key and snap to its orthogonal neighbour instead of the diagonal target. Dropping the
// leftover keys also stops their auto-repeat from restarting a stray move (keydown guards on repeat).
document.addEventListener("keyup", (ev) => {
    if (!heldArrows.has(ev.key)) return;
    heldArrows.clear();
    commitNav();
});
window.addEventListener("blur", () => { if (heldArrows.size) { heldArrows.clear(); navTarget = null; clearNavArrow(); } });

// The graph view's global shortcut handler — Escape (3-stage), PageUp/Down zoom, Enter/Arrow node-nav,
// undo/redo, Delete, Shift+R, WASD move / Shift+WASD resize (node OR the live box overlay). Registered
// as ONE GRAPH-scope entry on the central input bus (inputbus.js) rather than its own document keydown:
// the three shared guards move OUT — scope=GRAPH replaces the `prettyActive` bail, the registry's
// input-field bail replaces the INPUT/SELECT/TEXTAREA check (now a superset: also contenteditable),
// and a focused `.tn-img-pv` preview (which owns WASD for its own element) yields via `when`. The branch
// logic below is otherwise unchanged. NUDGE (the shared dir map) is declared at module scope.
const MINB = 0.004;
registerKey({
    scope: SCOPE.GRAPH, priority: 20,
    when: () => !document.activeElement?.closest?.(".tn-img-pv"),
    run: (ev) => {
    // Escape: disarm a drawing tool first (a tool-input's own Escape is handled above — INPUT bails
    // first); else a single Esc clears the selection, and a double Esc (within 400ms) frames every
    // node (fit-all). navAnchor resets on fit-all so arrow-nav restarts from the centre.
    if (ev.key === "Escape") {
        if (clearTools()) { ev.preventDefault(); return; }
        const now = performance.now();
        if (now - _lastEsc < 400) { _lastEsc = 0; navAnchor = null; fitAllZoom(); ev.preventDefault(); return; }
        _lastEsc = now;
        if (selected.size || selectedNodeId || overlays.get(activeOverlayKey)) { deselectAll(); ev.preventDefault(); return; }
        return;
    }
    const plain = !ev.ctrlKey && !ev.metaKey && !ev.altKey;   // leave modified combos to the browser
    // PageUp/PageDown step the discrete zoom ladder around the viewport centre — active whenever
    // not typing (the INPUT bail above already guards that), regardless of selection.
    if (plain && (ev.key === "PageUp" || ev.key === "PageDown")) {
        zoomStep(ev.key === "PageUp" ? 1 : -1);
        ev.preventDefault(); return;
    }
    // Arrow keys + Enter navigate the node cloud, but ONLY when nothing is selected — a selected
    // node hands the keyboard to WASD-nudge + Tab. Arrows pan to the neighbouring node WITHOUT
    // selecting; Enter selects whichever node is centre-most to the camera.
    const navIdle = plain && !overlays.get(activeOverlayKey) && !selected.size && !selectedNodeId;
    if (navIdle && ev.key === "Enter") {
        const c = viewportCenterWorld();
        const anchor = centreMost(nodeCentres(), c.x, c.y);
        if (anchor) { navAnchor = anchor; navAnchorMode = false; focusNode(anchor); panZoomTo(anchor, { fit: true }); }
        ev.preventDefault(); return;
    }
    if (navIdle && ARROW[ev.key]) {
        if (!ev.repeat && !heldArrows.has(ev.key)) {
            if (heldArrows.size === 0) navGroupMode = ev.shiftKey;   // Shift held at chain start -> group nav
            heldArrows.add(ev.key); updateNavPreview();
        }
        ev.preventDefault(); return;
    }
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
                    flashGuides(selIds);   // show what the resized node(s) now line up with, then fade
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
                flashGuides(selIds);   // show what the moved node(s) now line up with, then fade
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
    // out (edit_txn.js). Holding W for a second is then one model write, one save, one re-OCR and
    // one undo step — not thirty. The atlas surface has no batch (nothing to re-read), so it keeps
    // writing straight through.
    if (rec.kind === "window" || rec.kind === "item") editBox(activeOverlayKey, b);
    else {
        rec.persist(b); rec.refresh();
        drawEdges(); autosave(rec.winId);
        rectEditCanvasSync(activeOverlayKey);
    }
    ev.preventDefault();
    },
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
        document.body.classList.remove("booting");   // screen is interactive now -> CSS motion on (covers error/offline paths that skip finishBoot)
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
        else log(`${ev.ok ? "✓" : "✗"} ${ev.method} ${ev.path} · ${ev.ms}ms${ev.srv != null ? ` (srv ${ev.srv}ms)` : ""}${ev.ok ? "" : " " + (ev.reason || "failed")}`, ev.ok ? undefined : "err");
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
        finishBoot();   // boot OCR drained -> re-OCR fresh on later reads + run the one edge/group pass
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
    refreshItemTemplateRefs, wireArmedRemove, NUDGE,
    onValueEdit, rulesEdit, wireFieldRules,
};
