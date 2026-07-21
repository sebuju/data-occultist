// Node inspector — its own floating panel. Select any node in the graph; this walks it back to
// the things that can actually be fed into it and renders a control per feedable input:
//
//   • READOUT values  -> /api/test/feed_readouts -> LiveSession.feed_readouts, the SAME fold a real
//     OCR tick uses, so registers, processes, gates, routers and on_readout triggers all react with
//     no game running and no matching video frame. Reached from a window/readout directly, or walked
//     upstream from a gate/router source, a register/process/toast source list, or a trigger watch.
//   • DATASET rows    -> the existing manual-record endpoint (pretty/api.js recordRow), so on_change /
//     on_new_batch triggers and every downstream subset/producer see a real write. Reached from a
//     dataset directly, or upstream from a subset join, producer source, or trigger watch.
//   • FIRE actions    -> the node's own existing test endpoints (trigger fire, toast test, action
//     fire, producer refresh/probe, sound audition). These already existed per-node; the inspector
//     just gathers them so one panel drives every kind of test.
//
// Readout feeds are ephemeral, so "send all" + the loop timer drive them freely. Dataset writes are
// PERSISTENT, so they ride an explicit per-dataset button and only join the loop behind an opt-in.
import { h, btn, subhead } from "../../dom.js";
import * as api from "../../api.js";
import * as conn from "../../conn.js";
import { recordRow } from "../../pretty/api.js";
import { log } from "../../log.js";
import { fmtDateTimeSec } from "../../datefmt.js";
import { $, model } from "../state.js";
import { createFloatWin } from "../floatwin.js";
import { persist } from "../persist.js";
import { onNodeSelect } from "../selection.js";
import { autosave } from "../main.js";
import { playCue } from "../sound.js";
import { resolveFeeds } from "../feed_targets.js";
import { defaultRowState, isNumType, rollValue as roll } from "../feed_values.js";

let root = null, body = null, lastLine = null, loopMsInput = null, loopBtnEl = null, loopDsCb = null;
let garbleCb = null, garblePct = null;
let curNodeId = null, curTarget = null;
let loopTimer = null;
// While the loop is playing the inspector FREEZES on its current node: selecting another node in the
// graph must neither stop the loop nor switch the panel to it. The last real node picked mid-play is
// held here (undefined = none) and applied when the loop stops. A deselect (null) mid-play is ignored
// so "no selection" also holds the frozen node.
let pendingNodeId;
// Working copies of each row's tuning, keyed by a stable feed key ("ro:<id>" / "col:<ds>:<field>")
// so switching between nodes that share an input keeps the row as you left it. Seeded from the
// profile (the readout's / dataset's optional `test` block) and written back on every edit, so the
// panel survives a reload. Cleared when the loaded game changes — the keys are per-profile.
const rowState = new Map();
let cacheGame = null, knobsSeeded = false;

// `cur` (the live counter position) is runtime-only; everything else round-trips to YAML.
const PERSISTED = ["enabled", "mode", "type", "value", "pool", "min", "max", "step", "integer"];

function stateFor(key, type, holder, retype = false) {
    let st = rowState.get(key);
    if (!st) {
        const saved = holder.kind === "ro" ? model.readoutTest(holder.win, holder.id)
                                           : model.datasetTest(holder.ds, holder.col);
        // a saved `type` wins: it's what the user chose for a column with no FieldDef to read one off
        st = defaultRowState((saved && saved.type) || type);
        for (const k of PERSISTED) if (saved && saved[k] != null) st[k] = saved[k];
        st._holder = holder;
        rowState.set(key, st);
    }
    if (retype) st.retype = true;   // dataset columns carry no FieldDef -> let the user pick the type
    return st;
}

// Write a row back to the profile + autosave. Called from the input handlers ONLY — rendering a
// row never persists, so a profile the user only looked at stays untouched.
function persistRow(st) {
    const h = st._holder;
    if (!h) return;
    const patch = {};
    for (const k of PERSISTED) patch[k] = st[k];
    // `type` is only the user's choice on a column with no FieldDef; on a readout it's just a copy
    // of the field's own type, so don't write it back as if it were configuration.
    if (!st.retype) patch.type = "";
    if (h.kind === "ro") model.setReadoutTest(h.win, h.id, patch);
    else model.setDatasetTest(h.ds, h.col, patch);
    autosave(null);
}

