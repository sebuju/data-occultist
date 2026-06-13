// Canvas overlay: render a capture, draw labelled boxes, and create / move /
// resize them interactively. Box geometry is kept in fractions (0..1) of the
// image so it maps directly to window-fraction coords in the profile.
//
// The canvas internal resolution stays at the image's native pixels; zoom only
// changes the CSS display width. Mouse mapping uses getBoundingClientRect, so
// drawing stays pixel-accurate at any zoom.

const ROLE_COLOR = {
  region: "#5aa9e6",
  field: "#5aa9e6",
  item: "#e0556b",
  bbox: "#e0556b",
  detect: "#7ddc7d",
  state_detect: "#e6c25a",
  state: "#e6c25a",
  scrollbar: "#7ddc7d",   // same green as detect boxes
  search: "#e89a4c",
  data_area: "#e89a4c",
};

const HANDLE_PX = 5;     // half-size of a resize handle, screen pixels
const MIN_FRAC = 0.004;  // minimum box size in fractions
const LABEL_BASE_PX = 12; // label size on screen at zoom z=1 (scales ∝ z, so it shrinks when zoomed out)
const LABEL_MAX_PX = 16;  // cap so a label never gets giant when zoomed in

// Resize handles: dx/dy in {-1,0,1} mark which edges a handle moves.
const HANDLES = [
  { id: "nw", dx: -1, dy: -1, cur: "nwse-resize" },
  { id: "n", dx: 0, dy: -1, cur: "ns-resize" },
  { id: "ne", dx: 1, dy: -1, cur: "nesw-resize" },
  { id: "e", dx: 1, dy: 0, cur: "ew-resize" },
  { id: "se", dx: 1, dy: 1, cur: "nwse-resize" },
  { id: "s", dx: 0, dy: 1, cur: "ns-resize" },
  { id: "sw", dx: -1, dy: 1, cur: "nesw-resize" },
  { id: "w", dx: -1, dy: 0, cur: "ew-resize" },
];

export class Overlay {
  constructor(canvas, { onCreate, onSelect, onChange, onZoom, onPick } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.img = null;
    this.boxes = [];
    this.activeId = null;
    this.onCreate = onCreate;
    this.onSelect = onSelect;
    this.onChange = onChange;   // a box was moved/resized
    this.onZoom = onZoom;
    this.onPick = onPick;       // eyedropper: sampled "#rrggbb"
    this.picking = false;
    this.op = null;             // active interaction
    this.scale = 1;
    this.gridCells = [];        // faint preview rectangles (fractions)
    this.previewItems = [];     // extracted per-cell values: {x,y,w,h,text,confidence}
    this.detections = [];       // raw OCR lines: {box:{x,y,w,h}, text, confidence}
    this.autoFit = true;        // keep fit-to-width until the user manually zooms
    this.worldZoom = 1;         // outer graph zoom, so UI sizes stay constant on screen
    this._bind();
    // Re-fit when the canvas area resizes (e.g. opened in a modal/iframe whose
    // width arrives after the image loaded). Avoids the image rendering as a sliver.
    if (typeof ResizeObserver !== "undefined" && canvas.parentElement) {
      new ResizeObserver(() => { if (this.img && this.autoFit) this.fit(); }).observe(canvas.parentElement);
    }
  }

  setWorldZoom(z) { this.worldZoom = z || 1; this.render(); }
  setGridPreview(cells) { this.gridCells = cells || []; this.render(); }
  setPreview(items) { this.previewItems = items || []; this.render(); }
  setDetections(items) { this.detections = items || []; this.render(); }

  setImage(img) {
    this.img = img;
    this.canvas.width = img.naturalWidth;
    this.canvas.height = img.naturalHeight;
    this.fit();
    this.render();
  }

  setBoxes(boxes) { this.boxes = boxes; this.render(); }
  setActive(id) { this.activeId = id; this.render(); }

