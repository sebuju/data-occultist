// Process-history node: a process's recent input/output (satellite; NON-persisted, this-session
// only). A standard vttable satellite (kind "processhistory") — the same resizable, scrolling,
// virtualized grid the readout/register-history tables use (rule 7: shares the VTable + `satVT`
// lifecycle + `.hist-host`).
//
// One row per key per evaluated tick (newest first). Columns: KEY (the input's key, preserved
// through the process), INPUT (the raw incoming value, the process's "raw"), then ONE COLUMN PER
// RULE STEP (that rule's outcome), then OUTPUT (the value after the pipeline). The rule columns +
// their cells are built by the SAME helpers the readout-history satellite uses (ruleColumns /
// cellFor), so the two trace views can never drift.
//
// Data rides the activity heartbeat TOP-LEVEL: each beat carries `process_history["<id>"]`
// (build_activity, fed by live collection AND the teach-UI test feed). Painted on satellite open
// and each beat — a closed satellite (no host in the DOM) costs nothing.
import * as hub from "../hub.js";
import { nodeEls } from "./state.js";
import { fmtDateTimeMs } from "../datefmt.js";
import { satVTData } from "./sat_vtable.js";
import { ruleColumns, cellFor } from "./readout_history_node.js";

// Render a process's history into its (open) satellite. No-op when the satellite is hidden (no host
// in the DOM). `history` defaults to the last heartbeat snapshot for this process, so a bare call
// (satellite just opened) paints immediately without waiting for the next beat.
export function renderProcessHistory(id, history) {
    const host = nodeEls.get(`prochist:${id}`)?.querySelector(".hist-host");
    if (!host) return;
    if (history === undefined)
        history = hub.latest()?.process_history?.[id] || [];
    const ruleCols = ruleColumns(history);
    const COLS = ["when", "key", "input", ...ruleCols.map((r) => r.col), "output"];
    const rows = history.map((e) => {
        const out = e.value == null ? "∅" : String(e.value);
        const row = {
            when: fmtDateTimeMs(e.ts),
            key: e.key == null ? "" : String(e.key),
            input: e.raw == null ? "" : String(e.raw),
            output: out,
            _dropped: e.value == null,
        };
        const byI = new Map((e.trace || []).map((s) => [s.i, s]));
        for (const { i, col } of ruleCols) {
            const s = byI.get(i);
            row[col] = s ? cellFor(s) : "";   // blank = the pipeline stopped before this rule
        }
        return row;
    });
    satVTData(`prochist:${id}`, host, COLS, rows, {
        rowClass: (row) => (row._dropped ? "hist-throttled" : ""),
    });
}
