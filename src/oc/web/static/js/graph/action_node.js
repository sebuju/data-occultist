// Action node: runs a dataset op (clear, or clone/move data into a destination) when fired. A
// trigger names this node's id in its `targets` (drag the trigger's fire-port here, or pick it in
// the trigger's "fires"), so any trigger condition can act on datasets — the shared
// dataset_ops.fire_dataset_target funnel does the work (same as an automatic collector fire).
// Drag this node's out-port onto a dataset to add it as a target. Rendering only — wiring is in
// main.js (wireAction). Config persists in the profile YAML.
import { h, frag, labCell, srcRow } from "../dom.js";
import { sourcesInput } from "./sources_input.js";
import { slotRow, REG_TAG } from "./reg_slots.js";

// dataset ops this node can perform. "" = no-op. clone/move copy into `dest` (batches = keep batch
// grouping; resolved = collapse to one). move also clears the source.
const ACTIONS = [["", "no action"], ["clear", "clear sources"],
    ["clone_batches", "clone data (batches)"], ["clone_resolved", "clone data (resolved)"],
    ["move_batches", "move data (batches)"], ["move_resolved", "move data (resolved)"]];

export function actionParts(x, model) {
    const cur = x.action || "";
    const needsDest = cur.startsWith("clone_") || cur.startsWith("move_");
    const srcs = model.actionSources(x.id);                              // [{kind,id,ref}] datasets + registers
    const have = new Set(srcs.map((s) => s.ref));
    // free options: every dataset + register not already wired, each a prefixed ref with a typed label
    const free = [
        ...model.datasets().filter((d) => !have.has(`dataset:${d}`)).map((d) => ({ value: `dataset:${d}`, label: d })),
        ...model.registers().filter((r) => !have.has(`register:${r}`)).map((r) => ({ value: `register:${r}`, label: r })),
    ];
    // clone/move destinations are datasets only (a register can't be a dest); exclude the action's
    // own dataset sources so you can't pick a source as its own dest (the server no-ops that anyway).
    const dsSrc = new Set(srcs.filter((s) => s.kind === "dataset").map((s) => s.id));
    const dsFree = model.datasets().filter((d) => !dsSrc.has(d));
    // per-register slot targeting sub-rows (only for register sources) — E
    const regSrcs = srcs.filter((s) => s.kind === "register");
    return {
        title: h("input", { class: "gi gi-id acrename", value: x.id, title: "rename action" }),
        body: frag(
            h("div", { class: "lab-grid" },
                srcRow("sources", "datasets and registers this action operates on when fired",
                    sourcesInput({
                        chips: srcs.map((s) => ({ value: s.ref, label: s.kind === "register" ? REG_TAG + s.id : s.id, node: model.refNode(s.ref) })),
                        free, addLabel: "+ source", addinCls: "sv-addin ac-addsrc", rmCls: "sv-rmin ac-rmsrc" })),
                labCell("action", "what this node does to its sources when fired"),
                h("select", { class: "ac-action" },
                    ACTIONS.map(([v, l]) => h("option", { value: v, selected: v === cur }, v === cur ? `<${l}>` : l))),
                ...regSrcs.map((s) => slotRow({
                    regId: s.id,
                    keys: model.registerSources(s.id).filter((k) => k.kind === "readout").map((k) => k.id),
                    targeted: model.actionSlots(x.id, s.id),
                    hint: `which of ${s.id}'s keys this action operates on (default all)` })),
                needsDest && labCell("into", "destination dataset for clone/move"),
                needsDest && h("select", { class: "ac-dest" },
                    h("option", { value: "" }, "- dataset -"),
                    dsFree.map((d) => h("option", { selected: d === x.dest }, d === x.dest ? `<${d}>` : d))))),
        foot: h("button", { class: "ac-fire", title: "run this action now on its sources" }, "↻ fire"),
        ports: h("span", { class: "port out", title: "drag to a dataset or register this action operates on" }),
    };
}
