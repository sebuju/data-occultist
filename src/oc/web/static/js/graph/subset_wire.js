// Subset node: join one or more datasets/subsets, then filter / derive / sort / hide-columns,
// with a live records-grid satellite. This file owns the config-node builder (subConfigNode /
// subsetParts), its per-source join + match-norm + pivot editors, the live column reconciliation,
// wireSubset, and the coalesced live-refresh storm-control (queueNodeRefresh + the batched
// /flow/details fetch feeding refreshDataNode / refreshSubsetNode). Split out of main.js; the
// deferred-edit wrapper (nodeEdit), onValueEdit, wireArmedRemove and the _bootDetails prefetch
// live in main and are imported back.
import * as api from "../api.js";
import * as nodeTxn from "./node_txn.js";
import { model, nodeEls } from "./state.js";
import { h, frag, labCell, srcRow } from "../dom.js";
import { renameNode, movePos } from "./node_lifecycle.js";
import { persist } from "./persist.js";
import { listBlock } from "./list_block.js";
import { sourcesInput } from "./sources_input.js";
import { singleFlight } from "../singleflight.js";
import { _optGroups, _colOpts, aggregateSelect, satToggleBtn } from "./node_parts.js";
import { vtables, vtableFor, expandSubsetRow, refreshDataNode, loadBatchesNode } from "./panels/datanodes.js";
import {
    render, autosave, rebuildNode, nodeEdit, setNodeBusy,
    onValueEdit, wireArmedRemove, _bootDetails,
} from "./main.js";

// ---- subset node: join one or more datasets, then filter/derive/sort ----------

const SUB_OPS = ["contains", "icontains", "eq", "ne", "nonempty", "empty", "gt", "lt", "gte", "lte", "regex"];

// how a source combines beyond a plain key-matched join (matches JoinSource.mode in models.py)
const SOURCE_MODES = ["join", "exclude", "mark", "broadcast"];
const SOURCE_MODE_LABEL = {
    join: "join (key-match)", exclude: "exclude (anti-join)",
    mark: "mark (semi-join, annotate)", broadcast: "broadcast (merge onto every row)",
};



// Last live column set a subset's join actually returned (set by refreshSubsetNode). The static
// schema (model.subsetColumns) only knows columns declared on windows — orders/enrich columns
// and other dataset-fed fields aren't in it, so the config must also offer what the join shows.
const subsetLiveCols = new Map();

// Every column a subset's config should list: static schema ∪ live result columns ∪ hidden
// columns. Hidden columns are STRIPPED from the live result by the backend, so without the
// last union they'd vanish from the toggle list and could never be turned back on.
function viewColumns(s) {
    const out = [];
    const add = (c) => { if (c && !out.includes(c)) out.push(c); };
    model.subsetColumns(s.id).forEach(add);
    (subsetLiveCols.get(s.id) || []).forEach(add);
    (s.hidden_columns || []).forEach(add);
    return out;
}

// Order the visible/hide toggles to MATCH the table: the vtable's live column order (which
// honours the user's column drag-reorder) first, then hidden columns (not in the table, so
// they have no table position), then any schema columns not yet seen — so the buttons read
// left-to-right exactly as the columns sit in the table.
function viewDisplayColumns(s) {
    const out = [];
    const add = (c) => { if (c && !out.includes(c)) out.push(c); };
    (vtables.get(`view:${s.id}`)?.columns || subsetLiveCols.get(s.id) || []).forEach(add);
    (s.hidden_columns || []).forEach(add);
    viewColumns(s).forEach(add);
    return out;
}

// Which source each of a subset's columns comes from — the ONE partition both the column dropdowns
// (optgroups) and the visible/hide row (subheadings) render from (rule 7). A column is claimed by
// the FIRST source offering it (a join key lives in several); everything no source declares (this
// subset's derived columns, live enrich/meta columns the static schema can't know) lands in a
// trailing group named after the subset itself. Returns null when there's nothing to separate —
// one source is no join, and a lone group is just noise. Order within a group follows `cols`.
function viewColumnGroups(s, cols) {
    const inputs = model.subsetInputs(s);
    if (inputs.length < 2) return null;
    const owner = new Map();
    for (const ds of inputs) for (const c of model.inputColumns(ds)) if (!owner.has(c)) owner.set(c, ds);
    const groups = inputs.map((ds) => ({ label: ds, cols: [] }));
    const byLabel = new Map(groups.map((g) => [g.label, g]));
    const own = { label: s.id, cols: [] };
    for (const c of cols) (byLabel.get(owner.get(c)) || own).cols.push(c);
    return [...groups, own].filter((g) => g.cols.length);
}

// `_`-prefixed columns (_seq, _count, …) are store meta, not data — sink them below the real
// columns of whatever list they're in. Array.sort is stable, so everything else keeps its order.
const metaLast = (cols) => cols.slice().sort((a, b) => (a.startsWith("_") ? 1 : 0) - (b.startsWith("_") ? 1 : 0));

