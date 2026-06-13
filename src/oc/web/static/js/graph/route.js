// Orthogonal edge router for the node view. A* on a coarse grid that prefers the
// middle of gaps, keeps clear of node rects, and steers around lines already routed
// in the same pass. Obstacles are SOFT (very high cost, never impassable): a line
// that is boxed in hugs open space as far as it can, then makes a straight run
// through — instead of failing or hugging a wall. Output is a Manhattan polyline the
// caller renders as rounded or square corners.
//
// One EdgeRouter is built per draw pass over the full obstacle set, then route()d
// once per edge. A persistent usage grid means each route accounts for the ones
// already laid down, so lines bundle into neat parallel corridors rather than
// stacking on top of each other.

const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];   // L R T B, indexed 0..3
const DIR_CODE = { L: 0, R: 1, T: 2, B: 3 };

// cost weights — tuned so a turn ~= 3 cells (few corners), overlapping a used cell
// ~= a 4-cell detour (lines split apart), and entering a node only happens when
// there is genuinely no way around (run-for-it).
const W_BLOCK = 100000; // entering a node rect — huge so a line takes ANY detour over clipping a node, yet finite so a fully-boxed-in line still completes (run-for-it)
const W_CLEAR = 1.2;    // per cell short of the wanted breathing room
const W_USE = 12;       // per line already on a cell — high, so a line takes a short detour (a few
                        // cells + a couple of turns) rather than needlessly crossing/overlapping
                        // another; it still crosses when genuinely boxed in (detour costs more)
const W_TURN = 3;       // changing direction
// A CORNER landing on a cell another line already occupies is the worst for readability — you
// can't tell which line turns where. Make it very costly (but finite, so a boxed-in line still
// completes): the router gives up clearance/breathing-room (cheap, W_CLEAR) long before it
// puts a turn on top of another line. A straight crossing is still only W_USE.
const W_TURN_ON_USED = 80;
// A line must enter a port (and especially an ARROWHEAD) dead-straight from behind — a turn
// right at the port reads as the line stabbing the arrow's SIDE. The router reserves this many
// cells of straight run leaving the out-port and entering the arrow (see route()/_portCell):
// A* starts/ends that far out on each normal, so any turn it makes is pushed at least this far
// back from the port. Clamped IN toward a port that's boxed in, so such a line still completes.
const STUB_CELLS = 3;
// One ring, but as costly as a full overlap. A parallel line therefore won't sit at
// distance 1 (10px, reads as touching) — it skips to distance 2 (~20px, a clear gap).
// Distance 2+ is FREE, so there's no outward taper to scatter the lines: the clear-field
// pull toward gap centres bundles them and they lock at a consistent 2-cell spacing.
const FLANK = [1.0];   // usage added at perpendicular distance 1 (== an overlap)
const CELL_CAP = 200000;   // max grid cells — cell size grows past this

export class EdgeRouter {
  // obstacles: [{x,y,w,h}] world rects. opts: {cell, clearWanted, extra:[[x,y]...]}
  constructor(obstacles, opts = {}) {
    this.clearWanted = opts.clearWanted ?? 3;
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (const o of obstacles) {
      minx = Math.min(minx, o.x); miny = Math.min(miny, o.y);
      maxx = Math.max(maxx, o.x + o.w); maxy = Math.max(maxy, o.y + o.h);
    }
    for (const p of opts.extra || []) {
      minx = Math.min(minx, p[0]); miny = Math.min(miny, p[1]);
      maxx = Math.max(maxx, p[0]); maxy = Math.max(maxy, p[1]);
    }
    if (!Number.isFinite(minx)) { minx = miny = 0; maxx = maxy = 1; }

    let cell = opts.cell || 18;
    const pad = cell * (this.clearWanted + 4);
    this.ox = minx - pad; this.oy = miny - pad;
    const wpx = maxx - minx + pad * 2, hpx = maxy - miny + pad * 2;
    // grow the cell until the grid fits the cap (keeps big layouts responsive)
    while (Math.ceil(wpx / cell) * Math.ceil(hpx / cell) > CELL_CAP) cell *= 1.5;
    this.cell = cell;
    this.cols = Math.max(1, Math.ceil(wpx / cell));
    this.rows = Math.max(1, Math.ceil(hpx / cell));
    const N = this.cols * this.rows;

    this.blocked = new Uint8Array(N);
    this.clearCost = new Float32Array(N);
    this.usage = new Float32Array(N);
    // scratch reused across route() calls
    this.g = new Float64Array(N);
    this.came = new Int32Array(N);
    this.dir = new Int8Array(N);
    this.seen = new Int32Array(N);   // generation tag — avoids clearing N each route
    this.gen = 0;

    this._rasterize(obstacles);
    this._clearField();
  }

