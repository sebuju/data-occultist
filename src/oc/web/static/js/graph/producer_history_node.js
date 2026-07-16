// Producer-history node: a producer's recent sweeps (satellite; NON-persisted, this-session only).
// A standard vttable satellite (kind "producerhistory") — same resizable, scrolling, virtualized
// grid as the trigger-/readout-history tables (rule 7: shares the VTable + `satVT` lifecycle +
// `.hist-host`). One row per COMPLETED sweep, newest first: WHEN it finished, the DATASET it wrote,
// how many items FETCHED / FAILED, the run TOTAL, and how many ROWS landed.
//
// Data rides the live activity heartbeat: each beat carries `producer_history["<producer id>"]`
// (activity.py build_activity snapshot). Painted on satellite mount (main.js) and each beat
// (activity.js) — a closed satellite (no host in the DOM) costs nothing.
import * as hub from "../hub.js";
import { nodeEls } from "./state.js";
import { fmtDateTimeMs } from "../datefmt.js";
import { satVT } from "./sat_vtable.js";

const COLS = ["when", "dataset", "fetched", "failed", "total", "rows"];

// Render a producer's history into its (open) satellite. No-op when hidden (no host in the DOM).
// `history` defaults to the last heartbeat snapshot for this producer, so a bare call (satellite
// just opened) paints immediately without waiting for the next beat.
export function renderProducerHistory(producerId, history) {
    const host = nodeEls.get(`prodhist:${producerId}`)?.querySelector(".hist-host");
    if (!host) return;
    if (history === undefined)
        history = hub.latest()?.producer_history?.[producerId] || [];
    const rows = history.map((e) => ({
        when: fmtDateTimeMs(e.ts),
        dataset: e.dataset || "-",
        fetched: e.fetched == null ? "" : String(e.fetched),
        failed: e.failed ? String(e.failed) : "",
        total: e.total == null ? "" : String(e.total),
        rows: e.rows == null ? "" : String(e.rows),
        _failed: !!e.failed,
    }));
    satVT(`prodhist:${producerId}`, host).setData(COLS, rows, {
        rowClass: (row) => (row._failed ? "hist-throttled" : ""),   // dim a run that had failures
    });
}
