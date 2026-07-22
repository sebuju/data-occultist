// Input-log node: an on_input trigger's raw considered events (satellite; NON-persisted,
// this-session only). Twin of history_node.js's fire-history satellite, but logs EVERY hook event
// the trigger matched by device+button — including ones that didn't fire — with its disposition
// (fired/throttled/gated/rect_miss/window_miss/chord_miss/awaiting_double), so it doubles as the
// "why isn't this firing" debugger for a button/mods typo or a wrong window bind. Same standard
// vttable satellite (kind "inputlog") as every other history flavour (rule 7). Data rides the
// shared activity heartbeat TOP-LEVEL (`input_history["<id>"]`, build_activity — the ring builds on
// the same HistoryRing every other history satellite uses, rule 7) — no per-trigger fetch, so a
// closed satellite costs nothing. That `<kind>_history` shape is also what gets these events
// auto-discovered into the merged node-log panel (panels/nodelog.js). VTable reconciles in place
// (rule 1). NB the satellite id stays `inlog:` / kind `inputlog` while the ring is `input_history`:
// satellite ids are persisted in the profile layout, so renaming them would strand stale ids.
import * as hub from "../hub.js";
import { nodeEls } from "./state.js";
import { fmtDateTimeMs } from "../datefmt.js";
import { satVT } from "./sat_vtable.js";

const COLS = ["when", "event", "button", "mods", "pos", "result"];
// dispositions that mean "this event did NOT fire" — tinted like a throttled fire-history row.
const _MISS = new Set(["throttled", "gated", "rect_miss", "window_miss", "chord_miss", "awaiting_double"]);

// Render a trigger's input log into its (open) satellite. No-op when hidden (no host in the DOM).
// `log` defaults to the last heartbeat snapshot's copy, so a bare call (satellite just opened)
// paints immediately without waiting for the next beat.
export function renderInputLog(triggerId, log, _retried = false) {
    const host = nodeEls.get(`inlog:${triggerId}`)?.querySelector(".hist-host");
    if (!host) {
        // toggling the satellite on calls this mid-render, from the trigger's own wireTrigger —
        // its satellite element is built LATER in that same render() pass, so nodeEls doesn't have
        // it yet. Retry once the current render() has returned (nodeEls is then fully populated),
        // so it paints an empty table instead of being stuck on the "loading…" placeholder until
        // the next heartbeat happens to carry a (non-empty) entry for this trigger.
        if (log === undefined && !_retried) queueMicrotask(() => renderInputLog(triggerId, undefined, true));
        return;
    }
    if (log === undefined)
        log = hub.latest()?.input_history?.[triggerId] || [];
    const rows = log.map((e) => ({
        when: fmtDateTimeMs(e.ts),
        event: e.event || "",
        button: e.button || "",
        mods: (e.mods || []).join("+"),
        pos: `${e.x ?? ""},${e.y ?? ""}`,
        result: e.result || "",
    }));
    satVT(`inlog:${triggerId}`, host).setData(COLS, rows, {
        rowClass: (row) => (_MISS.has(row.result) ? "hist-throttled" : ""),
    });
}
