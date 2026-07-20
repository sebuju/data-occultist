// busroute.js — the bus router: route the "not facing" lines across a network of bus corridors.
//
// A line whose two nodes FACE each other (share a row or a column, so a direct L/straight shot
// exists) needs no bus — left for a later phase. A line whose nodes do NOT face each other travels
// the BUS NETWORK end to end:
//   APPROACH  source face -> nearest reachable bus's lane
//   RIDE/TURN ride that bus, turn 90 degrees at each junction (where two perpendicular corridors
//             cross) onto the next bus, hopping until a bus is reached that the target can exit to
//   EXIT      leave the last bus onto the target face
// Every bus ridden reserves one lane (centre-out). A bus line never routes THROUGH a node, but it
// does not deconflict with other wires ahead inside a channel — junction crossings are expected.
//
// Joins are resolved ONE SOURCE NODE AT A TIME. If a bus is full, has no path to the target, or the
// approach/exit can't be placed cleanly, the line falls through to the next start bus; a line with
// no workable option is left unrouted and the caller flags it `no-bus-route` (surfaced, not hidden).
// Committed approaches/exits deconflict later lines; placed wires stay followable.
//
// Lane reservation within a corridor fills from the CENTRE outward. Corridors + the junction graph
// come from findCorridors (corridors.js). This is the LIVE default router: busgraph.js adapts it to
// routing.js's contract (see ROUTE.router in routing.js).

import { simplify } from "./route.js";
import { faceKeep, FACE_OUT } from "./faces.js";
import { makeHeap } from "./minheap.js";

const EPS = 0.6;
const MIN_SEP = 3;   // DEFAULT min gap between parallel wires: closer than this and they read as one
                     // (matches followable.js's crowd gate). The app overrides it via opts.minSep --
                     // the oracle tolerates 3px bundles, a rendered canvas at zoom does not.
const TIE = 40;      // start-bus distances within this many px count as "the same distance"
const NODE_CLEAR = 6; // a wire may not ride within this many px of a non-endpoint node's edge

// Any node overlapping the band (x0,y0)-(x1,y1)? 1px slack so the two flanking nodes (whose faces are
// the band edges) don't count. Mirrors the app-side facing check (route.js `anyNodeIn`).
function anyNodeIn(nodeRects, x0, y0, x1, y1) {
    for (const id in nodeRects) {
        const m = nodeRects[id];
        if (m.x + m.w > x0 + 1 && m.x < x1 - 1 && m.y + m.h > y0 + 1 && m.y < y1 - 1) return true;
    }
    return false;
}

// Two nodes FACE each other only when their spans overlap on one axis AND the gap between the facing
// faces is CLEAR of any node (line of sight). Returns { axis, bandLo, bandHi, p0, p1, d1, d2 }: the
// connector runs along `axis`, its port sits anywhere in [bandLo,bandHi] — the overlap band inset at
// both ends so the port can't land on a rounded corner (see `band` below) — it spans
// p0..p1 on the other axis, and d1/d2 are the faces it leaves/arrives on. Null if they don't face
// (then the line is bus-routed). Mirrors route.js `facingLine`.
function facingGeom(a, b, nodeRects) {
    const ax1 = a.x + a.w, ay1 = a.y + a.h, bx1 = b.x + b.w, by1 = b.y + b.h;
    // The overlap band's bounds ARE node edges, and the same coord lands on BOTH nodes — so a lane
    // reserved at an extreme attaches inside a rounded corner (and on the narrower node it can be a
    // corner while still mid-face on the wider one). Pull both ends in by the shared face keep, which
    // carries the short-face guard so a narrow overlap can't invert. The line-of-sight test below
    // stays on the RAW band: what the port may not do is not what the gap must be clear of.
    const band = (lo, hi) => { const k = faceKeep(hi - lo); return { bandLo: lo + k, bandHi: hi - k }; };
    if (a.y < by1 && b.y < ay1) {                            // y overlap -> horizontal shot (band in Y)
        const yo0 = Math.max(a.y, b.y), yo1 = Math.min(ay1, by1);
        if (ax1 <= b.x && !anyNodeIn(nodeRects, ax1, yo0, b.x, yo1)) return { axis: "h", ...band(yo0, yo1), p0: ax1, p1: b.x, d1: "R", d2: "L" };
        if (bx1 <= a.x && !anyNodeIn(nodeRects, bx1, yo0, a.x, yo1)) return { axis: "h", ...band(yo0, yo1), p0: a.x, p1: bx1, d1: "L", d2: "R" };
    }
    if (a.x < bx1 && b.x < ax1) {                            // x overlap -> vertical shot (band in X)
        const xo0 = Math.max(a.x, b.x), xo1 = Math.min(ax1, bx1);
        if (ay1 <= b.y && !anyNodeIn(nodeRects, xo0, ay1, xo1, b.y)) return { axis: "v", ...band(xo0, xo1), p0: ay1, p1: b.y, d1: "B", d2: "T" };
        if (by1 <= a.y && !anyNodeIn(nodeRects, xo0, by1, xo1, a.y)) return { axis: "v", ...band(xo0, xo1), p0: a.y, p1: by1, d1: "T", d2: "B" };
    }
    return null;
}

function distToRect(px, py, c) {
    const dx = Math.max(c.x - px, 0, px - (c.x + c.w));
    const dy = Math.max(c.y - py, 0, py - (c.y + c.h));
    return Math.hypot(dx, dy);
}

