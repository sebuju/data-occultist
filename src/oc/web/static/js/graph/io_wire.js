// Data-IO node wiring: producer (HTTP fetch -> dataset), its preview satellite, trigger (fires
// sweeps on a condition), action (clear/clone/move a dataset), register (holds wired readouts'
// live values), and file-source (parse a log/config file -> dataset) with its parse-preview
// satellite and auto-find modal. Split out of main.js; the node DOM is built in the matching
// *_node.js files, this binds their controls. Deferred-edit / layout helpers (autosave, render,
// rebuildNode, refreshLive, wireArmedRemove, withBusy, setNodeBusy, showSatellite) live in main
// and are imported back.
import * as api from "../api.js";
import * as hub from "../hub.js";
import { model, nodeEls, setStatus } from "./state.js";
import { h, frag } from "../dom.js";
import { renameNode, movePos } from "./node_lifecycle.js";
import { drawEdges } from "./routing.js";
import { singleFlight } from "../singleflight.js";
import { openModal } from "../modal.js";
import { since } from "../datefmt.js";
import { log, timed } from "../log.js";
import { wireProducerNode, mapRow } from "./producer_node.js";
import { renderTriggerHistory } from "./history_node.js";
import { refreshRegister } from "./register_node.js";
import { wireSlotRows } from "./reg_slots.js";
import { makeArmed } from "./armbtn.js";
import { refreshDataNode, loadBatchesNode } from "./panels/datanodes.js";
import {
    render, autosave, rebuildNode, rebuildNodeEdges, refreshLive, wireArmedRemove,
    withBusy, setNodeBusy, showSatellite, armConfirm,
} from "./main.js";

// ---- producer node: fetches external data into its output dataset -----------

