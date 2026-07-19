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
    faceBias: 260,   // soft preference for the face pointing AT the other endpoint: a face is charged
                                      // up to this (px-equiv) when its normal points fully AWAY, 0 when it points
                                      // straight at the target. Competes with length+bends, so a genuinely
                                      // blocked near face still yields, but a clear wrong-way face loses.
};
const PORT_MIN = 12;     // hard floor between fanned out-port dots on one face (dot is 8px) — no overlap
const PORT_END_KEEP = 18;// min distance a fanned endpoint stays off a node corner (> corner radius 14) so
                         // the rounded bend can't swallow the stub; guarded on short faces (see kClamp)

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
        // directional face bias: charge each face by how much its outward normal points AWAY from the
        // other endpoint (0 = straight at it, C.faceBias = straight away), so A* prefers the face facing
        // the target unless obstacles make it genuinely costlier. `aFrom`/`aTo` are the endpoint anchors.
        const aFrom = anchor(ln.from, ln.fromGate), aTo = anchor(ln.to, ln.toGate);
        const faceAway = (face, from, to) => { const dx = to[0] - from[0], dy = to[1] - from[1], L = Math.hypot(dx, dy) || 1, n = faceOut[face]; return C.faceBias * (1 - (n[0] * dx + n[1] * dy) / L) / 2; };
        // hysteresis: non-previous faces cost a small stickiness bias, so the route keeps its face.
        for (const se of srcEntries) add(S0, { to: se.idx, d1: se.dir, d2: se.dir, corner: null, len: (prev && prev.d1 !== se.face ? C.faceStick : 0) + faceAway(se.face, aFrom, aTo), gset: EMPTY });
        for (const de of dstEntries) add(de.idx, { to: D0, d1: de.dir, d2: de.dir, corner: null, len: (prev && prev.d2 !== de.face ? C.faceStick : 0) + faceAway(de.face, aTo, aFrom), gset: EMPTY });
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
const WIDE_GAP_MULT = 3;   // cap on how far a widened (grid-stepped) lane gap can grow past C.laneGap
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
            const pref = Math.min(span - 2 * keep, (n - 1) * C.laneGap);
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
