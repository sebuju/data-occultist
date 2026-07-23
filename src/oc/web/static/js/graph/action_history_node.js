// Action-history node: an action's recent runs (satellite; NON-persisted, this-session only). A
// standard vttable satellite (kind "actionhistory") — same resizable, scrolling, virtualized grid
// every history satellite shares (rule 7: VTable + `satVT` lifecycle + `.hist-host`).
//
// One row per run (newest first): WHEN, BY (the firing trigger id, or "manual"/"chain" — the action
// has no live trigger to name for a manual/chained fire), RAN (whether a dataset/register op actually
// happened), SOUNDS (cued ids), CHAINED (downstream action ids fired). Data rides the activity
// heartbeat TOP-LEVEL (`action_history["<id>"]`, build_activity, fed by
// TriggerRunner._run_action — the single funnel every fire path shares). Painted on satellite open
// and each beat (activity.js) — a closed satellite (no host in the DOM) costs nothing.
import * as hub from "../hub.js";
import { nodeEls } from "./state.js";
import { fmtDateTimeMs } from "../datefmt.js";
import { satVTData } from "./sat_vtable.js";

const COLS = ["when", "by", "ran", "sounds", "chained"];

// Render an action's run-history into its (open) satellite. No-op when the satellite is hidden (no
// host in the DOM). `history` defaults to the last heartbeat snapshot for this action, so a bare
// call (satellite just opened) paints immediately without waiting for the next beat.
export function renderActionHistory(id, history) {
    const host = nodeEls.get(`acthist:${id}`)?.querySelector(".hist-host");
    if (!host) return;
    if (history === undefined)
        history = hub.latest()?.action_history?.[id] || [];
    const rows = history.map((e) => ({
        when: fmtDateTimeMs(e.ts),
        by: e.trigger || "manual",
        ran: e.ran ? "yes" : "no",
        sounds: (e.sounds || []).join(", ") || "-",
        chained: (e.chained || []).join(", ") || "-",
        _idle: !e.ran,
    }));
    satVTData(`acthist:${id}`, host, COLS, rows, {
        rowClass: (row) => (row._idle ? "hist-throttled" : ""),
    });
}
