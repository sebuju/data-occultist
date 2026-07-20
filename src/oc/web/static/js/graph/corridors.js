// corridors.js — bus-corridor detection (Phase 1 of the bus router).
//
// A "bus corridor" is a maximal node-free axis-aligned strip that runs in the gap between node
// clusters: a wire trunk can travel along it and lanes pack across its width. This module ONLY
// finds them; it draws nothing and knows nothing about the DOM. Later phases route wires onto them.
//
//   findCorridors(nodeRects, opts) -> [{ axis:'v'|'h', x, y, w, h, cap }]
//
//   axis 'v' = vertical corridor (tall; thickness is its x-extent, length is its y-extent)
//   axis 'h' = horizontal corridor (wide; thickness is its y-extent, length is its x-extent)
//   cap      = max lines it can hold = floor(thickness / laneGap)
//
// Method: slab decomposition of free space. Inflate every node by `margin` (keep-out). Cut the
// cross-axis at every inflated node edge into slabs; within a slab every node either spans it fully
// or misses it entirely (no edge lies interior), so the free runs along the long axis are just the
// gaps between the spanning nodes. Each free run is then extended across neighbouring slabs as far
// as a run still fully containing it exists — giving the maximal free strip and its true width.
//
// Blockers are NODES ONLY. Group boxes are soft (a bus may run through a group's whitespace) so they
// are not passed in and do not block.
//
// NOTE (CLAUDE.md rule 7): the retired corridor.js one-go router built an hOpen/vOpen open-channel *grid*; this
// module emits free *strips as rectangles* — a different abstraction for this phase. Kept separate
// deliberately; reconcile only if a later phase genuinely needs one shared free-space structure.

const EPS = 0.5;

// Merge a list of [lo,hi] intervals (sorted by lo) into disjoint covered spans.
function mergeIntervals(iv) {
    if (!iv.length) return [];
    iv.sort((a, b) => a[0] - b[0]);
    const out = [iv[0].slice()];
    for (let i = 1; i < iv.length; i++) {
        const cur = iv[i], last = out[out.length - 1];
        if (cur[0] <= last[1] + EPS) last[1] = Math.max(last[1], cur[1]);
        else out.push(cur.slice());
    }
    return out;
}

// Free gaps in [lo,hi] left uncovered by `covered` (disjoint, sorted spans).
function gaps(covered, lo, hi) {
    const out = [];
    let cursor = lo;
    for (const [c0, c1] of covered) {
        if (c1 <= lo || c0 >= hi) continue;
        if (c0 > cursor + EPS) out.push([cursor, Math.min(c0, hi)]);
        cursor = Math.max(cursor, c1);
        if (cursor >= hi) break;
    }
    if (cursor < hi - EPS) out.push([cursor, hi]);
    return out;
}

