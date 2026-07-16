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
import { makeArmed } from "./armbtn.js";
import { panZoomTo } from "./camera.js";
import { h, frag, kv, trashBtn, observeResize } from "../dom.js";
import { slideToggle } from "./node_parts.js";
import { liveCollecting } from "./panels/livewin.js";

// The register's own ring-aggregate vocabulary (its exposed/persisted value = this fold over the
// ring). "" is the default `<latest>` option (no fold — expose the ring tail). Deliberately its
// OWN list (uses "avg", the user's word) — not the dataset node's collapse policy (which says
// "mean"); the two concepts are unrelated, so they don't share a select.
const REG_AGGREGATES = [["", "latest"], ["min", "min"], ["max", "max"], ["avg", "avg"], ["sum", "sum"], ["median", "median"]];

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

// Display of an aggregate value for the tiny summary slot. Mirrors the backend fold's rounding
// (LiveSession._aggregate_ring): a value that PRODUCED a float (avg/median always; min/max/sum when
// not whole) shows at the ring's own decimals PLUS ONE (JSON drops the trailing ".0", so we re-add
// it here); a whole min/max/sum stays an int.
function fmtAgg(v, mode, ringVals) {
    if (typeof v !== "number") return String(v);
    const floaty = mode === "avg" || mode === "median" || !Number.isInteger(v);
    return floaty ? v.toFixed(ringDecimals(ringVals) + 1) : String(v);
}

// One bank state per live `.data-host` element (grid + a keyed Map of reused cell records + the
// trailing "+" cell), so the poll-driven refreshRegister reconciles in place — zero DOM churn in
// steady state (rule 1). Keyed on the host via a WeakMap: a node re-render swaps the host, drops
// the entry, rebuilds.
const _banks = new WeakMap();   // data-host el -> { grid, cells: Map<key, rec>, addCell, addSel, freeKey }

