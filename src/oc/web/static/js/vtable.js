// VTable — a virtualized, searchable data table.
//
// Renders only the rows that fit the viewport (RecyclerView-style): a small pool of row
// elements is reused as you scroll, so a 100k-row dataset costs the same DOM as a 30-row
// one. The user sees one long scrollable list. Built with createElement + textContent only
// (never innerHTML per row), so there's no churn.
//
// Features:
//  - scroll-based virtualization (no pages), element recycling
//  - a custom scrollbar styled like the app's, with a correctly-sized/positioned thumb
//  - live filtering: wildcards (*, ?), AND / OR / NOT, parentheses, quoted phrases
//  - a "rows" control to pin how many rows are visible (blank = fit the container, which
//    auto-updates when the node is resized)
//
// Usage:
//   const vt = new VTable(hostEl);
//   vt.setData(columns /* string[] */, rows /* object[] */, { rowClass(row){…} });

import { colResizeDrag } from "./graph/dragresize.js";

const ROW_H = 22;        // fixed row height (px) — virtualization needs a known height
const BUFFER = 6;        // extra rows rendered above/below the viewport

// CSS font shorthand for canvas text measurement (built from parts — the `font` shorthand
// is often empty when set via separate CSS properties).
function fontOf(el) {
  const s = getComputedStyle(el);
  return `${s.fontStyle} ${s.fontWeight} ${s.fontSize}/${s.lineHeight} ${s.fontFamily}`;
}

// Per-table column widths persist (by table id) so they travel with the profile, mirroring
// table.js. Until wired by the host app, an in-memory fallback keeps resizing working.
let _store = (() => {
  const mem = new Map();
  return { load: (id) => mem.get(id) || {}, save: (id, st) => mem.set(id, st) };
})();
export function setVTableStore(store) { _store = store; }

export class VTable {
  constructor(host, id = null) {
    this.host = host;
    this.id = id;
    this.widths = (id ? _store.load(id).widths : null) || {};   // colName -> px (else flex)
    this.columns = [];
    this.rows = [];          // [{ values:object, text:string(lowercased) }]
    this.filtered = [];      // subset of this.rows after search
    this.pool = [];          // reused .vt-row elements
    this.cellCount = 0;      // cells currently built per pooled row
    this.pred = null;        // compiled search predicate or null
    this.pinned = null;      // explicit visible-row count, or null = fit container
    this.rowClass = null;
    this.sortCol = null;     // sorted column index, or null
    this.sortDir = 1;        // 1 asc, -1 desc
    this.expander = null;    // async fn(values) -> detail node; when set, a row click expands inline
    this.expandedRow = null; // the row record (in this.rows) whose detail is open, or null
    this.expandEl = null;    // the inline detail element, or null
    this.expandH = 0;        // measured detail height (px), folded into the layout
    this._batchCount = null;  // optional batch tally shown in the bar meta (null = not applicable)
    this._raf = null;
    this._build();
  }

