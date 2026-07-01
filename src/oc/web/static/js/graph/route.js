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
};
const PORT_MIN = 12;     // hard floor between fanned out-port dots on one face (dot is 8px) — no overlap
const PORT_MARGIN = 12;  // keep the fan this far inside the face corners

const center = (r) => [r.x + r.w / 2, r.y + r.h / 2];
const faceOut = { L: [-1, 0], R: [1, 0], T: [0, -1], B: [0, 1] };
const DC = { N: 0, S: 1, E: 2, W: 3 };
const outDir = (s) => (faceOut[s][0] !== 0 ? (faceOut[s][0] > 0 ? "E" : "W") : (faceOut[s][1] > 0 ? "S" : "N"));
const inDirOf = (s) => (faceOut[s][0] !== 0 ? (faceOut[s][0] > 0 ? "W" : "E") : (faceOut[s][1] > 0 ? "N" : "S"));
const rev = (d) => (d === "N" ? "S" : d === "S" ? "N" : d === "E" ? "W" : "E");

// Shared empty group-set so the (very common) no-group edge doesn't allocate a Set per option.
// astar guards `e.gset && e.gset.size`, so an empty shared set is read-only-safe.
const EMPTY = new Set();
const mkSet = (a) => (a.length ? new Set(a) : EMPTY);

// `hb` = flat obstacle bounds {n, x0,y0,x1,y1} (typed arrays), prebuilt once per routeGraph call.
// Reading flats in the O(N^3) inner loop avoids object-property chasing and recomputing x+w / y+h
// on every iteration — same overlap test, identical result as the old per-rect-object scan.
function segHitsHard(ax, ay, bx, by, hb, eps) {
    eps = eps == null ? 1 : eps;
    const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx), y0 = Math.min(ay, by), y1 = Math.max(ay, by);
    const n = hb.n, rx0 = hb.x0, ry0 = hb.y0, rx1 = hb.x1, ry1 = hb.y1;
    for (let i = 0; i < n; i++) if (x1 > rx0[i] + eps && x0 < rx1[i] - eps && y1 > ry0[i] + eps && y0 < ry1[i] - eps) return true;
    return false;
}
function softList(ax, ay, bx, by, soft) {
    const out = []; const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx), y0 = Math.min(ay, by), y1 = Math.max(ay, by);
    for (let i = 0; i < soft.length; i++) { const g = soft[i]; if (x1 > g.x0 + 1 && x0 < g.x1 - 1 && y1 > g.y0 + 1 && y0 < g.y1 - 1) out.push(i); }
    return out;
}
// the 1-bend L (or straight) options A=(ax,ay)->B=(bx,by) that clear all hard rects
function edgeOpts(ax, ay, bx, by, hb, soft) {
    const out = [], len = Math.abs(ax - bx) + Math.abs(ay - by);
    if (len < 0.5) return out;
    const dh = bx > ax ? "E" : "W", dv = by > ay ? "S" : "N";
    if (Math.abs(ax - bx) < 0.5) { if (!segHitsHard(ax, ay, bx, by, hb)) out.push({ d1: dv, d2: dv, corner: null, len, gset: mkSet(softList(ax, ay, bx, by, soft)) }); return out; }
    if (Math.abs(ay - by) < 0.5) { if (!segHitsHard(ax, ay, bx, by, hb)) out.push({ d1: dh, d2: dh, corner: null, len, gset: mkSet(softList(ax, ay, bx, by, soft)) }); return out; }
    const c1 = [bx, ay];
    if (!segHitsHard(ax, ay, c1[0], c1[1], hb) && !segHitsHard(c1[0], c1[1], bx, by, hb))
        out.push({ d1: dh, d2: dv, corner: c1, len, gset: mkSet(softList(ax, ay, c1[0], c1[1], soft).concat(softList(c1[0], c1[1], bx, by, soft))) });
    const c2 = [ax, by];
    if (!segHitsHard(ax, ay, c2[0], c2[1], hb) && !segHitsHard(c2[0], c2[1], bx, by, hb))
        out.push({ d1: dv, d2: dh, corner: c2, len, gset: mkSet(softList(ax, ay, c2[0], c2[1], soft).concat(softList(c2[0], c2[1], bx, by, soft))) });
    return out;
}

