// Price producer node: a standalone source that sweeps the warframe.market catalogue
// and pushes one current snapshot record per item into its output dataset (wired
// price -> dataset). The node itself shows the sweep control, stored-slug count, market
// movers, and a per-item history chart; joining prices to inventory is a view's job.
import * as api from "../api.js";
import { esc } from "../dom.js";

const plat = (n) => (n == null ? "—" : Number.isInteger(n) ? `${n}` : n.toFixed(1));
const pctTxt = (f) => `${f > 0 ? "+" : ""}${(f * 100).toFixed(1)}%`;

// Elapsed between two ISO instants (end defaults to now) as "m:ss" / "h:mm:ss".
const elapsed = (start, end) => {
  if (!start) return "";
  const s = Math.max(0, ((end ? Date.parse(end) : Date.now()) - Date.parse(start)) / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
};

// Node title + body for a price producer. ``statistics`` mode shows the history chart +
// movers; ``orders`` mode is a live lowest-sell snapshot (no candle history) so those are
// omitted. The source <select> and sweep controls are common to both.
export function priceParts(pn) {
  const mode = pn.mode === "orders" ? "orders" : "statistics";
  const opt = (v, label) => `<option value="${v}"${v === mode ? " selected" : ""}>${label}</option>`;
  const head = `<div class="enr-sum muted">↻ sweep to price the market</div>
      <label class="enr-src flab">source
        <select class="enr-mode">${opt("statistics", "statistics (history)")}${opt("orders", "live orders (now)")}</select>
      </label>
      <div class="gn-foot">
        <button class="enr-refresh">↻ sweep prices</button>
        <button class="enr-cancel danger" hidden>cancel</button>
        <span class="enr-prog livestats"></span>
      </div>`;
  const charts = mode === "orders"
    ? `<div class="enr-orders muted">live lowest online sell, refreshed each sweep — no history</div>`
    : `<div class="pchart enr-chart">
        <div class="pchart-head"><strong class="enr-ctitle">select an item</strong><span class="muted enr-cmeta"></span></div>
        <svg class="enr-svg" viewBox="0 0 640 240" preserveAspectRatio="none"></svg>
      </div>
      <div class="enr-movers-wrap"><div class="sub-lbl">movers <span class="muted">(7d ≥15%) — click to chart</span></div>
        <ul class="movers enr-movers nodehost scrollhost"><li class="muted">—</li></ul></div>`;
  return {
    title: `<span class="gi-id">💲 ${esc(pn.type)}</span>`,
    body: head + charts,
    ports: `<span class="port out" title="drag to a dataset to push prices there"></span>`,
  };
}

// Wire the producer panel: load summary, drive the sweep, chart items on click.
// Self-cleaning — polling stops once the node leaves the DOM. ``onDone`` fires when a
// sweep finishes (or is cancelled) so the wired-up output dataset can refresh.
export function wirePriceNode(div, game, dataset, mode = "statistics", onDone = null) {
  const $ = (sel) => div.querySelector(sel);
  let selectedSlug = null;

  async function loadSummary() {
    try {
      const s = await api.prices.summary(game, dataset);
      const moversTxt = mode === "orders" ? "" : ` · ${(s.movers || []).length} movers`;
      $(".enr-sum").innerHTML = `<strong>${s.slugs}</strong> items priced${moversTxt}`;
      renderMovers(s.movers || []);
      reflectStatus(s.status || { running: false });
    } catch (e) { $(".enr-sum").textContent = String(e.message || e); }
  }

  function renderMovers(movers) {
    const ul = $(".enr-movers");
    if (!ul) return;                              // orders mode has no movers list
    ul.innerHTML = movers.length
      ? movers.map((m) => `<li class="mover ${m.pct >= 0 ? "up" : "down"}" data-slug="${esc(m.slug)}">
          <span class="mname">${esc(m.name)}</span>
          <span class="mprice">${plat(m.then)} → ${plat(m.now)}</span>
          <span class="mpct">${pctTxt(m.pct)}</span></li>`).join("")
      : `<li class="muted">none yet — sweep more history</li>`;
    ul.querySelectorAll("li.mover").forEach((li) => { li.onclick = () => loadItem(li.dataset.slug); });
  }

  async function loadItem(slug) {
    if (!slug || !$(".enr-svg")) return;          // no chart in orders mode
    selectedSlug = slug;
    try {
      const it = await api.prices.item(game, slug);
      $(".enr-ctitle").textContent = it.name || slug;
      const h = it.history || [];
      $(".enr-cmeta").textContent = h.length
        ? `${h.length}d · now ${plat(it.price)}p · ${h[0].date} → ${h[h.length - 1].date}`
        : "no history yet";
      drawChart($(".enr-svg"), h);
    } catch (e) { $(".enr-ctitle").textContent = String(e.message || e); }
  }

  function reflectStatus(st) {
    const prog = $(".enr-prog");
    if (st.blocked) {                             // another node in this game is sweeping
      $(".enr-refresh").disabled = false;
      $(".enr-cancel").hidden = true;
      prog.textContent = "another price node is sweeping — try again when it finishes";
      return;
    }
    const running = !!st.running;
    $(".enr-refresh").disabled = running;
    const cancelBtn = $(".enr-cancel");
    cancelBtn.hidden = !running;
    const cancelling = running && !!st.cancel;        // cancel requested, sweep still draining
    cancelBtn.disabled = cancelling;
    cancelBtn.classList.toggle("busy", cancelling);
    cancelBtn.textContent = cancelling ? "cancelling…" : "cancel";
    if (running) {
      const el = elapsed(st.started);
      prog.textContent = `sweeping ${st.done}/${st.total || "…"} · ${st.fetched} ok · ${el} · ${st.last || ""}`.trim();
      if (!div._enrPoll) poll();
    } else if (st.finished) {
      prog.textContent = `done: ${st.fetched}/${st.total} (${st.failed} failed) in ${elapsed(st.started, st.finished)}`;
    } else {
      prog.textContent = "";
    }
  }

  async function poll() {
    if (!document.contains(div)) { div._enrPoll = null; return; }   // node gone — stop polling
    div._enrPoll = true;        // mark polling for the whole round so a reentrant
                                // reflectStatus() (via the await below) can't re-kick poll()
    let st;
    try { st = await api.prices.status(game, dataset); } catch { st = { running: false }; }
    reflectStatus(st);
    if (st.running) div._enrPoll = setTimeout(poll, 1000);
    else { div._enrPoll = null; await loadSummary(); if (selectedSlug) loadItem(selectedSlug); onDone?.(); }
  }

  $(".enr-refresh").addEventListener("click", async () => {
    try { await api.prices.refresh(game, dataset, mode); poll(); }
    catch (e) { $(".enr-prog").textContent = String(e.message || e); }
  });
  $(".enr-cancel").addEventListener("click", () => {
    const b = $(".enr-cancel");                       // instant feedback (don't wait for the poll)
    b.disabled = true; b.classList.add("busy"); b.textContent = "cancelling…";
    api.prices.cancel(game, dataset).catch(() => {});
    if (!div._enrPoll) poll();                         // make sure we keep polling until it stops
  });

  queueMicrotask(loadSummary);
}

// SVG line of daily median with a faint min–max band + last-point dot.
export function drawChart(svg, history) {
  const W = 640, H = 240, padX = 36, padT = 14, padB = 22;
  if (!svg) return;
  if (!history || !history.length) { svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" class="cempty">no data</text>`; return; }
  const meds = history.map((d) => d.median);
  const mins = history.map((d) => (d.min ?? d.median));
  const maxs = history.map((d) => (d.max ?? d.median));
  let lo = Math.min(...mins), hi = Math.max(...maxs);
  if (lo === hi) { lo -= 1; hi += 1; }
  const n = history.length;
  const x = (i) => padX + (n === 1 ? (W - 2 * padX) / 2 : (i / (n - 1)) * (W - 2 * padX));
  const y = (v) => H - padB - ((v - lo) / (hi - lo)) * (H - padT - padB);
  const pts = (arr) => arr.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const band = `${maxs.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ")} ${mins.map((v, i) => `${x(n - 1 - i).toFixed(1)},${y(mins[n - 1 - i]).toFixed(1)}`).join(" ")}`;
  const mid = (lo + hi) / 2;
  const grid = [lo, mid, hi].map((v) => `<line class="cgrid" x1="${padX}" y1="${y(v).toFixed(1)}" x2="${W - 6}" y2="${y(v).toFixed(1)}"/><text class="cax" x="2" y="${(y(v) + 3).toFixed(1)}">${plat(Math.round(v))}</text>`).join("");
  const li = n - 1;
  svg.innerHTML = `${grid}
    <polygon class="cband" points="${band}"/>
    <polyline class="cline" points="${pts(meds)}"/>
    <circle class="cdot" cx="${x(li).toFixed(1)}" cy="${y(meds[li]).toFixed(1)}" r="3.5"/>
    <text class="cax" x="${padX}" y="${H - 6}">${esc(history[0].date.slice(5))}</text>
    <text class="cax cend" x="${W - 6}" y="${H - 6}">${esc(history[li].date.slice(5))}</text>`;
}
