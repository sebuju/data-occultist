// Inspector (edit mode): edit the selected widget — its binding, type-specific config,
// show/enable conditions, and style. Both config and style are PROFILE groups (a default plus any
// number of named profiles, shown as tabs; a condition can activate one at runtime). Edits commit
// on change, then re-render the page and the inspector so dependent choices refresh.

import { createFloatWin } from "../../graph/floatwin.js";
import { styleEditor } from "../style_editor.js";
import { widgetProfiles, widgetConfigProfiles } from "../profiles.js";
import { nodeInputs, inputMeta } from "../constraints.js";
import { sourceTokenList, resolveToken, subKeyForToken } from "../binding.js";
import { compileTerm, evaluate, truthy } from "../expr.js";
import { el, humanize } from "../widgets/util.js";
import { makeReorderable, arrayMove, orderColumns, setColumnProp } from "../reorder.js";
import { PANEL_OPTIONS } from "../widgets/panel.js";
import { POS_UNITS } from "../canvas.js";
import { svg } from "../../dom.js";

export const inspectorState = { visible: false, x: null, y: null, w: 320, h: null, collapsed: false };

export function buildInspector(ctx) {
    const win = createFloatWin({ id: "pretty-inspector", title: "inspector", state: inspectorState, bothAxes: true, autoFit: false });
    let current = null;
    let condSubs = [];   // live current-value read-outs / profile markers; torn down each render
    let editProfileId = "default";   // which STYLE profile the editor is showing (tab selection)
    let editConfigId = "default";    // which CONFIG profile the editor is showing (tab selection)
    const collapsed = {};   // section key -> collapsed? — persists across inspector re-renders (buildInspector runs once)

    function show(widget) { current = widget; editProfileId = "default"; editConfigId = "default"; win.setVisible(true); render(); }   // visible BEFORE render so height measures right
    function clear() { current = null; render(); }

    // Live profile preview: while the inspector holds focus, the canvas shows the style + config
    // profiles whose tabs are selected (so you edit-and-see); when focus leaves the panel it reverts
    // to the condition-driven profiles. focusin/out bubble, so one pair of listeners covers every input.
    win.el.addEventListener("focusin", () => { if (current) { ctx.previewStyleProfile(current.id, editProfileId); ctx.previewConfigProfile(current.id, editConfigId); } });
    win.el.addEventListener("focusout", (e) => { if (!win.el.contains(e.relatedTarget)) { ctx.previewStyleProfile(null); ctx.previewConfigProfile(null); } });

    // ---- small control builders --------------------------------------------------------
    const save = () => { ctx.pretty.save(); ctx.refresh(); render(); };
    function row(label, control) { const r = el("div", "pw-insp-row"); r.appendChild(el("span", "pw-insp-lab", label)); r.appendChild(control); return r; }
    // An icon-only reset button (the circular-arrow glyph), justified right in a section header.
    function resetBtn(label, onReset) {
        const b = el("button", "pw-insp-h-reset"); b.title = `reset ${label}`;
        b.appendChild(svg("svg", { viewBox: "0 0 16 16", width: "12", height: "12", "aria-hidden": "true" },
            svg("path", {
                d: "M13 8a5 5 0 1 1-1.6-3.7M13 2.2V5h-2.8",
                fill: "none", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round", "stroke-linejoin": "round",
            })));
        b.addEventListener("click", (e) => { e.stopPropagation(); onReset(); });
        return b;
    }
    // A plain (non-collapsing) sub-header with an optional reset — used INSIDE a section for sub-parts
    // (columns / series / fields).
    function hdr(label, onReset) {
        const h = el("div", "pw-insp-h");
        h.appendChild(el("span", "pw-insp-h-lab", label));
        if (onReset) h.appendChild(resetBtn(label, onReset));
        return h;
    }
    // A top-level COLLAPSIBLE section: a header (caret + label + optional reset) over a body. The
    // collapse state is keyed by `key` and remembered across inspector re-renders; clicking the header
    // toggles it. Returns {grp, body} — callers append their controls into `body`.
    function section(key, label, onReset) {
        const grp = el("div", "pw-insp-grp");
        const h = el("div", "pw-insp-h pw-insp-h-click");
        const car = el("span", "pw-insp-caret");
        h.append(car, el("span", "pw-insp-h-lab", label));
        if (onReset) h.appendChild(resetBtn(label, onReset));
        const body = el("div", "pw-insp-sec-body");
        const apply = () => { const c = !!collapsed[key]; grp.classList.toggle("pw-collapsed", c); body.hidden = c; car.textContent = c ? "▸" : "▾"; };
        h.addEventListener("click", () => { collapsed[key] = !collapsed[key]; apply(); });
        apply();
        grp.append(h, body);
        return { grp, body };
    }

    // Editable position + size, each with a unit (px/%/vw/vh/dvw/dvh). Values live-update while the
    // widget is dragged/resized (syncGeom) and apply on enter/blur. Returns the bare grid (no header) —
    // it's nested into the merged "layout" section alongside the anchor controls.
    const GEOM_FIELDS = ["x", "y", "w", "h"];
    let geomRefs = null;
    function geomGrid(w) {
        const g = el("div", "pw-geom");
        const gm = ctx.geomOf(w.id) || { x: w.x ?? 0, y: w.y ?? 0, w: w.w ?? 200, h: w.h ?? 80, units: {} };
        geomRefs = {};
        for (const k of GEOM_FIELDS) {
            const cell = el("div", "pw-geom-cell");
            cell.appendChild(el("span", "pw-geom-lab", k));
            // "calc" makes the value a raw CSS calc body, so the input is free text instead of a number.
            const isCalc = ((gm.units && gm.units[k]) || "px") === "calc";
            const inp = el("input", "pw-geom-val"); inp.type = isCalc ? "text" : "number"; inp.value = gm[k];
            if (isCalc) inp.placeholder = "100% - 20px";
            inp.addEventListener("change", () => ctx.applyGeom(w.id, { [k]: isCalc ? inp.value : Number(inp.value) }));
            const us = el("select", "pw-geom-unit");
            for (const u of POS_UNITS) { const o = el("option", null, u); o.value = u; us.appendChild(o); }
            us.value = (gm.units && gm.units[k]) || "px";
            // re-render (not just sync) on unit change so the input switches between number and calc text.
            us.addEventListener("change", () => { ctx.setUnit(w.id, k, us.value); render(); });
            // a matched dimension is driven by another widget — its own value/unit no longer apply.
            if ((k === "w" && w.matchW) || (k === "h" && w.matchH)) { inp.disabled = true; us.disabled = true; cell.title = "size matched to another widget"; }
            cell.append(inp, us);
            geomRefs[k] = { inp, us };
            g.appendChild(cell);
        }
        // z (stacking order) — a plain integer, no unit; sits below w/h in the same 2-col grid.
        const zc = el("div", "pw-geom-cell");
        zc.appendChild(el("span", "pw-geom-lab", "z"));
        const zin = el("input", "pw-geom-val"); zin.type = "number"; zin.step = "1"; zin.min = "1"; zin.max = "100"; zin.value = w.z ?? 1;
        zin.title = "stacking order 1-100 (higher is on top; floating panels always sit above)";
        zin.addEventListener("change", () => { const v = Math.max(1, Math.min(100, Math.round(Number(zin.value) || 1))); zin.value = v; ctx.applyGeom(w.id, { z: v }); });
        zc.appendChild(zin);
        g.appendChild(zc);
        return g;
    }
    function syncGeom(id) {
        if (!geomRefs || !current || current.id !== id) return;
        const gm = ctx.geomOf(id); if (!gm) return;
        for (const k of GEOM_FIELDS) {
            const ref = geomRefs[k]; if (!ref) continue;
            if (document.activeElement !== ref.inp) { const v = String(gm[k]); if (ref.inp.value !== v) ref.inp.value = v; }
            const u = (gm.units && gm.units[k]) || "px";
            if (ref.us.value !== u) ref.us.value = u;
        }
    }
    function sel(value, options, onChange) {
        const s = el("select");
        for (const o of options) { const op = el("option", null, o.label ?? o); op.value = o.value ?? o; s.appendChild(op); }
        s.value = value ?? ""; s.addEventListener("change", () => onChange(s.value)); return s;
    }
    function txt(value, onChange, area) {
        const t = el(area ? "textarea" : "input"); if (!area) t.type = "text"; t.value = value ?? "";
        t.addEventListener("change", () => onChange(t.value)); return t;
    }
    function numEl(value, onChange) { const n = el("input"); n.type = "number"; n.value = value ?? ""; n.addEventListener("change", () => onChange(n.value === "" ? "" : Number(n.value))); return n; }
    function chk(value, onChange) { const c = el("input"); c.type = "checkbox"; c.checked = !!value; c.addEventListener("change", () => onChange(c.checked)); return c; }

    // Columns available for a binding = the schema (window fields / view columns) UNIONED with
    // whatever keys appear in the live rows — so price/derived columns the schema doesn't list
    // still show up.
    function colsFor(b) {
        if (!b || !b.id) return [];
        const schema = b.src === "subset" ? ctx.model.subsetColumns(b.id) : ctx.model.datasetFields(b.id);
        const rows = ctx.data.read(b.src === "subset" ? `subset:${b.id}` : `dataset:${b.id}`) || [];
        const out = [...schema];
        for (const r of rows) for (const k of Object.keys(r)) if (!k.startsWith("_") && !out.includes(k)) out.push(k);
        if (rows.some((r) => "_seq" in r) && !out.includes("_seq")) out.push("_seq");   // rolling arrival id (sortable)
        return out;
    }
    const dsOptions = () => ctx.model.datasets().map((d) => ({ value: d, label: d }));
    const subOptions = () => (ctx.model.profile.subsets || []).map((s) => ({ value: s.id, label: s.id }));

    // Changing the bound source invalidates any column/series config keyed by the OLD source's
    // column names — clear it (across EVERY config profile, not just the active one, since the binding
    // is shared) so stale entries don't render as fake columns.
    function resetBindingConfigAll(w) {
        const clear = (cfg) => {
            if (w.type === "table") { cfg.columns = []; cfg.sortField = ""; }
            if (w.type === "chart") { cfg.x = ""; cfg.y = []; cfg.colorBy = {}; }
        };
        clear(w.config = w.config || {});
        for (const p of (w.configProfiles || [])) clear(p.config = p.config || {});
    }

    // The type-specific config fields for ONE config object (the active profile's config), appended
    // into `host`. `save` persists + rebuilds (caller decides whether that's a full refresh or a
    // light reconfig). The widget `w` supplies non-config context (binding, path, type).
    function buildConfigFields(host, w, c, save) {
        const g = host;
        // data binding lives at the TOP of config for data widgets (the old separate "data" section is
        // merged in here). The binding is widget-level (shared across config profiles), but changing it
        // resets the column/series config of every profile.
        if (["table", "chart"].includes(w.type)) {
            w.binding = w.binding || { src: "dataset", id: "" };
            g.appendChild(row("source", sel(w.binding.src, [{ value: "dataset", label: "dataset" }, { value: "subset", label: "subset" }], (v) => { w.binding.src = v; w.binding.id = ""; resetBindingConfigAll(w); save(); })));
            const opts = w.binding.src === "subset" ? subOptions() : dsOptions();
            g.appendChild(row("id", sel(w.binding.id, [{ value: "", label: "—" }, ...opts], (v) => { w.binding.id = v; resetBindingConfigAll(w); save(); })));
        }
        if (w.type === "label") g.appendChild(row("text", txt(c.text, (v) => { c.text = v; save(); }, true)));
        if (w.type === "container") g.appendChild(row("title", txt(c.title, (v) => { c.title = v; save(); })));
        if (w.type === "panel") g.appendChild(row("panel", sel(c.panel || "live", PANEL_OPTIONS, (v) => { c.panel = v; save(); })));
        if (w.type === "table") {
            const avail = colsFor(w.binding);
            // page size + paging share a row; sort by (grows) + direction (fits its content) share a row.
            const pr = el("div", "pw-insp-row");
            pr.append(el("span", "pw-insp-lab", "page size"), numEl(c.pageSize ?? 50, (v) => { c.pageSize = v || 50; save(); }),
                el("span", "pw-pair-lab", "paging"), chk(c.paging, (v) => { c.paging = v; save(); }));
            g.appendChild(pr);
            const sr = el("div", "pw-insp-row");
            const dir = sel(c.sortDesc ? "desc" : "asc", ["asc", "desc"], (v) => { c.sortDesc = v === "desc"; save(); }); dir.classList.add("pw-fit");
            sr.append(el("span", "pw-insp-lab", "sort by"),
                sel(c.sortField || "", [{ value: "", label: "—" }, ...avail.map((k) => ({ value: k, label: humanize(k) }))], (v) => { c.sortField = v; save(); }), dir);
            g.appendChild(sr);
            g.appendChild(hdr("columns", () => { c.columns = []; save(); }));
            if (!avail.length) g.appendChild(el("div", "pw-insp-hint", "bind data to list columns"));
            c.columns = Array.isArray(c.columns) ? c.columns : [];
            const entryOf = (key) => c.columns.find((e) => e.key === key);
            const upsert = (key, patch) => { setColumnProp(c.columns, key, patch); save(); };
            // Row order mirrors the table: config order first (drag-reordered), then any remaining
            // available column. Rows live in their own container so the reorder primitive only sees them.
            const cfgOrder = c.columns.map((e) => e.key).filter((k) => avail.includes(k));
            const ordered = [...cfgOrder, ...avail.filter((k) => !cfgOrder.includes(k))];
            const colList = el("div", "pw-col-list");
            for (const key of ordered) {
                const e = entryOf(key);
                const cr = el("div", "pw-insp-frow");
                const grip = el("span", "pw-ro-h", "⠿"); grip.title = "drag to reorder column";
                const tog = chk(e ? e.enabled !== false : true, (v) => upsert(key, { enabled: v })); tog.title = "show column";
                const lab = txt(e && e.label || "", (v) => upsert(key, { label: v.trim() })); lab.placeholder = humanize(key);
                const wid = numEl(e && e.width || "", (v) => upsert(key, { width: (v === "" || v <= 0) ? undefined : Math.min(100, v) })); wid.placeholder = "%"; wid.title = "width % (blank = auto)"; wid.min = 1; wid.max = 100; wid.className = "pw-col-w";
                cr.append(grip, tog, lab, wid);
                colList.appendChild(cr);
            }
            makeReorderable(colList, {
                itemSel: ".pw-insp-frow", handleSel: ".pw-ro-h", axis: "y",
                onReorder: (from, to) => { arrayMove(ordered, from, to); c.columns = orderColumns(c.columns, ordered); save(); },
            });
            g.appendChild(colList);
        }
        if (w.type === "chart") {
            const avail = colsFor(w.binding);
            g.appendChild(row("type", sel(c.chart_type || "bar", ["bar", "line", "area", "scatter", "pie", "donut"], (v) => { c.chart_type = v; save(); })));
            g.appendChild(row("x", sel(c.x || "", [{ value: "", label: "—" }, ...avail.map((k) => ({ value: k, label: humanize(k) }))], (v) => { c.x = v; save(); })));
            g.appendChild(row("title", txt(c.title, (v) => { c.title = v; save(); })));
            g.appendChild(hdr("series", () => { c.y = []; c.colorBy = {}; save(); }));
            if (!avail.length) g.appendChild(el("div", "pw-insp-hint", "bind data to pick series"));
            c.y = Array.isArray(c.y) ? c.y : []; c.colorBy = c.colorBy || {};
            for (const k of avail) {
                const fr = el("div", "pw-insp-frow");
                const tog = chk(c.y.includes(k), (v) => { if (v) { if (!c.y.includes(k)) c.y.push(k); } else c.y = c.y.filter((x) => x !== k); save(); }); tog.title = "include as a series";
                const colr = el("input", "pw-se-cmini"); colr.type = "color"; colr.value = c.colorBy[k] || "#4ea1ff";
                colr.addEventListener("change", () => { c.colorBy[k] = colr.value; save(); });
                fr.append(tog, el("span", "pw-insp-flab", humanize(k)), colr);
                g.appendChild(fr);
            }
        }
        if (w.type === "control") {
            const inputs = nodeInputs(ctx.model).map((i) => ({ value: i.path, label: `${i.nodeLabel} · ${i.label}` }));
            const meta = inputMeta(ctx.model, w.path);   // the constraint actually applied — prefill its defaults
            const dfltLabel = (/\.([A-Za-z_]\w*)$/.exec(w.path || "") || ["", ""])[1].replace(/_/g, " ");
            g.appendChild(row("input", sel(w.path, [{ value: "", label: "—" }, ...inputs], (v) => { w.path = v; save(); })));
            g.appendChild(row("control", sel(c.presentation, [{ value: "", label: "auto" }, "slider", "number", "select", "toggle", "radio", "stepper"], (v) => { c.presentation = v; save(); })));
            g.appendChild(row("label", txt(c.label ?? dfltLabel, (v) => { c.label = v; save(); })));
            g.appendChild(row("min", numEl(c.min ?? meta.min, (v) => { c.min = v; save(); })));
            g.appendChild(row("max", numEl(c.max ?? meta.max, (v) => { c.max = v; save(); })));
            g.appendChild(row("step", numEl(c.step ?? meta.step, (v) => { c.step = v; save(); })));
            g.appendChild(row("options", txt((c.options || []).map((o) => (o.value ?? o)).join(","), (v) => { c.options = v.split(",").map((x) => x.trim()).filter(Boolean).map((x) => ({ label: x, value: x })); save(); })));
        }
        if (w.type === "form") {
            g.appendChild(row("dataset", sel(c.dataset, [{ value: "", label: "—" }, ...dsOptions()], (v) => { c.dataset = v; save(); })));
            g.appendChild(row("submit", txt(c.submit || "Add", (v) => { c.submit = v; save(); })));
            g.appendChild(hdr("fields", () => { c.fields = []; save(); }));
            (c.fields = c.fields || []).forEach((f, i) => {
                const fr = el("div", "pw-insp-frow");
                fr.appendChild(txt(f.column, (v) => { f.column = v; save(); }));
                fr.appendChild(sel(f.input || "text", ["text", "number", "select"], (v) => { f.input = v; save(); }));
                const req = chk(f.required, (v) => { f.required = v; save(); }); req.title = "required";
                fr.appendChild(req);
                const del = el("button", "pw-insp-del", "×"); del.addEventListener("click", () => { c.fields.splice(i, 1); save(); });
                fr.appendChild(del);
                g.appendChild(fr);
            });
            const addRow = el("div", "pw-insp-frow");
            const add = el("button", "pw-insp-add", "+ field"); add.addEventListener("click", () => { c.fields.push({ column: "field", input: "text", required: false }); save(); });
            const copy = el("button", "pw-insp-add", "copy columns"); copy.title = "add a field for each column of the bound dataset";
            copy.addEventListener("click", () => {
                for (const k of colsFor({ src: "dataset", id: c.dataset })) if (!c.fields.some((f) => f.column === k)) c.fields.push({ column: k, input: "text", required: false });
                save();
            });
            addRow.append(add, copy);
            g.appendChild(addRow);
        }
        if (w.type === "button") {
            g.appendChild(row("action", sel(c.action || "fire_trigger", ["fire_trigger", "run_sweep", "set_value", "switch_page", "live_on", "live_off", "live_toggle"], (v) => { c.action = v; save(); })));
            if (c.action === "fire_trigger") g.appendChild(row("trigger", sel(c.target, [{ value: "", label: "—" }, ...(ctx.model.profile.triggers || []).map((t) => ({ value: t.id, label: t.id }))], (v) => { c.target = v; save(); })));
            else if (c.action === "run_sweep") g.appendChild(row("dataset", sel(c.target, [{ value: "", label: "—" }, ...dsOptions()], (v) => { c.target = v; save(); })));
            else if (c.action === "set_value") {
                g.appendChild(row("input", sel(c.target, [{ value: "", label: "—" }, ...nodeInputs(ctx.model).map((i) => ({ value: i.path, label: `${i.nodeLabel} · ${i.label}` }))], (v) => { c.target = v; save(); })));
                g.appendChild(row("value", txt(c.value, (v) => { c.value = v; save(); })));
            } else if (c.action === "switch_page") g.appendChild(row("page", sel(c.page, [{ value: "", label: "—" }, ...ctx.pretty.pages().map((p) => ({ value: p.id, label: p.title }))], (v) => { c.page = v; save(); })));
            g.appendChild(row("label", txt(c.label, (v) => { c.label = v; save(); })));
            // NB: button placement (align h/v, fill) is a STYLE concern — see styleExtras() in the style group.
        }
    }

    // Widget-type-specific STYLE controls appended into the style group, stored in w.style (not config)
    // and applied live via restyle (which re-runs the widget's update()). Button: placement within its
    // frame — align horizontally / vertically, or fill it.
    function styleExtras(w, group) {
        if (w.type !== "button") return;
        const s = w.style = w.style || {};
        const set = (k, v) => { if (v === "" || v == null || v === false) delete s[k]; else s[k] = v; ctx.pretty.save(); ctx.restyle(w.id); };
        group.appendChild(row("align h", sel(s.alignH || "left", ["left", "center", "right"], (v) => set("alignH", v))));
        group.appendChild(row("align v", sel(s.alignV || "middle", ["top", "middle", "bottom"], (v) => set("alignV", v))));
        group.appendChild(row("fill", chk(s.fill, (v) => set("fill", v))));
    }

    // ---- pages (sharing): which pages this widget appears on ------------------------------
    // A widget lives on its HOME page (always shown) and can be SHARED onto others: "all pages" or a
    // per-page checklist. The SAME object renders on each, so edits propagate. Un-checking a page (or
    // deleting the widget while viewing a shared page) just detaches it there; its home copy survives.
    function pagesEditor(w) {
        const commit = () => { ctx.refresh(); render(); };   // reflect on canvas (if current page is a target) + refresh toggles
        const { grp, body } = section("pages", "pages", () => { ctx.pretty.setShareAll(w.id, false); commit(); });   // reset -> home only
        const homeId = ctx.pretty.homePageId(w.id);
        const all = !!w.onAllPages;
        // rehome: move which page OWNS this element. Picking another page moves it there (and may drop
        // it from the current view, which clears the inspector).
        const others = ctx.pretty.pages().filter((p) => p.id !== homeId);
        if (others.length) {
            const homeTitle = (ctx.pretty.page(homeId) || {}).title || homeId;
            body.appendChild(row("home page", sel(homeId, [{ value: homeId, label: `${homeTitle} (home)` }, ...others.map((p) => ({ value: p.id, label: p.title }))], (v) => { if (v !== homeId) ctx.rehomeWidget(w.id, v); })));
        }
        body.appendChild(row("all pages", chk(all, (v) => { ctx.pretty.setShareAll(w.id, v); commit(); })));
        for (const p of ctx.pretty.pages()) {
            if (p.id === homeId) { body.appendChild(row(p.title, el("span", "pw-insp-hint", "home"))); continue; }
            const on = all || (Array.isArray(w.pages) && w.pages.includes(p.id));
            const c = chk(on, (v) => { ctx.pretty.setShare(w.id, p.id, v); commit(); });
            if (all) c.disabled = true;   // "all pages" already covers every page
            body.appendChild(row(p.title, c));
        }
        return grp;
    }

    // ---- anchor (layout): where the widget is pinned -------------------------------------
    // A widget is positioned relative to an anchor — the canvas (default) or another widget —
    // at one of nine points. x/y become the offset from that point, so anchoring to another
    // widget makes this one follow it. ctx.setAnchor re-solves the offset so the widget stays
    // put when the anchor changes (canvas.js reanchor).
    const ANCHOR_POINTS = [
        { value: "tl", label: "top-left" }, { value: "tc", label: "top" }, { value: "tr", label: "top-right" },
        { value: "ml", label: "left" }, { value: "mc", label: "center" }, { value: "mr", label: "right" },
        { value: "bl", label: "bottom-left" }, { value: "bc", label: "bottom" }, { value: "br", label: "bottom-right" },
    ];
    // A compact 3x3 picker for one of the nine anchor points — clicking a cell selects it. Small
    // by design: it's a quick pick, not a big control.
    function cornerGrid(value, onPick) {
        const g = el("div", "pw-corner-grid");
        for (const p of ANCHOR_POINTS) {
            const b = el("button", "pw-corner-cell"); b.type = "button"; b.title = p.label;
            if (p.value === (value || "tl")) b.classList.add("on");
            b.addEventListener("click", () => onPick(p.value));
            g.appendChild(b);
        }
        return g;
    }
    const widgetName = (x) => { const c = x.config || {}; const lab = c.title || c.text || c.label || (x.binding && x.binding.id) || x.type; return `${lab} · ${x.id}`; };
    // Anchor controls appended into `g` (the merged "layout" section's body), below the geometry grid.
    function appendAnchorRows(w, g) {
        const a = w.anchor || { to: "", corner: "tl" };
        const others = ctx.currentWidgets().filter((x) => x.id !== w.id);
        const toOpts = [{ value: "", label: "canvas" }, ...others.map((x) => ({ value: x.id, label: widgetName(x) }))];
        // `corner` = the widget's OWN point; `target` = the point on the anchor target it pins to.
        // Both default to the other so existing single-point anchors keep working.
        const set = (patch) => { ctx.setAnchor(w.id, { to: a.to || "", corner: a.corner || "tl", target: a.target || a.corner || "tl", ...patch }); render(); };
        g.appendChild(row("anchor to", sel(a.to || "", toOpts, (v) => set({ to: v }))));
        // labels carry the same glyph the canvas draws at each endpoint: target = circle, this = square.
        const markedRow = (mark, text, control) => {
            const lab = el("span", "pw-insp-lab");
            lab.append(el("span", `pw-anchor-mark ${mark}`), document.createTextNode(text));
            const r = el("div", "pw-insp-row"); r.append(lab, control); return r;
        };
        // this/target are sub-options OF the anchor target — only meaningful when one is chosen, and
        // indented under the "anchor to" select to read as nested.
        if (a.to) {
            const sub = el("div", "pw-anchor-sub");
            sub.appendChild(markedRow("this", "this", cornerGrid(a.corner || "tl", (v) => set({ corner: v }))));
            sub.appendChild(markedRow("target", "target", cornerGrid(a.target || a.corner || "tl", (v) => set({ target: v }))));
            g.appendChild(sub);
        }
        // match this widget's width / height to another widget's resolved size ("—" = own size).
        const matchOpts = [{ value: "", label: "—" }, ...others.map((x) => ({ value: x.id, label: widgetName(x) }))];
        const setMatch = (key, v) => { ctx.setMatch(w.id, key, v); render(); };   // re-render so the size field's disabled state follows
        // a row with the match-source select plus a percent of that (matched/own) size: 100 = as is.
        const matchRow = (label, key, pctKey) => {
            const r = el("div", "pw-insp-row pw-match-row");
            r.appendChild(el("span", "pw-insp-lab", label));
            r.appendChild(sel(w[key] || "", matchOpts, (v) => setMatch(key, v)));
            const p = el("input", "pw-match-pct"); p.type = "number"; p.min = "0"; p.step = "1"; p.title = "percent of the size";
            p.value = String(w[pctKey] ?? 100);
            p.addEventListener("change", () => { ctx.setMatchPct(w.id, pctKey, Number(p.value)); });
            r.append(p, el("span", "pw-match-pct-unit", "%"));
            return r;
        };
        g.appendChild(matchRow("match w", "matchW", "matchWPct"));
        g.appendChild(matchRow("match h", "matchH", "matchHPct"));
    }
    // Merged LAYOUT section: position/size grid + the anchor controls, under one collapsible header.
    function layoutEditor(w) {
        const { grp, body } = section("layout", "layout", () => { ctx.setAnchor(w.id, { to: "", corner: "tl", target: "tl" }); render(); });
        body.appendChild(geomGrid(w));
        appendAnchorRows(w, body);
        return grp;
    }

    const OPS = ["==", "!=", ">", "<", ">=", "<=", "nonempty", "empty"];
    // One merged effect select. The rule keeps its {effect, state} shape (canvas + compileConditions
    // read it); the select flattens "match", "style" and "config" cases into one list. "match X" ->
    // effect:"match", state:X (a resolved-state key the canvas mirrors); "style:<id>" -> effect:"style",
    // state:<profile id>; "config:<id>" -> effect:"config", state:<config profile id> (the profile the
    // canvas activates while the rule is true). The per-widget style/config options are built in
    // conditionsEditor (they depend on the widget's profiles); the base options are constant.
    const BASE_EFFECT_OPTS = [
        { value: "show", label: "show" }, { value: "enable", label: "enable" },
        { value: "match show", label: "match show" }, { value: "match enabled", label: "match enabled" }, { value: "match both", label: "match both" },
    ];
    const effectValue = (r) => (r.effect === "match" ? `match ${r.state || "both"}`
        : r.effect === "style" ? `style:${r.state || ""}`
            : r.effect === "config" ? `config:${r.state || ""}`
                : (r.effect || "show"));
    const setEffect = (r, v) => {
        if (v.startsWith("match ")) { r.effect = "match"; r.state = v.slice(6); }
        else if (v.startsWith("style:")) { r.effect = "style"; r.state = v.slice(6); }
        else if (v.startsWith("config:")) { r.effect = "config"; r.state = v.slice(7); }
        else { r.effect = v; }
    };
    // Compile the structured rule list -> the visible_when / enabled_when expr strings the canvas
    // evaluates. Rules of the same effect are AND-ed. "match", "style" and "config" rules are NOT
    // compiled to expressions — match mirrors another element's RESOLVED state, style/config pick a
    // profile; all are applied live in canvas. compileTerm (expr.js) is the shared rule->expression
    // builder the canvas reuses, so a rule's truth is derived in exactly one place.
    function compileConditions(w) {
        const show = [], en = [];
        for (const r of (w.conditions.rules || [])) {
            if (r.effect === "match" || r.effect === "style" || r.effect === "config") continue;   // applied live in canvas, not an expression
            const t = compileTerm(r); if (t) (r.effect === "enable" ? en : show).push(t);
        }
        w.conditions.visible_when = show.join(" && ");
        w.conditions.enabled_when = en.join(" && ");
    }

    // Known value domain for a source token, so the value picker is a dropdown of EXPECTED values
    // (e.g. activity:live is 0/1, a bool node-input is true/false) instead of a guess-the-value box.
    // null -> no known domain, fall back to a free-text input.
    function valueDomain(source) {
        if (!source) return null;
        if (source === "page") return ctx.pretty.pages().map((p) => ({ value: p.id, label: p.title }));   // pick a page by title, compare by id
        if (source.startsWith("activity:")) {
            const what = source.slice("activity:".length);
            return ["live", "precapture", "running"].includes(what) ? ["1", "0"] : null;   // sweeps/triggers are counts
        }
        if (source.startsWith("node:")) {
            const meta = inputMeta(ctx.model, source.slice(5));
            if (meta.kind === "bool") return ["true", "false"];
            if (meta.kind === "enum") return meta.options.map(String);
        }
        return null;
    }

    function conditionsEditor(w) {
        w.conditions = w.conditions || {}; w.conditions.rules = w.conditions.rules || [];
        const { grp, body } = section("conditions", `conditions (${w.conditions.rules.length})`, () => { w.conditions = { rules: [], visible_when: "", enabled_when: "" }; save(); });
        const g = body;
        const srcOpts = [{ value: "", label: "—" }, ...sourceTokenList(ctx.model, ctx.currentWidgets())];
        const elemOpts = [{ value: "", label: "—" }, ...ctx.currentWidgets().filter((x) => x.id !== w.id).map((x) => ({ value: x.id, label: widgetName(x) }))];
        // effect options = the base set + one "style · <name>" per extra style profile + one
        // "config · <name>" per extra config profile this widget defines, so a condition can switch the
        // element to that profile while true.
        const effectOpts = [...BASE_EFFECT_OPTS,
            ...widgetProfiles(w).filter((p) => p.id !== "default").map((p) => ({ value: `style:${p.id}`, label: `style · ${p.name}` })),
            ...widgetConfigProfiles(w).filter((p) => p.id !== "default").map((p) => ({ value: `config:${p.id}`, label: `config · ${p.name}` }))];
        // Re-apply conditions in place (re-wire subscriptions + re-evaluate), NOT a full canvas
        // rebuild: ctx.refresh() destroys + recreates every widget, which tears down any EMBEDDED
        // panel (e.g. the live panel) -> unembed -> onHide -> stops the live collector. Conditions
        // need none of that; like style/anchor/geom edits, they patch the live widgets directly.
        const recompile = () => { compileConditions(w); ctx.pretty.save(); ctx.recondition(); render(); };

        // Live read-out of what a rule currently resolves to, parked between the value box and the
        // delete button — so the value you compare against (or the element you mirror) is never a
        // guess. Updates in place on the source's heartbeat; no inspector re-render.
        function currentVal(rule) {
            const span = el("span", "pw-cond-cur"); span.title = "current value";
            const paint = () => {
                let v;
                if (rule.effect === "match") {
                    const st = rule.source ? ctx.condState(rule.source) : null;
                    v = !st ? "" : ((rule.state === "enabled" ? st.enabled : rule.state === "show" ? st.visible : (st.visible && st.enabled)) ? "1" : "0");
                } else {
                    v = rule.source ? resolveToken(ctx, rule.source) : "";
                }
                span.textContent = (v === "" || v == null) ? "—" : `= ${v}`;
            };
            paint();
            const key = rule.effect === "match" ? "activity" : subKeyForToken(rule.source);
            if (key) condSubs.push(ctx.data.subscribe(key, paint));
            return span;
        }

        // A live ✓/✗ at the head of each rule row showing whether the condition is TRUE right now —
        // for show/enable/style/config rules from the rule's own term, for match rules from the
        // mirrored element's resolved state. Re-paints on the source's heartbeat (no inspector re-render).
        function truthBadge(rule) {
            const b = el("span", "pw-cond-truth");
            const paint = () => {
                let on;
                if (rule.effect === "match") {
                    const st = rule.source ? ctx.condState(rule.source) : null;
                    on = !!st && (rule.state === "enabled" ? st.enabled : rule.state === "show" ? st.visible : (st.visible && st.enabled));
                } else {
                    const expr = compileTerm(rule);
                    on = expr ? truthy(evaluate(expr, (inner) => resolveToken(ctx, inner), false)) : false;
                }
                b.classList.toggle("on", !!on);
                b.textContent = on ? "✓" : "✗";
                b.title = on ? "condition true" : "condition false";
            };
            paint();
            const key = rule.effect === "match" ? "activity" : subKeyForToken(rule.source);
            if (key) condSubs.push(ctx.data.subscribe(key, paint));
            return b;
        }

        // sel + a class, so every select in the row is individually styleable/addressable:
        //   .pw-cond-effect  effect (show/enable/match show/match enabled/match both) — fixed width
        //   .pw-cond-op      comparison op                 — fixed width, never grows
        //   .pw-cond-grow    the source/element picker      — the ONE select that fills the row
        const csel = (cls, value, options, onChange) => { const s = sel(value, options, onChange); s.classList.add(cls); return s; };
        w.conditions.rules.forEach((rule, i) => {
            const fr = el("div", "pw-insp-frow pw-cond-row");
            fr.appendChild(truthBadge(rule));
            fr.appendChild(csel("pw-cond-effect", effectValue(rule), effectOpts, (v) => { setEffect(rule, v); recompile(); }));
            if (rule.effect === "match") {
                fr.appendChild(csel("pw-cond-grow", rule.source || "", elemOpts, (v) => { rule.source = v; recompile(); }));
            } else {
                fr.appendChild(csel("pw-cond-grow", rule.source || "", srcOpts, (v) => { rule.source = v; recompile(); }));
                fr.appendChild(csel("pw-cond-op", rule.op || "nonempty", OPS, (v) => { rule.op = v; recompile(); }));
                if (!["nonempty", "empty"].includes(rule.op || "nonempty")) {
                    const dom = valueDomain(rule.source);
                    fr.appendChild(dom
                        ? sel(rule.value ?? "", [{ value: "", label: "—" }, ...dom.map((d) => (typeof d === "object" ? d : { value: String(d), label: String(d) }))], (v) => { rule.value = v; recompile(); })
                        : txt(rule.value || "", (v) => { rule.value = v; recompile(); }));
                }
            }
            fr.appendChild(currentVal(rule));
            const del = el("button", "pw-insp-del", "×"); del.addEventListener("click", () => { w.conditions.rules.splice(i, 1); recompile(); });
            fr.appendChild(del);
            g.appendChild(fr);
        });
        const add = el("button", "pw-insp-add", "+ condition"); add.addEventListener("click", () => { w.conditions.rules.push({ effect: "show", source: "", op: "nonempty", value: "" }); recompile(); });
        g.appendChild(add);
        return grp;
    }

    // ---- profile group (profiles-as-tabs + the editor for the active profile) -------------------
    // The SHARED tabbed-profile UI used by BOTH style and config (rule 7). A widget has a default
    // profile plus any number of extra named profiles; the tabs pick which one the editor edits; a
    // condition rule activates a profile at runtime. Clicking a tab previews that profile on the canvas
    // while the inspector is focused. `d` (a descriptor) supplies the kind-specific bits:
    //   key/label, valKey ("style"/"config"), listKey, effect, addName,
    //   profilesOf / getEditId / setEditId / preview / condActive / live / buildBody
    function profileGroup(w, d) {
        let resetActive = () => {};
        const { grp, body } = section(d.key, d.label, () => resetActive());
        if (!d.profilesOf(w).some((p) => p.id === d.getEditId())) d.setEditId("default");   // selection survives widget switches

        const tabs = el("div", "pw-style-tabs"); body.appendChild(tabs);
        const ctlHost = el("div"); body.appendChild(ctlHost);   // rename/delete for the active extra profile
        const seHost = el("div"); body.appendChild(seHost);     // the active profile's editor

        // live marker: ring the tab of the profile the CONDITIONS currently activate (distinct from
        // .on, the profile being EDITED). Repaints on the active-effect rules' source heartbeats.
        let subs = []; condSubs.push(() => { subs.forEach((u) => u()); subs = []; });
        const tabBtns = new Map();
        const markActive = () => { const act = d.condActive(w.id); tabBtns.forEach((b, id) => b.classList.toggle("pw-style-active", id === act && act !== "default")); };

        // (Re)build the dynamic parts for the active profile WITHOUT a full inspector render — so
        // clicking a tab keeps focus inside the panel (which is what holds the live canvas preview).
        const build = () => {
            const profiles = d.profilesOf(w);
            const active = profiles.find((p) => p.id === d.getEditId()) || profiles[0];

            // tab strip: one tab per profile + a "+" that adds a profile copied from the active one
            tabs.textContent = ""; tabBtns.clear();
            for (const p of profiles) {
                const t = el("button", "pw-style-tab", p.name);
                t.classList.toggle("on", p.id === d.getEditId());
                t.title = p.id === "default" ? "default profile" : `${d.label} profile`;
                t.addEventListener("click", () => { d.setEditId(p.id); d.preview(w.id, p.id); build(); });
                tabBtns.set(p.id, t);
                tabs.appendChild(t);
            }
            const addT = el("button", "pw-style-tab pw-style-addtab", "+"); addT.title = "new profile (copies the active one)";
            addT.addEventListener("click", () => {
                const list = (w[d.listKey] = w[d.listKey] || []);
                const taken = new Set(["default", ...list.map((p) => p.id)]);
                let n = 1, id = `sp${n}`; while (taken.has(id)) id = `sp${++n}`;
                list.push({ id, name: `${d.addName} ${list.length + 1}`, [d.valKey]: JSON.parse(JSON.stringify(active[d.valKey] || {})) });
                d.setEditId(id);
                // full render so the conditions editor's effect options pick up the new profile
                ctx.pretty.save(); d.preview(w.id, id); render();
            });
            tabs.appendChild(addT);

            // rename + delete for the active EXTRA profile (the default can't be renamed/removed)
            ctlHost.textContent = "";
            if (active.id !== "default") {
                const ctl = el("div", "pw-style-pctl");
                const nameIn = el("input", "pw-style-pname"); nameIn.type = "text"; nameIn.value = active.name; nameIn.title = "profile name";
                const commitName = () => { const p = (w[d.listKey] || []).find((x) => x.id === active.id); if (p && nameIn.value.trim() && p.name !== nameIn.value.trim()) { p.name = nameIn.value.trim(); ctx.pretty.save(); render(); } };   // render: the "· <name>" condition option relabels
                nameIn.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); nameIn.blur(); } else if (e.key === "Escape") { e.preventDefault(); nameIn.value = active.name; nameIn.blur(); } });
                nameIn.addEventListener("blur", commitName);
                const del = el("button", "pw-insp-del", "×"); del.title = "delete this profile (click again to confirm)";
                del.addEventListener("click", () => {
                    if (del.dataset.armed !== "1") { del.dataset.armed = "1"; del.textContent = "✓"; setTimeout(() => { del.dataset.armed = "0"; del.textContent = "×"; }, 2000); return; }
                    w[d.listKey] = (w[d.listKey] || []).filter((x) => x.id !== active.id);
                    // drop any condition rule that activated this now-gone profile
                    if (w.conditions && Array.isArray(w.conditions.rules)) w.conditions.rules = w.conditions.rules.filter((r) => !(r.effect === d.effect && r.state === active.id));
                    d.setEditId("default"); compileConditions(w);
                    ctx.pretty.save(); d.preview(w.id, "default"); ctx.recondition(); render();   // full render: the conditions editor's effect options changed
                });
                ctl.append(nameIn, del);
                ctlHost.appendChild(ctl);
            }

            // the editor for the active profile, bound to its value object (mutated in place)
            seHost.textContent = "";
            d.buildBody(seHost, active, w, build);

            // (re)wire the live condition-active marker: subscribe to every active-effect rule's source
            // so the ring moves to whichever profile the conditions activate, without an inspector render.
            subs.forEach((u) => u()); subs = [];
            const keys = new Set();
            for (const r of (w.conditions?.rules || [])) if (r.effect === d.effect) { const k = subKeyForToken(r.source); if (k) keys.add(k); }
            for (const k of keys) subs.push(ctx.data.subscribe(k, markActive));
            markActive();
        };
        // header reset acts ONLY on the active profile (default -> base {}, extra -> its value {})
        resetActive = () => {
            const active = d.profilesOf(w).find((p) => p.id === d.getEditId()) || d.profilesOf(w)[0];
            if (active.id === "default") w[d.valKey] = {}; else { const p = (w[d.listKey] || []).find((x) => x.id === active.id); if (p) p[d.valKey] = {}; }
            ctx.pretty.save(); d.live(w.id); build();
        };
        build();
        return grp;
    }

    // The two profile-group descriptors. STYLE applies live via restyle (CSS only); CONFIG rebuilds the
    // widget instance via reconfig (config drives structure).
    const STYLE_DESC = {
        key: "style", label: "style", valKey: "style", listKey: "styleProfiles", effect: "style", addName: "Style",
        profilesOf: widgetProfiles,
        getEditId: () => editProfileId, setEditId: (v) => { editProfileId = v; },
        preview: (id, pid) => ctx.previewStyleProfile(id, pid),
        condActive: (id) => ctx.condProfile(id),
        live: (id) => ctx.restyle(id),
        buildBody: (host, active, w) => {
            styleEditor(host, active.style, () => { ctx.pretty.save(); ctx.restyle(w.id); }, { effective: ctx.effectiveStyle(w.id) });
            styleExtras(w, host);   // widget-type-specific style controls (e.g. button placement)
        },
    };
    const CONFIG_DESC = {
        key: "config", label: "config", valKey: "config", listKey: "configProfiles", effect: "config", addName: "Config",
        profilesOf: widgetConfigProfiles,
        getEditId: () => editConfigId, setEditId: (v) => { editConfigId = v; },
        preview: (id, pid) => ctx.previewConfigProfile(id, pid),
        condActive: (id) => ctx.condConfig(id),
        live: (id) => ctx.reconfig(id),
        buildBody: (host, active, w, build) => {
            buildConfigFields(host, w, active.config, () => { ctx.pretty.save(); ctx.reconfig(w.id); build(); });
        },
    };

    function render() {
        const body = win.body;
        body.textContent = "";
        condSubs.forEach((u) => { try { u(); } catch { /* */ } }); condSubs = [];
        geomRefs = null;
        if (!current) { body.appendChild(el("div", "pw-insp-empty", "select a widget")); return; }
        const w = current;
        const head = el("div", "pw-insp-head");
        head.appendChild(el("span", "pw-insp-type", `${w.type} ·`));
        // editable id: rename commits on Enter/blur; the model repoints every reference. A rejected
        // id (empty / duplicate / token-unsafe) snaps back and flashes.
        const idIn = el("input", "pw-insp-id"); idIn.value = w.id;
        idIn.title = "rename this element (updates all references to it)";
        const commitId = () => {
            const v = idIn.value.trim();
            if (v === w.id) { idIn.value = w.id; return; }
            if (!ctx.renameWidget(w.id, v)) { idIn.value = w.id; idIn.classList.add("bad"); setTimeout(() => idIn.classList.remove("bad"), 1000); }
        };
        idIn.addEventListener("keydown", (e) => {
            if (e.key === "Enter") { e.preventDefault(); idIn.blur(); }
            else if (e.key === "Escape") { e.preventDefault(); idIn.value = w.id; idIn.blur(); }
        });
        idIn.addEventListener("blur", commitId);
        head.appendChild(idIn);
        const clone = el("button", "pw-insp-clone", "clone");
        clone.title = "duplicate this element (new id)";
        clone.addEventListener("click", () => ctx.cloneWidget(w.id));
        head.appendChild(clone);
        const del = el("button", "pw-insp-remove", "delete");
        del.addEventListener("click", () => {
            if (del.dataset.armed !== "1") { del.dataset.armed = "1"; del.textContent = "confirm"; setTimeout(() => { del.dataset.armed = "0"; del.textContent = "delete"; }, 2500); return; }
            ctx.removeWidget(w.id);
        });
        head.appendChild(del);
        body.appendChild(head);

        body.appendChild(layoutEditor(w));   // merged position/size + anchor
        if (ctx.pretty.pages().length > 1) body.appendChild(pagesEditor(w));   // sharing only matters with >1 page
        body.appendChild(conditionsEditor(w));
        body.appendChild(profileGroup(w, CONFIG_DESC));   // config profiles (below conditions)
        body.appendChild(profileGroup(w, STYLE_DESC));    // style profiles
        // height is content-driven via CSS (.fw-body flex-basis:auto) — no JS measurement.
    }

    return { win, show, clear, refresh: render, syncGeom };
}
