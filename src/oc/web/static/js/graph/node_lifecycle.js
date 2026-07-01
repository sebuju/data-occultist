// Node identity + per-node-id live state: the ONE place that carries, drops, or guards a node's
// state across a rename or delete. Extracted from main.js — it depends only on the shared state
// maps (state.js) and groups; nothing here renders or saves. Rename handlers inject their own
// render/autosave/side-effects through `renameNode`'s `post` callback, so this module stays free
// of UI/DOM concerns.
//
// THE invariant: every per-node-id store is wired into BOTH remapNodeState (rename) and
// forgetNodeState (delete) here — add a new per-id store in these two functions and nowhere else,
// so a rename can never "do something else" (reset size/tab/columns) and a delete can never leak.
import { pos, nodeSizes, collapsed, busy, winPage, dsTab, model } from "./state.js";
import * as groups from "./groups.js";

// EVERY per-node-id live state store is keyed by node id, so any rename that changes a node id
// must remap ALL of them in lockstep — otherwise the node silently loses that slice of state on
// rename (jumps, resets its size/tab/columns, drops its spinner). `mapId(id)` returns the node's
// new id, or null to leave it; entity-keyed stores reconstruct the node id so the same mapId
// drives them too. The exported move* helpers are the only entry points (exact id, or prefix).
function remapNodeState(mapId) {
    // A satellite id embeds its parent's id (`prev:<win>` / `vt:<parentNodeId>`); a parent rename
    // only maps the bare parent id, so widen mapId to also carry the parent's satellites along.
    const mapSat = (id) => {
        if (id.startsWith("vtd:")) { const np = mapId(id.slice(4)); return np ? `vtd:${np}` : null; }
        if (id.startsWith("vt:")) { const np = mapId(id.slice(3)); return np ? `vt:${np}` : null; }
        if (id.startsWith("prev:")) { const np = mapId(`win:${id.slice(5)}`); return np && np.startsWith("win:") ? `prev:${np.slice(4)}` : null; }
        return null;
    };
    const mapAny = (id) => mapId(id) || mapSat(id);
    for (const store of [pos, nodeSizes, busy]) {  // Maps keyed by NODE id: {x,y} / {w,h} / spin count
        for (const id of [...store.keys()]) {
            const to = mapAny(id);
            if (to && to !== id) { store.set(to, store.get(id)); store.delete(id); }
        }
    }
    for (const id of [...collapsed]) {              // Set of collapsed node ids
        const to = mapAny(id);
        if (to && to !== id) { collapsed.delete(id); collapsed.add(to); }
    }
    for (const id of [...model.shownSatellites]) {  // Set of visible satellite node ids — carry over a parent rename
        const to = mapSat(id);
        if (to && to !== id) { model.shownSatellites.delete(id); model.shownSatellites.add(to); }
    }
    const tables = model.profile.layout?.tables;    // object keyed by NODE id: per-table column widths/sort
    if (tables) for (const id of Object.keys(tables)) {
        const to = mapId(id);
        if (to && to !== id) { tables[to] = tables[id]; delete tables[id]; }
    }
    for (const k of [...dsTab.keys()]) {            // keyed by DATASET entity id -> reconstruct the `ds:` node id
        const to = mapId(`ds:${k}`);
        if (to && to !== `ds:${k}`) { dsTab.set(to.slice(3), dsTab.get(k)); dsTab.delete(k); }
    }
    for (const k of [...winPage.keys()]) {          // keyed by WINDOW id -> reconstruct the `win:` node id
        const to = mapId(`win:${k}`);
        if (to && to !== `win:${k}`) { winPage.set(to.slice(4), winPage.get(k)); winPage.delete(k); }
    }
    groups.remapNodes(mapAny);  // carry group membership across the rename (don't detach) — mapAny so a
                                // parent's satellite member (vt:/prev:) rides along, else the records grid orphans
}

