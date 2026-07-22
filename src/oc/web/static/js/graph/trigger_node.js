// Trigger node: fires its target(s) on a condition. `interval` fires every N seconds (its clock
// reseeds to now on restart/config edit); `true_interval` fires every N seconds of REAL time,
// anchored to the persisted last-fire so its cadence survives restarts; `on_change` fires whenever
// a watched dataset gains rows (any write path), but a watched subset only fires when its computed
// output actually differs; `on_any_change` fires on every write reaching it; `on_new_batch` fires
// once per new batch of a watched dataset (a re-pushed screen) even if the values are identical;
// `on_readout` fires
// when a watched live readout meets its condition; `on_ready` fires once when a watched PRODUCER's
// sweep/fetch finishes (the producer does the work and knows when it's done); `manual` never
// auto-fires (the fire button drives it). A throttle sets a minimum time between fires (leading edge); a settle waits for the
// watched changes to stop and then fires once (trailing edge). Targets are wired by dragging the
// out-port to a producer / file source / toast / sound / action, or picked from the "fires" row.
// The dataset ACTION (clear/clone/move) is now its own node (action_node.js), fired via `targets`.
// Rendering only — wiring is in main.js.
import { h, frag, labCell, srcRow, labBtns, REC } from "../dom.js";
import { sourcesInput } from "./sources_input.js";

const KINDS = [["interval", "interval"], ["true_interval", "true interval"], ["on_change", "on change"],
    ["on_any_change", "on any change"], ["on_new_batch", "on new batch"],
    ["on_app_start", "on app start"], ["on_capture", "on capture start"],
    ["on_live_start", "on live start"], ["on_live_stop", "on live stop"],
    ["on_readout", "on readout"], ["on_register", "on register"], ["on_ready", "on ready"],
    ["on_input", "on input (live only)"], ["manual", "manual only"]];

const INPUT_EVENTS = [["down", "down"], ["up", "up"], ["press", "press (down+up)"], ["double", "double press"]];

// One rect-axis input with an inline x/y/w/h dim label (tg-inrect row, graph.css).
const rectField = (lbl, cls, val) =>
    h("label", { class: "tg-inrf" }, lbl, h("input", { class: cls, type: "number", step: "0.01", min: "0", max: "1", value: val }));

// The fire condition (was inline op/value / per-key rows) now lives on wired GATE node(s): the
// trigger fires only when every gate wired to it passes. That wiring is owned by the GATE end —
// its own picker or a drag from its out-port — so the trigger has no gates row of its own (one
// editor per relationship, like every other target). The on_readout/on_register kinds keep only
// the WATCH picker (which value(s) to wake on); the gate does the comparison. See gate_node.js.

export function triggerParts(t, model) {
    const kind = KINDS.some(([v]) => v === t.kind) ? t.kind : "interval";
    const kopt = ([v, l]) => h("option", { value: v, selected: v === kind }, v === kind ? `<${l}>` : l);
    const timed = kind === "interval" || kind === "true_interval";

    // targets: drag the out-port to a producer / file source / toast / sound / action OR pick one here.
    const haveT = new Set(t.targets || []);
    const tgtIds = () => [...(model.profile.producers || []).map((p) => p.id),
                    ...(model.profile.file_sources || []).map((s) => s.id),
                    ...(model.profile.toasts || []).map((x) => x.id),
                    ...(model.profile.sounds || []).map((x) => x.id),
                    ...(model.profile.actions || []).map((x) => x.id),
                    ...(model.profile.routers || []).map((x) => x.id)];
    const targets = srcRow("fires", "producers (sweep), file sources (read), toasts (notify), sounds (play), or actions (dataset op) this trigger fires",
        sourcesInput({
            chips: (t.targets || []).map((p) => ({ value: p, node: model.refNode(p) })),
            free: () => tgtIds().filter((p) => !haveT.has(p)),
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

    // on_input: keyboard/mouse chord + optional window/rect bind. LIVE ONLY — the input hook (see
    // oc.input.win32_hook) runs only while a live session is collecting. "listen" (the ◉ icon
    // nested in the button label, wired in io_wire.js) captures the next keydown/mousedown, incl.
    // held modifiers, into the button field — no blocking dialog (rule 2), just an .armed class.
    let inputCfg = null;
    if (kind === "on_input") {
        const winOpt = (w) => h("option", { value: w.id, selected: w.id === t.input_window }, w.id);
        const hasRect = !!t.input_window;
        const rect = t.input_rect && t.input_rect.length === 4 ? t.input_rect : ["", "", "", ""];
        inputCfg = frag(
            labCell("event", "which stream transition pulses the trigger"),
            h("select", { class: "tg-inevent" }, INPUT_EVENTS.map(([v, l]) =>
                h("option", { value: v, selected: v === t.input_event }, v === t.input_event ? `<${l}>` : l))),
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
            h("select", { class: "tg-inwindow" },
                h("option", { value: "", selected: !t.input_window }, "(any)"),
                (model.profile.windows || []).map(winOpt)),
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
    const hasSettle = t.settle_ms != null && t.settle_ms > 0;
    // on_ready is deterministic (fires on the watched producer's completion) — no debounce.
    const settle = (kind === "manual" || kind === "on_ready") ? null : frag(
        labCell("settle", "wait for changes to stop, then fire once (blank = fire now)"),
        h("span", { class: "tg-secs" },
            h("input", { class: "tg-settle", type: "number", min: "1", step: "1",
                placeholder: "(none)", value: t.settle_ms == null ? "" : t.settle_ms }), " ms"),
        hasSettle ? labCell("settle max", "fire anyway after this long even if changes keep coming") : null,
        hasSettle ? h("span", { class: "tg-secs" },
            h("input", { class: "tg-settlemax", type: "number", min: "1", step: "1",
                placeholder: "(none)", value: t.settle_max_ms == null ? "" : t.settle_max_ms }), " ms") : null);

    return {
        title: h("input", { class: "gi gi-id tgrename", value: t.id, title: "rename trigger" }),
        body: frag(
            h("div", { class: "lab-grid" },
                targets,
                labCell("kind", "how the trigger decides to fire"),
                h("select", { class: "tg-kind" }, KINDS.map(kopt)),
                interval, watch, varwatch, regwatch, inputCfg, throttle, settle,
                labCell("progress", "what the trigger is doing (live countdown for timed kinds)"),
                h("span", { class: "tg-prog muted" }, "idle"))),
        foot: h("button", { class: "tg-fire" }, "↻ fire"),
        ports: frag(
            h("span", { class: "port out", title: "drag to a node this trigger should fire" }),
            (kind === "on_change" || kind === "on_any_change") && h("span", { class: "port pwatch", title: "drag to a dataset or subset to watch for new rows" }),
            kind === "on_new_batch" && h("span", { class: "port pwatch", title: "drag to a dataset or subset to fire once per new batch (a re-pushed screen)" }),
            kind === "on_ready" && h("span", { class: "port pwatch", title: "drag to a producer to fire when its sweep finishes" }),
            kind === "on_readout" && h("span", { class: "port pwatch", title: "drag to a readout node to watch its value" }),
            kind === "on_register" && h("span", { class: "port pwatch", title: "drag to a register to watch its keys" })),
    };
}