  // ---- DOM scaffold (built once) ----
  _build() {
    this.host.classList.add("vt-host");
    const el = this.el = document.createElement("div");
    el.className = "vt";

    const bar = document.createElement("div");
    bar.className = "vt-bar";
    this.search = document.createElement("input");
    this.search.className = "vt-search";
    this.search.type = "text";
    this.search.placeholder = "search…  (AND OR NOT, *, ?)";
    this.search.spellcheck = false;
    this.clearBtn = document.createElement("button");
    this.clearBtn.className = "vt-clear";
    this.clearBtn.textContent = "✕";
    this.clearBtn.title = "clear filter";
    this.clearBtn.hidden = true;
    this.rowsInput = document.createElement("input");
    this.rowsInput.className = "vt-rows-n";
    this.rowsInput.type = "number";
    this.rowsInput.min = "1";
    this.rowsInput.title = "rows shown at once (blank = fit)";
    this.rowsInput.placeholder = "fit";
    this.rowsInput.hidden = true;   // hidden by default — fits the container; shown only on demand
    // hover-revealed reset: clears this table's column widths/order/sort back to defaults
    this.resetBtn = document.createElement("button");
    this.resetBtn.className = "vt-reset";
    this.resetBtn.title = "reset columns (width · order · sort) to defaults";
    this.resetBtn.textContent = "⟲";
    this.count = document.createElement("span");
    this.count.className = "vt-count muted";
    // Always-on tally at the far right of the bar: total line count (the table owns it) plus an
    // optional batch count the caller feeds via setBatchCount (datasets have batches; subsets/
    // precap don't, so theirs shows lines only).
    this.meta = document.createElement("span");
    this.meta.className = "vt-meta muted";
    bar.append(this.search, this.clearBtn, this.rowsInput, this.resetBtn, this.count, this.meta);

    this.head = document.createElement("div");
    this.head.className = "vt-head";

    const main = this.main = document.createElement("div");
    main.className = "vt-main";
    this.scroll = document.createElement("div");
    this.scroll.className = "vt-scroll";
    this.spacer = document.createElement("div");
    this.spacer.className = "vt-spacer";
    this.rowsEl = document.createElement("div");
    this.rowsEl.className = "vt-rows";
    this.scroll.append(this.spacer, this.rowsEl);
    // one scrollbar primitive per axis (both built from the same class — no copy-paste bar);
    // native bars stay hidden, these drive scrollTop/scrollLeft.
    this.vbar = new VtScrollbar(this.scroll, "y");
    this.hbar = new VtScrollbar(this.scroll, "x");
    main.append(this.scroll, this.vbar.bar, this.hbar.bar);

    el.append(bar, this.head, main);
    this.host.appendChild(el);

    this.head.addEventListener("click", (e) => {
      if (e.target.classList.contains("vt-grip")) return;       // a grip click isn't a sort
      if (this._resized) { this._resized = false; return; }     // drag ended over the header
      if (this._reordered) { this._reordered = false; return; } // a column drag isn't a sort
      const th = e.target.closest(".vt-th"); if (th) this._onHeader(+th.dataset.c);
    });
    this.rowsEl.addEventListener("click", (e) => {
      if (e.target.closest(".vt-detail")) return;        // clicks inside the drill-down aren't row clicks
      const row = e.target.closest(".vt-row");
      if (!row || row._idx == null) return;
      if (this.expander) this._toggleExpand(row._idx);
      else if (this.onRowClick) this.onRowClick(this.filtered[row._idx]?.values);
    });
    this.search.addEventListener("input", () => this._onSearch());
    this.clearBtn.addEventListener("click", () => { this.search.value = ""; this._onSearch(); this.search.focus(); });
    this.rowsInput.addEventListener("input", () => { const n = parseInt(this.rowsInput.value, 10); this.pinned = n > 0 ? n : null; this._applyHeight(); });
    this.resetBtn.addEventListener("click", () => this._reset());
    // keep the (overflow-clipped) header aligned with the body's horizontal scroll, then redraw
    this.scroll.addEventListener("scroll", () => { this._syncHead(); this._schedule(); });
    this._ro = new ResizeObserver(() => this._applyHeight());
    this._ro.observe(this.scroll);
  }

  destroy() { this._ro.disconnect(); if (this._raf) cancelAnimationFrame(this._raf); this.el.remove(); }

  // ---- data ----
  setData(columns, rows, opts = {}) {
    this._serverCols = (columns || []).slice();   // original order, for reset
    this.columns = this._applyOrder(columns || []);
    this.rowClass = opts.rowClass || null;
    this.onRowClick = opts.onRowClick || null;
    this.expander = opts.expander || null;   // async fn(values) -> detail node (inline row drill-down)
    const cell = opts.cell || ((row, c) => { const v = row[c]; return v == null ? "" : String(v); });
    this._cell = cell;
    this._collapse();         // new data invalidates any open detail
    this.rows = (rows || []).map((row) => ({
      values: row,
      text: this.columns.map((c) => cell(row, c)).join("  ").toLowerCase(),
    }));
    this._applySort();        // restore the persisted sort against the (possibly new) columns
    this._renderHead();
    this._filter();           // builds this.filtered + renders
    this._renderMeta();       // line count follows the new data (batch count, if any, persists)
  }