// Spatial index of node rects, bucketed into a grid of `cell`-sized squares, so a band query only
// tests the handful of nodes near it instead of all of them. A per-query generation stamp avoids
// re-testing a node that spans several cells (no per-query allocation).
function buildNodeIndex(nodeRects, cell) {
    const nodes = [], byCell = new Map();
    for (const id in nodeRects) {
        const m = nodeRects[id], ni = nodes.length;
        nodes.push({ id, x: m.x, y: m.y, x1: m.x + m.w, y1: m.y + m.h });
        for (let cx = Math.floor(m.x / cell); cx <= Math.floor((m.x + m.w) / cell); cx++)
            for (let cy = Math.floor(m.y / cell); cy <= Math.floor((m.y + m.h) / cell); cy++)
                pushBucket(byCell, cx + "," + cy, ni);
    }
    return { nodes, byCell, cell, stamp: new Int32Array(nodes.length), gen: 0 };
}
// Any node (other than `skip`) overlapping the axis-aligned band [x0,x1]x[y0,y1]?
function bandBlocked(index, skip, x0, x1, y0, y1) {
    if (x1 <= x0 || y1 <= y0) return false;
    const { nodes, byCell, cell, stamp } = index, gen = ++index.gen;
    for (let cx = Math.floor(x0 / cell); cx <= Math.floor(x1 / cell); cx++)
        for (let cy = Math.floor(y0 / cell); cy <= Math.floor(y1 / cell); cy++) {
            const arr = byCell.get(cx + "," + cy);
            if (!arr) continue;
            for (const ni of arr) {
                if (stamp[ni] === gen) continue;
                stamp[ni] = gen;
                const n = nodes[ni];
                if (n.id !== skip && n.x < x1 && n.x1 > x0 && n.y < y1 && n.y1 > y0) return true;
            }
        }
    return false;
}

// Can source node `a` approach corridor `c` without an intervening node in the way? The band spans
// the node's face extent out to the corridor's spine on the facing side.
function reachable(a, aId, c, index) {
    const cxc = c.x + c.w / 2, cyc = c.y + c.h / 2, acx = a.x + a.w / 2, acy = a.y + a.h / 2;
    if (c.axis === "v") {
        return cxc >= acx ? !bandBlocked(index, aId, a.x + a.w, cxc, a.y, a.y + a.h)
                          : !bandBlocked(index, aId, cxc, a.x, a.y, a.y + a.h);
    }
    return cyc >= acy ? !bandBlocked(index, aId, a.x, a.x + a.w, a.y + a.h, cyc)
                      : !bandBlocked(index, aId, a.x, a.x + a.w, cyc, a.y);
}

