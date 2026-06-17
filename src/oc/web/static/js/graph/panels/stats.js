// Stats floating panel — per-node execution durations, so you can eyeball when something
// is starting to take too long. Polls /api/stats/{game} for a live rollup (one row per
// node+op: count, last/avg/min/max ms, last-seen) while open; rows reconcile in place
// (keyed map, like the activity panel — never innerHTML per tick). Clicking a row expands a
// small line chart of that node's recent durations, fetched lazily on first open (the
// history is NOT pushed with every poll). Rows for nodes no longer in the graph are hidden.
import { createFloatWin } from "../floatwin.js";
import { persist } from "../persist.js";
import { $, model } from "../state.js";
import { since } from "../../datefmt.js";
import { drawChart } from "../../pretty/chart_draw.js";

const statsState = { visible: false, x: null, y: null, w: null, h: null };
let statsWin = null;
let statsTimer = null;
let statsEmpty = null;
const statsRows = new Map();   // "node|op" -> { row, detail, chart, cells:{}, expanded, loaded, node, op }

// duration chips, shown in ONE unit per card (chosen by durUnit): [key, label]
const DUR_METRICS = [["last_ms", "last"], ["avg_ms", "avg"], ["min_ms", "min"], ["max_ms", "max"]];

function buildStats() {
  if (statsWin) return;
  statsWin = createFloatWin({
    id: "stats", title: "stats", state: statsState, bothAxes: true,
    onShow: () => { $("statsBtn")?.classList.toggle("active", true); startStatsPoll(); },
    onHide: () => { $("statsBtn")?.classList.toggle("active", false); stopStatsPoll(); },
    // the SVG charts are sized to their host at draw time, so a panel resize leaves them stale —
    // redraw every open one from its cached samples (no refetch) when the panel size changes
    onResize: () => { for (const r of statsRows.values()) if (r.expanded && r.loaded) renderChart(r); },
    onPersist: () => persist.layout(),
  });
  statsWin.body.innerHTML = `<div class="st-panel"><div class="st-list"></div></div>`;
  statsEmpty = document.createElement("div");
  statsEmpty.className = "st-empty"; statsEmpty.textContent = "no timing yet";
  // one delegated click: toggle a row's inline history chart (lazy fetch on first open)
  statsWin.body.addEventListener("click", (ev) => {
    const head = ev.target.closest(".st-list .st-head");
    if (!head) return;
    const r = statsRows.get(head.parentElement?.dataset.k);
    if (r) toggleDetail(r);
  });
}

function stopStatsPoll() {
  if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
}

function startStatsPoll() {
  stopStatsPoll();
  pollStats();
  statsTimer = setInterval(pollStats, 2500);   // same cadence as the activity panel
}

function pollStats() {
  if (!statsState.visible) return;
  const game = model.profile.name;
  if (!game) { renderStats([]); return; }
  fetch(`/api/stats/${encodeURIComponent(game)}`)
    .then((r) => r.json())
    .then((d) => { if (statsState.visible) renderStats(d.nodes || []); })
    .catch(() => {});
}

// ids of nodes that still exist in the graph — rows for anything else (a removed/renamed
// node's leftover stats) are hidden so the panel never shows a ghost.
function liveNodeIds() {
  try { return new Set((model.nodes() || []).map((n) => n.id)); }
  catch { return null; }   // model mid-load -> don't filter
}

function shortName(node) {
  const i = node.indexOf(":");
  return i < 0 ? node : node.slice(i + 1);
}

function renderStats(nodes) {
  if (!statsWin) return;
  const live = liveNodeIds();
  const list = statsWin.body.querySelector(".st-list");
  // stable order: by node id then op, so reconcile never reshuffles. `precap` is a
  // synthetic (per-game) node, not a graph node, so it's always allowed through the filter.
  const rows = nodes
    .filter((r) => !live || r.node === "precap" || live.has(r.node))
    .sort((a, b) => (a.node === b.node ? a.op.localeCompare(b.op) : a.node.localeCompare(b.node)));
  const want = new Set(rows.map((r) => `${r.node}|${r.op}`));
  for (const [k, r] of statsRows) if (!want.has(k)) { r.row.remove(); statsRows.delete(k); }
  if (!rows.length) {
    if (!statsEmpty.isConnected) list.appendChild(statsEmpty);
    statsWin.fitHeight();   // size to the placeholder
    return;
  }
  if (statsEmpty.isConnected) statsEmpty.remove();
  let i = 0;
  for (const d of rows) {
    const k = `${d.node}|${d.op}`;
    let r = statsRows.get(k);
    if (!r) r = makeRow(k, d);
    const at = list.children[i];
    if (at !== r.row) list.insertBefore(r.row, at || null);
    i++;
    updateRow(r, d);
  }
  // the rows arrive from an async fetch AFTER setVisible's first fit ran on an empty list, so
  // re-fit here — this is what gives the panel its correct initial height (and tracks growth).
  statsWin.fitHeight();
  // live: each poll, refresh the history of every EXPANDED card so its chart tracks new runs.
  for (const r of statsRows.values()) if (r.expanded) loadHistory(r, true);
}

