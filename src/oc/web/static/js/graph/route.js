// Orthogonal connector router for the node view, after libavoid (Wybrow/Marriott/Stuckey,
// "Orthogonal Connector Routing", GD 2009 + "Seeing Around Corners", 2014). The WHOLE graph
// is routed in one pass — three stages:
//   1. a gridless visibility graph whose waypoints are obstacle corners (inflated for clearance)
//      + per-node face ports; any two waypoints joinable by a single orthogonal L,
//   2. A* per connector minimising length + bends, choosing the src/dst FACE itself (a super-
//      source/sink over all four faces; perpendicular exit/entry forced), groups soft-avoided,
//   3. nudging — connectors that share a corridor split into nested parallel lanes (and ports
//      fan along a face) so no two wires overlap, lanes centred in their free alley.
//
// Obstacle dodging, side selection and bundling all fall out of the search + nudging — there are
// no per-side heuristics. `routeGraph(nodes, groups, edges, opts)` returns a Map(key -> {pts,
// p1,d1,p2,d2}); the caller renders pts and anchors its port dots at p1/p2.
//
// Drag stability: opts.prevSides keeps each connector on its last-frame faces unless another face
// is genuinely cheaper (a small stickiness bias), so a tiny node move can't flip a route's whole
// shape across a cost-equality threshold.

import { FACE_OUT, insetEndpoint } from "./faces.js";

const C = {
    clearance: 22,   // routing margin around each node => gutter width for waypoints
    bendCost: 70,    // penalty per 90-degree bend (vs 1 unit of length)
    groupCross: 240, // soft penalty per group box a segment passes through (not its own)
    headCross: 1e6,  // soft penalty per group TITLE band crossed — so heavy that ANY detour, however
                                      // long, beats crossing; a band is crossed only when a node is truly
                                      // boxed in (no path exists) and nothing else can route it
    headBand: 46,    // height (px) of a group's FULL colored title banner (CSS .ggroup-title:
                                      // padding 9*2 + ~24 line for --fs-xl 20px), added as its own soft rect so
                                      // wires bias off the whole banner — not just the text (0 disables)
    laneGap: 12,     // separation between bundled parallel wires
    faceStick: 50,   // bias to keep a connector's previous face (hysteresis) — < bendCost, so a
                                      // clearly better route still switches, but ties/small margins don't flicker
    bench: false,    // console.log per-phase timings each routeGraph call (window.__route.bench=true; __reroute())
    occCong: 40,     // congestion penalty per line already occupying a corridor bucket a route would reuse
    occCell: 20,     // px width of a congestion corridor bucket (lines within this count as sharing a run)
    haloCost: 150,    // light soft penalty for skimming a node's halo (0 disables) — nudges lines to
                     // keep a little clearance off node walls so bundles don't pile against them
    nodeHalo: 30,    // px the halo extends past each node edge (the soft-avoid ring around the hard body)
    faceBias: 260,   // soft preference for the face pointing AT the other endpoint: a face is charged
                                      // up to this (px-equiv) when its normal points fully AWAY, 0 when it points
                                      // straight at the target. Competes with length+bends, so a genuinely
                                      // blocked near face still yields, but a clear wrong-way face loses.
};
const PORT_MIN = 12;     // hard floor between fanned out-port dots on one face (dot is 8px) — no overlap
const PORT_END_KEEP = 18;// min distance a fanned endpoint stays off a node corner (> corner radius 14) so
                         // the rounded bend can't swallow the stub; guarded on short faces (see kClamp)

const center = (r) => [r.x + r.w / 2, r.y + r.h / 2];
const DC = { N: 0, S: 1, E: 2, W: 3 };
const outDir = (s) => (FACE_OUT[s][0] !== 0 ? (FACE_OUT[s][0] > 0 ? "E" : "W") : (FACE_OUT[s][1] > 0 ? "S" : "N"));
const inDirOf = (s) => (FACE_OUT[s][0] !== 0 ? (FACE_OUT[s][0] > 0 ? "W" : "E") : (FACE_OUT[s][1] > 0 ? "N" : "S"));
const rev = (d) => (d === "N" ? "S" : d === "S" ? "N" : d === "E" ? "W" : "E");
// DC index of rev(d), by DC index of d — lets the hot loop compare directions as ints (see makeAStar).
const REVI = [DC.S, DC.N, DC.W, DC.E];

// ---- interned soft-crossing sets ---------------------------------------------
// Every edge carries the set of soft rects its segments cross. That used to be a real `Set` per
// edge — ~258k of them on the warframe fixture, ~129k distinct, averaging 5 members. But the SAME
// handful of crossing-sets recur over and over (all the edges threading one gap cross exactly the
// same halos), so they are interned: identical member lists share one immutable record.
//
// The record also caches `sum` — the total penalty for crossing everything in it. astar needs that on
// every expansion, and caching it on the shared record means it's computed once per DISTINCT set
// rather than once per edge. `sum` is lazy (-1 = not yet computed) because softCost isn't in scope
// here. Members are sorted and deduped so the key is canonical; astar only ever reads.
const EMPTY_IDS = new Int32Array(0);
const EMPTY_G = { n: 0, ids: EMPTY_IDS, sum: 0 };
// Scratch buffer the softList calls of one edgeOpts option append into — interning reads it and, on a
// hit (the overwhelmingly common case), copies nothing. Sized per pass in routeGraph.
let SCR = new Int32Array(512);
function internG(n, table) {
    if (!n) return EMPTY_G;
    if (n > 1) {   // insertion sort + dedupe in place: n averages ~5, so a comparator sort costs more
        for (let i = 1; i < n; i++) { const v = SCR[i]; let j = i - 1; while (j >= 0 && SCR[j] > v) { SCR[j + 1] = SCR[j]; j--; } SCR[j + 1] = v; }
        let w = 1;
        for (let i = 1; i < n; i++) if (SCR[i] !== SCR[i - 1]) SCR[w++] = SCR[i];
        n = w;
    }
    // key = the members packed straight into a string, one char each (soft indices are well under
    // 2^16). Cheaper to build than a join, and canonical because the members are sorted.
    const key = n === 1 ? SCR[0] : String.fromCharCode.apply(null, SCR.subarray(0, n));
    let g = table.get(key);
    if (!g) { g = { n, ids: SCR.slice(0, n), sum: -1 }; table.set(key, g); }
    return g;
}
const gHas = (g, v) => { const ids = g.ids; for (let i = 0; i < g.n; i++) if (ids[i] === v) return true; return false; };

// ---- band index over a rect set ---------------------------------------------
// segHitsHard/softList used to scan EVERY rect on EVERY candidate segment. edgeOpts emits up to 3
// segments per call and the whole router funnels through it (grid = 336k calls, ports = 672k, plus
// every astar expansion), so those two linear scans were the dominant cost of a route pass.
//
// Every segment tested here is AXIS-ALIGNED, so its bbox is degenerate on one axis: a horizontal
// segment can only hit rects straddling its single y, a vertical one rects straddling its single x.
// So index each rect set TWICE — into thin y-bands and thin x-bands — and let a query use whichever
// axis its bbox is thin on. That is one or two band lookups per query instead of a full scan.
// A 2-D cell grid does NOT work here: a canvas-wide horizontal run crosses every column, so it drags
// back the whole 256px band anyway.
//
// The band contents are a strict SUPERSET of what can match (built from raw rect bounds while the
// overlap test shrinks each rect by eps) and the SAME exact test then runs on every candidate, so
// results are identical to the full scan by construction — a lookup narrowing, not an approximation.
// Layout is CSR: `start[k]..start[k+1]` indexes into `items`.
const BAND = 64;   // px per band — ~2-4 entries per node-sized rect, 1-2 bands touched per query
function buildAxisBands(lo, hi, n) {
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < n; i++) { if (lo[i] < min) min = lo[i]; if (hi[i] > max) max = hi[i]; }
    const nb = Math.max(1, Math.min(8192, Math.floor((max - min) / BAND) + 1));
    const band = Math.max(BAND, (max - min) / nb);
    const bi = (v) => { const k = Math.floor((v - min) / band); return k < 0 ? 0 : k >= nb ? nb - 1 : k; };
    const start = new Int32Array(nb + 1);
    for (let i = 0; i < n; i++) { const a = bi(lo[i]), b = bi(hi[i]); for (let k = a; k <= b; k++) start[k + 1]++; }
    for (let k = 0; k < nb; k++) start[k + 1] += start[k];
    const items = new Int32Array(start[nb]), fill = start.slice(0, nb);
    for (let i = 0; i < n; i++) { const a = bi(lo[i]), b = bi(hi[i]); for (let k = a; k <= b; k++) items[fill[k]++] = i; }
    return { nb, band, bi, start, items };
}
function buildRectGrid(rx0, ry0, rx1, ry1, n) {
    if (!n) return null;
    return { x0: rx0, y0: ry0, x1: rx1, y1: ry1, byX: buildAxisBands(rx0, rx1, n), byY: buildAxisBands(ry0, ry1, n) };
}
// Pick the axis whose query range spans fewer bands, and return [index, firstBand, lastBand].
function pickBands(G, x0, x1, y0, y1) {
    const bx = G.byX, by = G.byY;
    const ax0 = bx.bi(x0), ax1 = bx.bi(x1), ay0 = by.bi(y0), ay1 = by.bi(y1);
    return (ax1 - ax0) <= (ay1 - ay0) ? [bx, ax0, ax1] : [by, ay0, ay1];
}

