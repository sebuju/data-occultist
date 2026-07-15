// Undo / redo of the profile — the node graph's history. Built on the shared createHistory engine
// (../history_core.js); this file supplies the node-view specifics: how to snapshot the WHOLE
// profile (config + layout), how to restore it (reload + re-hydrate node layout + re-render +
// reconcile open images + redraw boxes + persist), and the diff labeller for the panel.
//
// What IS in history: all config, plus node positions/sizes/collapse, groups, satellites, open
// image panels, table widths (everything in `profile.layout`). What is NOT: the per-device viewport
// (pan/zoom lives in a separate sidecar, never in the profile), dataset row data + captures (both
// server-side). So undo restores where every node sat, but never shuffles your pan/zoom.

import { model, setStatus, imageCanvases, itemCanvases, boot } from "./state.js";
import { persist } from "./persist.js";
import { render, collectLayout, hydrateNodeLayout, reconcileOpenImages, reapplyNodeSizes } from "./main.js";
import { refreshImageBoxes, refreshDetect, refreshItemBoxes } from "./imaging.js";
import { flushEdges, suspendRouting, resumeRouting } from "./routing.js";
import { reapplyPersistedVTables } from "../vtable.js";
import { createHistory } from "../history_core.js";
import * as rectTxn from "./edit_txn.js";
import * as nodeTxn from "./node_txn.js";
import { diffLabel } from "../history_label.js";

// fold live node layout into the profile first, so the snapshot captures the CURRENT positions
// (collectLayout runs at PUT time otherwise — too late for a synchronous snapshot).
const snapshot = () => { collectLayout(); return JSON.stringify(model.profile); };

async function restore(snap) {
    // model.load swaps out every config object — an armed edit transaction would be left holding
    // (and comparing against) orphans. Drop it before the swap, never after.
    nodeTxn.abandon();
    // Restoring is a multi-step layout swap (positions land, THEN sizes get re-stamped) — each step
    // draws the edges (so lines stay glued to nodes as they move) but must NOT each kick off its own
    // A* pass: a route computed between the position step and the size step is routed against
    // stale sizes and immediately superseded, wasting a full pass and briefly painting the wrong
    // shape. Suspend routing for the whole sequence and flush exactly once at the end, after sizes
    // are final.
    suspendRouting();
    try {
        model.load(JSON.parse(snap));          // profile incl. its layout
        hydrateNodeLayout();                   // push restored positions/sizes/collapse/groups/satellites live
        render();                              // place nodes at the restored spots (nodes now in the DOM)
        reapplyNodeSizes();                    // re-stamp restored node w/h (render only re-applies position)
        reapplyPersistedVTables();             // snap open tables' column widths/order/sort to the restored state
        await reconcileOpenImages();           // open/close window image canvases to match the snapshot
        // redraw every OPEN canvas from the restored model: window canvases (regions/detectors/data-area/
        // scrollbar + grid) and item-cutout canvases (per-item field/tell boxes, a separate map).
        for (const winId of imageCanvases.keys()) { refreshImageBoxes(winId); refreshDetect(winId); }
        for (const key of itemCanvases.keys()) { const i = key.indexOf(":"); refreshItemBoxes(key.slice(0, i), key.slice(i + 1)); }
    } finally {
        resumeRouting();
    }
    flushEdges();                           // the ONE routing pass, run once every step has landed
    persist.content(); persist.layout();   // persist the restored profile (guarded: no re-record mid-restore)
}

export const hist = createHistory({ snapshot, restore, label: diffLabel });

// thin wrappers keep the existing call sites (main.js) unchanged + add the status line
// Skip while booting: reopening images, re-OCR, group-rehydration and size re-stamps all fire
// layout/content saves during load — none are user edits. resetHistory() seeds the baseline once
// the graph is built; boot.phase only clears after bootSettle, so nothing boot-side records.
const pushHistory = () => { if (!boot.phase) hist.push(); };
const resetHistory = () => hist.reset("loaded");
// An uncommitted edit (a dragged box, a typed node config) IS the most recent change, but it never
// entered history (nothing is recorded until the batch commits). So Ctrl+Z drops it first — same
// effect as Escape — and only the next press walks the recorded stack.
function undo() {
    if (rectTxn.dirty()) { rectTxn.revert(); setStatus("discarded edit"); return; }
    if (hist.canUndo()) { const p = hist.undo(); setStatus("undo"); return p; }
}
function redo() { if (hist.canRedo()) { const p = hist.redo(); setStatus("redo"); return p; } }

export { pushHistory, resetHistory, undo, redo };