// A subset's column dropdown: grouped by source once it joins, flat when it has one input.
function subColOpts(s, cols, sel) {
    const groups = viewColumnGroups(s, cols);
    return groups
        ? _optGroups(groups.map((g) => ({ label: g.label, cols: metaLast(g.cols) })), sel)
        : _colOpts(metaLast(cols), sel);
}

function hideToggleNodes(s) {
    const hidden = new Set(s.hidden_columns || []);
    const cols = viewDisplayColumns(s);
    if (!cols.length) return h("span", { class: "muted sub-empty" }, "no columns yet");
    const btn = (c) => h("button", {
        class: `sv-hide${hidden.has(c) ? " off" : ""}`, dataset: { col: c },
        title: `${hidden.has(c) ? "show" : "hide"} column`,
    }, c);
    // joined -> the toggles carry a subheading per source, so it's clear which dataset a column
    // came from (they'd otherwise read as one undifferentiated pile). Unjoined -> plain row.
    const groups = viewColumnGroups(s, cols);
    if (!groups) return cols.map(btn);
    return groups.flatMap((g) => [h("span", { class: "sv-hide-h" }, g.label), ...g.cols.map(btn)]);
}

// Repaint + re-wire a subset's visible/hide toggle row in place (no node rebuild).
function renderHideToggles(el, s) {
    const hides = el && el.querySelector(".sv-hides");
    if (hides) { hides.replaceChildren(...[hideToggleNodes(s)].flat()); wireHideToggles(el, s); }
}

// Wire the visible/hide toggles. Standalone (not closed over wireSubset) so refreshSubsetNode
// can re-render + re-wire just this block when the live column set arrives/changes.
// Toggling does NOT rebuild the whole node (that wiped the vtable → "loading…" flash); it flips
// the button in place and re-fetches the subset, whose columns honour hidden_columns — the
// vtable then updates its columns in place and refreshSubsetNode repaints the toggles.
function wireHideToggles(host, s) {
    host.querySelectorAll(".sv-hide").forEach((b) => b.addEventListener("click", () => {
        nodeEdit(`sub:${s.id}`, "recompute", () => {
            model.toggleHiddenColumn(s.id, b.dataset.col);
            const nowHidden = (s.hidden_columns || []).includes(b.dataset.col);
            b.classList.toggle("off", nowHidden);                   // instant feedback, no node rebuild
            b.title = nowHidden ? "show column" : "hide column";
        }, () => { autosave(null); refreshSubsetNode(s.id); });     // hiding a view column changes nothing any window OCRs
    }));
}

// Client mirror of oc.store.textnorm.norm_text — same step order (lower -> strip punct -> drop
// whole words -> collapse whitespace), so the join-settings preview matches what the backend keys on.
function normPreview(jn, value) {
    let s = String(value || "");
    if (jn.case_insensitive) s = s.toLowerCase();
    if (jn.strip_punct) s = s.replace(/[^\w\s]+/g, " ");
    const words = jn.strip_words || [];
    if (words.length) {
        const drop = new Set(words.map((w) => (jn.case_insensitive ? w.toLowerCase() : w)));
        s = s.split(/\s+/).filter(Boolean).filter((t) => !drop.has(jn.case_insensitive ? t.toLowerCase() : t)).join(" ");
    }
    if (jn.collapse_ws) s = s.replace(/\s+/g, " ").trim();
    return s;
}

