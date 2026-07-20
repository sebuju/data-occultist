// Followability acceptance oracle for wire routing (CLAUDE.md rule 7: ONE checker, used by both
// the live corridor-debug badge and the headless test). A line is "eye-followable" exactly when none of the
// four forbidden states occur — the eye loses a line only where it can't tell WHICH line is which:
//
//   overlap            two DIFFERENT wires share a segment over nonzero length (one rides another).
//   under-node         a segment enters a node rect interior (the line vanishes behind a card).
//   ambiguous-junction 3+ distinct wires meet at one point (a knot), OR a wire's interior vertex
//                      lands on another wire's segment interior (a merge/T, not a clean crossing X).
//   self-overlap       a wire doubles back onto its own path (collinear self-overlap or 180° turn).
//
// A clean transversal crossing (two distinct wires, one shared point, distinct directions) is FINE.
//
// checkFollowable(routes, nodeRects) -> violations[]  (empty === passes the gate).
//   routes    : { "aId bId": {pts:[[x,y],...]} }  (or a Map of the same)
//   nodeRects : { id: {x,y,w,h} }
// Each violation: { kind, wires:[key...], at:[x,y] }. `at` is a representative world point.

const EPS = 1e-6;         // float-equality epsilon (numerical tolerance, not a tuning knob)

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const near = (a, b) => Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) < EPS;

// Two parallel lanes read as one unless there is a clear gap between their rendered strokes. The
// drawer strokes wires at 1.8px (edgecanvas applyEdgeStyle); "at least one px between" therefore
// means the centrelines must be at least stroke + 1px ~= 3px apart. Below that they merge. This is a
// perceptual floor tied to the stroke width, not a routing tuning knob.
const STROKE = 1.8;
const MIN_SEP = STROKE + 1;   // ~2.8px centreline separation

// Segments as {a,b,key,wi,si,axis,coord,lo,hi}. axis 'H'/'V' (null if diagonal); coord = the
// constant perpendicular value; [lo,hi] = the run's extent along its axis. Drops zero-length.
function segsOf(key, pts, wi) {
    const out = [];
    for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i], b = pts[i + 1];
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) < EPS) continue;
        const isH = Math.abs(a[1] - b[1]) < EPS, isV = Math.abs(a[0] - b[0]) < EPS;
        const axis = isH ? "H" : isV ? "V" : null;
        const coord = isH ? a[1] : isV ? a[0] : null;
        const lo = axis === "H" ? Math.min(a[0], b[0]) : axis === "V" ? Math.min(a[1], b[1]) : 0;
        const hi = axis === "H" ? Math.max(a[0], b[0]) : axis === "V" ? Math.max(a[1], b[1]) : 0;
        out.push({ a, b, key, wi, si: i, axis, coord, lo, hi });
    }
    return out;
}

// Classify two segments: "proper" (cross at one interior point), "collinear" (share a run),
// "touch" (meet only at a shared endpoint / T-point), or "none". Returns {type, pt, overlapLen}.
function relate(s1, s2) {
    const p = s1.a, r = sub(s1.b, s1.a);
    const q = s2.a, s = sub(s2.b, s2.a);
    const rxs = cross(r, s);
    const qmp = sub(q, p);
    if (Math.abs(rxs) < EPS) {
        // parallel; collinear iff (q-p) x r ~ 0
        if (Math.abs(cross(qmp, r)) > EPS) return { type: "none" };
        // project both onto r to find overlap along the shared line
        const rr = dot(r, r);
        const t0 = dot(qmp, r) / rr;
        const t1 = t0 + dot(s, r) / rr;
        const lo = Math.max(0, Math.min(t0, t1));
        const hi = Math.min(1, Math.max(t0, t1));
        const ov = hi - lo;
        if (ov > EPS) {
            const mid = lo + ov / 2;
            return { type: "collinear", pt: [p[0] + r[0] * mid, p[1] + r[1] * mid], overlapLen: ov * Math.hypot(r[0], r[1]) };
        }
        if (Math.abs(hi - lo) <= EPS && hi >= -EPS && lo <= 1 + EPS) {
            return { type: "touch", pt: [p[0] + r[0] * lo, p[1] + r[1] * lo] };
        }
        return { type: "none" };
    }
    const t = cross(qmp, s) / rxs;
    const u = cross(qmp, r) / rxs;
    if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return { type: "none" };
    const pt = [p[0] + r[0] * t, p[1] + r[1] * t];
    const interiorT = t > EPS && t < 1 - EPS;
    const interiorU = u > EPS && u < 1 - EPS;
    // both interior => clean transversal crossing (allowed as an X, flagged only if a knot forms).
    // exactly one interior => the other segment ENDS on this one's interior: a T / merge.
    return { type: interiorT && interiorU ? "proper" : "touch", pt, interiorT, interiorU };
}

