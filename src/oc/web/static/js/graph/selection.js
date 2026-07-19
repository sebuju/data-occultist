// Multi-select + the selection toolbar: the tier predictor shared by group/subgroup/super-group
// buttons, clone/delete/size-copy-paste actions, and the group/subgroup/super-group shortcuts
// those buttons (and the Delete/Backspace hotkey in shortcuts.js) call. Split out of main.js;
// deselectAll/render/autosave/positionNode/removeNode/isRemovable/armConfirm stay in main and are
// imported back.
import { svg } from "../dom.js";
import * as groups from "./groups.js";
import {
    $, model, pos, view, selected, nodeEls, collapsed, nodeSizes, setStatus,
} from "./state.js";
import { drawEdges, requestEdges, flushEdges, setDraggingNodes } from "./routing.js";
import { resizeCanvas } from "./camera.js";
import { persist } from "./persist.js";
import { snap, snapUp } from "./dragresize.js";
import { registerKey, SCOPE } from "../inputbus.js";
import { renderNodeViews } from "./panels/nodemap.js";
import { WIDTH_ONLY_NODES, applySavedSize, markNodeSized } from "./node_resize.js";
import {
    render, autosave, positionNode, armConfirm, deselectAll, removeNode, isRemovable,
    nodeTypeOf, selectedNodeId,
} from "./main.js";

// The current selection the group action operates on: the multi-select set if any,
// else the single focused node.
export function selectionIds() {
    if (selected.size) return [...selected].filter((id) => nodeEls.has(id));
    if (selectedNodeId && nodeEls.has(selectedNodeId)) return [selectedNodeId];
    return [];
}

export function setMultiSelect(ids) {
    selected.clear();
    for (const id of ids) if (nodeEls.has(id)) selected.add(id);
    syncMultiSelect();
}
export function clearMultiSelect() { if (selected.size) { selected.clear(); syncMultiSelect(); } }

