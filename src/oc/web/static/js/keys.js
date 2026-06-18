// Client mirror of the server's KeySpec (src/oc/store/keys.py): build the dedup
// key a record would store under, from its field values + a KeyDef
// {fields, sep, case_sensitive}. Used for INSTANT preview while the user edits the
// key config; the server's computed key (returned by /api/item/read and
// /api/preview) remains the source of truth and confirms after the next read.

export const DEFAULT_KEY = { fields: ["name"], sep: "|", case_sensitive: false };

// Normalised parts, or null when any part is missing/empty (unkeyable record —
// it would be dropped, never guessed). 0 is a valid part.
export function keyParts(values, keyDef) {
    const k = keyDef || DEFAULT_KEY;
    const fields = k.fields || [];
    if (!fields.length) return null;   // empty recipe = unkeyable (never an imaginary "name")
    const out = [];
    for (const f of fields) {
        const v = values ? values[f] : null;
        if (v === null || v === undefined || v === "") return null;
        // whitespace runs -> single underscores, same as the server's KeySpec
        let s = String(v).trim().replace(/\s+/g, "_");
        if (!k.case_sensitive) s = s.toLowerCase();
        if (!s) return null;
        out.push(s);
    }
    return out;
}

export function buildKey(values, keyDef) {
    const parts = keyParts(values, keyDef);
    return parts === null ? null : parts.join((keyDef || DEFAULT_KEY).sep ?? "|");
}
