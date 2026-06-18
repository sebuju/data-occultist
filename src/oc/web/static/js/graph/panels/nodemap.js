// Node-map / node-list floating panel — a miniature overview of the graph (map mode:
// scaled svg of every node + edge with a draggable viewport indicator; list mode: an
// edge-tree outline grouped by super-group/group). Extracted from main.js verbatim.
import { esc } from "../../dom.js";
import { polylinePath } from "../route.js";
import { createFloatWin } from "../floatwin.js";
import { persist } from "../persist.js";
import * as groups from "../groups.js";
import {
  $, model, pos, nodeEls, view, nw, nh,
} from "../state.js";
import { buildLinks, routeCache, ROUTE } from "../routing.js";
import { selectedNodeId, focusNode, panZoomTo, panZoomToRect } from "../main.js";

const NM_TYPE = { win: "window", prev: "preview", reg: "region", det: "detect",
  sb: "scrollbar", item: "item", fld: "itemfield", ds: "dataset", sub: "subset",
  price: "price", dict: "dictionary" };
const NM_COLOR = { game: "#7aa2f7", window: "#9ece6a", preview: "#56b6c2", region: "#e0af68",
  detect: "#bb9af7", scrollbar: "#f7768e", item: "#7dcfff", itemfield: "#e0af68", dataset: "#e5c07b",
  subset: "#73daca", price: "#ff9e64", dictionary: "#c98ae6" };
const nmTypeOf = (id) => (id === "game" ? "game" : NM_TYPE[id.split(":")[0]] || "node");
const nmColor = (id) => NM_COLOR[nmTypeOf(id)] || "#9aa5ce";

function nodeLabel(n) {
  switch (n.type) {
    case "game": return n.ref.name || "game";
    case "window": return n.ref.id;
    case "preview": return `${n.ref.id} ▸ preview`;
    case "region": return n.ref.id + (n.field ? ` → ${n.field.id}` : "");
    case "detect": return `detect: ${n.ref.id}`;
    case "scrollbar": return "scrollbar";
    case "item": return n.ref.id;
    case "itemfield": return n.ref.id + (n.field ? ` → ${n.field.id}` : "");
    case "dataset": return n.ref;
    case "subset": return n.ref.id;
    case "price": return n.ref.id;
    case "dictionary": return n.ref.name || n.ref.id;
    default: return n.id;
  }
}

// Compact id for a map box (no decorations — the box is tiny).
function nodeShort(n) {
  switch (n.type) {
    case "game": return n.ref.name || "game";
    case "preview": return "preview";
    case "scrollbar": return "scroll";
    case "dataset": return n.ref;
    default: return n.ref?.id ?? n.id;
  }
}

// Largest font that fits ``label`` in a ``bw``×``bh`` box, trying both orientations and
// picking whichever is bigger (so a tall box gets vertical text). ~0.58em per char. `cap`
// is the font ceiling — the live map caps at 11 (tiny boxes); the screenshot lifts it so a
// label can grow to the requested readable floor.
function nmFit(label, bw, bh, cap = 11) {
  const n = Math.max(1, label.length), CW = 0.58, PAD = 0.86;
  const fh = Math.min(bh * PAD, (bw * PAD) / (n * CW));   // horizontal
  const fv = Math.min(bw * PAD, (bh * PAD) / (n * CW));   // rotated 90°
  return { fs: Math.min(cap, Math.max(fh, fv)), vertical: fv > fh };
}

let nm = null;            // node-MAP float-win instance (scaled svg overview)
let nl = null;            // node-LIST float-win instance (edge-tree outline)
let nmTransform = null;   // last map projection {ox,oy,s} for the viewport indicator
// Map + list are now TWO distinct panels (split from one mode-toggled panel), each toggled
// from its own topbar button. Neither is persisted — floating panels are session-only and
// start hidden on every load (see floatwin.js / hydrateLayout).
const nmState = { visible: false, x: null, y: null, w: null, h: null };   // map: width-only (auto-fit height)
const nlState = { visible: false, x: null, y: null, w: null, h: null };   // list: free width + height
const nlCollapsed = new Set();   // node-list row keys whose subtree is folded away
const nlDefaulted = new Set();   // group keys already given their default-collapsed state (once each)

