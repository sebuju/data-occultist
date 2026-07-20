// Register node: an in-memory keyed map that HOLDS the latest live value of the readouts wired
// into it (key = readout id) — fast lookup, no batching / one-to-many. The held map itself
// lives only in the running live session's server memory (GET /api/live/<game>/register/<id>);
// it survives page reloads and collector start/stop, and is wiped only by the footer's clear
// button. Dragging the node's OUT port onto a dataset ALSO mirrors the held map there
// (RegisterDef.persist) — same wiring shape a window/producer/file source uses to feed a
// dataset — so that state becomes joinable/excludable by a subset; with nothing wired it stays
// memory-only.
//
// The held map + its sources are ONE surface: a "memory bank" of square value-slots, one per
// key, mounted in the `.data-host` inside the node body. Each slot shows the key + held value;
// colour carries confidence (tile tint + a bottom magnitude bar, the app-wide >=.8/.5 scale via
// confTier) and absent values (null / empty string) read as dead ∅ slots. A slot is also its own
// source control: hover shows a trash that removes that readout, a click pans/zooms to the readout
// node, and the trailing "+" slot adds one. Those mutations are intents (bubbling CustomEvents)
// the node's wiring (wireRegister in main.js) turns into model changes; rendering is here.
import * as api from "../api.js";
import { boot, model, nodeEls, readoutPreview } from "./state.js";
import { sinceShort } from "../datefmt.js";
import { confTier } from "./conf.js";
import { panZoomTo } from "./camera.js";
import { h, frag, kv, srcRow, observeResize } from "../dom.js";
import { slideToggle } from "./node_parts.js";
import { sourcesInput } from "./sources_input.js";
import { liveCollecting } from "./panels/livewin.js";

// The register's own ring-aggregate vocabulary (its exposed/persisted value = this fold over the
// ring) — grouped for the select's <optgroup>s. Deliberately its OWN list (uses "avg", the user's
// word) — not the dataset node's collapse policy (which says "mean"); the two concepts are
// unrelated, so they don't share a select. "" is the default `<latest>` option (no fold — expose
// the ring tail). The DENOISE group is the point of the roster — algorithms that filter OCR noise
// out of the exposed value (see RegisterDef.aggregate's doc for what each one does).
export const REG_AGGREGATES = [
    ["basic", [["", "latest"], ["first", "first"], ["min", "min"], ["max", "max"], ["sum", "sum"]]],
    ["central", [["avg", "avg"], ["median", "median"], ["midrange", "midrange"], ["wma", "wma"]]],
    ["denoise", [["ema", "ema"], ["trimmed", "trimmed"], ["winsor", "winsor"], ["stable", "stable"],
                 ["cluster", "cluster"], ["quality", "quality"], ["track", "track"], ["common", "common"]]],
    ["spread", [["range", "range"], ["delta", "delta"], ["stdev", "stdev"], ["mad", "mad"]]],
    ["count", [["distinct", "distinct"], ["changes", "changes"], ["nonblank", "nonblank"]]],
];

// One-line explanation per mode (mirrors RegisterDef.aggregate's doc, models.py) — shown under each
// row in the aggregate picker popover (reg_agg_picker.js) so a mode's meaning is visible while
// browsing, not just after picking (native <option title> tooltips don't render cross-browser).
export const AGG_DESC = {
    "": "expose the ring tail unchanged (newest read)",
    first: "oldest retained value (ring head)",
    min: "smallest numeric value",
    max: "largest numeric value",
    sum: "sum of numeric values",
    avg: "mean of the numeric ring",
    median: "middle value; robust to a lone spike",
    midrange: "(min + max) / 2",
    wma: "weighted mean, newest weighted most",
    ema: "exponential moving average (knob: alpha)",
    trimmed: "mean with N highest/lowest dropped (knob: N per end)",
    winsor: "mean with N extremes clamped in, not dropped (knob: N per end)",
    stable: "newest within k·MAD of median; skips misread spikes (knob: k)",
    cluster: "newest of the largest value-within-tolerance group (knob: tolerance)",
    quality: "newest right-type read, held while K-of-M reads matched type (knob: K)",
    track: "newest read that fits the ring's own trend line — time-aware, rejects impossible jumps (knob: tolerance)",
    common: "most frequent value as text (categorical denoiser)",
    range: "max minus min (spread)",
    delta: "newest minus oldest (net change)",
    stdev: "standard deviation of the ring",
    mad: "median absolute deviation",
    distinct: "count of distinct values",
    changes: "count of value changes",
    nonblank: "count of non-blank reads",
};

