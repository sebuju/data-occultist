// Window panel: window id, dataset, the record key (dedup identity), and the
// scrollable grid. The key is an ORDERED list of fields joined by a separator —
// e.g. arcanes key on name+level so "Arcane Aegis" level 5 and level 3 are
// different records. The key preview shows, live from the last preview read,
// exactly what key the first cell would store under.
// Grid strides are numbers you tune while the live grid preview on the canvas
// shows exactly where each field will be read.
import { fieldset, mount, h, frag, TRASH } from "../dom.js";
import { buildKey } from "../keys.js";

export function renderWindow(container, model, ctx) {
    const g = model.grid;
    const body = frag(
        h("label", "window id ", h("input", { id: "w-id", value: model.windowId })),
        h("label", "dataset ", h("input", { id: "w-ds", value: model.dataset, placeholder: "(defaults to window id)" })),
        keySection(model, ctx),
        h("label", { class: "inline" }, h("input", { type: "checkbox", id: "w-grid", checked: g.enabled }), " scrollable grid"),
        h("div", { class: "grid2" },
            h("label", "rows ", h("input", { type: "number", id: "w-rows", min: "1", value: g.rows })),
            h("label", "cols ", h("input", { type: "number", id: "w-cols", min: "1", value: g.cols })),
            h("label", "row Δy ", h("input", { type: "number", id: "w-rs", step: "0.001", value: g.rowStride })),
            h("label", "col Δx ", h("input", { type: "number", id: "w-cs", step: "0.001", value: g.colStride })),
            h("label", { title: "dynamic row lattice: bound the pitch derived from live findings to authored ± this fraction (0..1). Empty = static rows (face-value clustering). Set it to fit/interpolate rows on a scrolled list." },
                "pitch tol ", h("input", { type: "number", id: "w-pt", step: "0.01", min: "0", max: "1", value: g.pitchTolerance ?? "", placeholder: "static" })),
        ),
        h("button", { id: "w-derive", title: "Set strides from the two nearest region boxes" }, "Derive strides from boxes"),
    );
    const fs = fieldset("Window & grid", body, "Window &amp; grid");

    const q = (s) => fs.querySelector(s);
    q("#w-id").addEventListener("input", (e) => { model.windowId = e.target.value.trim(); });
    q("#w-ds").addEventListener("input", (e) => { model.dataset = e.target.value.trim(); });
    wireKeySection(fs, model, ctx);
    q("#w-grid").addEventListener("change", (e) => { model.grid.enabled = e.target.checked; ctx.refresh(); });
    q("#w-rows").addEventListener("input", (e) => { model.grid.rows = +e.target.value || 1; ctx.refreshOverlay(); });
    q("#w-cols").addEventListener("input", (e) => { model.grid.cols = +e.target.value || 1; ctx.refreshOverlay(); });
    q("#w-rs").addEventListener("input", (e) => { model.grid.rowStride = +e.target.value || 0; ctx.refreshOverlay(); });
    q("#w-cs").addEventListener("input", (e) => { model.grid.colStride = +e.target.value || 0; ctx.refreshOverlay(); });
    q("#w-pt").addEventListener("input", (e) => { const v = e.target.value.trim(); model.grid.pitchTolerance = v === "" ? null : (+v || 0); ctx.refreshOverlay(); });
    q("#w-derive").addEventListener("click", () => { deriveStrides(model); ctx.refresh(); });
    mount(container, fs);
}

function keySection(model, ctx) {
    const key = model.key;
    const fids = model.fields.map((f) => f.id);
    const rows = key.fields.map((fid, i) => h("div", { class: "key-row", dataset: { i } },
        h("select", { class: "kfield", dataset: { i } },
            (fids.includes(fid) ? fids : [fid, ...fids]).map((f) =>
                h("option", { selected: f === fid }, f))),
        h("button", { class: "kmv", dataset: { i, d: -1 }, disabled: i === 0, title: "earlier in the key" }, "▲"),
        h("button", { class: "kmv", dataset: { i, d: 1 }, disabled: i === key.fields.length - 1, title: "later in the key" }, "▼"),
        h("button", { class: "kdel danger", dataset: { i }, disabled: key.fields.length <= 1, title: "remove from the key" }, TRASH()),
    ));
    const addable = fids.filter((f) => !key.fields.includes(f));
    return h("div", { class: "key-sec", title: "which fields identify a record — reads with the same key merge; a different key (e.g. another level) is its own record. A record missing any key part is dropped." },
        h("div", { class: "muted" }, "key (dedup)"),
        rows,
        h("div", { class: "key-row" },
            addable.length ? h("select", { class: "kadd" },
                h("option", { value: "" }, "+ field…"),
                addable.map((f) => h("option", f))) : null,
            h("label", { class: "flab", title: "joins the parts in the stored key" },
                "sep ", h("input", { class: "ksep", value: key.sep ?? "|", size: "2" })),
            h("label", { class: "flab", title: "treat keys differing only in case as distinct" },
                "case ", h("input", { type: "checkbox", class: "kcase", checked: key.case_sensitive })),
        ),
        h("div", { class: "key-prev", title: "the key the first previewed cell would store under" }, keyPreview(model, ctx)),
    );
}

// Live key preview from the last preview read: instant on every config edit (client
// mirror of the server's key build), no OCR round-trip needed.
function keyPreview(model, ctx) {
    const cells = (ctx.previewCells && ctx.previewCells()) || [];
    const cell = cells.find((c) => c.fields && Object.values(c.fields).some((f) => f.value != null && f.value !== ""));
    if (!cell) return h("span", { class: "muted" }, "run a preview to see the key");
    const vals = {};
    for (const [k, v] of Object.entries(cell.fields)) vals[k] = v.value;
    const key = buildKey(vals, model.key);
    if (key !== null) return frag("→ ", h("b", key));
    const miss = model.key.fields.find((f) => vals[f] === null || vals[f] === undefined || vals[f] === "");
    return frag(
        h("span", { class: "warn" }, "∅ no key" + (miss ? ` — ${miss} read empty` : "")),
        " ",
        h("span", { class: "muted" }, "(record dropped)"),
    );
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