// `hb` = flat obstacle bounds {n, x0,y0,x1,y1} (typed arrays) + `hb.grid`, prebuilt once per
// routeGraph call. Reading flats in the hot loop avoids object-property chasing and recomputing
// x+w / y+h on every iteration. Falls back to the full scan when there is no index.
function segHitsHard(ax, ay, bx, by, hb, eps) {
    eps = eps == null ? 1 : eps;
    const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx), y0 = Math.min(ay, by), y1 = Math.max(ay, by);
    const rx0 = hb.x0, ry0 = hb.y0, rx1 = hb.x1, ry1 = hb.y1, G = hb.grid;
    if (!G) { const n = hb.n; for (let i = 0; i < n; i++) if (x1 > rx0[i] + eps && x0 < rx1[i] - eps && y1 > ry0[i] + eps && y0 < ry1[i] - eps) return true; return false; }
    const [B, b0, b1] = pickBands(G, x0, x1, y0, y1), st = B.start, it = B.items;
    for (let k = b0; k <= b1; k++) for (let p = st[k], q = st[k + 1]; p < q; p++) {
        const i = it[p];
        if (x1 > rx0[i] + eps && x0 < rx1[i] - eps && y1 > ry0[i] + eps && y0 < ry1[i] - eps) return true;
    }
    return false;
}
// Returns indices into `soft` of every penalty rect the segment crosses. A rect spanning several
// buckets can be reported twice — harmless, the caller always funnels the list through internG.
// `soft.grid` is the index (see buildRectGrid); its flats mirror soft[i].x0/y0/x1/y1.
// Appends the indices of every penalty rect the segment crosses into the shared SCR scratch, starting
// at `at`, and returns the new count. Writing into scratch rather than returning a fresh array keeps
// the hot path allocation-free — internG sorts/dedupes SCR in place and usually finds an existing
// record, so nothing is retained.
function softList(ax, ay, bx, by, soft, at) {
    const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx), y0 = Math.min(ay, by), y1 = Math.max(ay, by);
    const G = soft.grid;
    if (!G) { for (let i = 0; i < soft.length; i++) { const g = soft[i]; if (x1 > g.x0 + 1 && x0 < g.x1 - 1 && y1 > g.y0 + 1 && y0 < g.y1 - 1) SCR[at++] = i; } return at; }
    const sx0 = G.x0, sy0 = G.y0, sx1 = G.x1, sy1 = G.y1;
    const [B, b0, b1] = pickBands(G, x0, x1, y0, y1), st = B.start, it = B.items;
    for (let k = b0; k <= b1; k++) for (let p = st[k], q = st[k + 1]; p < q; p++) {
        const i = it[p];
        if (x1 > sx0[i] + 1 && x0 < sx1[i] - 1 && y1 > sy0[i] + 1 && y0 < sy1[i] - 1) SCR[at++] = i;
    }
    return at;
}
// the 1-bend L (or straight) options A=(ax,ay)->B=(bx,by) that clear all hard rects.
// `wantD1` (optional) = the only leave-direction the caller will keep. Every option's d1 follows from
// the geometry alone, BEFORE any obstacle test, so a caller that filters on d1 anyway (the face-port
// precompute, which forces a perpendicular exit, and the gate fallbacks) hands it in and the rejected
// variant costs nothing instead of a full segHitsHard + softList pair. Same options out either way.
function edgeOpts(ax, ay, bx, by, hb, soft, wantD1) {
    const out = [], len = Math.abs(ax - bx) + Math.abs(ay - by);
    if (len < 0.5) return out;
    const dh = bx > ax ? "E" : "W", dv = by > ay ? "S" : "N";
    const ih = DC[dh], iv = DC[dv];
    const gt = soft.intern;
    if (Math.abs(ax - bx) < 0.5) { if (wantD1 && wantD1 !== dv) return out; if (!segHitsHard(ax, ay, bx, by, hb)) out.push({ d1: dv, d2: dv, i1: iv, i2: iv, corner: null, len, gset: internG(softList(ax, ay, bx, by, soft, 0), gt) }); return out; }
    if (Math.abs(ay - by) < 0.5) { if (wantD1 && wantD1 !== dh) return out; if (!segHitsHard(ax, ay, bx, by, hb)) out.push({ d1: dh, d2: dh, i1: ih, i2: ih, corner: null, len, gset: internG(softList(ax, ay, bx, by, soft, 0), gt) }); return out; }
    if (!wantD1 || wantD1 === dh) {
        const c1 = [bx, ay];
        if (!segHitsHard(ax, ay, c1[0], c1[1], hb) && !segHitsHard(c1[0], c1[1], bx, by, hb))
            out.push({ d1: dh, d2: dv, i1: ih, i2: iv, corner: c1, len, gset: internG(softList(c1[0], c1[1], bx, by, soft, softList(ax, ay, c1[0], c1[1], soft, 0)), gt) });
    }
    if (!wantD1 || wantD1 === dv) {
        const c2 = [ax, by];
        if (!segHitsHard(ax, ay, c2[0], c2[1], hb) && !segHitsHard(c2[0], c2[1], bx, by, hb))
            out.push({ d1: dv, d2: dh, i1: iv, i2: ih, corner: c2, len, gset: internG(softList(c2[0], c2[1], bx, by, soft, softList(ax, ay, c2[0], c2[1], soft, 0)), gt) });
    }
    return out;
}

// A* over waypoints, state = (node, entryDir); cost = length + bendCost*bends + group penalty.
// Returns the chain [{node, corner}] start->goal (corner = the L-bend used to reach that node).
//
// Built ONCE per routeGraph pass (`makeAStar`) and re-run per connector, because every per-line
// allocation here is paid ~290 times over ~800 waypoints. The scratch state is therefore hoisted and
// reused: dist/prev live in typed arrays indexed by state id (a Map keyed on a small int was the
// single hottest thing in the profile), staleness is handled by a generation counter instead of
// clearing, and the binary heap is four flat parallel arrays instead of an array of [f,g,n,d] tuples.
//
// SEARCH SEMANTICS ARE UNCHANGED — same costs, same strict `<` relaxation, same heap comparisons and
// the same swap order, so ties break the same way and the chain returned is identical. This is purely
// how the search is stored.
//
// This heap deliberately does NOT use the shared minheap.js: it carries four payload lanes (f/g/node/
// dir) fused into the search, and swapping in a 1-lane heap would change how equal-f ties break in the
// live routing hot path. New searches (busroute.js) use minheap.js.
function makeAStar(WP, baseAdj, baseN, cap) {
    const SN = cap * 5;
    const dist = new Float64Array(SN), prevId = new Int32Array(SN), seen = new Int32Array(SN);
    const prevCorner = new Array(SN);
    let gen = 0;
    let hf = new Float64Array(2048), hg = new Float64Array(2048), hn = new Int32Array(2048), hd = new Int32Array(2048);
    let hlen = 0;
    const grow = () => {
        const g2 = (A, T) => { const b = new T(A.length * 2); b.set(A); return b; };
        hf = g2(hf, Float64Array); hg = g2(hg, Float64Array); hn = g2(hn, Int32Array); hd = g2(hd, Int32Array);
    };
    const swap = (a, b) => {
        let t = hf[a]; hf[a] = hf[b]; hf[b] = t;
        t = hg[a]; hg[a] = hg[b]; hg[b] = t;
        t = hn[a]; hn[a] = hn[b]; hn[b] = t;
        t = hd[a]; hd[a] = hd[b]; hd[b] = t;
    };
    // `d` is the entry direction as its DC index, 4 = none (start). Kept numeric end to end so the
    // hot loop never touches the "N"/"S"/"E"/"W" strings; edges carry DC-coded d1/d2 as e.i1/e.i2.
    return function search(overOf, start, goal, ownGroups, softCost, occCost) {
        gen++; hlen = 0;
        const gx = WP[goal][0], gy = WP[goal][1];
        const h = (i) => Math.abs(WP[i][0] - gx) + Math.abs(WP[i][1] - gy);
        const push = (f, g, n, d) => {
            if (hlen === hf.length) grow();
            let k = hlen++; hf[k] = f; hg[k] = g; hn[k] = n; hd[k] = d;
            while (k) { const p = (k - 1) >> 1; if (hf[p] <= hf[k]) break; swap(p, k); k = p; }
        };
        // own-group exemption: at most two groups (source's and dest's), so subtract their share from
        // a per-edge cached total instead of walking the whole gset on every expansion. softCost values
        // are integers, so the subtraction is exact — no float drift that could flip a `<` comparison.
        let own0 = -1, own1 = -1;
        for (const g of ownGroups) { if (own0 < 0) own0 = g; else own1 = g; }
        const s0 = start * 5 + 4;
        dist[s0] = 0; seen[s0] = gen; prevId[s0] = -1;
        push(h(start), 0, start, 4);
        let best = -1;
        while (hlen) {
            const g = hg[0], n = hn[0], d = hd[0];
            hlen--;
            if (hlen) {   // move the tail into the root and sift down (same comparisons as before)
                hf[0] = hf[hlen]; hg[0] = hg[hlen]; hn[0] = hn[hlen]; hd[0] = hd[hlen];
                let k = 0;
                for (; ;) { const a = 2 * k + 1, b = a + 1; let mi = k; if (a < hlen && hf[a] < hf[mi]) mi = a; if (b < hlen && hf[b] < hf[mi]) mi = b; if (mi === k) break; swap(mi, k); k = mi; }
            }
            const cur = n * 5 + d;
            if (g > (seen[cur] === gen ? dist[cur] : 1e18)) continue;
            if (n === goal) { best = cur; break; }
            // base adjacency then overlay — concatenating them allocated an array per expansion; the
            // two-list walk preserves that exact order, so equal-cost edges still resolve the same way.
            const bl = n < baseN ? baseAdj[n] : null, ol = overOf(n);
            for (let li = 0; li < 2; li++) {
                const list = li === 0 ? bl : ol;
                if (!list) continue;
                for (let ei = 0; ei < list.length; ei++) {
                    const e = list[ei];
                    let bends = (e.i1 !== e.i2 ? 1 : 0);
                    if (d !== 4 && e.i1 !== d) bends += 1;
                    const ns = e.to * 5 + e.i2, cap = seen[ns] === gen ? dist[ns] : 1e18;
                    // Penalties only ever ADD, so an edge that already loses on length+bends alone can
                    // never win — bail before the group/occupancy work rather than after. Same outcome,
                    // and in a graph this dense most expansions are exactly this case.
                    const lb = g + e.len + C.bendCost * bends;
                    if (lb >= cap) continue;
                    let pen = 0;
                    const gs = e.gset;
                    if (gs.n) {
                        let t = gs.sum;
                        if (t < 0) { t = 0; for (let z = 0; z < gs.n; z++) t += softCost[gs.ids[z]]; gs.sum = t; }
                        pen = t;
                        if (own0 >= 0 && gHas(gs, own0)) pen -= softCost[own0];
                        if (own1 >= 0 && gHas(gs, own1)) pen -= softCost[own1];
                    }
                    if (occCost) pen += occCost(n, e);   // congestion: steer AWAY from corridors earlier lines packed
                    const ng = lb + pen;
                    if (ng < cap) {
                        dist[ns] = ng; seen[ns] = gen; prevId[ns] = cur; prevCorner[ns] = e.corner;
                        push(ng + h(e.to), ng, e.to, e.i2);
                    }
                }
            }
        }
        if (best < 0) return null;
        const chain = [];
        for (let s = best; ;) { const p = prevId[s]; chain.push({ node: (s / 5) | 0, corner: p >= 0 ? prevCorner[s] : null }); if (p < 0) break; s = p; }
        chain.reverse();
        return chain;
    };
}

