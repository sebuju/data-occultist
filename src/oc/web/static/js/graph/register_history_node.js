// Register push-history node: a register's recent writes into its held map (satellite; NON-persisted,
// this-session only). A standard vttable satellite (kind "registerhistory") — same resizable,
// scrolling, virtualized grid as the trigger-/readout-/producer-history tables (rule 7: shares the
// VTable + `satVT` lifecycle + `.hist-host`). One row per WRITE, newest first: WHEN it was pushed,
// the KEY (readout id), the VALUE written, the ring INDEX it occupies, and what it wrote OVER (the
// sample the append evicted from the ring — for a capacity-1 register, the previously-held value).
//
// Data rides the activity heartbeat TOP-LEVEL: each beat carries `register_history["<register id>"]`
// (build_activity, fed by live collection AND the teach-UI test feed). Painted on satellite mount
// (main.js) and each beat (activity.js) — a closed satellite (no host in the DOM) costs nothing.
import * as hub from "../hub.js";
import { nodeEls } from "./state.js";
import { fmtDateTimeMs } from "../datefmt.js";
import { satVT } from "./sat_vtable.js";

const COLS = ["when", "key", "value", "ring", "overwritten"];
const VOID = "∅";   // ∅ — a null/empty value or nothing overwritten

// Render a register's push history into its (open) satellite. No-op when hidden (no host in the DOM).
// `history` defaults to the last heartbeat snapshot for this register, so a bare call (satellite just
// opened) paints immediately without waiting for the next beat.
export function renderRegisterHistory(registerId, history) {
    const host = nodeEls.get(`reghist:${registerId}`)?.querySelector(".hist-host");
    if (!host) return;
    if (history === undefined)
        history = hub.latest()?.register_history?.[registerId] || [];
    const rows = history.map((e) => ({
        when: fmtDateTimeMs(e.ts),
        key: e.key,
        value: e.value == null || e.value === "" ? VOID : String(e.value),
        ring: e.ring_index == null ? "" : String(e.ring_index),
        overwritten: e.overwritten == null || e.overwritten === "" ? VOID : String(e.overwritten),
    }));
    satVT(`reghist:${registerId}`, host).setData(COLS, rows);
}
