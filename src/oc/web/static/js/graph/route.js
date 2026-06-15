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
  laneGap: 12,     // separation between bundled parallel wires
  faceStick: 50,   // bias to keep a connector's previous face (hysteresis) — < bendCost, so a
                   // clearly better route still switches, but ties/small margins don't flicker
};
const GBAND = 10;  // a segment within this of a group border (parallel) counts as riding it

const center = (r) => [r.x + r.w / 2, r.y + r.h / 2];
const faceOut = { L: [-1, 0], R: [1, 0], T: [0, -1], B: [0, 1] };
const DC = { N: 0, S: 1, E: 2, W: 3 };
const outDir = (s) => (faceOut[s][0] !== 0 ? (faceOut[s][0] > 0 ? "E" : "W") : (faceOut[s][1] > 0 ? "S" : "N"));
const inDirOf = (s) => (faceOut[s][0] !== 0 ? (faceOut[s][0] > 0 ? "W" : "E") : (faceOut[s][1] > 0 ? "N" : "S"));
const rev = (d) => (d === "N" ? "S" : d === "S" ? "N" : d === "E" ? "W" : "E");

function segHitsHard(ax, ay, bx, by, rects, eps) {
  eps = eps == null ? 1 : eps;
  const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx), y0 = Math.min(ay, by), y1 = Math.max(ay, by);
  for (const r of rects) if (x1 > r.x + eps && x0 < r.x + r.w - eps && y1 > r.y + eps && y0 < r.y + r.h - eps) return true;
  return false;
}
function softList(ax, ay, bx, by, soft) {
  const out = []; const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx), y0 = Math.min(ay, by), y1 = Math.max(ay, by);
  for (let i = 0; i < soft.length; i++) { const g = soft[i]; if (x1 > g.x0 + 1 && x0 < g.x1 - 1 && y1 > g.y0 + 1 && y0 < g.y1 - 1) out.push(i); }
  return out;
}
// the 1-bend L (or straight) options A=(ax,ay)->B=(bx,by) that clear all hard rects
function edgeOpts(ax, ay, bx, by, rects, soft) {
  const out = [], len = Math.abs(ax - bx) + Math.abs(ay - by);
  if (len < 0.5) return out;
  const dh = bx > ax ? "E" : "W", dv = by > ay ? "S" : "N";
  if (Math.abs(ax - bx) < 0.5) { if (!segHitsHard(ax, ay, bx, by, rects)) out.push({ d1: dv, d2: dv, corner: null, len, gset: new Set(softList(ax, ay, bx, by, soft)) }); return out; }
  if (Math.abs(ay - by) < 0.5) { if (!segHitsHard(ax, ay, bx, by, rects)) out.push({ d1: dh, d2: dh, corner: null, len, gset: new Set(softList(ax, ay, bx, by, soft)) }); return out; }
  const c1 = [bx, ay];
  if (!segHitsHard(ax, ay, c1[0], c1[1], rects) && !segHitsHard(c1[0], c1[1], bx, by, rects))
    out.push({ d1: dh, d2: dv, corner: c1, len, gset: new Set(softList(ax, ay, c1[0], c1[1], soft).concat(softList(c1[0], c1[1], bx, by, soft))) });
  const c2 = [ax, by];
  if (!segHitsHard(ax, ay, c2[0], c2[1], rects) && !segHitsHard(c2[0], c2[1], bx, by, rects))
    out.push({ d1: dv, d2: dh, corner: c2, len, gset: new Set(softList(ax, ay, c2[0], c2[1], soft).concat(softList(c2[0], c2[1], bx, by, soft))) });
  return out;
}