// display label for a mode value ("" -> "latest"), looked up from REG_AGGREGATES rather than a
// second table — the trigger button (registerParts) and the picker's row order both read the one
// roster.
function aggLabel(v) {
    for (const [, opts] of REG_AGGREGATES) for (const [ov, lbl] of opts) if (ov === v) return lbl;
    return v;
}

// Modes whose fold takes a tuning knob (RegisterDef.aggregate_arg) — shown as one extra input next
// to the aggregate select, label + a placeholder naming that mode's own default (mirrors the
// backend defaults documented on RegisterDef.aggregate_arg).
const AGG_ARG = {
    ema: { label: "alpha", placeholder: "0.5" },
    trimmed: { label: "trim n / end", placeholder: "1" },
    winsor: { label: "clamp n / end", placeholder: "1" },
    stable: { label: "k·MAD", placeholder: "3" },
    cluster: { label: "tolerance", placeholder: "0 (exact)" },
    quality: { label: "min good (K)", placeholder: "⌈M/2⌉" },
    track: { label: "tolerance", placeholder: "3·MAD" },
};

// Short chip text for the agg-line mode tag (register_node.js's own self-describing label — see
// applyCell). Modes not listed here just show their own name.
const MODE_TAG = { avg: "x̄", sum: "Σ", delta: "Δ", stdev: "σ", nonblank: "nb" };
const modeTag = (mode) => MODE_TAG[mode] || mode;

// Most decimal places any numeric ring member carries (mirrors LiveSession._ring_decimals): "1.50"
// -> 2, "10" -> 0. Drives the aggregate's display precision.
function ringDecimals(values) {
    let m = 0;
    for (const v of values || []) {
        if (!Number.isFinite(Number(v))) continue;
        const s = String(v), dot = s.indexOf(".");
        if (dot >= 0) m = Math.max(m, s.length - dot - 1);
    }
    return m;
}

// Folds that always PRODUCE a computed float (mirrors LiveSession._aggregate_ring's own rounding
// rule) rather than merely selecting/summing existing ring members -- these never collapse to a
// bare int even when the result is whole.
const FLOATY_MODES = new Set(["avg", "median", "midrange", "wma", "ema", "trimmed", "winsor",
                              "range", "delta", "stdev", "mad"]);

// Display of an aggregate value for the tiny summary slot. Mirrors the backend fold's rounding
// (LiveSession._aggregate_ring): a value that PRODUCED a float shows at the ring's own decimals
// PLUS ONE (JSON drops the trailing ".0", so we re-add it here); a whole min/max/sum stays an int.
function fmtAgg(v, mode, ringVals) {
    if (typeof v !== "number") return String(v);
    const floaty = FLOATY_MODES.has(mode) || !Number.isInteger(v);
    return floaty ? v.toFixed(ringDecimals(ringVals) + 1) : String(v);
}

// One bank state per live `.data-host` element (grid + a keyed Map of reused cell records + the
// trailing "+" cell), so the poll-driven refreshRegister reconciles in place — zero DOM churn in
// steady state (rule 1). Keyed on the host via a WeakMap: a node re-render swaps the host, drops
// the entry, rebuilds.
const _banks = new WeakMap();   // data-host el -> { grid, cells: Map<key, rec> }