function persistKnobs() {
    model.setTesting({
        loop_ms: Math.max(50, Number(loopMsInput.value) || 500),
        garble: !!garbleCb.checked,
        garble_pct: Math.max(0, Math.min(100, Number(garblePct.value) || 0)),
        include_datasets: !!loopDsCb.checked,
    });
    autosave(null);
}

// Pull the panel knobs off the profile once a game is loaded (buildInspector runs before that).
function seedKnobs() {
    if (knobsSeeded || !model.profile) return;
    knobsSeeded = true;
    const t = model.testing();
    if (!t) return;
    loopMsInput.value = String(t.loop_ms ?? 500);
    garbleCb.checked = !!t.garble;
    garblePct.value = String(t.garble_pct ?? 20);
    garblePct.disabled = !garbleCb.checked;
    loopDsCb.checked = !!t.include_datasets;
}

// The node's OWN existing test entrypoints (each already backed by a per-node button elsewhere in
// the UI — reused here, not reimplemented) as [{label, title, run}].
function actsFor(n) {
    const game = () => model.profile?.name;
    if (n.type === "trigger") return [{ label: "fire now", title: "run this trigger's targets now (bypasses gates + settle)", run: () => api.triggers.fire(game(), n.ref.id) }];
    if (n.type === "toast") return [{ label: "test toast", title: "pop this toast now with its current config", run: () => api.toasts.test(game(), n.ref.id) }];
    if (n.type === "action") return [{ label: "fire action", title: "run this action's dataset op now", run: () => api.actions.fire(game(), n.ref.id) }];
    if (n.type === "sound") return [{ label: "play", title: "audition this cue", run: async () => playCue(model.soundNode(n.ref.id)) }];
    if (n.type === "producer") return [
        { label: "probe", title: "one-item test fetch (no sweep, no write)", run: () => api.prices.probe(game(), n.ref.dataset) },
        { label: "refresh", title: "run this producer's full sweep now", run: () => api.prices.refresh(game(), n.ref.dataset) },
    ];
    return [];
}

function feedTargetsFor(nodeId) {
    if (!nodeId) return null;
    const n = model.nodes().find((x) => x.id === nodeId);
    if (!n) return null;
    const { label, tip, ro, ds } = resolveFeeds(model, n);
    const acts = actsFor(n);
    if (!ro.length && !ds.length && !acts.length) return null;
    return { label, tip, ro, ds, acts };
}

// Every row's value goes through the shared generator, with the panel-level garble knobs applied.
function rollValue(st) {
    return roll(st, { garble: !!garbleCb?.checked, pct: Number(garblePct?.value) || 0 });
}

// ---- row rendering (ONE row primitive for readouts AND dataset columns, rule 7) --------------
// The min/max pair is shared by `random` (roll between them) and the counters (sweep between
// them), so it's built once here. Editing a bound drops the counter's position — otherwise the
// counter keeps ticking from a value that's now outside its own range.
function minMaxPair(st) {
    const mk = (k, cls) => {
        const el = h("input", { type: "number", class: cls, value: st[k], step: "any" });
        el.addEventListener("input", () => { st[k] = el.value; st.cur = null; persistRow(st); });
        return el;
    };
    return [h("span", { class: "insp-rangelbl" }, "min"), mk("min", "insp-min"),
            h("span", { class: "insp-rangelbl" }, "max"), mk("max", "insp-max")];
}

function rowControls(st) {
    if (st.mode === "fixed") {
        const inp = h("input", { type: "text", class: "insp-val", value: st.value, placeholder: "value" });
        inp.addEventListener("input", () => { st.value = inp.value; persistRow(st); });
        return inp;
    }
    if (st.mode === "countup" || st.mode === "countdown") {
        const stepI = h("input", { type: "number", class: "insp-step", value: st.step, step: "any", min: "0" });
        stepI.addEventListener("input", () => { st.step = stepI.value; st.cur = null; persistRow(st); });
        return h("div", { class: "insp-range" }, ...minMaxPair(st),
            h("span", { class: "insp-rangelbl" }, "step"), stepI);
    }
    if (isNumType(st.type)) {
        const kids = minMaxPair(st);
        if (st.type === "number") {
            const intCb = h("input", { type: "checkbox", class: "insp-int", checked: !!st.integer });
            intCb.addEventListener("change", () => { st.integer = intCb.checked; persistRow(st); });
            kids.push(h("label", { class: "insp-intlbl" }, intCb, " int"));
        }
        return h("div", { class: "insp-range" }, ...kids);
    }
    const poolI = h("input", { type: "text", class: "insp-pool", value: st.pool, placeholder: "comma, separated, pool" });
    poolI.addEventListener("input", () => { st.pool = poolI.value; persistRow(st); });
    return poolI;
}

