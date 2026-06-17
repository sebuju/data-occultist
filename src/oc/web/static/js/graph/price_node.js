// Price producer node: a standalone source that sweeps the warframe.market catalogue
// and pushes one current snapshot record per item into its output dataset (wired
// price -> dataset). The node shows only the sweep config + controls; joining prices
// to inventory (and charting them) is a view's job.
import * as api from "../api.js";
import { isOnline } from "../conn.js";
import { esc, TRASH, labCell } from "../dom.js";
import { log } from "../log.js";

// Elapsed between two ISO instants (end defaults to now) as "m:ss" / "h:mm:ss".
const elapsed = (start, end) => {
  if (!start) return "";
  const s = Math.max(0, ((end ? Date.parse(end) : Date.now()) - Date.parse(start)) / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
};

// Node title + body for a price producer: sweep config (mode, sources, key field) plus
// the sweep/cancel controls. No chart or movers — that's a view's job.
export function priceParts(pn, cols = [], free = []) {
  const mode = pn.mode === "orders" ? "orders" : "statistics";
  const opt = (v, label) => `<option value="${v}"${v === mode ? " selected" : ""}>${label}</option>`;
  const hasSrc = (pn.sources || []).length;
  // priced-item sources use the SAME chip + add-select input the subset's sources use.
  // same chip + add-select look as subset/trigger sources: shared .sv-* classes for style,
  // pr-* classes are the wiring hooks.
  const chips = (pn.sources || []).map((s) => `<span class="sv-input">${esc(s)}<button class="sv-rmin danger pr-rmsrc" data-ds="${esc(s)}" title="stop pricing this source">${TRASH}</button></span>`).join("");
  const addOpts = `<option value="">+ source…</option>${free.map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join("")}`;
  const srcs = `${labCell("prices", "datasets/views whose items to price (empty = whole market catalogue)", true)}<div class="sv-inputs">${chips}<span class="sv-input sv-add"><select class="sv-addin pr-addsrc">${addOpts}</select></span></div>`;
  // which source column names the item to price (resolved to a market slug). Only relevant
  // when sourcing from datasets/views (the whole-catalogue sweep needs no key).
  const nf = pn.source_field || "name";
  const nfOpts = [...new Set([nf, ...cols])].map((c) => `<option${c === nf ? " selected" : ""}>${esc(c)}</option>`).join("");
  const keyFld = hasSrc
    ? `${labCell("price by", "which source column names the item to price (it's resolved to a market slug)")}<select class="enr-keyfld-sel">${nfOpts}</select>`
    : "";
  const head = `<div class="enr-sum muted">↻ sweep to price the market</div>
      <div class="lab-grid">${labCell("source", "what each sweep stores: full daily history or a live now-snapshot")}<select class="enr-mode">${opt("statistics", "statistics (history)")}${opt("orders", "live orders (now)")}</select>
      ${srcs}
      ${keyFld}</div>
      <div class="gn-foot">
        <button class="enr-refresh">↻ sweep prices</button>
        <button class="enr-cancel warn" hidden>cancel</button>
        <span class="enr-prog livestats"></span>
      </div>`;
  return {
    title: `<input class="gi gi-id prrename" value="${esc(pn.id)}" title="rename price node" />`,
    body: head,
    ports: `<span class="port out" title="drag to a dataset to push prices there"></span>`,
  };
}

// Wire the producer panel: load summary, drive the sweep.
// Self-cleaning — polling stops once the node leaves the DOM. ``onDone`` fires when a
// sweep finishes (or is cancelled) so the wired-up output dataset can refresh.
export function wirePriceNode(div, game, dataset, mode = "statistics", onDone = null, onChange = null) {
  const $ = (sel) => div.querySelector(sel);

  async function loadSummary() {
    try {
      const s = await api.prices.summary(game, dataset);
      $(".enr-sum").innerHTML = `<strong>${s.slugs}</strong> items priced`;
      reflectStatus(s.status || { running: false });
    } catch (e) { $(".enr-sum").textContent = String(e.message || e); }
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
    if (!isOnline()) { div._enrPoll = setTimeout(poll, 1000); return; }   // backend down -> idle, keep alive
    div._enrPoll = true;        // mark polling for the whole round so a reentrant
                                // reflectStatus() (via the await below) can't re-kick poll()
    let st;
    try { st = await api.prices.status(game, dataset); } catch { st = { running: false }; }
    reflectStatus(st);
    if (st.running) div._enrPoll = setTimeout(poll, 1000);
    else { div._enrPoll = null; await loadSummary(); onDone?.(); }
  }

  $(".enr-refresh").addEventListener("click", async () => {
    try { await api.prices.refresh(game, dataset, mode); poll(); onChange?.(); }   // sweep started -> notify
    catch (e) { $(".enr-prog").textContent = String(e.message || e); }
  });
  $(".enr-cancel").addEventListener("click", () => {
    const b = $(".enr-cancel");                       // instant feedback (don't wait for the poll)
    b.disabled = true; b.classList.add("busy"); b.textContent = "cancelling…";
    api.prices.cancel(game, dataset).catch((e) => log(`cancel failed: ${e.message || e}`, "err"));
    if (!div._enrPoll) poll();                         // make sure we keep polling until it stops
    onChange?.();                                      // state changed -> notify
  });

  queueMicrotask(loadSummary);
}
