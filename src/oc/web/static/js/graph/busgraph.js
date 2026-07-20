// busgraph.js — the bus router behind the live router contract.
//
// routing.js speaks one shape:  (nodes, edges, opts) -> Map(key -> {pts,p1,d1,p2,d2}).  busRoute
// speaks node RECTS and its own link records, and it can legitimately leave a line unrouted. This
// adapter is the only place those two meet — busroute.js stays a pure geometry module with no idea
// the app exists, exactly like route.js.
//
// Three things busroute.js knows nothing about, handled here:
//   BLOCKS    group headings are soft-cost detours in route.js; busRoute has no soft costs, so each
//             heading goes in as an extra HARD obstacle. findCorridors sees the same rect list, so a
//             heading blocks the CORRIDOR CARVE as well as the wires — a channel is never cut across
//             a group title. Callers must pass every heading: each group's own title strip AND the
//             subgroup / super-group / ungated bands (routing.js `blockRects`).
//   FALLBACK  a line busRoute couldn't place would otherwise paint as a provisional elbow straight
//             through whatever is in the way. Instead the caller's `fallback` (routeGraph) supplies
//             those keys — a real orthogonal route, at the cost of one A* pass whenever any line
//             misses. Zero misses = zero cost.
//   INSET     watch/trigger caps sit ON the node edge, so their last point is pulled INTO the node
//             along its arrival face (`r.d2`) via the shared insetEndpoint (faces.js), same primitive
//             route.js uses at its own tail.
//
// deCollide runs ONLY when the fallback did. A pure bus pass needs none — every wire holds a lane
// span it reserved, so a lane shift could only move it off one — but a fallback line is routed blind
// to those lanes and can land on top of one.

import { findCorridors } from "./corridors.js";
import { busRoute } from "./busroute.js";
import { insetEndpoint } from "./faces.js";

/**
 * Route the graph over bus corridors.
 * @param {Array<{id,x,y,w,h}>} nodes
 * @param {Array<{from,to,key,insetEnd,pinSrc}>} edges
 * @param {Object} opts
 * @param {Array<{x,y,w,h}>} [opts.blockRects]      group headings — hard no-go for the corridor carve
 *                                                  AND for the wires themselves
 * @param {Object} [opts.bus]                       {margin, laneGap, minLen, hopCost, facePad}
 * @param {Function} [opts.fallback]                (missingEdges) -> Map(key -> {pts,p1,d1,p2,d2}),
 *                                                  called ONLY if busRoute left something unrouted
 * @param {Function} [opts.deconflict]              (routes) -> routes, applied ONLY when the fallback
 *                                                  ran (deCollide) — see the note at the call
 * @param {Function} [opts.onCorridors]              (corridors) -> void, the channels this pass carved.
 *                                                  Handed out rather than returned so the routes Map
 *                                                  stays the contract (and survives structured clone
 *                                                  to the worker, which drops a Map's extra props)
 * @returns {Map<string,{pts,p1,d1,p2,d2}>}
 */
export function busRouteGraph(nodes, edges, opts = {}) {
    const { blockRects = [], bus = {}, fallback = null, deconflict = null, onCorridors = null } = opts;
    // minSep/tightGap are raised well above busroute's own defaults (3 / 6): the followability oracle
    // only cares that two wires are distinguishable at all, the rendered canvas needs them readably
    // apart (scripts/route_metrics.mjs calls < 9px ambiguous). tightGap tracks minSep, or a bottleneck
    // corridor packs lanes closer than a lane may legally sit anyway.
    const cfg = { margin: 9, laneGap: 12, minLen: 280, hopCost: 120, facePad: 6, minSep: 10, tightGap: 10, ...bus };

    const nodeRects = {};
    for (const n of nodes) nodeRects[n.id] = { x: n.x, y: n.y, w: n.w, h: n.h };
    // obstacles = nodes + every group heading. The " block:" ids are synthetic: a real node id never
    // starts with a space, so one can never be a link endpoint, so `crossesNode`'s endpoint exemption
    // never fires for it — the heading is unconditionally impassable (see the BLOCKS note above).
    const obst = { ...nodeRects };
    for (let i = 0; i < blockRects.length; i++) {
        const b = blockRects[i];
        if (b && b.w > 0 && b.h > 0) obst[" block:" + i] = { x: b.x, y: b.y, w: b.w, h: b.h };
    }

    const links = [];
    for (const e of edges) {
        const ra = nodeRects[e.from], rb = nodeRects[e.to];
        if (!ra || !rb || e.from === e.to) continue;      // unpositioned endpoint, or a self-edge
        links.push({ key: e.key, aId: e.from, bId: e.to, ra, rb, pinSrc: e.pinSrc || null });
    }

    const corridors = findCorridors(obst, cfg);
    const routes = busRoute(links, obst, corridors, cfg);
    // published AFTER routing so each channel carries how full it ended up (`used` lanes of `cap`) —
    // the debug tint grades on that, and it only exists once the wires have been placed.
    if (onCorridors) {
        const use = routes._corridorUse || [];
        onCorridors(corridors.map((c, i) => ({ ...c, used: use[i] || 0 })));
    }

    const out = new Map();
    const insetOf = new Map(edges.map((e) => [e.key, e.insetEnd || 0]));
    for (const [key, r] of routes) {
        const pts = insetEndpoint(r.pts, r.d2, insetOf.get(key) || 0);
        out.set(key, { pts, p1: pts[0].slice(), d1: r.d1, p2: pts[pts.length - 1].slice(), d2: r.d2, via: r.via });
    }

    // Whatever missed — no bus path, no free lane, or an endpoint the corridors never reach.
    const missed = edges.filter((e) => !out.has(e.key) && nodeRects[e.from] && nodeRects[e.to] && e.from !== e.to);
    let res = out;
    if (missed.length && fallback) {
        const fb = fallback(missed);
        for (const e of missed) { const r = fb && fb.get(e.key); if (r) out.set(e.key, { ...r, via: "fallback" }); }
        // The fallback router is blind to the lanes busRoute reserved, so a fallback line can land on
        // top of a bus line. Fan coincident runs apart — ONLY on this path: with nothing to fall back
        // on, every wire already holds its own reserved lane and a shift would just move it off one.
        if (deconflict) res = deconflict(out) || out;
    }
    res._stats = { ...routes._stats, fellBack: missed.length };
    return res;
}
