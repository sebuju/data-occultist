// History node: a trigger's recent fires (satellite; NON-persisted, this-session only). It's a
// standard vttable satellite (kind "triggerhistory") — same resizable, scrolling, virtualized
// records grid as a dataset/subset data table (rule 7), so it resizes like every other node. Rows,
// newest first: WHEN each fire happened, WHY (the condition that justified it), WHAT it fired
// (target ids), and whether the fire was suppressed by the trigger's throttle. Data comes from the
// server's in-memory ring (GET /api/triggers/<game>/<id>/history) — it evaporates on restart.
//
// The node body (a `.hist-host` scrollhost) is built in node_parts (the vttable dispatch);
// `refreshTriggerHistory` fetches the ring and feeds a VTable into that host. VTable reconciles in
// place (rule 1). Called on satellite open (wireTrigger, no-op when hidden) and on each heartbeat
// while it fires (activity.js), so a live/throttled fire shows up as it's made.
import * as api from "../api.js";
import { model, nodeEls } from "./state.js";
import { fmtDateTimeMs } from "../datefmt.js";
import { VTable } from "../vtable.js";

const COLS = ["when", "why", "fires", "throttled"];
const _vts = new Map();   // triggerId -> VTable (one per open history satellite)

// One VTable per history host; recreated if the host element was rebuilt by a node re-render.
function vtFor(id, host) {
    let vt = _vts.get(id);
    if (vt && vt.host === host) return vt;
    if (vt) vt.destroy();
    host.replaceChildren();
    vt = new VTable(host, `hist:${id}`);
    _vts.set(id, vt);
    return vt;
}

// Fetch + render a trigger's history into its (open) satellite. No-op when the satellite is hidden
// (no host in the DOM) — a closed history costs nothing.
export function refreshTriggerHistory(triggerId) {
    const host = nodeEls.get(`hist:${triggerId}`)?.querySelector(".hist-host");
    if (!host) return;
    api.triggers.history(model.profile.name, triggerId)
        .then((r) => {
            const rows = (r.history || []).map((e) => ({
                when: fmtDateTimeMs(e.ts),
                why: e.why || "",
                fires: (e.targets || []).join(", ") || "-",
                throttled: e.throttled ? "yes" : "",
            }));
            vtFor(triggerId, host).setData(COLS, rows, {
                rowClass: (row) => (row.throttled ? "hist-throttled" : ""),
            });
        })
        .catch(() => { /* transient fetch error -> leave the last-rendered rows */ });
}
