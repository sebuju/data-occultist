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
import { persist } from "./persist.js";
import { h, frag } from "../dom.js";
import { renameNode, movePos } from "./node_lifecycle.js";
import { drawEdges } from "./routing.js";
import { singleFlight } from "../singleflight.js";
import { openModal } from "../modal.js";
import { since } from "../datefmt.js";
import { log, timed } from "../log.js";
import { wireProducerNode, mapRow } from "./producer_node.js";
import { renderTriggerHistory } from "./history_node.js";
import { renderInputLog } from "./input_log_node.js";
import { refreshRegister, populateRegister, REG_AGGREGATES, AGG_DESC } from "./register_node.js";
import { KIND_GROUPS, KIND_DESC, INPUT_EVENTS, INPUT_EVENT_DESC } from "./trigger_node.js";
import { ACTIONS, ACTION_DESC, REG_OPS, REG_OP_DESC } from "./action_node.js";
import {
    FORMATS, FORMAT_DESC, OPS, OP_DESC, METHODS, METHOD_DESC,
    SRC_FIELD_TYPES, FIELD_TYPE_DESC, WATCH_MODES, WATCH_DESC,
} from "./source_node.js";
import {
    PRODUCER_TYPES, PRODUCER_TYPE_DESC, AGG_OPS, AGG_OP_DESC, FILTER_OPS, FILTER_OP_DESC,
    KEY_TRANSFORMS, KEY_TRANSFORM_DESC, QUEUE_MODES, QUEUE_MODE_DESC,
    HTTP_METHODS, HTTP_METHOD_DESC, PR_FIELD_TYPES, PR_FIELD_TYPE_DESC,
} from "./producer_node.js";
import { PROCESS_TYPES, PROCESS_TYPE_DESC } from "./process_node.js";
import { GATE_WHENS, GATE_WHEN_DESC } from "./gate_node.js";
import { richPickerPop } from "./rich_picker.js";
import { comboPopover } from "./combo_popover.js";
import { renderProcessHistory } from "./process_history_node.js";
import { wireKeyRows, wireRegWriteRows } from "./reg_slots.js";
import { makeArmed } from "./armbtn.js";
import { refreshDataNode, loadBatchesNode } from "./panels/datanodes.js";
import { refreshImageBoxes } from "./imaging.js";
import {
    render, autosave, rebuildNode, rebuildNodeEdges, refreshLive, wireArmedRemove,
    withBusy, setNodeBusy, showSatellite, armConfirm, rulesEdit, wireFieldRules,
} from "./main.js";

// ---- producer node: fetches external data into its output dataset -----------