// jump-to wiring shared by both panels: click a node -> select + smooth pan/zoom; a group /
// super-group row -> frame it. (One handler builder, two callers.)
function wireJump(panel) {
  panel.body.addEventListener("click", (ev) => {
    // collapse/expand toggle (list only) — fold this row's whole subtree; never a jump
    const cb = ev.target.closest(".nm-collapse");
    if (cb) {
      ev.stopPropagation();
      const k = cb.dataset.key, willCollapse = !nlCollapsed.has(k);
      willCollapse ? nlCollapsed.add(k) : nlCollapsed.delete(k);
      // Rotate the LIVE caret so it transitions (a re-render would swap in a fresh, already-rotated
      // element — no state change, no animation). Re-render after the spin so rows update with the
      // caret already at its final angle.
      cb.classList.toggle("open", !willCollapse);
      setTimeout(renderNodeList, 130);
      return;
    }
    const sg = ev.target.closest("[data-sgid]");
    if (sg) { const sb = groups.superGroupBoxes().find((b) => b.id === sg.dataset.sgid); if (sb) panZoomToRect(sb.box); return; }
    const g = ev.target.closest("[data-gid]");
    if (g) { const gb = groups.groupBoxes().find((b) => b.id === g.dataset.gid); if (gb) panZoomToRect(gb.box); return; }
    const t = ev.target.closest("[data-id]");
    if (!t) return;
    const id = t.dataset.id;
    if (!nodeEls.has(id)) return;
    focusNode(id); panZoomTo(id); nmSyncSelection();
  });
}

function buildNodeMap() {
  if (nm) return;
  nm = createFloatWin({
    id: "nodemap", title: "node map", state: nmState,
    bothAxes: false, autoFit: false,   // width only — height auto-fits the GRAPH ASPECT (nmFitPanelHeight), not the content
    onResize: () => { if (nmState.visible && nm.el.offsetWidth) renderNodeMap(); },
    onShow: () => { $("nodemapBtn")?.classList.toggle("active", true); renderNodeMap(); },
    onHide: () => { $("nodemapBtn")?.classList.toggle("active", false); },
    onPersist: () => persist.layout(),
  });
  wireJump(nm);
}

function buildNodeList() {
  if (nl) return;
  nl = createFloatWin({
    id: "nodelist", title: "node list", state: nlState,
    bothAxes: true, autoFit: false,   // a scrolling outline freely resized in both axes (not content-fit)
    onShow: () => { $("nodelistBtn")?.classList.toggle("active", true); renderNodeList(); },
    onHide: () => { $("nodelistBtn")?.classList.toggle("active", false); },
    onPersist: () => persist.layout(),
  });
  wireJump(nl);
}

function setNodeMapVisible(on, reset) { nm.setVisible(on, reset); }    // toggles button + renders via onShow/onHide
function setNodeListVisible(on, reset) { nl.setVisible(on, reset); }

function nmSyncSelection() {
  for (const p of [nm, nl]) p && p.el.querySelectorAll("[data-id]")
    .forEach((e) => e.classList.toggle("sel", e.dataset.id === selectedNodeId));
}

function renderNodeMap() {
  if (!nm || !nmState.visible) return;
  nm.body.classList.add("nm-bmap");   // centre the wrapped svg
  nmRenderMap(nm.body);
}
function renderNodeList() {
  if (!nl || !nlState.visible) return;
  nmRenderList(nl.body);
}
// Refresh whichever overview panels are open — called wherever the graph changes.
function renderNodeViews() { renderNodeMap(); renderNodeList(); }

// Gather every placed, rendered node + its world rect and the content extent. Shared by the
// live map and the screenshot so both project IDENTICAL geometry (rule: one source of truth).
function nmMapModel() {
  const ids = [...pos.keys()].filter((id) => nodeEls.has(id) && Number.isFinite(pos.get(id).x));
  if (!ids.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const rects = ids.map((id) => {
    const p = pos.get(id), w = nw(id), h = nh(id);
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + w); maxY = Math.max(maxY, p.y + h);
    return { id, x: p.x, y: p.y, w, h };
  });
  const labels = new Map(model.nodes().map((n) => [n.id, nodeShort(n)]));
  return { rects, minX, minY, maxX, maxY, labels };
}