// A* over waypoints, state = (node, entryDir); cost = length + bendCost*bends + group penalty.
// Returns the chain [{node, corner}] start->goal (corner = the L-bend used to reach that node).
function astar(WP, edgesOf, start, goal, ownGroups, softCost) {
    const sid = (n, d) => n * 5 + (d == null ? 4 : DC[d]);
    const h = (i) => Math.abs(WP[i][0] - WP[goal][0]) + Math.abs(WP[i][1] - WP[goal][1]);
    const dist = new Map(), prev = new Map();
    const pq = [[h(start), 0, start, null]];
    const push = (f, g, n, d) => { pq.push([f, g, n, d]); let k = pq.length - 1; while (k) { const p = (k - 1) >> 1; if (pq[p][0] <= pq[k][0]) break;[pq[p], pq[k]] = [pq[k], pq[p]]; k = p; } };
    const pop = () => { const t = pq[0], l = pq.pop(); if (pq.length) { pq[0] = l; let k = 0; for (; ;) { let a = 2 * k + 1, b = a + 1, m = k; if (a < pq.length && pq[a][0] < pq[m][0]) m = a; if (b < pq.length && pq[b][0] < pq[m][0]) m = b; if (m === k) break;[pq[m], pq[k]] = [pq[k], pq[m]]; k = m; } } return t; };
    dist.set(sid(start, null), 0);
    let best = -1;
    while (pq.length) {
        const [, g, n, d] = pop(); const cur = sid(n, d);
        if (g > (dist.get(cur) ?? 1e18)) continue;
        if (n === goal) { best = cur; break; }
        for (const e of edgesOf(n)) {
            let bends = (e.d1 !== e.d2 ? 1 : 0);
            if (d != null && e.d1 !== d) bends += 1;
            let pen = 0; if (e.gset && e.gset.size) for (const gi of e.gset) if (!ownGroups.has(gi)) pen += softCost[gi];
            const ng = g + e.len + C.bendCost * bends + pen, ns = sid(e.to, e.d2);
            if (ng < (dist.get(ns) ?? 1e18)) { dist.set(ns, ng); prev.set(ns, { id: cur, corner: e.corner }); push(ng + h(e.to), ng, e.to, e.d2); }
        }
    }
    if (best < 0) return null;
    const chain = []; let s = best;
    while (s !== undefined) { const p = prev.get(s); chain.push({ node: Math.floor(s / 5), corner: p ? p.corner : null }); s = p ? p.id : undefined; }
    chain.reverse();
    return chain;
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
    const HB = { n: RN, x0: rx0, y0: ry0, x1: rx1, y1: ry1 };

    // stage 1: base waypoints = inflated node corners + group box corners; 1-bend adjacency
    const WP = [];
    for (const r of rects) { WP.push([r.x - m, r.y - m], [r.x + r.w + m, r.y - m], [r.x - m, r.y + r.h + m], [r.x + r.w + m, r.y + r.h + m]); }
    for (const g of soft) { WP.push([g.x0 - m, g.y0 - m], [g.x1 + m, g.y0 - m], [g.x0 - m, g.y1 + m], [g.x1 + m, g.y1 + m]); }
    const baseN = WP.length;
    const baseAdj = Array.from({ length: baseN }, () => []);
    for (let i = 0; i < baseN; i++) for (let j = i + 1; j < baseN; j++) {
        const A = WP[i], B = WP[j];
        for (const e of edgeOpts(A[0], A[1], B[0], B[1], HB, soft)) {
            baseAdj[i].push({ to: j, d1: e.d1, d2: e.d2, corner: e.corner, len: e.len, gset: e.gset });
            baseAdj[j].push({ to: i, d1: rev(e.d2), d2: rev(e.d1), corner: e.corner, len: e.len, gset: e.gset });
        }
    }

    // precompute each node's 4 face-port edges to the base waypoints (perpendicular-forced)
    const FACES = ["L", "R", "T", "B"], EMPTY = new Set();
    const faceCenter = (n, f) => { const c = center(n); return f === "L" ? [n.x, c[1]] : f === "R" ? [n.x + n.w, c[1]] : f === "T" ? [c[0], n.y] : [c[0], n.y + n.h]; };
    const portPos = new Map(), portEdges = new Map();
    for (const n of nodes) {
        const pp = {}, pe = {};
        for (const f of FACES) {
            const sp = faceCenter(n, f); pp[f] = sp; const od = outDir(f), list = [];
            for (let i = 0; i < baseN; i++) { const W = WP[i]; for (const e of edgeOpts(sp[0], sp[1], W[0], W[1], HB, soft)) if (e.d1 === od) list.push({ to: i, d1: e.d1, d2: e.d2, corner: e.corner, len: e.len, gset: e.gset }); }
            pe[f] = list;
        }
        portPos.set(n.id, pp); portEdges.set(n.id, pe);
    }

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
    for (const ln of lines) {
        const base0 = WP.length;
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
        const overlay = new Map(); const add = (from, e) => { if (!overlay.has(from)) overlay.set(from, []); overlay.get(from).push(e); };
        // hysteresis: non-previous faces cost a small stickiness bias, so the route keeps its face.
        for (const se of srcEntries) add(S0, { to: se.idx, d1: se.dir, d2: se.dir, corner: null, len: prev && prev.d1 !== se.face ? C.faceStick : 0, gset: EMPTY });
        for (const de of dstEntries) add(de.idx, { to: D0, d1: de.dir, d2: de.dir, corner: null, len: prev && prev.d2 !== de.face ? C.faceStick : 0, gset: EMPTY });
        // entries -> base visibility graph (node faces reuse the precompute; a gate scans the base once)
        for (const se of srcEntries) {
            if (se.pe) { for (const e of se.pe) add(se.idx, e); }
            else for (let i = 0; i < baseN; i++) { const W = WP[i]; for (const e of edgeOpts(se.pt[0], se.pt[1], W[0], W[1], HB, soft)) if (e.d1 === se.dir) add(se.idx, { to: i, d1: e.d1, d2: e.d2, corner: e.corner, len: e.len, gset: e.gset }); }
        }
        for (const de of dstEntries) {
            if (de.pe) { for (const e of de.pe) add(e.to, { to: de.idx, d1: rev(e.d2), d2: rev(e.d1), corner: e.corner, len: e.len, gset: e.gset }); }
            else for (let i = 0; i < baseN; i++) { const W = WP[i]; for (const e of edgeOpts(W[0], W[1], de.pt[0], de.pt[1], HB, soft)) if (e.d2 === de.dir) add(i, { to: de.idx, d1: e.d1, d2: e.d2, corner: e.corner, len: e.len, gset: e.gset }); }
        }
        // direct entry -> entry (short lines that never touch the base graph)
        for (const se of srcEntries) for (const de of dstEntries) for (const e of edgeOpts(se.pt[0], se.pt[1], de.pt[0], de.pt[1], HB, soft)) if (e.d1 === se.dir && e.d2 === de.dir) add(se.idx, { to: de.idx, d1: e.d1, d2: e.d2, corner: e.corner, len: e.len, gset: e.gset });
        const edgesOf = (i) => (i < baseN ? (overlay.has(i) ? baseAdj[i].concat(overlay.get(i)) : baseAdj[i]) : (overlay.get(i) || []));
        const chain = astar(WP, edgesOf, S0, D0, own, softCost);
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
        WP.length = base0;
    }

    // stage 3: nudging — split shared corridors into nested lanes, centred in their alley
    nudge(lines, byId, rects, opts.outPorts || new Map(), bands);

    const out = new Map();
    for (const ln of lines) out.set(ln.key, { pts: ln.pts, p1: ln.pts[0].slice(), d1: ln.srcSide, p2: ln.pts[ln.pts.length - 1].slice(), d2: ln.dstSide });
    return out;
}

