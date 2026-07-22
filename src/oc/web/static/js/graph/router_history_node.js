// Router-history node: a router's recent SELECTED-BRANCH changes (satellite; NON-persisted, this-
// session only). A standard vttable satellite (kind "routerhistory") — same resizable, scrolling,
// virtualized grid every history satellite shares (rule 7: VTable + `satVT` lifecycle + `.hist-host`).
//
// One row per CHANGE (newest first, not per tick — an unchanged selection never logs; see
// TriggerRunner.emit_router_flow). Columns: WHEN, SOURCE (the tested ref), VALUE (the source's live
// value at the change), ONE COLUMN PER BRANCH (matched/— , union across every row like the readout-
// history rule columns), SELECTED (the chosen branch index, or "none"), and TARGETS (that branch's
// forwarded ids). Data rides the activity heartbeat TOP-LEVEL (`router_history["<id>"]`,
// build_activity). Painted on satellite open and each beat (activity.js) — a closed satellite (no
// host in the DOM) costs nothing.
import * as hub from "../hub.js";
import { nodeEls } from "./state.js";
import { fmtDateTimeMs } from "../datefmt.js";
import { satVT } from "./sat_vtable.js";
import { unionIndexColumns } from "./readout_history_node.js";

const branchLabel = (b) => `branch ${b.i}`;

// Render a router's route-history into its (open) satellite. No-op when the satellite is hidden (no
// host in the DOM). `history` defaults to the last heartbeat snapshot for this router, so a bare
// call (satellite just opened) paints immediately without waiting for the next beat.
export function renderRouterHistory(id, history) {
    const host = nodeEls.get(`routhist:${id}`)?.querySelector(".hist-host");
    if (!host) return;
    if (history === undefined)
        history = hub.latest()?.router_history?.[id] || [];
    const cols = unionIndexColumns(history, "branches", (b) => b.i, branchLabel);
    const COLS = ["when", "source", "value", ...cols.map((c) => c.col), "selected", "targets"];
    const rows = history.map((e) => {
        const row = {
            when: fmtDateTimeMs(e.ts),
            source: e.source || "",
            value: e.source_value == null ? "" : String(e.source_value),
            selected: e.selected == null ? "none" : String(e.selected),
            targets: (e.targets || []).join(", ") || "-",
            _unmatched: e.selected == null,
        };
        const byI = new Map((e.branches || []).map((b) => [b.i, b]));
        for (const { i, col } of cols) {
            const b = byI.get(i);
            row[col] = b ? (b.matched ? "match" : "—") : "";
        }
        return row;
    });
    satVT(`routhist:${id}`, host).setData(COLS, rows, {
        rowClass: (row) => (row._unmatched ? "hist-throttled" : ""),
    });
}