  // Caller-supplied batch tally for the bar meta (null = table has no batches -> show lines only).
  setBatchCount(n) { this._batchCount = (n == null ? null : n); this._renderMeta(); }

  // Always-on right-side tally: total lines, plus batches when applicable.
  _renderMeta() {
    if (!this.meta) return;
    const lines = this.rows.length;
    const parts = [`${lines} line${lines === 1 ? "" : "s"}`];
    if (this._batchCount != null) parts.push(`${this._batchCount} batch${this._batchCount === 1 ? "" : "es"}`);
    this.meta.textContent = parts.join("  ·  ");
  }

  _renderHead() {
    this.head.textContent = "";
    this.columns.forEach((c, i) => {
      const h = document.createElement("span");
      h.className = "vt-cell vt-th";
      h.dataset.c = i;
      h.textContent = c;
      h.addEventListener("mousedown", (e) => {   // drag the header to reorder columns
        if (e.button !== 0 || e.target.classList.contains("vt-grip")) return;
        this._startReorder(e, i);
      });
      if (this.sortCol === i) {
        const s = document.createElement("span");
        s.className = "vt-sort";
        s.textContent = this.sortDir === 1 ? " ▲" : " ▼";
        h.appendChild(s);
      }
      // a lone column always spans the whole table — no width to set, so no resize grip
      if (this.columns.length > 1) {
        const grip = document.createElement("span");
        grip.className = "vt-grip";
        grip.title = "drag to resize · double-click to fit";
        grip.addEventListener("mousedown", (e) => this._startResize(e, i));
        grip.addEventListener("dblclick", (e) => { e.preventDefault(); e.stopPropagation(); this._autofit(i); });
        h.appendChild(grip);
      }
      this.head.appendChild(h);
    });
    this._applyWidths();
  }

  // Apply per-column widths to the header + every pooled body cell, and decide whether the
  // table overflows horizontally. A column with a stored width is fixed (flex:0 0 w); the
  // rest stay flexible (flex:1 1 0) and share the slack — UNTIL the fixed widths no longer
  // leave each flexible column a readable floor. Then every column gets a pixel width and the
  // body scrolls sideways (so a widened column never squeezes the others to nothing).
  _applyWidths() {
    const GUTTER = 9, FLEXMIN = 80;
    const single = this.columns.length <= 1;          // a lone column always fills the table
    const widthOf = (c) => (single ? undefined : this.widths[c]);
    const fixed = this.columns.map(widthOf);
    const fixedSum = fixed.reduce((s, w) => s + (w || 0), 0);
    const nFlex = fixed.filter((w) => !w).length;
    const avail = Math.max(0, (this.scroll.clientWidth || 0) - GUTTER);
    const overflow = avail > 0 && fixedSum + nFlex * FLEXMIN > avail;
    this._hScroll = overflow;
    const apply = (el, i) => {
      if (!el) return;
      const w = fixed[i] || (overflow ? FLEXMIN : 0);   // flexible cols get a floor in overflow mode
      el.style.flex = w ? `0 0 ${w}px` : "1 1 0";
      el.style.width = w ? `${w}px` : "";
      el.style.minWidth = w ? `${w}px` : "";
    };
    this.columns.forEach((c, i) => apply(this.head.children[i], i));
    for (const row of this.pool) row._cells.forEach((cell, i) => apply(cell, i));
    // overflow: pin the rows to the full column span so the scroll area is wider than the
    // viewport; otherwise let them flex to the viewport (right gutter clears the vertical bar).
    // The head stays at viewport width (NOT contentW) — widening it would overflow .vt-host and
    // raise a second, native horizontal scrollbar. Its fixed-width cells overflow + clip, and
    // _syncHead slides them to track the body's scroll.
    const contentW = overflow ? fixedSum + nFlex * FLEXMIN + GUTTER : 0;
    this.rowsEl.style.width = contentW ? `${contentW}px` : "";
    this.rowsEl.style.right = contentW ? "auto" : "";
    this.spacer.style.width = contentW ? `${contentW}px` : "";
    this._syncHead();
  }