function bankFor(host) {
    let b = _banks.get(host);
    if (b && host.firstChild === b.grid) return b;
    const grid = h("div", { class: "membank" });
    host.replaceChildren(grid);
    b = { grid, cells: new Map(), addCell: null, addSel: null, freeKey: null, cols: 0 };
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
// The slot IS the source control: armed-remove trash (rule 2, no confirm dialog) + click-to-pan.
function makeCell(id, key) {
    const ref = `readout:${key}`;
    const kEl = h("div", { class: "mb-k" });
    const vstack = h("div", { class: "mb-vstack" });   // one .mb-v line per ring value (latest first)
    const seenEl = h("span", { class: "mb-seen" });
    const confEl = h("span", { class: "mb-conf" });
    const trash = trashBtn({ cls: "mb-rmsrc", title: "remove source" });
    const row = h("div", { class: "mb-cell", dataset: { k: key, ref } },
        kEl, vstack, h("div", { class: "mb-meta" }, seenEl, confEl), trash);
    const armed = makeArmed({
        onArm: () => row.classList.add("armed"),
        onTimeout: () => row.classList.remove("armed"),
        onFire: () => {
            row.classList.remove("armed");
            row.dispatchEvent(new CustomEvent("reg-remove-source", { bubbles: true, detail: { id, ref } }));
        },
    });
    trash.addEventListener("click", (e) => { e.stopPropagation(); armed.trigger(); });   // not a pan
    row.addEventListener("click", (e) => {
        if (e.target.closest(".mb-rmsrc")) return;   // clicking the trash isn't a pan
        const nodeId = model.refNode(ref);
        if (nodeId) panZoomTo(nodeId);
    });
    return { row, kEl, vstack, vlines: [], seenEl, confEl, tier: "", k: "", vkey: "", seen: "", conf: "", multi: null };
}

// Update only the text / class / style that actually changed for one slot (rule 1). Toggles the
// tier class rather than rewriting className, so the transient "armed" (mid-remove) state survives
// a poll tick.
function applyCell(rec, r) {
    const emptyStr = r.value === "";
    const dead = r.value == null || emptyStr;
    const conf = r.conf == null ? null : +r.conf;
    const tier = dead ? "void" : conf == null ? "" : confTier(conf);   // "" = present but no conf -> neutral
    if (tier !== rec.tier) {
        for (const t of ["ok", "warn", "bad", "void"]) rec.row.classList.toggle(t, t === tier);
        rec.tier = tier;
    }
    if (r.key !== rec.k) { rec.kEl.textContent = r.key; rec.kEl.title = r.key; rec.k = r.key; }

    // Build the ordered lines (text + class). MULTI (more than one held value): the aggregate rides
    // on TOP and every raw sample is styled uniformly (no bold "latest") — the stack reads as one
    // ranked column, top-justified. SINGLE value (or dead): the latest sits big on top and the agg
    // (if any) trails below. Reconcile the line pool in place (rule 1): a change-gate string skips
    // untouched slots, line nodes are added/removed only when the entry count changes.
    const vals = Array.isArray(r.values) ? r.values : [r.value];
    const rawNewest = dead ? ["∅"] : vals.slice().reverse().map(String);   // server stores oldest->newest
    const multi = !dead && !!r.multi;   // styling driven by the "recent values" SETTING (capacity > 1), not the live count
    const aggTxt = (!dead && r.agg != null) ? fmtAgg(r.agg, r.aggMode, r.values) : null;   // just the value — the mode shows in the select
    const lines = [];
    if (multi) {
        if (aggTxt != null) lines.push({ t: aggTxt, c: "mb-v-agg" });   // agg first
        for (const t of rawNewest) lines.push({ t, c: "mb-v-old" });    // raw samples, all uniform
    } else {
        rawNewest.forEach((t, i) => lines.push({ t, c: i === 0 && !dead ? "mb-v-latest" : "mb-v-old" }));
        if (aggTxt != null) lines.push({ t: aggTxt, c: "mb-v-agg" });   // agg trails below
    }
    // top-justify the stack only when multi (else keep it centred) — gated so a static tick doesn't touch the DOM
    if (multi !== rec.multi) { rec.vstack.classList.toggle("mb-start", multi); rec.multi = multi; }
    const vkey = lines.map((l) => `${l.c}:${l.t}`).join(" ");
    if (vkey !== rec.vkey) {
        while (rec.vlines.length < lines.length) {
            const line = h("div", { class: "mb-v" });
            rec.vlines.push(line); rec.vstack.appendChild(line);
        }
        while (rec.vlines.length > lines.length) rec.vlines.pop().remove();
        lines.forEach((l, i) => {
            const line = rec.vlines[i];
            line.textContent = l.t;
            line.title = dead ? "" : l.t;   // full value on hover (the line clamps)
            line.classList.toggle("mb-v-latest", l.c === "mb-v-latest");
            line.classList.toggle("mb-v-old", l.c === "mb-v-old");
            line.classList.toggle("mb-v-agg", l.c === "mb-v-agg");
        });
        rec.vkey = vkey;
    }

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

// The trailing "+" slot: a native select (invisible, overlaid on the cell) whose options are the
// readouts not yet wired. Picking one dispatches an add intent. Options rebuilt only when the free
// set changes; hidden when nothing is left to add.
function updateAddCell(b, id) {
    if (!b.addCell) {
        const sel = h("select", { class: "mb-addsel", title: "add a readout source" });
        sel.addEventListener("change", () => {
            const ref = sel.value;
            if (!ref) return;
            sel.value = "";
            sel.dispatchEvent(new CustomEvent("reg-add-source", { bubbles: true, detail: { id, ref } }));
        });
        b.addSel = sel;
        b.addCell = h("div", { class: "mb-add", title: "add readout source" }, sel, h("span", { class: "mb-plus" }, "+"));
    }
    const have = new Set(model.registerSources(id).filter((s) => s.kind === "readout").map((s) => s.id));
    const free = model.readouts().map((v) => v.id).filter((rid) => !have.has(rid));
    const key = free.join("|");
    if (key !== b.freeKey) {
        b.addSel.replaceChildren(h("option", { value: "" }, "+"),
            ...free.map((rid) => h("option", { value: `readout:${rid}` }, rid)));
        b.addCell.classList.toggle("mb-add-empty", !free.length);
        b.freeKey = key;
    }
}

// Reconcile the bank against `rows` (ordered): reuse slots by key, place each at its index only if
// not already there (no detach/reattach churn), drop slots whose key vanished, keep "+" last.
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
    updateAddCell(b, id);
    const at = b.grid.children[i];
    if (at !== b.addCell) b.grid.insertBefore(b.addCell, at || null);
    layout(b, host);
}

export function registerParts(x) {
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
        // history. Below it, the body IS the memory bank: slots for the held map + wired sources,
        // the trailing "+" adds one. .nodehost overflow:auto — a wheel scrolls when the list
        // overflows, else zooms the graph (camera.js scrollableUnder).
        body: frag(
            h("div", { class: "lab-grid" },
                kv("recent values", h("input", { class: "gi reg-cap", type: "number", min: "1", step: "1",
                    value: x.capacity ?? 1, title: "how many recent values to hold per key" })),
                // aggregate: collapse the ring to the ONE value the register exposes/persists — only
                // meaningful (and only offered) once the ring holds more than one sample. The raw
                // ring is always still shown in the membank (a summary line adds below it).
                (x.capacity ?? 1) > 1 && kv("aggregate",
                    h("select", { class: "gi reg-agg", title: "collapse the ring to one exposed/persisted value (raw samples stay shown)" },
                        REG_AGGREGATES.map(([v, lbl]) => h("option", { value: v, selected: v === (x.aggregate || "") },
                            v === (x.aggregate || "") ? `<${lbl}>` : lbl)))),
                // ignore empty: don't write a null/empty read to a keyslot (always available).
                kv("ignore empty", slideToggle({ on: !!x.ignore_empty, cls: "reg-ignoreempty",
                    title: "ignore null / empty reads — don't write them to a keyslot" }))),
            h("div", { class: "nodehost data-host" })),
        foot: h("button", { class: "regclear danger" }, "clear data"),
    };
}

