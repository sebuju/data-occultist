// Trigger node: fires its target price node(s) on a condition. `interval` fires every N
// seconds; `on_change` fires when a watched dataset gains rows (pricing just those, live);
// `manual` never auto-fires (the sweep button drives it). All config persists in the
// profile YAML. Targets are wired by dragging the out-port to a price node; watch datasets
// and targets can also be added from the dropdowns here. Rendering only — wiring is in main.js.
import { h, frag, TRASH, labCell } from "../dom.js";

const KINDS = [["interval", "interval (periodic)"], ["on_change", "on change (live)"],
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

// removable source pill — same look as a subset's join-source pills (.sv-input). `rmCls`
// is the wiring hook (tg-rmwatch / tg-rmtarget); `attrKey`/`attrVal` carry the id back to
// the handler (e.g. data-ds / data-p, read by the wiring as el.dataset.ds / .p).
const srcChip = (val, attrKey, rmCls) =>
    h("span", { class: "sv-input" }, val,
        h("button", { class: `sv-rmin danger ${rmCls}`, dataset: { [attrKey]: val }, title: "remove" }, TRASH()));

// the pills + a "+ …" add-select that go in a watch/fires control cell. `chips` is an array
// of chip nodes; `addOpts` an array of <option> nodes.
const srcInputs = (chips, addCls, addOpts) =>
    h("div", { class: "sv-inputs" }, chips,
        h("span", { class: "sv-input sv-add" }, h("select", { class: `sv-addin ${addCls}` }, addOpts)));

export function triggerParts(t, model) {
    const kind = KINDS.some(([v]) => v === t.kind) ? t.kind : "interval";
    const kopt = ([v, l]) => h("option", { value: v, selected: v === kind }, l);

    const interval = kind === "interval"
        ? frag(labCell("every", "seconds between automatic sweeps"),
            h("span", { class: "tg-secs" },
                h("input", { class: "tg-interval", type: "number", min: "1", step: "1", value: t.interval_s || 300 }), " s"))
        : null;

    let watch = null;
    if (kind === "on_change") {
        const have = new Set(t.watch || []);
        // watch datasets OR subsets (a subset fires when any of its source datasets gains rows)
        const sources = [...model.datasets(), ...(model.profile.subsets || []).map((s) => s.id)];
        const opts = sources.filter((d) => !have.has(d)).map((d) => h("option", d));
        watch = frag(
            labCell("watch", "datasets or subsets; the trigger fires when one gains rows", true),
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
            labCell("watch var", "live readouts; the trigger fires when the condition holds", true),
            srcInputs(
                (t.readout_watch || []).map((vid) => srcChip(vid, "v", "tg-rmvarwatch")),
                "tg-addvarwatch",
                [h("option", { value: "" }, "+ watch readout"), opts],
            ),
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
    const targets = frag(
        labCell("fires", "producers (sweep/refresh), file sources (read), toasts (notify), or sounds (play) this trigger fires", true),
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
    const needsDest = dsAction.startsWith("clone_") || dsAction.startsWith("move_");
    const dsAction_ = frag(
        labCell("datasets", "datasets this trigger acts on when it fires", true),
        srcInputs(
            (t.dataset_targets || []).map((d) => srcChip(d, "ds", "tg-rmds")),
            "tg-addds",
            [h("option", { value: "" }, "+ dataset"), dsFree.map((d) => h("option", d))],
        ),
        (t.dataset_targets || []).length ? labCell("action", "what to do to the target dataset(s)") : null,
        (t.dataset_targets || []).length
            ? h("select", { class: "tg-dsaction" },
                DS_ACTIONS.map(([v, l]) => h("option", { value: v, selected: v === dsAction }, l)))
            : null,
        needsDest && labCell("into", "destination dataset for clone/move"),
        needsDest && h("select", { class: "tg-dsdest" },
            h("option", { value: "" }, "- dataset -"),
            dsFree.map((d) => h("option", { selected: d === t.dataset_dest }, d))));

    return {
        title: h("input", { class: "gi gi-id tgrename", value: t.id, title: "rename trigger" }),
        body: frag(
            h("div", { class: "lab-grid" },
                targets,
                labCell("kind", "how the trigger decides to fire"),
                h("select", { class: "tg-kind" }, KINDS.map(kopt)),
                interval, watch, varwatch, dsAction_,
                labCell("progress", "what the current/last sweep is doing"),
                h("span", { class: "tg-prog muted" }, "idle"),
                labCell("last fired", "last time this trigger fired"),
                h("span", { class: "tg-last muted" }, "never fired")),
            h("div", { class: "gn-foot" }, h("button", { class: "tg-fire" }, "↻ fire"))),
        ports: frag(
            h("span", { class: "port out", title: "drag to a price node this trigger should fire" }),
            kind === "on_change" && h("span", { class: "port pwatch", title: "drag to a dataset or subset to watch for new rows" }),
            kind === "on_readout" && h("span", { class: "port pwatch", title: "drag to a readout node to watch its value" })),
    };
}