  // Match the header's horizontal scroll to the body's. The head is overflow:hidden (a fixed
  // clip box) but its scrollLeft can still be set programmatically, so its cells slide while
  // the clip window stays put — transforming the head instead would move the clip box too.
  _syncHead() { this.head.scrollLeft = this._hScroll ? this.scroll.scrollLeft : 0; }

  // Restore this table to its defaults: clear column widths, sort, and reorder, and wipe the
  // persisted overrides. The reset control reveals on hover (see .vt-reset in tables.css).
  _reset() {
    this.widths = {};
    this.sortCol = null; this.sortDir = 1;
    this.columns = (this._serverCols || this.columns).slice();
    if (this.id) _store.save(this.id, { ...(_store.load(this.id)), widths: {}, order: [], sorts: [] });
    this._renderHead();
    this._filter();
    this.onReorder && this.onReorder(this.columns.slice());   // host (e.g. hide-toggle row) follows
  }

  // CSS scale this table is rendered at (graph nodes live inside a `scale(zoom)` transform).
  // Measured from the header itself so VTable needn't know the graph's zoom: rect width is
  // post-scale, offsetWidth is the local layout width, so their ratio is the scale factor.
  // Mouse deltas are in SCREEN px; ÷ scale converts them to the head's local coordinate space.
  _scale() { const w = this.head.offsetWidth; return w ? this.head.getBoundingClientRect().width / w : 1; }

  _startResize(e, i) {
    const name = this.columns[i];
    const th = this.head.children[i];
    const startW = this.widths[name] || th.offsetWidth || 80;
    const scale = this._scale();   // constant during the drag
    colResizeDrag(e, {
      moved: () => { this._resized = true; },   // suppress the trailing sort click
      onDelta: (dx) => { this.widths[name] = Math.max(36, Math.round(startW + dx / scale)); this._applyWidths(); },
      onSettle: () => { if (this.id) _store.save(this.id, { ...(_store.load(this.id)), widths: this.widths }); },
    });
  }

  // Double-click the grip: size the column to fit its header + every cell's text.
  _autofit(i) {
    const name = this.columns[i];
    this.widths[name] = this._measureCol(name);
    this._applyWidths();
    if (this.id) _store.save(this.id, { ...(_store.load(this.id)), widths: this.widths });
  }

  // Natural width that fits column `name`: the widest of its header and all (filtered) cell
  // values, measured via canvas so it's independent of the table's current fixed layout.
  // Clamped; header gets extra room for the sort-icon/grip overlay.
  _measureCol(name) {
    const cv = VTable._cv || (VTable._cv = document.createElement("canvas"));
    const ctx = cv.getContext("2d");
    const th = this.head.children[this.columns.indexOf(name)];
    const bodyCell = this.pool.find((r) => r.style.display !== "none")?._cells[0];
    ctx.font = fontOf(th || this.head);
    let max = ctx.measureText(name).width + 18;        // header text + icon/grip overlay room
    ctx.font = fontOf(bodyCell || th || this.head);
    for (const rec of this.rows) {
      const w = ctx.measureText(this._cell(rec.values, name)).width;
      if (w > max) max = w;
    }
    return Math.min(600, Math.max(36, Math.ceil(max) + 12));   // cell padding/slack, clamped
  }

