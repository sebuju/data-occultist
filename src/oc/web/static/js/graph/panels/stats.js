// Stats floating panel — per-node execution durations, so you can eyeball when something
// is starting to take too long. Polls /api/stats/{game} for a live rollup (one row per
// node+op: count, last/avg/min/max ms, last-seen) while open; rows reconcile in place
// (keyed map, like the activity panel — never innerHTML per tick). Clicking a row expands a
// small line chart of that node's recent durations, fetched lazily on first open (the
// history is NOT pushed with every poll). Rows for nodes no longer in the graph are hidden.
import { createFloatWin } from "../floatwin.js";
import { persist } from "../persist.js";
import { $, model } from "../state.js";
import { liveAgo, stopAgo } from "../../ago.js";
import { drawChart } from "../../pretty/chart_draw.js";

const statsState = { visible: false, x: null, y: null, w: null, h: null };
let statsWin = null;
let statsTimer = null;
let statsEmpty = null;
let statsSpin = null;   // "building…" spinner, shown while a fetch is in flight and no cards yet
let statsOrder = null;   // frozen key order ("node|op"), set on open by avg desc; null => re-sort next render
const statsRows = new Map();   // "node|op" -> { row, detail, chart, cells:{}, expanded, loaded, node, op }
const statsHeads = new Map();  // op -> { el, label }   group headings, reconciled in place like rows

// duration chips, shown in ONE unit per card (chosen by durUnit): [key, label]
const DUR_METRICS = [["last_ms", "last"], ["avg_ms", "avg"], ["min_ms", "min"], ["max_ms", "max"]];

// op-code -> display order of its type bucket + heading label. Cards group under these; the
// order here is the order the buckets render in. Mirrors stats_store.OPS.
const OP_GROUPS = [
  ["tk", "ticks"], ["oc", "ocr"], ["rp", "replays"], ["rc", "recomputes"], ["sw", "sweeps"], ["fr", "frames"],
];
const GROUP_RANK = new Map(OP_GROUPS.map(([op], i) => [op, i]));
const GROUP_LABEL = new Map(OP_GROUPS);
const groupRank = (op) => (GROUP_RANK.has(op) ? GROUP_RANK.get(op) : OP_GROUPS.length);
const groupLabel = (op) => GROUP_LABEL.get(op) || op;

// replays/recomputes are the slow-path ops we flag: avg over 1s = warn, over 10s = danger.
const SLOW_OPS = new Set(["rp", "rc"]);
const WARN_MS = 1000, DANGER_MS = 10000;