// A* over waypoints, state = (node, entryDir); cost = length + bendCost*bends + group penalty.
// Returns the chain [{node, corner}] start->goal (corner = the L-bend used to reach that node).
function astar(WP, edgesOf, start, goal, ownGroups) {
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
      let pen = 0; if (e.gset && e.gset.size) for (const gi of e.gset) if (!ownGroups.has(gi)) pen += C.groupCross;
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

function simplify(pts) {
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
  const soft = [], groupOfNode = new Map();
  for (const grp of (groups || [])) {
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, any = false;
    for (const id of grp.members) { const nd = byId.get(id); if (!nd) continue; any = true; x0 = Math.min(x0, nd.x); y0 = Math.min(y0, nd.y); x1 = Math.max(x1, nd.x + nd.w); y1 = Math.max(y1, nd.y + nd.h); groupOfNode.set(id, soft.length); }
    if (any) soft.push({ x0: x0 - PADG, y0: y0 - PADG, x1: x1 + PADG, y1: y1 + PADG });
  }

  // stage 1: base waypoints = inflated node corners + group box corners; 1-bend adjacency
  const WP = [];
  for (const r of rects) { WP.push([r.x - m, r.y - m], [r.x + r.w + m, r.y - m], [r.x - m, r.y + r.h + m], [r.x + r.w + m, r.y + r.h + m]); }
  for (const g of soft) { WP.push([g.x0 - m, g.y0 - m], [g.x1 + m, g.y0 - m], [g.x0 - m, g.y1 + m], [g.x1 + m, g.y1 + m]); }
  const baseN = WP.length;
  const baseAdj = Array.from({ length: baseN }, () => []);
  for (let i = 0; i < baseN; i++) for (let j = i + 1; j < baseN; j++) {
    const A = WP[i], B = WP[j];
    for (const e of edgeOpts(A[0], A[1], B[0], B[1], rects, soft)) {
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
      for (let i = 0; i < baseN; i++) { const W = WP[i]; for (const e of edgeOpts(sp[0], sp[1], W[0], W[1], rects, soft)) if (e.d1 === od) list.push({ to: i, d1: e.d1, d2: e.d2, corner: e.corner, len: e.len, gset: e.gset }); }
      pe[f] = list;
    }
    portPos.set(n.id, pp); portEdges.set(n.id, pe);
  }

  // stage 2: route each line; A* chooses the faces (super-source/sink over all 4)
  const lines = [];
  for (const e of edges) { if (byId.has(e.from) && byId.has(e.to)) lines.push({ from: e.from, to: e.to, key: e.key }); }
  for (const ln of lines) {
    const A = byId.get(ln.from), B = byId.get(ln.to), base0 = WP.length;
    const ppA = portPos.get(ln.from), ppB = portPos.get(ln.to), peA = portEdges.get(ln.from), peB = portEdges.get(ln.to);
    const prev = prevSides && prevSides.get(ln.key);
    const S0 = WP.length; WP.push(center(A));
    const srcIdx = {}; for (const f of FACES) { srcIdx[f] = WP.length; WP.push(ppA[f].slice()); }
    const dstIdx = {}; for (const f of FACES) { dstIdx[f] = WP.length; WP.push(ppB[f].slice()); }
    const D0 = WP.length; WP.push(center(B));
    const own = new Set(); const sg = groupOfNode.get(ln.from), dg = groupOfNode.get(ln.to); if (sg != null) own.add(sg); if (dg != null) own.add(dg);
    const overlay = new Map(); const add = (from, e) => { if (!overlay.has(from)) overlay.set(from, []); overlay.get(from).push(e); };
    // hysteresis: non-previous faces cost a small stickiness bias, so the route keeps its face
    for (const f of FACES) { const od = outDir(f); add(S0, { to: srcIdx[f], d1: od, d2: od, corner: null, len: prev && prev.d1 !== f ? C.faceStick : 0, gset: EMPTY }); }
    for (const f of FACES) { const id = inDirOf(f); add(dstIdx[f], { to: D0, d1: id, d2: id, corner: null, len: prev && prev.d2 !== f ? C.faceStick : 0, gset: EMPTY }); }
    for (const f of FACES) for (const e of peA[f]) add(srcIdx[f], e);
    for (const g of FACES) for (const e of peB[g]) add(e.to, { to: dstIdx[g], d1: rev(e.d2), d2: rev(e.d1), corner: e.corner, len: e.len, gset: e.gset });
    for (const f of FACES) { const sp = ppA[f], od = outDir(f); for (const g of FACES) { const dp = ppB[g], id = inDirOf(g); for (const e of edgeOpts(sp[0], sp[1], dp[0], dp[1], rects, soft)) if (e.d1 === od && e.d2 === id) add(srcIdx[f], { to: dstIdx[g], d1: e.d1, d2: e.d2, corner: e.corner, len: e.len, gset: e.gset }); } }
    const edgesOf = (i) => (i < baseN ? (overlay.has(i) ? baseAdj[i].concat(overlay.get(i)) : baseAdj[i]) : (overlay.get(i) || []));
    const chain = astar(WP, edgesOf, S0, D0, own);
    if (chain && chain.length >= 3) {
      const faceOf = (node, map) => FACES.find((f) => map[f] === node);
      ln.srcSide = faceOf(chain[1].node, srcIdx) || "R";
      ln.dstSide = faceOf(chain[chain.length - 2].node, dstIdx) || "L";
      const pts = [];
      for (let c = 1; c < chain.length - 1; c++) { if (chain[c].corner) pts.push(chain[c].corner.slice()); pts.push(WP[chain[c].node].slice()); }
      ln.pts = simplify(pts);
    } else {
      // degenerate (an endpoint trapped inside an overlapping node): orthogonal Z, never a diagonal
      const sc = center(A), dc = center(B), horiz = Math.abs(dc[0] - sc[0]) >= Math.abs(dc[1] - sc[1]);
      const mx = (sc[0] + dc[0]) / 2, my = (sc[1] + dc[1]) / 2;
      ln.pts = simplify(horiz ? [sc, [mx, sc[1]], [mx, dc[1]], dc] : [sc, [sc[0], my], [dc[0], my], dc]);
      ln.srcSide = horiz ? (dc[0] >= sc[0] ? "R" : "L") : (dc[1] >= sc[1] ? "B" : "T");
      ln.dstSide = horiz ? (dc[0] >= sc[0] ? "L" : "R") : (dc[1] >= sc[1] ? "T" : "B");
    }
    WP.length = base0;
  }

  // stage 3: nudging — split shared corridors into nested lanes, centred in their alley
  nudge(lines, byId, rects);

  const out = new Map();
  for (const ln of lines) out.set(ln.key, { pts: ln.pts, p1: ln.pts[0].slice(), d1: ln.srcSide, p2: ln.pts[ln.pts.length - 1].slice(), d2: ln.dstSide });
  return out;
}

// Nudging: each connector is a chain of maximal H/V segments. Connectors sharing a corridor (same
// axis + coord, overlapping span) get distinct parallel lanes (V-seg => x-offset, H-seg => y-offset,
// so a vertex = base + its V-offset + its H-offset and orthogonality is preserved). Port stubs are
// segments too => connectors leaving one face fan out along it. Each lane band is shifted to stay
// within the free alley bounded by neighbouring nodes, so no lane spills across a node edge.
function nudge(lines, byId, rects) {
  for (const ln of lines) { ln._V = ln.pts.map((p) => p.slice()); ln._dx = new Array(ln._V.length).fill(0); ln._dy = new Array(ln._V.length).fill(0); }
  const segs = [];
  for (const ln of lines) { const V = ln._V; for (let i = 0; i + 1 < V.length; i++) { const a = V[i], b = V[i + 1];
    if (Math.abs(a[0] - b[0]) < 0.5 && Math.abs(a[1] - b[1]) > 0.5) segs.push({ ln, axis: "V", coord: a[0], lo: Math.min(a[1], b[1]), hi: Math.max(a[1], b[1]), i0: i, i1: i + 1 });
    else if (Math.abs(a[1] - b[1]) < 0.5 && Math.abs(a[0] - b[0]) > 0.5) segs.push({ ln, axis: "H", coord: a[1], lo: Math.min(a[0], b[0]), hi: Math.max(a[0], b[0]), i0: i, i1: i + 1 });
  } }
  const buckets = new Map();
  for (const s of segs) { const k = s.axis + ":" + Math.round(s.coord); if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(s); }
  const through = (s) => { const c0 = center(byId.get(s.ln.from)), c1 = center(byId.get(s.ln.to)); return s.axis === "V" ? (c0[0] + c1[0]) / 2 : (c0[1] + c1[1]) / 2; };
  for (const arr of buckets.values()) {
    if (arr.length < 2) continue;
    arr.sort((a, b) => through(a) - through(b) || a.lo - b.lo);
    const trackEnd = [];
    for (const s of arr) { let tr = 0; while (tr < trackEnd.length && trackEnd[tr] > s.lo + 1) tr++; if (tr === trackEnd.length) trackEnd.push(-Infinity); s.tr = tr; trackEnd[tr] = s.hi; }
    const T = trackEnd.length; if (T < 2) continue;
    const g = C.laneGap, axis = arr[0].axis, coord = arr[0].coord;
    const minOff = (0 - (T - 1) / 2) * g, maxOff = ((T - 1) - (T - 1) / 2) * g;
    let lo = Infinity, hi = -Infinity; for (const s of arr) { lo = Math.min(lo, s.lo); hi = Math.max(hi, s.hi); }
    let lb = -Infinity, rb = Infinity;
    for (const nd of rects) {
      const ov = axis === "V" ? (nd.y < hi && nd.y + nd.h > lo) : (nd.x < hi && nd.x + nd.w > lo); if (!ov) continue;
      const near0 = axis === "V" ? nd.x : nd.y, near1 = axis === "V" ? nd.x + nd.w : nd.y + nd.h;
      if (near1 <= coord + 0.5) lb = Math.max(lb, near1); if (near0 >= coord - 0.5) rb = Math.min(rb, near0);
    }
    const clear = 5, aLo = lb + clear, aHi = rb - clear, minC = coord + minOff, maxC = coord + maxOff;
    let shift = 0;
    if (maxC > aHi) shift = aHi - maxC;
    if (minC + shift < aLo) { const room = aHi - aLo, need = maxC - minC; shift = need <= room ? aLo - minC : (aLo + aHi) / 2 - (minC + maxC) / 2; }
    for (const s of arr) {
      const off = (s.tr - (T - 1) / 2) * g + shift;
      if (axis === "V") { s.ln._dx[s.i0] += off; s.ln._dx[s.i1] += off; } else { s.ln._dy[s.i0] += off; s.ln._dy[s.i1] += off; }
    }
  }
  for (const ln of lines) {
    const pts = ln._V.map((p, i) => [p[0] + ln._dx[i], p[1] + ln._dy[i]]);
    clampEnds(pts, byId.get(ln.from), ln.srcSide); clampEnds(pts, byId.get(ln.to), ln.dstSide, true);
    ln.pts = simplify(pts);
  }
}
// keep a fanned port endpoint within its node face span (perp coord already correct)
function clampEnds(pts, nd, side, last) {
  if (!nd || pts.length < 2) return;
  const i = last ? pts.length - 1 : 0, j = last ? pts.length - 2 : 1, M = 6;
  if (side === "T" || side === "B") { const x = Math.max(nd.x + M, Math.min(nd.x + nd.w - M, pts[i][0])); if (pts[j] && Math.abs(pts[j][0] - pts[i][0]) < 0.5) pts[j] = [x, pts[j][1]]; pts[i] = [x, pts[i][1]]; }
  else { const y = Math.max(nd.y + M, Math.min(nd.y + nd.h - M, pts[i][1])); if (pts[j] && Math.abs(pts[j][1] - pts[i][1]) < 0.5) pts[j] = [pts[j][0], y]; pts[i] = [pts[i][0], y]; }
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
