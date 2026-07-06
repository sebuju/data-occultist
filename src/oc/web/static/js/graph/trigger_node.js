// Trigger node: fires its target price node(s) on a condition. `interval` fires every N
// seconds; `on_change` fires whenever a watched dataset gains rows (any write path, not only
// live collection), but a watched subset only fires when its computed output actually differs;
// `on_any_change` uses the same watch list but fires on every write reaching it, even one that
// leaves a watched subset's visible output unchanged; `manual` never auto-fires (the sweep
// button drives it). All config persists in the profile YAML. Targets are wired by dragging the
// out-port to a price node; watch datasets and targets can also be added from the dropdowns here.
// Rendering only — wiring is in main.js.
import { h, frag, labCell, srcRow, srcChip, srcInputs, kv, subhead, gspan, trashBtn } from "../dom.js";

const KINDS = [["interval", "interval (periodic)"], ["on_change", "on change"],
    ["on_any_change", "on any change"],
    ["on_app_start", "on app start"], ["on_capture", "on capture start"],
    ["on_live_start", "on live start"], ["on_live_stop", "on live stop"],
    ["on_readout", "on readout (threshold)"], ["manual", "manual only"]];

// comparison operators for an on_readout trigger, with human labels for the dropdown.
const VAR_OPS = [["gte", "≥ (at least)"], ["lte", "≤ (at most)"], ["gt", "> (above)"],
    ["lt", "< (below)"], ["eq", "= (equals)"], ["ne", "≠ (not equal)"],
    ["crosses_up", "crosses up through"], ["crosses_down", "crosses down through"]];

// dataset actions a trigger can perform on its dataset targets when it fires. "" = do nothing.
// clone/move copy into `dataset_dest` (batches = keep batch grouping; resolved = collapse to one).
const DS_ACTIONS = [["", "no action"], ["clear", "clear dataset"],
    ["clone_batches", "clone data (batches)"], ["clone_resolved", "clone data (resolved)"],
    ["move_batches", "move data (batches)"], ["move_resolved", "move data (resolved)"]];

