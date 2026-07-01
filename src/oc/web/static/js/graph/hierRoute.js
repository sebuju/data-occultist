// hierRoute.js — hierarchical (per-group) orthogonal routing built on the ONE routing engine
// (route.js `routeGraph`). Instead of one global A* over the whole canvas, the graph is decomposed:
//
//   * OUTER pass — routes among the FREE nodes, with every group collapsed to a single opaque HARD box.
//     Outside lines never see a group's interior; they route around the box or terminate at its GATE.
//   * INNER pass (one per group) — routes among that group's MEMBERS only, obstacle set = those members.
//     A group's interior A* never sees anything outside it.
//
// A boundary-CROSSING edge is split at the gate (gates.js) into halves — one per pass — that both
// terminate at the SAME gate point (route.js gate terminals), then STITCHED back into one polyline. The
// result Map is identical in shape to `routeGraph`'s, so routing.js's cache/morph/flow all keep working.
//
// Wins: each pass is far smaller than the global one (sum of squares << the square of the sum), and a
// node move only dirties its own pass — the basis for the phase-2 per-pass cache (not yet wired).
import { routeGraph, simplify } from "./route.js";
import { classifyAndGate } from "./gates.js";

const boxNodeId = (gid) => "grp:" + gid;
const near = (a, b) => Math.abs(a[0] - b[0]) < 0.5 && Math.abs(a[1] - b[1]) < 0.5;

// ---- per-pass signature (cache key) ----------------------------------------------------------------
// A pass re-runs its A* only when its OWN inputs change: its node rects, its edge list (incl. gate
// points), its title bands, its out-ports, and the config. prevSides is deliberately EXCLUDED — it only
// breaks ties, so identical geometry yields the identical route and the cached result already reflects
// the last frame's stickiness. This is what makes an interior-only move re-route ONE group, not all.
const r0 = (n) => Math.round(n);
const gateSig = (g) => (g ? `${r0(g.pt[0])},${r0(g.pt[1])}${g.dir}${g.face}` : "");
function passSig(ns, es, bands, outPorts, cfg) {
    let s = `${cfg.clearance},${cfg.laneGap}#`;
    for (const n of ns) s += `${n.id}:${r0(n.x)},${r0(n.y)},${r0(n.w)},${r0(n.h)}:${(outPorts && outPorts.get(n.id)) || ""};`;
    s += "|";
    for (const e of es) s += `${e.key}~${e.from || ""}>${e.to || ""}~${e.pinSrc || ""}${e.port ? "P" : ""}${e.insetEnd || 0}${e.tether ? "T" : ""}~${gateSig(e.fromGate)}~${gateSig(e.toGate)};`;
    s += "|";
    for (const b of bands || []) s += `${r0(b.x0)},${r0(b.y0)},${r0(b.x1)},${r0(b.y1)};`;
    return s;
}
// concatenate piece polylines, dropping the duplicated shared gate vertex at each seam. Any missing
// piece (a sub-pass that failed to route it) collapses the whole edge to null so routing.js drops it.
function joinPts(...polys) {
    const out = [];
    for (const p of polys) {
        if (!p || !p.length) return null;
        const start = out.length && near(out[out.length - 1], p[0]) ? 1 : 0;
        for (let i = start; i < p.length; i++) out.push(p[i].slice());
    }
    return out.length >= 2 ? simplify(out) : null;
}