function wireProducer(div, n) {
    const id = n.ref.id;
    const save = () => autosave(null);                       // value-only edit
    const rebuild = () => { rebuildNodeEdges(n.id); autosave(null); };   // body/edges change (measured anchor)
    const structural = () => { rebuildNode(n.id); render(); autosave(null); };  // output columns change -> rebuild THIS body (removed row) + refresh downstream
    const fieldI = (el) => +el.closest(".pr-field").dataset.i;
    const collectMap = (kind) => {
        const obj = {};
        div.querySelectorAll(`.pr-map-row[data-kind="${kind}"]`).forEach((r) => {
            const k = r.querySelector(".pr-map-k").value.trim();
            if (k) obj[k] = r.querySelector(".pr-map-v").value;
        });
        return obj;
    };

    // the producer panel (config + controls). The out-port (drag to a dataset) is wired by wireOutPort.
    // when a refresh ends (or is cancelled), refresh the dataset it feeds so its new batch shows.
    wireProducerNode(div, model.profile.name, n.ref.dataset, n.ref.mode || "",
        n.ref.type || "http", () => {
            refreshLive(); refreshDataNode(n.ref.dataset); loadBatchesNode(n.ref.dataset);
        }, hub.kick);   // refresh start/cancel -> beat the hub so the tasks panel refreshes now

    // backend picker (http). Switching swaps the body AND the output columns.
    div.querySelector(".prtype")?.addEventListener("change", (e) => { model.setProducerType(id, e.target.value); structural(); });
    // rename the producer node (its id) — carry its saved layout slot to the new id, then re-render
    div.querySelector(".prrename")?.addEventListener("change", (e) => {
        const oldId = id;
        renameNode(e.target, oldId,
            () => model.renameProducer(oldId, (e.target.value || "").trim()),
            () => movePos(`producer:${oldId}`, `producer:${n.ref.id}`),
            () => { render(); autosave(null); });
    });
    // producer-level knobs
    div.querySelector(".pr-throttle")?.addEventListener("change", (e) => { model.setProducerThrottle(id, e.target.value); save(); });
    div.querySelector(".pr-queuemode")?.addEventListener("change", (e) => { model.setProducerQueueMode(id, e.target.value); save(); });
    div.querySelector(".pr-mode")?.addEventListener("change", (e) => { model.setProducerMode(id, e.target.value); save(); });

    // request
    div.querySelector(".pr-method")?.addEventListener("change", (e) => { model.setHttpMethod(id, e.target.value); save(); });
    div.querySelector(".pr-url")?.addEventListener("change", (e) => { model.setHttpUrl(id, e.target.value); save(); });
    div.querySelector(".pr-timeout")?.addEventListener("change", (e) => { model.setHttpTimeout(id, e.target.value); save(); });
    div.querySelector(".pr-htmlextract")?.addEventListener("change", (e) => { model.setHttpHtmlExtract(id, e.target.value); save(); });
    // headers/query maps: one blank row is added on demand via the section's "+" (labAdd), matching
    // the explode/fields sections — so an unused producer shows no empty rows. Wire each row (saved
    // OR just-appended): a k/v change recomputes the whole {k:v} and rebuilds; the remove button (on
    // saved rows only) drops it. A blank +added row commits once a name is typed, else it's dropped
    // on the next rebuild.
    const wireMapRow = (rowEl) => {
        rowEl.querySelectorAll(".pr-map-k, .pr-map-v").forEach((el) => el.addEventListener("change", () => {
            model.setProducerMap(id, rowEl.dataset.kind, collectMap(rowEl.dataset.kind)); rebuild();
        }));
        armConfirm(rowEl.querySelector(".pr-map-del"), () => {
            const kind = rowEl.dataset.kind; rowEl.remove();
            model.setProducerMap(id, kind, collectMap(kind)); rebuild();
        }, { silent: true, resetOnOutside: true });
    };
    div.querySelectorAll(".pr-map-row").forEach(wireMapRow);
    const addMapRow = (kind) => {
        const box = div.querySelector(`.pr-rows[data-mapkind="${kind}"]`);
        if (!box) return;
        const r = mapRow(kind, "", "", false);
        box.appendChild(r); wireMapRow(r);
        r.querySelector(".pr-map-k")?.focus();
    };
    div.querySelector(".pr-h-add")?.addEventListener("click", () => addMapRow("headers"));
    div.querySelector(".pr-q-add")?.addEventListener("click", () => addMapRow("query"));

    // key transform (+ catalogue sub-panel appears/vanishes -> rebuild)
    div.querySelector(".pr-keytransform")?.addEventListener("change", (e) => { model.setHttpKeyTransform(id, e.target.value); rebuild(); });
    div.querySelector(".pr-keyencode")?.addEventListener("change", (e) => { model.setHttpKeyEncode(id, e.target.checked); save(); });
    const catMap = { "pr-cat-url": "url", "pr-cat-items": "items_path", "pr-cat-name": "name_path",
                     "pr-cat-key": "key_path", "pr-cat-fuzzy": "fuzzy", "pr-cat-ttl": "ttl_days" };
    for (const [cls, key] of Object.entries(catMap)) {
        div.querySelector(`.${cls}`)?.addEventListener("change", (e) => {
            const v = (key === "fuzzy" || key === "ttl_days") ? parseFloat(e.target.value) || 0 : e.target.value;
            model.setHttpCatalogue(id, { [key]: v }); save();
        });
    }
    div.querySelector(".pr-cat-hints")?.addEventListener("change", (e) => {
        model.setHttpCatalogue(id, { suffix_hints: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) }); save();
    });

    // response mapping
    div.querySelector(".pr-root")?.addEventListener("change", (e) => { model.setHttpRoot(id, e.target.value); save(); });
    // list-mode explode paths — adding/removing the first level flips list mode, so rebuild the body
    div.querySelector(".pr-exp-add")?.addEventListener("click", () => { model.addHttpExplode(id); rebuild(); });
    div.querySelectorAll(".pr-exp-del").forEach((b) => armConfirm(b, () => { model.removeHttpExplode(id, +b.closest(".pr-exp-row").dataset.i); rebuild(); }, { silent: true, resetOnOutside: true }));
    div.querySelectorAll(".pr-exp-v").forEach((el) => el.addEventListener("change", () => { model.setHttpExplode(id, +el.closest(".pr-exp-row").dataset.i, el.value.trim()); save(); }));
    div.querySelector(".pr-f-add")?.addEventListener("click", () => { model.addHttpField(id); rebuild(); });
    div.querySelectorAll(".pr-f-del").forEach((b) => armConfirm(b, () => { model.removeHttpField(id, +b.dataset.i); structural(); }, { silent: true, resetOnOutside: true }));
    div.querySelectorAll(".pr-f-out").forEach((el) => el.addEventListener("change", () => { model.setHttpField(id, fieldI(el), { out_field: el.value.trim() }); structural(); }));
    div.querySelectorAll(".pr-f-path").forEach((el) => el.addEventListener("change", () => { model.setHttpField(id, fieldI(el), { path: el.value }); save(); }));
    div.querySelectorAll(".pr-f-tmpl").forEach((el) => el.addEventListener("change", () => { model.setHttpField(id, fieldI(el), { template: el.value }); save(); }));
    div.querySelectorAll(".pr-f-type").forEach((el) => el.addEventListener("change", () => { model.setHttpField(id, fieldI(el), { type: el.value }); save(); }));
    div.querySelectorAll(".pr-f-req").forEach((el) => el.addEventListener("change", () => { model.setHttpField(id, fieldI(el), { required: el.checked }); save(); }));
    div.querySelectorAll(".pr-f-arr").forEach((el) => el.addEventListener("change", () => { model.toggleHttpFieldArray(id, fieldI(el), el.checked); rebuild(); }));
    div.querySelectorAll(".pr-fa-pluck").forEach((el) => el.addEventListener("change", () => { model.setHttpFieldArray(id, fieldI(el), { pluck: el.value }); save(); }));
    div.querySelectorAll(".pr-fa-agg").forEach((el) => el.addEventListener("change", () => { model.setHttpFieldArray(id, fieldI(el), { agg: el.value }); save(); }));
    div.querySelectorAll(".pr-fa-depth").forEach((el) => el.addEventListener("change", () => { model.setHttpFieldArray(id, fieldI(el), { depth: parseInt(el.value, 10) || 1 }); save(); }));
    // a filter row/button with NO data-i belongs to the producer's row_filter (null), not a field's
    // array reduction — the one place the shared filterList() primitive's two callers diverge.
    const fltI = (el) => (el.dataset.i === undefined ? null : +el.dataset.i);
    div.querySelectorAll(".pr-ff-add").forEach((b) => b.addEventListener("click", () => { model.addHttpFilter(id, fltI(b)); rebuild(); }));
    div.querySelectorAll(".pr-ff-del").forEach((b) => armConfirm(b, () => { model.removeHttpFilter(id, fltI(b), +b.dataset.fi); rebuild(); }, { silent: true, resetOnOutside: true }));
    div.querySelectorAll(".pr-ffilt").forEach((row) => {
        const i = fltI(row), fi = +row.dataset.fi;
        const opSel = row.querySelector(".pr-ff-op"), valIn = row.querySelector(".pr-ff-val");
        row.querySelector(".pr-ff-path")?.addEventListener("change", (e) => { model.setHttpFilter(id, i, fi, { path: e.target.value }); save(); });
        // op and value co-normalize (in/nin take a list), so commit both together
        opSel?.addEventListener("change", () => { model.setHttpFilter(id, i, fi, { op: opSel.value, value: valIn.value }); save(); });
        valIn?.addEventListener("change", () => { model.setHttpFilter(id, i, fi, { op: opSel.value, value: valIn.value }); save(); });
    });

    // which source column names the item (next sweep uses it — no rebuild)
    div.querySelector(".enr-keyfld-sel")?.addEventListener("change", (e) => { model.setProducerSourceField(id, e.target.value); save(); });
    div.querySelector(".pr-srcarray")?.addEventListener("change", (e) => { model.setProducerSourceArray(id, e.target.value); save(); });
    // add an item source via the chip add-select (same input the subset uses)
    div.querySelector(".pr-addsrc")?.addEventListener("change", (e) => {
        if (e.target.value && model.addProducerSource(id, e.target.value)) rebuild();
    });
    // unwire an item source — rebuild the node so the chip goes too, and redraw the edge
    wireArmedRemove(div, ".pr-rmsrc", (val) => { model.removeProducerSource(id, val); rebuild(); });
}

