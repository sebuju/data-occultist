// Dataset / subset / batches node bodies — the inline records VTable, observation +
// view-row drill-downs, and the per-node batches ledger (list + detail/preview).
// Extracted from main.js verbatim.
import * as api from "../../api.js";
import { h, frag } from "../../dom.js";
import { openModal } from "../../modal.js";
import { VTable } from "../../vtable.js";
import { singleFlight } from "../../singleflight.js";
import { nodeEls, setStatus, model } from "../state.js";
import { refreshLive, refreshDatasetConsumers, setNodeBusy } from "../main.js";
import { clockTime, vtShowRemoved, vtShowSpecial } from "../node_parts.js";

// Show the "show removed" header toggle only when the dataset actually has removed rows (the server
// reports `has_removed`; the removed rows themselves are filtered server-side per the toggle).
function syncShowRemovedToggle(ds, hasRemoved) {
    // `.vt-showrm` is the checkbox INSIDE the <label class="gn-slide-wrap" hidden> the initial
    // render creates (slideToggle's `hidden:true`) -- the `hidden` attribute that actually hides
    // the control sits on that wrapping label, not the checkbox, so it must be cleared there too.
    const tog = nodeEls.get(`vt:ds:${ds}`)?.querySelector(".vt-showrm");
    const wrap = tog?.closest(".gn-slide-wrap") || tog;
    if (wrap) wrap.hidden = !hasRemoved;
}

// ---- dataset records (rendered inline in the dataset node body) ----

function dataHost(ds) {
    const el = nodeEls.get(`vt:ds:${ds}`);   // records grid lives in the opt-in vt-table satellite
    return el && el.querySelector(".data-host");
}
// refresh every dataset whose vt-table satellite is currently shown (after save / clear / live change)
function refreshAllDataNodes() {
    for (const ds of model.datasets()) if (nodeEls.has(`vt:ds:${ds}`)) refreshDataNode(ds);
}
// One VTable per data/subset node host (virtualized + searchable). Recreated if the host
// element was rebuilt by a node re-render.
const vtables = new Map();
function vtableFor(key, host) {
    let vt = vtables.get(key);
    if (vt && vt.host === host) return vt;
    if (vt) vt.destroy();
    host.replaceChildren();
    vt = new VTable(host, key);
    vtables.set(key, vt);
    return vt;
}

// Not shown as columns. `_count` (how many observations fold into this record) STAYS visible:
// hiding it made a collapsed record look identical to a single read, so an aggregate silently
// picking one of several observations was invisible. It's the tell that a row is a fold — click
// the row to drill into the observations behind it.
const VT_META = ["present", "first_seen", "last_seen", "key"];

// Fold any open inline-detail row in VTables hosted by a node OTHER than `keepId`. Called when
// focus moves so an expanded row doesn't linger on a node you've unfocused.
function collapseVtablesExcept(keepId = null) {
    for (const [nid, el] of nodeEls) {
        if (nid === keepId) continue;
        for (const vt of vtables.values()) if (vt.expandedRow && el.contains(vt.host)) vt.collapse();
    }
}

// A `<p class="muted">` message node (error / empty / loading). `pad` adds the 8px inset some
// hosts want. The ONE muted-message factory so these never drift.
const mutedP = (msg, pad = false) => h("p", { class: "muted", style: pad ? "padding:8px" : null }, msg);

// A read-only data table: <table class="grid-table zebra ...">. `cols` = header cells; each
// `rows` entry is rendered as one <tr> of <td> cells via `cell(row, col)` (defaults to the
// value at that column, "" for null). `extra` appends to the class list.
function dataTable(cols, rows, extra = "vt-detail-tbl", cell = (r, c) => (r[c] == null ? "" : String(r[c]))) {
    return h("table", { class: `grid-table zebra ${extra}` },
        h("thead", h("tr", cols.map((c) => h("th", String(c))))),
        h("tbody", rows.map((r) => h("tr", cols.map((c) => h("td", cell(r, c)))))));
}

// Show a count badge on the vt-table satellite's tab (data → item count, batches → batch count).
// The tabs + badges live ABOVE the table on the satellite now.
function setTabCount(ds, sel, n) {
    const el = nodeEls.get(`vt:ds:${ds}`)?.querySelector(sel);
    if (el) el.textContent = n != null ? `${n}` : "";
}

