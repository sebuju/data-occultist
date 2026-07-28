// Node removal: the denylist of unremovable node types, and the ONE place that deletes any node
// (per-type kill/after plan) — including purging a dropped dataset's on-disk files. Split out of
// main.js; render/autosave/rebuildNode/refreshLive/live stay in main and are imported back.
import * as api from "../api.js";
import { model, nodeEls, clearGrid, setStatus } from "./state.js";
import { closeImage, closeItemImage, refreshImageBoxes, nodeIdOf } from "./imaging.js";
import { forgetNodeState } from "./node_lifecycle.js";
import { itemChanged } from "./item_wire.js";
import { render, autosave, rebuildNode, refreshLive, live } from "./main.js";

// Denylist, NOT allowlist (twin of isRemovable below, same reason): every FUNCTIONAL node type is
// disableable EXCEPT these. Inverted on purpose so a new type gets the enable toggle by default —
// the recurring bug was forgetting to add each new type to an allowlist (toast/sound/register were
// the forgotten ones). Excluded: profile roots (game, atlas), satellites (preview, vttable — dismissed
// via their own sat-toggle), and refs with no `enabled` field (dataset's ref is a bare string so
// writing .enabled throws; subset/itemfield/itemtell carry no enabled).
const CANNOT_DISABLE = new Set(["game", "atlas", "preview", "vttable", "dataset", "subset", "itemfield", "itemtell"]);
export const canDisable = (type) => !!type && !CANNOT_DISABLE.has(type);
// Denylist, NOT allowlist: every node type is removable EXCEPT these. Inverted on purpose so a new
// functional node type is deletable by default — the recurring bug was forgetting to add each new
// type to an allowlist. Only the profile-root nodes (game, atlas) and toggle-only satellites
// (preview, vttable) are protected here; a satellite is dismissed via its toggle, never "deleted".
const UNREMOVABLE = new Set(["game", "atlas", "preview", "vttable"]);
export const isRemovable = (type) => !!type && !UNREMOVABLE.has(type);

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

// One place to remove any node; each goes through render()+autosave() so undo/redo
// records it (autosave -> pushHistory).
// Per-type removal as data, not a re-copied render/cleanup block: `kill` mutates the model (+ any
// pre-render teardown like closing a live canvas); `after` is the follow-up (autosave variant +
// side effects). The shared render + forgetNodeState (drops every per-id store) + status line run
// ONCE for every type. re-OCR only the affected window (autosave winId) — removing a region/detect/
// scrollbar/item changes THAT window's read, never the others; window-less types pass autosave(null).
export function removeNode(n) {
    const win = n.win?.id;
    const PLAN = {
        window:     { kill: () => { closeImage(n.ref.id); model.removeWindow(n.ref.id); }, after: () => autosave(null) },
        item:       { kill: () => { closeItemImage(win, n.ref.id); model.removeItem(win, n.ref.id); clearGrid(win); }, after: () => { refreshImageBoxes(win); autosave(win); } },
        region:     { kill: () => model.removeRegion(win, n.ref.id), after: () => { autosave(win); refreshImageBoxes(win); } },
        readout:   { kill: () => model.removeReadout(win, n.ref.id), after: () => { autosave(win); refreshImageBoxes(win); } },
        detect:     { kill: () => model.removeDetect(win, n.ref.id), after: () => { rebuildNode(nodeIdOf(win)); autosave(win); refreshImageBoxes(win); } },
        scrollbar:  { kill: () => model.removeScrollbar(win), after: () => { autosave(win); refreshImageBoxes(win); } },
        itemfield:  { kill: () => model.removeItemField(win, n.item.id, n.ref.id), after: () => itemChanged(win, n.item.id, { reread: true }) },
        itemtell:   { kill: () => model.removeItemTell(win, n.item.id, n.ref.id), after: () => itemChanged(win, n.item.id, { reread: true }) },
        dictionary: { kill: () => model.removeDictionary(n.ref.id), after: () => autosave(null) },
        subset:     { kill: () => model.removeSubset(n.ref.id), after: () => autosave(null) },
        producer:   { kill: () => model.removeProducer(n.ref.id), after: () => autosave(null) },
        trigger:    { kill: () => model.removeTrigger(n.ref.id), after: () => autosave(null) },
        gate:       { kill: () => model.removeGate(n.ref.id), after: () => autosave(null) },
        router:     { kill: () => model.removeRouter(n.ref.id), after: () => autosave(null) },
        toast:      { kill: () => model.removeToast(n.ref.id), after: () => autosave(null) },
        overlay:    { kill: () => model.removeOverlay(n.ref.id), after: () => autosave(null) },
        overlaywidget: { kill: () => model.removeOverlayWidget(n.ov.id, n.ref.id), after: () => autosave(null) },
        sound:      { kill: () => model.removeSound(n.ref.id), after: () => autosave(null) },
        action:     { kill: () => model.removeAction(n.ref.id), after: () => autosave(null) },
        register:   { kill: () => model.removeRegister(n.ref.id), after: () => autosave(null) },
        process:    { kill: () => model.removeProcess(n.ref.id), after: () => autosave(null) },
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
    // Skip render()'s whole-graph consumer sweep: the ONLY bodies a removal changes are the wired
    // neighbours (their reference chip is now stale), and we rebuild exactly those below. The "+"
    // picker candidate lists that also mentioned this node are recomputed live on open (lazy `free`
    // thunks in sources_input.js), so they need no rebuild either. This turns a delete from O(all
    // nodes) body rebuilds into O(neighbours) — the sweep here was pure redundancy with line below.
    render({ refConsumers: false });
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
