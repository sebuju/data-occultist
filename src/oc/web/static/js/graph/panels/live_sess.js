// How a saved live session reads in the UI. Two places show them — the live panel's feed dropdown
// (which session to replay) and the image picker's live tab (browse a session, then its images) —
// so the naming/meta lives here once rather than drifting between the two (rule 7).
//
// A session is one live-capture start: `{id, label, count, bytes, first, last, span}` from
// /api/captures/<game>/live/sessions (see web/captures_store.list_live_sessions).
import { fmtDateTime, countdown } from "../../datefmt.js";
import { fmtBytes } from "../../bytefmt.js";

// Session name: its own label when one was written (e.g. a migrated "recovered" bucket),
// else when the recording started (dd/mm/yy HH:MM — rule 9).
export function sessLabel(s) {
    if (!s) return "";
    return s.label ? `${s.label} — ${fmtDateTime(s.first)}` : fmtDateTime(s.first);
}

// Session meta line: how many images and how long the recording runs, optionally with its size.
// `countdown` is the house duration formatter (45s / 5m 30s / 2h 10m).
export function sessMeta(s, { withBytes = false } = {}) {
    if (!s) return "";
    return [`${s.count} imgs`, withBytes ? fmtBytes(s.bytes || 0) : null, countdown(s.span || 0)]
        .filter(Boolean).join(" · ");
}
