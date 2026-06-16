// Edge routing + drawing: builds the unified link list, picks ports/sides, fans shared
// endpoints, runs the cached A* orthogonal router (route.js), and paints one persistent
// <path> per link (with live morphing under a drag). Split out of main.js.
//
// Owns the routing-freeze flag (OCR pauses re-routing) and the drag-sync flag; main.js
// flips the drag flag via setDraggingNodes(). Reads selectedNodeId/wire and calls
// startWire from main.js (live bindings, runtime-safe circular import).
import * as groups from "./groups.js";
import { routeGraph, polylinePath } from "./route.js";
import { $, setStatus, model, nodeEls, pos, nw, nh } from "./state.js";
import { selectedNodeId, wire, startWire, CAN_DISABLE } from "./main.js";

// Port exit directions (L/R/T/B) -> unit vector, used to stub a line out of a port the
// right way before it turns. Lines are ALWAYS orthogonal — no bezier fallback exists.
const _DIROFF = { L: [-1, 0], R: [1, 0], T: [0, -1], B: [0, 1] };

// Orthogonal elbow between two ports — the instant fallback shown until A* routes the line.
// Replaces the old direct bezier so a curved line is NEVER drawn: a short stub leaves each
// port along its facing direction, then one right-angle connects the stubs. Same point list
// the router emits, so polylinePath renders it in the identical (rounded-corner) 90° style.
function dirElbowPts(x1, y1, d1, x2, y2, d2) {
  const k = 16;
  const a = _DIROFF[d1] || [0, 0], b = _DIROFF[d2] || [0, 0];
  const s1 = [x1 + a[0] * k, y1 + a[1] * k];   // stub out of the source port
  const s2 = [x2 + b[0] * k, y2 + b[1] * k];   // stub into the target port
  // turn axis: if the source exits horizontally, run horizontal-then-vertical, else the reverse
  const corner = a[0] !== 0 ? [s2[0], s1[1]] : [s1[0], s2[1]];
  return [[x1, y1], s1, corner, s2, [x2, y2]];
}

// Resample a polyline to n+1 points spread evenly by arc length — so two shapes with
// different vertex counts can be lerped point-for-point during a morph.
function resamplePoly(pts, n) {
  if (pts.length < 2) return Array.from({ length: n + 1 }, () => (pts[0] || [0, 0]).slice());
  const seg = []; let total = 0;
  for (let i = 0; i < pts.length - 1; i++) { const l = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]); seg.push(l); total += l; }
  if (total === 0) return Array.from({ length: n + 1 }, () => pts[0].slice());
  const out = []; let si = 0, acc = 0;
  for (let i = 0; i <= n; i++) {
    const target = (total * i) / n;
    while (si < seg.length - 1 && acc + seg[si] < target) { acc += seg[si]; si++; }
    const t = seg[si] ? (target - acc) / seg[si] : 0;
    out.push([pts[si][0] + (pts[si + 1][0] - pts[si][0]) * t, pts[si][1] + (pts[si + 1][1] - pts[si][1]) * t]);
  }
  return out;
}
const straightD = (pts) => "M " + pts.map((p) => `${Math.round(p[0] * 10) / 10} ${Math.round(p[1] * 10) / 10}`).join(" L ");

// Closest-facing sides of two rects (shortest centre axis): the port point and
// outward direction (L/R/T/B) on each. The geometric default — used for the live drag
// bezier and as the fallback before the router has scored a better pair of sides.
function facingSides(ra, rb) {
  const acx = ra.x + ra.w / 2, acy = ra.y + ra.h / 2, bcx = rb.x + rb.w / 2, bcy = rb.y + rb.h / 2;
  const dx = bcx - acx, dy = bcy - acy;
  if (Math.abs(dx) >= Math.abs(dy)) {
    if (dx >= 0) return { p1: [ra.x + ra.w, acy], d1: "R", p2: [rb.x, bcy], d2: "L" };
    return { p1: [ra.x, acy], d1: "L", p2: [rb.x + rb.w, bcy], d2: "R" };
  }
  if (dy >= 0) return { p1: [acx, ra.y + ra.h], d1: "B", p2: [bcx, rb.y], d2: "T" };
  return { p1: [acx, ra.y], d1: "T", p2: [bcx, rb.y + rb.h], d2: "B" };
}


