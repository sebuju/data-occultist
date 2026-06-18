// Date/time formatting — HOUSE RULE: 24-hour clock, dates as dd/mm/yy. Never 12-hour
// / AM-PM, never locale-default (toLocaleString varies by machine). Every date/time the
// UI shows goes through here.

const p2 = (n) => String(n).padStart(2, "0");

// "dd/mm/yy HH:MM" (24-hour).
export function fmtDateTime(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso ?? "");
    return `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${p2(d.getFullYear() % 100)} `
        + `${p2(d.getHours())}:${p2(d.getMinutes())}`;
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
