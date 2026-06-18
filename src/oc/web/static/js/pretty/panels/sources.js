// Sources catalogue (edit mode): a live, searchable tree of EVERYTHING bindable — datasets
// (+fields), subsets (+columns), node inputs (+constraints), status keys, and other pretty
// widgets (the reactive scope). The single place bindings are discovered: click a token to
// copy it (paste into a label/condition), or "use" to bind it to the selected widget.
//
// "only with value" filters to sources that currently resolve to a non-empty value. To make
// dataset/subset values available for that test, the panel requires (polls) those keys while
// the filter is on and releases them when off / hidden.

import { createFloatWin } from "../../graph/floatwin.js";
import { nodeInputs } from "../constraints.js";
import { resolveToken } from "../binding.js";
import { el } from "../widgets/util.js";

export const sourcesState = { visible: false, x: null, y: null, w: 300, h: null, collapsed: false };

export function buildSources(ctx) {
  const win = createFloatWin({ id: "pretty-sources", title: "sources", state: sourcesState, bothAxes: true, autoFit: false,
    onShow: () => refresh(), onHide: () => wireValueData(false) });

  const head = el("div", "pw-src-head");
  const search = el("input", "pw-src-search"); search.type = "text"; search.placeholder = "filter sources…";
  const valLab = el("label", "pw-src-valonly");
  const valChk = el("input"); valChk.type = "checkbox";
  valLab.append(valChk, document.createTextNode("only with value"));
  head.append(search, valLab);
  const list = el("div", "pw-src-list");
  win.body.append(head, list);
  search.addEventListener("input", () => refresh());
  let valOnly = false;
  valChk.addEventListener("change", () => { valOnly = valChk.checked; wireValueData(valOnly); refresh(); });

  // require/poll dataset+subset+status keys while the value filter is on; release otherwise.
  const valKeys = []; const valSubs = [];
  function wireValueData(on) {
    for (const u of valSubs) u(); valSubs.length = 0;
    for (const k of valKeys) ctx.data.release(k); valKeys.length = 0;
    if (!on) return;
    const m = ctx.model;
    const keys = [...m.datasets().map((d) => `dataset:${d}`), ...(m.profile.subsets || []).map((s) => `subset:${s.id}`), "status"];
    for (const k of keys) { ctx.data.require(k); valKeys.push(k); valSubs.push(ctx.data.subscribe(k, refresh)); }
  }

  function hasValue(inner) {
    const v = resolveToken(ctx, inner);
    if (v == null || v === "") return false;
    if (typeof v === "number" && v === 0 && /^(dataset|subset):[^.|]+$/.test(inner.split("|")[0].trim())) return false;   // empty collection
    return true;
  }

  function token(text, onUse) {
    const row = el("div", "pw-src-row");
    const code = el("code", "pw-src-tok", text);
    const inner = text.replace(/^\{\{|\}\}$/g, "").trim();
    code.addEventListener("mouseenter", () => {
      const v = resolveToken(ctx, inner);
      code.textContent = v == null || v === "" ? "(no value)" : String(v);
      code.classList.add("pw-src-val");
    });
    code.addEventListener("mouseleave", () => { code.textContent = text; code.classList.remove("pw-src-val"); });
    const copy = el("button", "pw-src-btn", "copy"); copy.title = "copy token";
    copy.addEventListener("click", () => { try { navigator.clipboard.writeText(text); } catch { /* */ } });
    row.appendChild(code);
    if (onUse) { const use = el("button", "pw-src-btn pw-src-use", "use"); use.addEventListener("click", onUse); row.appendChild(use); }
    row.appendChild(copy);
    return row;
  }
  function section(title) { const s = el("div", "pw-src-sec"); s.appendChild(el("div", "pw-src-h", title)); return s; }

  function render() {
    const filter = search.value.trim().toLowerCase();
    const m = ctx.model;
    list.textContent = "";
    const match = (s) => !filter || s.toLowerCase().includes(filter);
    // build + append a token row, honouring the search match and the value filter
    const push = (sec, text, onUse, isChild) => {
      const inner = text.replace(/^\{\{|\}\}$/g, "").trim();
      if (valOnly && !hasValue(inner)) return null;
      const r = token(text, onUse);
      if (isChild) r.classList.add("pw-src-child");
      sec.appendChild(r);
      return r;
    };

    const ds = section("datasets");
    for (const d of m.datasets()) {
      if (match(`dataset ${d}`)) push(ds, `{{dataset:${d}}}`, () => ctx.bindDataToSelected("dataset", d));
      for (const f of m.datasetFields(d)) if (match(`${d} ${f}`)) push(ds, `{{dataset:${d}.${f}}}`, null, true);
    }
    if (ds.children.length > 1) list.appendChild(ds);

    const subs = section("subsets");
    for (const s of m.profile.subsets || []) {
      if (match(`subset ${s.id}`)) push(subs, `{{subset:${s.id}}}`, () => ctx.bindDataToSelected("subset", s.id));
      for (const c of m.subsetColumns(s.id)) if (match(`${s.id} ${c}`)) push(subs, `{{subset:${s.id}.${c}}}`, null, true);
    }
    if (subs.children.length > 1) list.appendChild(subs);

    const ni = section("node inputs");
    for (const inp of nodeInputs(m)) if (match(`${inp.nodeLabel} ${inp.label} ${inp.path}`)) {
      const r = push(ni, `{{node:${inp.path}}}`, () => ctx.bindPathToSelected(inp.path));
      if (r) r.prepend(el("span", "pw-src-meta", `${inp.nodeLabel} · ${inp.label}`));
    }
    if (ni.children.length > 1) list.appendChild(ni);

    const st = section("status");
    for (const k of ["status:datasets", "status:windows"]) if (match(k)) push(st, `{{${k}}}`);
    for (const d of m.datasets()) if (match(`status ${d}`)) push(st, `{{status:${d}.present}}`);
    if (st.children.length > 1) list.appendChild(st);

    const wg = section("pretty elements");
    for (const w of ctx.currentWidgets()) if (match(`${w.id} ${w.type}`)) {
      const r = push(wg, `{{widget:${w.id}}}`);
      if (r) r.prepend(el("span", "pw-src-meta", w.type));
    }
    if (wg.children.length > 1) list.appendChild(wg);

    if (!list.children.length) list.appendChild(el("div", "pw-src-empty", "nothing matches"));
  }

  function refresh() { render(); }
  return { win, refresh };
}