  // ---- column reorder (drag a header) ----
  // Saved order is a column-name list (by name, not index, so it survives column add/remove)
  // persisted in the same per-table store as widths/sorts, so it travels with the profile.
  _savedOrder() { return (this.id ? _store.load(this.id).order : null) || null; }
  _saveOrder() { if (this.id) _store.save(this.id, { ...(_store.load(this.id)), order: this.columns.slice() }); }

  // ---- sort persistence ----
  // Sort travels with the profile in the same per-table store as widths/order. Stored by
  // column NAME (not index, so it survives reorder/add/remove) as a single-element `sorts`
  // array, matching table.js's shape (dir: 1 asc, -1 desc).
  _savedSort() { const s = this.id ? _store.load(this.id).sorts : null; return (Array.isArray(s) && s.length) ? s[0] : null; }
  _saveSort() {
    if (!this.id) return;
    const sorts = this.sortCol != null ? [{ col: this.columns[this.sortCol], dir: this.sortDir }] : [];
    _store.save(this.id, { ...(_store.load(this.id)), sorts });
  }
  // Resolve the persisted sort against the current columns. No id (store unwired) -> leave the
  // in-memory sort alone so it survives the poll's setData re-renders.
  _applySort() {
    if (!this.id) return;
    const s = this._savedSort();
    this.sortCol = null; this.sortDir = 1;
    if (s && s.col) {
      const i = this.columns.indexOf(s.col);
      if (i >= 0) { this.sortCol = i; this.sortDir = s.dir === -1 ? -1 : 1; }
    }
  }

  // Reorder incoming columns to the saved order; columns not in the saved list (new ones)
  // keep their server order and append at the end. No saved order → leave as-is.
  _applyOrder(cols) {
    const ord = this._savedOrder();
    if (!ord || !ord.length) return cols;
    const have = new Set(cols);
    const out = ord.filter((c) => have.has(c));
    const seen = new Set(out);
    for (const c of cols) if (!seen.has(c)) out.push(c);
    return out;
  }