// A 2-point line whose ends don't share an axis renders as a DIAGONAL — but every edge is an
// orthogonal 90° route, so a diagonal stands out (the dotted tethers were the usual offenders: they
// centre BOTH ends on their face, and setEnd can't keep a 2-point line orthogonal). Replace it with
// an L (perpendicular faces) or Z (parallel faces) elbow derived from the src/dst face dirs, so it
// bends and arcs like the rest. Already-straight lines pass through untouched.
function orthoElbow(a, b, d1, d2) {
    if (Math.abs(a[0] - b[0]) < 0.5 || Math.abs(a[1] - b[1]) < 0.5) return [a, b];
    const vert = (d) => d === "T" || d === "B";
    if (vert(d1) === vert(d2)) {   // parallel faces -> Z bending on the shared (perpendicular) axis
        if (vert(d1)) { const my = (a[1] + b[1]) / 2; return [a, [a[0], my], [b[0], my], b]; }
        const mx = (a[0] + b[0]) / 2; return [a, [mx, a[1]], [mx, b[1]], b];
    }
    return vert(d1) ? [a, [a[0], b[1]], b] : [a, [b[0], a[1]], b];   // perpendicular -> single corner
}

export function simplify(pts) {
    const dd = [];
    for (const p of pts) { const l = dd[dd.length - 1]; if (l && Math.abs(l[0] - p[0]) < 0.5 && Math.abs(l[1] - p[1]) < 0.5) continue; dd.push(p); }
    if (dd.length < 3) return dd;
    const res = [dd[0]];
    for (let i = 1; i < dd.length - 1; i++) { const a = res[res.length - 1], b = dd[i], c = dd[i + 1]; const ch = Math.abs(a[1] - b[1]) < 0.5 && Math.abs(b[1] - c[1]) < 0.5; const cv = Math.abs(a[0] - b[0]) < 0.5 && Math.abs(b[0] - c[0]) < 0.5; if (!ch && !cv) res.push(b); }
    res.push(dd[dd.length - 1]);
    return res;
}

