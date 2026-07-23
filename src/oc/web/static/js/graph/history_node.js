// History node: a trigger's recent fires (satellite; NON-persisted, this-session only). It's a
// standard vttable satellite (kind "triggerhistory") — same resizable, scrolling, virtualized
// records grid as a dataset/subset data table (rule 7), so it resizes like every other node. Rows,
// newest first: WHEN each fire happened, WHY (the condition that justified it), WHAT it fired
// (target ids), and whether the fire was suppressed by the trigger's throttle. Data rides the
// shared activity heartbeat TOP-LEVEL (`trigger_history["<id>"]`, build_activity — trigger_history
// now builds on the same HistoryRing every other history satellite uses, rule 7) — no per-trigger
// fetch, so a closed satellite costs nothing and an open one updates the instant the beat pushes a
// change.
//
// The node body (a `.hist-host` scrollhost) is built in node_parts (the vttable dispatch);
// `renderTriggerHistory` feeds a VTable into that host from the passed (or last-seen) snapshot.
// VTable reconciles in place (rule 1). Called on satellite open (wireTrigger, no-op when hidden)
// and on each heartbeat (activity.js), so a live/throttled fire shows up as it's made.
import * as hub from "../hub.js";
import { nodeEls } from "./state.js";
import { fmtDateTimeMs } from "../datefmt.js";
import { satVTData } from "./sat_vtable.js";

const COLS = ["when", "node", "value", "why", "fires", "throttled"];

// Render a trigger's history into its (open) satellite. No-op when the satellite is hidden (no
// host in the DOM) — a closed history costs nothing. `history` defaults to the last heartbeat
// snapshot's copy for this trigger, so a bare call (satellite just opened) paints immediately
// without waiting for the next beat.
export function renderTriggerHistory(triggerId, history) {
    const host = nodeEls.get(`hist:${triggerId}`)?.querySelector(".hist-host");
    if (!host) return;
    if (history === undefined)
        history = hub.latest()?.trigger_history?.[triggerId] || [];
    const rows = history.map((e) => ({
        when: fmtDateTimeMs(e.ts),
        node: e.node || "-",
        value: e.value === null || e.value === undefined ? "" : String(e.value),
        why: e.why || "",
        fires: (e.targets || []).join(", ") || "-",
        throttled: e.throttled ? "yes" : "",
    }));
    satVTData(`hist:${triggerId}`, host, COLS, rows, {
        rowClass: (row) => (row.throttled ? "hist-throttled" : ""),
    });
}