// How many batches the ledger actually holds. The server ships `batch_total` (a real
// COUNT(DISTINCT batch)) alongside a list capped at the newest BATCH_PREVIEW, so the list length
// is NOT the count — it saturates at the cap. Falls back to the list only for a payload that
// predates the field. Counts every batch, reverted included, so this agrees with the db panel,
// the compact button, and the retention window's own cutoff.
const batchTotal = (payload, batches) =>
    (typeof payload?.batch_total === "number" ? payload.batch_total : batches.length);

// Single-flight key shared by refreshDataNode + refreshDatasetNode: they hit the same endpoint
// and write the same node host, so they must not race; a call arriving mid-fetch re-runs once
// after (the LATEST request wins) — never dropped, so the final write of a live sweep lands.
const _dnKey = (ds) => `dn:${ds}`;

// The window-fetch closure for a dataset's records table. Reads the show-removed + show-special
// toggles live, so a toggle flip + refreshWindow() re-queries with/without soft-deleted rows /
// bookkeeping columns. Server does q/sort/slice.
function _dataFetch(ds) {
    const game = model.profile.name;
    return (o) => api.datasetPage(game, ds, { ...o, removed: !!vtShowRemoved.get(ds), special: !!vtShowSpecial.get(ds) });
}
// Paint the dataset records table as a server-backed VTable: seed it on first mount (from the boot
// window `pre`, or a fetched first window), else just refetch its current window. Returns the vt.
async function _paintDataTable(ds, host, pre, superseded) {
    const vt = vtableFor(`ds:${ds}`, host);
    const fetchWindow = _dataFetch(ds);
    if (vt.server) {                                   // already server-backed -> refetch the window in place
        await vt.refreshWindow();
        if (!superseded?.()) setTabCount(ds, ".data-n", vt.serverTotal);
        return vt;
    }
    const seed = pre
        ? { columns: pre.columns || [], rows: pre.rows || [], total: pre.total || 0 }
        : await fetchWindow({ offset: 0, limit: 120 });
    if (superseded?.()) return vt;
    syncShowRemovedToggle(ds, pre ? pre.has_removed : seed.has_removed);
    vt.setServerSource(seed, fetchWindow, {
        rowClass: (row) => (row.present === false ? "gone" : ""),
        expander: (row) => expandObservations(ds, row),   // drill into a record's observations inline
    });
    setTabCount(ds, ".data-n", seed.total);
    return vt;
}

// Returns the singleFlight promise — callers that show a "refreshing" state (queueNodeRefresh's
// header spinner) must await the PAINT, not just the fetch that fed it.
function refreshDataNode(ds, pre = null) { return singleFlight(_dnKey(ds), (ctx) => _refreshDataNode(ds, pre, ctx)); }
async function _refreshDataNode(ds, pre, { superseded } = {}) {
    const host = dataHost(ds);
    if (!host) return;
    setNodeBusy(`vt:ds:${ds}`, true);   // spin the records-grid satellite while it recomputes
    try {
        // a newer request is already queued behind us — its result supersedes ours; skip the
        // paint and let the trailing rerun (singleflight.js) write the fresh one instead.
        if (superseded?.()) return;
        const vt = await _paintDataTable(ds, host, pre, superseded);
        // the boot window carries the ledger; use it for the search-bar batch tally (live refreshes
        // update it through loadBatchesNode instead — the records path no longer ships batches).
        if (pre && pre.batches) vt.setBatchCount(batchTotal(pre, pre.batches));
    } catch (e) {
        if (superseded?.()) return;
        vtables.delete(`ds:${ds}`); host.replaceChildren(mutedP(String(e), true));
    }
    finally { setNodeBusy(`vt:ds:${ds}`, false); }
}

// Inline drill-down: a dataset record aggregates "many" observations under its key — fetch
// them and return a detail node the VTable parks under the clicked row.
async function expandObservations(ds, row) {
    const node = document.createElement("div");
    node.className = "vt-detail-inner";
    const key = row && row.key;
    if (!key) { node.replaceChildren(mutedP("no key")); return node; }
    try {
        const r = await fetch(`/api/flow/${encodeURIComponent(model.profile.name)}/dataset/${encodeURIComponent(ds)}/observations?key=${encodeURIComponent(key)}`);
        const obs = (await r.json()).observations || [];
        const cols = [...new Set(obs.flatMap((o) => Object.keys(o)))];
        node.replaceChildren(
            h("div", { class: "vt-detail-lbl" }, `${obs.length} observation${obs.length === 1 ? "" : "s"} · ${key}`),
            dataTable(cols, obs));
    } catch (e) { node.replaceChildren(mutedP(String(e.message || e))); }
    return node;
}