// Core: find maximal free strips in abstract (a = cross/thickness axis, b = long/length axis) space.
// rects here are {a0,a1,b0,b1} inflated. Returns [{a0,a1,b0,b1}] maximal free rectangles.
function stripsAB(rects) {
    if (!rects.length) return [];
    const bLo = Math.min(...rects.map(r => r.b0));
    const bHi = Math.max(...rects.map(r => r.b1));

    // slab boundaries along the cross axis = every unique inflated edge
    const edgeSet = new Set();
    for (const r of rects) { edgeSet.add(r.a0); edgeSet.add(r.a1); }
    const aEdges = [...edgeSet].sort((p, q) => p - q);
    if (aEdges.length < 2) return [];

    // per-slab free runs along b
    const slabs = [];
    for (let i = 0; i < aEdges.length - 1; i++) {
        const aL = aEdges[i], aR = aEdges[i + 1];
        if (aR - aL < EPS) continue;
        const mid = (aL + aR) / 2;
        const blocked = [];
        for (const r of rects) if (r.a0 <= mid && r.a1 >= mid) blocked.push([r.b0, r.b1]);
        const runs = gaps(mergeIntervals(blocked), bLo, bHi);
        slabs.push({ aL, aR, runs });
    }

    // extend each run across neighbouring slabs while a run still fully contains it. Extension
    // stops at a slab whose runs don't cover [t,b] — i.e. a node body walls the channel there.
    // Stopping at the first/last slab instead means the strip is open to the world edge on that
    // side (not walled by a node): flag it so callers can require "between nodes".
    const contains = (slab, t, b) => slab.runs.some(([rt, rb]) => rt <= t + EPS && rb >= b - EPS);
    const seen = new Set();
    const out = [];
    for (let i = 0; i < slabs.length; i++) {
        for (const [t, b] of slabs[i].runs) {
            let iL = i, iR = i;
            while (iR + 1 < slabs.length && contains(slabs[iR + 1], t, b)) iR++;
            while (iL - 1 >= 0 && contains(slabs[iL - 1], t, b)) iL--;
            const a0 = slabs[iL].aL, a1 = slabs[iR].aR;
            const key = `${Math.round(a0)}|${Math.round(a1)}|${Math.round(t)}|${Math.round(b)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ a0, a1, b0: t, b1: b, walled: iL > 0 && iR < slabs.length - 1 });
        }
    }
    return out;
}

// Drop strips fully contained by a wider-or-equal strip (removes nested duplicates from the
// per-run extension). O(n^2) on strip count — fine after the length/width filters upstream.
function dropContained(strips) {
    const keep = [];
    for (let i = 0; i < strips.length; i++) {
        const s = strips[i];
        let contained = false;
        for (let j = 0; j < strips.length; j++) {
            if (i === j) continue;
            const o = strips[j];
            const thicker = (o.a1 - o.a0) >= (s.a1 - s.a0) - EPS;
            const covers = o.a0 <= s.a0 + EPS && o.a1 >= s.a1 - EPS && o.b0 <= s.b0 + EPS && o.b1 >= s.b1 - EPS;
            const strictlyBigger = (o.a1 - o.a0) + (o.b1 - o.b0) > (s.a1 - s.a0) + (s.b1 - s.b0) + EPS;
            if (thicker && covers && (strictlyBigger || j < i)) { contained = true; break; }
        }
        if (!contained) keep.push(s);
    }
    return keep;
}

// c minus k as axis-aligned rectangles (0-4 pieces): the parts of c not covered by k.
function subtractRect(c, k) {
    const cx1 = c.x + c.w, cy1 = c.y + c.h, kx0 = k.x, ky0 = k.y, kx1 = k.x + k.w, ky1 = k.y + k.h;
    const ix0 = Math.max(c.x, kx0), iy0 = Math.max(c.y, ky0), ix1 = Math.min(cx1, kx1), iy1 = Math.min(cy1, ky1);
    if (ix0 >= ix1 - EPS || iy0 >= iy1 - EPS) return [c];    // no real overlap
    const out = [];
    if (c.y < iy0 - EPS) out.push({ x: c.x, y: c.y, w: c.w, h: iy0 - c.y });          // above the overlap
    if (iy1 < cy1 - EPS) out.push({ x: c.x, y: iy1, w: c.w, h: cy1 - iy1 });          // below
    if (c.x < ix0 - EPS) out.push({ x: c.x, y: iy0, w: ix0 - c.x, h: iy1 - iy0 });    // left (within overlap band)
    if (ix1 < cx1 - EPS) out.push({ x: ix1, y: iy0, w: cx1 - ix1, h: iy1 - iy0 });    // right
    return out;
}

// Enforce zero same-axis overlap by CLIPPING, not dropping. Process largest-first; subtract every
// already-kept corridor from the candidate and keep whatever non-overlapping pieces survive (still
// long/thick enough to be a channel). The kept set is pairwise non-overlapping, but a corridor that
// merely clips another is shortened rather than silently deleted, so coverage is preserved.
function suppressOverlaps(cor, laneGap, minLen, minAspect) {
    const area = (c) => c.w * c.h;
    const capOf = (thick) => Math.floor(thick / laneGap) + 1;
    const valid = (axis, w, h) => {
        const thick = axis === "v" ? w : h, len = axis === "v" ? h : w;
        return capOf(thick) >= 1 && len >= minLen && len >= thick * minAspect;
    };
    const order = [...cor].sort((a, b) => area(b) - area(a));
    const kept = [];
    for (const c of order) {
        let pieces = [{ x: c.x, y: c.y, w: c.w, h: c.h }];
        for (const k of kept) {
            pieces = pieces.flatMap((p) => subtractRect(p, k));
            if (!pieces.length) break;
        }
        for (const p of pieces) {
            if (!valid(c.axis, p.w, p.h)) continue;
            kept.push({ axis: c.axis, x: p.x, y: p.y, w: p.w, h: p.h, cap: capOf(c.axis === "v" ? p.w : p.h) });
        }
    }
    return kept;
}

/**
 * Find bus corridors over a node layout.
 * @param {Object<string,{x,y,w,h}>} nodeRects
 * @param {Object} [opts]
 * @param {number} [opts.margin=22]  keep-out halo inflated around every node
 * @param {number} [opts.laneGap=12] per-lane spacing; cap = floor(thickness / laneGap) + 1
 * @param {number} [opts.minLen=280] drop corridors shorter than this along their long axis
 * @returns {Array<{axis:'v'|'h', x:number, y:number, w:number, h:number, cap:number}>}
 */
export function findCorridors(nodeRects, opts = {}) {
    const { margin = 22, laneGap = 12, minLen = 280, minAspect = 4, smallCap = 3, tightGap = 6 } = opts;
    const rects = Object.values(nodeRects || {});
    if (!rects.length) return [];

    const inflate = (mapA) => rects.map(mapA);
    // lanes may ride the two edges of the channel, so N gaps hold N+1 lanes (fencepost). A SMALL-cap
    // corridor (a bottleneck) is packed tighter — its lanes use `tightGap` instead of `laneGap`, which
    // buys extra capacity; `extra` records how many lanes that tightening gained (shown as +N in the lab).
    const capSpec = (thick) => {
        const base = Math.floor(thick / laneGap) + 1;
        if (base <= smallCap) { const cap = Math.floor(thick / tightGap) + 1; return { cap, gap: tightGap, extra: cap - base }; }
        return { cap: base, gap: laneGap, extra: 0 };
    };

    // A corridor must be (a) walled by nodes on both cross sides — genuinely *between* nodes, not a
    // strip open to the empty world edge — and (b) at least `minAspect` times longer than it is thick,
    // so it reads as a channel, not a near-square plaza (which the transposed pass emits correctly).
    const keep = (s) => s.walled && (s.b1 - s.b0) >= (s.a1 - s.a0) * minAspect;

    // vertical corridors: cross axis = x (thickness), long axis = y (length)
    const vRects = inflate(r => ({ a0: r.x - margin, a1: r.x + r.w + margin, b0: r.y - margin, b1: r.y + r.h + margin }));
    let vCor = [];
    for (const s of dropContained(stripsAB(vRects))) {
        if (!keep(s)) continue;
        const thick = s.a1 - s.a0, len = s.b1 - s.b0, sp = capSpec(thick);
        if (sp.cap < 1 || len < minLen) continue;
        vCor.push({ axis: 'v', x: s.a0, y: s.b0, w: thick, h: len, cap: sp.cap, gap: sp.gap, capExtra: sp.extra });
    }

    // horizontal corridors: cross axis = y (thickness), long axis = x (length)
    const hRects = inflate(r => ({ a0: r.y - margin, a1: r.y + r.h + margin, b0: r.x - margin, b1: r.x + r.w + margin }));
    let hCor = [];
    for (const s of dropContained(stripsAB(hRects))) {
        if (!keep(s)) continue;
        const thick = s.a1 - s.a0, len = s.b1 - s.b0, sp = capSpec(thick);
        if (sp.cap < 1 || len < minLen) continue;
        hCor.push({ axis: 'h', x: s.b0, y: s.a0, w: len, h: thick, cap: sp.cap, gap: sp.gap, capExtra: sp.extra });
    }

    // overlap allowed: same-axis corridors may overlap — but a corridor almost entirely inside a
    // bigger same-axis one (a redundant near-duplicate) is dropped. `INSIDE` = fraction of the
    // smaller's area covered by the bigger to count as "inside".
    const INSIDE = 0.9;
    const areaIn = (c, k) => {
        const ix = Math.max(0, Math.min(c.x + c.w, k.x + k.w) - Math.max(c.x, k.x));
        const iy = Math.max(0, Math.min(c.y + c.h, k.y + k.h) - Math.max(c.y, k.y));
        return ix * iy;
    };
    const dropInside = (cs) => cs.filter((c, i) => {
        const ac = c.w * c.h;
        return !cs.some((k, j) => j !== i && (k.w * k.h > ac + EPS || (Math.abs(k.w * k.h - ac) < EPS && j < i))
            && areaIn(c, k) / ac >= INSIDE);
    });
    return [...dropInside(vCor), ...dropInside(hCor)];
}