export function triggerParts(t, model) {
    const kind = KINDS.some(([v]) => v === t.kind) ? t.kind : "interval";
    const kopt = ([v, l]) => h("option", { value: v, selected: v === kind }, l);

    const interval = kind === "interval"
        ? frag(labCell("every", "seconds between automatic sweeps"),
            h("span", { class: "tg-secs" },
                h("input", { class: "tg-interval", type: "number", min: "1", step: "1", value: t.interval_s || 300 }), " s"))
        : null;

    let watch = null;
    if (kind === "on_change" || kind === "on_any_change") {
        const have = new Set(t.watch || []);
        // watch datasets OR subsets (a subset fires when any of its source datasets gains rows)
        const sources = [...model.datasets(), ...(model.profile.subsets || []).map((s) => s.id)];
        const opts = sources.filter((d) => !have.has(d)).map((d) => h("option", d));
        const hint = kind === "on_any_change"
            ? "datasets or subsets; fires on every write, even if a watched subset's visible output is unchanged"
            : "datasets or subsets; the trigger fires when one gains rows";
        watch = srcRow("watch", hint,
            srcInputs(
                (t.watch || []).map((w) => srcChip(w, "ds", "tg-rmwatch")),
                "tg-addwatch",
                [h("option", { value: "" }, "+ watch source"), opts],
            ));
    }

    // on_readout: watch one or more live readouts and fire when the condition is met. Chips
    // show each watched readout's id (its identity); the op + threshold set the test.
    let varwatch = null;
    if (kind === "on_readout") {
        const have = new Set(t.readout_watch || []);
        const opts = model.readouts().filter((v) => !have.has(v.id)).map((v) => h("option", { value: v.id }, v.id));
        varwatch = frag(
            srcRow("watch var", "live readouts; the trigger fires when the condition holds",
                srcInputs(
                    (t.readout_watch || []).map((vid) => srcChip(vid, "v", "tg-rmvarwatch")),
                    "tg-addvarwatch",
                    [h("option", { value: "" }, "+ watch readout"), opts],
                )),
            labCell("when", "how the readout's value is compared to the threshold"),
            h("select", { class: "tg-varop" }, VAR_OPS.map(([v, l]) => h("option", { value: v, selected: v === (t.readout_op || "gte") }, l))),
            labCell("value", "the threshold the readout is compared against"),
            h("input", { class: "tg-varval", type: "number", step: "any", value: t.readout_value ?? 0 }));
    }

    // targets: drag the out-port to a producer / file source OR pick one here (same source-row UI
    // as watch). A target is a producer id (sweep/refresh) or a file-source id (read a log/config file).
    const haveT = new Set(t.targets || []);
    const tgtIds = [...(model.profile.producers || []).map((p) => p.id),
                    ...(model.profile.file_sources || []).map((s) => s.id),
                    ...(model.profile.toasts || []).map((x) => x.id),
                    ...(model.profile.sounds || []).map((x) => x.id)];
    const popts = tgtIds.filter((p) => !haveT.has(p)).map((p) => h("option", p));
    const targets = srcRow("fires", "producers (sweep/refresh), file sources (read), toasts (notify), or sounds (play) this trigger fires",
        srcInputs(
            (t.targets || []).map((p) => srcChip(p, "p", "tg-rmtarget")),
            "tg-addfire",
            [h("option", { value: "" }, "+ fire target"), popts],
        ));

    // dataset action: attach the trigger to one or more datasets and pick what it does to them
    // when it fires (clear, or clone/move their data into a destination dataset). Independent of
    // the fire targets above and of `kind`, so any trigger can carry a dataset action.
    const dsHave = new Set(t.dataset_targets || []);
    const dsFree = model.datasets().filter((d) => !dsHave.has(d));
    const dsAction = t.dataset_action || "";
    const hasAction = dsAction !== "";
    const needsDest = dsAction.startsWith("clone_") || dsAction.startsWith("move_");
    const dsAction_ = frag(
        labCell("action", "what this trigger does to its target dataset(s) when it fires"),
        h("select", { class: "tg-dsaction" },
            DS_ACTIONS.map(([v, l]) => h("option", { value: v, selected: v === dsAction }, l))),
        hasAction && h("div", { class: "gspan" },
            srcInputs(
                (t.dataset_targets || []).map((d) => srcChip(d, "ds", "tg-rmds")),
                "tg-addds",
                [h("option", { value: "" }, "+ dataset"), dsFree.map((d) => h("option", d))],
            )),
        needsDest && labCell("into", "destination dataset for clone/move"),
        needsDest && h("select", { class: "tg-dsdest" },
            h("option", { value: "" }, "- dataset -"),
            dsFree.map((d) => h("option", { selected: d === t.dataset_dest }, d))));

    return {
        title: h("input", { class: "gi gi-id tgrename", value: t.id, title: "rename trigger" }),
        body: frag(
            h("div", { class: "lab-grid" },
                labCell("kind", "how the trigger decides to fire"),
                h("select", { class: "tg-kind" }, KINDS.map(kopt)),
                targets,
                interval, watch, varwatch, dsAction_,
                labCell("progress", "what the current/last sweep is doing"),
                h("span", { class: "tg-prog muted" }, "idle"),
                labCell("last fired", "last time this trigger fired"),
                h("span", { class: "tg-last muted" }, "never fired"))),
        foot: h("button", { class: "tg-fire" }, "↻ fire"),
        ports: frag(
            h("span", { class: "port out", title: "drag to a price node this trigger should fire" }),
            (kind === "on_change" || kind === "on_any_change") && h("span", { class: "port pwatch", title: "drag to a dataset or subset to watch for new rows" }),
            kind === "on_readout" && h("span", { class: "port pwatch", title: "drag to a readout node to watch its value" })),
    };
}