// One source block in a view-row drill-down: a labelled table of `rows`. Returns a DocumentFragment
// (header + table). Columns = union of keys minus the store's bookkeeping fields.
function srcBlock(label, rows) {
    if (!rows.length) return h("div", { class: "vt-src-h muted" }, `${label} — no rows`);
    const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((c) => !VT_META.includes(c));
    return frag(h("div", { class: "vt-src-h" }, label), dataTable(cols, rows));
}

// Inline drill-down for a VIEW row: per joined input, the RAW observations (the 'many' that
// the view's aggregate collapsed) behind this row's join key — so you see the actual multiple
// values, not the one aggregated record. A dataset source drills its observations; a view
// source has none, so it shows its matching computed row(s).
async function expandSubsetRow(sid, row) {
    const node = document.createElement("div");
    node.className = "vt-detail-inner";
    const s = model.subsetDef(sid);
    const inputs = model.subsetInputs(s);
    const game = encodeURIComponent(model.profile.name);
    const blocks = await Promise.all(inputs.map(async (inp) => {
        const isView = !!model.subsetDef(inp);
        // each source joins on its OWN field — match this input's rows against the view row by it
        const jf = (model.subsetSource(sid, inp) || {}).join_field || "name";
        const jv = String(row[jf] ?? "").trim().toLowerCase();
        const matchJv = (r) => String(r[jf] ?? "").trim().toLowerCase() === jv;
        if (!jv) return h("div", { class: "vt-src-h muted" }, `${inp} — no ${jf} value to trace`);
        try {
            if (isView) {   // views have no observations — show the matching computed row(s)
                const data = await (await fetch(`/api/flow/${game}/subset/${encodeURIComponent(inp)}`)).json();
                return srcBlock(`${inp} (view)`, (data.rows || []).filter(matchJv));
            }
            // dataset: find the matching record(s), then drill each one's observations (the 'many')
            const data = await (await fetch(`/api/flow/${game}/dataset/${encodeURIComponent(inp)}`)).json();
            const match = (data.records || []).filter(matchJv);
            if (!match.length) return h("div", { class: "vt-src-h muted" }, `${inp} — no matching record`);
            const obs = [];
            for (const rec of match) {
                if (rec.key == null) continue;
                const od = await (await fetch(`/api/flow/${game}/dataset/${encodeURIComponent(inp)}/observations?key=${encodeURIComponent(rec.key)}`)).json();
                obs.push(...(od.observations || []));
            }
            const seen = obs.length ? obs : match;   // fall back to the record itself if it has no key
            return srcBlock(`${inp} · ${obs.length} observation${obs.length === 1 ? "" : "s"}`, seen);
        } catch (e) { return h("div", { class: "vt-src-h muted" }, `${inp} — ${String(e.message || e)}`); }
    }));
    node.replaceChildren(...(blocks.length ? blocks : [mutedP("no sources")]));
    return node;
}

// A dataset record aggregates "many" observations under its key — open them in a modal.
// (kept as an alternative to the inline drill-down above; not currently wired)
async function showRecordMany(ds, key, count) {
    if (!key) return;
    const node = document.createElement("div");
    node.className = "vt-modal-host";
    openModal({ title: `${ds}: ${key}${count ? ` · ${count} observations` : ""}`, size: "data", node });
    try {
        const r = await fetch(`/api/flow/${encodeURIComponent(model.profile.name)}/dataset/${encodeURIComponent(ds)}/observations?key=${encodeURIComponent(key)}`);
        const obs = (await r.json()).observations || [];
        const cols = [...new Set(obs.flatMap((o) => Object.keys(o)))];
        new VTable(node).setData(cols, obs);
    } catch (e) { node.replaceChildren(mutedP(String(e), true)); }
}

// ---- batches node (ledger + per-batch contents/preview, embedded in the node) ----

const batchesState = new Map();   // ds -> { sel, events } (selection + event cache per node)

function batEls(ds) {
    const el = nodeEls.get(`vt:ds:${ds}`);   // batches host lives in the vt-table satellite's batches tab
    return el && { list: el.querySelector(".bat-list"), detail: el.querySelector(".bat-detail") };
}
function batState(ds) {
    if (!batchesState.has(ds)) batchesState.set(ds, { sel: null, events: {} });
    return batchesState.get(ds);
}

