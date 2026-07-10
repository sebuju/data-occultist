// gates.js — hierarchical routing helper (pure, no DOM/state deps). Classifies every edge by the group
// membership of its two endpoints and assigns each boundary-CROSSING edge a GATE: one fanned crossing
// point per group-box face. A group becomes an opaque box to the outside; every line that crosses its
// boundary funnels through the gate on the face nearest its outside end, fanned so multiple crossings
// never stack on one point. The fan's CENTRE is free, not fixed at the face midpoint: it slides toward
// the mean straight member<->outside pierce point (pierceCoord), so a side's gates track where its wires
// actually point instead of always sitting dead-centre. hierRoute.js then routes the inside half (member
// -> gate) and the outside half (gate -> free node / other group's gate) as separate A* sub-problems and
// stitches them at the shared gate point (route.js gate terminals keep both halves meeting there exactly).
//
// Edge classes:
//   outer     — both ends free (no group)                -> routed whole in the outer pass
//   inner(G)  — both ends in the same group G            -> routed whole in G's pass
//   crossing  — ends in different groups, or one free    -> split at a gate on each grouped end

const PORT_MIN = 12;      // hard floor between adjacent fanned gates on one face (no overlap)
const FACE_MARGIN = 12;   // keep the fan this far inside the face corners
const SPACE_CAP = 300;    // px clearance treated as "wide open" — caps one distant node from swamping
                          // the score against a face that's merely mostly-clear
const K_SPACE = 60;       // max px-equivalent bonus faceToward gives a fully-open face (space score
                          // normalized 0..1) — direction still dominates; this only breaks a near-tie
                          // or steers off a strongly-blocked side
const K_OPEN = 0.75;      // blend weight of the fan centre toward the emptiest span (0 = pure pierce-
                          // mean, 1 = pure open-gap) — the open gap dominates: a member row's own
                          // pierce-mean reliably points AT that row, so a weak blend barely escapes it.
const NEAR_PROBE = 150;   // px reach from the face (EITHER direction) within which a node counts as
                          // crowding this gap-search — a member row parked right at the boundary
                          // squeezes the gate exactly like a nearby exterior node would. Bounds BOTH
                          // sides: unbounded outward reach let one distant, unrelated node (anything
                          // whose Y merely overlapped the span, however far away in X) swallow the
                          // whole usable span and collapse the search to the span edge — the opposite
                          // of "emptiest". Beyond this depth on either side, routing has room to dodge
                          // on its own; only near-face congestion should relocate the gate.

const rectCenter = (r) => [r.x + r.w / 2, r.y + r.h / 2];

