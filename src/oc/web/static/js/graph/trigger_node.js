// Trigger node: fires its target(s) on a condition. `interval` fires every N seconds (its clock
// reseeds to now on restart/config edit); `true_interval` fires every N seconds of REAL time,
// anchored to the persisted last-fire so its cadence survives restarts; `on_change` fires whenever
// a watched dataset gains rows (any write path), but a watched subset only fires when its computed
// output actually differs; `on_any_change` fires on every write reaching it; `on_readout` fires
// when a watched live readout meets its condition; `manual` never auto-fires (the fire button
// drives it). A throttle sets a minimum time between fires. Targets are wired by dragging the
// out-port to a producer / file source / toast / sound / action, or picked from the "fires" row.
// The dataset ACTION (clear/clone/move) is now its own node (action_node.js), fired via `targets`.
// Rendering only — wiring is in main.js.
import { h, frag, labCell, srcRow } from "../dom.js";
import { sourcesInput } from "./sources_input.js";

const KINDS = [["interval", "interval"], ["true_interval", "true interval"], ["on_change", "on change"],
    ["on_any_change", "on any change"],
    ["on_app_start", "on app start"], ["on_capture", "on capture start"],
    ["on_live_start", "on live start"], ["on_live_stop", "on live stop"],
    ["on_readout", "on readout"], ["manual", "manual only"]];

// comparison operators for an on_readout trigger, with human labels for the dropdown.
const VAR_OPS = [["gte", "≥ (at least)"], ["lte", "≤ (at most)"], ["gt", "> (above)"],
    ["lt", "< (below)"], ["eq", "= (equals)"], ["ne", "≠ (not equal)"],
    ["crosses_up", "crosses up through"], ["crosses_down", "crosses down through"]];

export function triggerParts(t, model) {
    const kind = KINDS.some(([v]) => v === t.kind) ? t.kind : "interval";
    const kopt = ([v, l]) => h("option", { value: v, selected: v === kind }, v === kind ? `<${l}>` : l);
    const timed = kind === "interval" || kind === "true_interval";

    // targets: drag the out-port to a producer / file source / toast / sound / action OR pick one here.
    const haveT = new Set(t.targets || []);
    const tgtIds = [...(model.profile.producers || []).map((p) => p.id),
                    ...(model.profile.file_sources || []).map((s) => s.id),
                    ...(model.profile.toasts || []).map((x) => x.id),
                    ...(model.profile.sounds || []).map((x) => x.id),
                    ...(model.profile.actions || []).map((x) => x.id)];
    const targets = srcRow("fires", "producers (sweep), file sources (read), toasts (notify), sounds (play), or actions (dataset op) this trigger fires",
        sourcesInput({
            chips: (t.targets || []).map((p) => ({ value: p, node: model.refNode(p) })),
            free: tgtIds.filter((p) => !haveT.has(p)),
            addLabel: "+ fire target", addinCls: "sv-addin tg-addfire", rmCls: "sv-rmin tg-rmtarget" }));

    const interval = timed
        ? frag(labCell("every", "seconds between fires"),
            h("span", { class: "tg-secs" },
                h("input", { class: "tg-interval", type: "number", min: "1", step: "1", value: t.interval_s || 300 }), " s"))
        : null;

    let watch = null;
    if (kind === "on_change" || kind === "on_any_change") {
        const have = new Set(t.watch || []);
        // watch datasets OR subsets (a subset fires when any of its source datasets gains rows)
        const sources = [...model.datasets(), ...(model.profile.subsets || []).map((s) => s.id)];
        const hint = kind === "on_any_change"
            ? "datasets or subsets; fires on every write, even if a watched subset's visible output is unchanged"
            : "datasets or subsets; the trigger fires when one gains rows";
        watch = srcRow("watch", hint,
            sourcesInput({
                chips: (t.watch || []).map((w) => ({ value: w, node: model.refNode(w) })),
                free: sources.filter((d) => !have.has(d)),
                addLabel: "+ watch source", addinCls: "sv-addin tg-addwatch", rmCls: "sv-rmin tg-rmwatch" }));
    }

    // on_readout: watch one or more live readouts and fire when the condition is met. Chips
    // show each watched readout's id (its identity); the op + threshold set the test.
    let varwatch = null;
    if (kind === "on_readout") {
        const have = new Set(t.readout_watch || []);
        varwatch = frag(
            srcRow("watch", "live readouts; the trigger fires when the condition holds",
                sourcesInput({
                    chips: (t.readout_watch || []).map((vid) => ({ value: vid, node: model.refNode(vid) })),
                    free: model.readouts().filter((v) => !have.has(v.id)).map((v) => v.id),
                    addLabel: "+ watch readout", addinCls: "sv-addin tg-addvarwatch", rmCls: "sv-rmin tg-rmvarwatch" })),
            labCell("when", "how the readout's value is compared to the threshold"),
            h("select", { class: "tg-varop" }, VAR_OPS.map(([v, l]) => h("option", { value: v, selected: v === (t.readout_op || "gte") }, v === (t.readout_op || "gte") ? `<${l}>` : l))),
            labCell("value", "the threshold the readout is compared against"),
            h("input", { class: "tg-varval", type: "number", step: "any", value: t.readout_value ?? 0 }));
    }

    // throttle: minimum ms between actual fires (blank = none) — a global rate limit across all kinds.
    const throttle = frag(
        labCell("throttle", "minimum time between fires (blank = none)"),
        h("span", { class: "tg-secs" },
            h("input", { class: "tg-throttle", type: "number", min: "1", step: "1",
                placeholder: "(none)", value: t.throttle_ms == null ? "" : t.throttle_ms }), " ms"));

    return {
        title: h("input", { class: "gi gi-id tgrename", value: t.id, title: "rename trigger" }),
        body: frag(
            h("div", { class: "lab-grid" },
                targets,
                labCell("kind", "how the trigger decides to fire"),
                h("select", { class: "tg-kind" }, KINDS.map(kopt)),
                interval, watch, varwatch, throttle,
                labCell("progress", "what the trigger is doing (live countdown for timed kinds)"),
                h("span", { class: "tg-prog muted" }, "idle"))),
        foot: h("button", { class: "tg-fire" }, "↻ fire"),
        ports: frag(
            h("span", { class: "port out", title: "drag to a node this trigger should fire" }),
            (kind === "on_change" || kind === "on_any_change") && h("span", { class: "port pwatch", title: "drag to a dataset or subset to watch for new rows" }),
            kind === "on_readout" && h("span", { class: "port pwatch", title: "drag to a readout node to watch its value" })),
    };
}
