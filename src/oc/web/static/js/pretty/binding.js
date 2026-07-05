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
//   page                     the id of the page currently shown/edited (changes on page switch)
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
    add("page", "current page");
    add("status:datasets", "status · datasets");
    // live worker heartbeat (what the tasks/live/precapture panels reflect) — see resolveToken
    add("activity:running", "activity · any running");
    add("activity:live", "activity · live");
    add("activity:precapture", "activity · precapture");
    add("activity:sweeps", "activity · sweeps running");
    add("activity:triggers", "activity · triggers firing");
    return out;
}

// Strip a trailing python-style `[...]` row slice off a token segment (so the subscribe key /
// id is the bare collection, not "id[0:5]").
const stripSlice = (s) => String(s).replace(/\[[^\]]*\]\s*$/, "").trim();

// The subscribe key a token/binding depends on (what the data layer notifies on).
export function subKeyForToken(inner) {
    const src = String(inner || "").split("|")[0].trim();
    if (src.startsWith("dataset:")) return `dataset:${stripSlice(src.slice(8).split(".")[0])}`;
    if (src.startsWith("subset:")) return `subset:${stripSlice(src.slice(7).split(".")[0])}`;
    if (src.startsWith("node:")) return `node:${src.slice(5).trim()}`;
    if (src.startsWith("widget:")) return `widget:${src.slice(7).trim()}`;
    if (src === "page") return "page";
    if (src.startsWith("status")) return "status";
    if (src.startsWith("activity")) return "activity";
    return null;
}

export function dataKeyForBinding(b) {
    if (!b || !b.id) return null;
    return b.src === "subset" ? `subset:${b.id}` : `dataset:${b.id}`;
}

// Pull a trailing python-style `[...]` slice off a dataset/subset body. Returns the remaining
// body (id[.field]) and the parsed slice (null when absent / empty).
function splitSlice(body) {
    const m = /^(.*)\[([^\]]*)\]\s*$/.exec(String(body));
    if (!m) return { rest: body, slice: null };
    return { rest: m[1], slice: parseSlice(m[2]) };
}
// Parse a slice spec: "n" -> single index; "a:b" / "a:b:c" -> range (any part may be blank).
function parseSlice(spec) {
    spec = String(spec).trim();
    if (spec === "") return null;
    const toInt = (s) => { s = String(s).trim(); if (s === "") return null; const n = parseInt(s, 10); return Number.isFinite(n) ? n : null; };
    if (!spec.includes(":")) { const i = toInt(spec); return i == null ? null : { index: i }; }
    const p = spec.split(":");
    return { start: toInt(p[0]), stop: toInt(p[1]), step: p.length > 2 ? toInt(p[2]) : null };
}
// Apply a parsed slice to `rows` with python semantics (negative indices, step, blanks).
function applySlice(rows, sl) {
    if (!sl) return rows;
    const n = rows.length;
    if (sl.index != null) { const i = sl.index < 0 ? n + sl.index : sl.index; return (i >= 0 && i < n) ? [rows[i]] : []; }
    let step = sl.step == null ? 1 : sl.step; if (step === 0) step = 1;
    const out = [];
    if (step > 0) {
        const lo = sl.start == null ? 0 : (sl.start < 0 ? Math.max(n + sl.start, 0) : Math.min(sl.start, n));
        const hi = sl.stop == null ? n : (sl.stop < 0 ? Math.max(n + sl.stop, 0) : Math.min(sl.stop, n));
        for (let i = lo; i < hi; i += step) out.push(rows[i]);
    } else {
        const lo = sl.start == null ? n - 1 : (sl.start < 0 ? n + sl.start : Math.min(sl.start, n - 1));
        const hi = sl.stop == null ? -1 : (sl.stop < 0 ? n + sl.stop : sl.stop);
        for (let i = lo; i > hi; i += step) out.push(rows[i]);
    }
    return out;
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

// Join a slice of rows into a delimited string: `field` picks the column (else each row's first
// visible field), empties dropped, joined by `delim` (default ", ").
function joinRows(rows, field, delim) {
    const valOf = (r) => {
        if (field) return r[field];
        const k = Object.keys(r).find((x) => !x.startsWith("_"));   // first visible column
        return k ? r[k] : "";
    };
    return rows.map(valOf).filter((v) => v !== undefined && v !== null && v !== "").join(delim);
}

// Resolve one {{token}} inner string to a scalar (for dynamic text / conditions).
export function resolveToken(ctx, inner) {
    const parts = String(inner || "").split("|");
    const src = parts[0].trim();
    // everything after the first "|" is the aggregate (delimiters may contain "|", so re-join)
    const aggRaw = parts.slice(1).join("|").trim();
    const agg = aggRaw || "latest";
    if (src.startsWith("node:")) return pathGet(ctx.model.profile, src.slice(5).trim());
    if (src.startsWith("widget:")) return ctx.data.read(`widget:${src.slice(7).trim()}`);
    if (src === "page") return ctx.data.read("page") || "";   // the page id currently shown/edited
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
        const { rest, slice } = splitSlice(src.slice(isSub ? 7 : 8));
        const [id, field] = rest.split(".");
        let rows = ctx.data.read(`${isSub ? "subset" : "dataset"}:${id.trim()}`) || [];
        if (slice) rows = applySlice(rows, slice);      // pythonesque row slice, e.g. dataset:id[0:5]
        if (agg === "join" || agg.startsWith("join:")) {   // join sliced rows into a delimited string
            const c = agg.indexOf(":");
            const delim = c >= 0 ? agg.slice(c + 1).replace(/^["']|["']$/g, "") : ", ";
            return joinRows(rows, field && field.trim(), delim);
        }
        if (!field) return rows.length;                 // bare collection -> row count
        return aggregate(rows, field.trim(), agg);
    }
    return "";
}

// A trailing `|round:N` / `|dp:N` / `|fixed:N` / `|.Nf` directive sets a fixed decimal count
// (0 => integer). Kept as the last `|` segment so it never collides with an aggregate or a join
// delimiter. Returns [core, dp|null]. Mirrors templating.py `_split_format`.
const _FMT = /^(?:round|dp|fixed):(\d+)$|^\.(\d+)f$/i;
function splitFormat(inner) {
    const parts = inner.split("|");
    if (parts.length > 1) {
        const m = parts[parts.length - 1].trim().match(_FMT);
        if (m) return [parts.slice(0, -1).join("|").trim(), +(m[1] != null ? m[1] : m[2])];
    }
    return [inner, null];
}

// Replace every {{token}} in `text` with its resolved value. A `|round:N` suffix formats to N
// decimals; otherwise numbers trim to int-bare / 2dp.
export function renderDynamicText(ctx, text) {
    return String(text == null ? "" : text).replace(/\{\{(.+?)\}\}/g, (_m, inner) => {
        const [core, dp] = splitFormat(inner.trim());
        const v = resolveToken(ctx, core);
        if (dp != null) { const n = Number(v); return Number.isFinite(n) ? n.toFixed(dp) : (v == null ? "" : String(v)); }
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
