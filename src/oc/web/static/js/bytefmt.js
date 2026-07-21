// THE byte-size formatter for the web UI — the one place bytes become text, so every size in
// the app scales and rounds identically (rule 7; this was two diverging copies, one of which
// never reached MB and printed "198456.3 kB" for a big store).
//
// Binary units, one decimal, and a plain integer for raw bytes. Nullish/NaN reads as "0 B"
// rather than "NaN B" — a missing size is an absent measurement, not a broken one.
export function fmtBytes(n) {
    const v = Number(n);
    if (!Number.isFinite(v) || v <= 0) return "0 B";
    if (v >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(1)} GB`;
    if (v >= 1024 ** 2) return `${(v / 1024 ** 2).toFixed(1)} MB`;
    if (v >= 1024) return `${(v / 1024).toFixed(1)} kB`;
    return `${Math.round(v)} B`;
}