function wireProducer(div, n) {
    const id = n.ref.id;
    const save = () => autosave(null);                       // value-only edit
    const rebuild = () => { rebuildNodeEdges(n.id); autosave(null); };   // body/edges change (measured anchor)
    const structural = () => { rebuildNode(n.id); render(); autosave(null); };  // output columns change -> rebuild THIS body (removed row) + refresh downstream
    const fieldI = (el) => +el.closest(".pr-field").dataset.i;
    // a plain string-valued enum picker (value === label) — mirrors sel()/producer_node.js.
    // `after` runs once the model is updated (save/rebuild/structural, matching each old `change`).
    const enumBtn = (btn, current, opts, descs, onPick) => {
        richPickerPop({
            anchor: btn, current,
            groups: [[null, opts.map((v) => ({ value: v, label: v, meta: (descs && descs[v]) || "" }))]],
            onPick: (v) => { onPick(v); btn.textContent = `<${v}>`; },
        });
    };
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
    div.querySelector(".prtype")?.addEventListener("click", (e) => {
        const btn = e.currentTarget;
        enumBtn(btn, n.ref.type || "http", PRODUCER_TYPES, PRODUCER_TYPE_DESC, (v) => { model.setProducerType(id, v); structural(); });
    });
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
    div.querySelector(".pr-queuemode")?.addEventListener("click", (e) => {
        enumBtn(e.currentTarget, n.ref.queue_mode || "drop", QUEUE_MODES, QUEUE_MODE_DESC, (v) => { model.setProducerQueueMode(id, v); save(); });
    });
    div.querySelector(".pr-mode")?.addEventListener("change", (e) => { model.setProducerMode(id, e.target.value); save(); });

    // request
    div.querySelector(".pr-method")?.addEventListener("click", (e) => {
        enumBtn(e.currentTarget, (n.ref.http || {}).request?.method || "GET", HTTP_METHODS, HTTP_METHOD_DESC, (v) => { model.setHttpMethod(id, v); save(); });
    });
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
    div.querySelector(".pr-keytransform")?.addEventListener("click", (e) => {
        enumBtn(e.currentTarget, (n.ref.http || {}).key_transform || "slugify", KEY_TRANSFORMS, KEY_TRANSFORM_DESC, (v) => { model.setHttpKeyTransform(id, v); rebuild(); });
    });
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
    div.querySelectorAll(".pr-f-type").forEach((btn) => btn.addEventListener("click", (e) => {
        const b = e.currentTarget, i = fieldI(b);
        const cur = ((n.ref.http || {}).fields || [])[i]?.type || "text";
        enumBtn(b, cur, PR_FIELD_TYPES, PR_FIELD_TYPE_DESC, (v) => { model.setHttpField(id, i, { type: v }); save(); });
    }));
    div.querySelectorAll(".pr-f-req").forEach((el) => el.addEventListener("change", () => { model.setHttpField(id, fieldI(el), { required: el.checked }); save(); }));
    div.querySelectorAll(".pr-f-arr").forEach((el) => el.addEventListener("change", () => { model.toggleHttpFieldArray(id, fieldI(el), el.checked); rebuild(); }));
    div.querySelectorAll(".pr-fa-pluck").forEach((el) => el.addEventListener("change", () => { model.setHttpFieldArray(id, fieldI(el), { pluck: el.value }); save(); }));
    div.querySelectorAll(".pr-fa-agg").forEach((btn) => btn.addEventListener("click", (e) => {
        const b = e.currentTarget, i = fieldI(b);
        const cur = ((n.ref.http || {}).fields || [])[i]?.array?.agg || "min";
        enumBtn(b, cur, AGG_OPS, AGG_OP_DESC, (v) => { model.setHttpFieldArray(id, i, { agg: v }); save(); });
    }));
    div.querySelectorAll(".pr-fa-depth").forEach((el) => el.addEventListener("change", () => { model.setHttpFieldArray(id, fieldI(el), { depth: parseInt(el.value, 10) || 1 }); save(); }));
    // a filter row/button with NO data-i belongs to the producer's row_filter (null), not a field's
    // array reduction — the one place the shared filterList() primitive's two callers diverge.
    const fltI = (el) => (el.dataset.i === undefined ? null : +el.dataset.i);
    div.querySelectorAll(".pr-ff-add").forEach((b) => b.addEventListener("click", () => { model.addHttpFilter(id, fltI(b)); rebuild(); }));
    div.querySelectorAll(".pr-ff-del").forEach((b) => armConfirm(b, () => { model.removeHttpFilter(id, fltI(b), +b.dataset.fi); rebuild(); }, { silent: true, resetOnOutside: true }));
    div.querySelectorAll(".pr-ffilt").forEach((row) => {
        const i = fltI(row), fi = +row.dataset.fi;
        const opBtn = row.querySelector(".pr-ff-op"), valIn = row.querySelector(".pr-ff-val");
        row.querySelector(".pr-ff-path")?.addEventListener("change", (e) => { model.setHttpFilter(id, i, fi, { path: e.target.value }); save(); });
        // op and value co-normalize (in/nin take a list), so commit both together
        opBtn?.addEventListener("click", (e) => {
            const cur = opBtn.textContent.replace(/^<|>$/g, "");
            enumBtn(e.currentTarget, cur, FILTER_OPS, FILTER_OP_DESC, (v) => { model.setHttpFilter(id, i, fi, { op: v, value: valIn.value }); save(); });
        });
        valIn?.addEventListener("change", () => { model.setHttpFilter(id, i, fi, { op: opBtn.textContent.replace(/^<|>$/g, ""), value: valIn.value }); save(); });
    });

    // which source column names the item (next sweep uses it — no rebuild)
    div.querySelector(".enr-keyfld-sel")?.addEventListener("click", (e) => {
        const btn = e.currentTarget;
        const nf = n.ref.source_field || "name";
        const cols = model.producerSourceColumns(n.ref);
        richPickerPop({
            anchor: btn, current: nf,
            groups: [[null, [...new Set([nf, ...cols])].map((c) => ({ value: c, label: c }))]],
            onPick: (v) => { model.setProducerSourceField(id, v); btn.textContent = `<${v}>`; save(); },
        });
    });
    div.querySelector(".pr-srcarray")?.addEventListener("change", (e) => { model.setProducerSourceArray(id, e.target.value); save(); });
    div.querySelector(".pr-identity")?.addEventListener("click", (e) => {
        const btn = e.currentTarget;
        const nf = n.ref.source_field || "name";
        const idf = n.ref.identity_field || "";
        const cols = model.producerSourceColumns(n.ref);
        richPickerPop({
            anchor: btn, current: idf,
            groups: [[null, [
                { value: "", label: nf, meta: "same as 'name by'" },
                ...[...new Set([idf, ...cols].filter(Boolean))].map((c) => ({ value: c, label: c })),
            ]]],
            onPick: (v) => {
                model.setProducerIdentityField(id, v);
                btn.textContent = v === "" ? `<${nf}>` : `<${v}>`;
                save();
            },
        });
    });
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
    // kind swaps the body (interval/watch blocks) AND the edges, so rebuild this node then re-render.
    // Grouped rich popover (rich_picker.js), same shape as the register aggregate fold — each kind's
    // meaning shows as a meta line while browsing (native <option title> tooltips don't render
    // cross-browser).
    div.querySelector(".tg-kind-btn")?.addEventListener("click", (e) => {
        richPickerPop({
            anchor: e.currentTarget, current: t.kind,
            groups: KIND_GROUPS.map(([grp, opts]) =>
                [grp, opts.map(([v, lbl]) => ({ value: v, label: lbl, meta: KIND_DESC[v] || "" }))]),
            onPick: (v) => { model.setTriggerKind(t.id, v); rebuildNode(n.id); render(); autosave(null); },
        });
    });
    div.querySelector(".tg-interval")?.addEventListener("change", (e) => { model.setTriggerInterval(t.id, e.target.value); autosave(null); });
    // on_input: chord + window/rect bind. Event/window/double rebuild (their presence/value shows
    // or hides other fields — the double-window input, the rect row); button/mods/rect just save.
    div.querySelector(".tg-inevent")?.addEventListener("click", (e) => {
        const btn = e.currentTarget;
        richPickerPop({
            anchor: btn, current: t.input_event,
            groups: [[null, INPUT_EVENTS.map(([v, l]) => ({ value: v, label: l, meta: INPUT_EVENT_DESC[v] || "" }))]],
            onPick: (v) => { model.setTriggerInputEvent(t.id, v); rebuildNode(n.id); autosave(null); },
        });
    });
    div.querySelector(".tg-inbutton")?.addEventListener("change", (e) => { model.setTriggerInputButton(t.id, e.target.value); autosave(null); });
    div.querySelector(".tg-inmods")?.addEventListener("change", (e) => {
        model.setTriggerInputMods(t.id, e.target.value.split(",").map((s) => s.trim())); autosave(null);
    });
    div.querySelector(".tg-indouble")?.addEventListener("change", (e) => { model.setTriggerInputDoubleMs(t.id, e.target.value); autosave(null); });
    // window bind also draws a trigger->window edge (model.edges) and, once a rect is set, an
    // overlay box on that window (refreshImageBoxes) — refresh both the old and new window's
    // canvas (refreshImageBoxes is a no-op if that window isn't open) so the box moves with it.
    div.querySelector(".tg-inwindow")?.addEventListener("click", (e) => {
        const btn = e.currentTarget;
        const winMeta = (w) => `${(w.items || []).length} item template(s), ${(w.detect || []).length} detector(s)`;
        richPickerPop({
            anchor: btn, current: t.input_window || "",
            groups: [[null, [{ value: "", label: "(any)", meta: "fire regardless of the recognized window" },
                ...(model.profile.windows || []).map((w) => ({ value: w.id, label: w.id, meta: winMeta(w) }))]]],
            onPick: (v) => {
                const prevWin = t.input_window;
                model.setTriggerInputWindow(t.id, v);
                rebuildNode(n.id);
                rebuildNodeEdges(n.id);
                if (prevWin) refreshImageBoxes(prevWin);
                if (t.input_window) refreshImageBoxes(t.input_window);
                autosave(null);
            },
        });
    });
    const inRect = () => model.setTriggerInputRect(t.id,
        [".tg-inrx", ".tg-inry", ".tg-inrw", ".tg-inrh"].map((sel) => div.querySelector(sel)?.value ?? ""));
    const inRectChanged = () => { inRect(); autosave(null); if (t.input_window) refreshImageBoxes(t.input_window); };
    div.querySelector(".tg-inrx")?.addEventListener("change", inRectChanged);
    div.querySelector(".tg-inry")?.addEventListener("change", inRectChanged);
    div.querySelector(".tg-inrw")?.addEventListener("change", inRectChanged);
    div.querySelector(".tg-inrh")?.addEventListener("change", inRectChanged);
    // "listen": arm the button, capture the NEXT keydown/mousedown (incl. held modifiers) into the
    // button field, then disarm. No blocking dialog (rule 2) — just an .armed class on the icon
    // button while armed; Escape cancels. preventDefault so the captured key/click never reaches
    // the page underneath.
    div.querySelector(".tg-inlisten")?.addEventListener("click", (e) => {
        const btn = e.currentTarget;
        const input = div.querySelector(".tg-inbutton");
        btn.classList.add("armed");
        btn.disabled = true;
        const finish = (token) => {
            document.removeEventListener("keydown", onKey, true);
            document.removeEventListener("mousedown", onMouse, true);
            document.removeEventListener("contextmenu", onCtx, true);
            btn.classList.remove("armed");
            btn.disabled = false;
            if (token) { input.value = token; model.setTriggerInputButton(t.id, token); autosave(null); }
        };
        // Named-key translation to the SAME token vocabulary oc.input.win32_hook's _key_name
        // produces (VK-derived), so a browser-captured bind matches the live hook's events.
        // Letters/digits/punctuation already agree (both lowercase the printable char).
        const NAMED_KEYS = {
            Escape: "esc", " ": "space", ArrowLeft: "left", ArrowUp: "up", ArrowRight: "right",
            ArrowDown: "down", PageUp: "pageup", PageDown: "pagedown",
        };
        const MOD_KEYS = { Control: "ctrl", Shift: "shift", Alt: "alt", Meta: "win" };
        const onKey = (ev) => {
            ev.preventDefault(); ev.stopPropagation();
            if (ev.key === "Escape") return finish(null);
            if (MOD_KEYS[ev.key]) return;   // a bare modifier arms the chord but isn't itself the button
            const name = NAMED_KEYS[ev.key] || ev.key.toLowerCase();
            finish(`key:${name}`);
        };
        const onMouse = (ev) => {
            ev.preventDefault(); ev.stopPropagation();
            const NAMES = { 0: "left", 1: "middle", 2: "right", 3: "x1", 4: "x2" };
            finish(`mouse:${NAMES[ev.button] || "left"}`);
        };
        const onCtx = (ev) => ev.preventDefault();   // suppress the right-click menu while armed
        document.addEventListener("keydown", onKey, true);
        document.addEventListener("mousedown", onMouse, true);
        document.addEventListener("contextmenu", onCtx, true);
    });
    // rebuildNode (not render) re-renders THIS node's chips — render() only builds NEW nodes,
    // so an in-place chip add/remove wouldn't show. drawEdges() drops/adds the trigger's edges
    // (watch source→trigger and trigger→price) so a chip change reflects on the canvas live.
    div.querySelector(".tg-addwatch")?.addEventListener("change", (e) => { if (model.addTriggerWatch(t.id, e.target.value)) { rebuildNodeEdges(n.id); autosave(null); } });
    // on_readout: watched readouts (chips + edges). The fire test now lives on the wired gate(s).
    div.querySelector(".tg-addvarwatch")?.addEventListener("change", (e) => { if (model.addTriggerReadoutWatch(t.id, e.target.value)) { rebuildNodeEdges(n.id); autosave(null); } });
    wireArmedRemove(div, ".tg-rmvarwatch", (val) => { model.removeTriggerReadoutWatch(t.id, val); rebuildNodeEdges(n.id); autosave(null); });
    // on_register: watched registers (chips + edges). The fire test now lives on the wired gate(s).
    div.querySelector(".tg-addregwatch")?.addEventListener("change", (e) => { if (model.addTriggerRegisterWatch(t.id, e.target.value)) { rebuildNodeEdges(n.id); autosave(null); } });
    wireArmedRemove(div, ".tg-rmregwatch", (val) => { model.removeTriggerRegisterWatch(t.id, val); rebuildNodeEdges(n.id); autosave(null); });
    // on_item/on_window_detected/undetected/on_window_data_start/stop: watched window(s) (chips +
    // edges). Adding/removing the window can change which item_watch is still valid (on_item), so
    // rebuild the whole body, not just the edges.
    div.querySelector(".tg-addwinwatch")?.addEventListener("change", (e) => { if (model.addTriggerWindowWatch(t.id, e.target.value)) { rebuildNode(n.id); rebuildNodeEdges(n.id); autosave(null); } });
    wireArmedRemove(div, ".tg-rmwinwatch", (val) => { model.removeTriggerWindowWatch(t.id, val); rebuildNode(n.id); rebuildNodeEdges(n.id); autosave(null); });
    // on_item: which item template (within the watched window) pulses the trigger.
    div.querySelector(".tg-itemwatch")?.addEventListener("click", (e) => {
        const btn = e.currentTarget;
        const winId = (t.window_watch || [])[0];
        const items = winId ? model.items(winId) : [];
        const itemMeta = (it) => `${(it.fields || []).length} field(s)${it.terminator ? " — terminator" : ""}`;
        richPickerPop({
            anchor: btn, current: t.item_watch || "",
            groups: [[null, [
                { value: "", label: "(pick one)", meta: "no item template chosen yet — the trigger won't fire" },
                { value: "*", label: "any item", meta: "pulse on ANY item template's detection" },
                ...items.map((it) => ({ value: it.id, label: it.id, meta: itemMeta(it) })),
            ]]],
            onPick: (v) => { model.setTriggerItemWatch(t.id, v); rebuildNode(n.id); rebuildNodeEdges(n.id); autosave(null); },
        });
    });
    // gates have no trigger-side row: the gate node owns that editor (its picker / out-port drag).
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
    renderInputLog(t.id);   // on_input's raw-event log satellite; no-op when hidden or not on_input
}