// Drop EVERY per-node-id live state slice for a removed node — the delete-twin of remapNodeState.
// (openImages/imageCanvases are torn down by closeImage, not here.)
export function forgetNodeState(id) {
    pos.delete(id); nodeSizes.delete(id); collapsed.delete(id); busy.delete(id);
    const p = id.split(":");
    if (p[0] === "ds") dsTab.delete(p[1]);
    if (p[0] === "win") winPage.delete(p[1]);
    const tables = model.profile.layout?.tables;
    if (tables) { delete tables[id]; if (p[0] === "ds") delete tables[`bat:${p[1]}`]; }
    // a node's satellite(s) die with it — forget visibility + slot too. A file source carries TWO
    // (vt: kept rows + vtd: dismissed rows); dataset/subset one; a window its preview.
    const sats = (p[0] === "ds" || p[0] === "sub") ? [`vt:${id}`]
        : p[0] === "src" ? [`vt:${id}`, `vtd:${id}`]
        : p[0] === "win" ? [`prev:${p[1]}`] : [];
    for (const sat of sats) { model.shownSatellites.delete(sat); pos.delete(sat); nodeSizes.delete(sat); collapsed.delete(sat); }
    groups.forgetNodes(new Set([id, ...sats]));
}

// THE rename flow for node-id renames. Guard via the model rename (restore the field + bail on a
// rejected/colliding id), carry ALL live state to the new id (`move`), then run the node's
// follow-up (`post`: render + its side effects). The guard+restore+move triplet is the part every
// handler used to re-copy and occasionally get wrong; it lives here ONCE. dataset (async server
// data move), window (image/binding move) and dictionary (name→id derivation) stay bespoke —
// genuinely different flows, not copies of this one.
export function renameNode(input, oldId, doRename, move, post) {
    if (!doRename()) { input.value = oldId; return; }   // collision/empty -> restore the field, no-op
    move();
    post();
}

// A node rename must also carry that node's timing history (per-node CSV). The backend
// rename is a file move keyed by node id; it no-ops for a node with no stats yet, so it's
// safe to call on any tracked-type rename. Only the node types the stats store tracks.
const _STATS_NODE_TYPES = new Set(["win", "ds", "sub", "producer"]);
function statsRenameNode(oldId, newId) {
    const game = model.profile.name;
    if (!game || oldId === newId || !_STATS_NODE_TYPES.has(String(oldId).split(":")[0])) return;
    fetch(`/api/stats/${encodeURIComponent(game)}/rename`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ old: oldId, new: newId }),
    }).catch(() => {});   // best-effort: stats history is diagnostic, never block a rename on it
}

// Carry one node's saved state to its new id after a rename, so it doesn't jump.
export function movePos(oldId, newId) {
    if (oldId === newId) return;
    remapNodeState((id) => (id === oldId ? newId : null));
    statsRenameNode(oldId, newId);
}

// Renaming a window changes the id embedded in ALL its child nodes, so carry every node
// whose window segment matches — one rename, the whole subtree stays put. Limited to the
// window-owned node types so it can't grab a same-named dataset node (those carry
// separately in the handler, since their stored data moves too).
const WINDOW_NODE_TYPES = new Set(["win", "prev", "reg", "det", "item", "sb"]);
export function moveWindowPos(oldWin, newWin) {
    if (oldWin === newWin) return;
    statsRenameNode(`win:${oldWin}`, `win:${newWin}`);   // carry the window node's timing history
    remapNodeState((id) => {
        const p = id.split(":");
        return WINDOW_NODE_TYPES.has(p[0]) && p[1] === oldWin
            ? [p[0], newWin, ...p.slice(2)].join(":") : null;
    });
}

// Renaming an item changes the id embedded in its OWN node AND every child field/tell node
// (`fld:win:item:*`, `tell:win:item:*`), so carry the whole item subtree — otherwise the
// children lose their saved slot and jump. Mirrors moveWindowPos (segment-prefix remap).
const ITEM_NODE_TYPES = new Set(["item", "fld", "tell"]);
export function moveItemPos(winId, oldItem, newItem) {
    if (oldItem === newItem) return;
    remapNodeState((id) => {
        const p = id.split(":");
        return ITEM_NODE_TYPES.has(p[0]) && p[1] === winId && p[2] === oldItem
            ? [p[0], winId, newItem, ...p.slice(3)].join(":") : null;
    });
}
