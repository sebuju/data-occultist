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
  subset: "#73daca", price: "#ff9e64", dictionary: "#a9b1d6" };
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
// picking whichever is bigger (so a tall box gets vertical text). ~0.58em per char.
function nmFit(label, bw, bh) {
  const n = Math.max(1, label.length), CW = 0.58, PAD = 0.86;
  const fh = Math.min(bh * PAD, (bw * PAD) / (n * CW));   // horizontal
  const fv = Math.min(bw * PAD, (bh * PAD) / (n * CW));   // rotated 90°
  return { fs: Math.min(11, Math.max(fh, fv)), vertical: fv > fh };
}

let nm = null;            // the createFloatWin instance (built once at startup)
let nmTransform = null;   // last map projection {ox,oy,s} for the viewport indicator
// Node-map panel state. Persisted in the profile YAML (layout.float_windows.nodemap) via
// the shared float-window machinery — hydrateLayout feeds it in, collectLayout writes it
// back. `mode` + `sizes` are nodemap's own extras carried in the same blob: `sizes` keeps
// each mode's box (map auto-fits its height to the graph, list is freely resized) so
// toggling restores the entering mode's box instead of carrying one over the other.
const nmState = { visible: false, x: null, y: null, w: null, h: null, mode: "map",
  sizes: { map: { w: null, h: null }, list: { w: null, h: null } } };

// Restore the active mode's saved box into nmState.w/h, then apply. Width always; height
// only in list mode (map height is recomputed by nmFitPanelHeight on render).
function applyNmModeSize() {
  const sz = (nmState.sizes && nmState.sizes[nmState.mode]) || {};
  if (Number.isFinite(sz.w)) nmState.w = sz.w;
  // map mode: drop the height so applySize leaves it to nmFitPanelHeight (auto-fit)
  nmState.h = (nmState.mode === "list" && Number.isFinite(sz.h)) ? sz.h
    : (nmState.mode === "list" ? nmState.h : null);
  nm.applySize();
}

