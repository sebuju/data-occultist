// Node-view home: edit a game's structure as a graph (Game → Windows → Fields →
// Datasets), drag to arrange, drag-wire a window to a dataset, edit inline, and
// watch live dataset counts. Box drawing happens on each node's inline canvas.
import * as api from "../api.js";
import * as conn from "../conn.js";
import * as hub from "../hub.js";
import { h, frag, svg } from "../dom.js";
import { nodeIcon } from "./node_icons.js";
import { onOutside } from "../inputbus.js";
import { since } from "../datefmt.js";
import { log, timed, mirrorConsole } from "../log.js";

mirrorConsole();   // surface uncaught errors + console.error/warn in the log bar (no devtools needed)
import { snap, addResizeGrips, suppressNextClick } from "./dragresize.js";
import { wireSound } from "./sound_wire.js";
import { wireToast } from "./toast_wire.js";
import {
    syncCellSize, itemChanged, wireItemControls, wireItemField, wireItemTell,
    addFieldToItemGroup, addTellToItemGroup, refreshItemTemplateRefs,
} from "./item_wire.js";
import {
    subsetParts, refreshSubsetNode, refreshAllSubsetNodes, refreshDatasetConsumers,
    queueNodeRefresh, wireSubset,
} from "./subset_wire.js";
import {
    wireProducer, wireProducerPreview, wireTrigger, wireGate, wireRouter, wireAction, wireRegister, wireProcess, wireSource,
    refreshSourcePreview,
} from "./io_wire.js";
import { persist, setScrubHook } from "./persist.js";
import * as prettyOverrides from "../pretty/overrides.js";
import * as groups from "./groups.js";
import { initTitlebar } from "../titlebar.js";

initTitlebar();   // custom window chrome — no-op outside the desktop window

import {
    $, setStatus, model, pos, nodeEls, collapsed, view, selected, nodeSizes, openImages,
    imageCanvases, itemCanvases, busy, overlays,
    prevPresent, prevLastTs, dsTab, clearGrid, nw, nh, boot,
} from "./state.js";
import { drawEdges, nodeRect, freezeRouting, requestEdges } from "./routing.js";
import {
    panTo, panZoomTo, panZoomToRect, zoomToNode, viewportCenterWorld,
    applyView, resizeCanvas, dragOnlyZoom,
} from "./camera.js";
import { movePos, renameNode } from "./node_lifecycle.js";
import { nodeParts, windowControls, gamePriority, itemLists, enableBtn, vtShowRemoved, rectEditBtn, markColorCollisions } from "./node_parts.js";
import * as dsevents from "./dsevents.js";
import { renderReadoutHistory } from "./readout_history_node.js";
import { renderProducerHistory } from "./producer_history_node.js";
import { renderRegisterHistory } from "./register_history_node.js";
import { renderProcessHistory } from "./process_history_node.js";
import { clearTools } from "./drawtool.js";
import { singleFlight } from "../singleflight.js";
import { nmSyncSelection, renderNodeViews } from "./panels/nodemap.js";
import {
    refreshDataNode, refreshDatasetNode, collapseVtablesExcept,
    batchesState, batEls, loadBatchesNode, refreshAllBatchesNodes,
} from "./panels/datanodes.js";
import { armedButton } from "./armbtn.js";
import { workers, unregisterWorker } from "./workers.js";
import {
    openImage, openAtlasImage, refreshDetect, nodeIdOf,
    openItemImage,
    scheduleWindowRead, flushWindowRead,
    refreshImageBoxes, selectRegionNode, refreshRuleTrace,
    RECT_TYPES, toggleRectEditor, openDetectColorPick,
    mountMatchPreview, refreshMatchPreviews,
} from "./imaging.js";
import * as nodeTxn from "./node_txn.js";
import {
    WIDTH_ONLY_NODES, markNodeSized, makeNodeResizable, nodeResizeOpts,
    reapplyNodeSizes, startGroupResize,
} from "./node_resize.js";
import { syncKillGpu, wireSettingsButton } from "./settings_modal.js";
import { bootGraph } from "./graph_boot.js";
import { refreshDirtyUI } from "./pretty_switch.js";
import { wireOutPort, targetIdOf } from "./port_wire.js";
import {
    setDetectKind, wireWindowControls, wireGamePriority, wireReadout, wireScrollbar,
} from "./window_wire.js";
import {
    ensurePositions, placeNewNode, inheritGroupFrom, placeAt, paintSatToggle, applySatellite,
    showSatellite, startMove, moveNodes, dragFromHandle,
} from "./node_layout.js";
import { wireCanvasInput } from "./canvas_input.js";
import { wireCtrlSelect } from "./ctrl_select.js";
import {
    selectionIds, setMultiSelect, clearMultiSelect, syncMultiSelect, deleteSelection,
    wireSelectionToolbar,
} from "./selection.js";
import "./shortcuts.js";
import { wireFieldRules, wireArmedRemove } from "./rules_editor.js";
import { canDisable, isRemovable, removeNode } from "./node_remove.js";
import { initPanels } from "./panels_init.js";
import {
    _bootDetails, collectLayout, hydrateNodeLayout, reconcileOpenImages,
    initGameLifecycle, refreshGames, loadGame, finishBoot, createGame,
} from "./game_lifecycle.js";