// ---- main: route the whole graph -------------------------------------------
// nodes:[{id,x,y,w,h}]  groups:[{members:[id...]}]  edges:[{from,to,key}]
// opts:{prevSides:Map(key->{d1,d2}), config}.  Returns Map(key -> {pts,p1,d1,p2,d2}).
export function routeGraph(nodes, groups, edges, opts = {}) {
    if (opts.config) Object.assign(C, opts.config);
    const bnow = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());
    const BM = C.bench ? { t0: bnow() } : null;   // per-phase benchmark marks
    const prevSides = opts.prevSides || null;
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const rects = nodes.map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h, id: n.id }));
    const m = C.clearance, PADG = 18;
    // soft[] holds avoid-with-penalty rects: one per group box, plus (when C.headBand>0) one per
    // group TITLE band — the top strip of its box — so wires stray off the heading. A group's OWN
    // lines are exempt from the BOX (own-group set below) but NOT from the heading: every line,
    // internal or foreign, pays headCross to cross any title band, so headings stay clear.
    //
    // Bands are HIGH-COST SOFT, never HARD. A member node sits BELOW its group's full-width band, so
    // hard-blocking the band would leave that node no escape: the router finds no path and drops to a
    // straight degenerate fallback (see stage 2) that ignores every obstacle and slices clean through
    // the banner. Heavy-soft instead makes the router detour around the heading whenever a path exists
    // and cross it (cleanly routed, not a degenerate cut) only when a node is genuinely boxed in.
    const soft = [], softCost = [], groupOfNode = new Map();   // softCost[i] = penalty to cross soft[i]
    const bands = [];   // title-band rects {x,y,w,h} — passed to nudge as alley walls so the lane shift
                        // can't push a wire (that A* routed AROUND a heading) back ACROSS it
    for (const grp of (groups || [])) {
        // Geometry: prefer the caller's REAL rendered box + title-band height (grp.box/grp.bandH);
        // the title banner occupies the top `bandH` of that box. Fall back to member bounds ± PADG
        // (standalone/test callers without box info) — there the band height is the C.headBand guess.
        let bx0, by0, bx1, by1, band;
        if (grp.box) {
            bx0 = grp.box.x; by0 = grp.box.y; bx1 = grp.box.x + grp.box.w; by1 = grp.box.y + grp.box.h;
            band = grp.bandH || 0;
        } else {
            let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, any = false;
            for (const id of grp.members) { const nd = byId.get(id); if (!nd) continue; any = true; x0 = Math.min(x0, nd.x); y0 = Math.min(y0, nd.y); x1 = Math.max(x1, nd.x + nd.w); y1 = Math.max(y1, nd.y + nd.h); }
            if (!any) continue;
            bx0 = x0 - PADG; by0 = y0 - PADG; bx1 = x1 + PADG; by1 = y1 + PADG; band = C.headBand;
        }
        const gi = soft.length;
        for (const id of grp.members) if (byId.has(id)) groupOfNode.set(id, gi);
        soft.push({ x0: bx0, y0: by0, x1: bx1, y1: by1 }); softCost.push(C.groupCross);
        if (C.headBand > 0 && band > 0) { soft.push({ x0: bx0, y0: by0, x1: bx1, y1: by0 + band }); softCost.push(C.headCross); bands.push({ x: bx0, y: by0, w: bx1 - bx0, h: band }); }
    }
    // extra title bands the caller computed itself (subgroup TOP bands, super-group BOTTOM label
    // band — each has its own position the box+bandH shorthand can't express). Same heavy-soft
    // treatment as a group heading (waypoints at the band corners let wires hug around it).
    for (const tb of (opts.titleBands || [])) { soft.push(tb); softCost.push(C.headCross); bands.push({ x: tb.x0, y: tb.y0, w: tb.x1 - tb.x0, h: tb.y1 - tb.y0 }); }
    // flat HARD obstacle bounds = node rects ONLY — title bands are soft (handled above), never hard,
    // so no member node is ever boxed in by its own heading. Hard-blocked by every segHitsHard.
    const RN = rects.length;
    const rx0 = new Float64Array(RN), ry0 = new Float64Array(RN), rx1 = new Float64Array(RN), ry1 = new Float64Array(RN);
    for (let i = 0; i < rects.length; i++) { const r = rects[i]; rx0[i] = r.x; ry0[i] = r.y; rx1[i] = r.x + r.w; ry1[i] = r.y + r.h; }
    const HB = { n: RN, x0: rx0, y0: ry0, x1: rx1, y1: ry1, grid: buildRectGrid(rx0, ry0, rx1, ry1, RN) };

    // stage 1: base waypoints = inflated node corners + group box corners; 1-bend adjacency
    const WP = [];
    for (const r of rects) { WP.push([r.x - m, r.y - m], [r.x + r.w + m, r.y - m], [r.x - m, r.y + r.h + m], [r.x + r.w + m, r.y + r.h + m]); }
    for (const g of soft) { WP.push([g.x0 - m, g.y0 - m], [g.x1 + m, g.y0 - m], [g.x0 - m, g.y1 + m], [g.x1 + m, g.y1 + m]); }
    // light soft HALO around every node (penalty-only — its corners aren't added as waypoints, the node's
    // own inflated corners already exist): a thin ring past each node so a segment skimming a node wall
    // pays a tiny cost and prefers a hair of clearance, letting bundles sit off the walls. Bodies stay HARD.
    if (C.haloCost > 0) for (const r of rects) { soft.push({ x0: r.x - C.nodeHalo, y0: r.y - C.nodeHalo, x1: r.x + r.w + C.nodeHalo, y1: r.y + r.h + C.nodeHalo }); softCost.push(C.haloCost); }
    // expose the soft-penalty rects (group boxes, title bands, node halos) for the lab overlay
    if (opts.softOut) for (let i = 0; i < soft.length; i++) opts.softOut.push({ x: soft[i].x0, y: soft[i].y0, w: soft[i].x1 - soft[i].x0, h: soft[i].y1 - soft[i].y0, cost: softCost[i] });
    // index the soft rects too — built LAST, after the halo push, so it covers the final set. Hung on
    // the array itself so every softList/edgeOpts call site picks it up without threading an argument.
    {
        const SN = soft.length, sx0 = new Float64Array(SN), sy0 = new Float64Array(SN), sx1 = new Float64Array(SN), sy1 = new Float64Array(SN);
        for (let i = 0; i < SN; i++) { const g = soft[i]; sx0[i] = g.x0; sy0[i] = g.y0; sx1[i] = g.x1; sy1[i] = g.y1; }
        soft.grid = buildRectGrid(sx0, sy0, sx1, sy1, SN);
        soft.intern = new Map();   // crossing-set intern table for this pass (see internG)
        // worst case one option touches every soft rect twice (both legs of the L)
        if (SCR.length < SN * 2 + 8) SCR = new Int32Array(SN * 2 + 8);
    }
    const baseN = WP.length;
    const baseAdj = Array.from({ length: baseN }, () => []);
    for (let i = 0; i < baseN; i++) for (let j = i + 1; j < baseN; j++) {
        const A = WP[i], B = WP[j];
        for (const e of edgeOpts(A[0], A[1], B[0], B[1], HB, soft)) {
            baseAdj[i].push({ to: j, d1: e.d1, d2: e.d2, i1: e.i1, i2: e.i2, corner: e.corner, len: e.len, gset: e.gset });
            baseAdj[j].push({ to: i, d1: rev(e.d2), d2: rev(e.d1), i1: REVI[e.i2], i2: REVI[e.i1], corner: e.corner, len: e.len, gset: e.gset });
        }
    }

    if (BM) BM.grid = bnow();
    // precompute each node's 4 face-port edges to the base waypoints (perpendicular-forced)
    const FACES = ["L", "R", "T", "B"];
    const faceCenter = (n, f) => { const c = center(n); return f === "L" ? [n.x, c[1]] : f === "R" ? [n.x + n.w, c[1]] : f === "T" ? [c[0], n.y] : [c[0], n.y + n.h]; };
    const portPos = new Map(), portEdges = new Map();
    for (const n of nodes) {
        const pp = {}, pe = {};
        for (const f of FACES) {
            const sp = faceCenter(n, f); pp[f] = sp; const od = outDir(f), list = [];
            for (let i = 0; i < baseN; i++) { const W = WP[i]; for (const e of edgeOpts(sp[0], sp[1], W[0], W[1], HB, soft, od)) list.push({ to: i, d1: e.d1, d2: e.d2, i1: e.i1, i2: e.i2, corner: e.corner, len: e.len, gset: e.gset }); }
            pe[f] = list;
        }
        portPos.set(n.id, pp); portEdges.set(n.id, pe);
    }
    if (BM) BM.ports = bnow();
    // One A* instance for the whole pass — its scratch arrays are sized for the base graph plus the
    // handful of per-line entry waypoints (S0 + <=4 src + <=4 dst + D0) and reused for every connector.
    const search = makeAStar(WP, baseAdj, baseN, baseN + 16);
    // Per-line overlay edges (entry ports -> base graph). A fresh Map of fresh arrays per connector
    // meant ~800 array allocations x ~290 lines of pure garbage, so the buckets are allocated once and
    // recycled: a generation stamp marks which are live this line, no clearing pass and no re-alloc.
    const OVN = baseN + 16, ovGen = new Int32Array(OVN), ovList = new Array(OVN);
    let ovg = 0;
    const add = (from, e) => {
        if (ovGen[from] !== ovg) { ovGen[from] = ovg; if (ovList[from]) ovList[from].length = 0; else ovList[from] = []; }
        ovList[from].push(e);
    };
    const overOf = (i) => (ovGen[i] === ovg ? ovList[i] : null);

    // stage 2: route each line. Each endpoint is a TERMINAL: either a real NODE (a super-source over
    // its 4 face ports, A* picks the face) or a fixed GATE ({pt,dir,face}) — a single forced-direction
    // port on a group-box surface. Gates are how hierarchical routing (hierRoute.js) funnels a group's
    // boundary-crossing lines through ONE fanned crossing point per face: the outer pass and the inner
    // pass each terminate their half of the line at the SAME gate pt, so the stitched line is seamless.
    const lines = [];
    for (const e of edges) {
        const okFrom = e.fromGate || byId.has(e.from), okTo = e.toGate || byId.has(e.to);
        if (okFrom && okTo) lines.push({ from: e.from, to: e.to, key: e.key, pinSrc: e.pinSrc || null, insetEnd: e.insetEnd || 0, tether: !!e.tether, port: !!e.port, fromGate: e.fromGate || null, toGate: e.toGate || null });
    }
    // super-source/sink anchor position for an endpoint (a node centre, or the gate point itself)
    const anchor = (id, gate) => (gate ? gate.pt : center(byId.get(id)));
    // Congestion: each committed line STAMPS its runs into a coarse occupancy grid; later lines pay
    // OCONG per already-used corridor bucket they'd traverse, so once a corridor fills up A* routes the
    // NEXT line a DIFFERENT way (a nearby empty channel) instead of packing another wire 2px alongside.
    const OCELL = C.occCell, OCONG = C.occCong;
    const occ = new Map();
    // Bucket id is an INT, not "H:12" — occCost runs on every A* expansion, and building a string key
    // there (then hashing it) was the second-hottest thing in the router. Axis goes in bit 0, the
    // rounded corridor index in the rest; same 1:1 bucket identity as the old string form.
    const NOB = -2147483648;   // "this segment isn't an axis-aligned run" sentinel
    const segBucket = (p, q) => (Math.abs(p[1] - q[1]) < 0.5 && Math.abs(p[0] - q[0]) > 0.5) ? (Math.round(p[1] / OCELL) * 2) : (Math.abs(p[0] - q[0]) < 0.5 && Math.abs(p[1] - q[1]) > 0.5) ? (Math.round(p[0] / OCELL) * 2 + 1) : NOB;
    // An edge's buckets follow from its geometry alone (the endpoints of a base edge never move, and a
    // per-line overlay edge is discarded with its line), so resolve them ONCE per edge and cache on it
    // — the occupancy COUNTS still change every time a line is stamped, only the lookup key is fixed.
    const occCost = (n, e) => {
        let b1 = e._b1;
        if (b1 === undefined) {
            const A = WP[n], B = WP[e.to];
            if (!A || !B) return 0;
            if (e.corner) { b1 = e._b1 = segBucket(A, e.corner); e._b2 = segBucket(e.corner, B); }
            else { b1 = e._b1 = segBucket(A, B); e._b2 = NOB; }
        }
        const b2 = e._b2;
        let c = 0;
        if (b1 !== NOB) c += occ.get(b1) || 0;
        if (b2 !== NOB) c += occ.get(b2) || 0;
        return c ? OCONG * c : 0;
    };
    const stamp = (pts) => { for (let i = 0; i + 1 < pts.length; i++) { const b = segBucket(pts[i], pts[i + 1]); if (b !== NOB) occ.set(b, (occ.get(b) || 0) + 1); } };
    // FACING lines: the two endpoint nodes' spans overlap on an axis, so their facing sides line up and a
    // direct connector is the natural route. These are excluded from the heavy crowd-avoidance — routed
    // LAST with plain A* (no congestion, they don't stamp/contribute occupancy) so they stay direct
    // instead of being shoved off their path. Overlaps among them are still fixed by deCollide afterwards.
    // FACING = the two nodes genuinely face each other with a CLEAR direct corridor between them (their
    // spans overlap on an axis AND no node sits in the gap) — a simple straight/L connector. NOT merely
    // span-aligned across the whole canvas (distant aligned nodes with a crowd between are NOT facing).
    const anyNodeIn = (x0, y0, x1, y1) => { for (let i = 0; i < RN; i++) if (rx1[i] > x0 + 1 && rx0[i] < x1 - 1 && ry1[i] > y0 + 1 && ry0[i] < y1 - 1) return true; return false; };
    // Returns the facing FACES {src,dst} when the two nodes truly face with a clear gap between (a direct
    // connector), else null. The sides are PINNED below so a facing line leaves/enters the facing faces
    // and A* draws the straight/L directly, instead of the super-source picking odd sides and doglegging.
    const facingLine = (ln) => {
        if (ln.fromGate || ln.toGate) return null;
        const a = byId.get(ln.from), b = byId.get(ln.to); if (!a || !b) return null;
        if (a.y < b.y + b.h && b.y < a.y + a.h) {   // y overlap -> horizontally facing? straight line at coord y
            const yo0 = Math.max(a.y, b.y), yo1 = Math.min(a.y + a.h, b.y + b.h), coord = (yo0 + yo1) / 2;
            if (a.x + a.w <= b.x && !anyNodeIn(a.x + a.w, yo0, b.x, yo1)) return { horiz: true, src: "R", dst: "L", p0: a.x + a.w, p1: b.x, coord, lo: yo0, hi: yo1 };
            if (b.x + b.w <= a.x && !anyNodeIn(b.x + b.w, yo0, a.x, yo1)) return { horiz: true, src: "L", dst: "R", p0: a.x, p1: b.x + b.w, coord, lo: yo0, hi: yo1 };
        }
        if (a.x < b.x + b.w && b.x < a.x + a.w) {   // x overlap -> vertically facing? straight line at coord x
            const xo0 = Math.max(a.x, b.x), xo1 = Math.min(a.x + a.w, b.x + b.w), coord = (xo0 + xo1) / 2;
            if (a.y + a.h <= b.y && !anyNodeIn(xo0, a.y + a.h, xo1, b.y)) return { horiz: false, src: "B", dst: "T", p0: a.y + a.h, p1: b.y, coord, lo: xo0, hi: xo1 };
            if (b.y + b.h <= a.y && !anyNodeIn(xo0, b.y + b.h, xo1, a.y)) return { horiz: false, src: "T", dst: "B", p0: a.y, p1: b.y + b.h, coord, lo: xo0, hi: xo1 };
        }
        return null;
    };
    for (const ln of lines) ln._facing = facingLine(ln);
    lines.sort((p, q) => (p._facing ? 1 : 0) - (q._facing ? 1 : 0));   // heavy (non-facing) first, facing last
    // FACING pre-pass: emit each facing line's direct straight connector NOW and STAMP it, so the heavy
    // lines (routed below, with congestion) see the facing lines' occupancy and steer clear of them.
    const emitFacing = (ln) => { const f = ln._facing; ln.pts = f.horiz ? [[f.p0, f.coord], [f.p1, f.coord]] : [[f.coord, f.p0], [f.coord, f.p1]]; ln.srcSide = f.src; ln.dstSide = f.dst; };
    for (const ln of lines) if (ln._facing) { emitFacing(ln); stamp(ln.pts); }
    if (BM) BM.facing = bnow();
    for (const ln of lines) {
        const base0 = WP.length;
        if (ln._facing) continue;   // already emitted + stamped in the facing pre-pass above
        const prev = prevSides && prevSides.get(ln.key);
        // Build the ENTRY waypoints for each end: [{idx, pt, dir, face, pe?}]. A node contributes its 4
        // face ports (pe = precomputed face->base edges); a gate contributes one point, exit/entry forced
        // to gate.dir. `dir` is the perpendicular direction of the stub touching that entry (out for the
        // source end, in for the dest end); for a gate hierRoute already baked the correct sense into dir.
        const S0 = WP.length; WP.push(anchor(ln.from, ln.fromGate).slice());
        const srcEntries = [];
        if (ln.fromGate) { const idx = WP.length; WP.push(ln.fromGate.pt.slice()); srcEntries.push({ idx, pt: ln.fromGate.pt, dir: ln.fromGate.dir, face: ln.fromGate.face }); }
        else { const pp = portPos.get(ln.from), pe = portEdges.get(ln.from); for (const f of (ln.pinSrc ? [ln.pinSrc] : FACES)) { const idx = WP.length; WP.push(pp[f].slice()); srcEntries.push({ idx, pt: pp[f], dir: outDir(f), face: f, pe: pe[f] }); } }
        const dstEntries = [];
        if (ln.toGate) { const idx = WP.length; WP.push(ln.toGate.pt.slice()); dstEntries.push({ idx, pt: ln.toGate.pt, dir: ln.toGate.dir, face: ln.toGate.face }); }
        else { const pp = portPos.get(ln.to), pe = portEdges.get(ln.to); for (const f of FACES) { const idx = WP.length; WP.push(pp[f].slice()); dstEntries.push({ idx, pt: pp[f], dir: inDirOf(f), face: f, pe: pe[f] }); } }
        const D0 = WP.length; WP.push(anchor(ln.to, ln.toGate).slice());
        const own = new Set(); const sg = ln.fromGate ? null : groupOfNode.get(ln.from), dg = ln.toGate ? null : groupOfNode.get(ln.to); if (sg != null) own.add(sg); if (dg != null) own.add(dg);
        ovg++;   // recycle the overlay buckets (see above) — everything stamped below is this line's
        // directional face bias: charge each face by how much its outward normal points AWAY from the
        // other endpoint (0 = straight at it, C.faceBias = straight away), so A* prefers the face facing
        // the target unless obstacles make it genuinely costlier. `aFrom`/`aTo` are the endpoint anchors.
        const aFrom = anchor(ln.from, ln.fromGate), aTo = anchor(ln.to, ln.toGate);
        const faceAway = (face, from, to) => { const dx = to[0] - from[0], dy = to[1] - from[1], L = Math.hypot(dx, dy) || 1, n = FACE_OUT[face]; return C.faceBias * (1 - (n[0] * dx + n[1] * dy) / L) / 2; };
        // hysteresis: non-previous faces cost a small stickiness bias, so the route keeps its face.
        for (const se of srcEntries) add(S0, { to: se.idx, d1: se.dir, d2: se.dir, i1: DC[se.dir], i2: DC[se.dir], corner: null, len: (prev && prev.d1 !== se.face ? C.faceStick : 0) + faceAway(se.face, aFrom, aTo), gset: EMPTY_G });
        for (const de of dstEntries) add(de.idx, { to: D0, d1: de.dir, d2: de.dir, i1: DC[de.dir], i2: DC[de.dir], corner: null, len: (prev && prev.d2 !== de.face ? C.faceStick : 0) + faceAway(de.face, aTo, aFrom), gset: EMPTY_G });
        // entries -> base visibility graph (node faces reuse the precompute; a gate scans the base once)
        for (const se of srcEntries) {
            if (se.pe) { for (const e of se.pe) add(se.idx, e); }
            else for (let i = 0; i < baseN; i++) { const W = WP[i]; for (const e of edgeOpts(se.pt[0], se.pt[1], W[0], W[1], HB, soft, se.dir)) add(se.idx, { to: i, d1: e.d1, d2: e.d2, i1: e.i1, i2: e.i2, corner: e.corner, len: e.len, gset: e.gset }); }
        }
        for (const de of dstEntries) {
            if (de.pe) { for (const e of de.pe) add(e.to, { to: de.idx, d1: rev(e.d2), d2: rev(e.d1), i1: REVI[e.i2], i2: REVI[e.i1], corner: e.corner, len: e.len, gset: e.gset }); }
            else for (let i = 0; i < baseN; i++) { const W = WP[i]; for (const e of edgeOpts(W[0], W[1], de.pt[0], de.pt[1], HB, soft)) if (e.d2 === de.dir) add(i, { to: de.idx, d1: e.d1, d2: e.d2, i1: e.i1, i2: e.i2, corner: e.corner, len: e.len, gset: e.gset }); }
        }
        // direct entry -> entry (short lines that never touch the base graph)
        for (const se of srcEntries) for (const de of dstEntries) for (const e of edgeOpts(se.pt[0], se.pt[1], de.pt[0], de.pt[1], HB, soft, se.dir)) if (e.d2 === de.dir) add(se.idx, { to: de.idx, d1: e.d1, d2: e.d2, i1: e.i1, i2: e.i2, corner: e.corner, len: e.len, gset: e.gset });
        const chain = search(overOf, S0, D0, own, softCost, ln._facing ? null : occCost);
        if (chain && chain.length >= 3) {
            ln.srcSide = (srcEntries.find((se) => se.idx === chain[1].node) || srcEntries[0]).face;
            ln.dstSide = (dstEntries.find((de) => de.idx === chain[chain.length - 2].node) || dstEntries[0]).face;
            const pts = [];
            for (let c = 1; c < chain.length - 1; c++) { if (chain[c].corner) pts.push(chain[c].corner.slice()); pts.push(WP[chain[c].node].slice()); }
            ln.pts = simplify(pts);
        } else {
            // degenerate (an endpoint trapped inside an overlapping node): orthogonal Z, never a diagonal
            const sc = anchor(ln.from, ln.fromGate), dc = anchor(ln.to, ln.toGate), horiz = Math.abs(dc[0] - sc[0]) >= Math.abs(dc[1] - sc[1]);
            const mx = (sc[0] + dc[0]) / 2, my = (sc[1] + dc[1]) / 2;
            ln.pts = simplify(horiz ? [sc.slice(), [mx, sc[1]], [mx, dc[1]], dc.slice()] : [sc.slice(), [sc[0], my], [dc[0], my], dc.slice()]);
            ln.srcSide = ln.fromGate ? ln.fromGate.face : (ln.pinSrc || (horiz ? (dc[0] >= sc[0] ? "R" : "L") : (dc[1] >= sc[1] ? "B" : "T")));
            ln.dstSide = ln.toGate ? ln.toGate.face : (horiz ? (dc[0] >= sc[0] ? "L" : "R") : (dc[1] >= sc[1] ? "T" : "B"));
        }
        if (!ln._facing) stamp(ln.pts);   // heavy lines record their runs; facing lines contribute nothing
        WP.length = base0;
    }

    if (BM) BM.astar = bnow();
    // stage 3: nudging — split shared corridors into nested lanes, centred in their alley. FACING lines
    // are excluded — they're already the clean direct connector; deCollide alone fans coincident ones apart.
    nudge(lines.filter((l) => !l._facing), byId, rects, opts.outPorts || new Map(), bands);
    if (BM) { const e = bnow(); const nf = lines.filter((l) => l._facing).length; console.log(`[route] ${(e - BM.t0).toFixed(0)}ms total | grid ${(BM.grid - BM.t0).toFixed(0)} ports ${(BM.ports - BM.grid).toFixed(0)} facing ${(BM.facing - BM.ports).toFixed(0)} astar ${(BM.astar - BM.facing).toFixed(0)} nudge ${(e - BM.astar).toFixed(0)} | ${lines.length} lines (${nf} facing, ${lines.length - nf} heavy), ${nodes.length} nodes, ${WP.length} wp`); }

    const out = new Map();
    for (const ln of lines) out.set(ln.key, { pts: ln.pts, p1: ln.pts[0].slice(), d1: ln.srcSide, p2: ln.pts[ln.pts.length - 1].slice(), d2: ln.dstSide });
    return out;
}