function bankFor(host) {
    let b = _banks.get(host);
    if (b && host.firstChild === b.grid) return b;
    const grid = h("div", { class: "membank" });
    host.replaceChildren(grid);
    b = { grid, cells: new Map(), cols: 0 };
    _banks.set(host, b);
    observeResize(host, () => layout(b, host), { coalesce: true });   // regrow slots as the node resizes
    return b;
}

// Size the slots to fill the host: pick the FEWEST columns (=> largest square cells) whose grid
// still fits the host height, with the column MIN set to the widest key so keys usually sit on one
// line (clamped between a floor and a cap so one long key can't blow the whole grid up). Full rows
// stretch edge-to-edge (repeat(C,1fr)); any leftover falls to the last row / bottom. Writes
// gridTemplateColumns only when the column count changes (rule 1 — no steady-state mutation).
const MB_FLOOR = 4.6 * 16;   // px, smallest column
const MB_CAP = 11 * 16;      // px, largest column the widest key may force ("within reason")
const _measCanvas = document.createElement("canvas");
const _measCtx = _measCanvas.getContext("2d");

// Widest rendered key width (unwrapped) across the slots, measured in the key's own font.
function widestKeyPx(b) {
    const first = b.cells.values().next().value?.kEl;
    if (!first) return 0;
    const cs = getComputedStyle(first);
    _measCtx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const ls = parseFloat(cs.letterSpacing) || 0;   // letter-spacing measureText ignores
    let w = 0;
    for (const rec of b.cells.values()) {
        const s = (rec.k || "").toUpperCase();   // matches text-transform: uppercase
        const px = _measCtx.measureText(s).width + s.length * ls;
        if (px > w) w = px;
    }
    return w;
}

function layout(b, host) {
    const N = b.grid.children.length;
    const W = host.clientWidth, H = host.clientHeight, g = 4;
    if (!N || !W || !H) return;
    const minCol = Math.max(MB_FLOOR, Math.min(MB_CAP, widestKeyPx(b) + 14));   // +14 = cell padding slack
    const maxC = Math.max(1, Math.floor((W + g) / (minCol + g)));   // keep cells >= the widest key
    let best = maxC;
    for (let C = 1; C <= maxC; C++) {
        const colW = (W - (C - 1) * g) / C;
        const rows = Math.ceil(N / C);
        if (rows * colW + (rows - 1) * g <= H) { best = C; break; }   // fewest cols that fit vertically
    }
    if (best !== b.cols) { b.grid.style.gridTemplateColumns = `repeat(${best}, 1fr)`; b.cols = best; }
}

// Build a slot once; its child nodes are cached on the record and mutated in place by applyCell.
// The slot is DISPLAY-ONLY now (the sources input owns add/remove); a click still pans to the
// readout node it holds (kept — a handy jump from a value to its source).
function makeCell(id, key) {
    const ref = `readout:${key}`;
    const kEl = h("div", { class: "mb-k" });
    const tagEl = h("span", { class: "mb-agg-tag" });   // which fold is exposed — corner chip, absolute (no flex slot)
    const vstack = h("div", { class: "mb-vstack" });   // one .mb-v line per ring value (latest first)
    const seenEl = h("span", { class: "mb-seen" });
    const confEl = h("span", { class: "mb-conf" });
    const row = h("div", { class: "mb-cell", dataset: { k: key, ref } },
        kEl, tagEl, vstack, h("div", { class: "mb-meta" }, seenEl, confEl));
    row.addEventListener("click", () => {
        const nodeId = model.refNode(ref);
        if (nodeId) panZoomTo(nodeId);
    });
    return { row, kEl, tagEl, vstack, vlines: [], seenEl, confEl,
             tier: "", k: "", vkey: "", tag: "", seen: "", conf: "", multi: null };
}

