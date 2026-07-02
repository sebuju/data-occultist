// Producer node: a standalone source fired on a schedule/trigger that fetches external data
// and pushes current records into its output dataset (wired producer -> dataset). The backend
// is chosen by `type` (registry._PRODUCER): `http` fetches a taught URL per source item and maps
// JSON paths -> columns (warframe.market pricing is just an http node); `relic` fetches the WFCD
// relic table and writes one row per (relic, reward). The node shows the config + controls;
// joining/deriving is a view's job.
import * as api from "../api.js";
import { isOnline } from "../conn.js";
import { h, frag, TRASH, labCell } from "../dom.js";
import * as hub from "../hub.js";
import { log } from "../log.js";

// Backends the type picker offers (mirrors registry._PRODUCER). http is the generic fetch+map
// backend (URL / headers / mapping); relic is a self-contained table refresh (no request config).
const PRODUCER_TYPES = ["http", "relic"];

const AGG_OPS = ["min", "max", "sum", "count", "median", "median_low", "first"];
const FILTER_OPS = ["eq", "ne", "in", "nin", "gt", "ge", "lt", "le", "contains"];

// Elapsed between two ISO instants (end defaults to now) as "m:ss" / "h:mm:ss".
const elapsed = (start, end) => {
    if (!start) return "";
    const s = Math.max(0, ((end ? Date.parse(end) : Date.now()) - Date.parse(start)) / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
    const pad = (n) => String(n).padStart(2, "0");
    return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
};

const typeSel = (pn) => h("select", { class: "prtype" },
    ...PRODUCER_TYPES.map((t) => h("option", { value: t, selected: t === (pn.type || "http") }, t)));

const sel = (cls, opts, cur) => h("select", { class: cls },
    ...opts.map((o) => h("option", { value: o, selected: o === cur }, o)));

// checkbox WITH an inline text label (for list rows that have no labCell of their own)
const chk = (cls, on, label) =>
    h("label", { class: "pr-chk", title: label }, h("input", { type: "checkbox", class: cls, checked: !!on }), label);
// bare checkbox (for lab-grid rows whose labCell already names it — avoids a doubled label)
const chkBare = (cls, on, title) => h("input", { type: "checkbox", class: cls, checked: !!on, title });

// A {k: v} map editor: committed rows (with delete) + one trailing empty add-row. `kind` is
// "headers" | "query" (a data hook read back by the wiring). The whole map is rebuilt from the
// rows on each edit, so a filled add-row simply commits and a fresh blank one reappears.
const mapBlock = (kind, obj) => {
    const row = (k, v, committed) => h("div", { class: "pr-row pr-map-row", dataset: { kind } },
        h("input", { class: "pr-map-k", value: k, placeholder: "name" }),
        h("input", { class: "pr-map-v", value: v, placeholder: "value" }),
        committed ? h("button", { class: "sv-rmin danger pr-map-del", dataset: { kind }, title: "remove" }, TRASH()) : null);
    return h("div", { class: "pr-rows" },
        ...Object.entries(obj || {}).map(([k, v]) => row(k, v, true)), row("", "", false));
};

// The catalogue sub-panel (only when key_transform == "catalogue"): teaches the name->key
// resolver. Returned as flat [label, control, ...] pairs to spread into the lab-grid.
const catalogueRows = (c) => [
    labCell("cat url", "catalogue list endpoint (fetched once per sweep)"),
    h("input", { class: "pr-cat-url", value: c.url || "", placeholder: "https://…/items" }),
    labCell("cat items", "path to the items array in the response"),
    h("input", { class: "pr-cat-items", value: c.items_path || "data" }),
    labCell("cat name", "path within an item to its display name"),
    h("input", { class: "pr-cat-name", value: c.name_path || "" }),
    labCell("cat key", "path within an item to its key"),
    h("input", { class: "pr-cat-key", value: c.key_path || "" }),
    labCell("cat fuzzy", "fuzzy match cutoff (0..1)"),
    h("input", { class: "pr-cat-fuzzy", type: "number", step: "0.05", value: c.fuzzy ?? 0.9 }),
    labCell("cat hints", "extra key framings tried after a slugify miss (comma list), e.g. _set"),
    h("input", { class: "pr-cat-hints", value: (c.suffix_hints || []).join(", "), placeholder: "_set" }),
    labCell("cat ttl", "cache freshness (days)"),
    h("input", { class: "pr-cat-ttl", type: "number", value: c.ttl_days ?? 7 }),
];

// The response->columns mapping: one row per output column, each optionally reducing an array
// (filter -> pluck -> aggregate). Indices (data-i field, data-fi filter) drive the wiring.
const fieldsBlock = (fields) => {
    const fieldRow = (f, i) => {
        const arr = f.array;
        return h("div", { class: "pr-field", dataset: { i } },
            h("div", { class: "pr-row" },
                h("input", { class: "pr-f-out", value: f.out_field || "", placeholder: "column" }),
                h("input", { class: "pr-f-path", value: f.path || "", placeholder: "json path" }),
                sel("pr-f-type", ["text", "number"], f.type || "text"),
                chk("pr-f-req", f.required, "required"),
                chk("pr-f-arr", !!arr, "array"),
                h("button", { class: "sv-rmin danger pr-f-del", dataset: { i }, title: "remove column" }, TRASH())),
            arr ? h("div", { class: "pr-arr" },
                h("input", { class: "pr-fa-pluck", value: arr.pluck || "", placeholder: "pluck path" }),
                sel("pr-fa-agg", AGG_OPS, arr.agg || "min"),
                h("input", { class: "pr-fa-depth", type: "number", value: arr.depth ?? 5, title: "depth (median_low)" }),
                ...(arr.filter || []).map((flt, fi) => h("div", { class: "pr-row pr-ffilt", dataset: { i, fi } },
                    h("input", { class: "pr-ff-path", value: flt.path || "", placeholder: "field" }),
                    sel("pr-ff-op", FILTER_OPS, flt.op || "eq"),
                    h("input", { class: "pr-ff-val", value: Array.isArray(flt.value) ? flt.value.join(", ") : (flt.value ?? ""), placeholder: "value" }),
                    h("button", { class: "sv-rmin danger pr-ff-del", dataset: { i, fi }, title: "remove filter" }, TRASH()))),
                h("button", { class: "pr-ff-add", dataset: { i } }, "+ filter"),
            ) : null);
    };
    return h("div", { class: "pr-fields" }, ...fields.map(fieldRow), h("button", { class: "pr-f-add" }, "+ column"));
};

// Node title + body for a producer. http: the full fetch+map editor. relic (and any non-http
// type): just a type picker + the refresh controls.
export function producerParts(pn, cols = [], free = []) {
    const isHttp = (pn.type || "http") === "http";
    const title = h("input", { class: "gi gi-id prrename", value: pn.id, title: "rename producer node" });
    const port = h("span", { class: "port out", title: "drag to a dataset to write its rows there" });

    if (!isHttp) {
        const body = frag(
            h("div", { class: "enr-sum muted" }, "↻ refresh to fetch this data"),
            h("div", { class: "lab-grid" },
                labCell("backend", "which producer backend fetches this dataset"), typeSel(pn),
                labCell("status", "live refresh progress ('idle' when not running)"),
                h("div", { class: "enr-prog livestats" })),
            h("div", { class: "gn-foot" },
                h("button", { class: "enr-refresh" }, "↻ refresh")));   // doubles as cancel while running
        return { title, body, ports: port };
    }

    const spec = pn.http || {};
    const req = spec.request || {};
    const hasSrc = (pn.sources || []).length;
    // item sources use the SAME chip + add-select input the subset's sources use.
    const chips = (pn.sources || []).map((s) =>
        h("span", { class: "sv-input" }, s,
            h("button", { class: "sv-rmin danger pr-rmsrc", dataset: { ds: s }, title: "stop fetching this source" }, TRASH())));
    const addOpts = [h("option", { value: "" }, "+ source"), free.map((d) => h("option", { value: d }, d))];
    const srcs = frag(
        labCell("sources", "datasets/subsets whose item names to fetch", true),
        h("div", { class: "sv-inputs" }, chips,
            h("span", { class: "sv-input sv-add" }, h("select", { class: "sv-addin pr-addsrc" }, addOpts))));
    // which source column names the item (only meaningful when sourcing from datasets/subsets).
    const nf = pn.source_field || "name";
    const nfOpts = [...new Set([nf, ...cols])].map((c) => h("option", { selected: c === nf }, c));
    const keyFld = hasSrc
        ? frag(labCell("name by", "which source column names the item (fed to the URL / catalogue)"),
            h("select", { class: "enr-keyfld-sel" }, nfOpts))
        : null;

    const body = frag(
        h("div", { class: "enr-sum muted" }, "↻ refresh to fetch this data"),
        h("div", { class: "lab-grid" },
            labCell("backend", "which producer backend fetches this dataset"), typeSel(pn),
            labCell("throttle", "seconds between requests during a sweep"),
            h("input", { class: "pr-throttle", type: "number", step: "0.1", value: pn.throttle ?? 0.4 }),
            labCell("label", "status label only (no behaviour) — shown in progress copy"),
            h("input", { class: "pr-mode", value: pn.mode || "", placeholder: "e.g. orders" }),
            labCell("enabled", "include in scheduled / triggered runs"),
            chkBare("pr-enabled", pn.enabled !== false, "include in scheduled / triggered runs"),
            labCell("method", "HTTP method"), sel("pr-method", ["GET", "POST"], req.method || "GET"),
            labCell("url", "{name} = raw item name, {key} = transformed key"),
            h("input", { class: "pr-url", value: req.url || "", placeholder: "https://…/{key}" }),
            labCell("headers", "request headers", true), mapBlock("headers", req.headers),
            labCell("query", "query params appended to the URL", true), mapBlock("query", req.query),
            labCell("timeout", "per-request timeout (seconds)"),
            h("input", { class: "pr-timeout", type: "number", value: req.timeout ?? 30 }),
            labCell("key", "how {key} is built from the item name"),
            sel("pr-keytransform", ["none", "lowercase", "slugify", "catalogue"], spec.key_transform || "slugify"),
            labCell("encode", "percent-encode the substituted {key}"),
            chkBare("pr-keyencode", spec.key_encode !== false, "percent-encode the substituted {key}"),
            ...(spec.key_transform === "catalogue" ? catalogueRows(spec.catalogue || {}) : []),
            srcs, keyFld,
            labCell("root", "path applied to the response before every column path"),
            h("input", { class: "pr-root", value: spec.root || "", placeholder: "e.g. data" }),
            labCell("fields", "response → dataset columns", true), fieldsBlock(spec.fields || []),
            labCell("status", "live sweep progress ('idle' when not running)"),
            h("div", { class: "enr-prog livestats" })),
        h("div", { class: "gn-foot" },
            h("button", { class: "enr-refresh" }, "↻ refresh")));   // doubles as cancel while running
    return { title, body, ports: port };
}

// Wire the producer panel: load status, drive the refresh/sweep.
// Self-cleaning — polling stops once the node leaves the DOM. ``onDone`` fires when a
// refresh finishes (or is cancelled) so the wired-up output dataset can refresh.
export function wireProducerNode(div, game, dataset, mode = "", type = "http",
                                 onDone = null, onChange = null) {
    const $ = (sel) => div.querySelector(sel);

    // unwired producer: no output dataset yet -> nothing to refresh. Prompt the user to wire it.
    if (!dataset) {
        $(".enr-sum").textContent = "drag the out-port to a dataset to enable";
        const rb = $(".enr-refresh"); if (rb) rb.disabled = true;
        return;
    }

    async function loadSummary() {
        try {
            reflectStatus((await api.prices.summary(game, dataset)).status || { running: false });
        } catch (e) { $(".enr-sum").textContent = String(e.message || e); }
    }

    const btn = $(".enr-refresh");
    const startLabel = "↻ refresh";

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
            prog.textContent = "idle";
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

    // Catch a sweep started by ANOTHER actor (a trigger's "fire now", the collector loop, another
    // tab): the self-poll only runs once THIS node kicks it, so ride the shared heartbeat — when a
    // sweep for our dataset appears and we're not already polling, reflectStatus kicks the poll loop.
    let unsub;
    unsub = hub.subscribe((snap) => {
        if (!document.contains(div)) { unsub?.(); return; }   // node gone -> stop listening
        if (div._enrPoll) return;                              // already tracking a sweep
        const sw = (snap.sweeps || []).find((s) => s.dataset === dataset);
        if (sw && sw.running) reflectStatus(sw);               // kicks poll()
    });

    queueMicrotask(loadSummary);
}
