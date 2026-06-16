// Inspector (edit mode): edit the selected widget — its binding, type-specific config,
// show/enable conditions, and style (via the ONE style editor). Edits commit on change, then
// re-render the page and the inspector so dependent choices (e.g. a binding's columns) refresh.

import { createFloatWin } from "../../graph/floatwin.js";
import { styleEditor } from "../style_editor.js";
import { nodeInputs, inputMeta } from "../constraints.js";
import { sourceTokenList } from "../binding.js";
import { el, humanize } from "../widgets/util.js";

export const inspectorState = { visible: false, x: null, y: null, w: 320, h: null, collapsed: false };

export function buildInspector(ctx) {
  const win = createFloatWin({ id: "pretty-inspector", title: "inspector", state: inspectorState, bothAxes: true });
  let current = null;

  function show(widget) { current = widget; win.setVisible(true); render(); }   // visible BEFORE render so height measures right
  function clear() { current = null; render(); }

  // ---- small control builders --------------------------------------------------------
  const save = () => { ctx.pretty.save(); ctx.refresh(); render(); };
  function row(label, control) { const r = el("div", "pw-insp-row"); r.appendChild(el("span", "pw-insp-lab", label)); r.appendChild(control); return r; }
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
  // column names — clear it so stale entries don't render as fake columns.
  function resetBindingConfig(w) {
    if (w.type === "table") { w.config.columns = []; w.config.sortField = ""; }
    if (w.type === "chart") { w.config.x = ""; w.config.y = []; w.config.colorBy = {}; }
  }
  function bindingEditor(w) {
    const wrap = el("div", "pw-insp-grp");
    wrap.appendChild(el("div", "pw-insp-h", "data"));
    w.binding = w.binding || { src: "dataset", id: "" };
    wrap.appendChild(row("source", sel(w.binding.src, [{ value: "dataset", label: "dataset" }, { value: "subset", label: "subset" }], (v) => { w.binding.src = v; w.binding.id = ""; resetBindingConfig(w); save(); })));
    const opts = w.binding.src === "subset" ? subOptions() : dsOptions();
    wrap.appendChild(row("id", sel(w.binding.id, [{ value: "", label: "—" }, ...opts], (v) => { w.binding.id = v; resetBindingConfig(w); save(); })));
    return wrap;
  }

  function configEditor(w) {
    const g = el("div", "pw-insp-grp");
    g.appendChild(el("div", "pw-insp-h", "config"));
    const c = w.config = w.config || {};
    if (w.type === "label") g.appendChild(row("text", txt(c.text, (v) => { c.text = v; save(); }, true)));
    if (w.type === "container") g.appendChild(row("title", txt(c.title, (v) => { c.title = v; save(); })));
    if (w.type === "table") {
      const avail = colsFor(w.binding);
      g.appendChild(row("page size", numEl(c.pageSize ?? 50, (v) => { c.pageSize = v || 50; save(); })));
      g.appendChild(row("paging", chk(c.paging, (v) => { c.paging = v; save(); })));
      g.appendChild(row("sort by", sel(c.sortField || "", [{ value: "", label: "—" }, ...avail.map((k) => ({ value: k, label: humanize(k) }))], (v) => { c.sortField = v; save(); })));
      g.appendChild(row("direction", sel(c.sortDesc ? "desc" : "asc", ["asc", "desc"], (v) => { c.sortDesc = v === "desc"; save(); })));
      g.appendChild(el("div", "pw-insp-h", "columns"));
      if (!avail.length) g.appendChild(el("div", "pw-insp-hint", "bind data to list columns"));
      c.columns = Array.isArray(c.columns) ? c.columns : [];
      const entryOf = (key) => c.columns.find((e) => e.key === key);
      const upsert = (key, patch) => { let e = entryOf(key); if (!e) { e = { key, enabled: true }; c.columns.push(e); } Object.assign(e, patch); save(); };
      for (const key of avail) {
        const e = entryOf(key);
        const cr = el("div", "pw-insp-frow");
        const tog = chk(e ? e.enabled !== false : true, (v) => upsert(key, { enabled: v })); tog.title = "show column";
        const lab = txt(e && e.label || "", (v) => upsert(key, { label: v.trim() })); lab.placeholder = humanize(key);
        const wid = numEl(e && e.width || "", (v) => upsert(key, { width: (v === "" || v <= 0) ? undefined : Math.min(100, v) })); wid.placeholder = "%"; wid.title = "width % (blank = auto)"; wid.min = 1; wid.max = 100; wid.className = "pw-col-w";
        cr.append(tog, lab, wid);
        g.appendChild(cr);
      }
    }
    if (w.type === "chart") {
      const avail = colsFor(w.binding);
      g.appendChild(row("type", sel(c.chart_type || "bar", ["bar", "line", "area", "scatter", "pie", "donut"], (v) => { c.chart_type = v; save(); })));
      g.appendChild(row("x", sel(c.x || "", [{ value: "", label: "—" }, ...avail.map((k) => ({ value: k, label: humanize(k) }))], (v) => { c.x = v; save(); })));
      g.appendChild(row("title", txt(c.title, (v) => { c.title = v; save(); })));
      g.appendChild(el("div", "pw-insp-h", "series"));
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
      const dfltLabel = (/\.([A-Za-z_]\w*)$/.exec(w.path || "") || [, ""])[1].replace(/_/g, " ");
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
      g.appendChild(el("div", "pw-insp-h", "fields"));
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
      g.appendChild(row("action", sel(c.action || "fire_trigger", ["fire_trigger", "run_sweep", "set_value", "switch_page"], (v) => { c.action = v; save(); })));
      if (c.action === "fire_trigger") g.appendChild(row("trigger", sel(c.target, [{ value: "", label: "—" }, ...(ctx.model.profile.triggers || []).map((t) => ({ value: t.id, label: t.id }))], (v) => { c.target = v; save(); })));
      else if (c.action === "run_sweep") g.appendChild(row("dataset", sel(c.target, [{ value: "", label: "—" }, ...dsOptions()], (v) => { c.target = v; save(); })));
      else if (c.action === "set_value") {
        g.appendChild(row("input", sel(c.target, [{ value: "", label: "—" }, ...nodeInputs(ctx.model).map((i) => ({ value: i.path, label: `${i.nodeLabel} · ${i.label}` }))], (v) => { c.target = v; save(); })));
        g.appendChild(row("value", txt(c.value, (v) => { c.value = v; save(); })));
      } else if (c.action === "switch_page") g.appendChild(row("page", sel(c.page, [{ value: "", label: "—" }, ...ctx.pretty.pages().map((p) => ({ value: p.id, label: p.title }))], (v) => { c.page = v; save(); })));
      g.appendChild(row("label", txt(c.label, (v) => { c.label = v; save(); })));
    }
    return g;
  }

  const OPS = ["==", "!=", ">", "<", ">=", "<=", "nonempty", "empty"];
  // Compile the structured rule list -> the visible_when / enabled_when expr strings the
  // canvas evaluates. Rules of the same effect are AND-ed.
  function compileConditions(w) {
    const term = (r) => {
      if (!r.source) return "";
      if (r.op === "nonempty") return `{{${r.source}}} != ''`;
      if (r.op === "empty") return `{{${r.source}}} == ''`;
      const v = r.value ?? "";
      const val = (v !== "" && !isNaN(Number(v))) ? v : `'${String(v).replace(/'/g, "")}'`;
      return `{{${r.source}}} ${r.op} ${val}`;
    };
    const show = [], en = [];
    for (const r of (w.conditions.rules || [])) { const t = term(r); if (t) (r.effect === "enable" ? en : show).push(t); }
    w.conditions.visible_when = show.join(" && ");
    w.conditions.enabled_when = en.join(" && ");
  }

  function conditionsEditor(w) {
    const g = el("div", "pw-insp-grp");
    g.appendChild(el("div", "pw-insp-h", "conditions"));
    w.conditions = w.conditions || {}; w.conditions.rules = w.conditions.rules || [];
    const srcOpts = [{ value: "", label: "—" }, ...sourceTokenList(ctx.model, ctx.currentWidgets())];
    const recompile = () => { compileConditions(w); ctx.pretty.save(); ctx.refresh(); render(); };
    w.conditions.rules.forEach((rule, i) => {
      const fr = el("div", "pw-insp-frow pw-cond-row");
      fr.append(
        sel(rule.effect || "show", ["show", "enable"], (v) => { rule.effect = v; recompile(); }),
        sel(rule.source || "", srcOpts, (v) => { rule.source = v; recompile(); }),
        sel(rule.op || "nonempty", OPS, (v) => { rule.op = v; recompile(); }),
      );
      if (!["nonempty", "empty"].includes(rule.op || "nonempty")) fr.appendChild(txt(rule.value || "", (v) => { rule.value = v; recompile(); }));
      const del = el("button", "pw-insp-del", "×"); del.addEventListener("click", () => { w.conditions.rules.splice(i, 1); recompile(); });
      fr.appendChild(del);
      g.appendChild(fr);
    });
    const add = el("button", "pw-insp-add", "+ condition"); add.addEventListener("click", () => { w.conditions.rules.push({ effect: "show", source: "", op: "nonempty", value: "" }); recompile(); });
    g.appendChild(add);
    return g;
  }

  function render() {
    const body = win.body;
    body.textContent = "";
    if (!current) { body.appendChild(el("div", "pw-insp-empty", "select a widget")); return; }
    const w = current;
    const head = el("div", "pw-insp-head");
    head.appendChild(el("span", "pw-insp-type", `${w.type} · ${w.id}`));
    const del = el("button", "pw-insp-remove", "delete");
    del.addEventListener("click", () => {
      if (del.dataset.armed !== "1") { del.dataset.armed = "1"; del.textContent = "confirm"; setTimeout(() => { del.dataset.armed = "0"; del.textContent = "delete"; }, 2500); return; }
      ctx.removeWidget(w.id);
    });
    head.appendChild(del);
    body.appendChild(head);

    if (["table", "chart"].includes(w.type)) body.appendChild(bindingEditor(w));
    body.appendChild(configEditor(w));
    body.appendChild(conditionsEditor(w));

    const styleGrp = el("div", "pw-insp-grp");
    styleGrp.appendChild(el("div", "pw-insp-h", "style"));
    const seHost = el("div");
    styleGrp.appendChild(seHost);
    body.appendChild(styleGrp);
    styleEditor(seHost, w.style = w.style || {}, () => { ctx.pretty.save(); ctx.restyle(w.id); }, { effective: ctx.effectiveStyle(w.id) });
    // height is content-driven via CSS (.fw-body flex-basis:auto) — no JS measurement.
  }

  return { win, show, clear, refresh: render };
}