const FLOW_FALLBACK_MS = 15000;   // safety-net /api/flow poll; the dataset-change bus is the real mechanism
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
export let activeOverlayKey = null;        // which overlay holds the live box selection

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

initGameLifecycle();   // table-store + persist funnel (incl. save-conflict modal) + game-select wiring

// ---- groups (titled boxes around nodes; pure layout) -----------------------
// Node type from its id prefix (game | win:… | reg:… | ds:… | …) for default titles.
const _TYPE_BY_PREFIX = { win: "window", prev: "preview", vt: "vttable", vtd: "vttable", prod: "vttable", prodhist: "vttable", hist: "vttable", rohist: "vttable", reghist: "vttable", prochist: "vttable", reg: "region", register: "register", process: "process", ro: "readout", det: "detect", sb: "scrollbar", item: "item", fld: "itemfield", tell: "itemtell", ds: "dataset", sub: "subset", producer: "producer", trigger: "trigger", gate: "gate", router: "router", action: "action", dict: "dictionary", src: "filesource", toast: "toast", sound: "sound" };
export function nodeTypeOf(id) { return id === "game" ? "game" : id === "atlas" ? "atlas" : (_TYPE_BY_PREFIX[id.split(":")[0]] || null); }
// Strip a node id's KNOWN type-prefix -> the bare id the model keys on. Same master map as
// nodeTypeOf (one source of truth), so a new node type that registers its prefix above is wired
// end-to-end. Strips only the leading segment (readout ro:win:vid -> win:vid); leaves unknown/
// unprefixed ids untouched.
export function bareNodeId(id) {
    const s = String(id || "");
    const pfx = s.split(":")[0];
    return (pfx in _TYPE_BY_PREFIX) ? s.slice(pfx.length + 1) : s;
}
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
    // frame an arbitrary world rect (theme panel "used by" click → jump to that group/sub/super)
    focusRect: (box, opts) => panZoomToRect(box, opts),
    // drag the group's resize grip → resize the group's container box (sets explicit w/h)
    startGroupResize,
});

// Node identity / per-id state (rename + delete carry, the rename flow) lives in node_lifecycle.js
// — see the imports at the top of this file.

// Node body builders (windowControls/itemLists/fieldConfigBody/nodeParts/keyPrevNode/…) live in node_parts.js

// ---- layout ---------------------------------------------------------------

// pan/zoom camera (panTo/panZoomTo/applyView/resizeCanvas/onWheel/…) lives in camera.js
// group-box resize drag (startGroupResize) lives in node_resize.js

// ---- render ---------------------------------------------------------------





// Keep the cell-size inputs in sync after a canvas cell-resize (which doesn't rebuild the node).





// Shared wiring for a field's RULE PIPELINE editor (region / item-field / readout nodes all
// call this). `rebuild` re-renders the node body (structure changed: add/remove/reorder a rule,
// or a when/then whose operands differ); `commit` persists a plain operand edit in place;
// the aggregate <select> itself lives in node_parts.js — ONE primitive shared with the dataset
// node's own "many → one" policy (rule 7). Here it's rendered with "" = inherit that policy.