// Nudging: each connector is a chain of maximal H/V segments. Connectors sharing a corridor (same
// axis + coord, overlapping span) get distinct parallel lanes (V-seg => x-offset, H-seg => y-offset,
// so a vertex = base + its V-offset + its H-offset and orthogonality is preserved). Port stubs are
// segments too => connectors leaving one face fan out along it. Each lane band is shifted to stay
// within the free alley bounded by neighbouring nodes, so no lane spills across a node edge.
//
// Each corridor used to pick its own lane order independently (sorted by each wire's far endpoint) —
// fine for one corridor alone, but where a BUNDLE turns together from one corridor into another, the
// two corridors' independently-chosen orders can disagree, and the bundle crosses itself right at the
// bend even though it nests cleanly along each straight run. `orderCorridors` below fixes this:
// corridors sharing a bend are reordered together (crossing-minimising adjacent swaps, seeded by the
// old per-corridor sort) so a bundle keeps ONE consistent nesting order through its turns.
// endpoint reference centre for a line end: a node centre, or a gate's fixed point (gate ends have no
// backing node, so byId.get() would be undefined). Used by nudge/fan wherever they'd read a node centre.
const endCenter = (ln, which, byId) => { const g = which === "from" ? ln.fromGate : ln.toGate; return g ? g.pt : center(byId.get(which === "from" ? ln.from : ln.to)); };
// force a gate endpoint back onto its exact gate point after nudging, carrying the collinear stub
// vertex so the stub stays orthogonal — keeps the two halves' seam exactly coincident for stitching.
function pinGate(pts, pt, last) {
    if (!pts || pts.length < 2) return;
    const i = last ? pts.length - 1 : 0, j = last ? pts.length - 2 : 1;
    if (pts.length > 2) { if (Math.abs(pts[j][0] - pts[i][0]) < 0.5) pts[j][0] = pt[0]; if (Math.abs(pts[j][1] - pts[i][1]) < 0.5) pts[j][1] = pt[1]; }
    pts[i][0] = pt[0]; pts[i][1] = pt[1];
}
const MARG = 1;   // px of clearance baked onto every nudge alley wall (node + band) so lanes never sit flush
const CORNER_CLEAR = 15;   // px a band/node eviction pushes a vertex PAST the edge: > the corner radius (14)
                           // so the rounded bend at the evicted vertex can never arc back across the edge
const FACE_SPREAD = 2.4;   // fan a same-source bundle this many lane-gaps apart on its node face (uses
                           // the face's spare width so a fat bundle reads clearly), capped to the face
const WIDE_GAP_MULT = 6;   // cap on how far a widened (grid-stepped) lane gap can grow past C.laneGap
                           // when an alley has spare room — keeps a loose group readably spaced without
                           // flinging tracks across a wide-open gutter
