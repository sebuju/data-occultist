// Gate node: a boolean guard on any gateable node — trigger, producer, file-source, toast, sound,
// action, or router. It TESTS a single live value (a readout, a register slot, or a dataset/
// subset's content-hash signature — meant for the `changed` op) against an ordered list of
// conditions combined by and/or, optionally negated. The gate owns the link to every node it
// gates (`targets`, model.gateTargets) — it never fires anything itself, it only permits/blocks
// whatever is wired to its out-port. See GateDef (backend). Rendering only — wiring lives in
// io_wire.js (wireGate), like every other node body.
import { h, frag, labAdd, labCell, srcRow, trashBtn } from "../dom.js";
import { sourcesInput } from "./sources_input.js";
import { slideToggle } from "./node_parts.js";
import * as wiring from "./wiring.js";

// Condition operators (GateCond.when), from the server's wiring table — the same roster
// models.GateWhen is generated from and TriggerRunner._cond_holds evaluates, so the picker can't
// omit an op the server implements (it used to omit `no_digit`/`no_letter`). EXPORTED + reused by
// router_node.js so the cond-row markup lives in ONE place (rule 7 — router imports GATE_WHENS +
// condRow, never re-inlines). Thunks: the table lands at boot, after module eval.
export const GATE_WHENS = () => wiring.opPairs("gate_ops");
export const GATE_WHEN_DESC = () => wiring.opDesc("gate_ops");
// ops that take NO argument — the arg input is hidden for these (a per-op flag in the table).
const NO_ARG = () => new Set(wiring.ops("gate_ops").filter((o) => o.no_arg).map((o) => o.id));

export function condRow(cls, ci, c) {
    const label = (GATE_WHENS().find(([v]) => v === c.when) || [, c.when])[1];
    return h("div", { class: `${cls}-condrow`, dataset: { idx: String(ci) } },
        h("button", { class: `${cls}-condwhen rich-dd-btn`, type: "button",
            title: GATE_WHEN_DESC()[c.when] || "how the tested value must behave for this condition to hold" }, `<${label}>`),
        NO_ARG().has(c.when) ? null
            : h("input", { class: `${cls}-condarg`, value: c.arg ?? "", type: "text", placeholder: "value",
                title: "value the condition compares against — a number, text, a comma list for 'in list', or lo,hi for 'between'" }),
        trashBtn({ cls: `${cls}-condrm`, title: "remove condition" }));
}

export function gateParts(g, model) {
    const conds = g.conds || [];
    const andOn = (g.logic || "or") === "and";
    // source picker: the single readout / register slot / dataset / subset the gate tests. Shown as a chip once set.
    const source = srcRow("source", "the live value this gate tests",
        sourcesInput({
            chips: g.source ? [{ value: g.source, node: model.refNode(g.source) }] : [],
            free: () => model.sourceCandidates("gate", g.id).map((c) => c.ref),
            addLabel: "+ source", addinCls: "sv-addin gate-addsource", rmCls: "sv-rmin gate-rmsource" }));
    // and/or slider — only meaningful once >1 condition exists (below one there's nothing to combine).
    const logic = conds.length > 1
        ? frag(labCell("match", "and = every condition must hold; or = any one"),
            h("label", { class: "gn-slide-wrap" },
                slideToggle({ on: andOn, cls: "gate-logic", title: "and = all conditions hold; or = any" }),
                h("span", { class: "gn-slide-lbl" }, andOn ? "and" : "or")))
        : null;
    // conditions: one condRow each; the "+" add lives in the label (labAdd) like other nodes.
    const condsBox = h("div", { class: "gate-conds" },
        ...conds.map((c, ci) => condRow("gate", ci, c)));
    const ifRow = frag(
        labAdd("if", "conditions — the gate passes when they hold", "gate-addcond", "add condition", true),
        condsBox);
    const negate = srcRow("negate", "pass when the conditions do NOT hold (block-list)",
        slideToggle({ on: !!g.negate, cls: "gate-negate", title: "invert: pass only when the conditions do NOT hold" }));
    // destination: every node (trigger, producer, file-source, toast, sound, action, router) this
    // gate permits/blocks. The gate owns the link (model.gateTargets), so this is the single place
    // it's edited — no per-kind picker, one uniform list.
    const wired = model.gateTargets(g.id);
    const dest = srcRow("targets", "nodes this gate applies to — it permits or blocks each one",
        sourcesInput({
            chips: wired.map((ref) => ({ value: ref, node: model.refNode(ref) })),
            free: () => model.sourceCandidates("gate", g.id, "targets").map((c) => c.ref),
            addLabel: "+ target", addinCls: "sv-addin gate-adddest", rmCls: "sv-rmin gate-rmdest" }));
    return {
        title: h("input", { class: "gi gi-id gate-rename", value: g.id, title: "rename gate" }),
        body: frag(source, dest, logic, ifRow, negate),
        ports: frag(
            h("span", { class: "port in", title: "drag a readout or register here as the tested value" }),
            h("span", { class: "port out", title: "drag to a node this gate should gate" })),
    };
}
