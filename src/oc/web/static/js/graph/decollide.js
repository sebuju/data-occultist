// decollide.js — GLOBAL cross-pass wire de-collision, run once on the FINAL stitched routes.
//
// Why this exists: hierRoute.js routes the graph in ISOLATED passes (one outer + one per group box)
// for performance. route.js's nudge() — the anti-overlap / lane-packing stage — separates coincident
// wires ONLY within a single pass. Two wires from DIFFERENT passes never share a nudge bucket, so both
// can land on the identical world coordinate for a long shared run (the "two wires exactly on top of
// each other" bug). This pass reconciles that residue across the assembled polylines.
//
// Design — occupancy-aware MINIMAL displacement (NOT re-centering). An earlier attempt re-centred each
// colliding run in its free alley (like nudge does within a pass); global-blind, that FLUNG runs onto
// OTHER wires already sitting mid-alley and made overlap WORSE. So instead: leave every run where A*
// put it, and for each run that actually collides with a different wire, nudge ONLY that run to the
// nearest track that is verified clear of EVERY other segment (global occupancy). A run that can't find
// a clear track inside its wall-bounded alley is left untouched — never displaced onto something else.
//
// Held fixed (never moved): a port-stub endpoint segment (moving it detaches the wire from its node)
// and a run sitting INSIDE a wall (an inner-pass run within its own group box — evicting it is wrong).
import { simplify } from "./route.js";

const CLEAR = 5;           // px kept clear of each alley wall (matches nudge's `clear`)

// The free alley around a run's coord: nearest wall edge each side. A wall STRADDLING the coord (the run
// sits inside it) makes the run unmovable — we must not push it out of the box/node it lives in.
function alleyOf(axis, coord, lo, hi, walls) {
    let lb = -Infinity, rb = Infinity, straddled = false;
    for (const w of walls) {
        const ov = axis === "V" ? (w.y < hi && w.y + w.h > lo) : (w.x < hi && w.x + w.w > lo);
        if (!ov) continue;
        const e0 = axis === "V" ? w.x : w.y, e1 = axis === "V" ? w.x + w.w : w.y + w.h;
        if (e1 <= coord + 0.5) lb = Math.max(lb, e1);
        else if (e0 >= coord - 0.5) rb = Math.min(rb, e0);
        else { straddled = true; break; }
    }
    return { lb, rb, straddled };
}

const spanOverlap = (a, b) => Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo) > 1;

const FACE_M = 8;   // keep a slid port this far inside its node face (off the corners)
// The node face a port stub attaches to, as its slidable perp span (an H stub rides an L/R face, slides
// in Y; a V stub rides a T/B face, slides in X). Returns {lo,hi} or null (free/gate end — leave pinned).
function faceSpanFor(port, axis, walls) {
    const T = 8;
    if (axis === "H") { for (const w of walls) if (port[1] > w.y - 1 && port[1] < w.y + w.h + 1 && (Math.abs(port[0] - w.x) < T || Math.abs(port[0] - (w.x + w.w)) < T)) return { lo: w.y, hi: w.y + w.h }; }
    else { for (const w of walls) if (port[0] > w.x - 1 && port[0] < w.x + w.w + 1 && (Math.abs(port[1] - w.y) < T || Math.abs(port[1] - (w.y + w.h)) < T)) return { lo: w.x, hi: w.x + w.w }; }
    return null;
}
// would a run on `axis` at coord `c` spanning [lo,hi] pierce any node interior?
function stubHitsNode(axis, c, lo, hi, walls) {
    for (const w of walls) {
        const e0 = axis === "V" ? w.x : w.y, e1 = axis === "V" ? w.x + w.w : w.y + w.h;
        const o0 = axis === "V" ? w.y : w.x, o1 = axis === "V" ? w.y + w.h : w.x + w.w;
        if (c > e0 + 1 && c < e1 - 1 && hi > o0 + 1 && lo < o1 - 1) return true;
    }
    return false;
}

// Group-box CONTAINERS (not obstacles): a box the run lives INSIDE only clamps how far it may
// travel (it must stay in the box), never freezes it — unlike a straddling wall. A box entirely to
// one side clamps that side like a wall (don't cross into a neighbouring group). Returns interior
// bounds only; never "straddled", so an inner-pass run stays free to shift into a clear lane.
function containerBounds(axis, coord, lo, hi, boxes) {
    let lb = -Infinity, rb = Infinity;
    for (const w of boxes) {
        const ov = axis === "V" ? (w.y < hi && w.y + w.h > lo) : (w.x < hi && w.x + w.w > lo);
        if (!ov) continue;
        const e0 = axis === "V" ? w.x : w.y, e1 = axis === "V" ? w.x + w.w : w.y + w.h;
        if (e1 <= coord + 0.5) lb = Math.max(lb, e1);           // box entirely on the low side
        else if (e0 >= coord - 0.5) rb = Math.min(rb, e0);      // box entirely on the high side
        else { lb = Math.max(lb, e0); rb = Math.min(rb, e1); }  // run is INSIDE this box — keep it in
    }
    return { lb, rb };
}

