// Trigger node: fires its target(s) on a condition. `interval` fires every N seconds (its clock
// reseeds to now on restart/config edit); `true_interval` fires every N seconds of REAL time,
// anchored to the persisted last-fire so its cadence survives restarts; `on_change` fires whenever
// a watched dataset gains rows (any write path), but a watched subset only fires when its computed
// output actually differs; `on_any_change` fires on every write reaching it; `on_new_batch` fires
// once per new batch of a watched dataset (a re-pushed screen) even if the values are identical;
// `on_readout` fires
// when a watched live readout meets its condition; `on_ready` fires once when a watched PRODUCER's
// sweep/fetch finishes (the producer does the work and knows when it's done); `on_item` fires when
// a specific item template in a watched WINDOW is detected/kept this tick; `on_window_detected`/
// `on_window_undetected` fire on a watched window becoming/ceasing to be the recognized one;
// `on_window_tick` fires EVERY tick a watched window's grid was actually OCR'd (content-
// independent, unlike on_change — won't stall on a duplicate-content re-read);
// `on_window_data_start`/`on_window_data_stop` fire on a watched window's dataset producing again
// after a quiet spell / going quiet after producing; `on_scroll_top`/`on_scroll_bottom` fire when a
// watched window's scrollbar thumb arrives at the top/bottom of its track; `manual` never
// auto-fires (the fire button drives it). A throttle sets a minimum time between fires (leading edge); a settle waits for the
// watched changes to stop and then fires once (trailing edge). Targets are wired by dragging the
// out-port to a producer / file source / toast / sound / action, or picked from the "fires" row.
// The dataset ACTION (clear/clone/move) is now its own node (action_node.js), fired via `targets`.
// Rendering only — wiring is in main.js.
import { h, frag, labCell, srcRow, labBtns, REC } from "../dom.js";
import { sourcesInput } from "./sources_input.js";
import { watchLink } from "./wiring.js";
import * as wiring from "./wiring.js";

// Hover copy for the watch port, per kind — COPY ONLY: whether the port exists at all, and what
// it may be dropped on, both come from the wiring table (watchLink). A kind with no entry gets a
// generic "drag to a <what it watches> to watch".
const WATCH_TITLE = {
    on_change: "drag to a dataset or subset to watch for new rows",
    on_any_change: "drag to a dataset or subset to watch for new rows",
    on_new_batch: "drag to a dataset or subset to fire once per new batch (a re-pushed screen)",
    on_ready: "drag to a producer to fire when its sweep finishes",
    on_readout: "drag to a readout node to watch its value",
    on_register: "drag to a register to watch its keys",
    on_item: "drag to a window to watch — then pick the item template below",
    on_window_detected: "drag to a window to watch its recognition state",
    on_window_undetected: "drag to a window to watch its recognition state",
    on_window_data_start: "drag to a window to watch its dataset's activity",
    on_window_data_stop: "drag to a window to watch its dataset's activity",
    on_scroll_top: "drag to a window to watch its scrollbar",
    on_scroll_bottom: "drag to a window to watch its scrollbar",
};

// The kind roster comes from the server's wiring table (wiring.VOCAB["trigger_kinds"]) — the same
// roster every `t.kind ==` site in oc.collect.triggers dispatches on, grouped by the node kind each
// kind watches (the picker's headers; mirrors REG_AGGREGATES/register_node.js — the grouped
// rich_picker.js pattern, so a native <select> isn't the only way to browse a long vocabulary).
// Each entry carries its own one-line meta for the picker, so a kind's behaviour reads while
// browsing rather than only after picking. Thunks: the table lands at boot, after module eval.
export const KIND_GROUPS = () => wiring.opGroups("trigger_kinds");
export const KIND_DESC = () => wiring.opDesc("trigger_kinds");

// window-scoped kinds: all watch window_watch (a window node); on_item ALSO sub-picks item_watch.
const WINDOW_KINDS = () => wiring.opsInGroup("trigger_kinds", "window");

export function kindLabel(v) {
    for (const [, opts] of KIND_GROUPS()) for (const [ov, lbl] of opts) if (ov === v) return lbl;
    return v;
}

export const INPUT_EVENTS = [["down", "down"], ["up", "up"], ["press", "press (down+up)"], ["double", "double press"]];
export const INPUT_EVENT_DESC = {
    down: "pulse on the button/key going down",
    up: "pulse on the button/key coming back up",
    press: "pulse on a full down+up press",
    double: "pulse only when two presses land within the 'within' window below",
};