// (re)fetch the ledger and paint it into the node body — called on build and whenever
// the dataset's batches change (save / revert / edit / remove). No refresh button.
async function loadBatchesNode(ds, pre = null) {
    const els = batEls(ds);
    if (!els) return;
    setNodeBusy(`vt:ds:${ds}`, true);   // same host id as the records grid — refcounted, so an overlapping data refresh is unaffected
    try {
        // pre (boot window) carries the ledger; live loads hit the lightweight batches endpoint
        // (no record dump — records now stream through /page).
        const src = pre || await api.datasetBatches(model.profile.name, ds);
        const batches = src.batches || [];
        renderBatchesList(ds, batches);
        // Count from batch_total (a real COUNT(DISTINCT batch)), NOT from this list — the list is
        // capped at the newest BATCH_PREVIEW, so its length silently saturates (a 198-batch dataset
        // read 80 here while the db panel read 198).
        setTabCount(ds, ".bat-n", batchTotal(src, batches));
    } catch (e) { els.list.replaceChildren(h("li", { class: "muted" }, String(e))); }
    finally { setNodeBusy(`vt:ds:${ds}`, false); }
}

// refresh every batches host that currently exists (i.e. whose vt-table satellite is shown)
function refreshAllBatchesNodes() {
    for (const ds of model.datasets()) if (nodeEls.has(`vt:ds:${ds}`)) loadBatchesNode(ds);
}

// Per-batch display string for the .batmeta line ("+2 ~1 −3 · 7 · a, b, c …").
function batMeta(b) {
    const parts = [b.adds ? `+${b.adds}` : "", b.updates ? `~${b.updates}` : "", b.removes ? `−${b.removes}` : ""].filter(Boolean).join(" ");
    const keys = (b.keys || []).slice(0, 4).join(", ") + (b.count > 4 ? " …" : "");
    return `${parts} · ${b.count} · ${keys}`;
}

// Build one <li class="batrow"> ONCE, wiring its row/checkbox/remove handlers at build time
// (so the reconcile never re-binds). Returned alongside the mutable refs the reconcile updates.
function buildBatchRow(ds, b) {
    const st = batState(ds);
    const time = h("span", { class: "muted" }, clockTime(b.ts));
    const num = h("b", `#${b.batch}`);
    const meta = h("span", { class: "muted batmeta", title: batMeta(b) }, batMeta(b));
    const toggle = h("input", {
        type: "checkbox", class: "led-toggle", dataset: { batch: b.batch }, checked: !b.reverted,
        onChange: async () => {
            toggle.disabled = true;
            try {
                await api.revertDatasetBatch(model.profile.name, ds, +toggle.dataset.batch, !toggle.checked);
                refreshLive(); refreshDataNode(ds); loadBatchesNode(ds); refreshDatasetConsumers(ds);   // views reading ds are stale (a revert doesn't bump last_ts)
            } catch (e) { toggle.disabled = false; toggle.checked = !toggle.checked; setStatus(String(e.message || e)); }
        },
    });
    const app = h("label", { class: "led-apply", title: "apply this batch to the dataset (uncheck to revert it)" }, toggle, " applied");
    const rm = h("button", {
        class: "led-remove danger", dataset: { batch: b.batch }, title: "permanently delete this batch from the ledger",
        onClick: async () => {
            if (rm.dataset.armed !== "1") { rm.dataset.armed = "1"; rm.textContent = "sure?"; setTimeout(() => { rm.dataset.armed = "0"; rm.textContent = "remove"; }, 2500); return; }
            rm.disabled = true; rm.classList.add("reading");   // spinner while the ledger deletes + nodes refresh
            try {
                if (st.sel === +rm.dataset.batch) { st.sel = null; batEls(ds)?.detail.replaceChildren(); }
                await api.removeDatasetBatch(model.profile.name, ds, +rm.dataset.batch);
                refreshLive(); refreshDataNode(ds); loadBatchesNode(ds); refreshDatasetConsumers(ds);   // views reading ds are stale (loadBatchesNode re-renders this list — button gone)
            } catch (e) { rm.disabled = false; rm.classList.remove("reading"); setStatus(String(e.message || e)); }
        },
    }, "remove");
    const li = h("li", {
        class: `batrow ${b.reverted ? "reverted" : ""}${st.sel === b.batch ? " sel" : ""}`, dataset: { batch: b.batch },
        // toggle detail on row click (but not when hitting the checkbox/remove): a second click on
        // the open row closes its detail.
        onClick: (ev) => {
            if (ev.target.closest(".led-apply,.led-remove")) return;
            const cur = batEls(ds); if (!cur) return;
            const bn = +li.dataset.batch;
            if (st.sel === bn) {
                st.sel = null;
                li.classList.remove("sel");
                const r = cur.list._rows?.get(bn); if (r) r.sel = false;   // keep keyed cache in sync (next reconcile won't re-toggle)
                cur.detail.replaceChildren(mutedP("select a batch to see its events and what applying it changes"));
            } else selectBatch(ds, bn);
        },
    }, time, " ", num, " ", meta, " ", app, " ", rm);
    return { li, meta, toggle, reverted: b.reverted, sel: st.sel === b.batch };
}