// clearance beyond `box`'s face `f`, out to the nearest node rect that both (a) overlaps the face's
// perpendicular span and (b) sits outward of the face — how much open canvas a gate on this face has
// before it runs into something. No qualifying node -> SPACE_CAP (wide open).
function faceSpace(box, f, nodeRects) {
    let best = SPACE_CAP;
    if (!nodeRects) return best;
    const horiz = f === "L" || f === "R";
    const lo = horiz ? box.y : box.x, hi = horiz ? box.y + box.h : box.x + box.w;
    for (const r of nodeRects.values()) {
        const rLo = horiz ? r.y : r.x, rHi = horiz ? r.y + r.h : r.x + r.w;
        if (rHi <= lo || rLo >= hi) continue;   // no overlap with the face's perpendicular span
        let d;
        if (f === "L") { if (r.x + r.w > box.x) continue; d = box.x - (r.x + r.w); }
        else if (f === "R") { if (r.x < box.x + box.w) continue; d = r.x - (box.x + box.w); }
        else if (f === "T") { if (r.y + r.h > box.y) continue; d = box.y - (r.y + r.h); }
        else { if (r.y < box.y + box.h) continue; d = r.y - (box.y + box.h); }
        if (d < best) best = d;
    }
    return best;
}
// widest free gap along `box`'s face `f` within [lo,hi] (the usable fan span) — returns that gap's
// centre COORD along the face axis. A gap is bounded by any node within NEAR_PROBE of the face on
// EITHER side: an exterior node close enough to squeeze the wire leaving the face, or a member row
// parked close enough to the face on the inside to squeeze the gate the same way. Nodes farther than
// NEAR_PROBE (either direction) don't count — they're not this gap's problem. No qualifying nodes ->
// the span's own centre (nothing to dodge).
function emptiestCoord(box, f, nodeRects, lo, hi) {
    if (!nodeRects) return (lo + hi) / 2;
    const horiz = f === "L" || f === "R";
    const blocks = [];
    for (const r of nodeRects.values()) {
        const b0 = horiz ? r.y : r.x, b1 = horiz ? r.y + r.h : r.x + r.w;
        if (b1 <= lo || b0 >= hi) continue;   // no overlap with the usable span
        let near;
        if (f === "L") near = (r.x + r.w <= box.x && box.x - (r.x + r.w) <= NEAR_PROBE) || (r.x >= box.x && r.x - box.x <= NEAR_PROBE);
        else if (f === "R") near = (r.x >= box.x + box.w && r.x - (box.x + box.w) <= NEAR_PROBE) || (r.x + r.w <= box.x + box.w && (box.x + box.w) - (r.x + r.w) <= NEAR_PROBE);
        else if (f === "T") near = (r.y + r.h <= box.y && box.y - (r.y + r.h) <= NEAR_PROBE) || (r.y >= box.y && r.y - box.y <= NEAR_PROBE);
        else near = (r.y >= box.y + box.h && r.y - (box.y + box.h) <= NEAR_PROBE) || (r.y + r.h <= box.y + box.h && (box.y + box.h) - (r.y + r.h) <= NEAR_PROBE);
        if (!near) continue;
        blocks.push([Math.max(lo, b0), Math.min(hi, b1)]);
    }
    if (!blocks.length) return (lo + hi) / 2;
    blocks.sort((a, b) => a[0] - b[0]);
    let cursor = lo, bestGap = -1, bestMid = (lo + hi) / 2;
    for (const [b0, b1] of blocks) {
        if (b0 - cursor > bestGap) { bestGap = b0 - cursor; bestMid = (cursor + b0) / 2; }
        cursor = Math.max(cursor, b1);
    }
    if (hi - cursor > bestGap) { bestGap = hi - cursor; bestMid = (cursor + hi) / 2; }
    return bestMid;
}