  _startReorder(e, from) {
    const startX = e.clientX;
    const scale = this._scale();   // marker.left is in the head's local (pre-zoom) space
    let dragging = false, to = from;
    const marker = document.createElement("div");
    marker.className = "vt-col-marker";
    const ths = () => [...this.head.children].filter((c) => c.classList.contains("vt-th"));
    const move = (ev) => {
      if (!dragging) {
        if (Math.abs(ev.clientX - startX) < 4) return;   // threshold: a small move is still a click
        dragging = true;
        this.head.classList.add("vt-reordering");
        this.head.appendChild(marker);
        ths()[from]?.classList.add("vt-dragcol");
      }
      const cells = ths();
      to = cells.length;
      for (let k = 0; k < cells.length; k++) {
        const r = cells[k].getBoundingClientRect();
        if (ev.clientX < r.left + r.width / 2) { to = k; break; }
      }
      const headRect = this.head.getBoundingClientRect();
      const ref = cells[to];
      const x = ref ? ref.getBoundingClientRect().left : (cells[cells.length - 1]?.getBoundingClientRect().right ?? headRect.left);
      marker.style.left = `${(x - headRect.left) / scale + this.head.scrollLeft}px`;
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      this.head.classList.remove("vt-reordering");
      marker.remove();
      ths()[from]?.classList.remove("vt-dragcol");
      if (!dragging) return;
      this._reordered = true;                       // suppress the trailing sort click
      let dest = to > from ? to - 1 : to;           // removing `from` shifts later indices left
      if (dest === from || dest < 0) return;
      const sortName = this.sortCol != null ? this.columns[this.sortCol] : null;
      const cols = this.columns.slice();
      const [c] = cols.splice(from, 1);
      cols.splice(dest, 0, c);
      this.columns = cols;
      this.sortCol = sortName != null ? this.columns.indexOf(sortName) : null;   // keep sort on its column
      this._saveOrder();
      this._renderHead();   // re-applies widths by name; body cells re-map to new order on render
      this._render();
      this.onReorder && this.onReorder(this.columns.slice());   // host (e.g. hide-toggle row) follows
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  }

  // ---- inline drill-down (one expanded row at a time) ----
  // Toggle the detail panel under filtered row `idx`. The opened row is tracked by record
  // identity so it survives re-sort/re-filter; the panel folds into the virtualized layout
  // (rows below it shift down by its height).
  async _toggleExpand(idx) {
    const rec = this.filtered[idx];
    if (!rec) return;
    if (this.expandedRow === rec) { this._collapse(); this._render(); return; }
    this._collapse();
    this.expandedRow = rec;
    this.expandEl = document.createElement("div");
    this.expandEl.className = "vt-detail";
    this.expandEl.innerHTML = `<div class="vt-detail-inner"><p class="muted" style="padding:6px">loading…</p></div>`;
    this.rowsEl.appendChild(this.expandEl);
    this._measureExpand();
    this._render();
    if (this.expander) {
      let node;
      try { node = await this.expander(rec.values); }
      catch (e) { node = document.createElement("div"); node.className = "vt-detail-inner"; node.textContent = String(e?.message || e); }
      if (this.expandedRow !== rec || !this.expandEl) return;   // collapsed/changed while awaiting
      this.expandEl.replaceChildren(node);
      this._measureExpand();
      this._render();
    }
  }
  _measureExpand() { this.expandH = this.expandEl ? this.expandEl.offsetHeight : 0; }
  _collapse() {
    if (this.expandEl) this.expandEl.remove();
    this.expandEl = null; this.expandedRow = null; this.expandH = 0;
  }

  // click a header: asc -> desc -> unsorted
  _onHeader(i) {
    if (this.sortCol === i) {
      if (this.sortDir === 1) this.sortDir = -1;
      else { this.sortCol = null; this.sortDir = 1; }
    } else { this.sortCol = i; this.sortDir = 1; }
    this._saveSort();
    this._renderHead();
    this._filter();
  }
  _sortView() {
    if (this.sortCol == null) return;
    const col = this.columns[this.sortCol], dir = this.sortDir, cell = this._cell;
    this.filtered = this.filtered.slice().sort((a, b) =>
      dir * String(cell(a.values, col)).localeCompare(String(cell(b.values, col)), undefined, { numeric: true, sensitivity: "base" }));
  }

  // ---- search ----
  _onSearch() {
    const q = this.search.value;
    this.clearBtn.hidden = !q;
    this.pred = compileQuery(q);
    this._filter();
  }
  _filter() {
    this.filtered = this.pred ? this.rows.filter((r) => { try { return this.pred(r.text); } catch { return true; } }) : this.rows;
    this._sortView();
    if (this.expandedRow && !this.filtered.includes(this.expandedRow)) this._collapse();   // opened row filtered out
    const total = this.rows.length, shown = this.filtered.length;
    // count is a search result — only meaningful while filtering; hide it when nothing's searched
    this.count.hidden = !this.pred;
    this.count.textContent = this.pred ? `${shown} / ${total}` : "";
    this.scroll.scrollTop = 0;
    this._applyHeight();
  }

  // ---- sizing ----
  // visible-row count is either pinned or however many fit the scroll viewport
  _applyHeight() {
    if (this.pinned) {
      this.main.style.flex = "none";
      this.main.style.height = `${this.pinned * ROW_H}px`;
    } else {
      this.main.style.flex = "";
      this.main.style.height = "";
    }
    this._render();
  }

  _schedule() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = null; this._render(); });
  }

  // ---- the virtualization core ----
  _render() {
    const total = this.filtered.length;
    // an open detail panel adds `extra` px directly below its row; everything under it shifts down
    const eIdx = this.expandedRow ? this.filtered.indexOf(this.expandedRow) : -1;
    const extra = eIdx >= 0 ? this.expandH : 0;
    const detailTop = eIdx >= 0 ? (eIdx + 1) * ROW_H : 0;
    const yOf = (idx) => idx * ROW_H + (eIdx >= 0 && idx > eIdx ? extra : 0);
    const contentH = total * ROW_H + extra;
    this.spacer.style.height = `${contentH}px`;
    const viewH = this.scroll.clientHeight || 0;
    const scrollTop = this.scroll.scrollTop;
    const visible = Math.ceil(viewH / ROW_H) + BUFFER + Math.ceil(extra / ROW_H);
    // invert yOf: undo the detail shift for the region scrolled past the panel
    let top = scrollTop;
    if (eIdx >= 0 && scrollTop > detailTop) top -= Math.min(extra, scrollTop - detailTop);
    let start = Math.floor(top / ROW_H) - (BUFFER >> 1);
    start = Math.max(0, Math.min(start, Math.max(0, total - visible)));   // never render past the end
    const end = Math.min(total, start + visible);
    // park the detail panel under its row (or hide it when its row is off the current view)
    if (this.expandEl) {
      const on = eIdx >= 0;
      this.expandEl.style.display = on ? "" : "none";
      if (on) this.expandEl.style.transform = `translateY(${detailTop}px)`;
    }

    // (re)build the pool when the row's cell layout changes (column count) or it grows
    const need = end - start;
    if (this.cellCount !== this.columns.length) { this.pool.forEach((r) => r.remove()); this.pool = []; this.cellCount = this.columns.length; }
    while (this.pool.length < need) {
      const row = document.createElement("div");
      row.className = "vt-row";
      row._cells = [];
      for (let c = 0; c < this.cellCount; c++) {
        const cell = document.createElement("span");
        cell.className = "vt-cell";
        row.appendChild(cell);
        row._cells.push(cell);
      }
      this.rowsEl.appendChild(row);
      this.pool.push(row);
    }
    this._applyWidths();    // newly built rows (and any post-resize) get current column widths
    // assign data to pooled rows; recycle by index
    for (let i = 0; i < this.pool.length; i++) {
      const row = this.pool[i];
      const idx = start + i;
      if (idx >= end) { row.style.display = "none"; continue; }
      const rec = this.filtered[idx];
      row._idx = idx;
      row.style.display = "";
      row.style.transform = `translateY(${yOf(idx)}px)`;
      row.className = "vt-row" + (this.rowClass ? " " + (this.rowClass(rec.values) || "") : "") + ((idx & 1) ? " odd" : "") + (idx === eIdx ? " vt-open" : "");
      for (let c = 0; c < this.cellCount; c++) row._cells[c].textContent = this._cell(rec.values, this.columns[c]);
    }
    this.vbar.sync(viewH, contentH);
    this.hbar.sync(this.scroll.clientWidth, this.scroll.scrollWidth);
    this.main.classList.toggle("vt-has-hbar", this.scroll.scrollWidth > this.scroll.clientWidth + 1);
  }
}