// Segment vs axis-aligned rect: does the segment pass through the rect INTERIOR over nonzero length?
// (Liang-Barsky clip against the open rect; a run strictly inside => under-node.)
function segEntersRect(a, b, rect) {
    const x0 = rect.x, y0 = rect.y, x1 = rect.x + rect.w, y1 = rect.y + rect.h;
    let t0 = 0, t1 = 1;
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const clip = (p, q) => {
        if (Math.abs(p) < EPS) return q > -EPS;             // parallel: inside iff q>=0
        const r = q / p;
        if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
        else { if (r < t0) return false; if (r < t1) t1 = r; }
        return true;
    };
    if (!clip(-dx, a[0] - x0)) return null;
    if (!clip(dx, x1 - a[0])) return null;
    if (!clip(-dy, a[1] - y0)) return null;
    if (!clip(dy, y1 - a[1])) return null;
    if (t1 - t0 <= EPS) return null;                        // only grazes an edge
    const mt = (t0 + t1) / 2;
    const mid = [a[0] + dx * mt, a[1] + dy * mt];
    // require the midpoint to be strictly inside (not on the boundary) — a segment sliding along a
    // node edge is not "under" it.
    if (mid[0] <= x0 + EPS || mid[0] >= x1 - EPS || mid[1] <= y0 + EPS || mid[1] >= y1 - EPS) return null;
    return mid;
}

// cluster key for junction points (grid-snap to EPS-scale so coincident crossings collapse)
const pkey = (pt) => `${Math.round(pt[0] / 1e-3)},${Math.round(pt[1] / 1e-3)}`;