// One source's per-source join config (a block within the subset's "sources" grid). Each input
// carries its OWN join field / match-norm / many->one aggregate / required flag. Returns null when
// the source has nothing to configure (a single non-dedup dataset source) so no empty block shows.
//   • `joined` (2+ sources) -> show join-on column, required, and match knobs (once a field is set);
//   • a dataset source that dedups -> show its "many →" collapse;
//   • a subset source / no-dedup dataset -> no aggregate row (it already serves one row per key).
function sourceCfgNode(s, ds, joined) {
    const isView = !!model.subsetDef(ds);
    const src = model.subsetSource(s.id, ds) || {};
    const jf = src.join_field || "";
    const showAgg = !isView && model.datasetDedup(ds);
    if (!joined && !showAgg) return null;   // single non-dedup source: nothing to configure
    const cols = model.inputColumns(ds);
    // source header spans BOTH grid columns (gspan) — a shared node subheading above its settings
    const rows = [h("span", { class: "gspan sv-src-h", title: "this source's settings" }, ds)];
    // "many ->" is the read/collapse policy, NOT a join input — render it FIRST, above the join config,
    // so it doesn't read as a join knob.
    if (showAgg) {
        rows.push(labCell("many →", "how this source's many observations collapse to one value; inherit = the dataset's own policy"),
            aggregateSelect(model.sourceAggregate(s.id, ds), {
                cls: "sv-sagg", ds, all: true,
                inherit: model.sourceAggregateEffective(s.id, ds),   // names what "" resolves to
                title: "how THIS source's many observations collapse when the view reads them" }));
    }
    if (joined) {
        const mode = src.mode || "join";
        const modeOpts = SOURCE_MODES.map((m) => h("option", { value: m, selected: m === mode },
            m === mode ? `<${SOURCE_MODE_LABEL[m]}>` : SOURCE_MODE_LABEL[m]));
        rows.push(labCell("mode", "how this source combines into the join — see the option list"),
            h("select", { class: "sv-smode", dataset: { ds } }, modeOpts));
        // broadcast merges onto every row unkeyed -- no join key to configure at all.
        if (mode !== "broadcast") {
            const joinOpts = [h("option", { value: "", selected: !jf }, "(no join)"),
                ...[...new Set([jf, ...cols])].filter(Boolean).map((c) => h("option", { value: c, selected: c === jf }, c === jf ? `<${c}>` : c))];
            rows.push(labCell("join on", "this source's column used as the join key; (no join) stacks its rows"),
                h("select", { class: "sv-sjoin", dataset: { ds } }, joinOpts));
            if (jf) {
                // required only gates a plain join's output presence -- meaningless for exclude/mark,
                // which never affect whether a key survives on their own.
                if (mode === "join") {
                    rows.push(labCell("required", "key must exist in this source (inner-style); off = optional outer fill"),
                        h("input", { type: "checkbox", class: "sv-sreq", dataset: { ds }, checked: !!src.required }));
                }
                const jn = model.sourceJoinNorm(s.id, ds);
                const ckRow = (lbl, title, cls, on) => frag(labCell(lbl, title),
                    h("input", { type: "checkbox", class: cls, dataset: { ds }, checked: !!on }));
                rows.push(
                    ckRow("ignore case", "fold case before matching", "sn-ci", jn.case_insensitive),
                    ckRow("strip punc", "strip punctuation (collapse to spaces)", "sn-punct", jn.strip_punct),
                    ckRow("collapse ws", "runs of whitespace -> one space, trimmed", "sn-ws", jn.collapse_ws),
                    labCell("drop words", "whole words removed from this side; space- or comma-separated"),
                    h("input", { type: "text", class: "sn-words", dataset: { ds }, value: (jn.strip_words || []).join(" "), placeholder: "(none)" }));
                // live worked example: a REAL sample join value from this source, transformed by the knobs
                // above. Filled async (fillNormSamples) since the sample is fetched; updates in place as the
                // knobs change. Shows a "no data" note when the source has no value to preview.
                rows.push(labCell("example", "how these settings canonicalise a real join value from this source", false, "eg-lab"),
                    h("span", { class: "sv-norm-eg", dataset: { ds, jf } }, h("span", { class: "muted" }, "loading…")));
            }
        }
    }
    return frag(...rows);
}

// Repaint ONE source's worked example in place from the current knobs + the cached sample
// (`el._sample`, set by fillNormSamples). `_sample === undefined` -> still loading; `null` -> the
// source had no value to preview; a string -> show `"raw" → normalised`. Event-driven (knob/keystroke),
// never a steady-state poll, so replaceChildren here is fine.
function renderNormEg(el, sid) {
    const ds = el.dataset.ds;
    const jn = model.sourceJoinNorm(sid, ds);
    const many = (el._samples?.length || 0) > 1;   // clickable only when there's another to show
    el.classList.toggle("clickable", many);
    el.title = many ? "click for another example" : "";
    if (el._sample === undefined) { el.replaceChildren(h("span", { class: "muted" }, "loading example…")); return; }
    if (el._sample === null) { el.replaceChildren(h("span", { class: "muted" }, `no ${el.dataset.jf} data to preview`)); return; }
    el.replaceChildren(el._sample, h("span", { class: "eg-arrow" }, " → "), normPreview(jn, el._sample) || "∅");
}

// Fetch real sample join values for every source's worked example, then render each. Collects every
// DISTINCT non-empty value in the source's join column (its own rows for a dataset, computed rows for
// a subset) into `el._samples` so clicking the example cycles through them (cycleNormEg); the first is
// shown. Failures / empty sources resolve to the "no data" state, never an error.
async function fillNormSamples(div, s) {
    const game = encodeURIComponent(model.profile.name);
    await Promise.all([...div.querySelectorAll(".sv-norm-eg")].map(async (el) => {
        const ds = el.dataset.ds, jf = el.dataset.jf;
        const seen = new Set(), list = [];
        try {
            const isView = !!model.subsetDef(ds);
            // boot batch already carries every source's rows — sample from it (no extra fetch); the
            // live path (post-boot edits) has no prefetch and fetches the one source it needs.
            const cached = isView ? _bootDetails?.subsets?.[ds] : _bootDetails?.datasets?.[ds];
            const data = cached || await (await fetch(`/api/flow/${game}/${isView ? "subset" : "dataset"}/${encodeURIComponent(ds)}`)).json();
            const recs = isView ? (data.rows || []) : (data.records || []);
            for (const r of recs) { const v = r[jf]; if (v != null && String(v).trim() !== "" && !seen.has(String(v))) { seen.add(String(v)); list.push(String(v)); } }
        } catch { /* leave empty -> "no data" */ }
        el._samples = list;
        el._sampleIdx = 0;
        el._sample = list.length ? list[0] : null;
        renderNormEg(el, s.id);
    }));
}