// One custom scrollbar, either axis — the app hides the native bars, so this draws the thumb
// and drives the scroll element's scrollTop/scrollLeft. Both VTable bars are instances of this
// (no second hand-rolled bar): axis "y" or "x" picks the property names the shared body uses.
class VtScrollbar {
  constructor(scroll, axis) {
    this.scroll = scroll;
    this.axis = axis;                       // "y" | "x"
    this.bar = document.createElement("div");
    this.bar.className = `vt-sb vt-sb-${axis}`;
    this.thumb = document.createElement("div");
    this.thumb.className = "vt-sb-thumb";
    this.bar.appendChild(this.thumb);
    this._wire();
  }

  // axis-specific accessors so one body drives both bars
  _ax() {
    return this.axis === "y"
      ? { pos: "scrollTop",  client: "clientHeight", content: "scrollHeight", side: "height", coord: "clientY", near: "top",  page: 0.9 }
      : { pos: "scrollLeft", client: "clientWidth",  content: "scrollWidth",  side: "width",  coord: "clientX", near: "left", page: 0.9 };
  }

  // size + place the thumb (view = viewport px along the axis, content = total scrollable px).
  // Hidden when everything fits.
  sync(view, content) {
    const a = this._ax();
    if (content <= view + 1 || !view) { this.bar.style.display = "none"; return; }
    this.bar.style.display = "";
    const thumb = Math.max(18, view * view / content);
    const off = (content - view) ? (this.scroll[a.pos] / (content - view)) * (view - thumb) : 0;
    this.thumb.style[a.side] = `${thumb}px`;
    this.thumb.style.transform = this.axis === "y" ? `translateY(${off}px)` : `translateX(${off}px)`;
  }

