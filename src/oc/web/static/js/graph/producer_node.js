// Producer node: a standalone source fired on a schedule/trigger that fetches external data
// and pushes current records into its output dataset (wired producer -> dataset). The backend
// is chosen by `type` (registry._PRODUCER): `http` fetches a taught URL and maps JSON paths ->
// columns — per source item (warframe.market pricing), or, with `explode` set, one fetch expanded
// into many rows (the WFCD relic table -> one row per (relic, reward)). The node shows the config
// + controls; joining/deriving is a view's job.
import * as api from "../api.js";
import { isOnline } from "../conn.js";
import { h, frag, TRASH, labCell, labAdd, srcRow, kv, subhead, gspan, trashBtn } from "../dom.js";
import { sourcesInput } from "./sources_input.js";
import { model, afterBoot } from "./state.js";
import * as hub from "../hub.js";
import { log } from "../log.js";

// Backends the type picker offers (mirrors registry._PRODUCER). http is the one generic fetch+map
// backend (URL / headers / mapping, per-item or list mode).
const PRODUCER_TYPES = ["http"];

const AGG_OPS = ["min", "max", "sum", "count", "median", "median_low", "first"];
const FILTER_OPS = ["eq", "ne", "in", "nin", "gt", "ge", "lt", "le", "contains", "ncontains"];