// ---- gate node: a boolean value-guard a trigger must satisfy before firing --

function wireGate(div, n) {
    const g = n.ref;
    const $ = (sel) => div.querySelector(sel);
    $(".gate-rename")?.addEventListener("change", (e) => {
        const oldId = g.id;
        renameNode(e.target, oldId,
            () => model.renameGate(oldId, (e.target.value || "").trim()),
            () => movePos(`gate:${oldId}`, `gate:${g.id}`),
            () => { render(); autosave(null); });
    });
    // source: a single readout / register slot. Adding replaces; the chip trash clears it.
    $(".gate-addsource")?.addEventListener("change", (e) => { model.setGateSource(g.id, e.target.value); rebuildNodeEdges(n.id); autosave(null); });
    wireArmedRemove(div, ".gate-rmsource", () => { model.setGateSource(g.id, ""); rebuildNodeEdges(n.id); autosave(null); });
    // destination: every node this gate applies to — the gate OWNS this link (model.gateTargets),
    // so this is the only editor for it. render() redraws the gate->target edges and refreshes the
    // gated cue on whichever node kind was picked.
    $(".gate-adddest")?.addEventListener("change", (e) => { if (model.addGateTarget(g.id, e.target.value)) { render(); autosave(null); } });
    // rebuildNode(n.id) FIRST: the armed trash button is the focused element and lives in THIS node,
    // so render()'s consumer sweep (rebuildRefConsumers) would skip rebuilding the gate body and the
    // removed chip would linger. Rebuild our own body directly, then render() to drop the edge.
    wireArmedRemove(div, ".gate-rmdest", (ref) => { model.removeGateTarget(g.id, ref); rebuildNode(n.id); render(); autosave(null); });
    // and/or slider — rebuild so its label re-renders (and it shows/hides at the >1-condition threshold).
    $(".gate-logic")?.addEventListener("change", (e) => { model.setGateLogic(g.id, e.target.checked ? "and" : "or"); rebuildNode(n.id); autosave(null); });
    // negate — a plain toggle (no structural change), so just save.
    $(".gate-negate")?.addEventListener("change", (e) => { model.setGateNegate(g.id, e.target.checked); autosave(null); });
    // add-cond — rebuild so the new row (and the and/or slider crossing >1) appears.
    $(".gate-addcond")?.addEventListener("click", () => { model.addGateCond(g.id); rebuildNode(n.id); autosave(null); });
    // each cond row: when-select rebuilds (its arg input shows/hides with the op); arg-input just
    // saves; remove is a two-click arm (rule 2), armed on the whole row.
    div.querySelectorAll(".gate-condrow").forEach((row) => {
        const idx = +row.dataset.idx;
        row.querySelector(".gate-condwhen")?.addEventListener("click", (e) => {
            const btn = e.currentTarget;
            richPickerPop({
                anchor: btn, current: g.conds[idx]?.when || "always",
                groups: [[null, GATE_WHENS.map(([v, l]) => ({ value: v, label: l, meta: GATE_WHEN_DESC[v] || "" }))]],
                onPick: (v) => { model.setGateCondWhen(g.id, idx, v); rebuildNode(n.id); autosave(null); },
            });
        });
        row.querySelector(".gate-condarg")?.addEventListener("input", (e) => { model.setGateCondArg(g.id, idx, e.target.value); autosave(null); });
        const rm = row.querySelector(".gate-condrm");
        if (rm) armConfirm(rm, () => { model.removeGateCond(g.id, idx); rebuildNode(n.id); autosave(null); }, { silent: true, resetOnOutside: true });
    });
}