const nodeRect = (id) => { const p = pos.get(id); return p && { x: p.x, y: p.y, w: nw(id), h: nh(id) }; };

// ---- one unified link list -------------------------------------------------
// EVERY connection in the view is the same thing: a line between two NODES — always to
// the node rect, never to a box on the image. They all flow through buildLinks →
// routing → drawn on a persistent per-link <path>. No bespoke per-kind drawing.
function selClsFor(aId, bId) {
  return selectedNodeId && (aId === selectedNodeId || bId === selectedNodeId) ? " sel" : "";
}

// Build the descriptor for every line. `aId`/`bId` name each rect's owner (used to
// fan endpoints that share a node side); `ra`/`rb` are the world rects.
// A data edge always leaves its source node's `.port.out` handle. Every source that draws
// one — window, price, dataset, view (subset) — anchors its data line at the port dot and
// gets the animated flow. (Keep this prefix set in sync with `outPortSpec`.)
const PORT_OUT_SRC = ["win:", "price:", "ds:", "sub:"];
// a data edge leaves its source's out-port; a trigger's control edges (fires + watch) leave the
// trigger's out-ports too — `fires` from the RIGHT `.port.out`, `watch` from the LEFT `.port.pwatch`.
const fromPortOut = (aId, kind) =>
  (kind === "data" && PORT_OUT_SRC.some((p) => aId.startsWith(p))) ||
  ((kind === "trigger" || kind === "watch") && aId.startsWith("trigger:"));
function buildLinks() {
  const links = [];
  const add = (key, aId, bId, top, kind, ra, rb) => {
    if (!ra || !rb) return;
    const port = fromPortOut(aId, kind);
    const flow = port && kind !== "watch";   // watch keeps its own dotted/diamond look, not the data flow arrow
    const tgt = bId.startsWith("sub:") ? " toview" : "";
    const own = kind === "own" && bId.startsWith("win:") ? " ownwin" : "";   // game→window owns the window's accent tint
    const portKind = kind === "watch" ? "watch" : "out";   // which port element this line leaves (`.port.pwatch` vs `.port.out`)
    // EVERY line ends in a glyph (squarecap by default, else arrow/chevron/diamond); they all
    // draw on the top layer so the end glyph sits OVER the node instead of being hidden behind
    // its card (edges z1 < nodes z2 < top z5).
    const over = true;
    links.push({ key, aId, bId, top, over, port, portKind, cls: `gedge ${kind}${flow ? " flow" : ""}${tgt}${own}${selClsFor(aId, bId)}`, ra, rb });
  };
  for (const e of model.edges())
    add(`${e.from} ${e.to}`, e.from, e.to, !!selClsFor(e.from, e.to), e.kind, nodeRect(e.from), nodeRect(e.to));
  computePorts(links);
  return links;
}

