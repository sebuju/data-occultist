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
const MAX_STEPS = 8;       // how many laneGap steps out to search for a clear track before giving up

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

const spanOverlap = (a, b) => Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo) > 5;

// deCollide(routes, walls, config) -> new Map(key -> {pts,p1,d1,p2,d2})
//   routes : the Map hierRoute returns (values may be CACHED sub-pass objects, shared by reference)
//   walls  : [{x,y,w,h}] every node rect + group box + title band a shift must not cross
//   config : { laneGap }
// Returns a fresh Map; untouched routes keep their original object, touched ones get a CLONE (never
// mutate in place — hierRoute hands back cached sub-pass results by reference, poisoning the pass cache).
export function deCollide(routes, walls, config = {}) {
    const laneGap = config.laneGap || 12;
    const GAP = laneGap * 0.9;   // two same-axis runs closer than this (with overlapping span) read as collided
    walls = walls || [];

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
            const al = endpoint ? null : alleyOf(s.axis, s.coord, s.lo, s.hi, walls);
            s.movable = !endpoint && !(al && al.straddled);
            s.lb = al ? al.lb : -Infinity; s.rb = al ? al.rb : Infinity;
            segs.push(s);
        }
    }

    // ---- occupancy: same-axis segments sharing this run's span, for a global "is coord c clear?" test ----
    const byAxis = { V: [], H: [] };
    for (const s of segs) byAxis[s.axis].push(s);
    // does `seg` currently collide with any OTHER-wire run? (same axis, overlapping span, within GAP)
    const collides = (seg) => {
        for (const s2 of byAxis[seg.axis]) {
            if (s2 === seg || s2.key === seg.key) continue;
            if (spanOverlap(seg, s2) && Math.abs(seg.cur - s2.cur) < GAP) return true;
        }
        return false;
    };
    // is coord `c` clear for `seg` — no other-wire run within laneGap of it over the shared span?
    const clearAt = (seg, c) => {
        for (const s2 of byAxis[seg.axis]) {
            if (s2 === seg || s2.key === seg.key) continue;
            if (spanOverlap(seg, s2) && Math.abs(c - s2.cur) < laneGap) return false;
        }
        return true;
    };

    // ---- resolve: nudge each colliding movable run to the NEAREST globally-clear track in its alley ----
    for (const seg of segs) {
        if (!seg.movable || !collides(seg)) continue;
        const loB = Number.isFinite(seg.lb) ? seg.lb + CLEAR : -Infinity;
        const hiB = Number.isFinite(seg.rb) ? seg.rb - CLEAR : Infinity;
        for (let k = 1; k <= MAX_STEPS; k++) {
            let placed = false;
            for (const c of [seg.coord + k * laneGap, seg.coord - k * laneGap]) {
                if (c < loB || c > hiB) continue;
                if (clearAt(seg, c)) { seg.cur = c; placed = true; break; }   // moving `seg` alone updates only its own occupancy
            }
            if (placed) break;
        }
    }

    // ---- apply: clone each displaced wire's pts once, shift its vertices, re-simplify ----
    const moved = new Map();   // key -> [{i0,i1,axis,off}]
    for (const s of segs) {
        const off = s.cur - s.coord;
        if (Math.abs(off) < 0.5) continue;
        (moved.get(s.key) || moved.set(s.key, []).get(s.key)).push({ i0: s.i0, i1: s.i1, axis: s.axis, off });
    }
    if (!moved.size) return routes;                            // nothing displaced — hand back the input untouched
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
    return out;
}