// ---- router node: branch a live value to different targets (first match wins) --

function wireRouter(div, n) {
    const r = n.ref;
    const $ = (sel) => div.querySelector(sel);
    $(".router-rename")?.addEventListener("change", (e) => {
        const oldId = r.id;
        renameNode(e.target, oldId,
            () => model.renameRouter(oldId, (e.target.value || "").trim()),
            () => movePos(`router:${oldId}`, `router:${r.id}`),
            () => { render(); autosave(null); });
    });
    $(".router-addsource")?.addEventListener("change", (e) => { model.setRouterSource(r.id, e.target.value); rebuildNodeEdges(n.id); autosave(null); });
    wireArmedRemove(div, ".router-rmsource", () => { model.setRouterSource(r.id, ""); rebuildNodeEdges(n.id); autosave(null); });
    // fired by: the trigger(s) that drive this router — the trigger owns the ref (targets), so a full
    // render refreshes both this node and the trigger's own "fires" row.
    $(".router-adddest")?.addEventListener("change", (e) => { if (model.addTriggerTarget(e.target.value, r.id)) { render(); autosave(null); } });
    // rebuildNode(n.id) FIRST — the focused armed trash button lives in THIS node, so render()'s
    // consumer sweep would skip our own body and leave the removed chip visible (same as gate-rmdest).
    wireArmedRemove(div, ".router-rmdest", (tid) => { model.removeTriggerTarget(tid, r.id); rebuildNode(n.id); render(); autosave(null); });
    // add/remove a branch — rebuild (a branch block appears/vanishes) + edges (its targets' wires).
    $(".router-addbranch")?.addEventListener("click", () => { model.addRouterBranch(r.id); rebuildNodeEdges(n.id); autosave(null); });
    // every per-branch control resolves its branch index off the wrapping [data-bi].
    div.querySelectorAll(".routerb-addcond").forEach((btn) => {
        btn.addEventListener("click", () => { model.addRouterBranchCond(r.id, +btn.dataset.bi); rebuildNode(n.id); autosave(null); });
    });
    div.querySelectorAll(".routerb-logic").forEach((box) => {
        box.addEventListener("change", (e) => { const bi = +e.target.closest("[data-bi]").dataset.bi; model.setRouterBranchLogic(r.id, bi, e.target.checked ? "and" : "or"); rebuildNode(n.id); autosave(null); });
    });
    div.querySelectorAll(".routerb-condrow").forEach((row) => {
        const bi = +row.closest("[data-bi]").dataset.bi, ci = +row.dataset.idx;
        row.querySelector(".routerb-condwhen")?.addEventListener("click", (e) => {
            const btn = e.currentTarget;
            richPickerPop({
                anchor: btn, current: r.branches?.[bi]?.conds?.[ci]?.when || "always",
                groups: [[null, GATE_WHENS.map(([v, l]) => ({ value: v, label: l, meta: GATE_WHEN_DESC[v] || "" }))]],
                onPick: (v) => { model.setRouterBranchCondWhen(r.id, bi, ci, v); rebuildNode(n.id); autosave(null); },
            });
        });
        row.querySelector(".routerb-condarg")?.addEventListener("input", (e) => { model.setRouterBranchCondArg(r.id, bi, ci, e.target.value); autosave(null); });
        const rm = row.querySelector(".routerb-condrm");
        if (rm) armConfirm(rm, () => { model.removeRouterBranchCond(r.id, bi, ci); rebuildNode(n.id); autosave(null); }, { silent: true, resetOnOutside: true });
    });
    // per-branch target add (the "+ target" select) — scoped by the wrapping .routerb-targets[data-bi].
    div.querySelectorAll(".routerb-addtarget").forEach((sel) => {
        sel.addEventListener("change", (e) => { const bi = +sel.closest("[data-bi]").dataset.bi; if (model.addRouterTarget(r.id, bi, e.target.value)) { rebuildNodeEdges(n.id); autosave(null); } });
    });
    // per-branch target chip removal (armed, rule 2) — resolve the branch off the wrapping [data-bi].
    div.querySelectorAll(".routerb-rmtarget").forEach((b) => {
        const bi = +b.closest("[data-bi]").dataset.bi, pill = b.closest(".sv-input");
        const armed = makeArmed({
            onArm: () => pill?.classList.add("armed"),
            onTimeout: () => pill?.classList.remove("armed"),
            onFire: () => { pill?.classList.remove("armed"); model.removeRouterTarget(r.id, bi, b.dataset.val); rebuildNodeEdges(n.id); autosave(null); },
        });
        b.addEventListener("click", (e) => { e.stopPropagation(); armed.trigger(); });
    });
    // remove-branch (armed) — arms the whole branch block.
    div.querySelectorAll(".router-rmbranch").forEach((btn) => {
        const bi = +btn.dataset.bi, wrap = btn.closest(".routerb");
        const armed = makeArmed({
            onArm: () => wrap?.classList.add("armed"),
            onTimeout: () => wrap?.classList.remove("armed"),
            onFire: () => { wrap?.classList.remove("armed"); model.removeRouterBranch(r.id, bi); rebuildNodeEdges(n.id); autosave(null); },
        });
        btn.addEventListener("click", (e) => { e.stopPropagation(); armed.trigger(); });
    });
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
    // action kind: rebuild so the dest select shows/hides; edges follow (dest edge). DATASET
    // targets only — a register target runs its own op below, independent of this one.
    $(".ac-action")?.addEventListener("click", (e) => {
        const btn = e.currentTarget;
        richPickerPop({
            anchor: btn, current: x.action || "",
            groups: [[null, ACTIONS.map(([v, l]) => ({ value: v, label: l, meta: ACTION_DESC[v] || "" }))]],
            onPick: (v) => { model.setActionKind(x.id, v); rebuildNode(n.id); rebuildNodeEdges(n.id); autosave(null); },
        });
    });
    // sources: datasets AND registers, by prefixed ref (value carries "dataset:"/"register:")
    $(".ac-addsrc")?.addEventListener("change", (e) => { if (model.addActionSource(x.id, e.target.value)) { rebuildNodeEdges(n.id); autosave(null); } });
    wireArmedRemove(div, ".ac-rmsrc", (val) => { model.removeActionSource(x.id, val); rebuildNodeEdges(n.id); autosave(null); });
    // dest excludes the action's own dataset targets (can't pick one as its own dest).
    $(".ac-dest")?.addEventListener("click", (e) => {
        const btn = e.currentTarget;
        const dsSrc = new Set(model.actionSources(x.id).filter((s) => s.kind === "dataset").map((s) => s.id));
        const dsFree = model.datasets().filter((d) => !dsSrc.has(d));
        richPickerPop({
            anchor: btn, current: x.dest || "",
            groups: [[null, [{ value: "", label: "- dataset -" }, ...dsFree.map((d) => ({ value: d, label: d }))]]],
            onPick: (v) => { model.setActionDest(x.id, v); rebuildNode(n.id); drawEdges(); autosave(null); },
        });
    });
    // per-register op: each register target picks its own op (rebuild so set/clone/move sub-rows
    // show/hide; edges follow for a per-register clone/move dest).
    div.querySelectorAll(".ac-regop").forEach((btn) => btn.addEventListener("click", (e) => {
        const b = e.currentTarget, regId = b.dataset.reg;
        richPickerPop({
            anchor: b, current: model.actionRegOp(x.id, regId) || "",
            groups: [[null, REG_OPS.map(([v, l]) => ({ value: v, label: l, meta: REG_OP_DESC[v] || "" }))]],
            onPick: (v) => { model.setActionRegOp(x.id, regId, v); rebuildNode(n.id); rebuildNodeEdges(n.id); autosave(null); },
        });
    }));
    // dest is one combined dataset/register picker (value carries the "dataset:"/"register:" prefix)
    // — picking a NEW kind clears every OTHER register's dest on this node (setActionRegDest), so
    // rebuild (not just redraw edges) to show those now-empty "into" buttons.
    div.querySelectorAll(".ac-regdest").forEach((btn) => btn.addEventListener("click", (e) => {
        const b = e.currentTarget, regId = b.dataset.reg;
        const dsSrc = new Set(model.actionSources(x.id).filter((s) => s.kind === "dataset").map((s) => s.id));
        const dsFree = model.datasets().filter((d) => !dsSrc.has(d));
        const regFree = model.registers().filter((r) => r !== regId);
        richPickerPop({
            anchor: b, current: model.actionRegDest(x.id, regId) || "",
            groups: [
                [null, [{ value: "", label: "- destination -" }]],
                ["datasets", dsFree.map((d) => ({ value: `dataset:${d}`, label: d }))],
                ["registers", regFree.map((r) => ({ value: `register:${r}`, label: r }))],
            ],
            onPick: (v) => { model.setActionRegDest(x.id, regId, v); rebuildNode(n.id); rebuildNodeEdges(n.id); autosave(null); },
        });
    }));
    // clone/move key-narrowing: hand-typed rows, one register source running one of those ops
    // (shared reg_slots primitive, rule 7) — each scoped to its register via data-reg. A key/remove
    // edit changes what's targeted, so it rebuilds (matches wireRegWriteRows below).
    wireKeyRows(div, {
        add: (regId) => model.addActionRegKey(x.id, regId),
        removeRow: (regId, idx) => model.removeActionRegKey(x.id, regId, idx),
        setKey: (regId, idx, v) => model.setActionRegKey(x.id, regId, idx, v),
        after: () => { rebuildNode(n.id); autosave(null); },
    });
    // "set values": one row per hand-typed key (shared reg_slots primitive, rule 7) — a key/remove
    // edit changes what the register node scaffolds + the value input's disabled state, so those
    // rebuild; a bare value keystroke only autosaves (matches every other free-text field here).
    wireRegWriteRows(div, {
        add: (regId) => model.addActionWrite(x.id, regId),
        removeRow: (regId, idx) => model.removeActionWrite(x.id, regId, idx),
        setKey: (regId, idx, v) => model.setActionWriteKey(x.id, regId, idx, v),
        setValue: (regId, idx, v) => model.setActionWriteValue(x.id, regId, idx, v),
        setRemove: (regId, idx, on) => model.setActionWriteRemove(x.id, regId, idx, on),
        after: () => { rebuildNode(n.id); autosave(null); },
        autosaveOnly: () => autosave(null),
    });
    // timing knobs — persisted only; the SERVER schedules the delay and the repeated sound cues (a
    // backgrounded tab throttles its timers but not its SSE cue delivery), so nothing here runs a clock.
    $(".ac-delay")?.addEventListener("change", (e) => { model.setActionDelay(x.id, e.target.value); autosave(null); });
    $(".ac-repms")?.addEventListener("change", (e) => { model.setActionRepeatMs(x.id, e.target.value); autosave(null); });
    // repeat crossing 1 reveals/hides the "every ms" row -> rebuild, not a bare autosave
    $(".ac-repeat")?.addEventListener("change", (e) => { model.setActionRepeat(x.id, e.target.value); rebuildNode(n.id); autosave(null); });
    // manual fire: run the action NOW on its targets via the same funnel a trigger uses — including
    // its delay and its sound cues, which the server owns (the cue comes BACK over SSE and plays
    // through the same path an automatic fire uses; nothing is played locally).
    // Transient feedback by swapping the button label (no progress line on the node).
    $(".ac-fire")?.addEventListener("click", async (e) => {
        const btn = e.currentTarget; btn.disabled = true; btn.textContent = "firing…";
        // register sources aren't in /api/flow, so repaint each one this action touches directly
        // (clear/move mutate the in-memory held map server-side but publish no dataset-change push,
        // so refreshLive would never reach them). A COSMETIC repaint, not a cue: with a delay set it
        // has to run after the server's timer, hence the local wait — the sound cue never rides this.
        const repaint = () => {
            refreshLive();
            for (const s of model.actionSources(x.id)) if (s.kind === "register") refreshRegister(s.id);
        };
        try {
            // The server fires off the PERSISTED profile (load_profile reads disk), so a config
            // edit still sitting in the 400ms autosave debounce would fire STALE. Land it first:
            // the input's `change` already mutated the model on blur; flush that pending save
            // before the request so a just-typed delay/dest/repeat is what actually fires.
            await persist.flush();
            const r = await api.actions.fire(model.profile.name, x.id);
            const delay = Math.max(0, Number(x.delay_ms) || 0);
            btn.textContent = r.ran ? (delay ? `in ${delay}ms…` : "fired ✓") : "no-op";
            repaint();
            if (delay) setTimeout(repaint, delay + 50);
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
    // sources live in the standard sources input now (registerParts): removable chips of the wired
    // readouts + processes + an add-select — the ONE sources widget (rule 7), same wiring shape as
    // wireProcess/wireAction. Adding/removing a source changes the chip list (body) AND the edges,
    // so rebuild both; the rebuild re-runs this wireRegister, whose microtask re-populates the bank
    // scaffold (no fetch). Out-port drag shares model.addRegisterSource + rebuilds the target too.
    const rebuild = () => { rebuildNodeEdges(n.id); autosave(null); };
    $(".reg-addsrc")?.addEventListener("change", (e) => {
        const ref = e.target.value; e.target.value = "";
        if (ref && model.addRegisterSource(x.id, ref)) rebuild();
    });
    wireArmedRemove(div, ".reg-rmsrc", (val) => { model.removeRegisterSource(x.id, val); rebuild(); });
    // ring depth per key: coerce (blank -> 1) then rebuild so the normalised value re-renders.
    $(".reg-cap")?.addEventListener("change", (e) => { model.setRegisterCapacity(x.id, e.target.value); rebuildNode(n.id); autosave(null); });
    // ring aggregate (shown only when capacity > 1): opens the grouped rich picker (rich_picker.js)
    // instead of a native <select> (option tooltips don't render cross-browser), so each mode's
    // description reads while browsing. The picked mode gates whether the arg-tuning input shows at
    // all (AGG_ARG in register_node.js), so rebuild the body like `.reg-cap` does for its own
    // threshold — then refetch so the membank's summary line repaints with the new fold.
    $(".reg-agg-btn")?.addEventListener("click", (e) => {
        richPickerPop({
            anchor: e.currentTarget, current: x.aggregate || "",
            groups: REG_AGGREGATES.map(([grp, opts]) =>
                [grp, opts.map(([v, lbl]) => ({ value: v, label: lbl, meta: AGG_DESC[v] || "" }))]),
            onPick: (v) => { model.setRegisterAggregate(x.id, v); rebuildNode(n.id); refreshRegister(x.id); autosave(null); },
        });
    });
    // the fold's tuning knob (RegisterDef.aggregate_arg): no structural change, just refetch so the
    // summary repaints with the new arg (mirrors the plain `.reg-agg-btn` refresh, pre-rebuild).
    $(".reg-aggarg")?.addEventListener("change", (e) => {
        model.setRegisterAggregateArg(x.id, e.target.value); refreshRegister(x.id); autosave(null);
    });
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
    // populate the SCAFFOLD only (empty ∅ slot per wired readout) — no data fetch on boot / rebuild /
    // undo-redo restore / a source add-remove. Live values fill in only while collecting, via the
    // heartbeat's refreshRegister (activity.js). wireRegister runs INSIDE buildNode before the node
    // is mounted, so populateRegister would no-op if called directly; queueMicrotask defers past the
    // synchronous render()/buildNode chain -> the node is mounted by the time this fires.
    queueMicrotask(() => populateRegister(x.id));
}

// ---- process node: apply one rules pipeline to wired inputs, key-preserved (see ProcessDef) --------

function wireProcess(div, n) {
    const x = n.ref;
    const $ = (sel) => div.querySelector(sel);
    $(".prrename")?.addEventListener("change", (e) => {
        const oldId = x.id;
        renameNode(e.target, oldId,
            () => model.renameProcess(oldId, (e.target.value || "").trim()),
            () => movePos(`process:${oldId}`, `process:${x.id}`),
            () => {
                render(); autosave(null);
                // the live output + history live server-side keyed by the OLD id (LiveSession) — carry
                // them to the new id, then repaint the satellite; without this the renamed node's
                // history is blank until the next collector tick repopulates it.
                api.renameProcess(model.profile.name, oldId, x.id)
                    .catch(() => {})
                    .finally(() => renderProcessHistory(x.id));
            });
    });
    // value type — re-filters the rule menus (a number-only rule greys out for text) -> rebuild body.
    $(".pr-type")?.addEventListener("click", (e) => {
        const btn = e.currentTarget;
        richPickerPop({
            anchor: btn, current: x.type || "text",
            groups: [[null, PROCESS_TYPES.map(([v, l]) => ({ value: v, label: l, meta: PROCESS_TYPE_DESC[v] || "" }))]],
            onPick: (v) => { model.setProcessType(x.id, v); rebuildNode(n.id); autosave(null); },
        });
    });
    // add an input (a readout or a register slot) via the "+ input" select — candidates come from
    // model.sourceCandidates (the shared truth).
    // add/remove an input, or rename an output key, changes what this process EMITS — so a consuming
    // register must re-scaffold its cells. render() runs the unified _refKey consumer sweep (processes
    // are in the key), which rebuilds the register body; a bare rebuildNodeEdges would miss it.
    // render()'s sweep SKIPS the focused node (rule: never yank the input being edited) — and the
    // add-select / armed-remove button live INSIDE this node, so this node is the focused one and the
    // sweep won't rebuild its own body (the new/removed row wouldn't show until reload). Rebuild it
    // explicitly here, like every other in-body source-add handler does with rebuildNodeEdges.
    $(".pr-inadd")?.addEventListener("click", (e) => {
        const cands = model.sourceCandidates("process", x.id);
        comboPopover({
            anchor: e.currentTarget, placeholder: "search inputs...",
            options: cands.map((c) => ({ value: c.ref, label: c.label })),
            onPick: (ref) => { if (ref && model.addProcessSource(x.id, ref)) { render(); rebuildNode(n.id); autosave(null); } },
        });
    });
    // the trash lives in the .pr-maprow (sibling of the input-key chip, not inside a .sv-input) — arm the whole row.
    wireArmedRemove(div, ".pr-rmin", (val) => { model.removeProcessSource(x.id, val); render(); rebuildNode(n.id); autosave(null); }, { pill: ".pr-maprow" });
    // the key mangler: each input's output-key field renames its key downstream. Commit re-scaffolds
    // any consuming register (render() -> _refKey sweep); blank keeps the input key (the placeholder).
    div.querySelectorAll(".pr-out").forEach((inp) => inp.addEventListener("change", (e) => {
        model.setProcessSourceOut(x.id, e.target.dataset.ref, e.target.value); render(); autosave(null);
    }));
    // the rules pipeline — the SAME editor the readout/region nodes use, bound to the ProcessDef
    // (which carries its own `.rules`). No inline live trace here; the "raw" satellite shows real ones.
    wireFieldRules(div, x, { edit: rulesEdit(n.id, () => autosave(null)) });
    // paint the input/output-history satellite from the last heartbeat (no-op when hidden), so a
    // just-opened satellite shows at once instead of waiting for the next beat.
    renderProcessHistory(x.id);
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
    $(".src-format")?.addEventListener("click", (e) => {
        const btn = e.currentTarget;
        richPickerPop({
            anchor: btn, current: s.format || "log_lines",
            groups: [[null, FORMATS.map(([v, l]) => ({ value: v, label: l, meta: FORMAT_DESC[v] || "" }))]],
            onPick: (v) => { model.setSourceFormat(s.id, v); rebuildNode(n.id); autosave(null); },
        });
    });
    $(".src-watch")?.addEventListener("click", (e) => {
        const btn = e.currentTarget;
        richPickerPop({
            anchor: btn, current: s.watch || "manual",
            groups: [[null, WATCH_MODES.map(([v, l]) => ({ value: v, label: l, meta: WATCH_DESC[v] || "" }))]],
            onPick: (v) => { model.setSourceProp(s.id, "watch", v); rebuildNode(n.id); autosave(null); },
        });
    });
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
    div.querySelectorAll(".mset-op").forEach((btn) => btn.addEventListener("click", (e) => {
        const b = e.currentTarget, i = +b.dataset.i;
        richPickerPop({
            anchor: b, current: (s.match[i].op || "contains"),
            groups: [[null, OPS.map(([v, l]) => ({ value: v, label: l, meta: OP_DESC[v] || "" }))]],
            onPick: (v) => {
                model.setSourceMatch(s.id, i, "op", v);
                b.textContent = `<${(OPS.find(([ov]) => ov === v) || [, v])[1]}>`;
                autosave(null); schedulePreview();
            },
        });
    }));

    // extraction fields. add/remove change which columns the parse emits -> refresh the preview too.
    $(".src-addf")?.addEventListener("click", () => { model.addSourceField(s.id); rebuildNode(n.id); autosave(null); schedulePreview(); });
    div.querySelectorAll(".src-rmf").forEach((b) => armConfirm(b, () => { model.removeSourceField(s.id, +b.dataset.i); rebuildNode(n.id); autosave(null); schedulePreview(); }, { silent: true, resetOnOutside: true }));
    div.querySelectorAll(".fset2").forEach((inp) => inp.addEventListener("change", (e) => {
        const k = e.target.dataset.k;
        model.setSourceFieldProp(s.id, +e.target.dataset.i, k,
            e.target.type === "checkbox" ? e.target.checked : e.target.value);
        autosave(null); schedulePreview();
    }));
    div.querySelectorAll(".src-ftype").forEach((btn) => btn.addEventListener("click", (e) => {
        const b = e.currentTarget, i = +b.dataset.i;
        richPickerPop({
            anchor: b, current: (s.fields[i].type || "text"),
            groups: [[null, SRC_FIELD_TYPES.map(([v, l]) => ({ value: v, label: l, meta: FIELD_TYPE_DESC[v] || "" }))]],
            onPick: (v) => {
                model.setSourceFieldProp(s.id, i, "type", v);
                b.textContent = `<${(SRC_FIELD_TYPES.find(([tv]) => tv === v) || [, v])[1]}>`;
                autosave(null); schedulePreview();
            },
        });
    }));
    // method swaps its own inputs + changes the parse -> rebuild the node
    div.querySelectorAll(".src-fmethod").forEach((btn) => btn.addEventListener("click", (e) => {
        const b = e.currentTarget, i = +b.dataset.i;
        richPickerPop({
            anchor: b, current: (s.fields[i].method || "after"),
            groups: [[null, METHODS.map(([v, l]) => ({ value: v, label: l, meta: METHOD_DESC[v] || "" }))]],
            onPick: (v) => { model.setSourceFieldProp(s.id, i, "method", v); rebuildNode(n.id); autosave(null); schedulePreview(); },
        });
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
    wireProducer, wireProducerPreview, wireTrigger, wireGate, wireRouter, wireAction, wireRegister, wireProcess, wireSource,
    refreshSourcePreview,
};