// Pick each line's port + side, then fan endpoints that share a node side so they sit
// one GAP apart instead of all stacking on the side's midpoint.
const GAP = () => ROUTE.cell * 2;   // preferred spacing: fanned endpoints AND parallel bundles (a line can still squeeze to 1 cell between two)
const MIN_PORT_GAP = 11;   // hard floor between adjacent fanned port dots (dot is 8px) — never let them overlap
// both node ids belong to the same (non-null) group
function sameGroup(aId, bId) { const g = groups.groupOf(aId); return !!g && g === groups.groupOf(bId); }
function computePorts(links) {
  for (const l of links) {
    // geometric facing — the pre-route default for a brand-new line; the router picks the real
    // faces (and the routed result's ports override these in drawEdges/runRouting).
    const f = facingSides(l.ra, l.rb);
    l.p1 = f.p1; l.d1 = f.d1; l.p2 = f.p2; l.d2 = f.d2;
    // port lines leave a pinned face (the port dot); pin the pre-route default to match what the
    // router will pick (route.js pinSrc) so the elbow doesn't flip. `watch` leaves the LEFT
    // `.port.pwatch`; every other port line leaves the RIGHT `.port.out`.
    if (l.port) {
      if (l.portKind === "watch") { l.d1 = "L"; l.p1 = [l.ra.x, l.ra.y + l.ra.h / 2]; }
      else { l.d1 = "R"; l.p1 = [l.ra.x + l.ra.w, l.ra.y + l.ra.h / 2]; }
    }
    l.align = false;
    l.relax = sameGroup(l.aId, l.bId);
  }
  // Grouped nodes read as a single unit, so the "ports sit at the edge centre" rule is relaxed
  // for lines BETWEEN members of the same group: if their facing sides share an axis, slide
  // both ports to a common coordinate inside the rects' overlap → the connector runs dead
  // straight instead of doglegging to two centres. Aligned ports skip the fan below.
  for (const l of links) {
    if (!sameGroup(l.aId, l.bId)) continue;
    const horiz = (l.d1 === "L" || l.d1 === "R") && (l.d2 === "L" || l.d2 === "R");
    const vert = (l.d1 === "T" || l.d1 === "B") && (l.d2 === "T" || l.d2 === "B");
    if (!horiz && !vert) continue;
    const ax = horiz ? 1 : 0;   // perpendicular axis to align on
    const aLo = ax ? l.ra.y : l.ra.x, aHi = aLo + (ax ? l.ra.h : l.ra.w);
    const bLo = ax ? l.rb.y : l.rb.x, bHi = bLo + (ax ? l.rb.h : l.rb.w);
    const lo = Math.max(aLo, bLo), hi = Math.min(aHi, bHi);
    if (lo > hi) continue;      // no overlap → can't straighten, keep the centred ports
    const c = (lo + hi) / 2;
    l.p1[ax] = c; l.p2[ax] = c;
    l.align = true;
  }
  const buckets = new Map();   // `${owner}|${dir}` -> endpoints on that rect side
  const put = (owner, dir, l, end, other) => {
    const horiz = dir === "L" || dir === "R";
    const perp = horiz ? other.y + other.h / 2 : other.x + other.w / 2;
    const k = `${owner}|${dir}`;
    (buckets.get(k) || buckets.set(k, []).get(k)).push({ l, end, perp, horiz });
  };
  for (const l of links) {
    if (l.align) continue;   // grouped straight lines keep their off-centre ports — don't fan them
    put(l.aId, l.d1, l, "a", l.rb); put(l.bId, l.d2, l, "b", l.ra);
  }
  const gap = GAP();
  for (const arr of buckets.values()) {
    if (arr.length < 2) continue;
    arr.sort((u, v) => u.perp - v.perp);   // order by where each other end sits → no crossing
    const n = arr.length;
    arr.forEach((it, i) => {
      const rect = it.end === "a" ? it.l.ra : it.l.rb;
      const lo = it.horiz ? rect.y : rect.x, span = it.horiz ? rect.h : rect.w;
      // preferred = one GAP apart, kept just inside the edge; but never below the no-overlap
      // floor — when the edge can't hold N dots at GAP, fall back to MIN_PORT_GAP (overflowing
      // the edge only if even that won't fit) instead of squeezing them on top of each other.
      const pref = Math.min(span - MIN_PORT_GAP, (n - 1) * gap);
      const spread = Math.max(0, pref, (n - 1) * MIN_PORT_GAP);
      const coord = lo + span / 2 - spread / 2 + (i * spread) / (n - 1);
      const port = it.end === "a" ? it.l.p1 : it.l.p2;
      if (it.horiz) port[1] = coord; else port[0] = coord;
    });
  }
  // A line may share an EDGE with a node's out-port, but must not END directly OVER the out-port
  // dot. The dot sits where the node's outgoing line starts (its p1). Nudge any incoming end that
  // landed on the same side AND ~same coord as that dot just clear of it (kept on the edge).
  const outDot = new Map();   // nodeId -> { dir, coord } of its out-port dot
  for (const l of links) {
    if (outDot.has(l.aId)) continue;
    const horiz = l.d1 === "L" || l.d1 === "R";
    outDot.set(l.aId, { dir: l.d1, coord: horiz ? l.p1[1] : l.p1[0] });
  }
  for (const l of links) {
    const od = outDot.get(l.bId);
    if (!od || od.dir !== l.d2) continue;            // different edge → no conflict
    const horiz = l.d2 === "L" || l.d2 === "R";
    const cur = horiz ? l.p2[1] : l.p2[0];
    if (Math.abs(cur - od.coord) >= gap * 0.5) continue;   // already clear of the dot
    const lo = horiz ? l.rb.y : l.rb.x, hi = lo + (horiz ? l.rb.h : l.rb.w);
    const want = od.coord + (cur >= od.coord ? gap : -gap);
    const v = Math.max(lo + 4, Math.min(hi - 4, want));
    if (horiz) l.p2[1] = v; else l.p2[0] = v;
  }
}

