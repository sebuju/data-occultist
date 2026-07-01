// Human label for a history entry, derived by DIFFING the previous snapshot against the new one.
// One labeller for both histories (node graph + Pretty) so the edit list reads the same in both.
// Snapshots are JSON strings of the whole editable object; we find the FIRST meaningful
// difference and describe it ("add window 'arcanes'", "windows > eq > id: equipment -> gear").
// Approximate by design — it's a scannable edit log, not an audit trail; when nothing obvious is
// found it falls back to "edit".

const kindOf = (v) => (Array.isArray(v) ? "array" : v === null ? "null" : typeof v);

// A short, readable stand-in for a value in the leaf label.
function short(v) {
    if (v == null) return "-";
    if (typeof v === "object") return Array.isArray(v) ? `[${v.length}]` : "{...}";
    const s = String(v);
    return s.length > 22 ? s.slice(0, 21) + "…" : s;
}

// Name an array element by its most identifying field (id/name/title), else null.
function elName(el) {
    if (el && typeof el === "object") {
        for (const k of ["id", "name", "title", "field", "key"]) if (el[k]) return String(el[k]);
    }
    return null;
}

// A path segment is either { k } (object key) or { i, el } (array index + its element). Render
// the tail of the path so labels stay short: name an array element, else its key/index.
function pathText(path) {
    return path.map((s) => (s.k != null ? s.k : elName(s.el) || `#${s.i}`)).join(" › ");
}

// Depth-first: return the first difference as a finished label string, or null if identical.
function walk(a, b, path) {
    if (a === b) return null;
    const ka = kindOf(a), kb = kindOf(b);
    if (ka !== kb) return `${pathText(path)}: ${short(a)} → ${short(b)}`;
    if (ka === "array") {
        if (a.length !== b.length) {
            const n = Math.min(a.length, b.length);
            let i = 0;
            while (i < n && JSON.stringify(a[i]) === JSON.stringify(b[i])) i++;
            const noun = pathText(path) || "item";
            if (b.length > a.length) { const el = b[i]; return `add ${noun}${elName(el) ? ` '${elName(el)}'` : ""}`; }
            const el = a[i]; return `remove ${noun}${elName(el) ? ` '${elName(el)}'` : ""}`;
        }
        for (let i = 0; i < a.length; i++) {
            const r = walk(a[i], b[i], [...path, { i, el: b[i] }]);
            if (r) return r;
        }
        return null;
    }
    if (ka === "object") {
        const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
        for (const k of keys) {
            if (!(k in a)) return `set ${pathText([...path, { k }])}`;
            if (!(k in b)) return `clear ${pathText([...path, { k }])}`;
            const r = walk(a[k], b[k], [...path, { k }]);
            if (r) return r;
        }
        return null;
    }
    return `${pathText(path)}: ${short(a)} → ${short(b)}`;
}

// Operation class of a finished label, for colour-coding the history panel.
function opKind(text) {
    if (text.startsWith("add ")) return "add";
    if (text.startsWith("remove ")) return "remove";
    if (text.startsWith("set ")) return "set";
    if (text.startsWith("clear ")) return "clear";
    return "change";   // "path: a → b" leaf edits, moves, sorts, widths, renames…
}

// Returns { text, kind } — kind drives the row colour, text is the label shown.
export function diffLabel(prevJson, nextJson) {
    if (prevJson == null) return { text: "loaded", kind: "base" };
    let a, b;
    try { a = JSON.parse(prevJson); b = JSON.parse(nextJson); } catch { return { text: "edit", kind: "change" }; }
    const text = walk(a, b, []) || "edit";
    return { text, kind: opKind(text) };
}