export function checkFollowable(routes, nodeRects) {
    const entries = routes instanceof Map ? [...routes.entries()] : Object.entries(routes || {});
    const rects = nodeRects || {};
    const violations = [];

    // endpoints owned by each wire (its two node ids from the key) — those rects are legal to touch.
    const owners = new Map();
    const allSegs = [];
    entries.forEach(([key, r], wi) => {
        const sp = key.indexOf(" ");
        owners.set(key, sp < 0 ? [key] : [key.slice(0, sp), key.slice(sp + 1)]);
        const pts = (r && r.pts) || [];
        allSegs.push(...segsOf(key, pts, wi));
    });

    // --- under-node ---------------------------------------------------------
    for (const seg of allSegs) {
        const own = owners.get(seg.key);
        for (const [id, rect] of Object.entries(rects)) {
            if (own.includes(id)) continue;
            const at = segEntersRect(seg.a, seg.b, rect);
            if (at) { violations.push({ kind: "under-node", wires: [seg.key], node: id, at }); break; }
        }
    }

    // --- pairwise: overlap (diff wire) / self-overlap / T-merge; collect knot points -------------
    const junctions = new Map();   // pkey -> Set(wire keys) for proper crossings
    for (let i = 0; i < allSegs.length; i++) {
        for (let j = i + 1; j < allSegs.length; j++) {
            const s1 = allSegs[i], s2 = allSegs[j];
            const sameWire = s1.key === s2.key;
            const adjacent = sameWire && Math.abs(s1.si - s2.si) === 1;
            // crowd: two parallel segments running closer than MIN_SEP over a shared span read as one
            // lane — whether from two different wires OR one wire folding back near itself (a hairpin).
            // (A gap of exactly 0 is exact overlap, caught as "overlap"/"self-overlap" below; adjacent
            // segments of one wire meet at a corner and are perpendicular, so they never qualify.)
            if (s1.axis && s1.axis === s2.axis && !(sameWire && adjacent)) {
                const gap = Math.abs(s1.coord - s2.coord);
                if (gap > EPS && gap < MIN_SEP) {
                    const lo = Math.max(s1.lo, s2.lo), hi = Math.min(s1.hi, s2.hi);
                    if (hi - lo > EPS) {
                        const mid = (lo + hi) / 2, c = (s1.coord + s2.coord) / 2;
                        violations.push({ kind: "crowd", wires: sameWire ? [s1.key] : [s1.key, s2.key], at: s1.axis === "H" ? [mid, c] : [c, mid], gap });
                    }
                }
            }
            const rel = relate(s1, s2);
            if (rel.type === "none") continue;
            if (rel.type === "collinear") {
                if (sameWire) violations.push({ kind: "self-overlap", wires: [s1.key], at: rel.pt });
                else violations.push({ kind: "overlap", wires: [s1.key, s2.key], at: rel.pt });
                continue;
            }
            if (rel.type === "proper") {
                if (sameWire) { violations.push({ kind: "self-overlap", wires: [s1.key], at: rel.pt }); continue; }
                const k = pkey(rel.pt);
                const j = junctions.get(k) || junctions.set(k, { wires: new Set(), pt: rel.pt }).get(k);
                j.wires.add(s1.key); j.wires.add(s2.key);
                continue;
            }
            // touch: an endpoint meets a segment. Adjacent self-segments legitimately share a vertex;
            // a 180° backtrack there is self-overlap. Otherwise, a vertex landing on ANOTHER wire's
            // interior is an ambiguous merge/T.
            if (adjacent) continue;
            if (sameWire) { violations.push({ kind: "self-overlap", wires: [s1.key], at: rel.pt }); continue; }
            if (rel.interiorT || rel.interiorU) {
                violations.push({ kind: "ambiguous-junction", wires: [s1.key, s2.key], at: rel.pt });
            }
        }
    }

    // --- knots: 3+ distinct wires crossing at one point ----------------------
    for (const [, j] of junctions) {
        if (j.wires.size >= 3) violations.push({ kind: "ambiguous-junction", wires: [...j.wires], at: j.pt, knot: true });
    }

    return violations;
}

// Convenience: group a violation list by kind for a HUD/summary line.
export function summarize(violations) {
    const by = {};
    for (const v of violations) by[v.kind] = (by[v.kind] || 0) + 1;
    return by;
}

// Counts form of the audit, for a live HUD: how many violations of each kind, plus the mix of which
// router placed the wires (`via`, stamped by busroute/busgraph; anything untagged came from the A*
// router). Same oracle as checkFollowable above — a readout must never grade differently from the
// test (rule 7). Returns {total, kinds:{kind:n}, mix:{via:n}}.
export function gradeRoutes(routes, nodeRects) {
    const kinds = {}, mix = {};
    for (const v of checkFollowable(routes, nodeRects)) kinds[v.kind] = (kinds[v.kind] || 0) + 1;
    const each = routes instanceof Map ? routes.values() : Object.values(routes);
    for (const r of each) { const k = (r && r.via) || "astar"; mix[k] = (mix[k] || 0) + 1; }
    let total = 0;
    for (const k in kinds) total += kinds[k];
    return { total, kinds, mix };
}