// Per-line port dots: EVERY port line gets its OWN dot at BOTH ends — the source end (where it
// leaves a node, a draggable handle) and the destination end (where it arrives). A node fanning N
// lines shows N dots, one per line, never all stacked on one point. Each dot FOLLOWS its line: the
// router (fanFaceEnds) picks the coord, the dot moves onto that node-relative point.

// Position + colour one dot at a world point, relative to its node's rect. (-1: the dot lives in the
// node's PADDING box inside its 1px border, but the point/rect are border-box world coords.)
function styleDot(dot, pt, rect, cls) {
  dot.style.left = `${pt[0] - rect.x - 1}px`;
  dot.style.top = `${pt[1] - rect.y - 1}px`;
  dot.style.right = "auto";
  dot.style.transform = "translate(-50%, -50%)";
  const sel = cls.includes(" sel");
  dot.classList.toggle("sel", sel);   // edge selected (either end) -> accent (CSS clears inline bg)
  dot.style.background = sel ? ""
    : cls.includes("trigger") ? "var(--trigger-line)"
    : cls.includes("watch") ? "var(--watch-line)"
    : "#ff8c2b";   // data orange
}

// Grow/shrink a pool of source-dot clones off `base` (the drag handle = dot #0); clones get
// `extraCls` and re-wire `spec` (listeners aren't cloned). Returns [base, ...clones].
function ensurePortDots(node, count, base, extrasSel, extraCls, spec) {
  let extras = [...node.querySelectorAll(extrasSel)];
  while (extras.length < count - 1) {
    const d = base.cloneNode(false);
    d.classList.add(extraCls);
    if (spec && node._outId) d.addEventListener("mousedown", (ev) => startWire(node._outId, ev, spec));
    node.appendChild(d); extras.push(d);
  }
  for (let i = count - 1; i < extras.length; i++) extras[i].remove();
  return [base, ...extras.slice(0, Math.max(0, count - 1))];
}

// One source-dot family (the `.port.out` fires/data handle, or the `.port.pwatch` watch handle):
// fan a dot per line onto its start; when idle, drop clones and park the handle at its CSS home.
function placeSrcDots(node, lines, baseSel, extrasSel, extraCls, spec) {
  const base = node.querySelector(baseSel);
  if (!base) return;
  if (!lines || !lines.length) {   // idle handle: no line uses it — show only on node hover (.port-idle)
    node.querySelectorAll(extrasSel).forEach((d) => d.remove());
    if (base.style.left || base.style.top) { base.style.cssText = ""; base.classList.remove("sel"); }
    base.classList.add("port-idle");
    return;
  }
  base.classList.remove("port-idle");
  const dots = ensurePortDots(node, lines.length, base, extrasSel, extraCls, spec);
  lines.forEach((l, i) => { if (dots[i]) styleDot(dots[i], l.p1, l.ra, l.cls); });
}

// Only the SOURCE end shows a dot (the draggable port handle). The arriving end is laid out by the
// router (fanFaceEnds spaces every landing point), but draws no sphere — the line just meets the edge.
function placePortDots(links) {
  const srcOut = new Map(), srcWatch = new Map();
  const push = (m, id, l) => (m.get(id) || m.set(id, []).get(id)).push(l);
  for (const l of links) {
    if (!l.port) continue;
    push(l.portKind === "watch" ? srcWatch : srcOut, l.aId, l);   // leaving end -> source family
  }
  for (const [id, node] of nodeEls) {
    placeSrcDots(node, srcOut.get(id), ".port.out:not(.port-extra)", ".port.out.port-extra", "port-extra", node._outSpec);
    placeSrcDots(node, srcWatch.get(id), ".port.pwatch:not(.pw-extra)", ".port.pwatch.pw-extra", "pw-extra", node._watchSpec);
  }
}

// Persistent <path> per link (NOT rebuilt each draw) — lets a line keep its identity
// so it can follow the cursor live, then morph into its routed shape on settle.
const edgeEls = new Map();   // link key -> <path>
let wireEl = null;
let tweenRoutes = false;     // set by runRouting so the NEXT draw morphs the lines that changed

