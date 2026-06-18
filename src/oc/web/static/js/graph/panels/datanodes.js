// Dataset / subset / batches node bodies — the inline records VTable, observation +
// view-row drill-downs, and the per-node batches ledger (list + detail/preview).
// Extracted from main.js verbatim.
import * as api from "../../api.js";
import { esc } from "../../dom.js";
import { openModal } from "../../modal.js";
import { VTable } from "../../vtable.js";
import { singleFlight } from "../../singleflight.js";
import { nodeEls, setStatus, model } from "../state.js";
import { refreshLive, clockTime, refreshDatasetConsumers } from "../main.js";

// ---- dataset records (rendered inline in the dataset node body) ----

function dataHost(ds) {
  const el = nodeEls.get(`ds:${ds}`);
  return el && el.querySelector(".data-host");
}
// refresh every dataset node that currently exists (after save / clear / live change)
function refreshAllDataNodes() {
  for (const ds of model.datasets()) if (nodeEls.has(`ds:${ds}`)) refreshDataNode(ds);
}
// One VTable per data/subset node host (virtualized + searchable). Recreated if the host
// element was rebuilt by a node re-render.
const vtables = new Map();
function vtableFor(key, host) {
  let vt = vtables.get(key);
  if (vt && vt.host === host) return vt;
  if (vt) vt.destroy();
  host.innerHTML = "";
  vt = new VTable(host, key);
  vtables.set(key, vt);
  return vt;
}

const VT_META = ["present", "first_seen", "last_seen", "key", "_count"];   // not shown as columns

// Show a count badge on a dataset node's tab (data → item count, batches → batch count).
function setTabCount(ds, sel, n) {
  const el = nodeEls.get(`ds:${ds}`)?.querySelector(sel);
  if (el) el.textContent = n != null ? `${n}` : "";
}

// Single-flight key shared by refreshDataNode + refreshDatasetNode: they hit the same endpoint
// and write the same node host, so they must not race; a call arriving mid-fetch re-runs once
// after (the LATEST request wins) — never dropped, so the final write of a live sweep lands.
const _dnKey = (ds) => `dn:${ds}`;

function refreshDataNode(ds) { singleFlight(_dnKey(ds), () => _refreshDataNode(ds)); }
async function _refreshDataNode(ds) {
  const host = dataHost(ds);
  if (!host) return;
  try {
    const r = await fetch(`/api/flow/${encodeURIComponent(model.profile.name)}/dataset/${encodeURIComponent(ds)}`, { cache: "no-store" });
    const payload = await r.json();
    const recs = payload.records || [];
    const batchN = (payload.batches || []).filter((b) => !b.reverted).length;   // applied batches (matches the bat-n badge)
    const cols = [...new Set(recs.flatMap((rec) => Object.keys(rec)))].filter((c) => !VT_META.includes(c));
    const vt = vtableFor(`ds:${ds}`, host);
    vt.setData(cols, recs, {
      rowClass: (row) => (row.present ? "" : "gone"),
      expander: (row) => expandObservations(ds, row),   // drill into its observations inline
    });
    vt.setBatchCount(batchN);                   // line + batch tally in the table's search bar
    setTabCount(ds, ".data-n", recs.length);   // item count on the data tab
  } catch (e) { vtables.delete(`ds:${ds}`); host.innerHTML = `<p class="muted" style="padding:8px">${esc(String(e))}</p>`; }
}

