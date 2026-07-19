// Readout-history node: a readout's recent reads (satellite; NON-persisted, this-session only).
// A standard vttable satellite (kind "readouthistory") — same resizable, scrolling, virtualized
// grid as the trigger-history table (rule 7: shares the VTable + `satVT` lifecycle + `.hist-host`).
//
// One row per evaluated read (newest first). Columns: WHEN, RAW (the OCR text), then ONE COLUMN
// PER RULE STEP showing that rule's outcome (its `out` value / `·` no-op / `drop` / `—` ignored),
// then the final VALUE — the same rule trace the readout NODE shows (paintRuleTrace), split into
// columns. Rule columns are derived from the reads' own traces, so they track the field's pipeline.
//
// Data rides the activity heartbeat TOP-LEVEL: each beat carries `readout_history["<win>:<ro>"]`
// (build_activity, fed by live collection AND the teach-UI test feed). Painted on satellite open
// (wireReadout) and each beat (activity.js) — a closed satellite (no host in the DOM) costs nothing.
import * as hub from "../hub.js";
import { nodeEls } from "./state.js";
import { fmtDateTimeMs } from "../datefmt.js";
import { satVT } from "./sat_vtable.js";

// Compact label for a rule step, e.g. "empty→drop", "above→drop", "always→extract".
function ruleLabel(s) {
    const when = s.when || "";
    const then = s.then || "";
    if (!then || then === when) return when || "rule";
    return `${when}→${then}`;
}

// One rule column's cell for a read's matching trace step. Exported so the process-history
// satellite paints its rule columns identically (rule 7 — one trace-cell renderer, not two).
export function cellFor(s) {
    if (s.ignored) return "—";                          // rule invalid for the field type (skipped)
    if (s.out === null || s.out === undefined)          // both stop the pipeline with a null value:
        return s.then === "blank" ? "blank" : "drop";   // blank FORWARDS the gap, drop rejects the read
    if (s.fired === false) return "·";                  // condition didn't match — value passes through
    return String(s.out);                               // the rule transformed the value
}

// Build the ordered rule columns from every read's trace (union by step index). Headers are made
// unique (a suffix on collision) so VTable's row-object keys don't clash. Exported so the process-
// history satellite derives its rule columns identically (rule 7).
export function ruleColumns(history) {
    const label = new Map();   // step index -> label (first seen wins)
    for (const e of history)
        for (const s of (e.trace || []))
            if (!label.has(s.i)) label.set(s.i, ruleLabel(s));
    const seen = new Map();
    return [...label.keys()].sort((a, b) => a - b).map((i) => {
        let col = label.get(i);
        if (seen.has(col)) { const n = seen.get(col) + 1; seen.set(col, n); col = `${col} ${n}`; }
        else seen.set(col, 0);
        return { i, col };
    });
}

// Render a readout's history into its (open) satellite. No-op when the satellite is hidden (no host
// in the DOM). `history` defaults to the last heartbeat snapshot for this readout, so a bare call
// (satellite just opened) paints immediately without waiting for the next beat.
export function renderReadoutHistory(win, vid, history) {
    const host = nodeEls.get(`rohist:${win}:${vid}`)?.querySelector(".hist-host");
    if (!host) return;
    if (history === undefined)
        history = hub.latest()?.readout_history?.[`${win}:${vid}`] || [];
    const ruleCols = ruleColumns(history);
    const COLS = ["when", "gap", "raw", ...ruleCols.map((r) => r.col), "value", "confidence"];
    const rows = history.map((e, i) => {
        // gap = milliseconds since the PREVIOUS (older) read of this readout — the read cadence,
        // so a stall or a fast burst is visible per row. History is newest-first, so the older
        // read is the next index; the oldest row has no prior read (blank).
        const older = history[i + 1];
        const gapMs = older ? (Date.parse(e.ts) - Date.parse(older.ts)) : null;
        const val = e.value == null ? "∅" : String(e.value);
        const row = {
            when: fmtDateTimeMs(e.ts),
            gap: gapMs == null ? "" : `${gapMs} ms`,
            raw: e.raw == null ? "" : String(e.raw),
            value: val,
            confidence: e.conf == null ? "" : `${Math.round(e.conf * 100)}%`,
            _dropped: !!e.dropped,
        };
        const byI = new Map((e.trace || []).map((s) => [s.i, s]));
        for (const { i: si, col } of ruleCols) {
            const s = byI.get(si);
            row[col] = s ? cellFor(s) : "";   // blank = the pipeline stopped before this rule
        }
        return row;
    });
    satVT(`rohist:${win}:${vid}`, host).setData(COLS, rows, {
        rowClass: (row) => (row._dropped ? "hist-throttled" : ""),
    });
}