// Elapsed between two ISO instants (end defaults to now) as "m:ss" / "h:mm:ss".
const elapsed = (start, end) => {
    if (!start) return "";
    const s = Math.max(0, ((end ? Date.parse(end) : Date.now()) - Date.parse(start)) / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
    const pad = (n) => String(n).padStart(2, "0");
    return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
};

const typeSel = (pn) => h("select", { class: "prtype" },
    ...PRODUCER_TYPES.map((t) => h("option", { value: t, selected: t === (pn.type || "http") }, t === (pn.type || "http") ? `<${t}>` : t)));

const sel = (cls, opts, cur, title = "") => h("select", { class: cls, title: title || null },
    ...opts.map((o) => h("option", { value: o, selected: o === cur }, o === cur ? `<${o}>` : o)));

// checkbox WITH an inline text label (for list rows that have no labCell of their own)
const chk = (cls, on, label) =>
    h("label", { class: "pr-chk", title: label }, h("input", { type: "checkbox", class: cls, checked: !!on }), label);
// bare checkbox (for lab-grid rows whose labCell already names it — avoids a doubled label)
const chkBare = (cls, on, title) => h("input", { type: "checkbox", class: cls, checked: !!on, title });

// A {k: v} map editor: committed rows (with delete) + one trailing empty add-row. `kind` is
// "headers" | "query" (a data hook read back by the wiring). The whole map is rebuilt from the
// rows on each edit, so a filled add-row simply commits and a fresh blank one reappears.
// One header/query k/v row. A ``committed`` row (from the saved object) carries a remove button; a
// freshly +added row does not — it commits (and gains one) once a name is typed, else it vanishes on
// the next rebuild. Exported so the +add wiring can append an identical blank row.
export const mapRow = (kind, k, v, committed) => h("div", { class: "pr-row pr-map-row", dataset: { kind } },
    h("input", { class: "pr-map-k", value: k, placeholder: "name" }),
    h("input", { class: "pr-map-v", value: v, placeholder: "value" }),
    committed ? trashBtn({ cls: "sv-rmin pr-map-del", dataset: { kind }, title: "remove" }) : null);

// Only the SAVED rows — no trailing blank. A "+" (labAdd) appends a blank row on demand, matching
// the explode/keep-rows/fields sections. ``data-mapkind`` lets the add wiring find this container.
const mapBlock = (kind, obj) => h("div", { class: "pr-rows", dataset: { mapkind: kind } },
    ...Object.entries(obj || {}).map(([k, v]) => mapRow(kind, k, v, true)));

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

// A {k:v}-style list of single text values (ordered) with delete. Used for the `explode`
// array-path list (list mode); the add-button lives in the section label (labAdd, `${cls}-add`).
// The whole list rebuilds per edit.
const listBlock = (cls, items, placeholder, itemTitle) => {
    const row = (v, i) => h("div", { class: `pr-row ${cls}-row`, dataset: { i } },
        h("input", { class: `${cls}-v`, value: v, placeholder, title: itemTitle }),
        trashBtn({ cls: `sv-rmin ${cls}-del`, dataset: { i }, title: "remove" }));
    return h("div", { class: "pr-rows" }, ...(items || []).map(row));
};

// The response->columns mapping: one row per output column. A column's value is a `path` (optionally
// reducing an array: filter -> pluck -> aggregate) OR a `{path}` template composed from several
// fields. Indices (data-i field, data-fi filter) drive the wiring.
// ONE editable list of HttpFilter predicates (path / op / value) + its "+ filter" button.
// Two callers, one primitive (rule 7): a field's ARRAY reduction passes its field index `i`
// (rows carry data-i + data-fi); the producer's ROW filter passes none (rows carry data-fi
// only, and the handlers read a missing data-i as "the row_filter list"). Never paste this
// block for a third filter list — pass the index instead.
// `withAdd`: the per-field array-reduction caller keeps its inline "+ filter" button; the
// producer's row-filter section passes false — its add-button lives in the section label (labAdd).
const filterList = (filters, i = null, withAdd = true) => {
    const at = (fi) => (i == null ? { fi } : { i, fi });
    return frag(
        ...(filters || []).map((flt, fi) => h("div", { class: "pr-row pr-ffilt", dataset: at(fi) },
            h("input", { class: "pr-ff-path", value: flt.path || "", placeholder: "field", title: "path within each element to test" }),
            sel("pr-ff-op", FILTER_OPS, flt.op || "eq", "comparison (in/nin take a comma list)"),
            h("input", { class: "pr-ff-val", value: Array.isArray(flt.value) ? flt.value.join(", ") : (flt.value ?? ""), placeholder: "value", title: "value to compare against" }),
            trashBtn({ cls: "sv-rmin pr-ff-del", dataset: at(fi), title: "remove filter" }))),
        withAdd ? h("button", { class: "pr-ff-add", dataset: i == null ? {} : { i } }, "+ filter") : null);
};

const fieldsBlock = (fields) => {
    const fieldRow = (f, i) => {
        const arr = f.array;
        return h("div", { class: "pr-field", dataset: { i } },
            h("div", { class: "pr-row" },
                h("input", { class: "pr-f-out", value: f.out_field || "", placeholder: "column", title: "output dataset column name" }),
                h("input", { class: "pr-f-path", value: f.path || "", placeholder: "json path", title: "dotted/[i] path to the value ('' = response root)" }),
                trashBtn({ cls: "sv-rmin pr-f-del", dataset: { i }, title: "remove column" })),
            h("div", { class: "pr-row" },
                sel("pr-f-type", ["text", "number"], f.type || "text", "text keeps the raw value; number coerces (drops non-numeric)"),
                chk("pr-f-req", f.required, "required"),
                chk("pr-f-arr", !!arr, "array")),
            h("div", { class: "pr-row" },
                h("input", { class: "pr-f-tmpl", value: f.template || "", placeholder: "template (optional): {path} {path}",
                    title: "compose the column from several fields, e.g. '{tier} {relicName}' -> 'Axi A1'. Overrides path/array." })),
            arr ? h("div", { class: "pr-arr" },
                h("input", { class: "pr-fa-pluck", value: arr.pluck || "", placeholder: "pluck path", title: "dotted path within each kept element to the value" }),
                sel("pr-fa-agg", AGG_OPS, arr.agg || "min", "how the plucked values fold to one"),
                h("input", { class: "pr-fa-depth", type: "number", value: arr.depth ?? 5, title: "depth (median_low): median of the lowest N" }),
                filterList(arr.filter, i),
            ) : null);
    };
    return h("div", { class: "pr-fields" }, ...fields.map(fieldRow));
};

// Node title + body for a producer: the full http fetch+map editor. Three shapes share it —
// per-item (one row per fetch), list mode (`explode` set, no sources: one fetch, many rows), and
// per-item-explode (`explode` set AND sources wired: one fetch PER source item, each expanded into
// many rows — e.g. a builds-list-per-frame feed). The per-item-only rows (key transform, sources,
// name-by, array field) hide ONLY in true list mode, where there's no source item to name/key.
export function producerParts(pn, cols = [], free = []) {
    const title = h("input", { class: "gi gi-id prrename", value: pn.id, title: "rename producer node" });
    const port = h("span", { class: "port out", title: "drag to a dataset to write its rows there" });

    const spec = pn.http || {};
    const req = spec.request || {};
    const hasSrc = (pn.sources || []).length;
    const isExplode = (spec.explode || []).length > 0;   // response expands into many rows
    const isList = isExplode && !hasSrc;                 // TRUE list mode: one fetch, no sources
    // item sources use the SHARED sources-input widget (rule 7 — same as subset joins / dict feeds).
    const srcs = srcRow("sources", "datasets/subsets whose item names to fetch",
        sourcesInput({ chips: (pn.sources || []).map((ds) => ({ value: ds, node: model.refNode(ds) })), free,
            rmCls: "sv-rmin pr-rmsrc", addinCls: "sv-addin pr-addsrc", rmTitle: "stop fetching this source" }));
    // which source column names the item (only meaningful when sourcing from datasets/subsets).
    // When `source_array` is set, `source_field` instead names a field WITHIN each element of
    // that nested array column (e.g. `mod` inside each build row's `slots` list).
    const nf = pn.source_field || "name";
    const nfOpts = [...new Set([nf, ...cols])].map((c) => h("option", { selected: c === nf }, c === nf ? `<${c}>` : c));
    const keyFld = hasSrc
        ? frag(labCell("name by", "which source column names the item (fed to the URL / catalogue) — or, with 'array field' set, a field WITHIN each element of that nested array"),
            h("select", { class: "enr-keyfld-sel" }, nfOpts),
            labCell("array field", "optional: a NESTED array column to read source items from instead — every element's 'name by' field, deduped across every row (e.g. a build's 'slots' -> the distinct mod ids used)"),
            h("input", { class: "pr-srcarray", value: pn.source_array || "", placeholder: "blank = source_field is a top-level column" }))
        : null;
    // per-item-only knobs (how {key} is built, which sources feed it) — irrelevant in list mode.
    const perItem = isList ? [] : [
        labCell("key", "how {key} is built from the item name"),
        sel("pr-keytransform", ["none", "lowercase", "slugify", "catalogue"], spec.key_transform || "slugify",
            "transform each source name into the {key} the URL substitutes"),
        labCell("encode", "percent-encode the substituted {key}"),
        chkBare("pr-keyencode", spec.key_encode !== false, "percent-encode the substituted {key}"),
        ...(spec.key_transform === "catalogue" ? catalogueRows(spec.catalogue || {}) : []),
        srcs, keyFld,
    ];

    const body = frag(
        h("div", { class: "enr-sum muted" }, "↻ refresh to fetch this data"),
        h("div", { class: "lab-grid" },
            labCell("backend", "which producer backend fetches this dataset"), typeSel(pn),
            labCell("throttle", "seconds between requests during a sweep (per-item mode only)"),
            h("input", { class: "pr-throttle", type: "number", step: "0.1", value: pn.throttle ?? 0.4, title: "seconds between requests during a sweep" }),
            labCell("label", "status label only (no behaviour) — shown in progress copy"),
            h("input", { class: "pr-mode", value: pn.mode || "", placeholder: "e.g. orders", title: "status label only (no behaviour)" }),
            labCell("on new fire", "if fired again while this sweep is still running: drop = ignore; latest = run only the newest pending batch after; queue = run every pending batch in order"),
            sel("pr-queuemode", ["drop", "latest", "queue"], pn.queue_mode || "drop", "what to do when fired while already sweeping"),
            labCell("method", "HTTP method"), sel("pr-method", ["GET", "POST"], req.method || "GET", "HTTP method"),
            labCell("url", isList ? "the URL fetched once (no {name}/{key} in list mode)" : "{name} = raw item name, {key} = transformed key"),
            h("input", { class: "pr-url", value: req.url || "", placeholder: "https://…/{key}", title: "request URL; templates {name}/{key} in per-item mode" }),
            labAdd("headers", "request headers", "pr-h-add", "add header", true), mapBlock("headers", req.headers),
            labAdd("query", "query params appended to the URL", "pr-q-add", "add param", true), mapBlock("query", req.query),
            labCell("timeout", "per-request timeout (seconds)"),
            h("input", { class: "pr-timeout", type: "number", value: req.timeout ?? 30, title: "per-request timeout (seconds)" }),
            labCell("html extract", "optional: the response is an HTML page, not bare JSON — id of a <script id=\"…\">…</script> tag whose CONTENTS are the JSON to map (e.g. Next.js's __NEXT_DATA__). Blank = parse the response body as JSON directly."),
            h("input", { class: "pr-htmlextract", value: req.html_extract || "", placeholder: "blank = plain JSON response" }),
            ...perItem,
            labCell("root", "path applied to the response before every column path (and before explode)"),
            h("input", { class: "pr-root", value: spec.root || "", placeholder: "e.g. data", title: "dotted path into the response applied before mapping" }),
            labAdd("explode", "nested array paths to expand the response into one row each — with no sources wired, one fetch total (list mode); with sources wired, one fetch PER source item (blank = a single row per fetch, no expansion)", "pr-exp-add", "add level", true),
            listBlock("pr-exp", spec.explode || [], "array path (e.g. relics)", "a nested array path, relative to the prior level"),
            // runs BEFORE the column mapping — so it can test a raw field this producer never emits
            labAdd("keep rows", "drop a source row before it is mapped unless it clears EVERY predicate (tests the raw element, so it may use a field no column emits)", "pr-ff-add", "add filter", true),
            // wrap in ONE .pr-rows cell (like headers/query/explode) — filterList returns a bare
            // frag, so dropping it straight into the lab-grid leaks 2 loose cells per filter and
            // shifts every row below off the 2-col grid. The section add-button lives in the label.
            h("div", { class: "pr-rows" }, filterList(spec.row_filter || [], null, false)),
            labAdd("fields", "response → dataset columns", "pr-f-add", "add column", true), fieldsBlock(spec.fields || []),
            labCell("status", "live sweep progress ('idle' when not running)"),
            h("div", { class: "enr-prog livestats" })));
    // The fetch button doubles as cancel while running. The segmented meter lives INSIDE the button
    // and only shows while a sweep is fetching (built ONCE; reflectStatus() toggles each seg + the
    // label span in place, never rebuilt). The button is sized by the node, so showing/hiding the
    // meter never resizes the node and never triggers a wire reroute.
    const fetchBtn = h("button", { class: "enr-refresh" },
        h("span", { class: "enr-lbl" }, "↻ fetch"),
        h("div", { class: "enr-meter meter", hidden: true },
            h("div", { class: "segs" }, ...Array.from({ length: 12 }, () => h("span", { class: "seg off" }))),
            h("span", { class: "pct" })));
    return { title, body, foot: fetchBtn, ports: port };
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
    const lbl = $(".enr-lbl");   // the button's text span (shown at idle; hidden while the meter runs)

    // ONE button, like every other node: idle = start; while running it carries `data-running`
    // and a second click cancels. The in-button meter is the only running cue — no spinner/label.
    // Paint the in-button meter to done/total (0..1); `null` = indeterminate (empty bar, "…" pct).
    // Visibility is NOT handled here — showMeter() swaps the label span for the meter while running.
    // Toggles existing seg nodes' classes — never rebuilds the scaffold (reconcile in place).
    function setMeter(frac) {
        const m = $(".enr-meter");
        if (!m) return;
        const known = frac != null;
        const lit = known ? Math.round(Math.max(0, Math.min(1, frac)) * 12) : 0;
        m.querySelectorAll(".seg").forEach((s, i) => {
            const on = i < lit; s.classList.toggle("on", on); s.classList.toggle("off", !on);
        });
        m.querySelector(".pct").textContent = known ? `${Math.round(frac * 100)}%` : "…";
    }

    // While a sweep runs the button shows ONLY the meter + pct (no "↻ fetch" label); idle/done/blocked
    // show the label and hide the meter. The button is fixed-size, so this swap never reroutes wires.
    function showMeter(on) {
        const m = $(".enr-meter");
        if (m) m.hidden = !on;
        lbl.hidden = on;
    }

    function reflectStatus(st) {
        const prog = $(".enr-prog");
        if (st.blocked) {                             // another producer in this game is sweeping
            btn.dataset.running = ""; btn.disabled = false;
            prog.textContent = "busy elsewhere";
            showMeter(false);
            return;
        }
        const running = !!st.running;
        const cancelling = running && !!st.cancel;        // cancel requested, sweep still draining
        btn.dataset.running = running ? "1" : "";         // gates the click handler (2nd click cancels)
        btn.disabled = cancelling;                        // mid-cancel: ignore further clicks
        showMeter(running);                               // running -> meter+pct only; else -> label
        const q = st.queued_count > 0 ? ` · +${st.queued_count} queued` : "";
        if (running) {
            prog.textContent = `${st.done}/${st.total || "…"} · ${st.fetched} ok${q}`;
            setMeter(st.total ? st.done / st.total : null);   // no total yet -> indeterminate ("…")
            if (!div._enrPoll) poll();
        } else if (st.finished) {
            prog.textContent = `done · ${st.fetched}/${st.total} · ${elapsed(st.started, st.finished)}${q}`;
        } else {
            prog.textContent = q ? `idle${q}` : "idle";
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
        if (btn.dataset.running) {                        // running -> second click cancels
            btn.disabled = true;                          // instant feedback (don't wait for the poll)
            api.prices.cancel(game, dataset).catch((e) => log(`cancel failed: ${e.message || e}`, "err"));
            if (!div._enrPoll) poll();
            onChange?.();
            return;
        }
        btn.dataset.running = "1";                         // instant feedback before the poll confirms
        showMeter(true); setMeter(null);                   // swap label -> indeterminate meter right away
        try { await api.prices.refresh(game, dataset, mode, type); poll(); onChange?.(); }
        catch (e) { btn.dataset.running = ""; showMeter(false); $(".enr-prog").textContent = String(e.message || e); }
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

    afterBoot(loadSummary);
}