  _i(cx, cy) { return cy * this.cols + cx; }
  _cx(x) { return Math.min(this.cols - 1, Math.max(0, Math.floor((x - this.ox) / this.cell))); }
  _cy(y) { return Math.min(this.rows - 1, Math.max(0, Math.floor((y - this.oy) / this.cell))); }
  _center(cx, cy) { return [this.ox + (cx + 0.5) * this.cell, this.oy + (cy + 0.5) * this.cell]; }

  _rasterize(obstacles) {
    for (const o of obstacles) {
      const x0 = this._cx(o.x), x1 = this._cx(o.x + o.w);
      const y0 = this._cy(o.y), y1 = this._cy(o.y + o.h);
      for (let cy = y0; cy <= y1; cy++)
        for (let cx = x0; cx <= x1; cx++) this.blocked[this._i(cx, cy)] = 1;
    }
  }

  // Multi-source BFS out from every blocked cell, capped at clearWanted+1 rings, to
  // get each free cell's distance to the nearest node. Cells closer than the wanted
  // clearance get a penalty so routes drift to the centre of open gaps.
  _clearField() {
    const { cols, rows } = this, dist = new Int16Array(cols * rows).fill(-1);
    let frontier = [];
    for (let i = 0; i < this.blocked.length; i++) if (this.blocked[i]) { dist[i] = 0; frontier.push(i); }
    const want = this.clearWanted + 1;
    for (let d = 0; d < want && frontier.length; d++) {
      const next = [];
      for (const i of frontier) {
        const cx = i % cols, cy = (i / cols) | 0;
        for (const [dx, dy] of DIRS) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const ni = ny * cols + nx;
          if (dist[ni] !== -1) continue;
          dist[ni] = d + 1; next.push(ni);
        }
      }
      frontier = next;
    }
    for (let i = 0; i < dist.length; i++) {
      const dc = dist[i] < 0 ? this.clearWanted + 1 : dist[i];   // far cells: no penalty
      this.clearCost[i] = Math.max(0, this.clearWanted - dc) * W_CLEAR;
    }
  }

  // Route one edge. p1/p2 are world port points on the node rims, d1/d2 the outward
  // sides ("L"/"R"/"T"/"B"). Returns a simplified world polyline and stamps the path
  // into the usage grid so the next route gives it a wide berth.
  // `relax`: drop the clearance (breathing-room) penalty so the line takes the direct path
  // and runs close to neighbours instead of detouring to hug open space — used for lines
  // BETWEEN grouped nodes. Node rects stay hard obstacles (W_BLOCK), so it never draws over one.
  route(p1, d1, p2, d2, relax = false) {
    const sd = DIR_CODE[d1] ?? 1, gd = DIR_CODE[d2] ?? 0;
    // Start/goal sit STUB_CELLS out from the ports along their normals (clamped in toward the
    // port by anything in the way). A* routes between those, and p1/p2 are then appended — so
    // the segment touching each port is a guaranteed straight run of that many cells. The LINE
    // therefore always leaves the out-port and enters the arrow dead-straight from behind; any
    // turn A* makes is pushed at least STUB_CELLS back from the port, never onto the arrowhead.
    const start = this._portCell(p1, sd, STUB_CELLS), goal = this._portCell(p2, gd, STUB_CELLS);

    const cells = this._astar(start, goal, sd, relax);
    const centers = cells.map((i) => this._center(i % this.cols, (i / this.cols) | 0));
    // Attach at the EXACT node-edge centre (p1/p2), not a grid-snapped point — otherwise a
    // short node (e.g. collapsed) shows the line meeting it visibly off-centre. BUT the grid
    // start/goal sit half a cell off the port's axis, so a raw join would kink diagonally
    // right at the port. Pull the leading/trailing colinear run onto the port's axis: the
    // stub then leaves/enters dead straight and the off-axis slack is absorbed at the first
    // real turn instead of as a wart by the node.
    snapStubs(centers, p1, d1, p2, d2);
    const pts = simplify([p1, ...centers, p2]);
    this._centerJog(pts);   // near-straight lines turn in the MIDDLE, not by an endpoint
    // Hard rule: the segment touching a port must run dead-straight along that port's normal.
    // The arrowhead is auto-oriented to the final segment's tangent, so a diagonal final
    // segment rotates it and the line looks like it stabs the arrow's SIDE instead of entering
    // its flat back. Snap the endpoint's neighbour onto the port axis to force a square entry.
    straightenStub(pts, d1, true);
    straightenStub(pts, d2, false);
    this.stampPath(pts);    // reserve the FINAL drawn geometry (post-jog) so the next line avoids it
    return pts;
  }

  // A single-jog (almost straight) path is [a,b,c,d] with two colinear long runs and
  // one short perpendicular hop. Slide that hop to a lane that's clear of nodes AND not
  // already running alongside another line — centring blindly to the geometric midpoint
  // piles every parallel line's riser onto the same x (undoing the A* separation). The
  // hop is kept BETWEEN the two endpoints so the long runs only shorten, never extend
  // (an extended run could be dragged through a node), and the WHOLE resulting 3-segment
  // path is re-validated against nodes — only the hop being clear isn't enough.
  _centerJog(pts) {
    if (pts.length !== 4) return;
    const [a, b, c, d] = pts;
    // Keep the hop at least STUB away from BOTH ports so the line runs dead-straight into the
    // out-port and into the arrowhead. A turn right at an endpoint leaves the arrow looking
    // detached from its line (and the start dot off its stub). Fall back to the full span only
    // if no margined lane is clear, so we never route worse than before.
    const STUB = this.cell * 1.5;
    const band = (lo, hi) => { const a2 = Math.min(lo, hi) + STUB, b2 = Math.max(lo, hi) - STUB; return a2 <= b2 ? [a2, b2] : [lo, hi]; };
    if (a[1] === b[1] && c[1] === d[1] && b[0] === c[0]) {            // horizontal runs, vertical hop at x
      const [lo, hi] = band(a[0], d[0]);
      const x = this._bestHop(lo, hi, (x) => [
        this._laneScore(a[0], a[1], x, a[1]),   // run a→corner
        this._laneScore(x, a[1], x, d[1]),       // the hop
        this._laneScore(x, d[1], d[0], d[1]),    // run corner→d
      ]);
      if (x !== null) { b[0] = x; c[0] = x; }
    } else if (a[0] === b[0] && c[0] === d[0] && b[1] === c[1]) {     // vertical runs, horizontal hop at y
      const [lo, hi] = band(a[1], d[1]);
      const y = this._bestHop(lo, hi, (y) => [
        this._laneScore(a[0], a[1], a[0], y),
        this._laneScore(a[0], y, d[0], y),
        this._laneScore(d[0], y, d[0], d[1]),
      ]);
      if (y !== null) { b[1] = y; c[1] = y; }
    }
  }

  // Search hop coordinates from the midpoint of [lo,hi] outward, staying within the
  // endpoint span. `segs(coord)` returns the three [clear, used] segment scores of the
  // path that hop would produce. Reject any candidate whose path touches a node; among
  // the node-clear ones take the nearest-to-centre with the fewest already-used cells —
  // so parallel risers split apart, yet a lone line still turns near its middle.
  _bestHop(lo, hi, segs) {
    const mid = (lo + hi) / 2, loB = Math.min(lo, hi), hiB = Math.max(lo, hi);
    let best = null, bestScore = Infinity;
    for (let off = 0; off <= (hiB - loB) / 2 + this.cell; off += this.cell) {
      for (const cand of (off ? [mid + off, mid - off] : [mid])) {
        if (cand < loB || cand > hiB) continue;
        const parts = segs(cand);
        if (parts.some(([clear]) => !clear)) continue;   // any segment hits a node → skip
        const score = parts.reduce((s, p) => s + p[1], 0);
        if (score < bestScore) { bestScore = score; best = cand; if (score === 0) return best; }
      }
    }
    return best;
  }

  // [node-clear?, count of already-used cells] along a straight span. The two ENDPOINT
  // cells are exempt from the node-hit test: a span fed by _centerJog starts/ends at a PORT,
  // which sits on its own node's rim cell and so always reads as blocked — counting it would
  // reject every candidate lane and the jog could never re-centre off an endpoint. Exempting
  // the whole rim cell (not just the exact sample) is needed because the port is mid-cell, so
  // samples within half a cell of it map to the same blocked cell. A span that truly crosses
  // a node still blocks INTERIOR cells, so this can't miss a real intrusion.
  _laneScore(x1, y1, x2, y2) {
    const steps = Math.ceil(Math.hypot(x2 - x1, y2 - y1) / (this.cell / 2)) || 1;
    const c0 = this._i(this._cx(x1), this._cy(y1)), c1 = this._i(this._cx(x2), this._cy(y2));
    let used = 0;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const i = this._i(this._cx(x1 + (x2 - x1) * t), this._cy(y1 + (y2 - y1) * t));
      if (this.blocked[i] && i !== c0 && i !== c1) return [false, 0];
      if (this.usage[i] > 0) used++;
    }
    return [true, used];
  }

  // Cost of routing an edge between these ports, WITHOUT building/stamping a path —
  // just the A* g-score at the goal. Lets the caller pick the cheapest-to-route pair of
  // node sides instead of guessing by raw distance: a side that faces a wall or forces a
  // long detour scores worse than a slightly-farther side with a clear run. Reflects the
  // corridors already stamped this pass, so a side is also penalised for piling onto
  // lines already there. Infinity only if truly unreachable (soft obstacles → rare).
  routeCost(p1, d1, p2, d2, relax = false) {
    const sd = DIR_CODE[d1] ?? 1, gd = DIR_CODE[d2] ?? 0;
    const goal = this._portCell(p2, gd, STUB_CELLS);
    this._astar(this._portCell(p1, sd, STUB_CELLS), goal, sd, relax);   // fills g[]/seen[] for this gen
    return this.seen[goal] === this.gen ? this.g[goal] : Infinity;
  }

  // The grid cell `k` cells out from port `p` along outward direction `di`, clamped IN toward
  // the port so the straight run from the port to that cell never crosses a node (stop one
  // cell before the first blocked/out-of-range cell). Floor of 1 cell (the old behaviour).
  _portCell(p, di, k) {
    const dx = DIRS[di][0], dy = DIRS[di][1];
    let cell = this._i(this._cx(p[0] + dx * this.cell), this._cy(p[1] + dy * this.cell));
    for (let kk = 2; kk <= k; kk++) {
      const cx = this._cx(p[0] + dx * this.cell * kk), cy = this._cy(p[1] + dy * this.cell * kk);
      const i = this._i(cx, cy);
      if (this.blocked[i]) break;
      cell = i;
    }
    return cell;
  }

  _astar(start, goal, startDir, relax = false) {
    const { cols, rows, g, came, dir, seen } = this;
    const gen = ++this.gen;
    const gxc = goal % cols, gyc = (goal / cols) | 0;
    const heap = new MinHeap();
    g[start] = 0; came[start] = -1; dir[start] = startDir; seen[start] = gen;
    heap.push(start, this._h(start % cols, (start / cols) | 0, gxc, gyc));

    while (heap.size) {
      const cur = heap.pop();
      if (cur === goal) break;
      const cx = cur % cols, cy = (cur / cols) | 0, gc = g[cur], cd = dir[cur];
      for (let m = 0; m < 4; m++) {
        const nx = cx + DIRS[m][0], ny = cy + DIRS[m][1];
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const ni = ny * cols + nx;
        // `relax` drops the clearance term so grouped lines don't pay to hug open space;
        // usage (other lines) and W_BLOCK (node rects) still apply — never draw over a node.
        let step = 1 + (relax ? 0 : this.clearCost[ni]) + this.usage[ni] * W_USE;
        if (this.blocked[ni]) step += W_BLOCK;
        // a turn corners at `cur`; never put that corner on top of another line if avoidable.
        // (Straight port/arrow stubs are guaranteed geometrically by _portCell, not here.)
        if (cd !== m) step += W_TURN + (this.usage[cur] > 0 ? W_TURN_ON_USED : 0);
        const ng = gc + step;
        if (seen[ni] !== gen || ng < g[ni]) {
          seen[ni] = gen; g[ni] = ng; came[ni] = cur; dir[ni] = m;
          heap.push(ni, ng + this._h(nx, ny, gxc, gyc));
        }
      }
    }
    if (seen[goal] !== gen) return [start, goal];   // unreachable guard (shouldn't happen: soft obstacles)
    const path = [];
    for (let c = goal; c !== -1; c = came[c]) { path.push(c); if (c === start) break; }
    path.reverse();
    return path;
  }

  _h(cx, cy, gx, gy) { return Math.abs(cx - gx) + Math.abs(cy - gy); }

  // Reserve an already-computed polyline (a kept/cached route) in the usage grid so
  // freshly-routed lines bundle beside it and don't draw over it. Used by incremental
  // re-routing, where most lines are unchanged and only a few are recomputed.
  stampPath(pts) {
    if (!pts || pts.length < 2) return;
    const seen = new Set(), cells = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const steps = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / this.cell) || 1;
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const idx = this._i(this._cx(a[0] + (b[0] - a[0]) * t), this._cy(a[1] + (b[1] - a[1]) * t));
        if (!seen.has(idx)) { seen.add(idx); cells.push(idx); }
      }
    }
    this._stamp(cells);
  }

  _stamp(cells) {
    // Mark the path cells (W_USE keeps later routes off them entirely) and a TAPERING
    // cost on a band of flank cells out to FLANK.length rings. The near ring is strong
    // so parallel lines don't hug at 1 cell when there's open space to spread into; the
    // outer rings taper so lines fan apart where it's free yet a boxed-in line can still
    // pay the toll and squeeze through rather than take a long detour.
    const R = FLANK.length;
    for (const i of cells) {
      this.usage[i] += 1;
      const cx = i % this.cols, cy = (i / this.cols) | 0;
      for (let dy = -R; dy <= R; dy++) {
        const ny = cy + dy;
        if (ny < 0 || ny >= this.rows) continue;
        for (let dx = -R; dx <= R; dx++) {
          const nx = cx + dx, d = Math.abs(dx) + Math.abs(dy);
          if (d === 0 || d > R || nx < 0 || nx >= this.cols) continue;
          this.usage[ny * this.cols + nx] += FLANK[d - 1];
        }
      }
    }
  }
}