// hierRoute(nodes, groupBox, groupOf, edges, opts) -> { routes:Map(key->{pts,p1,d1,p2,d2}), faces }
//   nodes    : [{id,x,y,w,h}]                 every routable node
//   groupBox : Map(gid -> {x,y,w,h,bandH})    live box of every group that HAS one (boxless = free)
//   groupOf  : (id) -> gid|null
//   edges    : [{from,to,key,pinSrc,port,tether,insetEnd}]   same descriptors routing.js already builds
//   opts     : { prevSides, outPorts, titleBands, config, laneGap, prevFace }
export function hierRoute(nodes, groupBox, groupOf, edges, opts = {}) {
    const nodeRects = new Map(nodes.map((n) => [n.id, { x: n.x, y: n.y, w: n.w, h: n.h }]));
    const { outer, inner, crossings, faces } = classifyAndGate({ nodeRects, groupBox, groupOf, edges, laneGap: opts.laneGap, prevFace: opts.prevFace });
    const edgeOpt = new Map(edges.map((e) => [e.key, e]));

    // ---- per-pass node lists ----
    const outerNodes = [];                 // free nodes + one hard box-node per group
    const innerNodes = new Map();          // gid -> [member node]
    for (const [gid] of groupBox) innerNodes.set(gid, []);
    for (const n of nodes) { const g = groupOf(n.id); if (g && groupBox.has(g)) innerNodes.get(g).push(n); else outerNodes.push(n); }
    for (const [gid, b] of groupBox) outerNodes.push({ id: boxNodeId(gid), x: b.x, y: b.y, w: b.w, h: b.h });

    // ---- per-pass edge lists ----
    const outerEdges = [];
    const innerEdges = new Map();
    for (const [gid] of groupBox) innerEdges.set(gid, []);
    // a gate terminal for route.js: outward stub when this half is OUTSIDE the box, inward when INSIDE —
    // so both halves' stubs are collinear at the shared point and the stitched line runs straight through.
    const gateTerm = (g, role, pass) => ({ pt: g.pt.slice(), face: g.face, dir: pass === "inner" ? (role === "to" ? g.out : g.in) : (role === "to" ? g.in : g.out) });
    // a whole (unsplit) edge keeps all its decorations; a split PIECE keeps source decorations (pinSrc/
    // port) only on the half holding the real source, dest decorations (insetEnd) only on the half
    // holding the real dest, and never a tether flag (a split tether would fight fanFaceEnds' centring).
    const whole = (e) => { const o = edgeOpt.get(e.key) || {}; return { key: e.key, from: e.from, to: e.to, pinSrc: o.pinSrc || null, port: !!o.port, insetEnd: o.insetEnd || 0, tether: !!o.tether }; };
    const piece = (key, extra, keepSrc, keepDst) => { const o = edgeOpt.get(key) || {}; return { key, ...extra, pinSrc: keepSrc ? (o.pinSrc || null) : null, port: keepSrc ? !!o.port : false, insetEnd: keepDst ? (o.insetEnd || 0) : 0, tether: false }; };

    for (const e of outer) outerEdges.push(whole(e));
    for (const [gid, arr] of inner) for (const e of arr) innerEdges.get(gid).push(whole(e));
    for (const cr of crossings) {
        const fromG = cr.fromGid, toG = cr.toGid;
        if (fromG && toG) {                    // member(G1) -> member(G2): inner(G1) + outer + inner(G2)
            innerEdges.get(fromG).push(piece(cr.key, { from: cr.from, toGate: gateTerm(cr.fromGate, "to", "inner") }, true, false));
            outerEdges.push(piece(cr.key, { from: boxNodeId(fromG), to: boxNodeId(toG), fromGate: gateTerm(cr.fromGate, "from", "outer"), toGate: gateTerm(cr.toGate, "to", "outer") }, false, false));
            innerEdges.get(toG).push(piece(cr.key, { fromGate: gateTerm(cr.toGate, "from", "inner"), to: cr.to }, false, true));
        } else if (toG) {                      // free -> member(G): outer(free->gate) + inner(gate->member)
            outerEdges.push(piece(cr.key, { from: cr.from, to: boxNodeId(toG), toGate: gateTerm(cr.toGate, "to", "outer") }, true, false));
            innerEdges.get(toG).push(piece(cr.key, { fromGate: gateTerm(cr.toGate, "from", "inner"), to: cr.to }, false, true));
        } else {                               // member(G) -> free: inner(member->gate) + outer(gate->free)
            innerEdges.get(fromG).push(piece(cr.key, { from: cr.from, toGate: gateTerm(cr.fromGate, "to", "inner") }, true, false));
            outerEdges.push(piece(cr.key, { from: boxNodeId(fromG), to: cr.to, fromGate: gateTerm(cr.fromGate, "from", "outer") }, false, true));
        }
    }

    // ---- run every pass, memoised on its sub-signature (groups=[] so boxes are HARD nodes) ----
    // Each pass reuses last frame's routed result when its own inputs are unchanged, so a move only
    // re-runs the pass(es) it actually touched. A fresh nextCache is built so passes for deleted groups
    // drop out; routing.js persists it back in for the next frame.
    const cache = opts.passCache instanceof Map ? opts.passCache : new Map();
    const nextCache = new Map();
    const cachedRun = (passKey, ns, es, bands) => {
        const sig = passSig(ns, es, bands, opts.outPorts, opts.config);
        const hit = cache.get(passKey);
        const res = hit && hit.sig === sig ? hit.res : routeGraph(ns, [], es, { prevSides: opts.prevSides, outPorts: opts.outPorts, titleBands: bands || [], config: opts.config });
        nextCache.set(passKey, { sig, res });
        return res;
    };
    const outerRes = cachedRun("outer", outerNodes, outerEdges, opts.titleBands);
    const innerRes = new Map();
    for (const [gid, ns] of innerNodes) {
        if (!ns.length) continue;
        // feed the group's OWN title band into its inner pass so interior lines steer around the heading
        // too (gates never sit on the top face, so no inner stub is forced to cross it — cf. gates.js).
        const b = groupBox.get(gid), band = b.bandH || 0;
        const bands = band > 0 ? [{ x0: b.x, y0: b.y, x1: b.x + b.w, y1: b.y + band }] : [];
        innerRes.set(gid, cachedRun("inner:" + gid, ns, innerEdges.get(gid), bands));
    }

    // ---- stitch ----
    const routes = new Map();
    const inRes = (gid, key) => { const m = innerRes.get(gid); return m ? m.get(key) : null; };
    for (const e of outer) { const r = outerRes.get(e.key); if (r) routes.set(e.key, r); }
    for (const [gid, arr] of inner) for (const e of arr) { const r = inRes(gid, e.key); if (r) routes.set(e.key, r); }
    for (const cr of crossings) {
        const oR = outerRes.get(cr.key);
        let pts, d1, d2;
        if (cr.fromGid && cr.toGid) {
            const iA = inRes(cr.fromGid, cr.key), iB = inRes(cr.toGid, cr.key);
            pts = iA && oR && iB ? joinPts(iA.pts, oR.pts, iB.pts) : null;
            d1 = iA && iA.d1; d2 = iB && iB.d2;
        } else if (cr.toGid) {
            const iB = inRes(cr.toGid, cr.key);
            pts = oR && iB ? joinPts(oR.pts, iB.pts) : null;
            d1 = oR && oR.d1; d2 = iB && iB.d2;
        } else {
            const iA = inRes(cr.fromGid, cr.key);
            pts = iA && oR ? joinPts(iA.pts, oR.pts) : null;
            d1 = iA && iA.d1; d2 = oR && oR.d2;
        }
        if (pts) routes.set(cr.key, { pts, p1: pts[0].slice(), d1: d1 || "R", p2: pts[pts.length - 1].slice(), d2: d2 || "L" });
    }
    return { routes, faces, passCache: nextCache };
}