// In-place keyed reconcile (CLAUDE.md rule 1; canonical: renderActivity in activity.js). Steady
// state mutates the DOM zero times. Rows live in `els.list._rows` (Map<batch, {li, meta, toggle,…}>).
function renderBatchesList(ds, batches) {
    const els = batEls(ds);
    if (!els) return;
    const st = batState(ds);
    const list = els.list;
    els.list.parentElement?.classList.toggle("bat-empty", !batches.length);   // drop the box framing when empty
    if (!list._rows) list._rows = new Map();
    const rows = list._rows;
    if (!batches.length) {
        rows.clear();
        list.replaceChildren(h("li", { class: "muted" }, "no batches yet"));
        list._empty = true;
        els.detail.replaceChildren(); st.sel = null; return;
    }
    if (list._empty) { list.replaceChildren(); list._empty = false; }   // clear the placeholder once
    const want = new Set(batches.map((b) => b.batch));
    for (const [k, r] of rows) if (!want.has(k)) { r.li.remove(); rows.delete(k); }
    // drop any stray placeholder (the node_parts "loading…" template li, or a prior "no
    // batches yet") — it's not a tracked batrow, so the reconcile loop never removes it and
    // rows insertBefore it, leaving it stranded. Steady state finds none -> zero mutations.
    for (const c of [...list.children]) if (!c.classList.contains("batrow")) c.remove();
    let i = 0;
    for (const b of batches) {
        let r = rows.get(b.batch);
        if (!r) { r = buildBatchRow(ds, b); rows.set(b.batch, r); }
        // place at slot i ONLY if it isn't already there — no needless detach/reattach.
        const at = list.children[i];
        if (at !== r.li) list.insertBefore(r.li, at || null);
        i++;
        // update changed text + classes ONLY when changed.
        const meta = batMeta(b);
        if (r.meta.textContent !== meta) { r.meta.textContent = meta; r.meta.title = meta; }
        if (r.toggle.disabled) r.toggle.disabled = false;   // authoritative refetch clears a mid-flight toggle's busy state
        if (r.reverted !== b.reverted) { r.li.classList.toggle("reverted", b.reverted); r.toggle.checked = !b.reverted; r.reverted = b.reverted; }
        const sel = st.sel === b.batch;
        if (r.sel !== sel) { r.li.classList.toggle("sel", sel); r.sel = sel; }
    }
    if (st.sel != null && batches.some((b) => b.batch === st.sel)) selectBatch(ds, st.sel, { refresh: true });
    else if (st.sel != null) { st.sel = null; els.detail.replaceChildren(); }
}

// `refresh` = the selection didn't change, we're just re-pulling the detail because the ledger
// moved (line-300 reconcile). In that case DON'T flash "loading…" over the panel that's already
// shown, and DON'T fight a selection the user changed while the fetch was in flight.
async function selectBatch(ds, batch, { refresh = false } = {}) {
    const els = batEls(ds);
    if (!els) return;
    const st = batState(ds);
    st.sel = batch;
    els.list.querySelectorAll(".batrow").forEach((li) => li.classList.toggle("sel", +li.dataset.batch === batch));
    // keep the keyed-row cache in sync so the next reconcile doesn't re-toggle `sel`.
    if (els.list._rows) for (const [k, r] of els.list._rows) r.sel = (k === batch);
    if (!refresh) els.detail.replaceChildren(mutedP("loading…"));   // fresh open only — a refresh keeps the old detail until the new one lands
    try {
        const bd = await api.batchDetail(model.profile.name, ds, batch);
        if (st.sel !== batch) return;   // selection changed/cleared while awaiting — drop this stale result
        renderBatchDetail(ds, bd);
    } catch (e) { if (st.sel === batch) els.detail.replaceChildren(mutedP(String(e))); }
}

