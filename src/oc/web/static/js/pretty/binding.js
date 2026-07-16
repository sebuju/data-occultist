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

// The data-layer key a dataset/subset SCALAR token resolves under. Its value is computed
// server-side (templating.py) and cached here, so a label/condition never fetches the whole row
// table just to fold it. Format directives (|round:N) are stripped so the subscribe side
// (subKeyForToken) and the read side (resolveToken) key on the same string regardless of which the
// caller passed. Table/chart bindings still take full rows via dataKeyForBinding — not this.
const tokenKey = (inner) => `token:${splitFormat(splitDefault(String(inner || "").trim())[0])[0]}`;

// The subscribe key a token/binding depends on (what the data layer notifies on).
export function subKeyForToken(inner) {
    const src = splitDefault(String(inner || "").trim())[0].split("|")[0].trim();
    if (src.startsWith("dataset:") || src.startsWith("subset:")) return tokenKey(inner);
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

// Resolve one {{token}} inner string to a scalar (for dynamic text / conditions). dataset:/subset:
// scalars are resolved server-side (templating.py) and read from the data-layer cache; the other
// sources are client-local (node inputs, the reactive widget scope, live status/activity, page).
export function resolveToken(ctx, inner) {
    const src = String(inner || "").split("|")[0].trim();
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
        // Resolved server-side (templating.py: count/sum/mean/min/max/first/latest, python slices
        // incl. negative index, join) and cached under the token key — the browser no longer folds
        // whole row tables for a scalar. `undefined`/`null` (not yet resolved, or an empty
        // aggregate) -> "" to match the old client-side behaviour; the widget re-renders on notify
        // once the first resolve lands.
        return ctx.data.read(tokenKey(inner)) ?? "";
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

// A trailing ` ?? default` sets a literal fallback rendered when the token resolves to nothing
// (null/undefined/""). Whitespace-padded so it never collides with a `??` inside a |join
// delimiter; split on the FIRST ` ?? `. Returns [left, default|null]. Mirrors templating.py
// split_default — the two renderers MUST stay in lockstep.
const _DEFAULT = /\s\?\?\s/;
function splitDefault(inner) {
    const m = _DEFAULT.exec(inner);
    if (!m) return [inner, null];
    return [inner.slice(0, m.index).trim(), inner.slice(m.index + m[0].length).trim()];
}

// Replace every {{token}} in `text` with its resolved value. A ` ?? fallback` renders when the
// token is nothing (null/""); a `|round:N` suffix formats to N decimals; otherwise numbers trim
// to int-bare / 2dp.
export function renderDynamicText(ctx, text) {
    return String(text == null ? "" : text).replace(/\{\{(.+?)\}\}/g, (_m, inner) => {
        const [left, def] = splitDefault(inner.trim());
        const [core, dp] = splitFormat(left);
        const v = resolveToken(ctx, core);
        if (def != null && (v == null || v === "")) return def;   // authored `?? fallback`
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
