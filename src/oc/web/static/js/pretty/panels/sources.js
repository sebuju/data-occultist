// Sources catalogue (edit mode): a live, searchable tree of EVERYTHING bindable — globals
// (current page, live/worker activity, flow status), datasets (+fields), subsets (+columns),
// node inputs (grouped by node), per-dataset status, and other pretty widgets (the reactive
// scope). The single place bindings are discovered: copy a token (paste into a label/condition)
// or "use" to bind it to the selected widget. Each section is collapsed by default; opening one
// fetches its sources' live values and shows them inline (no hover needed).
//
// "only with value" filters to sources that currently resolve to a non-empty value.

import { createFloatWin } from "../../graph/floatwin.js";
import { fieldset } from "../../dom.js";
import { nodeInputs } from "../constraints.js";
import { resolveToken } from "../binding.js";
import { el } from "../widgets/util.js";

// Only these widget types publish a live value into the reactive scope (control.js / form.js call
// data.publish). Listing the others is noise — their {{widget:id}} can never resolve.
const PUBLISHING_WIDGETS = new Set(["control", "form"]);

export const sourcesState = { visible: false, x: null, y: null, w: 300, h: null, collapsed: false, open: {} };

// Global sources — the "where am I / what's running" tokens, each with a plain-language note so
// it's obvious what value it yields (the recurring "these don't make sense" complaint).
const GLOBALS = [
    ["{{page}}", "current page id"],
    ["{{activity:running}}", "any worker running (1/0)"],
    ["{{activity:live}}", "live collection on (1/0)"],
    ["{{activity:precapture}}", "precapture running (1/0)"],
    ["{{activity:sweeps}}", "sweeps running (count)"],
    ["{{activity:triggers}}", "triggers firing (count)"],
    ["{{status:datasets}}", "datasets present (count)"],
    ["{{status:windows}}", "windows seen (count)"],
];