function buildNodeMap() {
  if (nm) return;
  nm = createFloatWin({
    id: "nodemap",
    title: nmState.mode === "list" ? "node list" : "node map",
    headerExtra: `<button class="nm-mode" title="toggle map / list view">${nmState.mode === "list" ? "▤" : "⊞"}</button>`,
    state: nmState,
    bothAxes: () => nmState.mode === "list",   // list: free width+height; map: width only
    onResize: () => {
      if (!nmState.visible || !nm.el.offsetWidth) return;
      nmState.sizes[nmState.mode] = { w: nm.el.offsetWidth, h: nm.el.offsetHeight };   // per-mode box
      renderNodeMap();   // map: refit to new size; list: cheap re-render
    },
    onShow: () => { $("nodemapBtn")?.classList.toggle("active", true); nmSyncHeader(); applyNmModeSize(); renderNodeMap(); },
    onHide: () => { $("nodemapBtn")?.classList.toggle("active", false); },
    onPersist: () => persist.layout(),
  });
  nm.el.querySelector(".nm-mode").addEventListener("click", () =>
    setNodeMapMode(nmState.mode === "map" ? "list" : "map"));
  // jump-to: click a node in either view -> select + smooth pan/zoom; a group row -> frame it
  nm.body.addEventListener("click", (ev) => {
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

// Reflect the current mode on the header (title text + toggle glyph).
function nmSyncHeader() {
  nm.el.querySelector(".nm-mode").textContent = nmState.mode === "list" ? "▤" : "⊞";
  nm.el.querySelector(".fw-title").textContent = nmState.mode === "list" ? "node list" : "node map";
}

function setNodeMapVisible(on) {
  nm.setVisible(on);   // toggles the button + renders via onShow/onHide
}
function setNodeMapMode(mode) {
  if (mode === nmState.mode) return;
  const right = nm.el.offsetLeft + nm.el.offsetWidth;   // pin right edge so the toggle button stays put
  if (nm.el.offsetWidth) nmState.sizes[nmState.mode] = { w: nm.el.offsetWidth, h: nm.el.offsetHeight };  // stash leaving box
  nmState.mode = mode;
  nmSyncHeader();
  applyNmModeSize();           // restore the entering mode's box
  renderNodeMap();
  nm.place(right - nm.el.offsetWidth, nm.el.offsetTop);   // re-anchor by the right edge
  persist.layout();
}

function nmSyncSelection() {
  if (!nm) return;
  nm.el.querySelectorAll("[data-id]").forEach((e) => e.classList.toggle("sel", e.dataset.id === selectedNodeId));
}

function renderNodeMap() {
  if (!nm || !nmState.visible) return;
  const body = nm.body;
  body.classList.toggle("nm-bmap", nmState.mode === "map");   // centre the wrapped svg
  if (nmState.mode === "list") nmRenderList(body); else nmRenderMap(body);
}

function nmRenderMap(body) {
  const ids = [...pos.keys()].filter((id) => nodeEls.has(id) && Number.isFinite(pos.get(id).x));
  if (!ids.length) { body.innerHTML = `<div class="nm-empty">no nodes</div>`; nmTransform = null; return; }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const rects = ids.map((id) => {
    const p = pos.get(id), w = nw(id), h = nh(id);
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + w); maxY = Math.max(maxY, p.y + h);
    return { id, x: p.x, y: p.y, w, h };
  });
  // Resizing drives WIDTH only; the panel height is then locked to the content's aspect
  // (nmFitPanelHeight) so the map always fills the panel exactly — no empty space.
  const availW = Math.max(120, (body.clientWidth || 276) - 12), PAD = 8;
  const spanX = Math.max(1, maxX - minX), spanY = Math.max(1, maxY - minY);
  const s = (availW - 2 * PAD) / spanX;        // fit to width; height follows
  const W = availW, H = spanY * s + 2 * PAD;   // svg wraps content tightly
  const ox = PAD - minX * s, oy = PAD - minY * s;
  nmTransform = { ox, oy, s };
  const X = (v) => ox + v * s, Y = (v) => oy + v * s;
  const labels = new Map(model.nodes().map((n) => [n.id, nodeShort(n)]));
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
    const f = nmFit(lbl, bw, bh);
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
  // The viewport indicator is a plain DIV moved with a CSS transform (compositor-only) — it
  // must NOT be an SVG element whose geometry attributes are rewritten each pan frame, since
  // that forces a layout, and with this huge DOM each layout is ~3ms (the pan lag).
  body.innerHTML = `<div class="nm-wrap" style="width:${W.toFixed(1)}px;height:${H.toFixed(1)}px;">
    <svg class="nm-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
      <g class="nm-supers">${superSvg}</g>
      <g class="nm-groups">${groupSvg}</g>
      <g class="nm-edges" transform="translate(${ox.toFixed(2)} ${oy.toFixed(2)}) scale(${s.toFixed(4)})">${edgePaths}</g>
      <g class="nm-nodes">${rects.map(node).join("")}</g></svg>
    <div class="nm-vp"></div>
  </div>`;
  nmUpdateViewport();
  nmFitPanelHeight(H);   // shrink/grow the panel height to the content -> no empty space
}

// Lock the panel height to the map content (map mode) so resizing width never leaves a
// vertical gap. Height-only write: the next ResizeObserver tick re-renders with the same
// width and converges (no loop).
function nmFitPanelHeight(svgH) {
  if (!nm || nmState.mode !== "map" || nmState.collapsed) return;   // collapsed owns its height
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

  const rowHTML = (r) => {
    const pad = 6 + (r.depth || 0) * 14;
    if (r.kind === "super") return `<div class="nm-row nm-super-row" data-sgid="${esc(r.sgid)}" title="zoom to super group" style="padding-left:${pad}px">
        <span class="nm-gswatch nm-sswatch" style="border-color:${r.color || "#9aa5ce"}"></span>${esc(r.label)}</div>`;
    if (r.kind === "group") return `<div class="nm-row nm-grp" data-gid="${esc(r.gid)}" title="zoom to group" style="padding-left:${pad}px">
        <span class="nm-gswatch" style="border-color:${r.color || "#9aa5ce"}"></span>${esc(r.label)}</div>`;
    return `<div class="nm-row${r.id === selectedNodeId ? " sel" : ""}" data-id="${esc(r.id)}" style="padding-left:${pad}px">
        <span class="nm-dot" style="background:${NM_COLOR[r.type] || "#9aa5ce"}"></span>${esc(r.label)}</div>`;
  };
  body.innerHTML = `<div class="nm-list">${rows.map(rowHTML).join("") || `<div class="nm-empty">no nodes</div>`}</div>`;
}

// Cache the graph viewport box — nmUpdateViewport runs every pan FRAME, and reading
// getBoundingClientRect right after applyView writes the transform forces a sync layout
// (the pan lag). The box only changes on resize, so cache and invalidate there.
let _graphBox = null;
function graphBox() { return _graphBox || (_graphBox = $("graph").getBoundingClientRect()); }
window.addEventListener("resize", () => { _graphBox = null; });

function nmUpdateViewport() {
  if (!nm || !nmState.visible || nmState.mode !== "map" || !nmTransform) return;
  const vp = nm.el.querySelector(".nm-vp"); if (!vp) return;
  const rect = graphBox();
  const { ox, oy, s } = nmTransform;
  const x = ox + (-view.panX / view.zoom) * s, y = oy + (-view.panY / view.zoom) * s;
  const w = Math.max(0, (rect.width / view.zoom) * s), h = Math.max(0, (rect.height / view.zoom) * s);
  // width/height only change on ZOOM (not pan) — set them rarely; the per-frame pan update
  // is a pure transform (no layout/paint of the box)
  if (vp._w !== w || vp._h !== h) { vp.style.width = `${w.toFixed(1)}px`; vp.style.height = `${h.toFixed(1)}px`; vp._w = w; vp._h = h; }
  vp.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
}

export {
  nmColor, nodeLabel, nodeShort, nmFit, nm, nmTransform, nmState, applyNmModeSize,
  buildNodeMap, nmSyncHeader, setNodeMapVisible, setNodeMapMode, nmSyncSelection,
  renderNodeMap, nmRenderMap, nmFitPanelHeight, nmRenderList, graphBox, nmUpdateViewport,
};