// a rich-dd-btn button built from [value,label] pairs, marking `val` current — mirrors optSel
// (node_parts.js); wiring (io_wire.js) has the model access to open the picker.
const richBtn = (val, label, cls, title) =>
    h("button", { class: `${cls} rich-dd-btn`, type: "button", title: title || "" }, `<${label}>`);

// One rect-axis input with an inline x/y/w/h dim label (tg-inrect row, graph.css).
const rectField = (lbl, cls, val) =>
    h("label", { class: "tg-inrf" }, lbl, h("input", { class: cls, type: "number", step: "0.01", min: "0", max: "1", value: val }));

// The fire condition (was inline op/value / per-key rows) now lives on wired GATE node(s): the
// trigger fires only when every gate wired to it passes. That wiring is owned by the GATE end —
// its own picker or a drag from its out-port — so the trigger has no gates row of its own (one
// editor per relationship, like every other target). The on_readout/on_register kinds keep only
// the WATCH picker (which value(s) to wake on); the gate does the comparison. See gate_node.js.

export function triggerParts(t, model) {
    const allKinds = KIND_GROUPS().flatMap(([, opts]) => opts.map(([v]) => v));
    const kind = allKinds.includes(t.kind) ? t.kind : "interval";
    const timed = kind === "interval" || kind === "true_interval";

    // targets: drag the out-port to a producer / file source / toast / sound / action OR pick one here.
    const targets = srcRow("fires", "producers (sweep), file sources (read), toasts (notify), sounds (play), or actions (dataset op) this trigger fires",
        sourcesInput({
            chips: (t.targets || []).map((p) => ({ value: p, node: model.refNode(p) })),
            free: () => model.sourceCandidates("trigger", t.id, "targets").map((c) => c.ref),
            addLabel: "+ fire target", addinCls: "sv-addin tg-addfire", rmCls: "sv-rmin tg-rmtarget" }));

    const interval = timed
        ? frag(labCell("every", "seconds between fires"),
            h("span", { class: "tg-secs" },
                h("input", { class: "tg-interval", type: "number", min: "1", step: "1", value: t.interval_s || 300 }), " s"))
        : null;

    let watch = null;
    if (kind === "on_change" || kind === "on_any_change" || kind === "on_new_batch" || kind === "on_ready") {
        const have = new Set(t.watch || []);
        // on_change/on_any_change/on_new_batch watch datasets OR subsets; on_ready watches a
        // PRODUCER and fires when its sweep finishes (the producer knows when it's done).
        const onlyProducers = kind === "on_ready";
        const sources = () => onlyProducers
            ? (model.profile.producers || []).map((p) => p.id)
            : [...model.datasets(), ...(model.profile.subsets || []).map((s) => s.id)];
        const hint = kind === "on_any_change"
            ? "datasets or subsets; fires on every write, even if a watched subset's visible output is unchanged"
            : kind === "on_new_batch"
            ? "datasets or subsets; fires once per new batch (a re-pushed screen) even if the values are identical"
            : kind === "on_ready"
            ? "the producer to watch; fires once when its sweep/fetch finishes (data already written)"
            : "datasets or subsets; the trigger fires when one gains rows";
        watch = srcRow("watch", hint,
            sourcesInput({
                chips: (t.watch || []).map((w) => ({ value: w, node: model.refNode(w) })),
                free: () => sources().filter((d) => !have.has(d)),
                addLabel: onlyProducers ? "+ watch producer" : "+ watch source",
                addinCls: "sv-addin tg-addwatch", rmCls: "sv-rmin tg-rmwatch" }));
    }

    // on_readout: watch one or more live readouts. The fire test itself lives on the wired gate(s).
    let varwatch = null;
    if (kind === "on_readout") {
        const have = new Set(t.readout_watch || []);
        varwatch = srcRow("watch", "live readouts to wake on; the fire test is set on the wired gate(s)",
            sourcesInput({
                chips: (t.readout_watch || []).map((vid) => ({ value: vid, node: model.refNode(vid) })),
                free: () => model.readouts().filter((v) => !have.has(v.id)).map((v) => v.id),
                addLabel: "+ watch readout", addinCls: "sv-addin tg-addvarwatch", rmCls: "sv-rmin tg-rmvarwatch" }));
    }

    // on_register: watch register(s). The per-key fire test lives on the wired gate(s).
    let regwatch = null;
    if (kind === "on_register") {
        const have = new Set(t.register_watch || []);
        regwatch = srcRow("watch", "registers to wake on; the fire test is set on the wired gate(s)",
            sourcesInput({
                chips: (t.register_watch || []).map((rid) => ({ value: rid, node: model.refNode(`register:${rid}`) })),
                free: () => model.registers().filter((r) => !have.has(r)),
                addLabel: "+ watch register", addinCls: "sv-addin tg-addregwatch", rmCls: "sv-rmin tg-rmregwatch" }));
    }

    // on_item/on_window_detected/undetected/on_window_data_start/stop: watch window(s). on_item
    // watches exactly one (model.addTriggerWindowWatch enforces that on the model side) and then
    // sub-picks which item template within it pulses the trigger.
    let winWatch = null, itemWatch = null;
    if (WINDOW_KINDS().includes(kind)) {
        const have = new Set(t.window_watch || []);
        const hint = kind === "on_item" ? "the window the watched item template lives in"
            : kind === "on_window_detected" ? "windows to watch for becoming the recognized one"
            : kind === "on_window_undetected" ? "windows to watch for no longer being the recognized one"
            : kind === "on_window_tick" ? "windows to watch for a real OCR tick (fires every such tick, content-independent)"
            : kind === "on_window_data_start" ? "windows to watch for producing data again after a quiet spell"
            : kind === "on_window_data_stop" ? "windows to watch for going quiet after producing data (see settle below)"
            : kind === "on_scroll_top" ? "windows to watch for their scrollbar reaching the top"
            : "windows to watch for their scrollbar reaching the bottom";
        winWatch = srcRow("watch", hint,
            sourcesInput({
                chips: (t.window_watch || []).map((w) => ({ value: w, node: model.refNode(w) })),
                free: () => (model.profile.windows || []).map((w) => w.id).filter((w) => !have.has(w)),
                addLabel: "+ watch window", addinCls: "sv-addin tg-addwinwatch", rmCls: "sv-rmin tg-rmwinwatch" }));
        const winId = (t.window_watch || [])[0];
        if (kind === "on_item" && winId) {
            const items = model.items(winId);
            const label = !t.item_watch ? "(pick one)" : t.item_watch === "*" ? "<any item>" : `<${t.item_watch}>`;
            itemWatch = frag(
                labCell("item", "which item template's detection pulses the trigger"),
                h("button", { class: "tg-itemwatch rich-dd-btn", type: "button" }, label));
        }
    }

    // on_input: keyboard/mouse chord + optional window/rect bind. LIVE ONLY — the input hook (see
    // oc.input.win32_hook) runs only while a live session is collecting. "listen" (the ◉ icon
    // nested in the button label, wired in io_wire.js) captures the next keydown/mousedown, incl.
    // held modifiers, into the button field — no blocking dialog (rule 2), just an .armed class.
    let inputCfg = null;
    if (kind === "on_input") {
        const hasRect = !!t.input_window;
        const rect = t.input_rect && t.input_rect.length === 4 ? t.input_rect : ["", "", "", ""];
        inputCfg = frag(
            labCell("event", "which stream transition pulses the trigger"),
            richBtn(t.input_event, (INPUT_EVENTS.find(([v]) => v === t.input_event) || [, t.input_event])[1],
                "tg-inevent", INPUT_EVENT_DESC[t.input_event] || ""),
            labBtns("button", "the watched button — blank/\"any\" matches any key/mouse button",
                [{ cls: "tg-inlisten", title: "click, then press the key/mouse button to bind", glyph: REC() }]),
            h("input", { class: "tg-inbutton", placeholder: "any", value: t.input_button || "",
                title: "key:<name> or mouse:<left|right|middle|x1|x2>" }),
            labCell("mods", "modifiers that must ALL be held (comma-separated): ctrl, shift, alt, win, mouse:left…"),
            h("input", { class: "tg-inmods", placeholder: "(none)", value: (t.input_mods || []).join(", ") }),
            t.input_event === "double" ? labCell("within", "max time between the two presses") : null,
            t.input_event === "double" ? h("span", { class: "tg-secs" },
                h("input", { class: "tg-indouble", type: "number", min: "1", step: "1",
                    value: t.input_double_ms || 350 }), " ms") : null,
            labCell("window", "fire only while this window is the recognized one (blank = any screen)"),
            h("button", { class: "tg-inwindow rich-dd-btn", type: "button" }, t.input_window ? `<${t.input_window}>` : "(any)"),
            hasRect ? labCell("rect", "fire only when the mouse is inside this client-relative box (blank = whole window)") : null,
            hasRect ? h("span", { class: "tg-inrect" },
                rectField("x", "tg-inrx", rect[0]),
                rectField("y", "tg-inry", rect[1]),
                rectField("w", "tg-inrw", rect[2]),
                rectField("h", "tg-inrh", rect[3])) : null);
    }

    // throttle: minimum ms between actual fires (blank = none) — a global rate limit across all kinds.
    const throttle = frag(
        labCell("throttle", "minimum time between fires (blank = none)"),
        h("span", { class: "tg-secs" },
            h("input", { class: "tg-throttle", type: "number", min: "1", step: "1",
                placeholder: "(none)", value: t.throttle_ms == null ? "" : t.throttle_ms }), " ms"));

    // settle: trailing-edge debounce — wait for changes to stop, then fire ONCE with the final
    // state (blank = fire immediately). Meaningless for `manual` (never auto-fires), so it's shown
    // only for auto-fire kinds. The max-cap (fire anyway after this long even if changes keep
    // coming) appears only once a settle window is set — a deadline with no window does nothing.
    // on_window_data_stop repurposes this SAME field as the quiet-before-fire threshold itself
    // (not a trailing debounce of an already-decided fire — see TriggerRunner._check_window_data_
    // stop), so it gets its own label and no "settle max" (that field does nothing for this kind:
    // the fire path bypasses the debounce timer entirely).
    const isDataStop = kind === "on_window_data_stop";
    const hasSettle = t.settle_ms != null && t.settle_ms > 0;
    // on_ready is deterministic (fires on the watched producer's completion) — no debounce.
    const settle = (kind === "manual" || kind === "on_ready") ? null : frag(
        labCell("settle", isDataStop
            ? "quiet for this long before firing (blank = ~2s default)"
            : "wait for changes to stop, then fire once (blank = fire now)"),
        h("span", { class: "tg-secs" },
            h("input", { class: "tg-settle", type: "number", min: "1", step: "1",
                placeholder: isDataStop ? "2000" : "(none)", value: t.settle_ms == null ? "" : t.settle_ms }), " ms"),
        (hasSettle && !isDataStop) ? labCell("settle max", "fire anyway after this long even if changes keep coming") : null,
        (hasSettle && !isDataStop) ? h("span", { class: "tg-secs" },
            h("input", { class: "tg-settlemax", type: "number", min: "1", step: "1",
                placeholder: "(none)", value: t.settle_max_ms == null ? "" : t.settle_max_ms }), " ms") : null);

    // kind: a grouped rich popover (rich_picker.js), same shape as the register aggregate fold —
    // native <option title> tooltips don't render cross-browser, so each kind's meaning is shown
    // as a meta line while browsing (io_wire.js wires the click -> KIND_GROUPS/KIND_DESC -> pick).
    const kindBtn = h("button", { class: "gi tg-kind-btn rich-dd-btn rich-dd-block", type: "button", title: KIND_DESC()[kind] || "" },
        `<${kindLabel(kind)}>`);

    return {
        title: h("input", { class: "gi gi-id tgrename", value: t.id, title: "rename trigger" }),
        body: frag(
            labCell("kind", "how the trigger decides to fire"), kindBtn,
            targets,
            interval, watch, varwatch, regwatch, winWatch, itemWatch, inputCfg, throttle, settle,
            labCell("progress", "what the trigger is doing (live countdown for timed kinds)"),
            h("span", { class: "tg-prog muted" }, "idle")),
        foot: h("button", { class: "tg-fire" }, "↻ fire"),
        ports: frag(
            h("span", { class: "port out", title: "drag to a node this trigger should fire" }),
            // WHETHER this kind has a watch port (and what it accepts) is the wiring table's call
            // — watchLink(kind) — so a new watching kind needs no edit here. Only the hover copy
            // is per-kind, and it falls back to the link's own label.
            !!watchLink(kind) && h("span", { class: "port pwatch",
                title: WATCH_TITLE[kind] || `drag to a ${watchLink(kind).label} to watch` })),
    };
}