// ---- producer preview satellite: resolved inputs + output schema + live test-fetch ----
// Not polled: fetched once on mount (inputs/columns) and on demand (the test-fetch button).
function wireProducerPreview(div, r) {
    const game = model.profile.name;
    const cols = div.querySelector(".pp-cols");
    const host = div.querySelector(".pp-inputs");
    const result = div.querySelector(".pp-result");
    const btn = div.querySelector(".pp-probe");
    const itemIn = div.querySelector(".pp-item");

    async function loadPreview() {
        try {
            const p = await api.prices.preview(game, r.dataset);
            cols.replaceChildren(h("span", "outputs: "), h("strong", (p.columns || []).join(", ") || "—"));
            const rows = p.inputs || [];
            const list = h("table", { class: "pp-table" },
                h("tr", h("th", "item"), h("th", "→ key")),
                ...rows.map((it) => h("tr", h("td", it.name),
                    h("td", it.key || h("span", { class: "muted" }, "no match")))));
            const cap = p.total > rows.length ? h("p", { class: "muted", style: "padding:4px 8px" }, `showing ${rows.length} of ${p.total}`) : null;
            host.replaceChildren(rows.length ? frag(list, cap) : h("p", { class: "muted", style: "padding:8px" }, "no source items (wire a source dataset in)"));
        } catch (e) { host.replaceChildren(h("p", { class: "muted", style: "padding:8px" }, String(e.message || e))); }
    }

    async function probe() {
        btn.disabled = true; btn.classList.add("reading");
        result.replaceChildren(h("p", { class: "muted", style: "padding:4px 8px" }, "fetching…"));
        try {
            const d = await api.prices.probe(game, r.dataset, itemIn.value.trim());
            if (d.error) { result.replaceChildren(h("p", { class: "err", style: "padding:4px 8px" }, d.error)); return; }
            result.replaceChildren(
                h("div", { class: "pp-kv", style: "padding:4px 8px" },
                    h("div", h("strong", d.name || "—"), " → ", h("code", d.key || "?")),
                    d.url ? h("div", { class: "muted", style: "word-break:break-all" }, d.url) : null),
                h("div", { class: "pp-map", style: "padding:4px 8px" }, h("strong", "mapped: "),
                    h("code", JSON.stringify(d.mapped || {}))),
                h("details", { style: "padding:4px 8px" },
                    h("summary", { class: "muted" }, "raw sample"),
                    h("pre", { class: "pp-raw" }, JSON.stringify(d.sample, null, 1))));
        } catch (e) { result.replaceChildren(h("p", { class: "err", style: "padding:4px 8px" }, String(e.message || e))); }
        finally { btn.disabled = false; btn.classList.remove("reading"); }
    }

    btn?.addEventListener("click", probe);
    itemIn?.addEventListener("keydown", (e) => { if (e.key === "Enter") probe(); });
    queueMicrotask(loadPreview);
}

// ---- trigger node: fires price-node sweeps on a condition -------------------