// ---- ctrl-click toggles (owned by ctrl_select.js's central resolver) ------------------------
// Toggle ONE node in/out of the multi-selection. Seeds the set with the currently single-focused
// node first, so a ctrl-click on a 2nd node ADDS to the selection instead of dropping the 1st.
export function ctrlToggleNode(id) {
    if (!selected.size && selectedNodeId && nodeEls.has(selectedNodeId)) selected.add(selectedNodeId);
    if (selected.has(id)) selected.delete(id); else selected.add(id);
    syncMultiSelect();
}
// Toggle a WHOLE group's member nodes in/out of the multi-selection as one unit (ctrl-click on a
// group title while in node-mode — see ctrl_select.js). All-in -> remove all; else -> add all.
export function ctrlToggleGroupMembers(gid) {
    const members = groups.groupMembers(gid).filter((id) => nodeEls.has(id));
    if (!members.length) return;
    if (!selected.size && selectedNodeId && nodeEls.has(selectedNodeId)) selected.add(selectedNodeId);
    const allIn = members.every((id) => selected.has(id));
    for (const id of members) { if (allIn) selected.delete(id); else selected.add(id); }
    syncMultiSelect();
}
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
export function syncMultiSelect() {
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
        // Force-disarm on any selection change. This bypasses armConfirm's own disarm(), so clear the
        // node ring here too — else the armed highlight lingers on the nodes we just deselected.
        if (del.dataset.armed === "1") { del.dataset.armed = "0"; const dl = del.querySelector(".sel-lbl"); if (dl) setSelLbl(dl, del.dataset.label ?? dl.textContent); setRmArmed(false); }   // label is legitimately "" now (icon-only) -> ?? not ||
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

// Ring the node(s) an armed delete would remove, so the confirm click's target is unambiguous (not
// just the toolbar button turning yellow). Targets are exactly what deleteSelection hits. Tracks the
// armed set so disarm clears precisely what was armed even if the selection changed meanwhile.
let rmArmedIds = [];
function rmArmTargets() { return selectionIds().filter((id) => isRemovable(nodeTypeOf(id))); }
function setRmArmed(on) {
    for (const id of rmArmedIds) nodeEls.get(id)?.classList.remove("rm-armed");
    rmArmedIds = on ? rmArmTargets() : [];
    for (const id of rmArmedIds) nodeEls.get(id)?.classList.add("rm-armed");
}

// Delete every removable node in the selection. Each goes through removeNode() so undo/redo
// records it, same path the old per-node trash button used. SHARED by the armed toolbar button
// and the Delete/Backspace hotkey so both behave identically (rule 7).
export function deleteSelection() {
    const byId = new Map(model.nodes().map((n) => [n.id, n]));
    const targets = selectionIds().map((id) => byId.get(id)).filter((n) => n && isRemovable(n.type));
    if (!targets.length) return;
    for (const n of targets) removeNode(n);   // each renders + autosaves; undo records each
    deselectAll();
}

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
    toast: (n) => model.cloneToast(n.ref.id),
    sound: (n) => model.cloneSound(n.ref.id),
    gate: (n) => model.cloneGate(n.ref.id),
    router: (n) => model.cloneRouter(n.ref.id),
    register: (n) => model.cloneRegister(n.ref.id),
    process: (n) => model.cloneProcess(n.ref.id),
};
const CLONEABLE = new Set(Object.keys(CLONE));
function cloneSelection() {
    const byId = new Map(model.nodes().map((n) => [n.id, n]));
    const targets = selectionIds().map((id) => byId.get(id)).filter((n) => n && CLONEABLE.has(n.type));
    if (!targets.length) return;
    // keep source->clone node-id pairs so the copy inherits the original card's box below
    const pairs = targets.map((n) => { const id = CLONE[n.type](n); return id ? { src: n.id, dst: nodeIdOfType(n.type, id) } : null; }).filter(Boolean);
    render();
    for (const { src, dst } of pairs) cloneNodeSize(src, dst);   // stamp the source's saved w/h onto the clone
    autosave(null);
    const newIds = pairs.map((p) => p.dst);
    selected.clear();
    for (const id of newIds) if (nodeEls.has(id)) selected.add(id);
    syncMultiSelect();
    setStatus(`cloned ${targets.length} node${targets.length === 1 ? "" : "s"} — click to place`);
    carryClones(newIds);   // grab the fresh copies onto the cursor; next click/key drops them
}
// Copy a source node's saved box onto its fresh clone, through the SAME nodeSizes funnel a grip
// resize / pasteSize uses. The stored size object already carries the right custW/custH flags
// (incl. width-only nodes), so it's copied verbatim. No entry = source never resized -> clone
// keeps the type default.
function cloneNodeSize(srcId, dstId) {
    const s = nodeSizes.get(srcId);
    if (!s) return;
    const copy = { ...s };
    nodeSizes.set(dstId, copy);
    const el = nodeEls.get(dstId);
    if (el) { applySavedSize(el, copy); markNodeSized(el, dstId); }
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

// ---- size copy / paste (selection toolbar) --------------------------------
// A session clipboard holding one node's rendered box. Copy grabs the single selected node's
// size; paste stamps it onto every resizable node in the (possibly multi-) selection at once,
// through the SAME nodeSizes funnel a grip resize / __nodeHistory.resizeNode uses. `sizeClip`
// ({w,h} in unscaled local px, or null until a size is copied) is declared up top with the other
// selection scalars so syncMultiSelect can read it without a TDZ hazard.
let sizeClip = null;              // size clipboard {w,h} for the toolbar copy/paste-size buttons
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
        // widthOnly nodes (item/window/atlas) wrap a fixed-aspect canvas — stamp width only.
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

// entity id -> node id (mirror of the `<type>:<id>` derivation in model.nodes()).
function nodeIdOfType(type, id) { return type === "dataset" ? `ds:${id}` : type === "filesource" ? `src:${id}` : type === "subset" ? `sub:${id}` : type === "window" ? `win:${id}` : type === "dictionary" ? `dict:${id}` : `${type}:${id}`; }

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

export function wireSelectionToolbar() {
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
    // Toolbar: armed two-click (rule 2) — a mis-click shouldn't nuke a node. Silent: the yellow
    // armed background is the confirm cue; no "confirm" label (keeps the button icon-only).
    armConfirm($("selDeleteBtn"), deleteSelection, { silent: true, onArm: () => setRmArmed(true), onDisarm: () => setRmArmed(false) });
    $("selCloneBtn").addEventListener("click", cloneSelection);
    $("selCopySizeBtn").addEventListener("click", copySize);
    $("selPasteSizeBtn").addEventListener("click", pasteSize);
    $("selClearBtn").addEventListener("click", () => deselectAll());
}
