// Standalone nodemap renderer: draw a profile's graph as a scaled SVG from DATA alone
// (positions from profile.layout.nodes, structure from a throwaway GraphModel). Unlike
// the live minimap in main.js it touches no live DOM/route cache, so it can preview any
// profile — used by the backups browser. Edges are straight segments (no orthogonal
// router; this is an at-a-glance preview). Reuses the .nm-* CSS of the live minimap.

import { GraphModel } from "./model.js";

const NM_COLOR = {
  game: "#7aa2f7", window: "#9ece6a", preview: "#56b6c2", region: "#e0af68",
  detect: "#bb9af7", scrollbar: "#f7768e", item: "#7dcfff", dataset: "#e5c07b",
  subset: "#73daca", price: "#ff9e64", trigger: "#e0af68", dictionary: "#c98ae6",
};
const DEFAULT_W = 160, DEFAULT_H = 70;   // size for nodes whose layout didn't store one

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function shortLabel(n) {
  if (n.type === "game") return n.ref?.name || "game";
  if (typeof n.ref === "string") return n.ref;          // dataset carries its id as a string
  return n.ref?.name || n.ref?.id || n.id;
}

// Largest font that fits ``label`` in a bw×bh box, trying both orientations (matches the
// live minimap's nmFit so previews look the same).
function fit(label, bw, bh) {
  const n = Math.max(1, label.length), CW = 0.58, PAD = 0.86;
  const fh = Math.min(bh * PAD, (bw * PAD) / (n * CW));
  const fv = Math.min(bw * PAD, (bh * PAD) / (n * CW));
  return { fs: Math.min(11, Math.max(fh, fv)), vertical: fv > fh };
}

export function renderMiniMap(container, profile) {
  const model = new GraphModel();
  model.load(profile);
  const lnodes = (profile?.layout?.nodes) || {};
  const placed = model.nodes().filter((n) => {
    const p = lnodes[n.id];
    return p && Number.isFinite(p.x) && Number.isFinite(p.y);
  });
  if (!placed.length) {
    container.innerHTML = `<div class="nm-empty">no placed nodes in this backup</div>`;
    return;
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const rects = placed.map((n) => {
    const p = lnodes[n.id];
    const w = Number.isFinite(p.w) ? p.w : DEFAULT_W, h = Number.isFinite(p.h) ? p.h : DEFAULT_H;
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + w); maxY = Math.max(maxY, p.y + h);
    return { id: n.id, type: n.type, label: shortLabel(n), x: p.x, y: p.y, w, h };
  });

  const box = container.getBoundingClientRect();
  const availW = Math.max(160, (box.width || 540) - 16), availH = Math.max(160, (box.height || 420) - 16), PAD = 8;
  const spanX = Math.max(1, maxX - minX), spanY = Math.max(1, maxY - minY);
  const s = Math.min((availW - 2 * PAD) / spanX, (availH - 2 * PAD) / spanY);   // fit both axes
  const ox = PAD - minX * s + (availW - 2 * PAD - spanX * s) / 2;               // centre the content
  const oy = PAD - minY * s + (availH - 2 * PAD - spanY * s) / 2;
  const X = (v) => ox + v * s, Y = (v) => oy + v * s;

  const center = new Map(rects.map((r) => [r.id, { x: X(r.x) + r.w * s / 2, y: Y(r.y) + r.h * s / 2 }]));
  const edges = model.edges()
    .filter((e) => center.has(e.from) && center.has(e.to))
    .map((e) => {
      const a = center.get(e.from), b = center.get(e.to);
      return `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" />`;
    }).join("");

  // Group boxes behind the nodes. Read from layout data (no live DOM) and hug members with
  // the same PAD/TITLE_H geometry groups.js uses, so the preview matches the live map.
  const GPAD = 16, GTITLE_H = 24;
  const rectById = new Map(rects.map((r) => [r.id, r]));
  const groupSvg = ((profile?.layout?.groups) || []).map((g) => {
    let nx = Infinity, ny = Infinity, mx = -Infinity, my = -Infinity;
    for (const id of (g.members || [])) {
      const r = rectById.get(id); if (!r) continue;
      nx = Math.min(nx, r.x); ny = Math.min(ny, r.y); mx = Math.max(mx, r.x + r.w); my = Math.max(my, r.y + r.h);
    }
    if (!Number.isFinite(nx)) return "";
    const bx = nx - GPAD, by = ny - GPAD - GTITLE_H, bw = (mx - nx) + GPAD * 2, bh = (my - ny) + GPAD * 2 + GTITLE_H;
    const x = X(bx), y = Y(by), w = bw * s, h = bh * s;
    const style = g.outline?.style || "solid";
    const stroke = style === "none" ? "none" : (g.outline?.color || "#333333");
    const dash = style === "dashed" ? ` stroke-dasharray="4 3"` : style === "dotted" ? ` stroke-dasharray="1 3"` : "";
    return `<rect class="nm-group" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${g.bg || "#1c1e231f"}" stroke="${stroke}"${dash}><title>${esc(g.title || g.id)}</title></rect>`;
  }).join("");

  const nodeSvg = rects.map((r) => {
    const bw = Math.max(2, r.w * s), bh = Math.max(2, r.h * s);
    const x = X(r.x), y = Y(r.y), cx = x + bw / 2, cy = y + bh / 2;
    const f = fit(r.label, bw, bh);
    const text = f.fs >= 3
      ? `<text class="nm-lbl" x="${cx.toFixed(1)}" y="${cy.toFixed(1)}" font-size="${f.fs.toFixed(1)}"${f.vertical ? ` transform="rotate(90 ${cx.toFixed(1)} ${cy.toFixed(1)})"` : ""}>${esc(r.label)}</text>`
      : "";
    return `<rect class="nm-n" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="1.5" fill="${NM_COLOR[r.type] || "#9aa5ce"}"><title>${esc(r.label)}</title></rect>${text}`;
  }).join("");

  container.innerHTML = `<svg class="nm-svg" width="${availW}" height="${availH}" viewBox="0 0 ${availW} ${availH}" preserveAspectRatio="xMidYMid meet">
    <g class="nm-groups">${groupSvg}</g><g class="nm-edges">${edges}</g><g class="nm-nodes">${nodeSvg}</g></svg>`;
}
