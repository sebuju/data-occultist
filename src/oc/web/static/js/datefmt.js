// Date/time formatting — HOUSE RULE: 24-hour clock, dates as dd/mm/yy. Never 12-hour
// / AM-PM, never locale-default (toLocaleString varies by machine). Every date/time the
// UI shows goes through here.

const p2 = (n) => String(n).padStart(2, "0");
const p3 = (n) => String(n).padStart(3, "0");

// "dd/mm/yy HH:MM" (24-hour).
export function fmtDateTime(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso ?? "");
    return `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${p2(d.getFullYear() % 100)} `
        + `${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

// "dd/mm/yy HH:MM:SS" (24-hour) — when both the date and per-second resolution matter
// (e.g. a captured frame's exact stamp).
export function fmtDateTimeSec(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso ?? "");
    return `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${p2(d.getFullYear() % 100)} `
        + `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

// "dd/mm/yy HH:MM:SS.mmm" (24-hour) — sub-second resolution for dense fire logs.
export function fmtDateTimeMs(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso ?? "");
    return `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${p2(d.getFullYear() % 100)} `
        + `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${p3(d.getMilliseconds())}`;
}

// "HH:MM:SS" (24-hour, time only) — for dense log rows that need per-second resolution.
export function fmtTimeSec(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso ?? "");
    return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

// "dd/mm/yy" (no time).
export function fmtDate(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso ?? "");
    return `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${p2(d.getFullYear() % 100)}`;
}

// Elapsed-since label ("12s ago", "5 min ago", "3h ago", "2d ago", "1w ago"); falls back
// to the absolute 24-hour timestamp once older than a few weeks.
export function since(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
    if (s < 60) return `${Math.floor(s)}s ago`;
    const m = s / 60; if (m < 60) return `${Math.floor(m)} min ago`;
    const h = m / 60; if (h < 24) return `${Math.floor(h)}h ago`;
    const dy = h / 24; if (dy < 7) return `${Math.floor(dy)}d ago`;
    const w = dy / 7; if (w < 5) return `${Math.floor(w)}w ago`;
    return fmtDateTime(iso);
}

// Human-readable duration for a FUTURE countdown: 45s / 5m / 5m 30s / 2h 10m. The one countdown
// formatter (rule 7) — shared by the Activity panel's "fires in …" and the trigger node's
// "next in …". Clamps negatives to 0.
export function countdown(secs) {
    let s = Math.max(0, Math.round(secs || 0));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60); s %= 60;
    if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
    const h = Math.floor(m / 60), rm = m % 60;
    return rm ? `${h}h ${rm}m` : `${h}h`;
}

// Compact relative age: no "ago", single-letter units (12s, 5m, 3h, 2d, 1w). Falls back to the
// absolute dd/mm/yy HH:MM once older than a few weeks. For dense lists (e.g. the history panel).
export function sinceShort(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
    if (s < 60) return `${Math.floor(s)}s`;
    const m = s / 60; if (m < 60) return `${Math.floor(m)}m`;
    const h = m / 60; if (h < 24) return `${Math.floor(h)}h`;
    const dy = h / 24; if (dy < 7) return `${Math.floor(dy)}d`;
    const w = dy / 7; if (w < 5) return `${Math.floor(w)}w`;
    return fmtDateTime(iso);
}
