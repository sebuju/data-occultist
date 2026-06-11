// Data-flow dashboard: a visual graph of Window -> captured fields -> Dataset,
// with animated flow edges, live counts, and a pulse when a dataset changes.
import { esc } from "./dom.js";

const $ = (id) => document.getElementById(id);
const setStatus = (m) => { $("status").textContent = m; };

let game = null;
let selectedDataset = null;
let timer = null;
let edges = [];                 // [{from, to, dataset}]
const prevPresent = {};         // dataset -> last present count (for pulse)
const active = new Set();       // datasets that changed this cycle

const OP_COLOR = { add: "#7ddc7d", update: "#e6c25a", remove: "#e6685a" };

async function jget(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

// ---- graph ----------------------------------------------------------------

async function loadFlow() {
  if (!game) return;
  let data;
  try { data = await jget(`/api/flow/${encodeURIComponent(game)}`); }
  catch (e) { setStatus(String(e.message || e)); return; }

  // detect changes for pulse
  active.clear();
  for (const d of data.datasets) {
    if (prevPresent[d.dataset] !== undefined && d.present !== prevPresent[d.dataset]) active.add(d.dataset);
    prevPresent[d.dataset] = d.present;
  }
  if (!selectedDataset && data.datasets.length) selectedDataset = data.datasets[0].dataset;

  // window nodes + captured-fields nodes
  edges = [];
  $("winCol").innerHTML = `<div class="col-h">Windows</div>` + data.windows.map((w) => `
    <a class="node win" id="win-${esc(w.id)}" href="/teach.html?game=${encodeURIComponent(game)}&window=${encodeURIComponent(w.id)}" title="teach this window">
      <div class="node-h">${esc(w.id)} <span class="muted">↗</span></div>
      <div class="muted">${w.detect} detectors · ${w.states.length} states</div>
    </a>`).join("");

  $("capCol").innerHTML = `<div class="col-h">Captured</div>` + data.windows.map((w) => `
    <div class="node cap" id="cap-${esc(w.id)}">
      <div class="muted">key: ${esc(w.key_field)}</div>
      <div class="chips">${(w.fields.length ? w.fields : ["—"]).map((f) => `<span class="fchip">${esc(f)}</span>`).join("")}</div>
    </div>`).join("");

  const dsCounts = Object.fromEntries(data.datasets.map((d) => [d.dataset, d]));
  // ensure a dataset node exists even if only referenced by a window
  const dsIds = [...new Set([...data.datasets.map((d) => d.dataset), ...data.windows.map((w) => w.dataset)])];
  $("dsCol").innerHTML = `<div class="col-h">Datasets</div>` + dsIds.map((id) => {
    const d = dsCounts[id] || { dataset: id, present: 0, total: 0, last_op: null, last_ts: null };
    const sel = id === selectedDataset ? "sel" : "";
    const pulse = active.has(id) ? "pulse" : "";
    return `<div class="node ds ${sel} ${pulse}" id="ds-${esc(id)}" data-ds="${esc(id)}">
      <div class="node-h">${esc(id)}</div>
      <div class="big">${d.present}<span class="muted"> / ${d.total}</span></div>
      <div class="muted">${d.last_op ? esc(d.last_op) : "—"} ${d.last_ts ? esc(d.last_ts.slice(11)) : ""}</div>
    </div>`;
  }).join("");

  for (const w of data.windows) {
    edges.push({ from: `win-${w.id}`, to: `cap-${w.id}`, dataset: w.dataset });
    edges.push({ from: `cap-${w.id}`, to: `ds-${w.dataset}`, dataset: w.dataset });
  }

  $("dsCol").querySelectorAll(".node.ds").forEach((el) =>
    el.addEventListener("click", () => selectDataset(el.dataset.ds)));

  requestAnimationFrame(drawEdges);
  setStatus(`${data.windows.length} windows · ${dsIds.length} datasets`);
}

function drawEdges() {
  const svg = $("edges");
  const dia = $("diagram").getBoundingClientRect();
  svg.setAttribute("width", dia.width);
  svg.setAttribute("height", dia.height);
  svg.innerHTML = "";
  for (const e of edges) {
    const a = document.getElementById(e.from), b = document.getElementById(e.to);
    if (!a || !b) continue;
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    const x1 = ra.right - dia.left, y1 = ra.top - dia.top + ra.height / 2;
    const x2 = rb.left - dia.left, y2 = rb.top - dia.top + rb.height / 2;
    const dx = Math.max(30, (x2 - x1) / 2);
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`);
    path.setAttribute("class", "edge" + (active.has(e.dataset) ? " active" : ""));
    svg.appendChild(path);
  }
}

// ---- dataset detail -------------------------------------------------------

async function selectDataset(ds) {
  selectedDataset = ds;
  $("detailTitle").textContent = `Dataset: ${ds}`;
  document.querySelectorAll(".node.ds").forEach((c) => c.classList.toggle("sel", c.dataset.ds === ds));
  await loadDetail();
}

async function loadDetail() {
  if (!game || !selectedDataset) return;
  let data;
  try { data = await jget(`/api/flow/${encodeURIComponent(game)}/dataset/${encodeURIComponent(selectedDataset)}`); }
  catch (e) { setStatus(String(e.message || e)); return; }

  $("history").innerHTML = data.history.map((h) => {
    const changed = h.changed ? " " + Object.entries(h.changed).map(([k, v]) => `${esc(k)}:${esc(v[0])}→${esc(v[1])}`).join(", ") : "";
    return `<li><span class="op" style="color:${OP_COLOR[h.op] || "#fff"}">${esc(h.op)}</span>
      <span class="muted">${esc(h.ts.slice(11))}</span> ${esc(h.key)}${changed}</li>`;
  }).join("") || '<li class="muted">no history yet</li>';

  const recs = data.records;
  $("recCount").textContent = recs.length;
  if (!recs.length) { $("records").innerHTML = '<p class="muted">no records</p>'; return; }
  const cols = [...new Set(recs.flatMap((r) => Object.keys(r)))].filter((c) => !["present", "first_seen", "last_seen"].includes(c));
  const head = cols.map((c) => `<th>${esc(c)}</th>`).join("");
  const body = recs.map((r) => `<tr class="${r.present ? "" : "gone"}">${cols.map((c) => `<td>${esc(r[c] ?? "")}</td>`).join("")}</tr>`).join("");
  $("records").innerHTML = `<table class="grid-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

// ---- polling + init -------------------------------------------------------

function tick() { loadFlow(); loadDetail(); }
function setAuto(on) { if (timer) { clearInterval(timer); timer = null; } if (on) timer = setInterval(tick, 3000); }

$("autoRefresh").addEventListener("change", (e) => setAuto(e.target.checked));
$("refreshBtn").addEventListener("click", tick);
$("gameSelect").addEventListener("change", (e) => { game = e.target.value; selectedDataset = null; tick(); });
window.addEventListener("resize", () => requestAnimationFrame(drawEdges));

(async function init() {
  const names = await jget("/api/profiles");
  $("gameSelect").innerHTML = names.map((n) => `<option>${n}</option>`).join("");
  game = $("gameSelect").value || null;
  tick();
  setAuto(true);
})();