// Nudging: each connector is a chain of maximal H/V segments. Connectors sharing a corridor (same
// axis + coord, overlapping span) get distinct parallel lanes (V-seg => x-offset, H-seg => y-offset,
// so a vertex = base + its V-offset + its H-offset and orthogonality is preserved). Port stubs are
// segments too => connectors leaving one face fan out along it. Each lane band is shifted to stay
// within the free alley bounded by neighbouring nodes, so no lane spills across a node edge.
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
function nudge(lines, byId, rects, outPorts, bands) {
    // alley walls = node rects PLUS title bands: a lane shift must not push a wire across a heading
    // it was routed around. A band straddling the segment's coord gives no bound (already inside it,
    // which A* avoids); a band to one side clamps that side, keeping the lane out of the band.
    const walls = bands && bands.length ? rects.concat(bands) : rects;
    for (const ln of lines) { ln._V = ln.pts.map((p) => p.slice()); ln._dx = new Array(ln._V.length).fill(0); ln._dy = new Array(ln._V.length).fill(0); }
    const segs = [];
    for (const ln of lines) { const V = ln._V; for (let i = 0; i + 1 < V.length; i++) { const a = V[i], b = V[i + 1];
        if (Math.abs(a[0] - b[0]) < 0.5 && Math.abs(a[1] - b[1]) > 0.5) segs.push({ ln, axis: "V", coord: a[0], lo: Math.min(a[1], b[1]), hi: Math.max(a[1], b[1]), i0: i, i1: i + 1 });
        else if (Math.abs(a[1] - b[1]) < 0.5 && Math.abs(a[0] - b[0]) > 0.5) segs.push({ ln, axis: "H", coord: a[1], lo: Math.min(a[0], b[0]), hi: Math.max(a[0], b[0]), i0: i, i1: i + 1 });
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
    for (const bucket of buckets.values()) {
      if (bucket.length < 2) continue;
      for (const arr of clustersOf(bucket)) {
        if (arr.length < 2) continue;
        arr.sort((a, b) => through(a) - through(b) || a.lo - b.lo);
        const trackEnd = [];
        for (const s of arr) { let tr = 0; while (tr < trackEnd.length && trackEnd[tr] > s.lo + 1) tr++; if (tr === trackEnd.length) trackEnd.push(-Infinity); s.tr = tr; trackEnd[tr] = s.hi; }
        const T = trackEnd.length; if (T < 2) continue;
        const g = C.laneGap, axis = arr[0].axis, coord = arr[0].coord;
        const minOff = (0 - (T - 1) / 2) * g, maxOff = ((T - 1) - (T - 1) / 2) * g;
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
        const clear = 5, aLo = lb + clear, aHi = rb - clear, minC = coord + minOff, maxC = coord + maxOff;
        let shift = 0;
        // Only clamp into the alley when it has real room. If walls leave aHi <= aLo (no alley — e.g.
        // a wall straddles both sides) the clamp math goes haywire and would fling the bundle far off,
        // ACROSS unrelated nodes. There, keep A*'s coord (shift 0) — A* already routed it obstacle-free.
        if (aHi > aLo) {
            if (maxC > aHi) shift = aHi - maxC;
            if (minC + shift < aLo) { const room = aHi - aLo, need = maxC - minC; shift = need <= room ? aLo - minC : (aLo + aHi) / 2 - (minC + maxC) / 2; }
        }
        for (const s of arr) {
            const off = (s.tr - (T - 1) / 2) * g + shift;
            if (axis === "V") { s.ln._dx[s.i0] += off; s.ln._dx[s.i1] += off; } else { s.ln._dy[s.i0] += off; s.ln._dy[s.i1] += off; }
        }
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
    for (const ln of lines) if (ln.insetEnd) {
        const p = ln._pts, i = p.length - 1, v = faceOut[ln.dstSide];
        if (i >= 1 && v) p[i] = [p[i][0] - v[0] * ln.insetEnd, p[i][1] - v[1] * ln.insetEnd];
    }
    for (const ln of lines) {
        let pts = simplify(ln._pts);
        if (pts.length === 2) pts = orthoElbow(pts[0], pts[1], ln.srcSide, ln.dstSide);   // never a diagonal
        ln.pts = pts;
    }
    // FINAL backstop: the lane shift can slide a segment 1-5px into a wall edge (its center-when-narrow
    // fallback overrides the alley clamp). A* never crosses, so any overlap here is nudge's doing —
    // push each offending INTERIOR segment back out to the wall's nearest edge (+MARG). Endpoints
    // (port stubs, i=0 / last) are left alone so a wire never detaches from its node face.
    if (walls.length) for (const ln of lines) evictSegments(ln.pts, walls, ln.tether, ln);
}
// Push interior axis-segments of `pts` out of any wall they sit inside, to the wall's nearer edge.
// Moving a segment's constant-axis coord shifts its two corner vertices only (neighbouring segments
// lengthen/shorten, staying orthogonal); the lane separation set by nudge is preserved.
function evictSegments(pts, walls, isTether, ln) {
    for (let i = 0; i + 1 < pts.length; i++) {   // EVERY segment, incl. the port stubs — a tiny shift just
        const a = pts[i], b = pts[i + 1];        // slides the port along its own face, it stays attached
        const firstSeg = i === 0, lastSeg = i + 1 === pts.length - 1;
        const isEnd = firstSeg || lastSeg;   // a port-stub: clamp its move so it can't run off-face
        if (isTether && isEnd) continue;   // a tether is centred on its face (fanFaceEnds) — don't let an evict re-corner its endpoints
        // a GATE stub must not move: its endpoint is pinned to the exact seam point shared with the other half.
        if (ln && ((firstSeg && ln.fromGate) || (lastSeg && ln.toGate))) continue;
        const vert = Math.abs(a[0] - b[0]) < 0.5 && Math.abs(a[1] - b[1]) > 0.5;
        const horiz = Math.abs(a[1] - b[1]) < 0.5 && Math.abs(a[0] - b[0]) > 0.5;
        if (!vert && !horiz) continue;
        const lo = vert ? Math.min(a[1], b[1]) : Math.min(a[0], b[0]);
        const hi = vert ? Math.max(a[1], b[1]) : Math.max(a[0], b[0]);
        const coord = vert ? a[0] : a[1];
        for (const r of walls) {
            const e0 = vert ? r.x : r.y, e1 = vert ? (r.x + r.w) : (r.y + r.h);
            const o0 = vert ? r.y : r.x, o1 = vert ? (r.y + r.h) : (r.x + r.w);
            if (hi <= o0 + 0.5 || lo >= o1 - 0.5) continue;          // segment span misses the wall
            if (coord <= e0 + 0.5 || coord >= e1 - 0.5) continue;    // segment already outside the wall
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
        const clamp = (c) => Math.max(lo + 4, Math.min(lo + span - 4, c));
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
        const pref = Math.min(span - PORT_MARGIN, (n - 1) * C.laneGap);
        const spread = Math.max(0, pref, (n - 1) * PORT_MIN);
        const coords = arr.map((_, i) => mid - spread / 2 + (i * spread) / (n - 1));
        for (let i = 0; i < n; i++) {
            let c = coords[i];
            if (reserveMid && Math.abs(c - mid) < PORT_MIN) c = mid + (c >= mid ? PORT_MIN : -PORT_MIN);
            setEnd(arr[i].ln._pts, side, clamp(c), arr[i].end === "dst");
        }
    }
}
// keep a fanned port endpoint within its node face span (perp coord already correct)
function clampEnds(pts, nd, side, last) {
    if (!nd || pts.length < 2) return;
    const i = last ? pts.length - 1 : 0, j = last ? pts.length - 2 : 1, M = 6;
    if (side === "T" || side === "B") { const x = Math.max(nd.x + M, Math.min(nd.x + nd.w - M, pts[i][0])); if (pts[j] && Math.abs(pts[j][0] - pts[i][0]) < 0.5) pts[j] = [x, pts[j][1]]; pts[i] = [x, pts[i][1]]; }
    else { const y = Math.max(nd.y + M, Math.min(nd.y + nd.h - M, pts[i][1])); if (pts[j] && Math.abs(pts[j][1] - pts[i][1]) < 0.5) pts[j] = [pts[j][0], y]; pts[i] = [pts[i][0], y]; }
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