// which face of `box` points toward `pt` — the face whose outward normal best aligns with the direction
// to `pt`, nudged toward whichever face has open canvas beyond it (faceSpace). All four faces (incl.
// TOP) are eligible even when the box has a title band: a top gate is permitted, and route.js's
// headCross SOFT penalty still steers wires around the heading when a clear side is available, so top
// is used only when the geometry genuinely favors it.
function faceToward(box, pt, band, nodeRects) {
    const c = rectCenter(box), dx = pt[0] - c[0], dy = pt[1] - c[1];
    const score = { L: -dx, R: dx, T: -dy, B: dy };
    let best = "R", bv = -Infinity;
    for (const f of ["L", "R", "T", "B"]) {
        const s = score[f] + K_SPACE * (faceSpace(box, f, nodeRects) / SPACE_CAP);
        if (s > bv) { bv = s; best = f; }
    }
    return best;
}
// Move every single-exit face's end onto the busiest OTHER occupied face. Counts are recomputed live, so
// two lone singles collapse onto one side rather than swapping. A single that has no company anywhere
// (all other faces empty) stays put — one line, one gate.
function mergeLonelyFaces(ends, band) {
    const FACES = ["L", "R", "T", "B"];
    const tally = () => { const m = { L: 0, R: 0, T: 0, B: 0 }; for (const e of ends) m[e.face]++; return m; };
    for (const lf of FACES) {
        const m = tally();
        if (m[lf] !== 1) continue;                       // only a face with exactly one exit is merged
        let target = null, best = 0;
        for (const f of FACES) { if (f === lf) continue; if (m[f] > best) { best = m[f]; target = f; } }
        if (!target) continue;                           // nothing to merge onto — leave the lone exit
        for (const e of ends) if (e.face === lf) e.face = target;
    }
}
// is a remembered face still geometrically reasonable (outside pt still on that side of the box centre)?
function faceStillOk(box, pt, f) {
    const c = rectCenter(box);
    if (f === "L") return pt[0] <= c[0];
    if (f === "R") return pt[0] >= c[0];
    if (f === "T") return pt[1] <= c[1];
    return pt[1] >= c[1];
}
// coord (along the face's own axis) where the straight line from inside point `A` to
// outside point `B` pierces face `f` of `box` — the "straightest wire" gate position.
// Degenerates to A's own coord on that axis when the segment runs parallel to the face.
function pierceCoord(box, f, A, B) {
    if (f === "L" || f === "R") {
        const faceX = f === "L" ? box.x : box.x + box.w;
        const dx = B[0] - A[0];
        if (Math.abs(dx) < 1e-6) return A[1];
        const t = (faceX - A[0]) / dx;
        return A[1] + t * (B[1] - A[1]);
    }
    const faceY = f === "T" ? box.y : box.y + box.h;
    const dy = B[1] - A[1];
    if (Math.abs(dy) < 1e-6) return A[0];
    const t = (faceY - A[1]) / dy;
    return A[0] + t * (B[0] - A[0]);
}
// point on `box` face `f` at perpendicular coord `c`
function facePoint(box, f, c) {
    if (f === "L") return [box.x, c];
    if (f === "R") return [box.x + box.w, c];
    if (f === "T") return [c, box.y];
    return [c, box.y + box.h];
}
// outward (leaving the box) / inward (entering) stub direction per face — route.js gate `dir`
const OUT_DIR = { L: "W", R: "E", T: "N", B: "S" };
const IN_DIR = { L: "E", R: "W", T: "S", B: "N" };