// `name` labels the row, `st` holds its config, `onSend` (optional) adds a per-row send button.
function feedRow(name, st, onSend) {
    const MODES = [["fixed", "fixed"], ["random", "random"], ["countup", "count up"], ["countdown", "count down"]];
    const modeSel = h("select", { class: "insp-mode",
        title: "fixed = this exact value · random = a fresh roll each send · count up/down = step between min and max, wrapping at the far end" },
        MODES.map(([v, l]) => h("option", { value: v, selected: st.mode === v }, l)));
    modeSel.addEventListener("change", () => { st.mode = modeSel.value; st.cur = null; persistRow(st); renderBody(); });
    // off keeps the row's tuning but drops it from every send (its own button, send-all, the loop)
    const enCb = h("input", { type: "checkbox", class: "insp-en", checked: st.enabled !== false,
        title: "feed this input — off keeps the settings but skips it" });
    enCb.addEventListener("change", () => { st.enabled = enCb.checked; persistRow(st); renderBody(); });
    const head = [enCb, h("span", { class: "insp-ro-id" }, name)];
    if (st.retype) {
        // dataset columns have no FieldDef to read a type off — let the user say what to roll
        const tSel = h("select", { class: "insp-type", title: "value type to roll" },
            h("option", { value: "text", selected: st.type === "text" }, "text"),
            h("option", { value: "number", selected: st.type === "number" }, "number"));
        // retype changes ONLY what the row rolls — never the bounds/pool/value the user typed
        // (rebuilding the whole state here silently reset min/max to 0/100 mid-edit).
        tSel.addEventListener("change", () => { st.type = tSel.value; st.cur = null; persistRow(st); renderBody(); });
        head.push(tSel);
    } else {
        head.push(h("span", { class: "insp-ro-type" }, `[${st.type}]`));
    }
    head.push(modeSel);
    const off = st.enabled === false;
    return h("div", { class: `insp-row${off ? " insp-off" : ""}` },
        h("div", { class: "insp-row-head" }, ...head),
        h("div", { class: "insp-row-body" }, rowControls(st),
            onSend ? btn("send", { cls: "btn insp-send", onClick: onSend, disabled: off }) : null));
}

function renderBody() {
    if (!body) return;
    if (!curTarget) {
        body.replaceChildren(h("div", { class: "insp-empty" },
            curNodeId ? "nothing to feed here" : "select a node to feed it data"));
        syncControls();
        return;
    }
    const kids = [h("div", { class: "insp-target" }, curTarget.label)];
    if (curTarget.tip) kids.push(h("div", { class: "insp-tip" }, curTarget.tip));
    if (curTarget.acts.length) {
        kids.push(h("div", { class: "insp-acts" }, ...curTarget.acts.map((a) =>
            btn(a.label, { cls: "btn insp-act", title: a.title, onClick: () => runAct(a) }))));
    }
    if (curTarget.ro.length) {
        kids.push(subhead("readouts"));
        for (const ro of curTarget.ro) {
            const st = stateFor(`ro:${ro.id}`, ro.field?.type || "number", { kind: "ro", win: ro.win, id: ro.id });
            kids.push(feedRow(ro.id, st, () => {
                resetCountsOnManualSend([st]);
                return sendReadouts(ro.win, { [ro.id]: rollValue(st) });
            }));
        }
    }
    for (const ds of curTarget.ds) {
        const cols = model.datasetFields(ds);
        kids.push(subhead(`dataset: ${ds}`));
        if (!cols.length) {
            kids.push(h("div", { class: "insp-tip" }, "no columns — nothing writes to this dataset yet"));
            continue;
        }
        for (const c of cols) kids.push(feedRow(c, stateFor(`col:${ds}:${c}`, "text", { kind: "col", ds, col: c }, true)));
        kids.push(h("div", { class: "insp-dsbar" },
            btn("record row", { cls: "btn insp-rec", title: "write one record into this dataset (persistent)",
                onClick: () => {
                    resetCountsOnManualSend(model.datasetFields(ds).map((c) => rowState.get(`col:${ds}:${c}`)).filter(Boolean));
                    return recordDataset(ds);
                } })));
    }
    body.replaceChildren(...kids);
    syncControls();
}