// Build the map <svg> markup projecting world coords at scale `s` (pad px margin). `cap` is the
// node-label font ceiling (live = 11; screenshot lifts it so labels reach the readable floor);
// `titleCap` the same for group headings. Returns { svg, W, H, ox, oy, s }. Pure string build,
// no DOM and no viewport indicator (that's the live panel's job). Used by BOTH callers.
function nmBuildMapSvg(m, s, { cap = 11, titleCap = 9, pad = 8 } = {}) {
  const { rects, minX, minY, maxX, maxY, labels } = m;
  const spanX = Math.max(1, maxX - minX), spanY = Math.max(1, maxY - minY);
  const W = spanX * s + 2 * pad, H = spanY * s + 2 * pad;
  const ox = pad - minX * s, oy = pad - minY * s;
  const X = (v) => ox + v * s, Y = (v) => oy + v * s;
  // Build edges from the ROUTED geometry (orthogonal polylines), never the live DOM paths
  // which can be mid-bezier during a morph. Uncached links fall back to a straight segment —
  // still never a bezier. World coords, reprojected by one group transform (same as X/Y).
  const edgePaths = buildLinks().map((l) => {
    const c = routeCache.get(l.key);
    const pts = (c && c.pts && c.pts.length >= 2) ? c.pts : [l.p1, l.p2];
    const d = polylinePath(pts, ROUTE.corners, ROUTE.radius);
    return d && !d.includes("NaN") ? `<path d="${d}" />` : "";
  }).join("");
  const node = (r) => {
    const bw = Math.max(2, r.w * s), bh = Math.max(2, r.h * s);
    const x = X(r.x), y = Y(r.y), cx = x + bw / 2, cy = y + bh / 2;
    const lbl = labels.get(r.id) || r.id;
    const rect = `<rect class="nm-n${r.id === selectedNodeId ? " sel" : ""}" data-id="${esc(r.id)}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="1.5" fill="${nmColor(r.id)}"><title>${esc(lbl)}</title></rect>`;
    // size the label to fit; rotate it 90° when that lets it be bigger; hide if it'd be unreadable
    const f = nmFit(lbl, bw, bh, cap);
    const text = f.fs >= 3
      ? `<text class="nm-lbl" x="${cx.toFixed(1)}" y="${cy.toFixed(1)}" font-size="${f.fs.toFixed(1)}"${f.vertical ? ` transform="rotate(90 ${cx.toFixed(1)} ${cy.toFixed(1)})"` : ""}>${esc(lbl)}</text>`
      : "";
    return rect + text;
  };
  // Group + super-group boxes (behind everything), hugging their members like the live layer.
  const boxSvg = (b, cls) => {
    const x = X(b.box.x), y = Y(b.box.y), w = b.box.w * s, h = b.box.h * s;
    const style = b.outline.style;
    const stroke = style === "none" ? "none" : b.outline.color;
    const dash = style === "dashed" ? ` stroke-dasharray="4 3"` : style === "dotted" ? ` stroke-dasharray="1 3"` : "";
    return `<rect class="${cls}" data-${cls === "nm-super" ? "sgid" : "gid"}="${esc(b.id)}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${b.bg}" stroke="${stroke}"${dash}><title>${esc(b.title)}</title></rect>`;
  };
  const superSvg = groups.superGroupBoxes().map((sp) => boxSvg(sp, "nm-super")).join("");
  const groupSvg = groups.groupBoxes().map((gp) => boxSvg(gp, "nm-group")).join("");
  // Group / super-group NAME as a title BAR: an opaque dark plate + coloured text (same idiom
  // as the canvas labels). Drawn ABOVE the nodes so it's never hidden, but the solid plate makes
  // it read as a deliberate header. Placement MIRRORS the live canvas: group titles align
  // (left/center/right) per the group's titleAlign and sit at the box TOP; super-group titles
  // pin BOTTOM-LEFT (the canvas watermark idiom). The plate width is clamped to the box so the
  // text always fits the space the box gives it; font shrinks too, and the title hides (hover
  // <title> still names it) when it'd be too small to read.
  const boxTitle = (b, col, { align = "left", bottom = false } = {}) => {
    if (!b.title) return "";
    const bx = X(b.box.x), by = Y(b.box.y), w = b.box.w * s, h = b.box.h * s, len = b.title.length;
    // Cap by WIDTH only — the reserved title band scales to ~2px on the mini-map, so capping the
    // font to it (bandH*s) drove fs negative and hid EVERY heading. The plate is opaque and drawn
    // last (nm-titles on top), so a fixed readable size sitting slightly over the first node row
    // is fine — that's the canvas title-bar idiom. Hide only when too narrow to read.
    const fs = Math.min(titleCap, (w - 6) / Math.max(1, len * 0.58));
    if (fs < 4) return "";
    const tw = Math.min(w, len * fs * 0.58 + 6), th = fs + 3;
    const tx = align === "center" ? bx + (w - tw) / 2 : align === "right" ? bx + w - tw : bx;
    const ty = bottom ? by + h - th : by;
    return `<g class="nm-gtitle">`
      + `<rect x="${tx.toFixed(1)}" y="${ty.toFixed(1)}" width="${tw.toFixed(1)}" height="${th.toFixed(1)}" rx="1.5" fill="rgba(8,11,16,0.72)"/>`
      + `<text x="${(tx + 3).toFixed(1)}" y="${(ty + 1.5).toFixed(1)}" font-size="${fs.toFixed(1)}" fill="${col}">${esc(b.title)}</text></g>`;
  };
  const titleSvg = groups.superGroupBoxes().map((b) => boxTitle(b, "#cdd3dc", { bottom: true }))   // super outlines run dark -> light text, label bottom-left
    .concat(groups.groupBoxes().map((b) => boxTitle(b, b.outline?.color || "#cdd3dc", { align: b.titleAlign }))).join("");
  const svg = `<svg class="nm-svg" width="${W.toFixed(1)}" height="${H.toFixed(1)}" viewBox="0 0 ${W.toFixed(1)} ${H.toFixed(1)}" preserveAspectRatio="xMidYMid meet">
      <g class="nm-supers">${superSvg}</g>
      <g class="nm-groups">${groupSvg}</g>
      <g class="nm-edges" transform="translate(${ox.toFixed(2)} ${oy.toFixed(2)}) scale(${s.toFixed(4)})">${edgePaths}</g>
      <g class="nm-nodes">${rects.map(node).join("")}</g>
      <g class="nm-titles">${titleSvg}</g></svg>`;
  return { svg, W, H, ox, oy, s };
}