// Advance a worked example to its NEXT distinct sample (wraps). No-op with <2 samples.
function cycleNormEg(el, sid) {
    const list = el._samples || [];
    if (list.length < 2) return;
    el._sampleIdx = ((el._sampleIdx | 0) + 1) % list.length;
    el._sample = list[el._sampleIdx];
    renderNormEg(el, sid);
}

// Reshape flat name/value rows (e.g. a register's readout mirror) into wide rows by shared
// id-prefix, applied right after the join, before filter/derive/sort (PivotSpec in models.py).
// The suffix VOCABULARY (`attributes`) is authored here as a free-typed box, never hardcoded —
// mirrors the existing "drop words" convention (setSourceStripWords) for the same reason.
function pivotCfgNode(s) {
    const on = model.pivotEnabled(s.id);
    const rows = [
        labCell("pivot", "reshape flat name/value rows into wide rows by shared id-prefix (e.g. a register's readout mirror)"),
        h("input", { type: "checkbox", class: "sv-pivot-on", checked: on }),
    ];
    if (on) {
        const p = model.subsetPivot(s.id);
        rows.push(
            h("span", { class: "gspan sv-src-h", title: "pivot settings" }, "pivot"),
            labCell("name field", "column holding each flat row's id (e.g. \"slot_1_school\")"),
            h("input", { type: "text", class: "sv-pivot-namefield", value: p.name_field || "name", placeholder: "name" }),
            labCell("value field", "column holding each flat row's value"),
            h("input", { type: "text", class: "sv-pivot-valuefield", value: p.value_field || "value", placeholder: "value" }),
            labCell("key column", "output column name for the shared prefix"),
            h("input", { type: "text", class: "sv-pivot-keycol", value: p.key_column || "slot", placeholder: "slot" }),
            labCell("attributes", "taught id SUFFIXES, longest match wins; space- or comma-separated (e.g. _name _drain _school); a row matching none is dropped"),
            h("input", { type: "text", class: "sv-pivot-attrs", value: (p.attributes || []).join(" "), placeholder: "_name _drain _school" }));
    }
    return frag(...rows);
}

function subConfigNode(s) {
    const cols = viewColumns(s);
    const inputs = model.subsetInputs(s);
    const free = model.joinableInputs(s);   // datasets + other subsets (cycle-free)
    // sources are removable pills + a "+ join source" select — the SHARED sources-input widget
    // (rule 7 — same as producer sources / dict feeds).
    // join is PER-SOURCE now: each input carries its own join column, match-norm, many->one
    // collapse, and required flag (see model JoinSource). One config block per source.
    const joined = inputs.length > 1;
    const srcCfgs = inputs.map((ds) => sourceCfgNode(s, ds, joined)).filter(Boolean);
    // filters / derived / sort are three add-delete lists — all on the shared listBlock primitive
    // (rule 7); each supplies only its per-row cells + wiring classes, so main.js handlers still key
    // off .sf-*/.sd-*/.ss-* + data-i as before.
    const filters = listBlock({ items: s.filters, rowClass: "sub-row", del: { cls: "sf-del", title: "remove filter" },
        render: (f, i) => [
            h("select", { class: "sf-field", dataset: { i } }, subColOpts(s, cols, f.field)),
            h("select", { class: "sf-op", dataset: { i } }, SUB_OPS.map((o) => h("option", { selected: o === f.op }, o === f.op ? `<${o}>` : o))),
            h("input", { class: "sf-val", dataset: { i }, value: f.value || "", placeholder: "value" })] });
    const derived = listBlock({ items: s.derived, rowClass: "sub-row", del: { cls: "sd-del", title: "remove column" },
        render: (d, i) => [
            h("input", { class: "sd-name", dataset: { i }, value: d.name || "", placeholder: "new column" }),
            h("span", { class: "muted" }, "="),
            h("input", { class: "sd-tpl", dataset: { i }, value: d.template || "", placeholder: "{=count*price_median|round:0} plat" })] });
    // multi-column sort: primary row first, each a column + direction; applied before limit
    const sortRows = listBlock({ items: s.sort, rowClass: "sub-row", del: { cls: "ss-del", title: "remove sort" },
        render: (so, i) => [
            h("select", { class: "ss-field", dataset: { i } }, subColOpts(s, cols, so.field)),
            h("select", { class: "ss-dir", dataset: { i } },
                h("option", { value: "asc", selected: !so.desc }, !so.desc ? "<asc>" : "asc"),
                h("option", { value: "desc", selected: !!so.desc }, !!so.desc ? "<desc>" : "desc"))] });
    // label + its inline "+" add button — a col-1 cell for the ONE node grid (matches labCell),
    // so filters/columns/sort/visible line up in the same label column as sources/limit/latest.
    const addLbl = (text, title, addCls, addTitle) =>
        h("span", { class: "lab sub-lbl", title }, text, h("button", { class: addCls, title: addTitle }, "+"));
    // ONE grid for the whole config: sources, per-source join, limit/latest, then filters/columns/
    // sort/visible — every label in col 1, its control(s) in col 2.
    return h("div", { class: "lab-grid" },
        srcRow("sources", "datasets or subsets; each joins on its own field",
            sourcesInput({ chips: inputs.map((ds) => ({ value: ds, node: model.refNode(ds) })), free,
                addLabel: "+ join source", rmTitle: "remove input" })),
        ...srcCfgs,
        // close the per-source section so the view-level rows below (limit, latest batch) don't
        // read as part of the last source's block
        ...(srcCfgs.length ? [h("div", { class: "gspan sv-sec-end" })] : []),
        labCell("limit", "cap the number of result rows (0 = no limit)"),
        h("input", { type: "number", class: "sv-limit", min: "0", step: "1", value: s.limit || 0, placeholder: "0" }),
        labCell("latest batch", "only pull rows from each source's most recent collection batch (applied before everything else)"),
        h("input", { type: "checkbox", class: "sv-latest", checked: !!s.latest_batch }),
        pivotCfgNode(s),
        addLbl("filters", "all must pass", "sub-addf", "add filter"),
        h("div", { class: "sub-rows" }, filters),
        addLbl("columns", "{col} text · {=expr} math · |round:N decimals · mix freely", "sub-addd", "add column"),
        h("div", { class: "sub-rows" }, derived),
        addLbl("sort", "primary first; applied before limit", "sub-adds", "add sort"),
        h("div", { class: "sub-rows" }, sortRows),
        labCell("visible", "click to hide/show", false, "vis-lab"),
        h("div", { class: "sv-hides" }, hideToggleNodes(s)));
}

