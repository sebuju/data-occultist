// Game-history node: the game node's recent live-collection ticks (satellite; NON-persisted, this-
// session only). A standard vttable satellite (kind "gamehistory") — same resizable, scrolling,
// virtualized grid every history satellite shares (rule 7: VTable + `satVT` lifecycle + `.hist-host`).
// Replaces the old bespoke "OCR log" section of the live panel (livewin.js) — same underlying data
// (LiveSession._debug), now painted as a satellite like every other node's history instead of a
// one-off poll-driven list.
//
// One row per recorded tick (a tick that read/wrote a record or saw a readout change — see
// live.py's debug-log gate; a cache-hit/throttled/idle tick never logs). Columns: WHEN, WINDOW
// (window/state), IMAGE (the saved capture filename, capture-recognised mode only), DELTA (ms since
// the previous LOGGED tick — the read cadence), WRITES (`+N → dataset` or `kept/read`), READS (a
// compact `fid: raw→value` summary of record reads), READOUTS (same, for changed live readouts).
//
// Data rides the activity heartbeat TOP-LEVEL (`game_history["game"]`, build_activity, only present
// while live collection is running — see LiveSession.debug_recent). Painted on satellite open and
// each beat (activity.js) — a closed satellite (no host in the DOM) costs nothing.
import * as hub from "../hub.js";
import { nodeEls } from "./state.js";
import { fmtTimeSec } from "../datefmt.js";
import { satVTData } from "./sat_vtable.js";

const COLS = ["when", "window", "image", "delta", "writes", "reads", "readouts"];

// One read's `{values, raw, corrected}` -> a compact "fid: raw→val, fid2: val2" summary string.
function readSummary(rd) {
    const cor = new Set(rd.corrected || []);
    return Object.entries(rd.values || {}).map(([fid, val]) => {
        const raw = rd.raw?.[fid];
        const shown = val === null || val === undefined ? "∅" : String(val);
        const corrected = cor.has(fid);
        const changed = corrected || (raw != null && String(raw) !== shown);
        return changed && raw != null ? `${fid}: ${raw}→${shown}${corrected ? "*" : ""}` : `${fid}: ${shown}`;
    }).join(", ");
}

// Render the game node's OCR-tick history into its (open) satellite. No-op when the satellite is
// hidden (no host in the DOM). `history` defaults to the last heartbeat snapshot, so a bare call
// (satellite just opened) paints immediately without waiting for the next beat. History is
// newest-first (see LiveSession.debug_recent) — delta is computed against the NEXT row (the
// previous, OLDER tick), mirroring readout-history's `gap` column.
export function renderGameHistory(history) {
    const host = nodeEls.get("gamehist")?.querySelector(".hist-host");
    if (!host) return;
    if (history === undefined)
        history = hub.latest()?.game_history?.game || [];
    const rows = history.map((e, i) => {
        const older = history[i + 1];
        const deltaMs = older ? Math.round((e.t - older.t) * 1000) : null;
        const wrote = e.new ? `+${e.new}${e.dataset ? " → " + e.dataset : ""}` : `${e.kept ?? 0}/${e.read ?? 0} read`;
        return {
            when: fmtTimeSec(e.t * 1000),
            window: e.state ? `${e.window}/${e.state}` : (e.window || "?"),
            image: e.saved || "",
            delta: deltaMs == null ? "" : `${deltaMs} ms`,
            writes: wrote,
            reads: (e.reads || []).map(readSummary).join(" · "),
            readouts: (e.readout_reads || []).map(readSummary).join(" · "),
        };
    });
    satVTData("gamehist", host, COLS, rows);
}