function nmRenderMap(body) {
  const m = nmMapModel();
  if (!m) { body.innerHTML = `<div class="nm-empty">no nodes</div>`; nmTransform = null; return; }
  // Resizing drives WIDTH only; the panel height is then locked to the content's aspect
  // (nmFitPanelHeight) so the map always fills the panel exactly — no empty space.
  const availW = Math.max(120, (body.clientWidth || 276) - 12), PAD = 8;
  const spanX = Math.max(1, m.maxX - m.minX);
  const s = (availW - 2 * PAD) / spanX;   // fit to width; height follows
  const { svg, W, H, ox, oy } = nmBuildMapSvg(m, s, { cap: 11, pad: PAD });
  nmTransform = { ox, oy, s };
  // The viewport indicator is a plain DIV moved with a CSS transform (compositor-only) — it
  // must NOT be an SVG element whose geometry attributes are rewritten each pan frame, since
  // that forces a layout, and with this huge DOM each layout is ~3ms (the pan lag).
  body.innerHTML = `<div class="nm-wrap" style="width:${W.toFixed(1)}px;height:${H.toFixed(1)}px;">${svg}<div class="nm-vp"></div></div>`;
  nmUpdateViewport();
  nmFitPanelHeight(H);   // shrink/grow the panel height to the content -> no empty space
}

// Build a standalone node-map SVG sized so the SMALLEST node label renders at `floor` px.
// Each label's fitted size grows linearly with the scale `s`, so the binding (smallest-fit)
// node fixes `s = floor / min(per-node fit at s=1)`; with the font cap lifted every label then
// lands at `floor` or larger. Returns { svg, W, H } or null when there are no nodes. The
// caller rasterises it (the .nm-* classes are global CSS, so it must render attached).
function nodemapShot({ floor = 13, titleCap = 16, pad = 16 } = {}) {
  const m = nmMapModel();
  if (!m) return null;
  let minFit = Infinity;
  for (const r of m.rects) {
    const lbl = m.labels.get(r.id) || r.id;
    const fit = nmFit(lbl, Math.max(2, r.w), Math.max(2, r.h), Infinity).fs;   // size at s=1
    if (fit > 0) minFit = Math.min(minFit, fit);
  }
  if (!Number.isFinite(minFit) || minFit <= 0) return null;
  const { svg, W, H } = nmBuildMapSvg(m, floor / minFit, { cap: Infinity, titleCap, pad });
  return { svg, W, H };
}