function wireTrigger(div, n) {
    const t = n.ref;
    div.querySelector(".tgrename")?.addEventListener("change", (e) => {
        const oldId = t.id;
        renameNode(e.target, oldId,
            () => model.renameTrigger(oldId, (e.target.value || "").trim()),
            () => movePos(`trigger:${oldId}`, `trigger:${t.id}`),
            () => { render(); autosave(null); });
    });
    // kind swaps the body (interval/watch blocks) AND the edges, so rebuild this node then re-render
    div.querySelector(".tg-kind")?.addEventListener("change", (e) => {
        model.setTriggerKind(t.id, e.target.value); rebuildNode(n.id); render(); autosave(null);
    });
    div.querySelector(".tg-interval")?.addEventListener("change", (e) => { model.setTriggerInterval(t.id, e.target.value); autosave(null); });
    // rebuildNode (not render) re-renders THIS node's chips — render() only builds NEW nodes,
    // so an in-place chip add/remove wouldn't show. drawEdges() drops/adds the trigger's edges
    // (watch source→trigger and trigger→price) so a chip change reflects on the canvas live.
    div.querySelector(".tg-addwatch")?.addEventListener("change", (e) => { if (model.addTriggerWatch(t.id, e.target.value)) { rebuildNodeEdges(n.id); autosave(null); } });
    // on_readout: watched readouts (chips + edges) + the threshold condition
    div.querySelector(".tg-addvarwatch")?.addEventListener("change", (e) => { if (model.addTriggerReadoutWatch(t.id, e.target.value)) { rebuildNodeEdges(n.id); autosave(null); } });
    wireArmedRemove(div, ".tg-rmvarwatch", (val) => { model.removeTriggerReadoutWatch(t.id, val); rebuildNodeEdges(n.id); autosave(null); });
    div.querySelector(".tg-varop")?.addEventListener("change", (e) => { model.setTriggerReadoutOp(t.id, e.target.value); autosave(null); });
    div.querySelector(".tg-varval")?.addEventListener("change", (e) => { model.setTriggerReadoutValue(t.id, e.target.value); autosave(null); });
    // on_register: watched registers (chips + edges); adding/removing a register changes both the
    // edge AND the body (its condition block appears/vanishes) -> rebuildNodeEdges.
    div.querySelector(".tg-addregwatch")?.addEventListener("change", (e) => { if (model.addTriggerRegisterWatch(t.id, e.target.value)) { rebuildNodeEdges(n.id); autosave(null); } });
    wireArmedRemove(div, ".tg-rmregwatch", (val) => { model.removeTriggerRegisterWatch(t.id, val); rebuildNodeEdges(n.id); autosave(null); });
    // and/or slider between a trigger's key conditions (rebuild so its "and"/"or" label re-renders).
    div.querySelector(".tg-reglogic")?.addEventListener("change", (e) => { model.setTriggerRegisterLogic(t.id, e.target.checked ? "and" : "or"); rebuildNode(n.id); autosave(null); });
    // per-register "+ key" adds a condition (defaults to fire-on-change; the row lets you set when/value).
    div.querySelectorAll(".tg-addcond").forEach((sel) => {
        sel.addEventListener("change", (e) => {
            if (e.target.value && model.addTriggerRegisterCond(t.id, sel.dataset.reg, e.target.value)) { rebuildNode(n.id); autosave(null); }
        });
    });
    // each condition row: key / when / value / armed-remove. key+when rebuild (free-key list + the
    // value input show/hide with the op); value is a plain save; remove is a two-click arm (rule 2).
    div.querySelectorAll(".tg-condrow").forEach((row) => {
        const reg = row.dataset.reg, idx = +row.dataset.idx;
        row.querySelector(".tg-condkey")?.addEventListener("change", (e) => { model.setTriggerRegisterCondKey(t.id, reg, idx, e.target.value); rebuildNode(n.id); autosave(null); });
        row.querySelector(".tg-condwhen")?.addEventListener("change", (e) => { model.setTriggerRegisterCondWhen(t.id, reg, idx, e.target.value); rebuildNode(n.id); autosave(null); });
        row.querySelector(".tg-condval")?.addEventListener("change", (e) => { model.setTriggerRegisterCondValue(t.id, reg, idx, e.target.value); autosave(null); });
        row.querySelector(".tg-condval2")?.addEventListener("change", (e) => { model.setTriggerRegisterCondValue2(t.id, reg, idx, e.target.value); autosave(null); });
        const rm = row.querySelector(".tg-condrm");
        if (rm) {
            const armed = makeArmed({
                onArm: () => row.classList.add("armed"),
                onTimeout: () => row.classList.remove("armed"),
                onFire: () => { row.classList.remove("armed"); model.removeTriggerRegisterCond(t.id, reg, idx); rebuildNode(n.id); autosave(null); },
            });
            rm.addEventListener("click", (e) => { e.stopPropagation(); armed.trigger(); });
        }
    });
    div.querySelector(".tg-addfire")?.addEventListener("change", (e) => { if (model.addTriggerTarget(t.id, e.target.value)) { rebuildNodeEdges(n.id); autosave(null); } });
    wireArmedRemove(div, ".tg-rmwatch", (val) => { model.removeTriggerWatch(t.id, val); rebuildNodeEdges(n.id); autosave(null); });
    wireArmedRemove(div, ".tg-rmtarget", (val) => { model.removeTriggerTarget(t.id, val); rebuildNodeEdges(n.id); autosave(null); });
    // throttle: minimum ms between fires (empty = none). Rebuild so the input re-normalises (null -> placeholder).
    div.querySelector(".tg-throttle")?.addEventListener("change", (e) => { model.setTriggerThrottle(t.id, e.target.value); rebuildNode(n.id); autosave(null); });
    // settle: trailing debounce (empty = fire now). Rebuild so the max-cap input appears/hides with it.
    div.querySelector(".tg-settle")?.addEventListener("change", (e) => { model.setTriggerSettle(t.id, e.target.value); rebuildNode(n.id); autosave(null); });
    div.querySelector(".tg-settlemax")?.addEventListener("change", (e) => { model.setTriggerSettleMax(t.id, e.target.value); rebuildNode(n.id); autosave(null); });
    div.querySelector(".tg-fire")?.addEventListener("click", async () => {
        const prog = div.querySelector(".tg-prog");
        prog.textContent = "firing…";
        try { const r = await api.triggers.fire(model.profile.name, t.id); const n = (r.started || []).length, sk = (r.skipped || []).length; prog.textContent = n ? `fired ${n} target(s)` : sk ? `already sweeping (${sk} skipped)` : "no targets to fire"; refreshLive(); hub.kick(); }
        catch (err) { prog.textContent = String(err.message || err); }
    });
    // fill the history satellite when it's open (this runs on every render, incl. right after the
    // satellite is toggled on — the parent trigger rebuilds and populates its follower, exactly like
    // a dataset/subset fills its vt-table satellite). No-op when the satellite is hidden.
    renderTriggerHistory(t.id);
}

