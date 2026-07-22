// Gate-history node: a gate's recent pass/block FLIPS (satellite; NON-persisted, this-session
// only). A standard vttable satellite (kind "gatehistory") — same resizable, scrolling, virtualized
// grid every history satellite shares (rule 7: VTable + `satVT` lifecycle + `.hist-host`).
//
// One row per FLIP (newest first, not per tick — a steady value never logs). Columns: WHEN, SOURCE
// (the tested ref), VALUE (the source's live value at the flip), ONE COLUMN PER CONDITION (hold/
// miss, union across every row like the readout-history rule columns), LOGIC (and/or), and RESULT
// (the post-negate pass/block). Data rides the activity heartbeat TOP-LEVEL (`gate_history["<id>"]`,
// build_activity, fed by TriggerRunner.emit_gate_flow). Painted on satellite open and each beat
// (activity.js) — a closed satellite (no host in the DOM) costs nothing.
import * as hub from "../hub.js";
import { nodeEls } from "./state.js";
import { fmtDateTimeMs } from "../datefmt.js";
import { satVT } from "./sat_vtable.js";
import { unionIndexColumns } from "./readout_history_node.js";

function condLabel(c) {
    const when = c.when || "";
    return c.arg ? `${when} ${c.arg}` : (when || "cond");
}

// Render a gate's flip-history into its (open) satellite. No-op when the satellite is hidden (no
// host in the DOM). `history` defaults to the last heartbeat snapshot for this gate, so a bare call
// (satellite just opened) paints immediately without waiting for the next beat.
export function renderGateHistory(id, history) {
    const host = nodeEls.get(`gatehist:${id}`)?.querySelector(".hist-host");
    if (!host) return;
    if (history === undefined)
        history = hub.latest()?.gate_history?.[id] || [];
    // conds have no stable index of their own (the backend sends a plain ordered list) — index by
    // position within each row instead, so tag each cond with its position first.
    const withPos = history.map((e) => ({ ...e, conds: (e.conds || []).map((c, i) => ({ ...c, i })) }));
    const cols = unionIndexColumns(withPos, "conds", (c) => c.i, condLabel);
    const COLS = ["when", "source", "value", ...cols.map((c) => c.col), "logic", "result"];
    const rows = withPos.map((e) => {
        const row = {
            when: fmtDateTimeMs(e.ts),
            source: e.source || "",
            value: e.source_value == null ? "" : String(e.source_value),
            logic: e.logic || "or",
            result: e.holds ? "pass" : "block",
            _blocked: !e.holds,
        };
        const byI = new Map((e.conds || []).map((c) => [c.i, c]));
        for (const { i, col } of cols) {
            const c = byI.get(i);
            row[col] = c ? (c.hold ? "hold" : "—") : "";
        }
        return row;
    });
    satVT(`gatehist:${id}`, host).setData(COLS, rows, {
        rowClass: (row) => (row._blocked ? "hist-throttled" : ""),
    });
}