function nudge(lines, byId, rects, outPorts, bands) {
    // alley walls = node rects PLUS title bands: a lane shift must not push a wire across a heading
    // it was routed around. A band straddling the segment's coord gives no bound (already inside it,
    // which A* avoids); a band to one side clamps that side, keeping the lane out of the band.
    const walls = bands && bands.length ? rects.concat(bands) : rects;
    for (const ln of lines) { ln._V = ln.pts.map((p) => p.slice()); ln._dx = new Array(ln._V.length).fill(0); ln._dy = new Array(ln._V.length).fill(0); }
    const segs = [], lineSegs = new Map();   // lineSegs: ln -> its segs in path order (no gaps — every
                                              // consecutive vertex pair is exactly one H or V segment,
                                              // orthogonal invariant) — walked below to find where a wire
                                              // BENDS from one bundled corridor straight into another.
    for (const ln of lines) { const V = ln._V, arr = []; lineSegs.set(ln, arr);
        for (let i = 0; i + 1 < V.length; i++) { const a = V[i], b = V[i + 1]; let s = null;
            if (Math.abs(a[0] - b[0]) < 0.5 && Math.abs(a[1] - b[1]) > 0.5) s = { ln, axis: "V", coord: a[0], lo: Math.min(a[1], b[1]), hi: Math.max(a[1], b[1]), i0: i, i1: i + 1 };
            else if (Math.abs(a[1] - b[1]) < 0.5 && Math.abs(a[0] - b[0]) > 0.5) s = { ln, axis: "H", coord: a[1], lo: Math.min(a[0], b[0]), hi: Math.max(a[0], b[0]), i0: i, i1: i + 1 };
            if (s) { segs.push(s); arr.push(s); }
    } }
    const buckets = new Map();
    for (const s of segs) { const k = s.axis + ":" + Math.round(s.coord); if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(s); }
    const through = (s) => { const c0 = endCenter(s.ln, "from", byId), c1 = endCenter(s.ln, "to", byId); return s.axis === "V" ? (c0[0] + c1[0]) / 2 : (c0[1] + c1[1]) / 2; };
    // A coord-bucket can hold segments at the SAME axis-coord that live in vertically (or
    // horizontally) disjoint parts of the graph — different corridors that merely line up. Bundling
    // them as one lane group is wrong: their combined span reaches walls all over the canvas, which
    // yields a nonsensical (even inverted) alley and a wild lane shift that flings a segment across a
    // node it never touched. So first split each bucket into CLUSTERS of span-overlapping segments
    // (a real shared corridor) and lay each cluster out independently.
    const clustersOf = (arr) => {
        const byLo = arr.slice().sort((a, b) => a.lo - b.lo);
        const out = []; let cur = null, curHi = -Infinity;
        for (const s of byLo) {
            if (cur && s.lo > curHi + C.laneGap) { out.push(cur); cur = null; curHi = -Infinity; }   // gap > a lane → new corridor
            (cur || (cur = [])).push(s); curHi = Math.max(curHi, s.hi);
        }
        if (cur) out.push(cur);
        return out;
    };

    // ---- corridors: one per real shared run, seeded in the old through()-sorted order --------------
    const corridors = [];
    // A cluster of exactly ONE segment still becomes its own (single-track) corridor: a lone wire
    // crossing a gap gets the same alley-centering pass as a bundle (below), instead of being left
    // wherever A* happened to hug a border — see the centering step for why this needed T=1 too.
    for (const bucket of buckets.values()) {
        for (const arr of clustersOf(bucket)) {
            if (!arr.length) continue;
            arr.sort((a, b) => through(a) - through(b) || a.lo - b.lo);
            const corridor = { id: corridors.length, axis: arr[0].axis, coord: arr[0].coord, segs: arr };
            for (const s of arr) s.corridor = corridor;
            corridors.push(corridor);
        }
    }

    // ---- bends: every point a wire crosses from one BUNDLED corridor straight into another ---------
    // (two adjacent segments of the same wire that both landed in a corridor — a lone/unbundled side
    // has no order to keep consistent, so it's skipped). Grouped by the PAIR of corridors it bends
    // between: two wires only risk crossing each other at a bend where they share BOTH corridors.
    const pairGroups = new Map();
    for (const [, arr] of lineSegs) for (let k = 0; k + 1 < arr.length; k++) {
        const a = arr[k], b = arr[k + 1];
        if (!a.corridor || !b.corridor) continue;
        const key = a.corridor.id < b.corridor.id ? a.corridor.id + "," + b.corridor.id : b.corridor.id + "," + a.corridor.id;
        (pairGroups.get(key) || pairGroups.set(key, []).get(key)).push({ a, b });
    }
    for (const [key, group] of pairGroups) {
        const [ia, ib] = key.split(",").map(Number);
        (corridors[ia].touching || (corridors[ia].touching = [])).push(group);
        (corridors[ib].touching || (corridors[ib].touching = [])).push(group);
    }
    // live lane offset of a segment, read from its corridor's CURRENT order — reflects the latest
    // trial swap below, no separate bookkeeping needed.
    const laneOffset = (s) => { const c = s.corridor, T = c.segs.length; return (c.segs.indexOf(s) - (T - 1) / 2) * C.laneGap; };
    // the point a wire's bend sits at, from its two (V,H) corridor coords + their live lane offsets.
    const cornerOf = (bl) => {
        const v = bl.a.axis === "V" ? bl.a : bl.b, h = bl.a.axis === "H" ? bl.a : bl.b;
        return [v.corridor.coord + laneOffset(v), h.corridor.coord + laneOffset(h)];
    };
    // one endpoint of a segment's OTHER (non-corner) end, read straight from the pre-offset base
    // points — approximate (ignores any offset it might separately pick up as some earlier/later
    // bend's OWN corner), but only ever matters far from the corner under test, so it never flips
    // the local verdict. `isA` says whether this seg is the bend's entering half (corner = its i1,
    // so the far end is i0) or its exiting half (corner = its i0, far end i1).
    const farOf = (seg, isA, axisIdx) => seg.ln._V[isA ? seg.i0 : seg.i1][axisIdx];
    // does wire bl1's bend cross wire bl2's? Both pieces are axis-aligned (one V, one H per wire), so
    // "crosses" reduces to an exact interval test — does wire A's vertical run pass through wire B's
    // corner Y, AND wire B's horizontal run pass through wire A's corner X (or the symmetric case).
    // The CORNER end of each run is exact (from cornerOf, live offsets); the far end is the base-point
    // approximation above — mixing a base bound with a live corner on the SAME run would be wrong
    // (the live offset can push the corner past where the base far-bound sits, right where it matters
    // most), so each run's span is built from its own two consistent ends.
    const bendCrosses = (bl1, bl2) => {
        const c1 = cornerOf(bl1), c2 = cornerOf(bl2);
        const v1 = bl1.a.axis === "V" ? bl1.a : bl1.b, h1 = bl1.a.axis === "H" ? bl1.a : bl1.b;
        const v2 = bl2.a.axis === "V" ? bl2.a : bl2.b, h2 = bl2.a.axis === "H" ? bl2.a : bl2.b;
        const fy1 = farOf(v1, v1 === bl1.a, 1), fx1 = farOf(h1, h1 === bl1.a, 0);
        const fy2 = farOf(v2, v2 === bl2.a, 1), fx2 = farOf(h2, h2 === bl2.a, 0);
        const y1lo = Math.min(fy1, c1[1]), y1hi = Math.max(fy1, c1[1]), x1lo = Math.min(fx1, c1[0]), x1hi = Math.max(fx1, c1[0]);
        const y2lo = Math.min(fy2, c2[1]), y2hi = Math.max(fy2, c2[1]), x2lo = Math.min(fx2, c2[0]), x2hi = Math.max(fx2, c2[0]);
        const cross1 = y1lo <= c2[1] && c2[1] <= y1hi && x2lo <= c1[0] && c1[0] <= x2hi;
        const cross2 = y2lo <= c1[1] && c1[1] <= y2hi && x1lo <= c2[0] && c2[0] <= x1hi;
        return cross1 || cross2;
    };
    const groupCrossings = (group) => { let n = 0; for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) if (bendCrosses(group[i], group[j])) n++; return n; };
    const corridorCrossings = (c) => { let n = 0; for (const g of (c.touching || [])) n += groupCrossings(g); return n; };

    // ---- reorder: adjacent-transposition, accept only strict crossing reductions -------------------
    // Seeded by the through()-sort, so an already-clean bundle makes zero swaps and looks identical to
    // before; only a bundle whose corridors disagree on order gets reshuffled, and only until it stops
    // improving — monotonic, so this can only remove crossings, never introduce a worse-looking bundle.
    const active = corridors.filter((c) => c.touching && c.touching.length);
    // adjacent-transposition needs up to N passes to fully untangle a width-N bundle (worst case,
    // reverse order) — a flat cap starves wide bundles before they finish reordering. Scale to the
    // widest active corridor; cheap even when oversized, since a sweep with no accepted swap exits
    // the loop immediately (line below).
    let widest = 6; for (const c of active) if (c.segs.length > widest) widest = c.segs.length;
    const MAX_SWEEPS = widest;
    for (let sweep = 0; sweep < MAX_SWEEPS; sweep++) {
        let changed = false;
        for (const c of active) for (let i = 0; i + 1 < c.segs.length; i++) {
            const before = corridorCrossings(c);
            const t = c.segs[i]; c.segs[i] = c.segs[i + 1]; c.segs[i + 1] = t;
            if (corridorCrossings(c) < before) changed = true;
            else { const t2 = c.segs[i]; c.segs[i] = c.segs[i + 1]; c.segs[i + 1] = t2; }   // no gain: revert
        }
        if (!changed) break;
    }

    // per-track spacing: pack at the minimum laneGap, but widen (grid-stepped, capped) to use spare
    // alley room instead of always cramming tracks to the tightest possible width.
    const gridGap = (n, room) => { if (n < 2) return C.laneGap; const steps = Math.floor(room / (n - 1) / C.laneGap); return Math.min(C.laneGap * Math.max(1, steps), C.laneGap * WIDE_GAP_MULT); };
    const soloQueue = [];   // lone (T=1) walled-both-sides segments, resolved after the main loop (see below)
    for (const corridor of corridors) {
        const arr = corridor.segs;
        const trackEnd = [];
        if (corridor.touching && corridor.touching.length) {
            // order-preserving packing: a segment gets the smallest track that's both free (no active
            // occupant) AND above every currently-active segment it overlaps. Plain greedy first-fit can
            // still re-pack a later, "outer" segment onto an earlier, freed track — invisible on its
            // own (the freed segment is gone by then) but it silently reinverts the order the sweep
            // above just settled, against whichever OTHER still-active segment now sits above it.
            for (const s of arr) {
                let minTr = 0;
                for (let t = 0; t < trackEnd.length; t++) if (trackEnd[t] > s.lo + 1) minTr = t + 1;
                let tr = minTr; while (tr < trackEnd.length && trackEnd[tr] > s.lo + 1) tr++;
                if (tr === trackEnd.length) trackEnd.push(s.hi); else trackEnd[tr] = s.hi;
                s.tr = tr;
            }
        } else {
            // no downstream bend to protect — plain greedy keeps this bundle at its most compact width.
            for (const s of arr) { let tr = 0; while (tr < trackEnd.length && trackEnd[tr] > s.lo + 1) tr++; if (tr === trackEnd.length) trackEnd.push(-Infinity); s.tr = tr; trackEnd[tr] = s.hi; }
        }
        const T = trackEnd.length;
        const axis = corridor.axis, coord = corridor.coord;
        let lo = Infinity, hi = -Infinity; for (const s of arr) { lo = Math.min(lo, s.lo); hi = Math.max(hi, s.hi); }
        let lb = -Infinity, rb = Infinity;
        for (const nd of walls) {
            const ov = axis === "V" ? (nd.y < hi && nd.y + nd.h > lo) : (nd.x < hi && nd.x + nd.w > lo); if (!ov) continue;
            // +MARG inflates every wall by 1px so a lane keeps a hair of clearance and never sits flush.
            const near0 = (axis === "V" ? nd.x : nd.y) - MARG, near1 = (axis === "V" ? nd.x + nd.w : nd.y + nd.h) + MARG;
            if (near1 <= coord + 0.5) lb = Math.max(lb, near1);            // wall entirely on the low side
            else if (near0 >= coord - 0.5) rb = Math.min(rb, near0);       // wall entirely on the high side
            // STRADDLE: the wall spans this lane's coord, i.e. the segment is INSIDE it (a node it's
            // cutting through, or a band it's crossing). A side bound alone can't evict it, so push the
            // whole bundle out to the NEARER edge of the wall.
            else if (coord - near0 <= near1 - coord) rb = Math.min(rb, near0);
            else lb = Math.max(lb, near1);
        }
        const clear = 5, aLo = lb + clear, aHi = rb - clear;
        const bounded = Number.isFinite(lb) && Number.isFinite(rb) && aHi > aLo;
        // A lone (T=1) segment walled on both sides is NOT resolved here — a DIFFERENT lone segment
        // elsewhere (a different corridor entirely, since it never shared this one's raw coordinate)
        // can independently centre into this exact same alley, and nothing here would know to keep
        // them apart: both would land on the identical coordinate and render on top of each other.
        // Defer it to the cross-corridor merge pass below, which groups by alley + span-overlap first.
        if (T === 1 && bounded) { soloQueue.push({ seg: arr[0], axis, lo, hi, aLo, aHi, coord }); continue; }
        const g = bounded ? gridGap(T, aHi - aLo) : C.laneGap;
        const minOff = (0 - (T - 1) / 2) * g, maxOff = ((T - 1) - (T - 1) / 2) * g;
        const minC = coord + minOff, maxC = coord + maxOff;
        let shift = 0;
        // Only move into the alley when it has real room. If walls leave aHi <= aLo (no alley — e.g.
        // a wall straddles both sides) the math goes haywire and would fling the bundle far off,
        // ACROSS unrelated nodes. There, keep A*'s coord (shift 0) — A* already routed it obstacle-free.
        if (aHi > aLo) {
            if (bounded) {
                // walled on BOTH sides — a real gutter/gap. Centre the bundle in it rather than just
                // clamping overflow, so a bundle that already "fits" stops sitting wherever A* happened
                // to hug one border and instead runs down the middle of the gap.
                shift = (aLo + aHi) / 2 - (minC + maxC) / 2;
            } else {
                // one-sided (or open) — nothing to centre against, only pull back if spilling out.
                if (maxC > aHi) shift = aHi - maxC;
                if (minC + shift < aLo) { const room = aHi - aLo, need = maxC - minC; shift = need <= room ? aLo - minC : (aLo + aHi) / 2 - (minC + maxC) / 2; }
            }
        }
        for (const s of arr) {
            const off = (s.tr - (T - 1) / 2) * g + shift;
            if (axis === "V") { s.ln._dx[s.i0] += off; s.ln._dx[s.i1] += off; } else { s.ln._dy[s.i0] += off; s.ln._dy[s.i1] += off; }
        }
    }
    // ---- lone-wire centring: merge by shared alley, not by raw coordinate ---------------------------
    // Two lone wires crossing the SAME gap almost never share a raw A* coordinate (each hugged
    // whichever border its own gate happened to bend near), so they never became one corridor above —
    // yet both independently centre into the identical alley midpoint, landing on the exact same
    // coordinate (invisible, unfollowable overlap). Group by the alley itself (not the raw coord),
    // cluster by span overlap, and pack the group onto distinct grid-spaced tracks around its centre.
    {
        const byAlley = new Map();
        for (const q of soloQueue) { const k = q.axis + ":" + Math.round(q.aLo) + ":" + Math.round(q.aHi); (byAlley.get(k) || byAlley.set(k, []).get(k)).push(q); }
        for (const list of byAlley.values()) {
            const byLo = list.slice().sort((a, b) => a.lo - b.lo);
            let cur = [], curHi = -Infinity;
            const flush = () => {
                if (!cur.length) return;
                const n = cur.length, aLo = cur[0].aLo, aHi = cur[0].aHi, centre = (aLo + aHi) / 2;
                const g = gridGap(n, aHi - aLo);
                for (let i = 0; i < n; i++) {
                    const q = cur[i], off = (i - (n - 1) / 2) * g + (centre - q.coord);
                    if (q.axis === "V") { q.seg.ln._dx[q.seg.i0] += off; q.seg.ln._dx[q.seg.i1] += off; } else { q.seg.ln._dy[q.seg.i0] += off; q.seg.ln._dy[q.seg.i1] += off; }
                }
                cur = []; curHi = -Infinity;
            };
            for (const q of byLo) { if (cur.length && q.lo > curHi + C.laneGap) flush(); cur.push(q); curHi = Math.max(curHi, q.hi); }
            flush();
        }
    }
    for (const ln of lines) {
        const pts = ln._V.map((p, i) => [p[0] + ln._dx[i], p[1] + ln._dy[i]]);
        clampEnds(pts, byId.get(ln.from), ln.srcSide); clampEnds(pts, byId.get(ln.to), ln.dstSide, true);
        ln._pts = pts;   // hold before simplify so the port-fan pass can place each source stub
    }
    // every PORT-line endpoint (data/control lines on a port dot) is laid out on the face it touches —
    // BOTH the leaving end and the arriving end — fanned along that face so no two dots overlap.
    fanFaceEnds(lines, byId, outPorts);
    // GATE ends: nudging shifts every stub's coord by its lane offset, which would slide a gate endpoint
    // off its exact gate point and open a gap at the stitch seam. Re-pin them (fanFaceEnds already left
    // them alone) so both halves of a crossing line still meet at the identical point.
    for (const ln of lines) { if (ln.fromGate) pinGate(ln._pts, ln.fromGate.pt, false); if (ln.toGate) pinGate(ln._pts, ln.toGate.pt, true); }
    // pull a line's arriving end a few px INTO the node (along the face normal, so the last segment
    // just shortens and stays orthogonal) — lets an end marker rest halfway inside the edge.
    for (const ln of lines) if (ln.insetEnd) insetEndpoint(ln._pts, ln.dstSide, ln.insetEnd);
    for (const ln of lines) {
        let pts = simplify(ln._pts);
        if (pts.length === 2) pts = orthoElbow(pts[0], pts[1], ln.srcSide, ln.dstSide);   // never a diagonal
        ln.pts = pts;
    }
    // FINAL backstop: the lane shift can slide a segment 1-5px into a wall edge (its center-when-narrow
    // fallback overrides the alley clamp). A* never crosses, so any overlap here is nudge's doing —
    // push each offending INTERIOR segment back out to the wall's nearest edge (+MARG). Endpoints
    // (port stubs, i=0 / last) are left alone so a wire never detaches from its node face.
    if (walls.length) for (const ln of lines) evictSegments(ln.pts, walls, ln.tether, ln, byId);
}
// Push interior axis-segments of `pts` out of any wall they sit inside, to the wall's nearer edge.
// Moving a segment's constant-axis coord shifts its two corner vertices only (neighbouring segments
// lengthen/shorten, staying orthogonal); the lane separation set by nudge is preserved.
function evictSegments(pts, walls, isTether, ln, byId) {
    for (let i = 0; i + 1 < pts.length; i++) {   // EVERY segment, incl. the port stubs — a tiny shift just
        const a = pts[i], b = pts[i + 1];        // slides the port along its own face, it stays attached
        const firstSeg = i === 0, lastSeg = i + 1 === pts.length - 1;
        const isEnd = firstSeg || lastSeg;   // a port-stub: clamp its move so it can't run off-face
        // a GATE stub must not move: its endpoint is pinned to the exact seam point shared with the other half.
        if (ln && ((firstSeg && ln.fromGate) || (lastSeg && ln.toGate))) continue;
        const vert = Math.abs(a[0] - b[0]) < 0.5 && Math.abs(a[1] - b[1]) > 0.5;
        const horiz = Math.abs(a[1] - b[1]) < 0.5 && Math.abs(a[0] - b[0]) > 0.5;
        if (!vert && !horiz) continue;
        // A tether attaches at its face CENTRE, but fanFaceEnds can fan that endpoint to a coord whose
        // stub runs straight ACROSS a sibling node (grazing it) — and A* never sanctioned it. We can't
        // slide the stub freely (its dot must stay on the endpoint node's own face), so push it just off
        // the crossed node to that node's NEARER edge, then clamp back inside the endpoint node's face
        // span so the dot stays attached. If the clamp lands back inside the crossed node (face too
        // small to clear it) we leave the stub — detaching the wire is worse than the graze.
        const endNode = (isTether && isEnd && byId) ? byId.get(firstSeg ? ln.from : ln.to) : null;
        const lo = vert ? Math.min(a[1], b[1]) : Math.min(a[0], b[0]);
        const hi = vert ? Math.max(a[1], b[1]) : Math.max(a[0], b[0]);
        const coord = vert ? a[0] : a[1];
        for (const r of walls) {
            const e0 = vert ? r.x : r.y, e1 = vert ? (r.x + r.w) : (r.y + r.h);
            const o0 = vert ? r.y : r.x, o1 = vert ? (r.y + r.h) : (r.x + r.w);
            if (hi <= o0 + 0.5 || lo >= o1 - 0.5) continue;          // segment span misses the wall
            if (coord <= e0 + 0.5 || coord >= e1 - 0.5) {            // already outside (or flush with) the wall
                // GRAZING: an interior run sitting within MARG of an edge it runs alongside would render
                // flush against it — push it out to a full MARG clear. Port/gate stubs (isEnd) keep their
                // existing exemptions untouched; only a non-endpoint run gets nudged here.
                if (!isEnd) {
                    if (coord > e0 - MARG && coord <= e0 + 0.5) { const t = e0 - MARG; if (vert) { a[0] = t; b[0] = t; } else { a[1] = t; b[1] = t; } }
                    else if (coord < e1 + MARG && coord >= e1 - 0.5) { const t = e1 + MARG; if (vert) { a[0] = t; b[0] = t; } else { a[1] = t; b[1] = t; } }
                }
                continue;
            }
            if (isTether && isEnd) {
                if (!endNode) continue;   // no backing node face to clamp against (gate/free end) — leave it
                // nearer edge of the crossed node (minimal move off a graze), CORNER_CLEAR past it
                const t = (coord - e0) <= (e1 - coord) ? e0 - CORNER_CLEAR : e1 + CORNER_CLEAR;
                // clamp inside the endpoint node's face span (perp to the face = this segment's const axis)
                const fLo = vert ? endNode.x : endNode.y, fHi = vert ? (endNode.x + endNode.w) : (endNode.y + endNode.h);
                const ct = Math.max(fLo, Math.min(fHi, t));
                if (ct > e0 + 0.5 && ct < e1 - 0.5) continue;   // clamped back INSIDE the crossed node — can't clear without detaching
                if (vert) { a[0] = ct; b[0] = ct; } else { a[1] = ct; b[1] = ct; }
                continue;
            }
            // Push to the edge on the side the line's NEIGHBOURS sit — NOT the nearer edge. A line
            // arching over a node has both ends below the band; shoving its top run to the nearer
            // (top) edge would leave the two legs spanning the band. Following the neighbours sinks
            // the run to the bottom edge so the whole detour stays on one side, legs clear.
            const side = (j) => { if (j < 0 || j >= pts.length) return 0; const c = vert ? pts[j][0] : pts[j][1]; return c >= e1 ? 1 : (c <= e0 ? -1 : 0); };
            const lean = side(i - 1) + side(i + 2);
            // CORNER_CLEAR past the edge (> corner radius) so the rounded bend can't arc back over it.
            const toHigh = lean !== 0 ? lean > 0 : (coord - e0) > (e1 - coord);
            const target = toHigh ? e1 + CORNER_CLEAR : e0 - CORNER_CLEAR;
            if (isEnd && Math.abs(target - coord) > 14) continue;    // big move on a port stub would pull the dot off its face — leave it
            if (vert) { a[0] = target; b[0] = target; } else { a[1] = target; b[1] = target; }
        }
    }
}
// Lay out the endpoints of EVERY line along the face each touches: the source end where it LEAVES a
// node and the destination end where it ARRIVES. Per face, endpoints are ordered by where their far end
// sits (so stubs don't cross) and spread one laneGap apart, kept inside the face and floored at PORT_MIN
// so dots never overlap. A face with a SINGLE endpoint keeps its routed coordinate (port ends stay
// centred as before; structural ends are left exactly where routed) — only 2+ endpoints sharing a face
// redistribute. An idle out-port dot sits dead-centre of its face, so lines on that same face are kept
// clear of the centre.
function fanFaceEnds(lines, byId, outPorts) {
    const groups = new Map();   // "<node id>\x00<side>" -> endpoints touching that face
    const push = (nodeId, side, ln, end, other) => {
        const k = nodeId + "\x00" + side;
        (groups.get(k) || groups.set(k, []).get(k)).push({ ln, end, other });
    };
    for (const ln of lines) {
        // every line (port AND structural) registers both ends, so endpoints sharing a face
        // co-distribute and never collapse onto one point. A lone endpoint keeps its routed coord below.
        // GATE ends are skipped: they're pre-fanned by gates.js at a fixed point on a group-box face and
        // must not be redistributed onto a node face (they have no backing node here anyway).
        if (!ln.fromGate) push(ln.from, ln.srcSide, ln, "src", endCenter(ln, "to", byId));
        if (!ln.toGate) push(ln.to, ln.dstSide, ln, "dst", endCenter(ln, "from", byId));
    }
    for (const [k, arr] of groups) {
        const sep = k.indexOf("\x00"), nodeId = k.slice(0, sep), side = k.slice(sep + 1);
        const nd = byId.get(nodeId); if (!nd) continue;
        const horiz = side === "L" || side === "R";
        const lo = horiz ? nd.y : nd.x, span = horiz ? nd.h : nd.w, mid = lo + span / 2;
        arr.sort((a, b) => (horiz ? a.other[1] - b.other[1] : a.other[0] - b.other[0]));
        const n = arr.length;
        // keep endpoints off the rounded corners; shrink the inset on a short face so the band never inverts.
        const keep = Math.min(PORT_END_KEEP, Math.max(0, (span - PORT_MIN) / 2));
        const clamp = (c) => Math.max(lo + keep, Math.min(lo + span - keep, c));
        // a node with an idle out-port on THIS face parks a (non-endpoint) dot at the centre — keep lines
        // off it. A real PORT line leaving the face owns the dot (its own start); a structural src does not.
        const reserveMid = outPorts.get(nodeId) === side && !arr.some((e) => e.end === "src" && (e.ln.pinSrc || e.ln.port));
        if (n < 2) {
            // lone endpoint: port ends keep the canonical centred position; structural ends keep their
            // ROUTED coord (never force-centred). Either way, an end under an idle out-port dot is nudged clear.
            const e = arr[0], p = e.ln._pts; if (!p || p.length < 2) continue;
            const last = e.end === "dst", i = last ? p.length - 1 : 0;
            const cur = horiz ? p[i][1] : p[i][0];
            // a satellite tether attaches at the face CENTRE (both ends) — never let A* leave it at a corner
            let c = (e.ln.pinSrc || e.ln.port || e.ln.tether) ? mid : cur;
            if (reserveMid && Math.abs(c - mid) < PORT_MIN) c = mid + PORT_MIN;
            if (e.ln.pinSrc || e.ln.port || e.ln.tether || Math.abs(c - cur) > 0.5) setEnd(p, side, clamp(c), last);
            continue;
        }
        let coords;
        if (reserveMid) {
            // An idle out-port dot sits dead-centre of this face. Carve a PORT_MIN-wide gap around
            // mid and fan the (sorted) endpoints OUTWARD on either side of it, so none lands on the
            // dot — nor, when an endpoint would fall at mid, gets bumped straight onto its neighbour
            // (the old per-endpoint "+PORT_MIN" nudge did exactly that, stacking two lines on one coord).
            const step = Math.max(C.laneGap, PORT_MIN);
            const below = Math.ceil(n / 2);   // endpoints seated below the gap; the rest go above
            coords = arr.map((_, i) => i < below
                ? mid - PORT_MIN - (below - 1 - i) * step
                : mid + PORT_MIN + (i - below) * step);
        } else {
            // spread endpoints to use the FACE's spare room (up to FACE_SPREAD lane-gaps apart), not the
            // bare min — a fat same-source bundle then leaves its node visibly fanned instead of a
            // laneGap-tight ribbon you can't read. Still capped to the face span (minus the corner keep).
            const pref = Math.min(span - 2 * keep, (n - 1) * C.laneGap * FACE_SPREAD);
            const spread = Math.max(0, pref, (n - 1) * PORT_MIN);
            coords = arr.map((_, i) => mid - spread / 2 + (i * spread) / (n - 1));
        }
        for (let i = 0; i < n; i++) setEnd(arr[i].ln._pts, side, clamp(coords[i]), arr[i].end === "dst");
    }
}
// keep a fanned port endpoint within its node face span (perp coord already correct)
function clampEnds(pts, nd, side, last) {
    if (!nd || pts.length < 2) return;
    const i = last ? pts.length - 1 : 0, j = last ? pts.length - 2 : 1;
    // keep the endpoint off the rounded corners; shrink the inset on a short face so it never inverts.
    const keepFor = (span) => Math.min(PORT_END_KEEP, Math.max(0, (span - PORT_MIN) / 2));
    if (side === "T" || side === "B") { const M = keepFor(nd.w), x = Math.max(nd.x + M, Math.min(nd.x + nd.w - M, pts[i][0])); if (pts[j] && Math.abs(pts[j][0] - pts[i][0]) < 0.5) pts[j] = [x, pts[j][1]]; pts[i] = [x, pts[i][1]]; }
    else { const M = keepFor(nd.h), y = Math.max(nd.y + M, Math.min(nd.y + nd.h - M, pts[i][1])); if (pts[j] && Math.abs(pts[j][1] - pts[i][1]) < 0.5) pts[j] = [pts[j][0], y]; pts[i] = [pts[i][0], y]; }
}