// deCollide(routes, walls, config) -> new Map(key -> {pts,p1,d1,p2,d2})
//   routes : the Map hierRoute returns (values may be CACHED sub-pass objects, shared by reference)
//   walls  : [{x,y,w,h}] every node rect + title band a shift must not cross
//   config : { laneGap, containers } — containers are group boxes: a run INSIDE one may still shift
//            into a parallel lane (clamped to stay in the box), where a straddling wall would freeze
//            it. Passing boxes as walls (the old behaviour) left sibling skip-edges stacked on one coord.
// Returns a fresh Map; untouched routes keep their original object, touched ones get a CLONE (never
// mutate in place — hierRoute hands back cached sub-pass results by reference, poisoning the pass cache).
export function deCollide(routes, walls, config = {}) {
    const laneGap = config.laneGap || 12;
    walls = walls || [];
    const containers = config.containers || [];   // group boxes: clamp travel, never freeze (see containerBounds)
    const bnow = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());
    const bt0 = config.bench ? bnow() : 0;
    const blog = () => { if (config.bench) console.log(`[decollide] ${(bnow() - bt0).toFixed(0)}ms | ${routes.size} routes`); };

    // ---- decompose every route into axis-aligned segments (read-only over the originals) ----
    // `cur` is the run's live coord (updated as we displace); `movable` gates whether it may move at all.
    const segs = [];
    for (const [key, r] of routes) {
        const pts = r && r.pts;
        if (!pts || pts.length < 2) continue;
        const last = pts.length - 1;
        for (let i = 0; i + 1 < pts.length; i++) {
            const a = pts[i], b = pts[i + 1];
            const endpoint = i === 0 || i + 1 === last;   // a port stub — its far end is the node face; don't move it
            let s = null;
            if (Math.abs(a[0] - b[0]) < 0.5 && Math.abs(a[1] - b[1]) > 0.5)
                s = { key, axis: "V", coord: a[0], cur: a[0], lo: Math.min(a[1], b[1]), hi: Math.max(a[1], b[1]), i0: i, i1: i + 1 };
            else if (Math.abs(a[1] - b[1]) < 0.5 && Math.abs(a[0] - b[0]) > 0.5)
                s = { key, axis: "H", coord: a[1], cur: a[1], lo: Math.min(a[0], b[0]), hi: Math.max(a[0], b[0]), i0: i, i1: i + 1 };
            if (!s) continue;
            s.isEnd = endpoint;
            if (endpoint) s.face = faceSpanFor(i === 0 ? pts[0] : pts[last], s.axis, walls);
            const al = endpoint ? null : alleyOf(s.axis, s.coord, s.lo, s.hi, walls);
            s.movable = !endpoint && !(al && al.straddled);
            let lb = al ? al.lb : -Infinity, rb = al ? al.rb : Infinity;
            // group boxes only tighten the alley (stay inside the box) — an enclosing box no longer
            // freezes the run, so sibling skip-edges arching over a node row can still fan into lanes.
            if (!endpoint && containers.length) {
                const cb = containerBounds(s.axis, s.coord, s.lo, s.hi, containers);
                lb = Math.max(lb, cb.lb); rb = Math.min(rb, cb.rb);
            }
            s.lb = lb; s.rb = rb;
            segs.push(s);
        }
    }

    const byAxis = { V: [], H: [] };
    for (const s of segs) byAxis[s.axis].push(s);
    // the same-axis OTHER-wire runs that share this run's span — its neighbours on the corridor.
    const neighboursOf = (seg) => byAxis[seg.axis].filter((s2) => s2.key !== seg.key && spanOverlap(seg, s2));
    // min gap from coord `c` to any neighbour (Infinity when the corridor is otherwise empty).
    const minGap = (c, list) => { let d = Infinity; for (const s2 of list) d = Math.min(d, Math.abs(c - s2.cur)); return d; };

    // ---- resolve: fan each colliding movable run off its neighbours, packing tighter when the alley
    // is cramped. The old fixed-laneGap search GAVE UP when the alley was tighter than (n-1)*laneGap
    // (the many-skip-edges-over-one-row case) and left runs stacked. This packs to fit instead.
    // Relaxation (Lloyd): each run that sits within a laneGap of a neighbour slides to the MIDPOINT of
    // the gap between its two bracketing runs (or the alley walls when a side is open). Iterated, a
    // crowded corridor spreads to EVEN spacing — which is a full laneGap when the alley is roomy and
    // packs proportionally tighter (never below what fits) when it isn't, the many-skip-edges case.
    // Two runs on the identical coord are split by a stable key tie-break so they don't move as one.
    // Occupancy-safe by construction: a run is bounded by its neighbours + its own alley, so it can
    // never cross onto another wire (the flaw that sank the earlier global re-centre — see header).
    for (let pass = 0; pass < 24; pass++) {
        let moved = false;
        for (const seg of segs) {
            if (!seg.movable) continue;
            const list = neighboursOf(seg);
            if (!list.length || minGap(seg.cur, list) >= laneGap - 0.5) continue;   // clear enough — leave it
            const loB = Number.isFinite(seg.lb) ? seg.lb + CLEAR : -1e9;
            const hiB = Number.isFinite(seg.rb) ? seg.rb - CLEAR : 1e9;
            let below = loB, above = hiB;                     // nearest neighbour bracketing `seg` each side
            for (const s2 of list) {
                const lower = s2.cur < seg.cur - 0.01 || (Math.abs(s2.cur - seg.cur) <= 0.01 && s2.key < seg.key);
                if (lower) below = Math.max(below, s2.cur); else above = Math.min(above, s2.cur);
            }
            let target = (below + above) / 2;
            if (target < loB) target = loB; else if (target > hiB) target = hiB;
            if (Math.abs(target - seg.cur) > 0.4) { seg.cur = target; moved = true; }
        }
        if (!moved) break;
    }

    // ---- endpoint de-dup: fanFaceEnds / evict can stack two port stubs on ONE face coord (the Lloyd
    // relaxation above skips endpoints — moving one would detach it). But a stub may SLIDE along its own
    // node face (perp coord) without detaching. For each end-stub still colliding, slide it to the
    // nearest face coord that is (a) >laneGap from every other run sharing its span AND (b) leaves the
    // stub clear of every node — so separating a stub can never manufacture a through-node.
    const OVL = 1;   // px of span overlap that counts as a collision (catch sub-laneGap near-misses too)
    const collides = (seg, c) => {
        for (const s2 of segs) { if (s2 === seg || s2.axis !== seg.axis) continue; if (Math.abs(s2.cur - c) < laneGap - 0.5 && Math.min(seg.hi, s2.hi) - Math.max(seg.lo, s2.lo) > OVL) return true; }
        return false;
    };
    for (let iter = 0; iter < 30; iter++) {
        let fixed = false;
        for (const seg of segs) {
            if (!seg.isEnd || !seg.face || seg.face.hi - seg.face.lo <= 2 * FACE_M) continue;
            // resolve an end-stub that either collides with another run OR pierces a node (a long stub
            // nudge shoved through a node row) — both fix by sliding along the face to a clear coord.
            if (!collides(seg, seg.cur) && !stubHitsNode(seg.axis, seg.cur, seg.lo, seg.hi, walls)) continue;
            const lo = seg.face.lo + FACE_M, hi = seg.face.hi - FACE_M;
            let best = null, bestd = 1e9;
            for (let c = lo; c <= hi; c += 2) {
                if (stubHitsNode(seg.axis, c, seg.lo, seg.hi, walls)) continue;
                if (collides(seg, c)) continue;
                const d = Math.abs(c - seg.cur); if (d < bestd) { bestd = d; best = c; }
            }
            if (best != null && Math.abs(best - seg.cur) > 0.5) { seg.cur = best; fixed = true; }
        }
        if (!fixed) break;
    }

    // ---- apply: clone each displaced wire's pts once, shift its vertices, re-simplify ----
    const moved = new Map();   // key -> [{i0,i1,axis,off}]
    for (const s of segs) {
        const off = s.cur - s.coord;
        if (Math.abs(off) < 0.5) continue;
        (moved.get(s.key) || moved.set(s.key, []).get(s.key)).push({ i0: s.i0, i1: s.i1, axis: s.axis, off });
    }
    if (!moved.size) { blog(); return routes; }                // nothing displaced — hand back the input untouched
    const out = new Map(routes);
    for (const [key, list] of moved) {
        const r = routes.get(key);
        if (!r || !r.pts) continue;
        const pts = r.pts.map((p) => p.slice());               // deep clone — never mutate the cached array
        for (const sh of list) {
            const ax = sh.axis === "V" ? 0 : 1;                // V shifts x, H shifts y
            pts[sh.i0][ax] += sh.off; pts[sh.i1][ax] += sh.off;
        }
        const np = simplify(pts);
        out.set(key, { pts: np, p1: np[0].slice(), d1: r.d1, p2: np[np.length - 1].slice(), d2: r.d2 });
    }
    blog();
    return out;
}