// reachability of every corridor from a node is constant, so compute it once per node and cache the
// boolean array (indexed by corridor idx). Source nodes and shared targets reuse it.
function reachAll(cache, nodeId, node, lanes, index) {
    let arr = cache.get(nodeId);
    if (!arr) { arr = lanes.map((c) => reachable(node, nodeId, c, index)); cache.set(nodeId, arr); }
    return arr;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---- geometry helpers -----------------------------------------------------------------------

// Axis-aligned segments of a polyline as {axis:'h'|'v', c, lo, hi} (c = the constant coordinate).
function segsOf(pts) {
    const out = [];
    for (let i = 0; i < pts.length - 1; i++) {
        const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
        if (Math.abs(y0 - y1) < 0.5 && Math.abs(x0 - x1) >= 0.5) out.push({ axis: "h", c: y0, lo: Math.min(x0, x1), hi: Math.max(x0, x1) });
        else if (Math.abs(x0 - x1) < 0.5 && Math.abs(y0 - y1) >= 0.5) out.push({ axis: "v", c: x0, lo: Math.min(y0, y1), hi: Math.max(y0, y1) });
    }
    return out;
}

// Does any segment enter a node's forbidden zone? Nodes in `ends` (the route's own source/target) use
// their bare rect — a wire legitimately touches those faces. Every OTHER node is inflated by `clear`,
// so a wire may neither pass through it NOR ride hugging within `clear` of its edge.
function crossesNode(pts, ends, nodeRects, clear = 0) {
    for (const s of segsOf(pts)) {
        for (const id in nodeRects) {
            const c = ends.has(id) ? 0 : clear;
            const m = nodeRects[id], mx0 = m.x - c, mx1 = m.x + m.w + c, my0 = m.y - c, my1 = m.y + m.h + c;
            if (s.axis === "h") {
                if (s.c > my0 + 0.5 && s.c < my1 - 0.5 && s.lo < mx1 - 0.5 && s.hi > mx0 + 0.5) return true;
            } else {
                if (s.c > mx0 + 0.5 && s.c < mx1 - 0.5 && s.lo < my1 - 0.5 && s.hi > my0 + 0.5) return true;
            }
        }
    }
    return false;
}

// If a route segment passes through a node, return the index of the PATH corridor whose lane it rides
// (matched by the segment's constant coordinate), so the retry can route around that corridor. Returns
// -1 if nothing crosses, or the crossing segment isn't one of the path rides (approach/exit).
function crossingCorridor(pts, path, pathLanes, nodeRects) {
    for (const s of segsOf(pts)) {
        let hit = false;
        for (const id in nodeRects) {
            const m = nodeRects[id], mx0 = m.x, mx1 = m.x + m.w, my0 = m.y, my1 = m.y + m.h;
            if (s.axis === "h") { if (s.c > my0 + 0.5 && s.c < my1 - 0.5 && s.lo < mx1 - 0.5 && s.hi > mx0 + 0.5) { hit = true; break; } }
            else { if (s.c > mx0 + 0.5 && s.c < mx1 - 0.5 && s.lo < my1 - 0.5 && s.hi > my0 + 0.5) { hit = true; break; } }
        }
        if (!hit) continue;
        for (let i = 0; i < path.length; i++) {
            const rideAxis = path[i].axis === "v" ? "v" : "h";
            if (s.axis === rideAxis && Math.abs(pathLanes[i] - s.c) < 0.6) return i;
        }
        return -1;
    }
    return -1;
}

// Is point p strictly INSIDE segment s's interior (not at its endpoints)? A vertex landing here forms
// a T-junction with s (the wire owning s passes straight through where this vertex turns/ends).
function ptOnInterior(p, s) {
    const px = p[0], py = p[1];
    if (s.axis === "h") return Math.abs(py - s.c) < 0.6 && px > s.lo + 0.6 && px < s.hi - 0.6;
    return Math.abs(px - s.c) < 0.6 && py > s.lo + 0.6 && py < s.hi - 0.6;
}
// Does the wire cross or re-touch ITSELF? Every other check here holds a route against nodes or
// against OTHER wires — nothing stopped a route from cutting across its own approach leg (board a bus
// heading north, ride back south past where you boarded). The eye loses that line exactly like it
// loses two overlapping ones, and followable.js counts it as `self-overlap`.
//
// Only NON-ADJACENT segments count: consecutive ones legitimately share the corner between them, so
// the perpendicular test demands a STRICTLY interior crossing rather than a touch.
function selfCrosses(pts) {
    const s = segsOf(pts);
    for (let i = 0; i < s.length; i++) {
        for (let j = i + 2; j < s.length; j++) {
            const A = s[i], B = s[j];
            if (A.axis === B.axis) {
                if (Math.abs(A.c - B.c) < 0.6 && Math.min(A.hi, B.hi) - Math.max(A.lo, B.lo) > EPS) return true;
            } else {
                const V = A.axis === "v" ? A : B, H = A.axis === "v" ? B : A;
                if (V.c > H.lo + 0.6 && V.c < H.hi - 0.6 && H.c > V.lo + 0.6 && H.c < V.hi - 0.6) return true;
            }
        }
    }
    return false;
}
// T-merge: any vertex of this route lands on a committed segment's interior, OR any committed vertex
// lands on this route's interior. (Plain perpendicular crossings — neither side turning — are fine.)
function tMerge(pts, cSegs, cPts) {
    for (const v of pts) for (const s of cSegs) if (ptOnInterior(v, s)) return true;
    const ns = segsOf(pts);
    for (const p of cPts) for (const s of ns) if (ptOnInterior(p, s)) return true;
    return false;
}

// Does any segment overlap (collinear share) or crowd (near-parallel) an already-committed segment?
function conflictsCommitted(pts, committed, sep) {
    for (const s of segsOf(pts)) {
        for (const t of committed) {
            if (s.axis !== t.axis) continue;
            const span = Math.min(s.hi, t.hi) - Math.max(s.lo, t.lo);
            if (span <= EPS) continue;                       // no shared extent along the run
            const d = Math.abs(s.c - t.c);
            if (d < sep) return true;                        // collinear overlap (d~0) or crowd (d<sep)
        }
    }
    return false;
}

// ---- committed-geometry store (bucketed by coordinate for O(1)-ish lookups) -----------------
//
// All placed wires' segments and vertices, indexed so a new route only checks the handful nearby
// instead of the whole growing list. Segments bucket by axis+round(constant coord); vertices bucket
// by round(x) and round(y). Replaces the flat committed/committedPts arrays.
function newStore() { return { seg: new Map(), px: new Map(), py: new Map() }; }
function pushBucket(map, key, v) { (map.get(key) || map.set(key, []).get(key)).push(v); }
function storeCommit(st, pts) {
    for (const s of segsOf(pts)) pushBucket(st.seg, s.axis + ":" + Math.round(s.c), s);
    for (const p of pts) { pushBucket(st.px, Math.round(p[0]), p); pushBucket(st.py, Math.round(p[1]), p); }
}
// overlap/crowd of pts against the store (same-axis, within `sep`, spans overlap)
function storeConflicts(st, pts, sep) {
    const R = Math.ceil(sep);
    for (const s of segsOf(pts)) {
        for (let d = -R; d <= R; d++) {
            const arr = st.seg.get(s.axis + ":" + (Math.round(s.c) + d));
            if (!arr) continue;
            for (const t of arr) if (Math.abs(s.c - t.c) < sep && Math.min(s.hi, t.hi) - Math.max(s.lo, t.lo) > EPS) return true;
        }
    }
    return false;
}
// T-merge of pts against the store: a new vertex on a committed segment's interior, or vice-versa
function storeTMerge(st, pts) {
    for (const v of pts) {                                   // new vertex on a committed segment interior
        for (const s of st.seg.get("h:" + Math.round(v[1])) || []) if (ptOnInterior(v, s)) return true;
        for (const s of st.seg.get("v:" + Math.round(v[0])) || []) if (ptOnInterior(v, s)) return true;
    }
    for (const s of segsOf(pts)) {                           // committed vertex on a new segment interior
        const arr = (s.axis === "h" ? st.py : st.px).get(Math.round(s.c));
        if (arr) for (const p of arr) if (ptOnInterior(p, s)) return true;
    }
    return false;
}

// ---- lane reservation (per-corridor lanes + proximity occupancy, by SPAN — roll-backable) ---
//
// Each corridor gets its OWN `cap` lanes, centre-out at laneGap spacing within its thickness (so even
// a corridor thinner than laneGap still gets its one centre lane — a global grid would snap it to
// nothing). A lane is reserved only over the SPAN a line rides it, so one lane carries many lines on
// disjoint spans. Crowding between OVERLAPPING corridors' lanes is prevented by a proximity check
// against a global occupancy map: a lane can't be placed within MIN_SEP of another occupied lane over
// an overlapping span. Occupancy is bucketed by rounded coordinate for fast neighbour lookup.

function makeLanes(corridors, laneGap) {
    return corridors.map((c, idx) => {
        const lo = c.axis === "v" ? c.x : c.y, hi = c.axis === "v" ? c.x + c.w : c.y + c.h;
        const center = (lo + hi) / 2, cap = Math.max(1, c.cap), gap = c.gap || laneGap, gridLanes = [];
        for (let slot = 0; slot < cap; slot++) gridLanes.push(center + (slot - (cap - 1) / 2) * gap);
        gridLanes.sort((p, q) => Math.abs(p - center) - Math.abs(q - center));   // centre-out
        return { ...c, idx, gridLanes };
    });
}
// c's centre along its THIN axis — the coordinate at which a perpendicular corridor crosses it.
function perpCenter(c) { return c.axis === "v" ? c.x + c.w / 2 : c.y + c.h / 2; }
// Which face of a node at (cx,cy) does corridor c sit off? This is the face a wire boarding c leaves
// from — the same test resolveNode uses for srcSide once the lane is known, run early so a PINNED
// port (a watch/trigger line that must leave its own port's face) can rule corridors out up front.
function sideOf(c, cx, cy) {
    return c.axis === "v" ? (perpCenter(c) > cx ? "R" : "L") : (perpCenter(c) > cy ? "B" : "T");
}
// half of Q's extent measured along P's LONG axis (how far a turn onto/off Q can slide the span).
function perpHalf(Q, P) { return (P.axis === "v" ? Q.h : Q.w) / 2; }

// Can a lane at `coord` on `axis` hold [lo,hi] without overlapping the SAME lane's spans or crowding a
// near (< MIN_SEP) parallel lane? occ buckets segments by rounded coord; scan the neighbouring buckets.
function laneFree(occ, axis, coord, lo, hi, sep) {
    const r = Math.round(coord);
    for (let d = -Math.ceil(sep); d <= Math.ceil(sep); d++) {
        const arr = occ.get(axis + ":" + (r + d));
        if (!arr) continue;
        for (const s of arr) if (Math.abs(coord - s.c) < sep && Math.min(hi, s.hi) - Math.max(lo, s.lo) > EPS) return false;
    }
    return true;
}
// Is this EXACT lane coord occupied anywhere along [lo,hi]? Different question from laneFree, which
// answers "may a new span go here" and so also rejects a merely NEARBY lane — for counting how full a
// corridor is we want the lanes actually taken, not the ones blocked by a neighbour.
function laneUsed(occ, axis, coord, lo, hi) {
    const arr = occ.get(axis + ":" + Math.round(coord));
    if (!arr) return false;
    for (const s of arr) if (Math.abs(s.c - coord) < 0.5 && Math.min(hi, s.hi) - Math.max(lo, s.lo) > EPS) return true;
    return false;
}
function occAdd(occ, axis, coord, lo, hi) {
    const k = axis + ":" + Math.round(coord);
    (occ.get(k) || occ.set(k, []).get(k)).push({ c: coord, lo, hi });
}
function releaseSpan(occ, axis, coord, lo, hi) {
    if (lo > hi) { const t = lo; lo = hi; hi = t; }
    const arr = occ.get(axis + ":" + Math.round(coord)); if (!arr) return;
    const i = arr.findIndex((s) => Math.abs(s.c - coord) < 0.5 && Math.abs(s.lo - lo) < 0.5 && Math.abs(s.hi - hi) < 0.5);
    if (i >= 0) arr.splice(i, 1);
}
// reserve a lane within corridor c free over [lo,hi]; returns the lane coord, or null if none.
function reserveSpan(occ, c, lo, hi, sep) {
    if (lo > hi) { const t = lo; lo = hi; hi = t; }
    for (const coord of c.gridLanes) if (laneFree(occ, c.axis, coord, lo, hi, sep)) { occAdd(occ, c.axis, coord, lo, hi); return coord; }
    return null;
}
// Reserve a lane for an APPROACH or EXIT leg (the perpendicular hop between a node face and a bus).
// `axis` is the leg's orientation ('h' = horizontal, coord is a Y; 'v' = vertical, coord is an X). The
// coord is chosen centre-out within the face extent [faceLo,faceHi] at laneGap spacing, free over the
// leg's [spanLo,spanHi]. Legs share the same occupancy as rides, so a leg never crowds a ride/leg.
function reserveLeg(occ, axis, faceLo, faceHi, spanLo, spanHi, center, laneGap, sep) {
    const coords = [];
    for (let g = center; g <= faceHi + 1e-6; g += laneGap) coords.push(g);
    for (let g = center - laneGap; g >= faceLo - 1e-6; g -= laneGap) coords.push(g);
    coords.sort((p, q) => Math.abs(p - center) - Math.abs(q - center));
    for (const coord of coords) if (laneFree(occ, axis, coord, spanLo, spanHi, sep)) { occAdd(occ, axis, coord, spanLo, spanHi); return coord; }
    return null;
}

// ---- bus network (junctions between perpendicular corridors) --------------------------------

// Two corridors form a junction where they cross. Same-axis corridors never overlap (enforced by
// findCorridors), so a junction is always a V corridor overlapping an H corridor.
//
// The network is flattened for the search: corridor u's neighbours live in nbr[base[u] .. base[u]+
// deg[u]-1]. A SLOT in that flat array is also the search's state id — slot s means "riding corridor
// owner[s], having boarded it at its crossing with nbr[s]". That crossing sits at perpC[nbr[s]] along
// owner[s]'s long axis, which is exactly the entry coordinate the cost needs (see busPathDist).
// rev[s] is the mirror slot: stepping u -> v across slot s lands on state rev[s] with no lookup.
// Search scratch is sized once here and generation-stamped, so the hot retry loop never allocates.
function buildBusNet(lanes) {
    const N = lanes.length, adj = lanes.map(() => []);
    for (let i = 0; i < N; i++) {
        for (let j = i + 1; j < N; j++) {
            const A = lanes[i], B = lanes[j];
            if (A.axis === B.axis) continue;
            if (A.x < B.x + B.w && A.x + A.w > B.x && A.y < B.y + B.h && A.y + A.h > B.y) {
                adj[i].push(j); adj[j].push(i);
            }
        }
    }
    const base = new Int32Array(N + 1);
    for (let i = 0; i < N; i++) base[i + 1] = base[i] + adj[i].length;
    const E = base[N];
    const nbr = new Int32Array(E), owner = new Int32Array(E), rev = new Int32Array(E);
    const slotOf = new Map();                            // u*N+v -> flat slot of the hop u->v
    for (let u = 0; u < N; u++) {
        for (let k = 0; k < adj[u].length; k++) {
            const s = base[u] + k;
            nbr[s] = adj[u][k]; owner[s] = u; slotOf.set(u * N + adj[u][k], s);
        }
    }
    for (let s = 0; s < E; s++) rev[s] = slotOf.get(nbr[s] * N + owner[s]);
    const perpC = new Float64Array(N);
    for (let i = 0; i < N; i++) perpC[i] = perpCenter(lanes[i]);
    const axisV = new Uint8Array(N);
    for (let i = 0; i < N; i++) axisV[i] = lanes[i].axis === "v" ? 1 : 0;
    return {
        N, E, base, nbr, owner, rev, perpC, axisV,
        heap: makeHeap(Math.max(64, E)),
        g: new Float64Array(E + 1), prev: new Int32Array(E + 1), seen: new Int32Array(E + 1), gen: 0,
    };
}

// Cheapest bus path from `start` to any goal corridor, by DISTANCE RIDDEN rather than hop count.
//
// Riding corridor u from its crossing with p to its crossing with v covers |perpC[v] - perpC[p]| — so
// the cost of a hop depends on where the wire BOARDED u, not on u alone. That makes the search state a
// directed hop (the flat slot), not a corridor. Each hop also pays `hopCost`, a flat turn penalty: a
// corner costs real estate and readability, so distance alone shouldn't buy three jogs to save a few px.
//
// A goal corridor is terminal but its exit cost |tgtLong - inLong| varies per state, so the first goal
// popped isn't necessarily the cheapest — keep the best total and stop once the heap's minimum can no
// longer beat it. Avoids `blocked` (full) corridors. Returns [idx...] or null.
function busPathDist(net, start, srcLong, goalSet, tcx, tcy, blocked, hopCost) {
    const { E, base, nbr, owner, rev, perpC, axisV, heap, g, prev, seen } = net;
    if (blocked.has(start)) return null;
    const gen = ++net.gen;
    const tgtLong = (u) => (axisV[u] ? tcy : tcx);
    heap.clear();
    g[E] = 0; seen[E] = gen; prev[E] = -1;
    heap.push(0, E);
    let best = Infinity, bestState = -2;                 // -2 = none yet, -1 = the start corridor itself
    while (heap.size) {
        const s = heap.pop(), k = heap.topKey;
        if (k >= best) break;                            // nothing left in the heap can improve on best
        if (seen[s] !== gen || k > g[s]) continue;       // stale heap entry
        const u = s === E ? start : owner[s];
        const inL = s === E ? srcLong : perpC[nbr[s]];
        if (goalSet.has(u)) {
            const total = k + Math.abs(tgtLong(u) - inL);
            if (total < best) { best = total; bestState = s === E ? -1 : s; }
        }
        for (let t = base[u], end = base[u + 1]; t < end; t++) {
            const v = nbr[t];
            if (blocked.has(v)) continue;
            const ng = k + Math.abs(perpC[v] - inL) + hopCost;
            const ns = rev[t];
            if (seen[ns] === gen && ng >= g[ns]) continue;
            g[ns] = ng; seen[ns] = gen; prev[ns] = s;
            heap.push(ng, ns);
        }
    }
    if (bestState === -2) return null;
    if (bestState === -1) return [start];
    const path = [];
    for (let s = bestState; s !== E; s = prev[s]) path.push(owner[s]);
    path.push(start);
    path.reverse();
    return path;
}

// ---- one node's routes ---------------------------------------------------------------------

// Build one line's full multi-bus route from its reserved lanes and legs:
//   APPROACH  source face -> first bus lane   (horizontal/vertical leg on a reserved grid line)
//   RIDE/TURN along each bus, turning 90 degrees at each junction onto the next bus
//   EXIT      last bus lane -> target face     (leg on a reserved grid line)
// Every segment sits on a grid line reserved over its span, so nothing overlaps or crowds and no two
// join points stack. r fields: { a,b, path, pathLanes, srcSide, tgtSide, entry, exit } where `entry`
// is the source join coord (the approach leg's grid line) and `exit` the target join coord.
// Returns { pts, appr, exit } (appr, exit = the open-gap legs, kept for the node-crossing check).
function buildRoute1(r) {
    const { a, b, path: P, pathLanes: L, entry, exit: e } = r;
    let pts, appr, cur;
    if (P[0].axis === "v") {                                  // first bus vertical: lane X, approach horizontal at y=entry
        const fx = r.srcSide === "R" ? a.x + a.w : a.x, on = [L[0], entry];
        pts = [[fx, entry], on]; appr = [[fx, entry], on]; cur = on;
    } else {                                                  // first bus horizontal: lane Y, approach vertical at x=entry
        const fy = r.srcSide === "B" ? a.y + a.h : a.y, on = [entry, L[0]];
        pts = [[entry, fy], on]; appr = [[entry, fy], on]; cur = on;
    }
    for (let k = 1; k < P.length; k++) {                     // turn onto each next bus at its junction
        const laneK = L[k];
        const corner = P[k].axis === "h" ? [cur[0], laneK] : [laneK, cur[1]];
        pts.push(corner); cur = corner;
    }
    let exit;
    const last = P[P.length - 1], laneLast = L[L.length - 1];
    if (last.axis === "v") {                                  // vertical bus: ride to y=e, then leave to face
        const faceX = r.tgtSide === "L" ? b.x : b.x + b.w;
        pts.push([laneLast, e], [faceX, e]);
        exit = [[cur[0], cur[1]], [laneLast, e], [faceX, e]];
    } else {                                                  // horizontal bus: ride to x=e, then leave to face
        const faceY = r.tgtSide === "T" ? b.y : b.y + b.h;
        pts.push([e, laneLast], [e, faceY]);
        exit = [[cur[0], cur[1]], [e, laneLast], [e, faceY]];
    }
    return { pts: simplify(pts), appr, exit };
}

// Resolve one source node's joins across the bus NETWORK. Each line boards the nearest reachable bus
// to the source, then hops bus->bus at junctions until it reaches a bus from which the target is
// reachable, and exits there. Every bus it rides reserves one lane. If a bus is full, has no path to
// the target, or its approach can't be placed cleanly, the line falls through to the next start bus;
// a line with no workable option at all is left unrouted (flagged no-bus-route by the caller).
function resolveNode(aId, lines, lanes, net, grid, committed, reachCache, index, nodeRects, opts) {
    const a = lines[0].a;
    const acx = a.x + a.w / 2, acy = a.y + a.h / 2;
    const { laneGap, facePad, hopCost, minSep, faceBias } = opts;
    const reachSrc = reachAll(reachCache, aId, a, lanes, index);   // cached: source can approach corridor?
    const excl = new Map();                                  // line.key -> Set(start corridor idx) rejected
    for (const l of lines) excl.set(l.key, new Set());
    const dropped = new Set();

    // goal buses per line = corridors the TARGET can approach (mirror of the source approach test)
    const goalOf = new Map();
    for (const l of lines) {
        const gr = reachAll(reachCache, l.bId, l.b, lanes, index), g = new Set();
        for (let i = 0; i < lanes.length; i++) if (gr[i]) g.add(i);
        goalOf.set(l.key, g);
        if (!g.size) dropped.add(l.key);                     // target touches no bus -> unrouted
    }

    const block = new Map();                                 // line.key -> Set(corridor idx) to avoid in paths
    for (const l of lines) block.set(l.key, new Set());

    const releaseAll = (r) => {
        for (const t of r.taken) releaseSpan(grid, t.axis, t.coord, t.lo, t.hi);
    };

    for (let iter = 0; iter < 2000; iter++) {
        const reserved = [];
        let contended = false;
        for (const l of lines) {
            if (dropped.has(l.key)) continue;
            const ex = excl.get(l.key), avoid = block.get(l.key), goal = goalOf.get(l.key);

            // pick the start bus by lowest COST = distance to the corridor + a face-direction charge:
            // boarding a corridor off the face pointing AWAY from the target costs up to `faceBias` px,
            // 0 when that face points straight at it. Without this the router boards the merely-nearest
            // corridor and a line leaves the wrong side (e.g. the TOP face when its target sits below).
            // Mirrors route.js's faceBias; the bus router had no target-direction term at all. Near-ties
            // on the combined cost still break toward the target's dominant axis.
            const tdx = (l.b.x + l.b.w / 2) - acx, tdy = (l.b.y + l.b.h / 2) - acy, tL = Math.hypot(tdx, tdy) || 1;
            const faceAway = (face) => { const n = FACE_OUT[face]; return (faceBias || 0) * (1 - (n[0] * tdx + n[1] * tdy) / tL) / 2; };
            const dom = Math.abs(tdx) >= Math.abs(tdy) ? "h" : "v";
            let start = null, bd = Infinity;
            for (const c of lanes) {
                if (ex.has(c.idx) || avoid.has(c.idx)) continue;
                if (!reachSrc[c.idx]) continue;
                if (l.pin && sideOf(c, acx, acy) !== l.pin) continue;   // pinned port: board only from that face
                const score = distToRect(acx, acy, c) + faceAway(sideOf(c, acx, acy));
                if (!start || score < bd - TIE) { start = c; bd = score; continue; }   // clearly cheaper
                if (score > bd + TIE) continue;                                        // clearly costlier
                const mc = c.axis === dom ? 1 : 0, ms = start.axis === dom ? 1 : 0;
                if (mc > ms) { start = c; bd = score; }                                // points toward target
            }
            if (!start) { dropped.add(l.key); continue; }     // no start bus left -> unrouted

            // path across the junction network to a goal bus, avoiding congested corridors. Cost is the
            // distance actually ridden (+ hopCost per turn), so the board coordinate on the start bus is
            // part of the input — it's where the ride begins.
            const startLong = start.axis === "v" ? acy : acx;
            const path = busPathDist(net, start.idx, startLong, goal, l.b.x + l.b.w / 2, l.b.y + l.b.h / 2, avoid, hopCost);
            if (!path) { excl.get(l.key).add(start.idx); contended = true; break; }
            const P = path.map(i => lanes[i]);

            // reserve a lane SPAN in each bus: only over the stretch the line actually rides it
            // (board/junction/exit points along that bus's long axis, padded by the crossing width).
            const r = { l, a, b: l.b, taken: [], path: P, pathLanes: [] };
            const srcLong = P[0].axis === "v" ? acy : acx;
            const tgtLong = P[P.length - 1].axis === "v" ? (l.b.y + l.b.h / 2) : (l.b.x + l.b.w / 2);
            let failIdx = -1;
            for (let i = 0; i < P.length; i++) {
                const inL = i === 0 ? srcLong : perpCenter(P[i - 1]);
                const outL = i === P.length - 1 ? tgtLong : perpCenter(P[i + 1]);
                const padIn = i === 0 ? (P[i].axis === "v" ? a.h : a.w) / 2 : perpHalf(P[i - 1], P[i]);
                const padOut = i === P.length - 1 ? (P[i].axis === "v" ? l.b.h : l.b.w) / 2 : perpHalf(P[i + 1], P[i]);
                const lo = Math.min(inL, outL) - (inL <= outL ? padIn : padOut);
                const hi = Math.max(inL, outL) + (inL <= outL ? padOut : padIn);
                const coord = reserveSpan(grid, P[i], lo, hi, minSep);
                if (coord == null) { failIdx = i; break; }
                r.taken.push({ axis: P[i].axis, coord, lo, hi });
                r.pathLanes.push(coord);
            }
            // a ride couldn't reserve a lane over its span (reserveSpan already tried every grid line):
            // the corridor genuinely can't host this ride there, so avoid it and re-path around it.
            if (failIdx >= 0) { releaseAll(r); block.get(l.key).add(P[failIdx].idx); contended = true; break; }

            // reserve the APPROACH and EXIT legs on the grid too (each fans onto its own grid line, so
            // join points never stack and a leg never runs over a ride). A leg is perpendicular to its
            // bus: horizontal off a vertical bus, vertical off a horizontal bus.
            const startLane = r.pathLanes[0], lastLane = r.pathLanes[r.pathLanes.length - 1];
            const last = P[P.length - 1], tcx = l.b.x + l.b.w / 2, tcy = l.b.y + l.b.h / 2;
            r.srcSide = P[0].axis === "v" ? (startLane > acx ? "R" : "L") : (startLane > acy ? "B" : "T");
            r.tgtSide = last.axis === "v" ? (lastLane < tcx ? "L" : "R") : (lastLane < tcy ? "T" : "B");
            const legFor = (bus, side, node, faceCenter, busLane) => {
                if (bus.axis === "v") {                        // horizontal leg at y=coord, spanning x face..lane
                    const fx = side === "R" ? node.x + node.w : node.x;
                    return { axis: "h", faceLo: node.y + facePad, faceHi: node.y + node.h - facePad,
                        spanLo: Math.min(fx, busLane), spanHi: Math.max(fx, busLane), center: faceCenter };
                }
                const fy = side === "B" ? node.y + node.h : node.y;   // vertical leg at x=coord, spanning y face..lane
                return { axis: "v", faceLo: node.x + facePad, faceHi: node.x + node.w - facePad,
                    spanLo: Math.min(fy, busLane), spanHi: Math.max(fy, busLane), center: faceCenter };
            };
            const ap = legFor(P[0], r.srcSide, a, P[0].axis === "v" ? acy : acx, startLane);
            r.entry = reserveLeg(grid, ap.axis, ap.faceLo, ap.faceHi, ap.spanLo, ap.spanHi, ap.center, laneGap, minSep);
            if (r.entry == null) { releaseAll(r); excl.get(l.key).add(P[0].idx); contended = true; break; }
            r.taken.push({ axis: ap.axis, coord: r.entry, lo: ap.spanLo, hi: ap.spanHi });
            const xl = legFor(last, r.tgtSide, l.b, last.axis === "v" ? tcy : tcx, lastLane);
            r.exit = reserveLeg(grid, xl.axis, xl.faceLo, xl.faceHi, xl.spanLo, xl.spanHi, xl.center, laneGap, minSep);
            if (r.exit == null) { releaseAll(r); block.get(l.key).add(last.idx); contended = true; break; }
            r.taken.push({ axis: xl.axis, coord: r.exit, lo: xl.spanLo, hi: xl.spanHi });

            // Now the exact board/turn/exit coords are known, so SHRINK each ride's reservation to the
            // stretch it truly rides (corner to corner) and free the padded overhang — this hands the
            // slack back to the grid for later lines. r.taken[0..P.length-1] are the ride spans.
            for (let i = 0; i < P.length; i++) {
                const t = r.taken[i];
                releaseSpan(grid, t.axis, t.coord, t.lo, t.hi);
                const inC = i === 0 ? r.entry : r.pathLanes[i - 1];
                const outC = i === P.length - 1 ? r.exit : r.pathLanes[i + 1];
                t.lo = Math.min(inC, outC); t.hi = Math.max(inC, outC);
                occAdd(grid, t.axis, t.coord, t.lo, t.hi);
            }
            reserved.push(r);
        }
        if (contended) { for (const r of reserved) releaseAll(r); continue; }
        if (!reserved.length) return new Map();

        const routes = new Map(reserved.map((r) => [r.l.key, buildRoute1(r)]));

        // A wire may NEVER pass through a node interior — the WHOLE route is checked against ALL nodes
        // (its own source/target included; a face touch is a boundary, not interior). It does not
        // deconflict with other wires ahead inside a channel — only the APPROACH and EXIT (crossing
        // open gaps) are checked for overlap. When a route fails, BLAME the responsible bus precisely
        // so the retry fixes the real problem instead of blindly abandoning the start bus.
        let bad = null, blame = null;                        // blame: { kind:'start'|'corridor', idx }
        const local = [], localPts = [];
        for (const r of reserved) {
            const { pts, appr, exit } = routes.get(r.l.key);
            const ends = new Set([r.l.aId, r.l.bId]);
            if (crossesNode(appr, ends, nodeRects, NODE_CLEAR) || storeConflicts(committed, appr, minSep) || conflictsCommitted(appr, local, minSep)) {
                bad = r; blame = { kind: "start", idx: r.path[0].idx }; break;   // boarding is the problem
            }
            if (crossesNode(exit, ends, nodeRects, NODE_CLEAR) || storeConflicts(committed, exit, minSep) || conflictsCommitted(exit, local, minSep)) {
                bad = r; blame = { kind: "corridor", idx: r.path[r.path.length - 1].idx }; break;   // last bus
            }
            const ci = crossingCorridor(pts, r.path, r.pathLanes, nodeRects);   // a ride crosses a node?
            if (ci >= 0) { bad = r; blame = { kind: "corridor", idx: r.path[ci].idx }; break; }
            // whole route: never through/hugging a node, never T-merging into another wire, and never
            // crossing ITSELF. A self-cross means the approach boarded a bus the route then doubled
            // back past, so the START bus is what to retry.
            if (crossesNode(pts, ends, nodeRects, NODE_CLEAR) || selfCrosses(pts) || storeTMerge(committed, pts) || tMerge(pts, local, localPts)) {
                bad = r; blame = { kind: "start", idx: r.path[0].idx }; break;
            }
            local.push(...segsOf(appr), ...segsOf(exit)); localPts.push(...pts);
        }

        if (!bad) {
            const out = new Map();
            for (const r of reserved) {
                const s = routes.get(r.l.key);
                storeCommit(committed, s.pts);                // deconflict future lines
                out.set(r.l.key, { pts: s.pts, d1: r.srcSide, d2: r.tgtSide, via: "bus" });
            }
            return out;                                       // keep every lane span + exit reservation
        }
        for (const r of reserved) releaseAll(r);
        if (blame.kind === "start") excl.get(bad.l.key).add(blame.idx);   // try boarding a different bus
        else block.get(bad.l.key).add(blame.idx);            // route around the offending corridor
    }
    return new Map();
}

/**
 * Dock not-facing lines onto their nearest reachable bus, one source node at a time.
 * @returns {Map<string,{pts:number[][],src,d1,d2,via}>}  routes keyed by link.key (d1/d2 = the faces
 *          the wire leaves/arrives on, "L"|"R"|"T"|"B"; via = "bus" rode corridors, "facing" took a
 *          direct line-of-sight shot);
 *          ._stats = {facing,routed,unrouted}; ._unrouted = [{key, at}] (no-bus-route offenders)
 */
export function busRoute(links, nodeRects, corridors, opts = {}) {
    const cfg = { laneGap: 12, facePad: 6, hopCost: 120, minSep: MIN_SEP, faceBias: 200, ...opts };
    // hopCost MUST stay > 0. BFS could never repeat a corridor (its visited gate); a distance search
    // can, and a repeated corridor would double-reserve a lane and break buildRoute1's corner walk.
    // With a strictly positive turn penalty no optimal path revisits one: re-entering a corridor is
    // always beaten by riding it straight through, which is no longer AND drops two turns.
    cfg.hopCost = Math.max(1e-6, cfg.hopCost);
    const lanes = makeLanes(corridors, cfg.laneGap);
    const net = buildBusNet(lanes);                       // bus network: which corridors cross + search scratch
    const grid = new Map();                                // global grid-lane occupancy (axis:coord -> spans)
    const index = buildNodeIndex(nodeRects, 256);          // spatial index for band/reachability queries
    const stats = { facing: 0, routed: 0, unrouted: 0 };

    const committed = newStore();                         // all placed wires, bucketed for fast lookup
    const reachCache = new Map();                          // nodeId -> per-corridor reachability
    const routes = new Map();
    const unrouted = [];
    const byNode = new Map();

    // classify: a clear line-of-sight pair is a straight shot (deferred until AFTER the bus lines);
    // everything else is bus-routed.
    const straights = [];
    for (const l of links) {
        const a = l.ra || nodeRects[l.aId], b = l.rb || nodeRects[l.bId];
        if (!a || !b) continue;
        const g = facingGeom(a, b, nodeRects);
        // a PINNED source (watch/trigger: the line must leave its own port's face) only takes the
        // straight shot if the shot happens to leave that face — otherwise it rides the buses, which
        // can board from the pinned side.
        if (g && (!l.pinSrc || g.d1 === l.pinSrc)) straights.push({ l, g });
        else (byNode.get(l.aId) || byNode.set(l.aId, []).get(l.aId)).push({ ...l, a, b, pin: l.pinSrc || null });
    }

    // BUS lines FIRST: busiest source nodes first so they claim lanes before scraps.
    const nodeOrder = [...byNode.entries()].sort((p, q) => q[1].length - p[1].length);
    for (const [aId, lines] of nodeOrder) {
        const stubs = resolveNode(aId, lines, lanes, net, grid, committed, reachCache, index, nodeRects, cfg);
        for (const l of lines) {
            const s = stubs.get(l.key);
            if (s) { routes.set(l.key, { pts: s.pts, src: aId, d1: s.d1, d2: s.d2, via: "bus" }); stats.routed++; }
            else { stats.unrouted++; unrouted.push({ key: l.key, at: [l.a.x + l.a.w / 2, l.a.y + l.a.h / 2] }); }
        }
    }

    // FACING straight shots AFTER: each reserves a grid line WITHIN the overlap band, adapting its port
    // to whatever the bus lines left free, so shots fan apart and never overlap a bus line or another
    // shot. A band with no free grid line falls back to its centre (best effort).
    for (const { l, g } of straights) {
        const coord = reserveLeg(grid, g.axis, g.bandLo, g.bandHi, Math.min(g.p0, g.p1), Math.max(g.p0, g.p1), (g.bandLo + g.bandHi) / 2, cfg.laneGap, cfg.minSep)
            ?? (g.bandLo + g.bandHi) / 2;
        const pts = g.axis === "h" ? [[g.p0, coord], [g.p1, coord]] : [[coord, g.p0], [coord, g.p1]];
        routes.set(l.key, { pts, src: l.aId, d1: g.d1, d2: g.d2, via: "facing" }); storeCommit(committed, pts); stats.facing++;
    }

    // How full each corridor ended up: its own lanes that carry at least one span. Counted from the
    // FINAL occupancy (after every retry rolled back and the straight shots claimed theirs), so it
    // reflects what was actually placed, not what was attempted. Indexed by corridor idx.
    routes._corridorUse = lanes.map((c) => {
        const lo = c.axis === "v" ? c.y : c.x, hi = c.axis === "v" ? c.y + c.h : c.x + c.w;
        let n = 0;
        for (const coord of c.gridLanes) if (laneUsed(grid, c.axis, coord, lo, hi)) n++;
        return n;
    });
    routes._stats = stats;
    routes._unrouted = unrouted;
    return routes;
}