// Lock the panel height to the map content (map mode) so resizing width never leaves a
// vertical gap. Height-only write: the next ResizeObserver tick re-renders with the same
// width and converges (no loop).
function nmFitPanelHeight(svgH) {
  if (!nm || nmState.collapsed) return;   // collapsed owns its height
  const headerH = nm.el.querySelector(".fw-head")?.offsetHeight || 28;
  const targetH = Math.round(svgH + 12 + headerH + 2);   // body padding + header + borders
  if (Math.abs(nm.el.offsetHeight - targetH) > 1) {
    nm.el.style.height = `${targetH}px`; nmState.h = targetH;
  }
}

function nmRenderList(body) {
  const nodes = model.nodes();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const kids = new Map();
  for (const e of model.edges()) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue;
    if (!kids.has(e.from)) kids.set(e.from, []);
    kids.get(e.from).push(e.to);
  }
  // edge-tree walk over a node SUBSET: local roots (no in-subset parent) first, then leftovers
  const orderWalk = (subset) => {
    const indeg = new Map(); for (const id of subset) indeg.set(id, 0);
    for (const e of model.edges()) if (subset.has(e.from) && subset.has(e.to)) indeg.set(e.to, (indeg.get(e.to) || 0) + 1);
    const seen = new Set(), out = [];
    const walk = (id, depth) => {
      if (seen.has(id) || !subset.has(id)) return;
      seen.add(id);
      const n = byId.get(id); if (!n) return;
      out.push({ id, depth, label: nodeLabel(n), type: n.type });
      for (const c of (kids.get(id) || [])) walk(c, depth + 1);
    };
    for (const id of subset) if ((indeg.get(id) || 0) === 0) walk(id, 0);
    for (const id of subset) walk(id, 0);
    return out;
  };

  // super groups (header → their groups → members), then loose groups, then ungrouped nodes
  const rows = [], grouped = new Set(), placedGroups = new Set();
  const emitGroup = (g, depth) => {
    placedGroups.add(g.id);
    const sub = new Set(g.members.filter((id) => byId.has(id)));
    if (!sub.size) return;
    for (const id of sub) grouped.add(id);
    rows.push({ kind: "group", gid: g.id, label: g.title || g.id, color: g.outline?.color, depth });
    for (const r of orderWalk(sub)) rows.push({ kind: "node", ...r, depth: r.depth + depth + 1 });
  };
  for (const sg of groups.allSuperGroups()) {
    const memberGroups = sg.groups.map((id) => groups.allGroups().find((g) => g.id === id)).filter(Boolean);
    if (!memberGroups.length) continue;
    rows.push({ kind: "super", sgid: sg.id, label: sg.title || sg.id, color: sg.outline?.color, depth: 0 });
    for (const g of memberGroups) emitGroup(g, 1);
  }
  for (const g of groups.allGroups()) if (!placedGroups.has(g.id)) emitGroup(g, 0);
  const ungrouped = new Set(nodes.map((n) => n.id).filter((id) => !grouped.has(id)));
  for (const r of orderWalk(ungrouped)) rows.push({ kind: "node", ...r });

  // Per-row tree bookkeeping: a stable key (for the collapse set), and the count of descendant
  // rows (the run of following rows deeper than it) — that count IS the hidden total when folded.
  const keyOf = (r) => r.kind === "node" ? `n:${r.id}` : r.kind === "group" ? `g:${r.gid}` : `s:${r.sgid}`;
  for (let i = 0; i < rows.length; i++) {
    rows[i].key = keyOf(rows[i]);
    let j = i + 1; while (j < rows.length && rows[j].depth > rows[i].depth) j++;
    rows[i].kids = j - i - 1;
    // window nodes start collapsed — seed once per window so the user can still expand it (and any
    // newly-appearing window also defaults to collapsed exactly once).
    if (rows[i].kind === "node" && rows[i].type === "window" && rows[i].kids && !nlDefaulted.has(rows[i].key)) {
      nlDefaulted.add(rows[i].key); nlCollapsed.add(rows[i].key);
    }
  }
  // Drop rows sitting under a collapsed ancestor: when a collapsed row is emitted, hide every
  // following row deeper than it until depth returns to its level or shallower.
  const visible = [];
  let hideBelow = Infinity;
  for (const r of rows) {
    if (r.depth > hideBelow) continue;
    hideBelow = Infinity;
    visible.push(r);
    if (r.kids && nlCollapsed.has(r.key)) hideBelow = r.depth;
  }

  // Allow wrapping after every non-alphanumeric char (':', '→', '▸', '_', space, …) so long
  // labels break at their separators instead of overflowing. Escape per-char so the injected
  // <wbr> tags survive (esc() on the whole string would mangle them).
  const wbr = (s) => [...String(s)].map((c) => esc(c) + (/[\p{L}\p{N}]/u.test(c) ? "" : "<wbr>")).join("");
  // Right-edge affordances (both ABSOLUTE so they never reflow the row): a hover-only
  // collapse/expand toggle for any row with children, and a hidden-count badge while collapsed.
  const afford = (r) => {
    if (!r.kids) return "";
    const collapsed = nlCollapsed.has(r.key);
    // one caret glyph (▸), rotated 90° when expanded — so it never points the wrong way
    return `<button class="nm-collapse${collapsed ? "" : " open"}" data-key="${esc(r.key)}" title="${collapsed ? "expand" : "collapse"}">▸</button>`
      + (collapsed ? `<span class="nm-hidden" title="${r.kids} hidden">${r.kids}</span>` : "");
  };
  const rowHTML = (r) => {
    const depth = r.depth || 0;   // CSS computes padding-left from --nm-depth (see floatwin.css)
    const folded = nlCollapsed.has(r.key) ? " nm-folded" : "";
    if (r.kind === "super") return `<div class="nm-row nm-super-row${folded}" data-sgid="${esc(r.sgid)}" title="zoom to super group" style="--nm-depth:${depth}">
        <span class="nm-gswatch nm-sswatch" style="border-color:${r.color || "#9aa5ce"}"></span>${wbr(r.label)}${afford(r)}</div>`;
    if (r.kind === "group") return `<div class="nm-row nm-grp${folded}" data-gid="${esc(r.gid)}" title="zoom to group" style="--nm-depth:${depth}">
        <span class="nm-gswatch" style="border-color:${r.color || "#9aa5ce"}"></span>${wbr(r.label)}${afford(r)}</div>`;
    return `<div class="nm-row${r.id === selectedNodeId ? " sel" : ""}${folded}" data-id="${esc(r.id)}" style="--nm-depth:${depth}">
        <span class="nm-dot" style="background:${NM_COLOR[r.type] || "#9aa5ce"}"></span>${wbr(r.label)}${afford(r)}</div>`;
  };
  body.innerHTML = `<div class="nm-list">${visible.map(rowHTML).join("") || `<div class="nm-empty">no nodes</div>`}</div>`;
}