// classifyAndGate({ nodeRects, groupBox, groupOf, edges, laneGap, prevFace })
//   nodeRects : Map(id -> {x,y,w,h})            live world rect of every routable node
//   groupBox  : Map(gid -> {x,y,w,h,bandH})     live box of every group that has one
//   groupOf   : (id) -> gid | null              a node's group (null = free)
//   edges     : [{from,to,key}]                 the edges to route
//   laneGap   : preferred spacing between fanned gates
//   prevFace  : Map("key|gid" -> face) | null   last frame's gate faces, for hysteresis
// returns { outer:[edge], inner:Map(gid->[edge]), crossings:[cr], faces:Map("key|gid"->face) }
// where a crossing `cr` = { key, from, to, fromGid, toGid, fromGate, toGate } and a gate =
//   { pt:[x,y], face, gid, out, in }  (out/in are the outward/inward stub dirs; hierRoute picks per half)
export function classifyAndGate({ nodeRects, groupBox, groupOf, edges, laneGap = 12, prevFace = null }) {
    const outer = [], inner = new Map(), crossings = [], faces = new Map();
    for (const e of edges) {
        const ga = groupOf(e.from), gb = groupOf(e.to);
        const va = ga && groupBox.has(ga), vb = gb && groupBox.has(gb);   // grouped AND that group has a live box
        if (!va && !vb) { outer.push(e); continue; }
        if (va && vb && ga === gb) { (inner.get(ga) || inner.set(ga, []).get(ga)).push(e); continue; }
        crossings.push({ key: e.key, from: e.from, to: e.to, fromGid: va ? ga : null, toGid: vb ? gb : null, fromGate: null, toGate: null });
    }
    // reference point of a crossing's OTHER end: a free node's centre, or the other group's box centre
    const outsidePtOf = (cr, which) => {
        const otherId = which === "from" ? cr.to : cr.from;
        const otherGid = which === "from" ? cr.toGid : cr.fromGid;
        if (otherGid && groupBox.has(otherGid)) return rectCenter(groupBox.get(otherGid));
        const r = nodeRects.get(otherId); return r ? rectCenter(r) : [0, 0];
    };
    // the INSIDE anchor of a gated end (the member driving this crossing) — used to aim the gate at the
    // straight member<->outside line instead of always sitting at the face midpoint
    const insidePtOf = (cr, which, gid) => {
        const insideId = which === "from" ? cr.from : cr.to;
        const r = nodeRects.get(insideId);
        if (r) return rectCenter(r);
        const b = groupBox.get(gid); return b ? rectCenter(b) : [0, 0];
    };
    // gather every gated END per group
    const byGroup = new Map();   // gid -> [{cr, which, outside:[x,y], inside:[x,y]}]
    const addEnd = (gid, cr, which) => (byGroup.get(gid) || byGroup.set(gid, []).get(gid)).push({ cr, which, outside: outsidePtOf(cr, which), inside: insidePtOf(cr, which, gid) });
    for (const cr of crossings) { if (cr.fromGid) addEnd(cr.fromGid, cr, "from"); if (cr.toGid) addEnd(cr.toGid, cr, "to"); }

    for (const [gid, ends] of byGroup) {
        const box = groupBox.get(gid), band = box.bandH || 0;
        // face per end, with hysteresis: keep last frame's face unless it's no longer on the right side
        for (const en of ends) {
            let f = faceToward(box, en.outside, band, nodeRects);
            if (prevFace) { const pf = prevFace.get(en.cr.key + "|" + gid); if (pf && pf !== f && faceStillOk(box, en.outside, pf)) f = pf; }
            en.face = f;
        }
        // consolidate: a face carrying only ONE exit is merged onto the busiest OTHER occupied face, so a
        // group doesn't sprout lonely single-line gates on several sides — its crossings gather on as few
        // sides as possible. A truly solitary crossing (nothing on any other face) is left where it is.
        mergeLonelyFaces(ends, band);
        for (const en of ends) faces.set(en.cr.key + "|" + gid, en.face);
        // fan each face's ends along the face span (ordered by the outside end so stubs don't cross)
        const buckets = new Map();
        for (const en of ends) (buckets.get(en.face) || buckets.set(en.face, []).get(en.face)).push(en);
        for (const [f, arr] of buckets) {
            const horiz = f === "L" || f === "R";   // vertical face edge => fan along Y; top/bottom => along X
            let lo = horiz ? box.y + band : box.x;   // L/R skip the title band at the top of the box
            let hi = horiz ? box.y + box.h : box.x + box.w;
            lo += FACE_MARGIN; hi -= FACE_MARGIN;
            if (hi < lo) { const m = (lo + hi) / 2; lo = hi = m; }
            const n = arr.length;
            arr.sort((u, v) => (horiz ? u.outside[1] - v.outside[1] : u.outside[0] - v.outside[0]));
            // free fan centre: the mean straight-wire pierce point of this face's ends, instead of the
            // fixed face midpoint — the fan still spreads/orders exactly as before, it just slides to
            // where the wires actually point.
            let cFree = 0;
            for (const en of arr) cFree += pierceCoord(box, f, en.inside, en.outside);
            cFree = Math.max(lo, Math.min(hi, cFree / n));
            // pull the fan off a dense clump toward the emptiest part of this face's span — a blend, so
            // it still favours where the wires actually point rather than jumping straight to the gap.
            const openC = emptiestCoord(box, f, nodeRects, lo, hi);
            cFree = Math.max(lo, Math.min(hi, cFree + K_OPEN * (openC - cFree)));
            const spread = Math.min(hi - lo, Math.max((n - 1) * laneGap, (n - 1) * PORT_MIN));
            const center = Math.max(lo + spread / 2, Math.min(hi - spread / 2, cFree));
            for (let i = 0; i < n; i++) {
                const c = n < 2 ? cFree : center - spread / 2 + (i * spread) / (n - 1);
                const pt = facePoint(box, f, Math.max(lo, Math.min(hi, c)));
                const gate = { pt, face: f, gid, out: OUT_DIR[f], in: IN_DIR[f] };
                if (arr[i].which === "from") arr[i].cr.fromGate = gate; else arr[i].cr.toGate = gate;
            }
        }
    }
    return { outer, inner, crossings, faces };
}