function edgeEl(key, layer) {
  let el = edgeEls.get(key);
  if (!el) { el = document.createElementNS(SVGNS, "path"); edgeEls.set(key, el); }
  if (el.parentNode !== layer) layer.appendChild(el);
  return el;
}
function cancelMorph(el) { if (el && el._raf) { cancelAnimationFrame(el._raf); el._raf = null; } }
function setRouted(el, pts) {
  cancelMorph(el);
  el._geo = pts; el._routed = true;
  el.setAttribute("d", polylinePath(pts, ROUTE.corners, ROUTE.radius));
}
function setBezier(el, l) {   // name kept (one caller); draws an ORTHOGONAL elbow, never a curve
  cancelMorph(el);
  const pts = dirElbowPts(l.p1[0], l.p1[1], l.d1, l.p2[0], l.p2[1], l.d2);
  el._geo = pts;
  el._routed = false;
  el.setAttribute("d", polylinePath(pts, ROUTE.corners, ROUTE.radius));
}

const MORPH_MS = 150, MORPH_N = 32;
function startMorph(el, toPts) {
  const from = resamplePoly(el._geo && el._geo.length ? el._geo : toPts, MORPH_N);
  const to = resamplePoly(toPts, MORPH_N);
  cancelMorph(el);
  const t0 = performance.now();
  const tick = (now) => {
    let t = (now - t0) / MORPH_MS; if (t < 0) t = 0; if (t > 1) t = 1;
    const e = t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;   // easeInOutQuad
    el.setAttribute("d", straightD(from.map((p, i) => [p[0] + (to[i][0] - p[0]) * e, p[1] + (to[i][1] - p[1]) * e])));
    if (t < 1) el._raf = requestAnimationFrame(tick);
    else { el._raf = null; setRouted(el, toPts); }   // land on the crisp rounded route
  };
  el._raf = requestAnimationFrame(tick);
}
function geoChanged(el, pts) {
  if (!el._routed || !el._geo || el._geo.length !== pts.length) return true;
  for (let i = 0; i < pts.length; i++)
    if (Math.abs(el._geo[i][0] - pts[i][0]) > 0.5 || Math.abs(el._geo[i][1] - pts[i][1]) > 0.5) return true;
  return false;
}

let drawSig = "";   // link signature for THIS draw (compared against the route cache's)
// True while a node is being dragged. The line MODE never changes (always the A* 90° route);
// this only makes routing run SYNCHRONOUSLY each frame instead of one rAF later, so the route
// is recomputed and painted in the same frame the node moves — the line stays glued to the
// node (smooth) instead of trailing it by a frame. Per-frame routing cost is accepted.
let draggingNodes = false;
function drawEdges() {
  const svg = $("gedges"), top = $("gedges-top");
  const links = buildLinks();
  drawSig = ROUTE.enabled ? linksSig(links) : "";   // change-gate: from the geometric facing ports
  // adopt the routed result's chosen faces/ports so the port dots + freshness check line up with
  // the painted path (the router, not the facing default, owns a routed line's endpoints).
  for (const l of links) { const c = routeCache.get(l.key); if (c && c.p1) { l.p1 = c.p1; l.d1 = c.d1; l.p2 = c.p2; l.d2 = c.d2; } }
  placePortDots(links);   // move each out-port dot onto where its line actually starts
  const used = new Set();
  // node ids that are turned off — any line touching one is greyed (carries no live data)
  const disSet = new Set();
  for (const n of model.nodes()) if (CAN_DISABLE.has(n.type) && n.ref && n.ref.enabled === false) disSet.add(n.id);
  for (const l of links) {
    used.add(l.key);
    const el = edgeEl(l.key, (l.top || l.over) ? top : svg);
    el.setAttribute("class", l.cls + (disSet.has(l.aId) || disSet.has(l.bId) ? " dis-edge" : ""));
    const c = routeCache.get(l.key);
    if (c && c.pts.length >= 2) {                            // have a routed path for this line
      if (tweenRoutes && geoChanged(el, c.pts)) startMorph(el, c.pts);
      else if (!el._raf && geoChanged(el, c.pts)) setRouted(el, c.pts);   // only redraw if it changed; leave morphs alone
    } else if (!el.getAttribute("d")) {
      // BRAND-NEW line only (no path yet): give it an initial orthogonal elbow so it isn't
      // invisible until the router runs. A line that already has a path keeps it — we never
      // repaint a provisional stage over a routed line, so nothing flashes; the A* below
      // updates it straight to the next FINISHED route.
      setBezier(el, l);
    }
  }
  for (const [k, el] of edgeEls) if (!used.has(k)) { cancelMorph(el); el.remove(); edgeEls.delete(k); }
  if (wire) {
    if (!wireEl) wireEl = document.createElementNS(SVGNS, "path");
    if (wireEl.parentNode !== svg) svg.appendChild(wireEl);
    wireEl.setAttribute("class", "gedge wire");
    const dx = Math.max(30, (wire.x2 - wire.x1) / 2);
    wireEl.setAttribute("d", `M ${wire.x1} ${wire.y1} C ${wire.x1 + dx} ${wire.y1}, ${wire.x2 - dx} ${wire.y2}, ${wire.x2} ${wire.y2}`);
  } else if (wireEl) { wireEl.remove(); wireEl = null; }
  tweenRoutes = false;
  scheduleRouting();   // pathfind to the 90° route; lines only ever paint a FINISHED route
}

