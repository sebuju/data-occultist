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
const W_BLOCK = 1000;   // entering a node rect
const W_CLEAR = 1.2;    // per cell short of the wanted breathing room
const W_USE = 4;        // per line already crossing a cell
const W_TURN = 3;       // changing direction
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
  route(p1, d1, p2, d2) {
    const sd = DIR_CODE[d1] ?? 1, gd = DIR_CODE[d2] ?? 0;
    // start/goal one cell outside the ports, in open space away from their own nodes
    const sx = this._cx(p1[0] + DIRS[sd][0] * this.cell), sy = this._cy(p1[1] + DIRS[sd][1] * this.cell);
    const gx = this._cx(p2[0] + DIRS[gd][0] * this.cell), gy = this._cy(p2[1] + DIRS[gd][1] * this.cell);
    const start = this._i(sx, sy), goal = this._i(gx, gy);

    const cells = this._astar(start, goal, sd);
    const centers = cells.map((i) => this._center(i % this.cols, (i / this.cols) | 0));
    // slide each port along its own node edge so the exit/entry stub is dead straight
    const a = alignPort(p1, d1, centers[0]);
    const b = alignPort(p2, d2, centers[centers.length - 1]);
    const pts = simplify([a, ...centers, b]);
    this._stamp(cells);
    return pts;
  }

  _astar(start, goal, startDir) {
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
        let step = 1 + this.clearCost[ni] + this.usage[ni] * W_USE;
        if (this.blocked[ni]) step += W_BLOCK;
        if (cd !== m) step += W_TURN;
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

  _stamp(cells) {
    // Mark only the path cells. A later route pays W_USE to share a cell but nothing
    // to sit in the cell NEXT to it — so parallel same-direction lines pack tight, one
    // cell apart, instead of being shoved far away.
    for (const i of cells) this.usage[i] += 1;
  }
}

// Keep the port on its node edge but slide it onto the first grid point's axis, so a
// horizontal exit leaves at one y and a vertical exit at one x — no kinked stub.
function alignPort(p, d, c) {
  if (!c) return p;
  return (d === "L" || d === "R") ? [p[0], c[1]] : [c[0], p[1]];
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