// ---- action node: clear / clone / move a dataset's data when fired ----------

function wireAction(div, n) {
    const x = n.ref;
    const $ = (sel) => div.querySelector(sel);
    $(".acrename")?.addEventListener("change", (e) => {
        const oldId = x.id;
        renameNode(e.target, oldId,
            () => model.renameAction(oldId, (e.target.value || "").trim()),
            () => movePos(`action:${oldId}`, `action:${x.id}`),
            () => { render(); autosave(null); });
    });
    // action kind: rebuild so the dest select + slot rows show/hide; edges follow (dest edge)
    $(".ac-action")?.addEventListener("change", (e) => { model.setActionKind(x.id, e.target.value); rebuildNodeEdges(n.id); autosave(null); });
    // sources: datasets AND registers, by prefixed ref (value carries "dataset:"/"register:")
    $(".ac-addsrc")?.addEventListener("change", (e) => { if (model.addActionSource(x.id, e.target.value)) { rebuildNodeEdges(n.id); autosave(null); } });
    wireArmedRemove(div, ".ac-rmsrc", (val) => { model.removeActionSource(x.id, val); rebuildNodeEdges(n.id); autosave(null); });
    // slot targeting: one row per register source (shared reg_slots primitive, rule 7) — each scoped
    // to its register via data-reg so the add/remove edits know which register's key set they narrow.
    wireSlotRows(div, {
        keysFor: (regId) => model.registerSources(regId).filter((s) => s.kind === "readout").map((s) => s.id),
        get: (regId) => model.actionSlots(x.id, regId),
        set: (regId, keys) => model.setActionSlots(x.id, regId, keys),
        after: () => { rebuildNode(n.id); autosave(null); },
    });
    $(".ac-dest")?.addEventListener("change", (e) => { model.setActionDest(x.id, e.target.value); drawEdges(); autosave(null); });
    // manual fire: run the action NOW on its target dataset(s) via the same funnel a trigger uses.
    // Transient feedback by swapping the button label (no progress line on the node).
    $(".ac-fire")?.addEventListener("click", async (e) => {
        const btn = e.currentTarget; btn.disabled = true; btn.textContent = "firing…";
        try {
            const r = await api.actions.fire(model.profile.name, x.id);
            btn.textContent = r.ran ? "fired ✓" : "no-op";
            refreshLive();   // dataset sources: refetch /api/flow. register sources aren't in flow, so
            // repaint each register this action touches directly (clear/move mutate the in-memory held
            // map server-side but publish no dataset-change push, so refreshLive would never reach them).
            for (const s of model.actionSources(x.id)) if (s.kind === "register") refreshRegister(s.id);
        }
        catch (err) { btn.textContent = String(err.message || err); }
        finally { setTimeout(() => { btn.textContent = "↻ fire"; btn.disabled = false; }, 1500); }
    });
}

// ---- register node: hold wired readouts' live values in an in-memory keyed map --------

function wireRegister(div, n) {
    const x = n.ref;
    const $ = (sel) => div.querySelector(sel);
    $(".regrename")?.addEventListener("change", (e) => {
        const oldId = x.id;
        renameNode(e.target, oldId,
            () => model.renameRegister(oldId, (e.target.value || "").trim()),
            () => movePos(`register:${oldId}`, `register:${x.id}`),
            () => {
                render(); autosave(null);
                // the held map lives server-side keyed by the OLD id (LiveSession._registers) — carry
                // it to the new id, then repaint; without this the renamed node reads empty until the
                // next collector tick happens to repopulate it from readouts.
                api.renameRegister(model.profile.name, oldId, x.id)
                    .catch(() => {})
                    .finally(() => refreshRegister(x.id));
            });
    });
    // sources live IN the memory bank now: each held-value slot is a wired readout (trash to remove,
    // click to pan to its node) and the trailing "+" slot adds one. The bank (register_node.js)
    // dispatches those as bubbling intents on the `.data-host`; we own the model mutation + edge
    // redraw + autosave, then repaint the bank (a newly wired readout appears as a pending slot at
    // once, same path the out-port drag uses). Scoped to `.data-host` (rebuilt on every render) so the
    // listeners never double up across rebuilds.
    const bankHost = $(".data-host");
    // membank grows/shrinks a slot async (its ResizeObserver -> layout settles next frame), so defer
    // the edge redraw a frame — else the readout->register edge anchors on the register's stale size.
    bankHost?.addEventListener("reg-add-source", (e) => {
        if (model.addRegisterSource(e.detail.id, e.detail.ref)) { refreshRegister(e.detail.id); requestAnimationFrame(drawEdges); autosave(null); }
    });
    bankHost?.addEventListener("reg-remove-source", (e) => {
        model.removeRegisterSource(e.detail.id, e.detail.ref); refreshRegister(e.detail.id); requestAnimationFrame(drawEdges); autosave(null);
    });
    // ring depth per key: coerce (blank -> 1) then rebuild so the normalised value re-renders.
    $(".reg-cap")?.addEventListener("change", (e) => { model.setRegisterCapacity(x.id, e.target.value); rebuildNode(n.id); autosave(null); });
    // ring aggregate (shown only when capacity > 1): nothing structural changes — the native select
    // already shows the pick — so DON'T rebuild the node body; just refetch so the membank's summary
    // line repaints with the new fold (the server folds off the passed mode).
    $(".reg-agg")?.addEventListener("change", (e) => { model.setRegisterAggregate(x.id, e.target.value); refreshRegister(x.id); autosave(null); });
    // ignore-empty toggle: pure server-side write behaviour, no re-render needed.
    $(".reg-ignoreempty")?.addEventListener("change", (e) => { model.setRegisterIgnoreEmpty(x.id, e.target.checked); autosave(null); });
    // clear the held map server-side (armed two-click, no blocking dialog). Values live only in the
    // running session, so this just empties that map; the table repopulates as readouts are read.
    const clearBtn = $(".regclear");
    clearBtn?.addEventListener("click", async () => {
        if (clearBtn.dataset.armed !== "1") {
            clearBtn.dataset.armed = "1"; clearBtn.textContent = "confirm?";
            setTimeout(() => { clearBtn.dataset.armed = "0"; clearBtn.textContent = "clear data"; }, 2500);
            return;
        }
        clearBtn.dataset.armed = "0"; clearBtn.textContent = "clear data";
        try {
            await withBusy([n.id], () => api.clearRegister(model.profile.name, x.id));
            refreshRegister(x.id);
            setStatus(`cleared ${x.id}`);
        } catch (e) { setStatus(String(e.message || e)); }
    });
    // show the persisted map + wired-source slots. wireRegister runs INSIDE buildNode, before the
    // node is mounted (added to nodeEls/layer), so refreshRegister would no-op if called here
    // directly. queueMicrotask defers past the synchronous render()/buildNode chain -> the node is
    // mounted by the time this fires, on initial boot, a post-boot rebuild, AND undo/redo restore
    // (afterBoot alone missed the restore case: it runs synchronously once boot.phase is false).
    queueMicrotask(() => refreshRegister(x.id));
}

