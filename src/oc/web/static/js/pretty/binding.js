// Bindings + dynamic text. A binding (or a {{token}} inside a label) names a live source;
// this module resolves it against the data layer / shared model and reports which subscribe
// key it depends on so the page can re-evaluate reactively.
//
// Sources:
//   dataset:<id>[.<field>]   rows of a dataset, or one field aggregated to a scalar
//   subset:<id>[.<col>]      rows of a view, or one column aggregated to a scalar
//   node:<path>              a node-input value (live, honours transient overrides)
//   status[:<ds>.<f>]        live flow status (dataset present/total/last_op, or counts)
//   activity[:<what>]        live worker heartbeat (running / live / precapture / sweeps / triggers)
//   widget:<id>              another pretty element's published value (the reactive scope)
//
// A token may end with `| <agg>` (count|sum|mean|min|max|latest|first) to collapse rows.

import { pathGet } from "./path.js";
import { nodeInputs } from "./constraints.js";

// Every bindable source as {value: token, label} — datasets (+fields), subsets (+columns),
// node inputs, pretty widgets, status. Drives the conditions builder's source dropdown.
export function sourceTokenList(model, widgets = []) {
    const out = [];
    const add = (v, l) => out.push({ value: v, label: l });
    for (const d of model.datasets()) { add(`dataset:${d}`, `rows · ${d}`); for (const f of model.datasetFields(d)) add(`dataset:${d}.${f}`, `${d} · ${f}`); }
    for (const s of model.profile.subsets || []) { add(`subset:${s.id}`, `rows · ${s.id}`); for (const c of model.subsetColumns(s.id)) add(`subset:${s.id}.${c}`, `${s.id} · ${c}`); }
    for (const i of nodeInputs(model)) add(`node:${i.path}`, `node · ${i.nodeLabel} · ${i.label}`);
    for (const w of widgets) add(`widget:${w.id}`, `widget · ${w.id} (${w.type})`);
    add("status:datasets", "status · datasets");
    // live worker heartbeat (what the tasks/live/precapture panels reflect) — see resolveToken
    add("activity:running", "activity · any running");
    add("activity:live", "activity · live");
    add("activity:precapture", "activity · precapture");
    add("activity:sweeps", "activity · sweeps running");
    add("activity:triggers", "activity · triggers firing");
    return out;
}

// The subscribe key a token/binding depends on (what the data layer notifies on).
export function subKeyForToken(inner) {
    const src = String(inner || "").split("|")[0].trim();
    if (src.startsWith("dataset:")) return `dataset:${src.slice(8).split(".")[0].trim()}`;
    if (src.startsWith("subset:")) return `subset:${src.slice(7).split(".")[0].trim()}`;
    if (src.startsWith("node:")) return `node:${src.slice(5).trim()}`;
    if (src.startsWith("widget:")) return `widget:${src.slice(7).trim()}`;
    if (src.startsWith("status")) return "status";
    if (src.startsWith("activity")) return "activity";
    return null;
}

export function dataKeyForBinding(b) {
    if (!b || !b.id) return null;
    return b.src === "subset" ? `subset:${b.id}` : `dataset:${b.id}`;
}

function aggregate(rows, field, agg) {
    const vals = rows.map((r) => r[field]).filter((v) => v !== undefined && v !== null && v !== "");
    const nums = vals.map(Number).filter((n) => Number.isFinite(n));
    switch (agg) {
        case "count": return rows.length;
        case "sum": return nums.reduce((a, b) => a + b, 0);
        case "mean": return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : "";
        case "min": return nums.length ? Math.min(...nums) : "";
        case "max": return nums.length ? Math.max(...nums) : "";
        case "first": return vals.length ? vals[0] : "";
        case "latest": default: return vals.length ? vals[vals.length - 1] : "";
    }
}

// Resolve one {{token}} inner string to a scalar (for dynamic text / conditions).
export function resolveToken(ctx, inner) {
    const parts = String(inner || "").split("|");
    const src = parts[0].trim();
    const agg = (parts[1] || "").trim() || "latest";
    if (src.startsWith("node:")) return pathGet(ctx.model.profile, src.slice(5).trim());
    if (src.startsWith("widget:")) return ctx.data.read(`widget:${src.slice(7).trim()}`);
    if (src.startsWith("status")) {
        const st = ctx.data.read("status") || {};
        const rest = src.includes(":") ? src.slice(src.indexOf(":") + 1).trim() : "";
        if (!rest) return (st.datasets || []).length;
        if (rest === "datasets") return (st.datasets || []).length;
        if (rest === "windows") return (st.windows || []).length;
        const [dsId, f] = rest.split(".");
        const ds = (st.datasets || []).find((d) => d.dataset === dsId || d.id === dsId);
        return ds ? (f ? ds[f] : ds.present) : "";
    }
    if (src.startsWith("activity")) {
        const a = ctx.data.read("activity") || {};
        const rest = src.includes(":") ? src.slice(src.indexOf(":") + 1).trim() : "running";
        const firing = (a.triggers || []).filter((t) => (t.targets || []).some((x) => x.running)).length;
        switch (rest) {
            case "": case "running": return (a.live || a.precapture || (a.sweeps || []).length || firing) ? 1 : 0;
            case "live": return a.live ? 1 : 0;
            case "precapture": return a.precapture ? 1 : 0;
            case "sweeps": return (a.sweeps || []).length;
            case "triggers": return firing;
            default: return "";
        }
    }
    if (src.startsWith("dataset:") || src.startsWith("subset:")) {
        const isSub = src.startsWith("subset:");
        const body = src.slice(isSub ? 7 : 8);
        const [id, field] = body.split(".");
        const rows = ctx.data.read(`${isSub ? "subset" : "dataset"}:${id.trim()}`) || [];
        if (!field) return rows.length;                 // bare collection -> row count
        return aggregate(rows, field.trim(), agg);
    }
    return "";
}

// Replace every {{token}} in `text` with its resolved value (numbers trimmed to a tidy form).
export function renderDynamicText(ctx, text) {
    return String(text == null ? "" : text).replace(/\{\{(.+?)\}\}/g, (_m, inner) => {
        const v = resolveToken(ctx, inner.trim());
        if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(2);
        return v == null ? "" : String(v);
    });
}

// Rows for a table/chart binding (already aggregated server-side for subsets, per-dataset
// aggregate for datasets). Returns [] until the data layer has fetched them.
export function resolveRows(ctx, b) {
    const key = dataKeyForBinding(b);
    return key ? (ctx.data.read(key) || []) : [];
}

// Ordered column union across rows. Internal keys (leading "_") are hidden unless `withMeta`.
export function columnsOf(rows, withMeta = false) {
    const seen = [];
    for (const r of rows || []) for (const k of Object.keys(r)) {
        if (!withMeta && k.startsWith("_") && k !== "_seq") continue;   // _seq is the visible/sortable rolling id
        if (!seen.includes(k)) seen.push(k);
    }
    return seen;
}