// Update only the text / class / style that actually changed for one slot (rule 1). Toggles the
// tier class rather than rewriting className, so the transient "armed" (mid-remove) state survives
// a poll tick.
function applyCell(rec, r) {
    const vals = Array.isArray(r.values) ? r.values : [r.value];
    const isBlank = (v) => v == null || v === "";
    // DEAD = the slot holds NO data at all — NOT merely that the LATEST sample is a gap. A ring with
    // earlier good values (or an aggregate) still renders its full stack; only the gap sample inside
    // shows as ∅. Keying `dead` off the ring tail (r.value) wiped the whole stack the instant a null
    // read landed — a null must never erase the retained ring.
    const dead = !vals.some((v) => !isBlank(v)) && r.agg == null;
    const conf = r.conf == null ? null : +r.conf;
    const tier = dead ? "void" : conf == null ? "" : confTier(conf);   // "" = present but no conf -> neutral
    if (tier !== rec.tier) {
        for (const t of ["ok", "warn", "bad", "void"]) rec.row.classList.toggle(t, t === tier);
        rec.tier = tier;
    }
    if (r.key !== rec.k) { rec.kEl.textContent = r.key; rec.kEl.title = r.key; rec.k = r.key; }

    // Build the ordered lines (text + class). MULTI (more than one held value): the aggregate rides
    // on TOP, then the raw ring in STABLE PHYSICAL-SLOT order — each sample sits at its circular
    // write slot (writes-1 % cap) so a slot never moves; the last-written slot carries a `mb-v-cur`
    // arrow that advances as new samples come (rule 1: a new sample repaints one line + shifts the
    // marker, nothing reorders). SINGLE value (or dead): the latest sits big on top and the agg (if
    // any) trails below. Reconcile the line pool in place: a change-gate string skips untouched
    // slots, line nodes are added/removed only when the entry count changes.
    const rawNewest = dead ? ["∅"] : vals.slice().reverse().map((v) => (isBlank(v) ? "∅" : String(v)));   // server stores oldest->newest; gaps -> ∅
    const multi = !dead && !!r.multi;   // styling driven by the "recent values" SETTING (capacity > 1), not the live count
    const latest = (r.aggMode || "") === "";   // <latest> fold: the exposed value IS the ring tail (cursor slot)
    const aggTxt = (!dead && r.agg != null) ? fmtAgg(r.agg, r.aggMode, r.values) : null;   // just the value — the mode shows in the select
    const lines = [];
    if (multi) {
        if (aggTxt != null) lines.push({ t: aggTxt, c: "mb-v-agg" });   // agg first
        const vlist = vals.map((v) => (isBlank(v) ? "∅" : String(v)));   // oldest -> newest; gaps -> ∅
        const L = vlist.length;
        const cap = Math.max(1, r.cap || L);
        const W = (r.writes == null) ? L : r.writes;   // preview fallback: no live cursor -> treat as in-order
        const cursor = (((W - 1) % cap) + cap) % cap;   // physical slot the last write landed in
        // place each retained sample at its physical ring slot; before the ring fills (W < cap) this
        // is identity, so the stack grows in order then wraps once full — slots stay put thereafter.
        const slots = new Array(cap).fill(null);
        for (let j = 0; j < L; j++) slots[(((W - L + j) % cap) + cap) % cap] = vlist[j];
        for (let s = 0; s < cap; s++) {
            if (slots[s] == null) continue;   // unfilled slot (ring not yet full)
            // cursor = last-written = the ring tail. In <latest> fold it's ALSO the exposed value, so
            // tint it nt (mb-v-live) — the same signal the agg line carries when a real fold is chosen.
            const c = s === cursor ? (latest ? "mb-v-old mb-v-cur mb-v-live" : "mb-v-old mb-v-cur") : "mb-v-old";
            lines.push({ t: slots[s], c });
        }
    } else {
        rawNewest.forEach((t, i) => lines.push({ t, c: i === 0 && !dead ? "mb-v-latest" : "mb-v-old" }));
        if (aggTxt != null) lines.push({ t: aggTxt, c: "mb-v-agg" });   // agg trails below
    }
    // top-justify the stack only when multi (else keep it centred) — gated so a static tick doesn't touch the DOM
    if (multi !== rec.multi) { rec.vstack.classList.toggle("mb-start", multi); rec.multi = multi; }
    const vkey = lines.map((l) => `${l.c}:${l.t}`).join("");
    if (vkey !== rec.vkey) {
        while (rec.vlines.length < lines.length) {
            const line = h("div", { class: "mb-v" });
            rec.vlines.push(line); rec.vstack.appendChild(line);
        }
        while (rec.vlines.length > lines.length) rec.vlines.pop().remove();
        lines.forEach((l, i) => {
            const line = rec.vlines[i];
            const cls = l.c.split(" ");   // a line may carry two tokens (e.g. "mb-v-old mb-v-cur")
            line.textContent = l.t;
            line.title = dead ? "" : l.t;   // full value on hover (the line clamps)
            line.classList.toggle("mb-v-latest", cls.includes("mb-v-latest"));
            line.classList.toggle("mb-v-old", cls.includes("mb-v-old"));
            line.classList.toggle("mb-v-agg", cls.includes("mb-v-agg"));
            line.classList.toggle("mb-v-cur", cls.includes("mb-v-cur"));   // last-written arrow
            line.classList.toggle("mb-v-live", cls.includes("mb-v-live"));   // exposed value (<latest> fold) -> nt tint
        });
        rec.vkey = vkey;
    }

    // mode chip: which fold is exposed, so the cell is self-describing without opening the select.
    const tagTxt = (!dead && r.agg != null && r.aggMode) ? modeTag(r.aggMode) : "";
    if (tagTxt !== rec.tag) { rec.tagEl.textContent = tagTxt; rec.tag = tagTxt; }

    const seenTxt = r.seen || "";
    if (seenTxt !== rec.seen) {
        rec.seenEl.textContent = seenTxt;
        rec.seenEl.classList.toggle("mb-preview", seenTxt === "preview");
        rec.seen = seenTxt;
    }

    // corner: the score to two decimals for a read; nothing when dead (null / empty) or no conf
    const confTxt = dead || conf == null ? "" : conf.toFixed(2);
    if (confTxt !== rec.conf) { rec.confEl.textContent = confTxt; rec.conf = confTxt; }
}