// ---- file-source node: parse a game log/config file into its dataset --------

function wireSource(div, n) {
    const s = n.ref;
    const $ = (sel) => div.querySelector(sel);

    // The parse preview now lives in the source's opt-in data-table satellite (vt:src:<id>), not the
    // node body — edits refresh it through refreshSourcePreview (a no-op when the satellite is hidden,
    // so a closed table costs nothing). Edit-driven + debounced — NEVER a poll/timer (steady-state-
    // zero-DOM rule); the only redraws are user edits. The satellite's own build kicks the first read.
    let pvTimer = null;
    const schedulePreview = () => { clearTimeout(pvTimer); pvTimer = setTimeout(() => refreshSourcePreview(s.id), 300); };

    $(".srcrename")?.addEventListener("change", (e) => {
        const oldId = s.id;
        renameNode(e.target, oldId,
            () => model.renameFileSource(oldId, (e.target.value || "").trim()),
            () => movePos(`src:${oldId}`, `src:${s.id}`),
            () => { render(); autosave(null); });
    });
    // format/watch swap the body (extraction UI / throttle / tail) -> rebuild then re-preview
    $(".src-format")?.addEventListener("change", (e) => { model.setSourceFormat(s.id, e.target.value); rebuildNode(n.id); autosave(null); });
    $(".src-watch")?.addEventListener("change", (e) => { model.setSourceProp(s.id, "watch", e.target.value); rebuildNode(n.id); autosave(null); });
    // plain edits: store + preview, no rebuild (keep input focus)
    $(".src-filename")?.addEventListener("change", (e) => { model.setSourceProp(s.id, "filename", e.target.value); autosave(null); schedulePreview(); });
    $(".src-path")?.addEventListener("change", (e) => { model.setSourceProp(s.id, "path", e.target.value); autosave(null); schedulePreview(); });
    $(".src-throttle")?.addEventListener("change", (e) => { model.setSourceProp(s.id, "throttle_s", e.target.value); autosave(null); });
    // slide toggles are native checkboxes now — the new state is `.checked` after the change event
    const flipSlide = (e) => { e.stopPropagation(); return e.currentTarget.checked; };
    // tail on/off rebuilds the node so the "tail lines" count input shows/hides with it
    $(".src-tail")?.addEventListener("change", (e) => { model.setSourceProp(s.id, "tail", flipSlide(e)); rebuildNode(n.id); autosave(null); schedulePreview(); });
    $(".src-taillines")?.addEventListener("change", (e) => {
        const v = parseInt(e.target.value, 10);
        model.setSourceProp(s.id, "tail_lines", Number.isNaN(v) || v < 1 ? 1 : v);
        autosave(null); schedulePreview();
    });
    $(".src-linepos")?.addEventListener("change", (e) => { model.setSourceProp(s.id, "line_position", flipSlide(e)); autosave(null); });

    // line filters (match clauses). add/remove change the parse output, so they refresh the preview
    // too — not just the inline edits below (the bug was removals leaving the preview stale).
    $(".src-addm")?.addEventListener("click", () => { model.addSourceMatch(s.id); rebuildNode(n.id); autosave(null); schedulePreview(); });
    div.querySelectorAll(".src-rmm").forEach((b) => armConfirm(b, () => { model.removeSourceMatch(s.id, +b.dataset.i); rebuildNode(n.id); autosave(null); schedulePreview(); }, { silent: true, resetOnOutside: true }));
    div.querySelectorAll(".mset").forEach((inp) => inp.addEventListener("change", (e) => {
        model.setSourceMatch(s.id, +e.target.dataset.i, e.target.dataset.k,
            e.target.type === "checkbox" ? e.target.checked : e.target.value);
        autosave(null); schedulePreview();
    }));

    // extraction fields. add/remove change which columns the parse emits -> refresh the preview too.
    $(".src-addf")?.addEventListener("click", () => { model.addSourceField(s.id); rebuildNode(n.id); autosave(null); schedulePreview(); });
    div.querySelectorAll(".src-rmf").forEach((b) => armConfirm(b, () => { model.removeSourceField(s.id, +b.dataset.i); rebuildNode(n.id); autosave(null); schedulePreview(); }, { silent: true, resetOnOutside: true }));
    div.querySelectorAll(".fset2").forEach((inp) => inp.addEventListener("change", (e) => {
        const k = e.target.dataset.k;
        model.setSourceFieldProp(s.id, +e.target.dataset.i, k,
            e.target.type === "checkbox" ? e.target.checked : e.target.value);
        if (k === "method") { rebuildNode(n.id); autosave(null); schedulePreview(); }   // method swaps its own inputs + changes the parse
        else { autosave(null); schedulePreview(); }
    }));
    // show the ␣ flag live while a delimiter holds a whitespace-only value (else it looks empty)
    div.querySelectorAll(".src-delim").forEach((inp) => inp.addEventListener("input", (e) => {
        const ws = e.target.value.length > 0 && e.target.value.trim() === "";
        e.target.closest(".src-delim-wrap")?.classList.toggle("has-ws", ws);
    }));
    // per-field "required" gn-slide — flips whether an invalid value dismisses the row; re-preview
    div.querySelectorAll(".src-req").forEach((tog) => tog.addEventListener("change", (e) => {
        const on = flipSlide(e);
        model.setSourceFieldProp(s.id, +e.currentTarget.dataset.i, "required", on);
        autosave(null); schedulePreview();
    }));

    // auto-find the file across generic OS locations — opens a modal that runs the search,
    // lists hits, previews a clicked file's contents, and pins the chosen one as the path.
    $(".src-find")?.addEventListener("click", () => openFindModal($, s, schedulePreview));
    // read the file now (writes to the dataset). The read runs in the BACKGROUND server-side (a big
    // log can take many seconds) — the request returns at once and the rows stream into the dataset
    // live via the change bus, so there's nothing to spin on or cancel here. Progress goes to the
    // log bar (the node carries no progress strip anymore), so it reads alongside every other event.
    $(".src-read")?.addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        try {
            const r = await api.sources.read(model.profile.name, s.id);
            log(r.busy ? `${s.id}: already reading…`
                : `${s.id}: reading → ${s.dataset || "(no dataset)"}, rows fill in live`, r.busy ? "warn" : "run");
        } catch (err) {
            log(`${s.id}: ${err.message || err}`, "err");
        } finally {
            btn.disabled = false;
        }
    });
    // "auto-resolve" inspects the file's data and proposes extraction columns the user then refines
    $(".src-resolve")?.addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        const done = timed(`${s.id}: auto-resolve`);
        try {
            const r = await api.sources.resolve(model.profile.name, s);
            const fields = r.fields || [];
            const added = model.mergeSourceFields(s.id, fields);   // append-only: never drops existing fields
            if (!added) { done(`(${fields.length ? "nothing new" : (r.note || "no columns found")})`, "warn"); return; }
            rebuildNode(n.id); autosave(null);
            done(`(+${added} field${added === 1 ? "" : "s"})`, "ok");
            showSatellite(`vt:src:${s.id}`); refreshSourcePreview(s.id);
        } catch (err) {
            done(String(err.message || err), "err");
        } finally {
            btn.disabled = false;
        }
    });
}

