// Window panel: window id, dataset, the record key (dedup identity), and the
// scrollable grid. The key is an ORDERED list of fields joined by a separator —
// e.g. arcanes key on name+level so "Arcane Aegis" level 5 and level 3 are
// different records. The key preview shows, live from the last preview read,
// exactly what key the first cell would store under.
// Grid strides are numbers you tune while the live grid preview on the canvas
// shows exactly where each field will be read.
import { fieldset, mount, esc, TRASH } from "../dom.js";
import { buildKey } from "../keys.js";

export function renderWindow(container, model, ctx) {
    const g = model.grid;
    const fs = fieldset("Window &amp; grid", `
    <label>window id <input id="w-id" value="${esc(model.windowId)}" /></label>
    <label>dataset <input id="w-ds" value="${esc(model.dataset)}" placeholder="(defaults to window id)" /></label>
    ${keySection(model, ctx)}
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
    wireKeySection(fs, model, ctx);
    q("#w-grid").addEventListener("change", (e) => { model.grid.enabled = e.target.checked; ctx.refresh(); });
    q("#w-rows").addEventListener("input", (e) => { model.grid.rows = +e.target.value || 1; ctx.refreshOverlay(); });
    q("#w-cols").addEventListener("input", (e) => { model.grid.cols = +e.target.value || 1; ctx.refreshOverlay(); });
    q("#w-rs").addEventListener("input", (e) => { model.grid.rowStride = +e.target.value || 0; ctx.refreshOverlay(); });
    q("#w-cs").addEventListener("input", (e) => { model.grid.colStride = +e.target.value || 0; ctx.refreshOverlay(); });
    q("#w-derive").addEventListener("click", () => { deriveStrides(model); ctx.refresh(); });
    mount(container, fs);
}

function keySection(model, ctx) {
    const key = model.key;
    const fids = model.fields.map((f) => f.id);
    const rows = key.fields.map((fid, i) => `<div class="key-row" data-i="${i}">
      <select class="kfield" data-i="${i}">${(fids.includes(fid) ? fids : [fid, ...fids])
        .map((f) => `<option ${f === fid ? "selected" : ""}>${esc(f)}</option>`).join("")}</select>
      <button class="kmv" data-i="${i}" data-d="-1" ${i === 0 ? "disabled" : ""} title="earlier in the key">▲</button>
      <button class="kmv" data-i="${i}" data-d="1" ${i === key.fields.length - 1 ? "disabled" : ""} title="later in the key">▼</button>
      <button class="kdel danger" data-i="${i}" ${key.fields.length <= 1 ? "disabled" : ""} title="remove from the key">${TRASH}</button>
    </div>`).join("");
    const addable = fids.filter((f) => !key.fields.includes(f));
    return `<div class="key-sec" title="which fields identify a record — reads with the same key merge; a different key (e.g. another level) is its own record. A record missing any key part is dropped.">
    <div class="muted">key (dedup)</div>
    ${rows}
    <div class="key-row">
      ${addable.length ? `<select class="kadd"><option value="">+ field…</option>${addable.map((f) => `<option>${esc(f)}</option>`).join("")}</select>` : ""}
      <label class="flab" title="joins the parts in the stored key">sep <input class="ksep" value="${esc(key.sep ?? "|")}" size="2"/></label>
      <label class="flab" title="treat keys differing only in case as distinct">case <input type="checkbox" class="kcase" ${key.case_sensitive ? "checked" : ""}/></label>
    </div>
    <div class="key-prev" title="the key the first previewed cell would store under">${keyPreview(model, ctx)}</div>
  </div>`;
}

// Live key preview from the last preview read: instant on every config edit (client
// mirror of the server's key build), no OCR round-trip needed.
function keyPreview(model, ctx) {
    const cells = (ctx.previewCells && ctx.previewCells()) || [];
    const cell = cells.find((c) => c.fields && Object.values(c.fields).some((f) => f.value != null && f.value !== ""));
    if (!cell) return '<span class="muted">run a preview to see the key</span>';
    const vals = {};
    for (const [k, v] of Object.entries(cell.fields)) vals[k] = v.value;
    const key = buildKey(vals, model.key);
    if (key !== null) return `→ <b>${esc(key)}</b>`;
    const miss = model.key.fields.find((f) => vals[f] === null || vals[f] === undefined || vals[f] === "");
    return `<span class="warn">∅ no key${miss ? ` — ${esc(miss)} read empty` : ""}</span> <span class="muted">(record dropped)</span>`;
}

function wireKeySection(fs, model, ctx) {
    const edit = (fn) => { fn(model.key); ctx.refresh(); };
    fs.querySelectorAll(".kfield").forEach((s) => s.addEventListener("change", (e) =>
        edit((k) => { k.fields[+e.target.dataset.i] = e.target.value; })));
    fs.querySelectorAll(".kmv").forEach((b) => b.addEventListener("click", () => edit((k) => {
        const i = +b.dataset.i, j = i + (+b.dataset.d);
        if (j < 0 || j >= k.fields.length) return;
        [k.fields[i], k.fields[j]] = [k.fields[j], k.fields[i]];
    })));
    fs.querySelectorAll(".kdel").forEach((b) => b.addEventListener("click", () =>
        edit((k) => { if (k.fields.length > 1) k.fields.splice(+b.dataset.i, 1); })));
    fs.querySelector(".kadd")?.addEventListener("change", (e) => {
        if (e.target.value) edit((k) => { k.fields.push(e.target.value); });
    });
    fs.querySelector(".ksep")?.addEventListener("change", (e) => edit((k) => { k.sep = e.target.value || "|"; }));
    fs.querySelector(".kcase")?.addEventListener("change", (e) => edit((k) => { k.case_sensitive = e.target.checked; }));
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