// Reconcile the bank against `rows` (ordered): reuse slots by key, place each at its index only if
// not already there (no detach/reattach churn), drop slots whose key vanished. Adding/removing a
// source lives in the node's sources input (registerParts), not here.
function renderBank(id, host, rows) {
    const b = bankFor(host);
    const liveKeys = new Set();
    let i = 0;
    for (const r of rows) {
        liveKeys.add(r.key);
        let rec = b.cells.get(r.key);
        if (!rec) { rec = makeCell(id, r.key); b.cells.set(r.key, rec); }
        applyCell(rec, r);
        const at = b.grid.children[i];
        if (at !== rec.row) b.grid.insertBefore(rec.row, at || null);
        i++;
    }
    for (const [k, rec] of b.cells) {
        if (!liveKeys.has(k)) { rec.row.remove(); b.cells.delete(k); }
    }
    layout(b, host);
}

export function registerParts(x, model) {
    // sources input (FIRST): the readouts + processes wired into this register — removable chips +
    // an add-select. The ONE sources widget (rule 7); candidates come from the shared source truth
    // (SOURCE_KINDS.register = readouts + processes, already-wired excluded).
    const wired = model ? model.registerSources(x.id) : [];
    const free = model ? model.sourceCandidates("register", x.id).map((c) => ({ value: c.ref, label: c.label })) : [];
    const sourcesRow = srcRow("sources", "readouts and processes wired into this register — remove here, or drag a node's out-port onto it",
        sourcesInput({ chips: wired.map((s) => ({ value: s.ref, node: model && model.refNode(s.ref) })),
                       free, addinCls: "sv-addin reg-addsrc", rmCls: "sv-rmin reg-rmsrc" }));
    return {
        title: h("input", { class: "gi gi-id regrename", value: x.id, title: "rename register" }),
        ports: frag(
            // drop target for a readout's out-port (like the dictionary's feed port)
            h("span", { class: "port in", title: "drag a readout here to hold its live value" }),
            // drag to a dataset to ALSO mirror the held map there (RegisterDef.persist) — same
            // out-port mechanism every other feeder (window/producer/file source) uses, so it
            // shows up as a real wire + a chip in the dataset's own "sources" list, not a
            // hidden side-channel setting.
            h("span", { class: "port out", title: "drag to a dataset to also mirror the held map there" })),
        // "recent values" = ring depth per key (RegisterDef.capacity): how many recent values each
        // key holds. Pulls/persist/membank always show the LATEST (ring tail); N>1 just retains
        // history. Below the settings, the body IS the memory bank: display-only value-slots for the
        // held map (one per wired readout). .nodehost overflow:auto — a wheel scrolls when the list
        // overflows, else zooms the graph (camera.js scrollableUnder).
        body: frag(
            h("div", { class: "lab-grid" },
                sourcesRow,
                kv("recent values", h("input", { class: "gi reg-cap", type: "number", min: "1", step: "1",
                    value: x.capacity ?? 1, title: "how many recent values to hold per key" })),
                // ignore empty: don't write a null/empty read to a keyslot (always available, so it
                // sits above the capacity-gated aggregate rows below rather than between them).
                kv("ignore empty", slideToggle({ on: !!x.ignore_empty, cls: "reg-ignoreempty",
                    title: "ignore null / empty reads — don't write them to a keyslot" })),
                // aggregate: collapse the ring to the ONE value the register exposes/persists — only
                // meaningful (and only offered) once the ring holds more than one sample. The raw
                // ring is always still shown in the membank (a summary line adds below it).
                // native <option title> tooltips don't render cross-browser, so the mode roster is
                // browsed in a grouped popover (reg_agg_picker.js) instead of a plain <select> —
                // each mode's meaning is visible while choosing (io_wire.js wires the click -> pick).
                (x.capacity ?? 1) > 1 && kv("aggregate",
                    h("button", { class: "gi reg-agg-btn", type: "button",
                        title: "collapse the ring to one exposed/persisted value (raw samples stay shown)" },
                        `<${aggLabel(x.aggregate || "")}>`)),
                // per-mode tuning knob (RegisterDef.aggregate_arg) — only shown for a fold that has
                // one (AGG_ARG); 0/blank -> that mode's own default (the placeholder names it).
                (x.capacity ?? 1) > 1 && AGG_ARG[x.aggregate || ""] && kv(AGG_ARG[x.aggregate || ""].label,
                    h("input", { class: "gi reg-aggarg", type: "number", step: "any",
                        value: x.aggregate_arg || "", placeholder: AGG_ARG[x.aggregate || ""].placeholder,
                        title: `tune the "${x.aggregate}" fold — blank/0 = its own default` }))),
            h("div", { class: "nodehost data-host" })),
        foot: h("button", { class: "regclear danger" }, "clear data"),
    };
}