function fillNode(div, n, wire = true) {
    const isCollapsed = collapsed.has(n.id);
    const canToggle = canDisable(n.type);
    const enabled = !(canToggle && n.ref && n.ref.enabled === false);
    // field nodes carrying fallback rules get a wider natural width (the rule row packs three
    // selects + a value + trash on one line) so a size RESET lands wide enough, not crushed.
    const hasRules = ((n.type === "itemfield" || n.type === "region") && (n.field?.rules?.length || 0) > 0)
        || (n.type === "sound" && !!n.ref?.synth);   // a sound node's open forge wants the wider width too
    const prettyDirty = prettyOverrides.isNodeDirty(n.id);
    div.className = `gnode ${n.type}${isCollapsed ? " collapsed" : ""}${enabled ? "" : " node-disabled"}${hasRules ? " has-rules" : ""}${prettyDirty ? " pretty-dirty" : ""}`;
    // A satellite (vttable/preview) inherits its PARENT node's hue: override --nt inline with the
    // parent type's token so a dataset table reads mint, a readout-history grid reads yellow, etc.
    // (default .gnode.vttable is steel). Cleared on a non-satellite since fillNode reuses the div.
    const satPar = model.satelliteParent(n.id);
    const parType = satPar && nodeTypeOf(satPar);
    if (parType) div.style.setProperty("--nt", `var(--nt-${parType})`);
    else div.style.removeProperty("--nt");
    if (n.type === "dataset") div.dataset.ds = n.ref;   // out-port drop target id (tabs moved to the vt-table satellite)
    const parts = nodeParts(n);
    // the enable toggle (gn-enable button) — only on toggleable node types; null otherwise. Its
    // .gn-enable class + `aria-pressed` state are read/flipped by the post-build click wiring below.
    const toggle = canToggle
        ? enableBtn({ on: enabled, title: "enabled — turn off to skip this node during detection" })
        : null;
    // delete + detach moved to the selection toolbar (act on the selection); nodes carry
    // neither button anymore — select a node (or several) and use the toolbar.
    const typeLabel = n.type === "itemfield" ? "field"
        : n.type === "itemtell" ? "tell"   // kind now lives in the node's own dropdown, not the tag
        : n.type;
    // whether .gn-hctl actually has anything in it (same three sources built below) — types with
    // none (game, atlas, preview, vttable) get an empty cluster, so the type label must stay put on
    // hover instead of fading into nothing (graph.css .gn-has-ctl).
    const hasHoverCtl = !!(parts.head || toggle || RECT_TYPES.has(n.type));   // any of these -> the tag fades to reveal .gn-hctl on hover
    div.replaceChildren(
        // box-panel header: TWO islands that straddle the card's top border (graph.css), each with
        // the card bg so it punches a gap in the frame — the `┌─ title ─── [tag] ─┐` look. Left
        // island = disc + title (+ always-visible headfix like vttable tabs); right island = the
        // hover cluster, type tag, pretty/spin badges, and the always-visible enable rocker.
        h("div", { class: `gn-h ${hasHoverCtl ? "gn-has-ctl " : ""}${parts.pulse || ""}` },
            h("span", { class: "gn-hl" },
                h("span", { class: "gn-disc", title: "collapse/expand" },
                    nodeIcon(n),
                    h("button", { class: "collapse", "aria-label": "collapse/expand" },
                        svg("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "aria-hidden": "true" },
                            svg("rect", { x: "3.5", y: "3.5", width: "17", height: "17", rx: "5.5" }),
                            svg("line", { x1: "8", y1: "12", x2: "16", y2: "12" }),
                            svg("line", { class: "cv", x1: "12", y1: "8", x2: "12", y2: "16" })
                        )
                    )
                ),
                parts.title, parts.headfix
            ),
            h("span", { class: "gn-hr" },
                // hover-only cluster: the enable toggle, satellite toggles, AND rect-edit all sink
                // into ONE reveal container (`.gn-hctl`) — hidden at rest (only the type tag shows),
                // revealed on header hover like every other control. Enable sits leftmost.
                h("span", { class: "gn-hctl" },
                    toggle,
                    parts.head,
                    RECT_TYPES.has(n.type) ? rectEditBtn() : null
                ),
                h("span", { class: "gn-type", "aria-hidden": "true" }, typeLabel),
                h("span", { class: "gn-pretty-dirty", title: "held by a pretty override — not saved to yaml" }, "pretty"),
                // tiny loader — lives IN the header, shown by .gnode.busy. Body locks while it spins.
                h("span", { class: "gn-hspin", title: "working…" })
            )
        ),
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
    tog?.addEventListener("click", (e) => {
        e.stopPropagation();
        const on = e.currentTarget.getAttribute("aria-pressed") !== "true";   // flip the button state
        e.currentTarget.setAttribute("aria-pressed", on);
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
// `fit` grows a pinned node whose rebuilt body overflows its height — right for a live edit that
// reveals an input, but WRONG during an undo/redo restore: there reapplyNodeSizes() is the size
// authority (it re-stamps every node from the restored snapshot), and letting fitNodeHeight grow a
// node here instead mutates nodeSizes to a value the snapshot never had — drift that survives the
// restore and later fires a phantom history entry. rebuildAllNodeBodies passes fit:false for that.
function rebuildNode(id, { fit = true } = {}) {
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
    if (fit) fitNodeHeight(el, n.id);   // a revealed input (e.g. dict -> fuzzy) may overflow the pinned height — grow to fit
}

// Rebuild ONE node's body in place AND redraw its edges against FRESHLY-measured geometry — the
// single funnel every in-body source-add/remove handler uses (rule 7). rebuildNode swaps the body
// (a chip added/removed changes the node's size) but never re-reads the node's rect; drawEdges then
// anchors via nodeRect -> nw/nh (state.js), which fall back to a 220x80 default box when the size
// isn't re-read yet — so a just-grown node's edge starts at the default-box edge, INSIDE the real
// node ("center"), until a nudge re-measures it. Force the re-measure here: markNodeSized re-stamps
// the size classes and `void offsetWidth` flushes layout so the following drawEdges reads the true
// border-box. Plain (content-height) nodes settle synchronously; pass `raf:true` for a node whose
// body sizes a frame later (a register's async membank ResizeObserver).
export function rebuildNodeEdges(id, { raf = false } = {}) {
    rebuildNode(id);
    const el = nodeEls.get(id);
    if (el) { markNodeSized(el, id); void el.offsetWidth; }   // sync layout flush -> true size on next read
    if (raf) requestAnimationFrame(drawEdges); else drawEdges();
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
    // This reconcile reuses existing node DOM (to keep focus/values), so it NEVER rebuilds a body.
    // But a body's chips/labels/<select>s list OTHER nodes' ids and columns — renaming a dataset/
    // register/readout, adding a field, wiring a source all change what a SIBLING body should show
    // without changing that sibling's own id. One comprehensive signature (_refKey) folds the whole
    // referenceable namespace AND the column/ref content that changes without an id-set change; when
    // it flips, rebuild every consumer body through ONE sweep (rule 7 — replaces the old per-mutation
    // dataset/toast/dataset-node/readout sweeps that each covered only a slice and missed actions).
    const rk = _refKey();
    if (rk !== _lastRefKey) { _lastRefKey = rk; rebuildRefConsumers(); }
}
let _lastRefKey = null;
// The signature the render-tail rebuild gates on. Built ONLY from ids, ref lists, and the field/
// column sets a body can display — NEVER from knob VALUES — so typing into a threshold/interval/
// message never flips it (the gate stays shut mid-edit). Flips only on rename/add/remove/wire.
function _refKey() {
    const P = model.profile;
    return JSON.stringify([
        model.datasets(),
        (P.subsets || []).map((s) => [s.id, model.subsetInputs(s), model.subsetColumns(s.id)]),
        (P.registers || []).map((r) => [r.id, r.sources, r.persist]),
        // a process's sources carry each input's ref + `out` rename — a consuming register scaffolds
        // one cell per process output key, so an out-key edit / input add-remove must flip the gate.
        (P.processes || []).map((p) => [p.id, p.sources]),
        model.readouts().map((v) => v.id),
        (P.producers || []).map((p) => [p.id, p.dataset, p.sources, model.producerColumns(p)]),
        (P.actions || []).map((x) => [x.id, x.sources, x.dest, Object.keys(x.slots || {})]),
        (P.toasts || []).map((x) => [x.id, x.sources]),
        (P.sounds || []).map((x) => x.id),
        (P.file_sources || []).map((s) => [s.id, s.dataset, (s.fields || []).map((f) => f.id)]),
        (P.triggers || []).map((t) => [t.id, t.targets, t.watch, t.readout_watch, t.register_watch, t.gates]),
        (P.dictionaries || []).map((d) => [d.id, (d.feeds || []).map((f) => f.dataset)]),
        (P.windows || []).map((w) => [w.id, w.dataset, (w.fields || []).map((f) => f.id),
            (w.readouts || []).map((v) => v.id)]),
        P.window_priority || [],
    ]);
}
// Rebuild every config node body that lists another node's id/column — the ONE consumer sweep.
// Skips live-canvas node types (they self-refresh) AND the node holding the caret, so render()'s
// "existing nodes keep focus/values" contract holds even if a keystroke handler flips the gate.
function rebuildRefConsumers() {
    const focused = document.activeElement;
    for (const n of model.nodes()) {
        if (_SKIP_RESTORE_REBUILD.has(n.type)) continue;
        const el = nodeEls.get(n.id);
        if (el && focused && el.contains(focused)) continue;   // never yank the input being edited
        rebuildNode(n.id);
    }
}

// history.restore() (undo/redo) swaps the ENTIRE model, then calls render() — but render() is a
// reconcile that deliberately KEEPS existing node DOM (so a live keystroke's caret survives a
// re-render). After a wholesale swap there is no caret to protect and every config input may have
// changed, so the reused DOM is stale. render()'s tail only force-rebuilds datasets+toasts and
// gates producers/subsets/triggers behind the dataset-id-set key — blind to a node's OWN config —
// so undoing a producer/trigger/register/... config edit left the body showing pre-undo values.
// Rebuild EVERY node body once, generically (rule 7): one loop covers all config node types for
// good, instead of adding a per-type rebuild line here each time another node hits this.
// Node types rebuildAllNodeBodies must NOT rebuild on a restore: vttable satellites are live data
// grids that self-refresh via their own microtask/heartbeat (rebuilding one tears down its VTable
// and re-measures its column widths, drifting layout.tables off the snapshot -> a phantom history
// entry); preview/atlas wrap a live image canvas fillNode would destroy. Everything else is a config
// body that must repaint from the restored model. (window/item/game are config too but rebuild only
// their controls section via _LIVE_SECTIONS, so they keep their canvas — safe to include.)
const _SKIP_RESTORE_REBUILD = new Set(["vttable", "preview", "atlas"]);
export function rebuildAllNodeBodies() {
    // fit:false — reapplyNodeSizes() re-stamps sizes from the restored snapshot right after; letting
    // fitNodeHeight grow a node here would drift nodeSizes off the snapshot and fire a phantom entry.
    for (const n of model.nodes()) {
        if (_SKIP_RESTORE_REBUILD.has(n.type)) continue;
        rebuildNode(n.id, { fit: false });
    }
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

// setMultiSelect/syncMultiSelect/collapseSeparators + the selection-toolbar tier predictors now
// live in selection.js.



// Is the cursor over an element whose content actually overflows and can scroll? Walk up to
// the canvas; the wheel belongs to that element (native scroll), not to the canvas zoom.



// Double-click a node: fit it tight to the viewport and centre it (smooth, shared with
// the node-map jump so both frame a node the same way).


// ---- per-node interaction -------------------------------------------------

// The node-title id input (`input.gi-id`) requires a genuine DOUBLE-CLICK to edit: a
// single click (or two slow clicks) only selects the node — native focus is blocked —
// so an id is never edited by accident while panning/selecting. A dblclick focuses it
// (see the node's dblclick handler). One global capture listener blurs the editing
// input on any mousedown elsewhere (the canvas pan handler preventDefaults its own
// mousedown, which would otherwise trap focus in the field).
document.addEventListener("mousedown", (ev) => {
    const ed = document.activeElement;
    if (ed && ed.matches?.("input.gi-id") && ev.target !== ed) ed.blur();
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
        // of the multi-selection and NEVER drags — owned centrally by ctrl_select.js (capture
        // phase, ahead of every stopPropagation()ing child), so it never even reaches here.
        if (ev.ctrlKey || ev.metaKey) return;
        // DRAG-ONLY regime (three furthest-out zoom rungs): the node is too small to aim inside,
        // so ANY press drags it — bypass the content/input/canvas/resize-corner gates entirely.
        // preventDefault so a press over an input never steals native focus/caret out here.
        if (dragOnlyZoom()) {
            ev.preventDefault();
            suppressNextClick(div);   // a press-release (no drag) must not fire an internal control
            if (!selected.has(n.id)) clearMultiSelect();
            focusNode(n.id);
            startMove(n.id, ev);
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
        // id input needs a genuine double-click to edit: block native focus on a single
        // mousedown (only select + arm the drag handle). The dblclick handler focuses it.
        // Don't block once it's already focused, so clicks inside place the caret while editing.
        if (handle && handle.matches?.("input.gi-id") && document.activeElement !== handle) {
            ev.preventDefault();   // suppress focus/caret; select-only
        }
        if (handle) dragFromHandle(n.id, ev, div, handle);   // drag past threshold, else click
        else startMove(n.id, ev);
    });

    // double-click anywhere non-interactive on the node: fit + centre it
    div.addEventListener("dblclick", (ev) => {
        // double-click is the edit gesture for the id input: focus + preselect so typing
        // replaces it (single mousedown blocks native focus). NOT pan/zoom-to-node — that
        // stays available by double-clicking the node body/header padding.
        const idInput = ev.target.closest("input.gi-id");
        if (idInput) { idInput.focus(); idInput.select(); return; }
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
            const newId = newName.replace(/[^A-Za-z0-9._-]+/g, "_");
            if (newId === oldId) {
                n.ref.name = newName;   // name-only tweak, id unchanged
            } else if (model.renameDictionary(oldId, newId)) {
                n.ref.name = newName;   // commit the display name only once the id rename took
                movePos(`dict:${oldId}`, `dict:${newId}`);
            } else {
                // collision: leave name/id as they were (don't let them diverge) + tell the user
                e.target.value = n.ref.name;
                setStatus(`Dictionary "${newId}" already exists — rename skipped`, "warn");
            }
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
    } else if (n.type === "dataset") {
        // sources chips: add via the "+ source" select, remove via each chip's trash. Both paths
        // call the SAME model setters the drag-a-window/producer/file-source-onto-this-dataset
        // wiring already uses, so the two ways of wiring stay in sync (rebuild re-queues edges).
        div.querySelector(".ds-addsrc")?.addEventListener("change", (e) => {
            if (model.addDatasetSource(n.ref, e.target.value)) { rebuildNodeEdges(n.id); autosave(null); }
        });
        wireArmedRemove(div, ".ds-rmsrc", (val) => {
            model.removeDatasetSource(n.ref, val);
            rebuildNodeEdges(n.id); autosave(null);
        });
        div.querySelector(".dsrename")?.addEventListener("change", async (e) => {
            const oldId = n.ref, newId = (e.target.value || "").trim();
            if (!model.renameDataset(oldId, newId)) {
                e.target.value = oldId;
                if (newId && newId !== oldId) setStatus(`Dataset "${newId}" already exists — rename skipped`, "warn");
                return;
            }
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
            rebuildNode(n.id);   // toggles the detection-only "re-open gap" row
            autosave(null);
        });
        div.querySelector(".dsreopen")?.addEventListener("change", (e) => {
            model.setDatasetReopenGrace(n.ref, e.target.value);
            autosave(null);
        });
        div.querySelector(".dssync")?.addEventListener("change", (e) => {
            model.setDatasetSyncMode(n.ref, e.target.value);
            autosave(null);
        });
        div.querySelector(".dskeep")?.addEventListener("change", (e) => {
            // SAVE ONLY — never fold here. Typing "1" on the way to "10" would otherwise compact
            // through the autosave debounce and destroy batches the user never meant to touch.
            // Folding happens on the armed button below, a fired action, or the next run's batch.
            model.setDatasetKeepBatches(n.ref, e.target.value);
            autosave(null);
            syncCompactBtn(n.ref);   // the limit moved -> the button may now apply, or stop applying
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
            // queueMicrotask (not afterBoot): must run after this node is mounted, which is true on
            // initial boot AND undo/redo restore (afterBoot alone fires synchronously, pre-mount, once
            // boot.phase is false -> the mount-guarded fill no-ops after a restore). Same fix as the
            // register node (io_wire.js wireRegister); mirrors the dataset/subset vttable microtasks below.
            queueMicrotask(() => refreshSourcePreview(r.id));   // parse the source's rules into BOTH satellites
        } else if (r.kind === "subset") {
            const pre = _bootDetails?.subsets?.[r.id] || null;
            queueMicrotask(() => refreshSubsetNode(r.id, pre));
        } else if (r.kind === "triggerhistory") {
            // filled by the trigger's wire (renderTriggerHistory) + the heartbeat (triggers ride
            // EVERY beat, so an idle/empty one still renders an empty grid — no fetch here).
        } else if (r.kind === "readouthistory") {
            // readout_history rides the beat top-level (fed by live collection AND the test feed).
            // Paint on mount so a just-opened satellite shows its last snapshot (or an empty grid)
            // immediately instead of a stale "loading…", live or not.
            queueMicrotask(() => renderReadoutHistory(r.win, r.id));
        } else if (r.kind === "producerhistory") {
            // producer_history rides the activity beat; paint on mount so a just-opened satellite
            // shows its last snapshot (or an empty grid) immediately, not a stale "loading…".
            queueMicrotask(() => renderProducerHistory(r.id));
        } else if (r.kind === "registerhistory") {
            // register_history rides the activity beat top-level (live collection AND the test feed);
            // paint on mount so a just-opened satellite shows its last snapshot (or empty) immediately.
            queueMicrotask(() => renderRegisterHistory(r.id));
        } else if (r.kind === "processhistory") {
            // process_history rides the activity beat top-level (live collection AND the test feed);
            // paint on mount so a just-opened satellite shows its last snapshot (or empty) immediately.
            queueMicrotask(() => renderProcessHistory(r.id));
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
    } else if (n.type === "gate") {
        wireGate(div, n);
    } else if (n.type === "router") {
        wireRouter(div, n);
    } else if (n.type === "toast") {
        wireToast(div, n);
    } else if (n.type === "sound") {
        wireSound(div, n);
    } else if (n.type === "action") {
        wireAction(div, n);
    } else if (n.type === "register") {
        wireRegister(div, n);
    } else if (n.type === "process") {
        wireProcess(div, n);
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
        const saveDet = () => { if (isGate) { autosave(null); refreshDetect("game"); } else autosave(owner); refreshMatchPreviews(owner); };
        div.querySelector(".gi-id").addEventListener("change", (e) => {
            const oldId = n.ref.id;
            nodeTxn.commitIfDirty();   // a rename render()s + changes node identity — land any pending knob edit first
            renameNode(e.target, oldId,
                () => model.renameDetect(owner, oldId, e.target.value.trim()),
                () => movePos(`det:${owner}:${oldId}`, `det:${owner}:${n.ref.id}`),
                () => { render(); rebuildNode(ownerNode); saveDet(); refreshImageBoxes(owner); });
        });
        // ＋ (in the color subhead) appends an empty color row; each row's trash removes it.
        // Both re-run detect for this owner (via the same nodeEdit/saveDet transaction).
        div.querySelector(".coloradd")?.addEventListener("click", () => {
            nodeEdit(n.id, "read", () => { (n.ref.colors ||= []).push(""); rebuildNode(n.id); }, saveDet);
        });
        // ⊙ sample a colour from a zoomed cutout of the detector's box (same modal as a readout)
        div.querySelector(".detcolorpick")?.addEventListener("click", () => openDetectColorPick(owner, n.ref.id));
        div.querySelectorAll(".coldel").forEach((b) => armConfirm(b, () => {
            const i = +b.dataset.i;
            nodeEdit(n.id, "read", () => { n.ref.colors?.splice(i, 1); rebuildNode(n.id); }, saveDet);
        }, { silent: true, resetOnOutside: true }));
        // colour list: hex inputs that collide (same colour, or within tolerance of another) go red.
        const remarkCollide = () => markColorCollisions(div.querySelectorAll('.aset[data-k="color"]'), n.ref.colors || [], n.ref.tolerance ?? 32);
        div.querySelectorAll(".aset").forEach((inp) => onValueEdit(inp, (e, live) => {
            const k = e.target.dataset.k, ci = +e.target.dataset.i || 0;
            nodeEdit(n.id, "read", () => {
                if (k === "kind") { setDetectKind(n.ref, e.target.value); if (!live) rebuildNode(n.id); refreshImageBoxes(owner); return; }
                if (k === "text") n.ref.text = e.target.value;
                else if (k === "color") { (n.ref.colors ||= [])[ci] = e.target.value.trim(); if (!live) rebuildNode(n.id); }
                else if (k === "colorpick") { (n.ref.colors ||= [])[ci] = e.target.value; if (!live) rebuildNode(n.id); }
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
            if (k === "color" || k === "colorpick" || k === "tol") remarkCollide();   // colours / tolerance changed
            // the mutate ran synchronously (nodeEdit defers only the SAVE), so repaint the cutout
            // preview NOW — tolerance/width don't rebuild the node, so nothing else would.
            if (k === "tol" || k === "width" || k === "color" || k === "colorpick") refreshMatchPreviews(owner);
        }));
        // cutout preview: this detector's box, matched pixels painted for a colour/border kind.
        mountMatchPreview(n.id, owner, div.querySelector(".mp-canvas"), () => n.ref.search, () => {
            const cols = n.ref.colors;
            return (cols && cols.length && n.ref.text == null)
                ? { colors: cols, tolerance: n.ref.tolerance, border: n.ref.width != null, width: n.ref.width } : {};
        });
        remarkCollide();   // initial paint of any existing collisions
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
// — the same primitives the floating panels use; the drag loop itself lives in node_layout.js.
export function positionNode(id) { const el = nodeEls.get(id); const p = pos.get(id); if (el && p) { el.style.left = `${p.x}px`; el.style.top = `${p.y}px`; markNodeSized(el, id); } }

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

// The compact button exists ONLY while folding would actually destroy something. Under the limit
// (or with no limit) the row is just the number input — no disabled button, no "nothing to fold"
// note: a limit above the current batch count is a harmless setting and must read as one.
//
// Called from the live poll, so it MUST be a no-op in steady state (rule 1): the desired label is
// compared against what's already rendered and the DOM is touched only on a real change. The
// rendered label is stamped on the HOST (not held in a side Map, which a node rebuild would leave
// stale, and not read back off the button, whose text changes while armed).
function syncCompactBtn(ds) {
    const host = document.getElementById(`node-ds:${ds}`)?.querySelector(".ds-keep-act");
    if (!host) return;
    const keep = model.datasetKeepBatches(ds);
    const have = live[ds]?.batches;   // only served for a dataset that HAS a limit (summary())
    // over the limit == there is at least one batch beyond the newest `keep`. Unknown count (no
    // limit set, or the poll hasn't answered yet) means we can't claim damage -> stay silent.
    const over = keep > 0 && model.datasetCanCompact(ds) && typeof have === "number" && have > keep;
    const want = over ? `fold ${have} → ${keep}` : "";
    if ((host.dataset.lbl || "") === want) return;      // steady state: zero DOM mutations
    host.dataset.lbl = want;
    if (!want) { host.replaceChildren(); return; }
    host.replaceChildren(armedButton({
        label: want, arm: `destroy ${have - keep} batches?`, cls: "ds-compact db-danger", busy: "…",
        title: "fold every batch past the limit into one base value per row. The rows and their sums/means survive; the per-read detail of those batches does not, and any revert inside them becomes permanent.",
        onFire: async () => {
            try {
                const r = await withBusy([`ds:${ds}`], () => api.compactDataset(model.profile.name, ds));
                const subs = (model.profile.subsets || []).filter((s) => model.subsetReaches(s.id, ds)).map((s) => s.id);
                queueNodeRefresh({ datasets: [ds], subsets: subs });
                refreshAllBatchesNodes();
                scheduleRefreshLive();
                setStatus(r.folded ? `compacted ${ds} — ${r.folded} batches folded` : `${ds} already within its limit`);
            } catch (e) { setStatus(String(e.message || e)); }
        },
    }));
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
        syncCompactBtn(ds);   // reconciles in place; no-op unless the over-limit state changed
    }
}

initPanels();

// Armed two-click confirm (no blocking dialogs — rule 2), the ONE shared arm helper (rule 7).
// `silent`: don't swap the label to "confirm" — the armed state is signalled by CSS alone (an
// icon-only delete just turns yellow; a "confirm" word would force the empty label wide).
// `resetOnOutside`: disarm on ANY click that isn't this button, or on Escape (instead of the
// default 2.5s auto-disarm) — for a delete sitting in a live list where a stray timeout is worse
// than an explicit dismiss.
function armConfirm(btn, run, { silent = false, resetOnOutside = false, onArm, onDisarm } = {}) {
    if (!btn) return;
    // Buttons with an icon keep it in a `.sel-ic` span; only the `.sel-lbl` text arms/disarms so
    // the icon survives (a whole-button textContent swap would wipe the SVG). Plain buttons fall
    // back to button textContent.
    const lbl = btn.querySelector(".sel-lbl");
    const get = () => (lbl ? lbl.textContent : btn.textContent);
    const set = (t) => { if (silent) return; if (lbl) setSelLbl(lbl, t); else btn.textContent = t; };
    let timer = null, offGlobal = null;
    // onArm/onDisarm let a caller mirror the armed state onto something other than the button
    // (e.g. ring the node(s) a delete would remove). disarm() runs on timeout, outside-dismiss,
    // AND before the fire path's run(), so onDisarm covers every un-arm.
    const disarm = () => {
        if (btn.dataset.armed !== "1") return;
        btn.dataset.armed = "0"; set(btn.dataset.label ?? get());
        clearTimeout(timer); offGlobal?.(); offGlobal = null;
        onDisarm?.();
    };
    const arm = () => {
        btn.dataset.armed = "1"; btn.dataset.label = get(); set("confirm");
        onArm?.();
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

wireSettingsButton();
wireCtrlSelect();
wireCanvasInput();
wireSelectionToolbar();

// ---- init -----------------------------------------------------------------

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

bootGraph();

// ---- exports consumed by panel modules (imported back from "./main.js") ----
export {
    focusNode, autosave, placeNewNode, render,
    collectLayout, hydrateNodeLayout, reconcileOpenImages, reapplyNodeSizes,   // used by history.js restore
    refreshLive, subsetParts,
    refreshAllSubsetNodes, refreshDatasetConsumers,
    rebuildNode, setNodeBusy, withBusy, registerOverlay, unregisterOverlay,
    overlaySelected, syncCellSize, itemChanged,
    addFieldToItemGroup, addTellToItemGroup, inheritGroupFrom,
    refreshItemTemplateRefs, wireArmedRemove, NUDGE,
    onValueEdit, rulesEdit, wireFieldRules,
    refreshGames, loadGame, finishBoot, initKillGpu,   // used by graph_boot.js's boot sequence
    armConfirm,   // used by pretty_switch.js's dirty-bar buttons
    buildNode,   // used by node_layout.js (positionNode is already `export function` above)
    placeAt, showSatellite,    // used by port_wire.js / imaging.js
    deselectAll, setMultiSelect, selectionIds,   // used by canvas_input.js
    deleteSelection,   // used by shortcuts.js
    canDisable, isRemovable, removeNode,   // used by routing.js / selection.js
    createGame, _bootDetails,   // used by settings_modal.js / subset_wire.js
};