// Coalesce edge redraws under a drag: each requestEdges() queues at most ONE redraw per
// animation frame, so the many mousemove events in a frame collapse to a single drawEdges()
// that paints the LATEST node positions (pos is mutated in place before this is called). The
// pending rAF IS the request — newer calls ride it instead of stacking a stale one behind it.
let _edgeRaf = 0;
function requestEdges() {
  if (_edgeRaf) return;   // a redraw is already queued; it'll read the newest positions when it runs
  _edgeRaf = requestAnimationFrame(() => {
    _edgeRaf = 0;
    // While dragging, route IN this frame (runRouting computes the route then paints) so the
    // line is current the same frame the node moves. Otherwise just paint + defer routing to rAF.
    if (draggingNodes) runRouting(); else drawEdges();
  });
}
function flushEdges() {   // force the final frame now (drop on settle) — cancels any pending rAF
  if (_edgeRaf) { cancelAnimationFrame(_edgeRaf); _edgeRaf = 0; }
  drawEdges();
}

// ---- live line routing -----------------------------------------------------
// Pathfinding runs every animation frame, as fast as the browser will paint:
// drawEdges() paints direct beziers instantly for any line whose route is stale and
// requests a recompute; the A* then fires on the next rAF and repaints with neat
// routed paths — so lines re-route LIVE under a drag, not only on settle. Routing is
// incremental + cached (only links whose deps changed re-run) and gated by a layout
// signature, so a frame where nothing moved is a no-op and the loop idles.
const ROUTE = {
  enabled: true,
  corners: "curve",   // "curve" | "square" — internal toggle (window.__route.corners)
  cell: 10,           // grid resolution (world px) — fine enough to squeeze a line between two others
  clearWanted: 5,     // cells of breathing room a line prefers around nodes
  radius: 14,         // corner rounding for "curve"
};
// internal handles: tweak ROUTE in the console, __reroute() to force a recompute
// (e.g. after flipping __route.corners to "square").
if (typeof window !== "undefined") {
  window.__route = ROUTE;
  window.__reroute = () => { routeCache = new Map(); routeHash = ""; drawEdges(); };   // force a full recompute
}

const SVGNS = "http://www.w3.org/2000/svg";
let routeCache = new Map();     // link key -> { pts:[[x,y]…], sig } (sig = its own deps)
let routeHash = "";             // global layout signature of the last pass (cheap change gate)
let routeRaf = null;            // pending requestAnimationFrame handle (one in flight at a time)

// Everything physical is an obstacle: nodes AND panels. Lines weave around all of
// them, not just the two rects they connect.
function obstacleRects() {
  const out = [];
  for (const n of model.nodes()) { const r = nodeRect(n.id); if (r) out.push(r); }
  for (const t of groups.titleRects()) out.push(t);   // lines prefer not to cross a group title
  return out;
}