// Ordered keys a register scaffolds a slot for, from its WIRING alone (no data): each wired readout's
// id, plus each wired process's declared output keys. The register's own view onto the shared SSOT
// `model.registerKeys` (rule 7) — the stable slot order both populate + the refresh fallback pin to.
const scaffoldKeys = (id) => model.registerKeys(id);

// Populate the SCAFFOLD only — one empty ∅ value-slot per wired key (readout ids + process output
// keys), NO server fetch and NO preview borrow. Used on boot and on a source add/remove: the register
// shows which sources are wired without pulling any data into the cells (values arrive only while
// live collection runs, via the heartbeat's refreshRegister). No-op when the node isn't in the DOM.
export function populateRegister(id) {
    const host = nodeEls.get(`register:${id}`)?.querySelector(".data-host");
    if (!host) return;
    const cap = model.registerNode(id)?.capacity ?? 1;
    const multi = cap > 1;
    const aggMode = model.registerNode(id)?.aggregate || "";
    const rows = scaffoldKeys(id).map((k) => ({
        key: k, value: null, values: [null], writes: null, cap,
        agg: null, aggMode, multi, conf: null, seen: "",
    }));
    renderBank(id, host, rows);
}

// Fetch + render a register's held map into its node body. No-op when the node isn't in the DOM.
// renderBank reconciles the slots in place (rule 1). The rendered slots are EXACTLY the current
// scaffold keys (wired readout ids + process output keys) — NOT whatever the server still holds: the
// live session's held map accumulates keys and is only wiped by "clear data", so a readout that got
// unwired or a process output key that got renamed lingers there. Showing only the scaffold keys
// drops those stale slots (the renamed/old key vanishes) instead of piling them up. A scaffold key
// with no matching server row shows ∅, borrowing the readout's /api/preview read when live mode is
// OFF (process keys have no preview). A "readout-preview" event (imaging.js) repaints every register.
export function refreshRegister(id) {
    const host = nodeEls.get(`register:${id}`)?.querySelector(".data-host");
    if (!host) return;
    // the register's full wired key set (readout ids + process output keys), in stable wiring order.
    const wired = scaffoldKeys(id);
    // pass the node's LIVE fold selection + its tuning knob: the server folds the ring with them
    // right away (its own profile is frozen mid-run, so the stored mode/arg lags the select). The
    // fold itself is server-side.
    const aggMode = model.registerNode(id)?.aggregate || "";
    const aggArg = model.registerNode(id)?.aggregate_arg || 0;
    api.registerDetail(model.profile.name, id, aggMode, aggArg)
        .then((r) => {
            const byKey = new Map((r.records || []).map((e) => [e.key, e]));
            const cap = model.registerNode(id)?.capacity ?? 1;
            const multi = cap > 1;   // the "recent values" setting drives the stack styling
            // iterate the SCAFFOLD keys (not the server records) — this both pins the slot order to the
            // wiring and drops any stale key the server still holds but nothing feeds anymore.
            const rows = wired.map((k) => {
                const e = byKey.get(k);
                if (e) return {
                    key: e.key,
                    value: e.value,                                  // raw: null / "" -> dead slot; else shown
                    values: Array.isArray(e.values) ? e.values : [e.value],   // full ring (oldest->newest); preview fallback = [value]
                    writes: e.writes ?? null,                        // total writes -> circular cursor; null on /api/preview (no live ring)
                    cap,
                    agg: e.agg == null ? null : e.agg,               // aggregated value (server fold) or null (no aggregate / preview)
                    aggMode,
                    multi,
                    conf: e.conf == null ? null : +e.conf,           // raw: classified into a tier in applyCell
                    seen: e.last_seen == null ? "preview" : sinceShort(e.last_seen * 1000),   // server sends epoch SECONDS
                };
                // no server row for this scaffold key -> ∅ slot, borrowing the /api/preview read for a
                // readout key when live mode is off (process keys have no preview -> stay ∅).
                const usePrev = !liveCollecting() && Object.prototype.hasOwnProperty.call(readoutPreview.all, k);
                return {
                    key: k, value: usePrev ? readoutPreview.all[k] : null,
                    values: [usePrev ? readoutPreview.all[k] : null], writes: null, cap,
                    agg: null, aggMode, multi,
                    conf: usePrev ? readoutPreview.allConfs[k] : null,
                    seen: usePrev ? "preview" : "",
                };
            });
            renderBank(id, host, rows);
        })
        .catch(() => { /* transient fetch error -> leave the last-rendered slots */ });
}

// A fresh /api/preview readout batch landed (non-live source) — repaint every register currently
// rendered (refreshRegister no-ops for ids not in the DOM, mirrors renderReadoutValues in livewin.js).
// Skipped during boot: every window's image load fires this event, so N windows means N redundant
// refetches of every register (all returning the same game-global held map). Boot content is
// already covered by the build-time fetch + the afterBoot one (io_wire.js wireRegister).
window.addEventListener("readout-preview", () => {
    if (boot.phase) return;
    for (const id of model.registers()) refreshRegister(id);
});