// Refresh a file source's parse-preview satellite (vt:src:<id>): re-run the live preview and render
// its rows + count line into the satellite. A no-op when the satellite is hidden (no node to fill).
// singleFlight per source so a burst of edits coalesces and the LATEST request wins (never dropped).
function refreshSourcePreview(id) { singleFlight(`srcpv:${id}`, () => _refreshSourcePreview(id)); }
// ONE preview fetch feeds BOTH satellites: vt:src (kept rows) and vtd:src (rows a required field
// dismissed). Either may be hidden — we just skip the missing host. No-op when neither is shown.
async function _refreshSourcePreview(id) {
    const kept = nodeEls.get(`vt:src:${id}`);
    const dism = nodeEls.get(`vtd:src:${id}`);
    if ((!kept && !dism) || !model.profile.name) return;
    const s = model.fileSource(id);
    if (!s) return;
    // render one satellite's host from a row list + a meta line
    const fill = (node, vtId, rows, meta, empty) => {
        if (!node) return;
        const host = node.querySelector(".src-host"), info = node.querySelector(".src-prev-info");
        if (!host) return;
        if (rows.length) renderPreview(host, rows);
        else host.replaceChildren(h("p", { class: "muted", style: "padding:8px" }, empty));
        if (info) info.textContent = meta;
    };
    if (kept) setNodeBusy(`vt:src:${id}`, true);
    if (dism) setNodeBusy(`vtd:src:${id}`, true);
    try {
        const r = await api.sources.preview(model.profile.name, s);
        const rows = r.rows || [], dropped = r.dismissed || [];
        const le = r.line_ending ? ` · ${r.line_ending}` : "";
        const noFile = r.path === null && !rows.length && !dropped.length;
        fill(kept, `vt:src:${id}`, rows,
            noFile ? (r.note || "file not found") : `${r.matched} row(s) · ${r.total} line(s)${le}`,
            r.note || "no rows");
        fill(dism, `vtd:src:${id}`, dropped,
            noFile ? (r.note || "file not found") : `${r.dismissed_count ?? dropped.length} dismissed · ${r.total} line(s)${le}`,
            "no dismissed rows — every matched line passed its required fields");
    } catch (e) {
        const msg = String(e.message || e);
        for (const node of [kept, dism]) if (node) {
            const host = node.querySelector(".src-host"), info = node.querySelector(".src-prev-info");
            if (info) info.textContent = msg;
            host?.replaceChildren(h("p", { class: "muted", style: "padding:8px" }, msg));
        }
    } finally {
        if (kept) setNodeBusy(`vt:src:${id}`, false);
        if (dism) setNodeBusy(`vtd:src:${id}`, false);
    }
}