// Pull the grid centres that run colinear with each port's exit onto that port's own axis,
// so the stub leaves/enters dead straight (the grid centres sit half a cell off the port
// axis). For an L/R exit the line runs horizontally, so its leading cells share a y; rewrite
// that y to the port's y. The leading run is snapped to p1, the trailing run to p2.
//
// The two ports are snapped TOGETHER (not by two independent passes) because of one
// degenerate case: when both ports exit the SAME orientation but at different perpendicular
// coords, A* returns a single straight corridor that IS both the leading and the trailing
// run. Snapping it to p1 then to p2 just makes the second win — the path leaves one port on a
// diagonal (the line feeds the port/arrow from the side). Detect that overlap and split the
// run at its midpoint instead: each half takes its own port's coord and the step between them
// becomes a clean mid-run jog (later re-centred by _centerJog).
function snapStubs(centers, p1, d1, p2, d2) {
  const n = centers.length;
  if (!n) return;
  const ax1 = (d1 === "L" || d1 === "R") ? 1 : 0;
  const ax2 = (d2 === "L" || d2 === "R") ? 1 : 0;
  let lead = 1;  while (lead < n && centers[lead][ax1] === centers[0][ax1]) lead++;
  let trail = 1; while (trail < n && centers[n - 1 - trail][ax2] === centers[n - 1][ax2]) trail++;
  if (ax1 === ax2 && lead + trail > n) {            // one straight run shared by both ports
    const mid = n >> 1, mv = ax1 ^ 1;               // mv: axis the run travels along
    for (let i = 0; i < mid; i++) centers[i][ax1] = p1[ax1];
    for (let i = mid; i < n; i++) centers[i][ax2] = p2[ax2];
    if (mid > 0) centers[mid][mv] = centers[mid - 1][mv];   // square the jog (shared travel coord) so it's a clean step, not a diagonal
    return;
  }
  for (let i = 0; i < lead; i++) centers[i][ax1] = p1[ax1];
  for (let i = n - trail; i < n; i++) centers[i][ax2] = p2[ax2];
}