function renderBatchDetail(ds, bd) {
    const els = batEls(ds);
    if (!els) return;
    const events = bd.events || [];
    const preview = bd.preview || [];

    // preview — what applying this batch changes in the dataset (read-only diff table)
    const pvRow = (p) => {
        if (p.kind === "add") return h("tr", { class: "pv-add" }, h("td", "add"), h("td", p.key), h("td", fmtVals(p.after)));
        if (p.kind === "remove") return h("tr", { class: "pv-remove" }, h("td", "remove"), h("td", p.key), h("td", fmtVals(p.before)));
        const diff = Object.entries(p.changed || {}).map(([f, [o, nv]]) => `${f}: ${o ?? "∅"} → ${nv ?? "∅"}`).join("; ");
        return h("tr", { class: "pv-update" }, h("td", "update"), h("td", p.key), h("td", diff));
    };
    const pvTable = preview.length
        ? h("table", { class: "grid-table zebra pv-table" },
            h("thead", h("tr", h("th", "change"), h("th", "key"), h("th", "detail"))),
            h("tbody", preview.map(pvRow)))
        : mutedP("applying this batch changes nothing");

    // event contents — read-only VTable (search/sort/resize), no editing
    const evHost = h("div", { class: "bat-ev-host" });
    els.detail.replaceChildren(
        h("h4", { class: "ds-h" }, `Batch #${bd.batch} · ${events.length} events`),
        evHost,
        h("h4", { class: "ds-h" }, "Applying this batch would…"),
        pvTable);
    if (!events.length) { evHost.replaceChildren(mutedP("no events", true)); return; }
    const cols = ["id", "op", ...new Set(events.flatMap((e) => Object.keys(e.values || {})))];
    const rows = events.map((e) => ({ id: e.id, op: e.op, reverted: e.reverted, ...(e.values || {}) }));
    vtableFor(`bat:${ds}`, evHost).setData(cols, rows, { rowClass: (row) => (row.reverted ? "reverted" : "") });
}

function fmtVals(v) {
    if (!v) return "";
    return Object.entries(v).map(([k, val]) => `${k}=${val}`).join(", ");
}

// ONE fetch updates BOTH a dataset node's data tab and its batches tab — they share the same
// endpoint, so on a live change refresh both from a single request instead of two.
function refreshDatasetNode(ds) { singleFlight(_dnKey(ds), (ctx) => _refreshDatasetNode(ds, ctx)); }
async function _refreshDatasetNode(ds, { superseded } = {}) {
    const host = dataHost(ds), els = batEls(ds);
    if (!host && !els) return;
    setNodeBusy(`vt:ds:${ds}`, true);   // spin the records-grid satellite while it recomputes
    try {
        if (superseded?.()) return;
        if (host) await _paintDataTable(ds, host, null, superseded);   // records via /page (live -> refetch window)
        if (els || host) {
            const src = await api.datasetBatches(model.profile.name, ds);
            const batches = src.batches || [];
            if (superseded?.()) return;
            const batchN = batchTotal(src, batches);   // true ledger count, not the capped list length
            if (els) { renderBatchesList(ds, batches); setTabCount(ds, ".bat-n", batchN); }
            if (host) vtableFor(`ds:${ds}`, host).setBatchCount(batchN);   // keep the records table's tally live too
        }
    } catch (e) { if (host && !superseded?.()) { vtables.delete(`ds:${ds}`); host.replaceChildren(mutedP(String(e), true)); } }
    finally { setNodeBusy(`vt:ds:${ds}`, false); }
}

export {
    dataHost, vtables, vtableFor, collapseVtablesExcept, VT_META, setTabCount, refreshDataNode, refreshDatasetNode,
    refreshAllDataNodes, expandObservations, srcBlock, expandSubsetRow, showRecordMany,
    batchesState, batEls, batState, loadBatchesNode, refreshAllBatchesNodes,
    renderBatchesList, selectBatch, renderBatchDetail, fmtVals,
};