// one card per node+op: a clickable head (title + a row of labelled metric chips) with the
// (hidden) history chart below. Mirrors the tasks panel's .act-row card shape.
function makeRow(k, d) {
  const row = document.createElement("div");
  row.className = "st-card"; row.dataset.k = k;
  const head = document.createElement("div");
  head.className = "st-head"; head.title = "show history";
  // title: "node · label" + the run count, dot-delimited
  const title = document.createElement("div");
  title.className = "st-title";
  const name = document.createElement("span"); name.className = "st-name";
  const runs = document.createElement("span"); runs.className = "st-runs";
  title.append(name, document.createTextNode(" · "), runs);
  const meta = document.createElement("div");
  meta.className = "st-meta";
  const cells = {};
  for (const [key, lbl] of [...DUR_METRICS, ["since", ""]]) {
    const chip = document.createElement("span");
    chip.className = `st-m st-m-${key}`;
    const lab = document.createElement("i"); lab.textContent = lbl;
    const val = document.createElement("b");
    chip.append(lab, val);
    meta.appendChild(chip);
    cells[key] = val;
  }
  head.append(title, meta);
  const detail = document.createElement("div");
  detail.className = "st-detail"; detail.hidden = true;
  const chart = document.createElement("div");
  chart.className = "st-chart";
  detail.appendChild(chart);
  row.append(head, detail);
  const r = { row, name, runs, detail, chart, cells, expanded: false, loaded: false, node: d.node, op: d.op };
  statsRows.set(k, r);
  return r;
}

function setText(el, txt) { if (el.textContent !== txt) el.textContent = txt; }
// Pick ONE time unit for a card's whole set of durations so last/avg/min/max never mix ms and s
// (which is confusing to read). ms while the peak is sub-second, else seconds; drop the decimals
// once we're into 100s of seconds (noise at that scale).
function durUnit(vals) {
  const peak = Math.max(0, ...vals.filter((v) => Number.isFinite(v)));
  if (peak < 1000) return { unit: "ms", fmt: (v) => `${Math.round(v)}` };
  const dec = peak / 1000 > 99 ? 0 : 2;
  return { unit: "s", fmt: (v) => (v / 1000).toFixed(dec) };
}

function updateRow(r, d) {
  setText(r.name, `${shortName(d.node)} · ${d.label}`);
  if (r.name.title !== d.node) r.name.title = d.node;
  setText(r.runs, `${d.count} runs`);
  const u = durUnit(DUR_METRICS.map(([key]) => d[key]));
  for (const [key] of DUR_METRICS) setText(r.cells[key], `${u.fmt(d[key])}${u.unit}`);
  setText(r.cells.since, d.last_ts ? since(d.last_ts * 1000) : "—");   // unix s -> ms for Date()
}

function toggleDetail(r) {
  r.expanded = !r.expanded;
  r.detail.hidden = !r.expanded;
  r.row.classList.toggle("open", r.expanded);
  if (r.expanded) loadHistory(r);   // (re)fetch on every open so the chart is fresh
  else r.loaded = false;            // closed -> next open refetches; stops the live refresh
  statsWin?.fitHeight();
}

// `silent` (live refresh of an already-open chart) keeps the current chart on screen until the
// fresh samples arrive — no "loading…" flash every poll.
function loadHistory(r, silent = false) {
  const game = model.profile.name;
  if (!game) return;
  r.loaded = true;
  if (!silent) r.chart.innerHTML = `<div class="pw-chart-empty">loading…</div>`;
  const url = `/api/stats/${encodeURIComponent(game)}/node/${encodeURIComponent(r.node)}/history?op=${encodeURIComponent(r.op)}`;
  fetch(url).then((res) => res.json()).then((d) => {
    // samples are [ts, ms, n] in time order; the chart's x is SAMPLE ORDER, not the
    // timestamp (a run-over-run trend). ts rides along only as the point's tooltip context.
    r.chartRows = (d.samples || []).map(([ts, msv], idx) => ({ i: idx + 1, ms: msv, ts }));
    renderChart(r);
    statsWin?.fitHeight();
  }).catch(() => { r.chart.innerHTML = `<div class="pw-chart-empty">failed</div>`; });
}

// (re)draw a row's history chart from its cached samples — the SVG is sized to its host, so
// this is re-run on panel resize to keep the chart fitting its (changed) width.
function renderChart(r) {
  drawChart(r.chart, { type: "line", rows: r.chartRows || [], x: "i", y: ["ms"], title: "duration (ms) per run" });
}

export { statsWin, statsState, buildStats, startStatsPoll, stopStatsPoll };
