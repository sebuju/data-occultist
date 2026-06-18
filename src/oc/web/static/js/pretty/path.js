// One node-input PATH grammar, shared by constraints / overrides / bindings — and kept in
// lock-step with the Python side (oc/runtime/overrides.py). Dotted segments; a segment is a
// plain attribute (`interval_s`) or a list element addressed by its `id` (`price_nodes[p1]`):
//
//   triggers[t1].interval_s
//   price_nodes[p1].throttle
//   windows[equipment].fields[name].min_confidence
//
// Resolution walks the live profile object (the shared GraphModel.profile), so a value read
// here reflects any transient override already mirrored into the model.

const SEG = /^([A-Za-z_]\w*)(?:\[(.+)\])?$/;

function step(obj, name, key) {
    const cur = obj == null ? undefined : obj[name];
    if (key == null) return cur;
    if (!Array.isArray(cur)) return undefined;
    return cur.find((e) => e != null && String(e.id) === key);
}

// Resolve to the {parent, name} holding the final attribute (so callers can get OR set it),
// or null if any step is missing or the final segment isn't a plain attribute.
export function pathParent(profile, path) {
    const segs = String(path || "").split(".");
    let parent = profile;
    for (const s of segs.slice(0, -1)) {
        const m = SEG.exec(s);
        if (!m) return null;
        parent = step(parent, m[1], m[2]);
        if (parent == null) return null;
    }
    const m = SEG.exec(segs[segs.length - 1]);
    if (!m || m[2] != null) return null;
    return { parent, name: m[1] };
}

export function pathGet(profile, path) {
    const p = pathParent(profile, path);
    return p ? p.parent[p.name] : undefined;
}

export function pathSet(profile, path, value) {
    const p = pathParent(profile, path);
    if (!p) return false;
    p.parent[p.name] = value;
    return true;
}