  _wire() {
    const a = this._ax();
    this.thumb.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      const start = ev[a.coord], startScroll = this.scroll[a.pos];
      const view = this.scroll[a.client], content = this.scroll[a.content];
      const thumb = Math.max(18, view * view / content);
      const maxThumb = view - thumb, maxScroll = content - view;
      const mv = (e) => { this.scroll[a.pos] = startScroll + (maxThumb ? ((e[a.coord] - start) / maxThumb) * maxScroll : 0); };
      const up = () => { document.removeEventListener("mousemove", mv); document.removeEventListener("mouseup", up); };
      document.addEventListener("mousemove", mv); document.addEventListener("mouseup", up);
    });
    // click the track: page toward the click
    this.bar.addEventListener("mousedown", (ev) => {
      if (ev.target === this.thumb) return;
      const r = this.bar.getBoundingClientRect(), t = this.thumb.getBoundingClientRect();
      const centre = (this.axis === "y" ? t.top - r.top : t.left - r.left) + t[a.side] / 2;
      const dir = ev[a.coord] < r[a.near] + centre ? -1 : 1;
      this.scroll[a.pos] += dir * this.scroll[a.client] * a.page;
    });
  }
}

// ---- query language: wildcards + AND/OR/NOT + ( ) + "quoted phrase" ----
// Compiles to a predicate (lowercasedRowText) -> boolean, or null for an empty query.
// On a malformed query, falls back to a plain substring match so typing never throws.
export function compileQuery(q) {
  q = (q || "").trim();
  if (!q) return null;
  const toks = [];
  const re = /\s*(\(|\)|"[^"]*"|[^\s()]+)/g;
  let m;
  while ((m = re.exec(q))) toks.push(m[1]);
  if (!toks.length) return null;
  let i = 0;
  const peek = () => toks[i];
  const isOp = (t, op) => !!t && t.toUpperCase() === op;

  function parseOr() {
    let l = parseAnd();
    while (isOp(peek(), "OR")) { i++; const r = parseAnd(); const a = l, b = r; l = (t) => a(t) || b(t); }
    return l;
  }
  function parseAnd() {
    let l = parseNot();
    while (peek() && !isOp(peek(), "OR") && peek() !== ")") {
      if (isOp(peek(), "AND")) i++;
      const r = parseNot(); const a = l, b = r; l = (t) => a(t) && b(t);
    }
    return l;
  }
  function parseNot() {
    if (isOp(peek(), "NOT") || peek() === "-") { i++; const x = parseAtom(); return (t) => !x(t); }
    return parseAtom();
  }
  function parseAtom() {
    let t = peek();
    if (t === "(") { i++; const e = parseOr(); if (peek() === ")") i++; return e; }
    if (t === ")" || t == null) { i++; return () => true; }
    i++;
    if (t.length > 1 && t.startsWith('"') && t.endsWith('"')) t = t.slice(1, -1);
    const rx = termRegex(t);
    return (text) => rx.test(text);
  }
  try {
    const fn = parseOr();
    return fn || null;
  } catch {
    const needle = q.toLowerCase();
    return (text) => text.includes(needle);
  }
}

function termRegex(term) {
  // glob -> regex: escape regex specials (NOT * or ?), then * -> .*, ? -> . ; unanchored, ci
  const src = term.toLowerCase()
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  try { return new RegExp(src); } catch { return new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")); }
}
