// Action node: runs a dataset op (clear, or clone/move data into a destination) when fired. A
// trigger names this node's id in its `targets` (drag the trigger's fire-port here, or pick it in
// the trigger's "fires"), so any trigger condition can act on datasets — the shared
// dataset_ops.fire_dataset_target funnel does the work (same as an automatic collector fire).
// Drag this node's out-port onto a dataset to add it as a target. Rendering only — wiring is in
// main.js (wireAction). Config persists in the profile YAML.
import { h, frag, labCell, srcRow, srcChip, srcInputs } from "../dom.js";

// dataset ops this node can perform. "" = no-op. clone/move copy into `dest` (batches = keep batch
// grouping; resolved = collapse to one). move also clears the source.
const ACTIONS = [["", "no action"], ["clear", "clear dataset"],
    ["clone_batches", "clone data (batches)"], ["clone_resolved", "clone data (resolved)"],
    ["move_batches", "move data (batches)"], ["move_resolved", "move data (resolved)"]];

export function actionParts(x, model) {
    const cur = x.action || "";
    const needsDest = cur.startsWith("clone_") || cur.startsWith("move_");
    const dsHave = new Set(x.datasets || []);
    const dsFree = model.datasets().filter((d) => !dsHave.has(d));
    return {
        title: h("input", { class: "gi gi-id acrename", value: x.id, title: "rename action" }),
        body: frag(
            h("div", { class: "lab-grid" },
                labCell("action", "what this node does to its target dataset(s) when fired"),
                h("select", { class: "ac-action" },
                    ACTIONS.map(([v, l]) => h("option", { value: v, selected: v === cur }, v === cur ? `<${l}>` : l))),
                srcRow("datasets", "datasets this action operates on when fired",
                    srcInputs(
                        (x.datasets || []).map((d) => srcChip(d, "ds", "ac-rmds")),
                        "ac-addds",
                        [h("option", { value: "" }, "+ dataset"), dsFree.map((d) => h("option", d))])),
                needsDest && labCell("into", "destination dataset for clone/move"),
                needsDest && h("select", { class: "ac-dest" },
                    h("option", { value: "" }, "- dataset -"),
                    dsFree.map((d) => h("option", { selected: d === x.dest }, d === x.dest ? `<${d}>` : d))))),
        ports: h("span", { class: "port out", title: "drag to a dataset this action operates on" }),
    };
}