// Show only the controls that apply to what's selected (dataset opt-in appears only when a dataset
// section exists; the loop/send-all pair only when there's a readout to feed).
function syncControls() {
    const hasRo = !!curTarget?.ro.length, hasDs = !!curTarget?.ds.length;
    if (root) root.querySelector(".insp-controls").hidden = !(hasRo || hasDs);
    if (loopDsCb) loopDsCb.parentElement.hidden = !hasDs;
}

// ---- sending -------------------------------------------------------------------------------
// Every row backing the current selection (readouts + each dataset's columns).
function curRowStates() {
    const out = [];
    if (!curTarget) return out;
    for (const ro of curTarget.ro) { const st = rowState.get(`ro:${ro.id}`); if (st) out.push(st); }
    for (const ds of curTarget.ds)
        for (const c of model.datasetFields(ds)) { const st = rowState.get(`col:${ds}:${c}`); if (st) out.push(st); }
    return out;
}

// A manual send WHILE THE LOOP RUNS restarts the sweep from its start bound instead of landing on
// whatever tick the loop was up to — that's the only way to tell your click apart from the loop's
// own traffic. Idle (no loop), a send still steps by one, so manual stepping keeps working.
// `cur` is runtime-only, so nothing here needs persisting.
function resetCountsOnManualSend(sts) {
    if (!loopTimer) return;
    for (const st of sts) st.cur = null;
}

function stamp(text) {
    if (lastLine) lastLine.textContent = `last ${fmtDateTimeSec(new Date().toISOString())} · ${text}`;
}

async function runAct(a) {
    try { await a.run(); stamp(a.label); }
    catch (e) { log(String(e.message || e), "err"); }
}

async function sendReadouts(winId, values) {
    const game = model.profile?.name;
    if (!game) { log("feed: load a game first", "err"); return; }
    try {
        await api.testfeed.readouts(game, model.profile, winId, values);
        stamp(Object.entries(values).map(([k, v]) => `${k}=${v}`).join(" "));
    } catch (e) { log(String(e.message || e), "err"); }
}

async function recordDataset(ds) {
    const game = model.profile?.name;
    if (!game) { log("record: load a game first", "err"); return; }
    const values = {};
    for (const c of model.datasetFields(ds)) {
        const st = rowState.get(`col:${ds}:${c}`);
        if (st && st.enabled !== false) values[c] = rollValue(st);   // a muted column is left out
    }
    if (!Object.keys(values).length) { log(`record: every column of ${ds} is off`, "err"); return; }
    try {
        await recordRow(game, ds, values);
        stamp(`${ds} <- ` + Object.entries(values).map(([k, v]) => `${k}=${v}`).join(" "));
    } catch (e) { log(String(e.message || e), "err"); }
}

// Every readout of the selection in one call per window, then (opt-in) each dataset row.
async function sendAll() {
    if (!curTarget) return;
    const byWin = new Map();
    for (const ro of curTarget.ro) {
        const st = rowState.get(`ro:${ro.id}`);
        if (!st || st.enabled === false) continue;   // muted rows sit out of send-all / the loop
        if (!byWin.has(ro.win)) byWin.set(ro.win, {});
        byWin.get(ro.win)[ro.id] = rollValue(st);
    }
    for (const [win, values] of byWin) if (Object.keys(values).length) await sendReadouts(win, values);
    if (loopDsCb?.checked) for (const ds of curTarget.ds) await recordDataset(ds);
}

function startLoop() {
    if (loopTimer || !curTarget) return;
    const ms = Math.max(50, Number(loopMsInput.value) || 500);
    loopTimer = setInterval(() => { if (conn.isOnline()) sendAll(); }, ms);
    if (loopBtnEl) loopBtnEl.textContent = "■ pause";
}
export function stopLoop() {
    if (loopTimer) { clearInterval(loopTimer); loopTimer = null; }
    if (loopBtnEl) loopBtnEl.textContent = "▶ play";
    // apply whatever node was picked while frozen (see refresh) now that the loop is stopped
    if (pendingNodeId !== undefined) { const id = pendingNodeId; pendingNodeId = undefined; refresh(id); }
}
function toggleLoop() { if (loopTimer) stopLoop(); else startLoop(); }

