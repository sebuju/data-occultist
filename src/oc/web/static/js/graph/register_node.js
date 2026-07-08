// Register node: an in-memory keyed map that HOLDS the latest live value of the readouts wired
// into it (key = readout id). It's the lightweight, NON-persisted counterpart to a dataset —
// fast lookup, no batching / one-to-many. The held map lives only in the running live session's
// server memory (GET /api/live/<game>/register/<id>); it survives page reloads and collector
// start/stop, and is wiped only by the footer's clear button.
//
// Like the trigger-history node (rule 7) the records grid is a standard VTable mounted in a
// `.data-host` scrollhost — but here it sits INSIDE the node body, not a satellite. Fed by
// dragging a readout's out-port onto this node's `.port.in`, or via the `+ readout` chip select.
// Parts (rendering) here; wiring (rename / chips / clear) is wireRegister in main.js.
import * as api from "../api.js";
import { model, nodeEls, readoutPreview } from "./state.js";
import { sinceShort } from "../datefmt.js";
import { VTable } from "../vtable.js";
import { h, frag, srcRow, srcChip, srcInputs } from "../dom.js";
import { liveCollecting } from "./panels/livewin.js";

const COLS = ["key", "value", "conf", "seen"];
const _vts = new Map();   // registerId -> VTable (one per node body host)

// One VTable per register host; recreated if the host element was rebuilt by a node re-render.
function vtFor(id, host) {
    let vt = _vts.get(id);
    if (vt && vt.host === host) return vt;
    if (vt) vt.destroy();
    host.replaceChildren();
    vt = new VTable(host, `register:${id}`);
    _vts.set(id, vt);
    return vt;
}

export function registerParts(x, model) {
    // readouts not already wired become the "+ readout" add options (refs are prefixed "readout:<id>")
    const have = new Set((x.sources || []).map((r) => r.replace(/^readout:/, "")));
    const free = model.readouts().map((v) => v.id).filter((id) => !have.has(id));
    return {
        title: h("input", { class: "gi gi-id regrename", value: x.id, title: "rename register" }),
        // drop target for a readout's out-port (like the dictionary's feed port)
        ports: h("span", { class: "port in", title: "drag a readout here to hold its live value" }),
        body: frag(
            // wrapped in .lab-grid like every other top-level srcRow (toast/action/producer) — a
            // bare .sv-inputs is a full-width block in the outer node grid (graph.css), so without
            // this wrapper the chips/add-select drop to their own row under the label.
            h("div", { class: "lab-grid" },
                srcRow("source", "readout nodes whose latest value this register holds",
                    srcInputs(
                        // chip label shows the bare readout id; the ref it carries keeps the prefix
                        model.registerSources(x.id).map((s) => srcChip(s.ref, "regsrc", "reg-rmsrc", s.id)),
                        "reg-addsrc",
                        [h("option", { value: "" }, "+ readout"), free.map((id) => h("option", { value: `readout:${id}` }, id))]))),
            h("div", { class: "nodehost scrollhost data-host" },
                h("p", { class: "muted", style: "padding:8px" }, "no data yet"))),
        foot: h("button", { class: "regclear danger" }, "clear data"),
    };
}

// Fetch + render a register's held map into its node body. No-op when the node isn't in the DOM.
// Modeled on renderTriggerHistory (history_node.js) — VTable reconciles in place (rule 1).
// With live mode OFF the collector never feeds the server-side map, so a wired source with no
// server row falls back to readoutPreview.all — the FULL (empty-inclusive) per-window
// /api/preview read a readout node's `.ro-live` uses (see panels/livewin.js renderReadoutValues).
// A "readout-preview" event (imaging.js, fired whenever that fallback source updates) repaints
// every open register too.
export function refreshRegister(id) {
    const host = nodeEls.get(`register:${id}`)?.querySelector(".data-host");
    if (!host) return;
    const wired = model.registerSources(id).filter((s) => s.kind === "readout").map((s) => s.id);
    api.registerDetail(model.profile.name, id)
        .then((r) => {
            const byKey = new Map((r.records || []).map((e) => [e.key, e]));
            if (!liveCollecting()) {
                for (const rid of wired) {
                    if (byKey.has(rid) || !Object.prototype.hasOwnProperty.call(readoutPreview.all, rid)) continue;
                    byKey.set(rid, { key: rid, value: readoutPreview.all[rid], conf: readoutPreview.allConfs[rid], last_seen: null });
                }
            }
            const rows = [...byKey.values()].map((e) => ({
                key: e.key,
                value: e.value,
                conf: e.conf == null ? "" : (+e.conf).toFixed(2),
                seen: e.last_seen == null ? "preview" : sinceShort(e.last_seen * 1000),   // server sends epoch SECONDS
            }));
            vtFor(id, host).setData(COLS, rows);
        })
        .catch(() => { /* transient fetch error -> leave the last-rendered rows */ });
}

// A fresh /api/preview readout batch landed (non-live source) — repaint every register currently
// rendered (refreshRegister no-ops for ids not in the DOM, mirrors renderReadoutValues in livewin.js).
window.addEventListener("readout-preview", () => { for (const id of model.registers()) refreshRegister(id); });