// place a port-line endpoint at `coord` along its face (perp axis), carrying the collinear stub
// vertex with it so that segment stays orthogonal — the line meets its dot. `last` picks the END
// endpoint (arriving) instead of the START (leaving).
function setEnd(pts, side, coord, last) {
    if (pts.length < 2) return;
    const i = last ? pts.length - 1 : 0, j = last ? pts.length - 2 : 1;
    // carry the collinear stub vertex too — but ONLY when it's interior. On a 2-point (straight) line
    // the "neighbour" IS the opposite endpoint; dragging it would yank that dot off its own node when
    // both ends fan to different coords. There, just move this endpoint (the segment goes diagonal).
    const carry = pts.length > 2;
    if (side === "T" || side === "B") { if (carry && Math.abs(pts[j][0] - pts[i][0]) < 0.5) pts[j][0] = coord; pts[i][0] = coord; }
    else { if (carry && Math.abs(pts[j][1] - pts[i][1]) < 0.5) pts[j][1] = coord; pts[i][1] = coord; }
}

// ---- render: SVG path from a polyline (square or arc-rounded corners) ------
export function polylinePath(pts, corners = "curve", radius = 14) {
    if (!pts || pts.length < 2) return "";
    if (pts.length === 2 || corners === "square")
        return "M " + pts.map((p) => `${rnd(p[0])} ${rnd(p[1])}`).join(" L ");
    let d = `M ${rnd(pts[0][0])} ${rnd(pts[0][1])}`;
    for (let i = 1; i < pts.length - 1; i++) {
        const a = pts[i - 1], b = pts[i], c = pts[i + 1];
        const rad = Math.min(radius, len(a, b) / 2, len(b, c) / 2);
        const pin = toward(b, a, rad), pout = toward(b, c, rad);
        d += ` L ${rnd(pin[0])} ${rnd(pin[1])} Q ${rnd(b[0])} ${rnd(b[1])} ${rnd(pout[0])} ${rnd(pout[1])}`;
    }
    const e = pts[pts.length - 1];
    d += ` L ${rnd(e[0])} ${rnd(e[1])}`;
    return d;
}
const rnd = (n) => Math.round(n * 10) / 10;
const len = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
function toward(from, to, dist) { const l = len(from, to) || 1; return [from[0] + (to[0] - from[0]) * (dist / l), from[1] + (to[1] - from[1]) * (dist / l)]; }
