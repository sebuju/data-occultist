// Window panel: window id, dataset, key field, and the scrollable grid.
// Grid strides are numbers you tune while the live grid preview on the canvas
// shows exactly where each field will be read.
import { fieldset, mount, esc } from "../dom.js";

export function renderWindow(container, model, ctx) {
  const fieldOpts = model.fields
    .map((f) => `<option value="${esc(f.id)}" ${f.id === model.keyField ? "selected" : ""}>${esc(f.id)}</option>`)
    .join("");
  const g = model.grid;
  const fs = fieldset("Window &amp; grid", `
    <label>window id <input id="w-id" value="${esc(model.windowId)}" /></label>
    <label>dataset <input id="w-ds" value="${esc(model.dataset)}" placeholder="(defaults to window id)" /></label>
    <label>key field (dedup)
      <select id="w-key">${fieldOpts || `<option value="name">name</option>`}</select>
    </label>
    <label class="inline"><input type="checkbox" id="w-grid" ${g.enabled ? "checked" : ""} /> scrollable grid</label>
    <div class="grid2">
      <label>rows <input type="number" id="w-rows" min="1" value="${g.rows}" /></label>
      <label>cols <input type="number" id="w-cols" min="1" value="${g.cols}" /></label>
      <label>row Δy <input type="number" id="w-rs" step="0.001" value="${g.rowStride}" /></label>
      <label>col Δx <input type="number" id="w-cs" step="0.001" value="${g.colStride}" /></label>
    </div>
    <button id="w-derive" title="Set strides from the two nearest region boxes">Derive strides from boxes</button>
  `);

  const q = (s) => fs.querySelector(s);
  q("#w-id").addEventListener("input", (e) => { model.windowId = e.target.value.trim(); });
  q("#w-ds").addEventListener("input", (e) => { model.dataset = e.target.value.trim(); });
  q("#w-key").addEventListener("change", (e) => { model.keyField = e.target.value; });
  q("#w-grid").addEventListener("change", (e) => { model.grid.enabled = e.target.checked; ctx.refresh(); });
  q("#w-rows").addEventListener("input", (e) => { model.grid.rows = +e.target.value || 1; ctx.refreshOverlay(); });
  q("#w-cols").addEventListener("input", (e) => { model.grid.cols = +e.target.value || 1; ctx.refreshOverlay(); });
  q("#w-rs").addEventListener("input", (e) => { model.grid.rowStride = +e.target.value || 0; ctx.refreshOverlay(); });
  q("#w-cs").addEventListener("input", (e) => { model.grid.colStride = +e.target.value || 0; ctx.refreshOverlay(); });
  q("#w-derive").addEventListener("click", () => { deriveStrides(model); ctx.refresh(); });
  mount(container, fs);
}

// Estimate strides from the first region box's size (one row/col apart ~= box pitch).
// A precise version can compare two drawn cells; this gives a sensible starting point.
function deriveStrides(model) {
  const r = model.regionBoxes();
  if (!r.length) return;
  const b = r[0];
  if (model.grid.rowStride === 0) model.grid.rowStride = +(b.h * 1.15).toFixed(4);
  if (model.grid.colStride === 0) model.grid.colStride = +(b.w * 1.05).toFixed(4);
  model.grid.enabled = true;
}
