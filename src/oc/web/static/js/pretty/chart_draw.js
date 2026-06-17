// Dependency-free SVG charts. One entry — `drawChart(host, spec)` — renders into `host` by
// setting one SVG (called only when data changes, never per poll tick). Types: line, area,
// bar, scatter, pie, donut. spec = { type, rows, x, y:[fields], colors:[], title }.
//
// Numbers are coerced from row values; non-numeric rows are skipped for value axes. The x
// axis uses the `x` column as a category label (line/bar/area/scatter) or pie slice label.

const PAL = ["#4ea1ff", "#9ece6a", "#ff9e64", "#bb9af7", "#f7768e", "#e0af68", "#73daca", "#7dcfff"];
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export function drawChart(host, spec) {
  const rows = spec.rows || [];
  const ys = (spec.y && spec.y.length ? spec.y : []).filter(Boolean);
  const colors = (i) => spec.colors?.[i] || PAL[i % PAL.length];
  const W = host.clientWidth || 360, H = host.clientHeight || 220;
  const pad = { l: 38, r: 12, t: spec.title ? 24 : 10, b: 26 };
  const iw = Math.max(10, W - pad.l - pad.r), ih = Math.max(10, H - pad.t - pad.b);

  if (!rows.length || (!ys.length && spec.type !== "pie" && spec.type !== "donut")) {
    host.innerHTML = `<div class="pw-chart-empty">no data</div>`;
    return;
  }

  const title = spec.title ? `<text class="pw-ch-title" x="${W / 2}" y="14" text-anchor="middle">${esc(spec.title)}</text>` : "";

  if (spec.type === "pie" || spec.type === "donut") {
    const field = ys[0] || spec.x;
    const slices = rows.map((r) => ({ label: r[spec.x], v: num(r[field]) || 0 })).filter((s) => s.v > 0);
    const total = slices.reduce((a, s) => a + s.v, 0) || 1;
    const cx = W / 2, cy = pad.t + ih / 2, R = Math.min(iw, ih) / 2 - 4, r0 = spec.type === "donut" ? R * 0.55 : 0;
    let a0 = -Math.PI / 2, paths = "";
    slices.forEach((s, i) => {
      const a1 = a0 + (s.v / total) * Math.PI * 2;
      const big = a1 - a0 > Math.PI ? 1 : 0;
      const p = (r, a) => `${(cx + r * Math.cos(a)).toFixed(1)} ${(cy + r * Math.sin(a)).toFixed(1)}`;
      const d = r0 > 0
        ? `M ${p(r0, a0)} L ${p(R, a0)} A ${R} ${R} 0 ${big} 1 ${p(R, a1)} L ${p(r0, a1)} A ${r0} ${r0} 0 ${big} 0 ${p(r0, a0)} Z`
        : `M ${cx} ${cy} L ${p(R, a0)} A ${R} ${R} 0 ${big} 1 ${p(R, a1)} Z`;
      paths += `<path d="${d}" fill="${colors(i)}"><title>${esc(s.label)}: ${s.v}</title></path>`;
      a0 = a1;
    });
    host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="pw-chart">${title}${paths}</svg>`;
    return;
  }

  // value range across all y series
  let lo = Infinity, hi = -Infinity;
  for (const f of ys) for (const r of rows) { const v = num(r[f]); if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }
  if (!Number.isFinite(lo)) { host.innerHTML = `<div class="pw-chart-empty">no numeric data</div>`; return; }
  if (lo === hi) { hi = lo + 1; lo = Math.min(lo, 0); } else if (lo > 0) lo = 0;
  const X = (i) => pad.l + (rows.length === 1 ? iw / 2 : (i / (rows.length - 1)) * iw);
  const Y = (v) => pad.t + ih - ((v - lo) / (hi - lo)) * ih;

  // y ticks at lo / midpoint / hi: a faint horizontal gridline (except at lo, which is the
  // x-axis itself) plus a value label, so a point's height reads off without guessing.
  const ticks = [lo, (lo + hi) / 2, hi];
  const grid = ticks.map((t) => {
    const y = Y(t);
    const ln = t === lo ? "" : `<line class="pw-grid" x1="${pad.l}" y1="${y.toFixed(1)}" x2="${pad.l + iw}" y2="${y.toFixed(1)}"/>`;
    return ln + `<text class="pw-axlbl" x="${pad.l - 4}" y="${(y + 3).toFixed(1)}" text-anchor="end">${esc(fmt(t))}</text>`;
  }).join("");
  const axes = `<line class="pw-ax" x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${pad.t + ih}"/>`
    + `<line class="pw-ax" x1="${pad.l}" y1="${pad.t + ih}" x2="${pad.l + iw}" y2="${pad.t + ih}"/>`
    + grid;

  let body = "";
  if (spec.type === "bar") {
    const groupW = iw / rows.length, bw = Math.max(1, (groupW * 0.8) / ys.length);
    rows.forEach((r, i) => ys.forEach((f, s) => {
      const v = num(r[f]); if (v == null) return;
      const x = pad.l + i * groupW + groupW * 0.1 + s * bw, y = Y(v), h = pad.t + ih - y;
      body += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" fill="${colors(s)}"><title>${esc(r[spec.x])}: ${v}</title></rect>`;
    }));
  } else {
    ys.forEach((f, s) => {
      const pts = rows.map((r, i) => ({ x: X(i), v: num(r[f]), lbl: r[spec.x] })).filter((p) => p.v != null);
      if (!pts.length) return;
      const line = pts.map((p, i) => `${i ? "L" : "M"} ${p.x.toFixed(1)} ${Y(p.v).toFixed(1)}`).join(" ");
      if (spec.type === "area") {
        const area = `${line} L ${pts[pts.length - 1].x.toFixed(1)} ${(pad.t + ih).toFixed(1)} L ${pts[0].x.toFixed(1)} ${(pad.t + ih).toFixed(1)} Z`;
        body += `<path d="${area}" fill="${colors(s)}" fill-opacity="0.25"/>`;
      }
      if (spec.type !== "scatter") body += `<path d="${line}" fill="none" stroke="${colors(s)}" stroke-width="2"/>`;
      if (spec.type === "scatter" || spec.type === "line") body += pts.map((p) => {
        const cy = Y(p.v).toFixed(1), cx = p.x.toFixed(1);
        // visible dot + a larger transparent disc that catches the hover and shows the value
        return `<circle cx="${cx}" cy="${cy}" r="2.6" fill="${colors(s)}"/>`
          + `<circle cx="${cx}" cy="${cy}" r="7" fill="transparent"><title>${esc(p.lbl)}: ${esc(fmt(p.v))}</title></circle>`;
      }).join("");
    });
  }
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="pw-chart">${title}${axes}${body}</svg>`;
}

function fmt(v) { return Number.isInteger(v) ? String(v) : v.toFixed(1); }