function buildStats() {
  if (statsWin) return;
  statsWin = createFloatWin({
    id: "stats", title: "stats", state: statsState, bothAxes: true,
    onShow: () => { $("statsBtn")?.classList.toggle("active", true); statsOrder = null; startStatsPoll(); },
    onHide: () => { $("statsBtn")?.classList.toggle("active", false); stopStatsPoll(); },
    // the SVG charts are sized to their host at draw time, so a panel resize leaves them stale —
    // redraw every open one from its cached samples (no refetch) when the panel size changes
    onResize: () => { for (const r of statsRows.values()) if (r.expanded && r.loaded) renderChart(r); },
    onPersist: () => persist.layout(),
  });
  statsWin.body.innerHTML = `<div class="st-panel"><div class="st-list"></div></div>`;
  statsEmpty = document.createElement("div");
  statsEmpty.className = "st-empty"; statsEmpty.textContent = "no timing yet";
  statsSpin = document.createElement("div");
  statsSpin.className = "st-spin"; statsSpin.textContent = "building…";
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

// Show the "building…" spinner only on the FIRST load (no cards yet, no empty placeholder
// shown) — a steady poll over existing cards leaves the DOM untouched.
function showSpin() {
  if (statsRows.size || !statsWin) return;
  const list = statsWin.body.querySelector(".st-list");
  if (statsEmpty.isConnected) return;   // already resolved to "no timing yet" — don't flip back
  if (!statsSpin.isConnected) { list.appendChild(statsSpin); statsWin.fitHeight(); }
}

function pollStats() {
  if (!statsState.visible) return;
  const game = model.profile.name;
  if (!game) { renderStats([]); return; }
  showSpin();
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
  if (statsSpin.isConnected) statsSpin.remove();   // a response arrived -> spinner done
  // `precap` is a synthetic (per-game) node, not a graph node, so it's always allowed through.
  const rows = nodes.filter((r) => !live || r.node === "precap" || live.has(r.node));
  // Cards are grouped by type (op) under a heading; WITHIN each bucket they sort by avg desc.
  // On open (statsOrder null) freeze the within-bucket key order so later polls don't reshuffle
  // as live avgs drift. Sort key: group rank first (keeps buckets contiguous, headings stable),
  // then frozen rank, then avg desc for any new keys with no frozen rank.
  if (!statsOrder) {
    statsOrder = [...rows]
      .sort((a, b) => (groupRank(a.op) - groupRank(b.op)) || ((b.avg_ms || 0) - (a.avg_ms || 0)))
      .map((r) => `${r.node}|${r.op}`);
  }
  const rank = new Map(statsOrder.map((k, i) => [k, i]));
  const frozen = (r) => (rank.has(`${r.node}|${r.op}`) ? rank.get(`${r.node}|${r.op}`) : Infinity);
  rows.sort((a, b) =>
    (groupRank(a.op) - groupRank(b.op)) || (frozen(a) - frozen(b)) || ((b.avg_ms || 0) - (a.avg_ms || 0)));
  const want = new Set(rows.map((r) => `${r.node}|${r.op}`));
  const wantOps = new Set(rows.map((r) => r.op));
  for (const [k, r] of statsRows) if (!want.has(k)) { r.row.remove(); statsRows.delete(k); }
  for (const [op, h] of statsHeads) if (!wantOps.has(op)) { h.el.remove(); statsHeads.delete(op); }
  if (!rows.length) {
    if (!statsEmpty.isConnected) list.appendChild(statsEmpty);
    statsWin.fitHeight();   // size to the placeholder
    return;
  }
  if (statsEmpty.isConnected) statsEmpty.remove();
  let i = 0;
  let curOp = null;
  for (const d of rows) {
    if (d.op !== curOp) {   // bucket boundary -> place (or move) its heading first
      curOp = d.op;
      let h = statsHeads.get(d.op);
      if (!h) { h = makeHead(d.op); statsHeads.set(d.op, h); }
      const at = list.children[i];
      if (at !== h.el) list.insertBefore(h.el, at || null);
      i++;
    }
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

// one heading per type bucket (ticks/ocr/replays/…), reconciled in place like the cards.
function makeHead(op) {
  const el = document.createElement("div");
  el.className = "st-group"; el.dataset.op = op;
  el.textContent = groupLabel(op);
  return { el, op };
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
  // chart-range toggle: default last 20 runs, click to show all (and back). Hidden when there
  // are <=20 samples (nothing to toggle). An armed button, not a dialog (CLAUDE.md rule 2).
  const bar = document.createElement("div");
  bar.className = "st-detail-bar";
  const toggle = document.createElement("button");
  toggle.className = "st-toggle"; toggle.type = "button"; toggle.hidden = true;
  bar.appendChild(toggle);
  const chart = document.createElement("div");
  chart.className = "st-chart";
  detail.append(bar, chart);
  row.append(head, detail);
  const r = { row, name, runs, detail, chart, toggle, cells, expanded: false, loaded: false,
              showAll: false, node: d.node, op: d.op };
  toggle.addEventListener("click", (ev) => { ev.stopPropagation(); r.showAll = !r.showAll; renderChart(r); statsWin?.fitHeight(); });
  statsRows.set(k, r);
  return r;
}

const STAT_LAST_N = 20;   // default chart window: the most recent N runs

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
  // since label ticks optimistically (1s) via the shared ago ticker, not just on the poll
  if (d.last_ts) liveAgo(r.cells.since, d.last_ts * 1000);   // unix s -> ms for Date()
  else { stopAgo(r.cells.since); setText(r.cells.since, "—"); }
  // flag slow replays/recomputes by avg: >10s danger, >1s warn (no class otherwise).
  const slow = SLOW_OPS.has(d.op) ? (d.avg_ms || 0) : 0;
  r.row.classList.toggle("st-danger", slow > DANGER_MS);
  r.row.classList.toggle("st-warn", slow > WARN_MS && slow <= DANGER_MS);
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
// this is re-run on panel resize to keep the chart fitting its (changed) width. Defaults to the
// last STAT_LAST_N runs; the per-row toggle flips to the full series (and back).
function renderChart(r) {
  const all = r.chartRows || [];
  const windowed = r.showAll ? all : all.slice(-STAT_LAST_N);
  if (r.toggle) {
    const more = all.length > STAT_LAST_N;
    r.toggle.hidden = !more;   // nothing to toggle when there aren't more than the default window
    setText(r.toggle, r.showAll ? `last ${STAT_LAST_N}` : `all ${all.length}`);
    r.toggle.classList.toggle("on", r.showAll);
  }
  const title = r.showAll ? "duration (ms) per run — all"
                          : `duration (ms) per run — last ${Math.min(STAT_LAST_N, all.length)}`;
  drawChart(r.chart, { type: "line", rows: windowed, x: "i", y: ["ms"], title });
}

export { statsWin, statsState, buildStats, startStatsPoll, stopStatsPoll };