export function buildSources(ctx) {
    const win = createFloatWin({ id: "pretty-sources", title: "sources", state: sourcesState, bothAxes: true, autoFit: false,
        onShow: () => { updateWiring(); refresh(); }, onHide: () => wireValueData(false) });
    const openState = sourcesState.open || (sourcesState.open = {});

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
    valChk.addEventListener("change", () => { valOnly = valChk.checked; updateWiring(); refresh(); });

    // Sections whose tokens resolve against polled/heartbeat data (vs. live node/widget reads).
    // We only require that data while one of these is open (or the value filter is on).
    const VALUE_SECTIONS = ["globals", "datasets", "subsets", "status"];
    function valueSectionsOpen() { return VALUE_SECTIONS.some((k) => openState[k]); }
    function updateWiring() { wireValueData(valOnly || valueSectionsOpen()); }

    // require/poll dataset+subset+status+activity keys while values are shown; release otherwise.
    const valKeys = []; const valSubs = [];
    function wireValueData(on) {
        for (const u of valSubs) u(); valSubs.length = 0;
        for (const k of valKeys) ctx.data.release(k); valKeys.length = 0;
        if (!on) return;
        const m = ctx.model;
        const keys = [...m.datasets().map((d) => `dataset:${d}`), ...(m.profile.subsets || []).map((s) => `subset:${s.id}`), "status", "activity"];
        for (const k of keys) { ctx.data.require(k); valKeys.push(k); valSubs.push(ctx.data.subscribe(k, refresh)); }
        valSubs.push(ctx.data.subscribe("page", refresh));   // page is pushed (not required), just listen
    }

    function hasValue(inner) {
        const v = resolveToken(ctx, inner);
        if (v == null || v === "") return false;
        if (typeof v === "number" && v === 0 && /^(dataset|subset):[^.|]+$/.test(inner.split("|")[0].trim())) return false;   // empty collection
        return true;
    }
    const innerOf = (token) => token.replace(/^\{\{|\}\}$/g, "").trim();
    const keep = (token) => !valOnly || hasValue(innerOf(token));

    // One source row: token code + inline resolved value (+ optional meta). Clicking the row copies
    // the token to the clipboard (flash to confirm); the row highlights on hover.
    function makeRow({ token, child, meta }) {
        const row = el("div", "pw-src-row");
        if (child) row.classList.add("pw-src-child");
        if (meta) row.appendChild(el("span", "pw-src-meta", meta));
        const code = el("code", "pw-src-tok", token);
        const val = el("span", "pw-src-v");
        const v = resolveToken(ctx, innerOf(token));
        val.textContent = v == null || v === "" ? "·" : String(v);
        row.append(code, val);
        row.title = "click to copy";
        row.addEventListener("click", () => {
            try { navigator.clipboard.writeText(token); } catch { /* */ }
            row.classList.add("pw-src-copied");
            setTimeout(() => row.classList.remove("pw-src-copied"), 600);
        });
        return row;
    }

    // Slicing help line, appended under the datasets / subsets bodies.
    const SLICE_HELP = () => el("div", "pw-src-help",
        "slice rows in a label: {{dataset:id.field[0:5]|join}} — python slice; |join joins with \", \" (|join:\" / \" to change the delimiter)");

    function render() {
        const filter = search.value.trim().toLowerCase();
        const m = ctx.model;
        list.textContent = "";
        const match = (s) => !filter || s.toLowerCase().includes(filter);
        let any = false;

        // A collapsible section (collapsed by default). Rows are built only while open — so we
        // resolve/fetch values lazily on uncollapse. The count in the legend is always accurate.
        const addSection = (key, title, count, buildBody) => {
            if (!count) return;
            any = true;
            const open = !!openState[key];
            const fs = fieldset(`${title} · ${count}`, open ? buildBody() : el("div"), `pw-src:${key}`, {
                open,
                onToggle: (isOpen) => { openState[key] = isOpen; updateWiring(); refresh(); },
            });
            fs.classList.add("pw-src-fs");
            list.appendChild(fs);
        };

        const g = GLOBALS.filter(([tok, desc]) => match(`${tok} ${desc}`) && keep(tok));
        addSection("globals", "globals", g.length, () => g.map(([tok, desc]) => makeRow({ token: tok, meta: desc })));

        const dRows = [];
        for (const d of m.datasets()) {
            if (match(`dataset ${d}`) && keep(`{{dataset:${d}}}`)) dRows.push({ token: `{{dataset:${d}}}` });
            for (const f of m.datasetFields(d)) if (match(`${d} ${f}`) && keep(`{{dataset:${d}.${f}}}`)) dRows.push({ token: `{{dataset:${d}.${f}}}`, child: true });
        }
        addSection("datasets", "datasets", dRows.length, () => [...dRows.map(makeRow), SLICE_HELP()]);

        const sRows = [];
        for (const s of m.profile.subsets || []) {
            if (match(`subset ${s.id}`) && keep(`{{subset:${s.id}}}`)) sRows.push({ token: `{{subset:${s.id}}}` });
            for (const c of m.subsetColumns(s.id)) if (match(`${s.id} ${c}`) && keep(`{{subset:${s.id}.${c}}}`)) sRows.push({ token: `{{subset:${s.id}.${c}}}`, child: true });
        }
        addSection("subsets", "subsets", sRows.length, () => [...sRows.map(makeRow), SLICE_HELP()]);

        // node inputs: grouped by node id (the token already names the path, so no per-row meta).
        const inputs = nodeInputs(m).filter((inp) => (match(`${inp.nodeId} ${inp.nodeLabel} ${inp.label} ${inp.path}`)) && keep(`{{node:${inp.path}}}`));
        addSection("nodes", "node inputs", inputs.length, () => {
            const frag = document.createDocumentFragment();
            let curNode = null;
            for (const inp of inputs) {
                if (inp.nodeId !== curNode) { curNode = inp.nodeId; frag.appendChild(el("div", "pw-src-grp", inp.nodeId)); }
                frag.appendChild(makeRow({ token: `{{node:${inp.path}}}`, child: true }));
            }
            return frag;
        });

        const stDs = m.datasets().filter((d) => match(`status ${d}`) && keep(`{{status:${d}.present}}`));
        addSection("status", "dataset status", stDs.length, () => stDs.map((d) => makeRow({ token: `{{status:${d}.present}}`, meta: d })));

        // only control/form widgets publish a value (others would always resolve empty)
        const wRows = ctx.currentWidgets().filter((w) => PUBLISHING_WIDGETS.has(w.type) && match(`${w.id} ${w.type}`) && keep(`{{widget:${w.id}}}`));
        addSection("widgets", "pretty elements", wRows.length, () => wRows.map((w) => makeRow({ token: `{{widget:${w.id}}}`, meta: w.type })));

        if (!any) list.appendChild(el("div", "pw-src-empty", "nothing matches"));
    }

    function refresh() { render(); }
    return { win, refresh };
}