function subsetParts(s) {
    // config is always visible now (no fold toggle); the head button toggles the records-grid
    // satellite (vt:sub:<id>), the same opt-in follower datasets get.
    return {
        title: h("input", { class: "gi gi-id subrename", value: s.id, title: "subset name" }),
        head: satToggleBtn(`vt:sub:${s.id}`, "vttable"),
        body: subConfigNode(s),
        ports: h("span", { class: "port out", title: "drag to another subset to feed it this subset's rows" }),
    };
}

// The sort/filter/join selects are built from the STATIC schema at render time — before the
// live join exposes its real columns. Repaint their options (preserving the current value)
// once the live column set changes, so every actual column is offered. Only touches the DOM
// when the set actually changed (event-driven, not a poll).
function repaintSubsetCols(el, s) {
    const cols = viewColumns(s);
    const sig = cols.join("|");
    if (el._colsig === sig) return;
    el._colsig = sig;
    for (const sel of el.querySelectorAll(".ss-field, .sf-field")) {
        const v = sel.value;
        sel.replaceChildren(...subColOpts(s, cols, v));
        sel.value = v;
    }
}

// Its compute can be slow — never run two at once for one subset, but a request that arrives
// mid-compute must re-run once after (never dropped), so a view tracking a live sweep lands on
// the FINAL data instead of stalling on a stale mid-sweep snapshot.
// `pre` (an already-computed view, e.g. from the one-shot boot batch) renders without a network
// round-trip; omit it for the live path and it fetches its own.
function refreshSubsetNode(id, pre = null) { return singleFlight(`sub:${id}`, (ctx) => _refreshSubsetNode(id, pre, ctx)); }
async function _refreshSubsetNode(id, pre, { superseded } = {}) {
    const el = nodeEls.get(`sub:${id}`);                              // config node (hide toggles live here)
    const vtId = `vt:sub:${id}`;
    const host = nodeEls.get(vtId)?.querySelector(".sub-host");       // records grid — opt-in satellite
    if (!el && !host) return;
    // spin the records-grid satellite while its rows are being recomputed (only when it's shown)
    const vtShown = !!host;
    if (vtShown) setNodeBusy(vtId, true);
    try {
        const r = pre || await api.getSubset(model.profile.name, id);
        // a newer request is already queued behind us — its result supersedes ours; skip the
        // paint and let the trailing rerun (singleflight.js) write the fresh one instead.
        if (superseded?.()) return;
        const s = model.subsetDef(id);
        if (host) {
            const vt = vtableFor(`view:${id}`, host);
            // dragging a column in the table re-orders the visible/hide buttons to match, live
            vt.onReorder = () => renderHideToggles(nodeEls.get(`sub:${id}`), s);
            // click a row to drill into the source rows that joined to produce it (one per input)
            vt.setData(r.columns || [], r.rows || [], { expander: (row) => expandSubsetRow(id, row) });
        }
        // the live join may expose columns the static schema can't know (orders/enrich fields) —
        // cache them and re-render the visible/hide toggles so every actual column is listed.
        subsetLiveCols.set(id, r.columns || []);
        if (s && el) { renderHideToggles(el, s); repaintSubsetCols(el, s); }
    } catch (e) {
        if (superseded?.()) return;
        // a just-added subset isn't on the backend until the profile saves (debounced) —
        // that's a transient 404, not an error; the post-save refresh fills it in.
        const msg = /\b404\b/.test(String(e.message || e)) ? "no data yet" : String(e.message || e);
        vtables.delete(`view:${id}`);
        if (host) host.replaceChildren(h("p", { class: "muted", style: "padding:8px" }, msg));
    } finally {
        if (vtShown) setNodeBusy(vtId, false);
    }
}