// Force the segment touching a port to run dead-straight along the port normal, so the
// auto-oriented arrowhead's flat back faces the line (a diagonal final segment rotates the
// marker and looks like the line stabs the arrow's side). ONLY the endpoint's inward neighbour
// is snapped onto the port axis — no geometry is pushed outward (that ran blind into other
// lines). A clear straight lead-in comes from the router's collision-aware approach instead.
function straightenStub(pts, d, fromStart) {
  const n = pts.length;
  if (n < 2) return;
  const ax = (d === "L" || d === "R") ? 1 : 0;   // coordinate held constant along the normal
  const e = fromStart ? pts[0] : pts[n - 1];
  const nb = fromStart ? pts[1] : pts[n - 2];
  const prev = nb[ax];
  nb[ax] = e[ax];
  if (nb[0] === e[0] && nb[1] === e[1]) nb[ax] = prev;   // don't create a zero-length stub
}

// Drop collinear midpoints so straight runs are single segments (neatness).
function simplify(pts) {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out[out.length - 1], b = pts[i], c = pts[i + 1];
    const collinear = (a[0] === b[0] && b[0] === c[0]) || (a[1] === b[1] && b[1] === c[1]);
    if (!collinear) out.push(b);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

// Build an SVG path from a polyline. corners "square" → sharp L joints; anything
// else → arc-rounded corners of up to `radius`.
export function polylinePath(pts, corners = "curve", radius = 14) {
  if (!pts || pts.length < 2) return "";
  if (pts.length === 2 || corners === "square")
    return "M " + pts.map((p) => `${r(p[0])} ${r(p[1])}`).join(" L ");
  let d = `M ${r(pts[0][0])} ${r(pts[0][1])}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1];
    const rad = Math.min(radius, len(a, b) / 2, len(b, c) / 2);
    const pin = toward(b, a, rad), pout = toward(b, c, rad);
    d += ` L ${r(pin[0])} ${r(pin[1])} Q ${r(b[0])} ${r(b[1])} ${r(pout[0])} ${r(pout[1])}`;
  }
  const e = pts[pts.length - 1];
  d += ` L ${r(e[0])} ${r(e[1])}`;
  return d;
}

const r = (n) => Math.round(n * 10) / 10;
const len = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
function toward(from, to, dist) {
  const l = len(from, to) || 1;
  return [from[0] + (to[0] - from[0]) * (dist / l), from[1] + (to[1] - from[1]) * (dist / l)];
}

// Tiny binary min-heap of cell indices keyed by f-score.
class MinHeap {
  constructor() { this.idx = []; this.f = []; }
  get size() { return this.idx.length; }
  push(i, f) {
    const a = this.idx, b = this.f; let n = a.length;
    a.push(i); b.push(f);
    while (n > 0) { const p = (n - 1) >> 1; if (b[p] <= b[n]) break; this._swap(n, p); n = p; }
  }
  pop() {
    const a = this.idx, b = this.f, top = a[0], last = a.length - 1;
    a[0] = a[last]; b[0] = b[last]; a.pop(); b.pop();
    let n = 0, len = a.length;
    while (true) {
      const l = 2 * n + 1, rr = l + 1; let s = n;
      if (l < len && b[l] < b[s]) s = l;
      if (rr < len && b[rr] < b[s]) s = rr;
      if (s === n) break; this._swap(n, s); n = s;
    }
    return top;
  }
  _swap(i, j) { const a = this.idx, b = this.f; [a[i], a[j]] = [a[j], a[i]]; [b[i], b[j]] = [b[j], b[i]]; }
}