  // ---- zoom (display only) ------------------------------------------------

  _applyScale() {
    if (!this.img) return;
    this.canvas.style.width = `${Math.round(this.img.naturalWidth * this.scale)}px`;
    this.onZoom?.(this.scale);
  }
  setScale(scale) { this.autoFit = false; this.scale = Math.min(8, Math.max(0.05, scale)); this._applyScale(); }
  zoom(factor) { this.setScale(this.scale * factor); }
  fit() {
    if (!this.img) return;
    const avail = (this.canvas.parentElement?.clientWidth || this.img.naturalWidth) - 4;
    if (avail <= 1) return;     // layout not ready; ResizeObserver will retry
    this.setScale(avail / this.img.naturalWidth);
    this.autoFit = true;        // keep auto-fitting on later resizes
  }

  // ---- geometry helpers ---------------------------------------------------

  _frac(ev) {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: (ev.clientX - r.left) / r.width,
      y: (ev.clientY - r.top) / r.height,
      tol: { x: HANDLE_PX / r.width, y: HANDLE_PX / r.height },
    };
  }

  _hitHandle(p, b) {
    if (!b) return null;
    for (const h of HANDLES) {
      // Handle anchor point on the box for this dx/dy.
      const hx = b.x + ((h.dx + 1) / 2) * b.w;
      const hy = b.y + ((h.dy + 1) / 2) * b.h;
      if (Math.abs(p.x - hx) <= p.tol.x && Math.abs(p.y - hy) <= p.tol.y) return h;
    }
    return null;
  }

  _hitBox(p) {
    for (let i = this.boxes.length - 1; i >= 0; i--) {
      const b = this.boxes[i];
      if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) return b;
    }
    return null;
  }

  _clampBox(b) {
    b.w = Math.max(MIN_FRAC, b.w);
    b.h = Math.max(MIN_FRAC, b.h);
    b.x = Math.min(Math.max(0, b.x), 1 - b.w);
    b.y = Math.min(Math.max(0, b.y), 1 - b.h);
  }

  // ---- interaction --------------------------------------------------------

  _bind() {
    // stop propagation only for the LEFT (drawing) button, so right-drag still
    // reaches the graph's pan handler over the canvas
    this.canvas.addEventListener("mousedown", (ev) => { if (ev.button === 0) ev.stopPropagation(); this._onDown(ev); });
    this.canvas.addEventListener("mousemove", (ev) => this._onMove(ev));
    window.addEventListener("mouseup", () => this._onUp());
  }

  setPick(on) { this.picking = on; this.canvas.style.cursor = on ? "crosshair" : "crosshair"; }

  _sampleColor(p) {
    const x = Math.round(p.x * this.canvas.width);
    const y = Math.round(p.y * this.canvas.height);
    const [r, g, b] = this.ctx.getImageData(x, y, 1, 1).data;
    const hex = (n) => n.toString(16).padStart(2, "0");
    return `#${hex(r)}${hex(g)}${hex(b)}`;
  }

  _onDown(ev) {
    if (ev.button !== 0) return;   // left button only; right-click never draws
    const p = this._frac(ev);
    if (this.picking) {
      this.picking = false;
      this.onPick?.(this._sampleColor(p));
      return;
    }
    const active = this.boxes.find((b) => b.id === this.activeId);

    // 1) resize the selected box from an edge/corner handle
    const handle = this._hitHandle(p, active);
    if (handle) {
      this.op = { type: "resize", box: active, handle, orig: { ...active } };
      return;
    }
    // 2) move ONLY from the centre indicator of the selected box
    if (active && this._hitCenter(p, active)) {
      this.op = { type: "move", box: active, start: p, orig: { ...active } };
      return;
    }
    // 3) clicking a box selects it. EXCEPT the data_area backdrop: you draw items
    //    inside it, so a drag there creates a new box (a plain click still selects).
    const hit = this._hitBox(p);
    if (hit && (hit.role === "data_area" || hit.role === "bbox")) {
      this.op = { type: "create", x0: p.x, y0: p.y, x1: p.x, y1: p.y, selHit: hit.id };
      return;
    }
    if (hit) {
      this.activeId = hit.id;
      this.onSelect?.(hit.id);
      this.render();
      return;
    }
    // 4) empty space: deselect, then start a new box
    if (this.activeId !== null) { this.activeId = null; this.onSelect?.(null); this.render(); }
    this.op = { type: "create", x0: p.x, y0: p.y, x1: p.x, y1: p.y };
  }

  _hitCenter(p, b) {
    if (!b) return false;
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    return Math.abs(p.x - cx) <= p.tol.x * 1.8 && Math.abs(p.y - cy) <= p.tol.y * 1.8;
  }

  _onMove(ev) {
    const p = this._frac(ev);
    if (!this.op) {
      this._updateCursor(p);
      return;
    }
    if (this.op.type === "create") {
      this.op.x1 = p.x; this.op.y1 = p.y;
      this.render();
    } else if (this.op.type === "move") {
      const { orig, start, box } = this.op;
      box.x = orig.x + (p.x - start.x);
      box.y = orig.y + (p.y - start.y);
      this._clampBox(box);
      this.render();
    } else if (this.op.type === "resize") {
      this._resize(p);
      this.render();
    }
  }

  _resize(p) {
    const { box, orig, handle } = this.op;
    if (handle.dx === 1) box.w = p.x - orig.x;
    if (handle.dx === -1) { box.x = p.x; box.w = orig.x + orig.w - p.x; }
    if (handle.dy === 1) box.h = p.y - orig.y;
    if (handle.dy === -1) { box.y = p.y; box.h = orig.y + orig.h - p.y; }
    // Guard against inverted drags past the opposite edge.
    if (box.w < MIN_FRAC) { box.w = MIN_FRAC; if (handle.dx === -1) box.x = orig.x + orig.w - MIN_FRAC; }
    if (box.h < MIN_FRAC) { box.h = MIN_FRAC; if (handle.dy === -1) box.y = orig.y + orig.h - MIN_FRAC; }
    this._clampBox(box);
  }

  _onUp() {
    if (!this.op) return;
    const op = this.op;
    this.op = null;
    if (op.type === "create") {
      const b = {
        x: Math.min(op.x0, op.x1), y: Math.min(op.y0, op.y1),
        w: Math.abs(op.x1 - op.x0), h: Math.abs(op.y1 - op.y0),
      };
      this.render();
      if (b.w > MIN_FRAC && b.h > MIN_FRAC) this.onCreate?.(b);
      else if (op.selHit != null) { this.activeId = op.selHit; this.onSelect?.(op.selHit); this.render(); }  // click = select the backdrop
    } else {
      this.onChange?.(op.box);
    }
  }

  _updateCursor(p) {
    const active = this.boxes.find((b) => b.id === this.activeId);
    const h = this._hitHandle(p, active);
    if (h) { this.canvas.style.cursor = h.cur; return; }
    if (active && this._hitCenter(p, active)) { this.canvas.style.cursor = "move"; return; }
    this.canvas.style.cursor = this._hitBox(p) ? "pointer" : "crosshair";
  }

  // ---- render -------------------------------------------------------------

  render() {
    const { ctx, img } = this;
    // Supersample the backing to the on-screen DEVICE resolution (fit scale × graph
    // zoom × dpr), so the canvas is drawn 1:1 with what's shown instead of a small
    // native-res bitmap that the browser upscales (= blur when zoomed in). Bounded so
    // a 4K image zoomed in doesn't allocate a giant canvas.
    const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
    const z = Math.max(this.scale, 1e-4) * Math.max(this.worldZoom, 1e-4);
    let ss = z * dpr;
    if (img) ss = Math.min(ss, 8, 4096 / Math.max(img.naturalWidth, img.naturalHeight));
    ss = Math.max(0.5, ss);
    if (img) {
      const tw = Math.round(img.naturalWidth * ss), th = Math.round(img.naturalHeight * ss);
      if (this.canvas.width !== tw || this.canvas.height !== th) { this.canvas.width = tw; this.canvas.height = th; }
    }
    const W = this.canvas.width, H = this.canvas.height;
    // backing px per ON-SCREEN css px — multiply screen sizes by this so every line,
    // label and handle is a CONSTANT on-screen size (and crisp, since backing is at
    // device resolution). Equals dpr when the supersample isn't clamped.
    const u = ss / z;
    // ONE uniform size for every label (not per-box). On-screen size = LABEL_BASE_PX at
    // the default graph zoom (worldZoom 1), scaling with the GRAPH zoom only — NOT the
    // per-image fit-scale — so it's readable by default, shrinks freely as you zoom the
    // graph out (no floor → labels go tiny instead of piling into a mess), and is capped
    // (LABEL_MAX_PX) so it never gets huge zoomed in. ·u converts screen px to backing
    // px; backing is supersampled so it stays crisp.
    const labelFs = Math.min(LABEL_MAX_PX, LABEL_BASE_PX * this.worldZoom) * u;
    ctx.clearRect(0, 0, W, H);
    if (img) ctx.drawImage(img, 0, 0, W, H);

    // Grid preview: where each field will be read across the tiled grid.
    if (this.gridCells.length) {
      ctx.strokeStyle = "rgba(90,169,230,0.5)";
      ctx.lineWidth = 1 * u;
      ctx.setLineDash([4 * u, 3 * u]);
      for (const c of this.gridCells) ctx.strokeRect(c.x * W, c.y * H, c.w * W, c.h * H);
      ctx.setLineDash([]);
    }

    // Preview read-outs: what OCR pulled from each cell, tinted by confidence. A
    // substituted value (an "if empty"/"if number"/"if text" fallback fired) is
    // config, not a read — neutral tint and the rule's name instead of a %.
    for (const p of this.previewItems) {
      if (p.cell) {
        // a cell-level tag (the matched item template's id): centred on the cell,
        // white on black — no confidence fill, it isn't a read
        this._centerLabel(String(p.text ?? ""), (p.cell.x + p.cell.w / 2) * W, (p.cell.y + p.cell.h / 2) * H, labelFs);
        continue;
      }
      const conf = p.confidence ?? 0;
      const tint = p.substituted ? "138,146,163"
        : conf >= 0.8 ? "125,220,125" : conf >= 0.5 ? "230,194,90" : "230,104,90";
      const x = p.x * W, y = p.y * H, w = p.w * W, h = p.h * H;
      ctx.fillStyle = `rgba(${tint},0.18)`;
      ctx.fillRect(x, y, w, h);
      const txt = p.text === null || p.text === "" || p.text === undefined ? "∅" : String(p.text);
      const tag = p.substituted
        ? `if ${String(p.substituted).replace(/^if_/, "").replace(/_/g, " ")}`
        : `${Math.round(conf * 100)}%`;
      this._label(`${txt}  ${tag}`, x, y + h, `rgb(${tint})`, labelFs);
    }

    // Raw OCR detections: exactly what OCR found and where (independent of boxes).
    for (const d of this.detections) {
      const x = d.box.x * W, y = d.box.y * H, dw = d.box.w * W, dh = d.box.h * H;
      ctx.strokeStyle = "rgba(201,138,230,0.9)";
      ctx.lineWidth = 1 * u;
      ctx.setLineDash([3 * u, 2 * u]);
      ctx.strokeRect(x, y, dw, dh);
      ctx.setLineDash([]);
      this._label(d.text, x, y, "#c98ae6", labelFs);
    }

    for (const b of this.boxes) {
      const color = ROLE_COLOR[b.role] || "#fff";
      const isActive = b.id === this.activeId;
      ctx.lineWidth = (isActive ? 1.4 : 0.9) * u;
      ctx.strokeStyle = color;
      ctx.strokeRect(b.x * W, b.y * H, b.w * W, b.h * H);
      this._label(b.label || b.id || b.role, b.x * W, b.y * H, color, labelFs);
      if (isActive && !this.op) this._drawHandles(b, W, H, u);   // hide handles while dragging
    }

    if (this.op?.type === "create") {
      const x = Math.min(this.op.x0, this.op.x1), y = Math.min(this.op.y0, this.op.y1);
      ctx.setLineDash([5 * u, 4 * u]);
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 1 * u;
      ctx.strokeRect(x * W, y * H, Math.abs(this.op.x1 - this.op.x0) * W, Math.abs(this.op.y1 - this.op.y0) * H);
      ctx.setLineDash([]);
    }
  }

  // ``fs`` is the font size in backing px (content-scaled, capped — see lfs). Drawn at
  // device resolution so it stays crisp at any zoom.
  _label(text, x, y, color, fs) {
    const ctx = this.ctx;
    const pad = fs * 0.28;
    ctx.font = `${fs}px system-ui`;
    const h = fs + pad * 2;
    const w = ctx.measureText(text).width + pad * 2;
    ctx.fillStyle = "rgba(0,0,0,0.65)";
    ctx.fillRect(x, y - h, w, h);      // readable plate behind the text
    ctx.fillStyle = color;
    ctx.textBaseline = "bottom";
    ctx.fillText(text, x + pad, y - pad);
  }

  // Centred variant of _label: solid black plate, white text, anchored on (cx, cy) —
  // used for cell-level read-outs (the item's name on its tile).
  _centerLabel(text, cx, cy, fs) {
    const ctx = this.ctx;
    const pad = fs * 0.28;
    ctx.font = `${fs}px system-ui`;
    const m = ctx.measureText(text);
    const h = fs + pad * 2;
    const w = m.width + pad * 2;
    ctx.fillStyle = "rgba(0,0,0,0.9)";
    ctx.fillRect(cx - w / 2, cy - h / 2, w, h);
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    // optically centre the actual glyph box (baseline maths, not the em box, which
    // sits visibly low for short caps/digit strings like an item id)
    ctx.fillText(text, cx, cy + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2);
    ctx.textAlign = "left";            // restore defaults for the other label paths
    ctx.textBaseline = "bottom";
  }

  _drawHandles(b, W, H, u) {
    const ctx = this.ctx;
    const bw = b.w * W, bh = b.h * H;
    // cap handle size to the box so small boxes aren't swamped by white squares
    const s = Math.max(1.5 * u, Math.min(HANDLE_PX * u, bw * 0.22, bh * 0.22));
    ctx.strokeStyle = "rgba(34,34,34,0.7)";
    ctx.lineWidth = 1 * u;
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    for (const h of HANDLES) {
      const hx = (b.x + ((h.dx + 1) / 2) * b.w) * W;
      const hy = (b.y + ((h.dy + 1) / 2) * b.h) * H;
      ctx.fillRect(hx - s, hy - s, s * 2, s * 2);
      ctx.strokeRect(hx - s, hy - s, s * 2, s * 2);
    }
    // centre move indicator (drag from here)
    const cx = (b.x + b.w / 2) * W, cy = (b.y + b.h / 2) * H;
    const r = Math.max(3 * u, Math.min(HANDLE_PX * 1.5 * u, bw * 0.32, bh * 0.32));
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.fill();
    ctx.stroke();
    ctx.lineWidth = 1.5 * u;
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.55, cy); ctx.lineTo(cx + r * 0.55, cy);
    ctx.moveTo(cx, cy - r * 0.55); ctx.lineTo(cx, cy + r * 0.55);
    ctx.stroke();
  }
}