// ---- coalesced live refresh (storm control) -------------------------------
// Each open dataset/subset node refetching itself on every live change is N concurrent slow
// /dataset + /subset requests — a "storm" on a rename or a sweep, since singleFlight keys are
// per-node and so DON'T coalesce across nodes. Instead COLLECT the changed ids, debounce briefly,
// and pull them all in ONE POST /flow/details — the same batched, memo-shared endpoint the boot
// prefetch uses (a dataset feeding many views opens/parses once, not once per consumer). The
// per-node refresh still runs, but fed a prefetched `pre` so it does no network of its own; a
// dataset/subset missing from the batch (or a failed batch) falls back to its own fetch.
const _refDs = new Set(), _refSub = new Set();
let _refTimer = null;
function queueNodeRefresh({ datasets = [], subsets = [] } = {}) {
    // spin the CONFIG node's header the moment it's queued, not only once the batch fetch below
    // actually starts — a node "about to refresh" should already show it's about to refresh.
    // Guarded by `!has` so a burst of pushes for the same id before the debounce fires doesn't
    // inflate the busy refcount (flushNodeRefresh clears it exactly once per queued id).
    for (const d of datasets) if (d) {
        if (!_refDs.has(d) && nodeEls.has(`ds:${d}`)) setNodeBusy(`ds:${d}`, true);
        _refDs.add(d);
    }
    for (const s of subsets) if (s) {
        if (!_refSub.has(s) && nodeEls.has(`sub:${s}`)) setNodeBusy(`sub:${s}`, true);
        _refSub.add(s);
    }
    if (_refTimer === null) _refTimer = setTimeout(flushNodeRefresh, 120);   // coalesce a burst into one batch
}
async function flushNodeRefresh() {
    _refTimer = null;
    const queuedDs = [..._refDs], queuedSub = [..._refSub];   // snapshot before clearing — clears the queue-time busy set above, whatever the outcome
    const dss = queuedDs.filter((d) => nodeEls.has(`vt:ds:${d}`) || nodeEls.has(`ds:${d}`));
    const subs = queuedSub.filter((s) => nodeEls.has(`vt:sub:${s}`) || nodeEls.has(`sub:${s}`));
    _refDs.clear(); _refSub.clear();
    try {
        if (!dss.length && !subs.length) return;
        let details = null;
        try { details = await api.flowDetails(model.profile.name, dss, subs); } catch { /* batch failed -> per-node fetch */ }
        const jobs = [];
        for (const d of dss) { const pre = details?.datasets?.[d] || null; jobs.push(refreshDataNode(d, pre), loadBatchesNode(d, pre)); }
        for (const s of subs) jobs.push(refreshSubsetNode(s, details?.subsets?.[s] || null));
        // AWAIT the repaints, not just the batch fetch: kicking them off and dropping the spinner
        // immediately (as this used to) un-busied the node while its table still held the old rows —
        // the spinner lifted a beat BEFORE the update landed. Never throws (allSettled).
        await Promise.allSettled(jobs);
    } finally {
        // every queued node has now refetched AND repainted — drop the queue-time header spinner.
        for (const d of queuedDs) if (nodeEls.has(`ds:${d}`)) setNodeBusy(`ds:${d}`, false);
        for (const s of queuedSub) if (nodeEls.has(`sub:${s}`)) setNodeBusy(`sub:${s}`, false);
    }
}

function refreshAllSubsetNodes() {
    queueNodeRefresh({ subsets: (model.profile.subsets || []).map((s) => s.id) });
}

// Snapshot of each subset's serialized definition at the last load/save. The post-save refresh
// must recompute ONLY subsets whose definition actually changed — otherwise EVERY content save
// (a toast nudge, a window box, any unrelated edit) recomputed every open subset: each is a
// server view-join + a full satellite-table DOM rebuild, and doing all of them (~140ms server +
// hundreds of rows of layout thrash) on every keystroke was pinning the CPU. Seeded at load so an
// unrelated save refreshes nothing; a genuinely new/edited subset differs from the snapshot and is
// the only one filled (its whole purpose — a just-added subset 404s until the profile saves).
let _subsetSig = new Map();
function _subsetSigs() {
    const m = new Map();
    for (const s of model.profile.subsets || []) m.set(s.id, JSON.stringify(s));
    return m;
}
function seedSubsetSig() { _subsetSig = _subsetSigs(); }
function refreshChangedSubsetNodes() {
    const cur = _subsetSigs();
    const changed = [];
    for (const [id, sig] of cur) if (_subsetSig.get(id) !== sig) changed.push(id);
    _subsetSig = cur;
    if (changed.length) queueNodeRefresh({ subsets: changed });
}