// Cache the graph viewport box — nmUpdateViewport runs every pan FRAME, and reading
// getBoundingClientRect right after applyView writes the transform forces a sync layout
// (the pan lag). The box only changes on resize, so cache and invalidate there.
let _graphBox = null;
function graphBox() { return _graphBox || (_graphBox = $("graph").getBoundingClientRect()); }
window.addEventListener("resize", () => { _graphBox = null; });

function nmUpdateViewport() {
  if (!nm || !nmState.visible || !nmTransform) return;
  const vp = nm.el.querySelector(".nm-vp"); if (!vp) return;
  const rect = graphBox();
  const { ox, oy, s } = nmTransform;
  // True viewport rect in map space (no clamping — the indicator must show the REAL position,
  // even when it runs past the node extents). The overflow:hidden on .nm-wrap clips the part
  // outside the map, so panning far just slides it off-edge instead of spilling/leaving a line.
  const x = ox + (-view.panX / view.zoom) * s, y = oy + (-view.panY / view.zoom) * s;
  const w = Math.max(0, (rect.width / view.zoom) * s), h = Math.max(0, (rect.height / view.zoom) * s);
  // width/height only change on ZOOM (not pan) — set them rarely; the per-frame pan update
  // is a pure transform (no layout/paint of the box)
  if (vp._w !== w || vp._h !== h) { vp.style.width = `${w.toFixed(1)}px`; vp.style.height = `${h.toFixed(1)}px`; vp._w = w; vp._h = h; }
  vp.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
}

export {
  nmColor, nodeLabel, nodeShort, nmFit, nm, nl, nmTransform, nmState, nlState,
  buildNodeMap, buildNodeList, setNodeMapVisible, setNodeListVisible, nmSyncSelection,
  renderNodeMap, renderNodeList, renderNodeViews, nmRenderMap, nmFitPanelHeight,
  nmRenderList, graphBox, nmUpdateViewport, nodemapShot,
};