function refresh(id) {
    // a different game = a different profile: the cached rows key off ITS readouts/datasets
    const game = model.profile?.name || null;
    if (game !== cacheGame) { cacheGame = game; rowState.clear(); knobsSeeded = false; curNodeId = null; }
    seedKnobs();
    // playing -> FREEZE on the current node: don't stop the loop, don't switch the panel. Remember a
    // real new selection to apply on stop; a re-pick of the frozen node cancels a pending switch; a
    // deselect (null) is ignored so "no selection" also holds the frozen node.
    if (loopTimer) {
        if (id === curNodeId) pendingNodeId = undefined;
        else if (id != null) pendingNodeId = id;
        return;
    }
    if (id === curNodeId) return;
    curNodeId = id;
    curTarget = feedTargetsFor(id);
    if (!curTarget) stopLoop();
    renderBody();
}

// The inspector's own body — the node-feed controls. Built once, hosted directly in the panel
// (no collapsible wrapper) and also embeddable in a pretty widget via the shared floatwin.
export function buildInspector() {
    if (root) return root;
    lastLine = h("div", { class: "insp-last" });
    body = h("div", { class: "insp-body" });
    loopMsInput = h("input", { type: "number", class: "insp-loopms", value: "500", min: "50", step: "50", title: "loop interval, ms" });
    loopBtnEl = btn("▶ play", { cls: "btn insp-loopbtn", onClick: toggleLoop });
    loopDsCb = h("input", { type: "checkbox", class: "insp-loop-ds" });
    garbleCb = h("input", { type: "checkbox", class: "insp-garble-cb" });
    garblePct = h("input", { type: "number", class: "insp-garblepct", value: "20", min: "0", max: "100", step: "5" });
    garbleCb.addEventListener("change", () => { garblePct.disabled = !garbleCb.checked; persistKnobs(); });
    garblePct.disabled = true;
    garblePct.addEventListener("input", persistKnobs);
    loopMsInput.addEventListener("input", persistKnobs);
    loopDsCb.addEventListener("change", persistKnobs);
    root = h("div", { class: "insp-panel" },
        body,
        lastLine,
        h("div", { class: "insp-controls" },
            h("label", { class: "insp-dsopt", title: "roll the WRONG type on some sends: text where a number is expected (and the reverse), using plausible OCR wreckage — exercises the field rules / gates against a bad read" },
                garbleCb, " wrong-type chance", garblePct, "%"),
            h("div", { class: "insp-ctlrow" },
                btn("send all", { cls: "btn insp-sendall",
                    onClick: () => { resetCountsOnManualSend(curRowStates()); return sendAll(); } }),
                h("label", { class: "insp-loop-wrap" }, "loop", loopMsInput, "ms"),
                loopBtnEl),
            h("label", { class: "insp-dsopt", title: "dataset writes are PERSISTENT — off by default so a loop can't flood the store" },
                loopDsCb, " include dataset writes in send all / loop")));
    renderBody();
    onNodeSelect(refresh);
    return root;
}

// ---- the inspector floating panel -------------------------------------------------------------
// A dedicated floating panel that hosts the node inspector directly (no collapsible section). Opens
// wide (500px) and at full usable height like pretty view's inspector — the height is CSS-driven
// (#inspector in floatwin.css), so autoFit stays off and the body scrolls inside a fixed frame.
export const inspState = { visible: false, x: null, y: null, w: 500, h: null, collapsed: false };
export let inspWin = null;

export function buildInspectorPanel() {
    if (inspWin) return inspWin;
    inspWin = createFloatWin({
        id: "inspector", title: "inspector", state: inspState,
        bothAxes: true, autoFit: false, resetW: 500,   // full-height (CSS) + wide default, still user-resizable
        onShow: () => $("inspectorBtn")?.classList.toggle("active", true),
        onHide: () => { $("inspectorBtn")?.classList.toggle("active", false); stopLoop(); },
        onPersist: () => persist.layout(),
    });
    inspWin.body.replaceChildren(buildInspector());
    return inspWin;
}