// Auto-find picker (modal): runs the search, lists hits on the left, previews a clicked file's
// contents on the right, and pins the chosen one as the explicit path. Closing the modal aborts
// the search AND any in-flight content peek (handle.signal + onClose). All user-driven — never a
// poll/tick, so a full rebuild per click is fine.
function openFindModal($, s, schedulePreview) {
    if (!model.profile.name) return;
    const listEl = h("div", { class: "find-list" }, h("div", { class: "find-status muted" }, "searching…"));
    const viewEl = h("div", { class: "find-view" }, h("div", { class: "find-status muted" }, "select a file to preview its contents"));
    const wrap = h("div", { class: "find-modal" }, listEl, viewEl);

    let viewCtl = null;
    const handle = openModal({
        title: `auto-find${s.filename ? ": " + s.filename : ""}`, size: "large",
        node: wrap, onClose: () => viewCtl?.abort(),    // handle.signal aborts find; this aborts the peek
    });

    const choose = (path) => {
        model.setSourceProp(s.id, "path", path);
        const pin = $(".src-path"); if (pin) pin.value = path;
        const found = $(".src-found"); if (found) found.textContent = path;
        autosave(null); schedulePreview();
        handle.close();
    };

    async function showFile(c, btn) {
        listEl.querySelectorAll(".find-item.sel").forEach((x) => x.classList.remove("sel"));
        btn.classList.add("sel");
        viewCtl?.abort(); viewCtl = new AbortController();
        viewEl.replaceChildren(
            h("div", { class: "find-vhead" },
                h("span", { class: "find-vpath" }, c.path),
                h("button", { class: "find-use", onClick: () => choose(c.path) }, "use this file")),
            h("pre", { class: "find-pre muted" }, "loading…"));
        try {
            const r = await api.sources.peek(model.profile.name, c.path, viewCtl.signal);
            const pre = viewEl.querySelector(".find-pre");
            pre.classList.remove("muted");
            pre.textContent = (r.text || "") + (r.truncated ? "\n…(truncated)" : "");
        } catch (e) {
            if (e.name === "AbortError") return;
            const pre = viewEl.querySelector(".find-pre"); if (pre) pre.textContent = String(e.message || e);
        }
    }

    (async () => {
        try {
            const r = await api.sources.find(model.profile.name, { filename: s.filename, roots: s.roots }, handle.signal);
            const cands = r.candidates || [];
            if (!cands.length) { listEl.replaceChildren(h("div", { class: "find-status muted" }, "none found")); return; }
            listEl.replaceChildren(...cands.slice(0, 50).map((c) => {
                const b = h("button", { class: "find-item" },
                    h("span", { class: "find-path" }, c.path),
                    h("span", { class: "find-meta muted" }, `${(c.size / 1024).toFixed(0)} KB · ${since(new Date(c.mtime * 1000).toISOString())}`));
                b.addEventListener("click", () => showFile(c, b));
                return b;
            }));
        } catch (e) {
            if (e.name === "AbortError") return;
            listEl.replaceChildren(h("div", { class: "find-status muted" }, String(e.message || e)));
        }
    })();
}

// small read-only preview table (capped) of the rows the current rules produce. Edit-driven
// (never a steady-state tick), so a full rebuild here is fine.
const SRC_LINE_COL = "__line__";   // preview-only column carrying the raw source line (see sources route)
function renderPreview(host, rows) {
    if (!host) return;
    if (!rows.length) { host.replaceChildren(); return; }
    const cols = [];
    for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
    // show the raw source line FIRST (traces a row back to its file line), with a friendly header
    // and a muted monospace look — it's context, not an extracted field.
    const li = cols.indexOf(SRC_LINE_COL);
    if (li >= 0) { cols.splice(li, 1); cols.unshift(SRC_LINE_COL); }
    const isLine = (c) => c === SRC_LINE_COL;
    const cap = 50;
    host.replaceChildren(h("table", { class: "src-ptab" },
        h("thead", h("tr", cols.map((c) => h("th", { class: isLine(c) ? "src-pline" : "" }, isLine(c) ? "line" : c)))),
        h("tbody", rows.slice(0, cap).map((r) =>
            h("tr", cols.map((c) => h("td", { class: isLine(c) ? "src-pline" : "" }, r[c] == null ? "" : String(r[c]))))))));
}

export {
    wireProducer, wireProducerPreview, wireTrigger, wireAction, wireRegister, wireSource,
    refreshSourcePreview,
};