// Refresh every subset that READS from `ds` (directly or through an upstream subset). Batch edits
// (revert / remove) change a dataset's contents WITHOUT appending a history event, so its ledger
// last_ts is unchanged and refreshLive's last_ts gate misses them — callers fixing a dataset's
// data must refresh its consumers explicitly.
function refreshDatasetConsumers(ds) {
    for (const s of model.profile.subsets || [])
        if (nodeEls.has(`sub:${s.id}`) && model.subsetReaches(s.id, ds)) refreshSubsetNode(s.id);
}


function wireSubset(div, s) {
    // subset edits are subset-only — they never change any window's image/regions/detect, so
    // autosave(null): persist + refresh THIS view, never re-OCR the open windows.
    // ...but they DO refetch the joined view and rebuild this body, so a burst of filter edits used
    // to fire one /subset per change and swap the DOM under the caret. Both defer to the
    // transaction: `mutate` paints now, the save+refetch runs once on ✓ / Enter / a click outside.
    const subEdit = (mutate, { rebuild = false } = {}) =>
        nodeEdit(`sub:${s.id}`, "recompute", () => { mutate(); if (rebuild) rebuildNode(`sub:${s.id}`); },
            () => { autosave(null); refreshSubsetNode(s.id); });
    const recompute = (mutate) => subEdit(mutate);
    const restructure = (mutate) => subEdit(mutate, { rebuild: true });   // rebuild this node's config
    div.querySelector(".subrename")?.addEventListener("change", (e) => {
        const oldId = s.id;
        nodeTxn.commitIfDirty();   // rename render()s + changes node identity — land any pending edit first
        renameNode(e.target, oldId,
            () => model.renameSubset(oldId, e.target.value),
            () => movePos(`sub:${oldId}`, `sub:${s.id}`),
            async () => {
                render(); autosave(null);
                // render()'s queued fetch for vt:sub:<newId> races the DEBOUNCED autosave: the backend
                // still serves the old (or no) def -> 404 "no data yet" and the grid never refills.
                // Flush the renamed def, then refetch this subset's records under the new id.
                await persist.flush();
                refreshSubsetNode(s.id);
            });
    });
    div.querySelector(".sub-addf")?.addEventListener("click", () => restructure(() => model.addFilter(s.id)));
    div.querySelector(".sub-addd")?.addEventListener("click", () => restructure(() => model.addDerived(s.id)));
    div.querySelector(".sub-adds")?.addEventListener("click", () => restructure(() => model.addSort(s.id)));

    // join inputs — adding/removing/swapping a source changes the wiring AND this config's own
    // source rows + join-on column list. They render() (edges change), so they stay immediate;
    // land any pending edit first.
    div.querySelector(".sv-addin")?.addEventListener("change", (e) => {
        nodeTxn.commitIfDirty();
        if (model.addSubsetInput(s.id, e.target.value)) { render(); autosave(null); rebuildNode(`sub:${s.id}`); }
    });
    wireArmedRemove(div, ".sv-rmin", (val) => {
        nodeTxn.commitIfDirty();
        model.removeSubsetInput(s.id, val); render(); autosave(null); rebuildNode(`sub:${s.id}`);
    });
    // PER-SOURCE join config — each control carries its source id in dataset.ds. Setting/clearing a
    // source's join field toggles its required + match rows, so rebuild the node (restructure);
    // the other knobs just re-canonicalise/recompute the view.
    div.querySelectorAll(".sv-sjoin").forEach((el) => el.addEventListener("change", (e) => restructure(() => model.setSourceJoinField(s.id, el.dataset.ds, e.target.value.trim()))));
    div.querySelectorAll(".sv-sreq").forEach((el) => el.addEventListener("change", (e) => recompute(() => model.setSourceRequired(s.id, el.dataset.ds, e.target.checked))));
    // switching mode toggles which rows show (required/join-on/norm), so rebuild the node
    div.querySelectorAll(".sv-smode").forEach((el) => el.addEventListener("change", (e) => restructure(() => model.setSourceMode(s.id, el.dataset.ds, e.target.value))));
    div.querySelectorAll(".sv-sagg").forEach((el) => el.addEventListener("change", (e) => recompute(() => model.setSourceAggregate(s.id, el.dataset.ds, e.target.value))));
    // norm knobs re-render the worked example IN PLACE (realtime) — no node rebuild, no refetch (the
    // sample is cached on the eg element) — then recompute() refreshes the actual joined view.
    const egFor = (ds) => div.querySelector(`.sv-norm-eg[data-ds="${CSS.escape(ds)}"]`);
    const previewNorm = (ds) => { const eg = egFor(ds); if (eg) renderNormEg(eg, s.id); };
    const normEdit = (el, patch) => recompute(() => { model.setSourceJoinNorm(s.id, el.dataset.ds, patch); previewNorm(el.dataset.ds); });
    div.querySelectorAll(".sn-ci").forEach((el) => el.addEventListener("change", (e) => normEdit(el, { case_insensitive: e.target.checked })));
    div.querySelectorAll(".sn-punct").forEach((el) => el.addEventListener("change", (e) => normEdit(el, { strip_punct: e.target.checked })));
    div.querySelectorAll(".sn-ws").forEach((el) => el.addEventListener("change", (e) => normEdit(el, { collapse_ws: e.target.checked })));
    // drop-words: preview live on every keystroke. It's one deferred edit like any other — the
    // worked example repaints per key, the view refetch waits for commit. (A separate `change`
    // listener would snapshot AFTER these keystrokes had already mutated the model, so Escape
    // could never put the original words back.)
    div.querySelectorAll(".sn-words").forEach((el) => {
        el.addEventListener("input", () => recompute(() => {
            model.setSourceStripWords(s.id, el.dataset.ds, el.value); previewNorm(el.dataset.ds);
        }));
    });
    fillNormSamples(div, s);   // sample each source's real join value, then render its example
    div.querySelectorAll(".sv-norm-eg").forEach((el) => el.addEventListener("click", () => cycleNormEg(el, s.id)));
    div.querySelector(".sv-latest")?.addEventListener("change", (e) => recompute(() => model.setSubsetLatestBatch(s.id, e.target.checked)));
    div.querySelector(".sv-limit")?.addEventListener("change", (e) => recompute(() => { model.setSubsetLimit(s.id, e.target.value); e.target.value = s.limit || 0; }));

    // pivot: toggling it changes which rows show (the name/value/key/attributes inputs), so
    // rebuild the node; editing its fields just recomputes the view.
    div.querySelector(".sv-pivot-on")?.addEventListener("change", (e) => restructure(() => model.setSubsetPivotEnabled(s.id, e.target.checked)));
    div.querySelector(".sv-pivot-namefield")?.addEventListener("change", (e) => recompute(() => model.setSubsetPivotField(s.id, "name_field", e.target.value.trim())));
    div.querySelector(".sv-pivot-valuefield")?.addEventListener("change", (e) => recompute(() => model.setSubsetPivotField(s.id, "value_field", e.target.value.trim())));
    div.querySelector(".sv-pivot-keycol")?.addEventListener("change", (e) => recompute(() => model.setSubsetPivotField(s.id, "key_column", e.target.value.trim())));
    div.querySelector(".sv-pivot-attrs")?.addEventListener("change", (e) => recompute(() => model.setSubsetPivotAttributes(s.id, e.target.value)));

    // filters
    div.querySelectorAll(".sf-del").forEach((b) => b.addEventListener("click", () => restructure(() => model.removeFilter(s.id, +b.dataset.i))));
    div.querySelectorAll(".sf-field").forEach((el) => el.addEventListener("change", (e) => restructure(() => { s.filters[+el.dataset.i].field = e.target.value; })));
    div.querySelectorAll(".sf-op").forEach((el) => el.addEventListener("change", (e) => restructure(() => { s.filters[+el.dataset.i].op = e.target.value; })));
    div.querySelectorAll(".sf-val").forEach((el) => onValueEdit(el, (e) => recompute(() => { s.filters[+el.dataset.i].value = e.target.value; })));

    // derived columns — editing a name changes the available column set, so restructure
    div.querySelectorAll(".sd-del").forEach((b) => b.addEventListener("click", () => restructure(() => model.removeDerived(s.id, +b.dataset.i))));
    div.querySelectorAll(".sd-name").forEach((el) => el.addEventListener("change", (e) => restructure(() => { s.derived[+el.dataset.i].name = e.target.value.trim(); })));
    div.querySelectorAll(".sd-tpl").forEach((el) => onValueEdit(el, (e) => recompute(() => { s.derived[+el.dataset.i].template = e.target.value; })));

    // sort — every mutation restructures (removal shifts indices; field/dir rebuild so the
    // picked option re-renders wrapped in < > like every other select)
    div.querySelectorAll(".ss-del").forEach((b) => b.addEventListener("click", () => restructure(() => model.removeSort(s.id, +b.dataset.i))));
    div.querySelectorAll(".ss-field").forEach((el) => el.addEventListener("change", (e) => restructure(() => { s.sort[+el.dataset.i].field = e.target.value; })));
    div.querySelectorAll(".ss-dir").forEach((el) => el.addEventListener("change", (e) => restructure(() => { s.sort[+el.dataset.i].desc = e.target.value === "desc"; })));

    // hide/show result columns — toggling changes the column set, so restructure
    wireHideToggles(div, s);
    // sort/limit removed — the table sorts itself (click a column header)

    queueMicrotask(() => refreshSubsetNode(s.id, _bootDetails?.subsets?.[s.id] || null));
}

export {
    subsetParts, refreshSubsetNode, refreshAllSubsetNodes, refreshDatasetConsumers,
    queueNodeRefresh, refreshChangedSubsetNodes, seedSubsetSig, wireSubset,
};