// Signature that invalidates the route cache: the ports of every link plus every
// obstacle rect. Any move/resize/open/close changes it (a moved node can reshape a
// route it isn't even an endpoint of, so obstacles must be in here too).
const rnd = (p) => `${Math.round(p[0])},${Math.round(p[1])}`;
function linksSig(links) {
  let s = `${ROUTE.cell}:${ROUTE.clearWanted}:`;
  for (const l of links) s += `${l.key}@${rnd(l.p1)}${l.d1}${rnd(l.p2)}${l.d2};`;
  for (const o of obstacleRects()) s += `${o.x},${o.y},${o.w},${o.h}|`;
  return s;
}

function scheduleRouting() {
  if (!ROUTE.enabled) return;
  if (routingFrozen) return;           // OCR in progress -> don't re-route (lines would wiggle)
  if (drawSig === routeHash) return;   // routes already current (drawSig set in drawEdges)
  if (routeRaf) return;                // one recompute already queued for the next frame
  routeRaf = requestAnimationFrame(runRouting);
}

function runRouting() {
  routeRaf = null;                     // this frame's pass is running; let drawEdges queue the next one
  const links = buildLinks();          // route the layout as it stands NOW
  const sig = linksSig(links);
  if (sig === routeHash) return;       // nothing moved since the last pass
  try {
    // The whole graph is routed in one pass (the engine needs every line together for face-
    // selection + nudging). Obstacles = every node; soft obstacles = groups. Carry each line's
    // last-frame faces in as hysteresis so a tiny move can't flip a route's whole shape.
    const nodes = [];
    for (const n of model.nodes()) { const r = nodeRect(n.id); if (r) nodes.push({ id: n.id, x: r.x, y: r.y, w: r.w, h: r.h }); }
    const grps = groups.allGroups().map((g) => ({ members: [...g.members] }));
    const edges = links.map((l) => ({ from: l.aId, to: l.bId, key: l.key, pinSrc: l.port ? (l.portKind === "watch" ? "L" : "R") : null,
      // watch ends in a diamond sunk slightly into the watched node; trigger ends in a hollow ring
      // pulled back by its radius (3px) so the ring centres ON the fired node's edge.
      insetEnd: l.portKind === "watch" ? 3 : (/\btrigger\b/.test(l.cls) ? 3 : 0) }));
    // every node that renders an out-port parks it on its RIGHT face; the router keeps arriving
    // lines off that dot when it's idle (`reserveMid`). Trigger fires-port lives on the right too.
    const outPorts = new Map();
    for (const n of nodes) if (PORT_OUT_SRC.some((p) => n.id.startsWith(p)) || n.id.startsWith("trigger:")) outPorts.set(n.id, "R");
    const prevSides = new Map();
    for (const [k, c] of routeCache) if (c.d1) prevSides.set(k, { d1: c.d1, d2: c.d2 });
    const res = routeGraph(nodes, grps, edges, { prevSides, outPorts, config: { clearance: ROUTE.cell * 2, laneGap: ROUTE.cell } });
    const fresh = new Map();
    for (const l of links) { const r = res.get(l.key); if (r && r.pts && r.pts.length >= 2) fresh.set(l.key, r); }
    routeCache = fresh;                 // also drops keys for links that vanished
    routeHash = sig;
  } catch (err) {
    setStatus(`route failed: ${err.message}`);   // surface instead of silently using elbows
    return;
  }
  drawEdges();
}

// Freeze edge re-routing while OCR runs. The image/cutout canvases redraw every read and
// fire their ResizeObservers -> drawEdges -> A* reroute, so the lines visibly wiggle during
// OCR (and continuously in live mode). While frozen, drawEdges keeps each line's current path
// and scheduleRouting skips the A*. Each OCR tick refreshes the timer, so a continuous live
// loop stays frozen; ~300ms after the last read it unfreezes and settles the routes once.
let routingFrozen = false;
let _routeFreezeTimer = null;
function freezeRouting() {
  routingFrozen = true;
  clearTimeout(_routeFreezeTimer);
  _routeFreezeTimer = setTimeout(() => { routingFrozen = false; drawEdges(); }, 300);
}

// main.js owns the drag interaction; it flips this flag so drawEdges routes synchronously
// per frame while a node is dragged (line stays glued to the node).
export function setDraggingNodes(v) { draggingNodes = v; }

export { drawEdges, requestEdges, flushEdges, buildLinks, nodeRect, freezeRouting, routeCache, ROUTE };
