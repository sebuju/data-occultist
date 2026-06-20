// Producer node: a standalone source fired on a schedule/trigger that fetches external data
// and pushes current records into its output dataset (wired producer -> dataset). The backend
// is chosen by `type` (registry._PRODUCER): `warframe_market` sweeps the market catalogue and
// prices items; `relic` fetches the WFCD relic table and writes one row per (relic, reward,
// state). The node shows the refresh config + controls; joining/charting is a view's job.
import * as api from "../api.js";
import { isOnline } from "../conn.js";
import { h, frag, TRASH, labCell } from "../dom.js";
import { log } from "../log.js";

// Backends the type picker offers (mirrors registry._PRODUCER). warframe_market is the market
// pricer (mode/sources/key field); relic is a self-contained table refresh (no sources).
const PRODUCER_TYPES = ["warframe_market", "relic"];

// Elapsed between two ISO instants (end defaults to now) as "m:ss" / "h:mm:ss".
const elapsed = (start, end) => {
    if (!start) return "";
    const s = Math.max(0, ((end ? Date.parse(end) : Date.now()) - Date.parse(start)) / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
    const pad = (n) => String(n).padStart(2, "0");
    return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
};

const typeSel = (pn) => h("select", { class: "prtype" },
    ...PRODUCER_TYPES.map((t) => h("option", { value: t, selected: t === (pn.type || "warframe_market") }, t)));

// Node title + body for a producer. warframe_market: sweep config (mode, sources, key field) +
// controls. relic (and any non-market type): just a type picker + the refresh controls.
export function producerParts(pn, cols = [], free = []) {
    const isMarket = (pn.type || "warframe_market") === "warframe_market";
    const title = h("input", { class: "gi gi-id prrename", value: pn.id, title: "rename producer node" });
    const port = h("span", { class: "port out", title: "drag to a dataset to write its rows there" });

    if (!isMarket) {
        const body = frag(
            h("div", { class: "enr-sum muted" }, "↻ refresh to fetch this data"),
            h("div", { class: "lab-grid" },
                labCell("backend", "which producer backend fetches this dataset"), typeSel(pn)),
            h("div", { class: "gn-foot" },
                h("button", { class: "enr-refresh" }, "↻ refresh")),   // doubles as cancel while running
            h("div", { class: "enr-prog livestats" }));   // progress sits BELOW the button
        return { title, body, ports: port };
    }

    const mode = pn.mode === "orders" ? "orders" : "statistics";
    const opt = (v, label) => h("option", { value: v, selected: v === mode }, label);
    const hasSrc = (pn.sources || []).length;
    // priced-item sources use the SAME chip + add-select input the subset's sources use.
    // same chip + add-select look as subset/trigger sources: shared .sv-* classes for style,
    // pr-* classes are the wiring hooks.
    const chips = (pn.sources || []).map((s) =>
        h("span", { class: "sv-input" }, s,
            h("button", { class: "sv-rmin danger pr-rmsrc", dataset: { ds: s }, title: "stop pricing this source" }, TRASH())));
    const addOpts = [h("option", { value: "" }, "+ source"), free.map((d) => h("option", { value: d }, d))];
    const srcs = frag(
        labCell("prices", "datasets/subsets whose items to price (empty = whole market catalogue)", true),
        h("div", { class: "sv-inputs" }, chips,
            h("span", { class: "sv-input sv-add" }, h("select", { class: "sv-addin pr-addsrc" }, addOpts))));
    // which source column names the item to price (resolved to a market slug). Only relevant
    // when sourcing from datasets/subsets (the whole-catalogue sweep needs no key).
    const nf = pn.source_field || "name";
    const nfOpts = [...new Set([nf, ...cols])].map((c) => h("option", { selected: c === nf }, c));
    const keyFld = hasSrc
        ? frag(labCell("price by", "which source column names the item to price (it's resolved to a market slug)"),
            h("select", { class: "enr-keyfld-sel" }, nfOpts))
        : null;
    const body = frag(
        h("div", { class: "enr-sum muted" }, "↻ sweep to price the market"),
        h("div", { class: "lab-grid" },
            labCell("backend", "which producer backend fetches this dataset"), typeSel(pn),
            labCell("source", "what each sweep stores: full daily history or a live now-snapshot"),
            h("select", { class: "enr-mode" }, opt("statistics", "statistics (history)"), opt("orders", "live orders (now)")),
            srcs, keyFld),
        h("div", { class: "gn-foot" },
            h("button", { class: "enr-refresh" }, "↻ sweep prices")),   // doubles as cancel while running
        h("div", { class: "enr-prog livestats" }));   // progress sits BELOW the button
    return { title, body, ports: port };
}

// Wire the producer panel: load summary, drive the refresh/sweep.
// Self-cleaning — polling stops once the node leaves the DOM. ``onDone`` fires when a
// refresh finishes (or is cancelled) so the wired-up output dataset can refresh.
export function wireProducerNode(div, game, dataset, mode = "statistics",
                                 type = "warframe_market", onDone = null, onChange = null) {
    const $ = (sel) => div.querySelector(sel);
    const isMarket = type === "warframe_market";
    const noun = isMarket ? "items priced" : "rows";

    // unwired producer: no output dataset yet -> nothing to refresh. Prompt the user to wire it.
    if (!dataset) {
        $(".enr-sum").textContent = "drag the out-port to a dataset to enable";
        const rb = $(".enr-refresh"); if (rb) rb.disabled = true;
        return;
    }

    async function loadSummary() {
        try {
            const s = await api.prices.summary(game, dataset);
            // warframe_market reports its OWN accumulated count ("N items priced"); other
            // producers show no count here (the row total belongs to the dataset node, not us).
            if (isMarket) $(".enr-sum").replaceChildren(h("strong", String(s.slugs)), ` ${noun}`);
            reflectStatus(s.status || { running: false });
        } catch (e) { $(".enr-sum").textContent = String(e.message || e); }
    }

    const btn = $(".enr-refresh");
    const startLabel = isMarket ? "↻ sweep prices" : "↻ refresh";

    // ONE button, like every other node: idle = start; while running it carries `.reading`
    // (CSS appends the spinner) and a second click cancels. No separate cancel button.
    function reflectStatus(st) {
        const prog = $(".enr-prog");
        if (st.blocked) {                             // another producer in this game is sweeping
            btn.classList.remove("reading"); btn.disabled = false; btn.textContent = startLabel;
            prog.textContent = "another producer is busy — try again when it finishes";
            return;
        }
        const running = !!st.running;
        const cancelling = running && !!st.cancel;        // cancel requested, sweep still draining
        btn.classList.toggle("reading", running);         // spinner ON the fetch button while it runs
        btn.disabled = cancelling;                        // mid-cancel: ignore further clicks
        btn.textContent = running ? (cancelling ? "cancelling…" : "cancel") : startLabel;
        if (running) {
            const el = elapsed(st.started);
            prog.textContent = `${st.done}/${st.total || "…"} · ${st.fetched} ok · ${el} · ${st.last || ""}`.trim();
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

    btn.addEventListener("click", async () => {
        if (btn.classList.contains("reading")) {          // running -> second click cancels
            btn.disabled = true; btn.textContent = "cancelling…";   // instant feedback (don't wait for the poll)
            api.prices.cancel(game, dataset).catch((e) => log(`cancel failed: ${e.message || e}`, "err"));
            if (!div._enrPoll) poll();
            onChange?.();
            return;
        }
        btn.classList.add("reading"); btn.textContent = "cancel";   // instant feedback before the poll confirms
        try { await api.prices.refresh(game, dataset, mode, type); poll(); onChange?.(); }
        catch (e) { btn.classList.remove("reading"); btn.textContent = startLabel; $(".enr-prog").textContent = String(e.message || e); }
    });

    queueMicrotask(loadSummary);
}