// Inline drill-down: a dataset record aggregates "many" observations under its key — fetch
// them and return a detail node the VTable parks under the clicked row.
async function expandObservations(ds, row) {
  const node = document.createElement("div");
  node.className = "vt-detail-inner";
  const key = row && row.key;
  if (!key) { node.innerHTML = `<p class="muted">no key</p>`; return node; }
  try {
    const r = await fetch(`/api/flow/${encodeURIComponent(model.profile.name)}/dataset/${encodeURIComponent(ds)}/observations?key=${encodeURIComponent(key)}`);
    const obs = (await r.json()).observations || [];
    const cols = [...new Set(obs.flatMap((o) => Object.keys(o)))];
    const head = cols.map((c) => `<th>${esc(c)}</th>`).join("");
    const rows = obs.map((o) => `<tr>${cols.map((c) => `<td>${esc(o[c] == null ? "" : String(o[c]))}</td>`).join("")}</tr>`).join("");
    node.innerHTML = `<div class="vt-detail-lbl">${obs.length} observation${obs.length === 1 ? "" : "s"} · ${esc(key)}</div>
      <table class="grid-table zebra vt-detail-tbl"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
  } catch (e) { node.innerHTML = `<p class="muted">${esc(String(e.message || e))}</p>`; }
  return node;
}

// One source block in a view-row drill-down: a labelled table of `rows` (label is already
// escaped). Columns = union of keys minus the store's bookkeeping fields.
function srcBlock(label, rows) {
  if (!rows.length) return `<div class="vt-src-h muted">${label} — no rows</div>`;
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((c) => !VT_META.includes(c));
  const head = cols.map((c) => `<th>${esc(c)}</th>`).join("");
  const body = rows.map((r) => `<tr>${cols.map((c) => `<td>${esc(r[c] == null ? "" : String(r[c]))}</td>`).join("")}</tr>`).join("");
  return `<div class="vt-src-h">${label}</div>
    <table class="grid-table zebra vt-detail-tbl"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

// Inline drill-down for a VIEW row: per joined input, the RAW observations (the 'many' that
// the view's aggregate collapsed) behind this row's join key — so you see the actual multiple
// values, not the one aggregated record. A dataset source drills its observations; a view
// source has none, so it shows its matching computed row(s).
async function expandSubsetRow(sid, row) {
  const node = document.createElement("div");
  node.className = "vt-detail-inner";
  const s = model.subsetDef(sid);
  const jf = (s && s.join_field) || "name";
  const jv = String(row[jf] ?? "").trim().toLowerCase();
  if (!jv) { node.innerHTML = `<p class="muted">no <code>${esc(jf)}</code> value to trace</p>`; return node; }
  const inputs = model.subsetInputs(s);
  const game = encodeURIComponent(model.profile.name);
  const matchJv = (r) => String(r[jf] ?? "").trim().toLowerCase() === jv;
  const blocks = await Promise.all(inputs.map(async (inp) => {
    const isView = !!model.subsetDef(inp);
    try {
      if (isView) {   // views have no observations — show the matching computed row(s)
        const data = await (await fetch(`/api/flow/${game}/subset/${encodeURIComponent(inp)}`)).json();
        return srcBlock(`${esc(inp)} (view)`, (data.rows || []).filter(matchJv));
      }
      // dataset: find the matching record(s), then drill each one's observations (the 'many')
      const data = await (await fetch(`/api/flow/${game}/dataset/${encodeURIComponent(inp)}`)).json();
      const match = (data.records || []).filter(matchJv);
      if (!match.length) return `<div class="vt-src-h muted">${esc(inp)} — no matching record</div>`;
      const obs = [];
      for (const rec of match) {
        if (rec.key == null) continue;
        const od = await (await fetch(`/api/flow/${game}/dataset/${encodeURIComponent(inp)}/observations?key=${encodeURIComponent(rec.key)}`)).json();
        obs.push(...(od.observations || []));
      }
      const seen = obs.length ? obs : match;   // fall back to the record itself if it has no key
      return srcBlock(`${esc(inp)} · ${obs.length} observation${obs.length === 1 ? "" : "s"}`, seen);
    } catch (e) { return `<div class="vt-src-h muted">${esc(inp)} — ${esc(String(e.message || e))}</div>`; }
  }));
  node.innerHTML = blocks.join("") || `<p class="muted">no sources</p>`;
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
  } catch (e) { node.innerHTML = `<p class="muted" style="padding:8px">${esc(String(e))}</p>`; }
}

// ---- batches node (ledger + per-batch contents/preview, embedded in the node) ----

const batchesState = new Map();   // ds -> { sel, events } (selection + event cache per node)

function batEls(ds) {
  const el = nodeEls.get(`ds:${ds}`);   // batches live in the merged dataset node's history tab
  return el && { list: el.querySelector(".bat-list"), detail: el.querySelector(".bat-detail") };
}
function batState(ds) {
  if (!batchesState.has(ds)) batchesState.set(ds, { sel: null, events: {} });
  return batchesState.get(ds);
}

// (re)fetch the ledger and paint it into the node body — called on build and whenever
// the dataset's batches change (save / revert / edit / remove). No refresh button.
async function loadBatchesNode(ds) {
  const els = batEls(ds);
  if (!els) return;
  try {
    const r = await fetch(`/api/flow/${encodeURIComponent(model.profile.name)}/dataset/${encodeURIComponent(ds)}`);
    const batches = (await r.json()).batches || [];
    renderBatchesList(ds, batches);
    setTabCount(ds, ".bat-n", batches.filter((b) => !b.reverted).length);   // applied batch count (reverted/unapplied excluded)
  } catch (e) { els.list.innerHTML = `<li class="muted">${esc(String(e))}</li>`; }
}

// refresh every batches node that currently exists
function refreshAllBatchesNodes() {
  for (const ds of model.datasets()) if (nodeEls.has(`ds:${ds}`)) loadBatchesNode(ds);
}

function renderBatchesList(ds, batches) {
  const els = batEls(ds);
  if (!els) return;
  const st = batState(ds);
  els.list.parentElement?.classList.toggle("bat-empty", !batches.length);   // drop the box framing when empty
  if (!batches.length) { els.list.innerHTML = '<li class="muted">no batches yet</li>'; els.detail.innerHTML = ""; st.sel = null; return; }
  els.list.innerHTML = batches.map((b) => {
    const parts = [b.adds ? `+${b.adds}` : "", b.updates ? `~${b.updates}` : "", b.removes ? `−${b.removes}` : ""].filter(Boolean).join(" ");
    const keys = (b.keys || []).slice(0, 4).join(", ") + (b.count > 4 ? " …" : "");
    const app = `<label class="led-apply" title="apply this batch to the dataset (uncheck to revert it)"><input type="checkbox" class="led-toggle" data-batch="${b.batch}"${b.reverted ? "" : " checked"}> applied</label>`;
    const rm = `<button class="led-remove danger" data-batch="${b.batch}" title="permanently delete this batch from the ledger">remove</button>`;
    return `<li class="batrow ${b.reverted ? "reverted" : ""}${st.sel === b.batch ? " sel" : ""}" data-batch="${b.batch}">
      <span class="muted">${esc(clockTime(b.ts))}</span> <b>#${b.batch}</b>
      <span class="muted batmeta" title="${parts} · ${b.count} · ${esc(keys)}">${parts} · ${b.count} · ${esc(keys)}</span> ${app} ${rm}</li>`;
  }).join("");
  // toggle detail on row click (but not when hitting the checkbox/remove): a second click on
  // the open row closes its detail.
  els.list.querySelectorAll(".batrow").forEach((li) => li.addEventListener("click", (ev) => {
    if (ev.target.closest(".led-apply,.led-remove")) return;
    const b = +li.dataset.batch;
    if (st.sel === b) { st.sel = null; els.detail.innerHTML = ""; li.classList.remove("sel"); }
    else selectBatch(ds, b);
  }));
  els.list.querySelectorAll(".led-toggle").forEach((cb) => cb.addEventListener("change", async () => {
    cb.disabled = true;
    try {
      await api.revertDatasetBatch(model.profile.name, ds, +cb.dataset.batch, !cb.checked);
      refreshLive(); refreshDataNode(ds); loadBatchesNode(ds); refreshDatasetConsumers(ds);   // views reading ds are stale (a revert doesn't bump last_ts)
    } catch (e) { cb.disabled = false; cb.checked = !cb.checked; setStatus(String(e.message || e)); }
  }));
  els.list.querySelectorAll(".led-remove").forEach((b) => b.addEventListener("click", async () => {
    if (b.dataset.armed !== "1") { b.dataset.armed = "1"; b.textContent = "sure?"; setTimeout(() => { b.dataset.armed = "0"; b.textContent = "remove"; }, 2500); return; }
    b.disabled = true; b.classList.add("reading");   // spinner while the ledger deletes + nodes refresh
    try {
      if (st.sel === +b.dataset.batch) { st.sel = null; els.detail.innerHTML = ""; }
      await api.removeDatasetBatch(model.profile.name, ds, +b.dataset.batch);
      refreshLive(); refreshDataNode(ds); loadBatchesNode(ds); refreshDatasetConsumers(ds);   // views reading ds are stale (loadBatchesNode re-renders this list — button gone)
    } catch (e) { b.disabled = false; b.classList.remove("reading"); setStatus(String(e.message || e)); }
  }));
  if (st.sel != null && batches.some((b) => b.batch === st.sel)) selectBatch(ds, st.sel);
  else if (st.sel != null) { st.sel = null; els.detail.innerHTML = ""; }
}

async function selectBatch(ds, batch) {
  const els = batEls(ds);
  if (!els) return;
  const st = batState(ds);
  st.sel = batch;
  els.list.querySelectorAll(".batrow").forEach((li) => li.classList.toggle("sel", +li.dataset.batch === batch));
  els.detail.innerHTML = '<p class="muted">loading…</p>';
  try {
    renderBatchDetail(ds, await api.batchDetail(model.profile.name, ds, batch));
  } catch (e) { els.detail.innerHTML = `<p class="muted">${esc(String(e))}</p>`; }
}

function renderBatchDetail(ds, bd) {
  const els = batEls(ds);
  if (!els) return;
  const events = bd.events || [];
  const preview = bd.preview || [];

  // preview — what applying this batch changes in the dataset (read-only diff table)
  const pvRows = preview.map((p) => {
    if (p.kind === "add") return `<tr class="pv-add"><td>add</td><td>${esc(p.key)}</td><td>${esc(fmtVals(p.after))}</td></tr>`;
    if (p.kind === "remove") return `<tr class="pv-remove"><td>remove</td><td>${esc(p.key)}</td><td>${esc(fmtVals(p.before))}</td></tr>`;
    const diff = Object.entries(p.changed || {}).map(([f, [o, nv]]) => `${esc(f)}: ${esc(o ?? "∅")} → ${esc(nv ?? "∅")}`).join("; ");
    return `<tr class="pv-update"><td>update</td><td>${esc(p.key)}</td><td>${diff}</td></tr>`;
  }).join("");
  const pvTable = preview.length
    ? `<table class="grid-table zebra pv-table"><thead><tr><th>change</th><th>key</th><th>detail</th></tr></thead><tbody>${pvRows}</tbody></table>`
    : '<p class="muted">applying this batch changes nothing</p>';

  // event contents — read-only VTable (search/sort/resize), no editing
  els.detail.innerHTML = `<h4 class="ds-h">Batch #${bd.batch} · ${events.length} events</h4>
    <div class="bat-ev-host"></div>
    <h4 class="ds-h">Applying this batch would…</h4>${pvTable}`;
  const evHost = els.detail.querySelector(".bat-ev-host");
  if (!events.length) { evHost.innerHTML = '<p class="muted" style="padding:8px">no events</p>'; return; }
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
function refreshDatasetNode(ds) { singleFlight(_dnKey(ds), () => _refreshDatasetNode(ds)); }
async function _refreshDatasetNode(ds) {
  const host = dataHost(ds), els = batEls(ds);
  if (!host && !els) return;
  try {
    const r = await fetch(`/api/flow/${encodeURIComponent(model.profile.name)}/dataset/${encodeURIComponent(ds)}`, { cache: "no-store" });
    const j = await r.json();
    const batches = j.batches || [];
    const batchN = batches.filter((b) => !b.reverted).length;   // applied batches
    if (host) {
      const recs = j.records || [];
      const cols = [...new Set(recs.flatMap((rec) => Object.keys(rec)))].filter((c) => !VT_META.includes(c));
      const vt = vtableFor(`ds:${ds}`, host);
      vt.setData(cols, recs, { rowClass: (row) => (row.present ? "" : "gone"), expander: (row) => expandObservations(ds, row) });
      vt.setBatchCount(batchN);                   // keep the table's search-bar batch tally live too
      setTabCount(ds, ".data-n", recs.length);
    }
    if (els) {
      renderBatchesList(ds, batches);
      setTabCount(ds, ".bat-n", batchN);
    }
  } catch (e) { if (host) { vtables.delete(`ds:${ds}`); host.innerHTML = `<p class="muted" style="padding:8px">${esc(String(e))}</p>`; } }
}

export {
  dataHost, vtables, vtableFor, VT_META, setTabCount, refreshDataNode, refreshDatasetNode,
  refreshAllDataNodes, expandObservations, srcBlock, expandSubsetRow, showRecordMany,
  batchesState, batEls, batState, loadBatchesNode, refreshAllBatchesNodes,
  renderBatchesList, selectBatch, renderBatchDetail, fmtVals,
};