// Fetch + render a register's held map into its node body. No-op when the node isn't in the DOM.
// renderBank reconciles the slots in place (rule 1). Every wired readout is a slot even before it
// holds a value, so an added source shows at once; with live mode OFF a wired source with no server
// row borrows the readout's /api/preview read (readoutPreview.all — the FULL, empty-inclusive
// per-window read a readout node's `.ro-live` uses), else it shows as a pending ∅ slot. A
// "readout-preview" event (imaging.js) repaints every open register too.
export function refreshRegister(id) {
    const host = nodeEls.get(`register:${id}`)?.querySelector(".data-host");
    if (!host) return;
    const wired = model.registerSources(id).filter((s) => s.kind === "readout").map((s) => s.id);
    // pass the node's LIVE fold selection: the server folds the ring with it right away (its own
    // profile is frozen mid-run, so the stored mode lags the select). The fold itself is server-side.
    const aggMode = model.registerNode(id)?.aggregate || "";
    api.registerDetail(model.profile.name, id, aggMode)
        .then((r) => {
            const byKey = new Map((r.records || []).map((e) => [e.key, e]));
            for (const rid of wired) {
                if (byKey.has(rid)) continue;
                const usePrev = !liveCollecting() && Object.prototype.hasOwnProperty.call(readoutPreview.all, rid);
                byKey.set(rid, {
                    key: rid,
                    value: usePrev ? readoutPreview.all[rid] : null,
                    conf: usePrev ? readoutPreview.allConfs[rid] : null,
                    last_seen: null,
                });
            }
            const multi = (model.registerNode(id)?.capacity ?? 1) > 1;   // the "recent values" setting drives the stack styling
            const rows = [...byKey.values()].map((e) => ({
                key: e.key,
                value: e.value,                                  // raw: null / "" -> dead slot; else shown
                values: Array.isArray(e.values) ? e.values : [e.value],   // full ring (oldest->newest); preview fallback = [value]
                agg: e.agg == null ? null : e.agg,               // aggregated value (server fold) or null (no aggregate / preview)
                aggMode,
                multi,
                conf: e.conf == null ? null : +e.conf,           // raw: classified into a tier in applyCell
                seen: e.last_seen == null ? "preview" : sinceShort(e.last_seen * 1000),   // server sends epoch SECONDS
            }));
            // STABLE slot order = the wired-source order (matches the readouts' layout). The server
            // sorts records by last_seen, which shifts every tick now that every read touches it —
            // that would reshuffle the grid and thrash cells (detach/reattach) on every refresh. Pin
            // the order to the wiring so a slot never moves; keys held but no longer wired trail after.
            const order = new Map(wired.map((rid, idx) => [rid, idx]));
            rows.sort((a, b) => (order.get(a.key) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.key) ?? Number.MAX_SAFE_INTEGER));
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
