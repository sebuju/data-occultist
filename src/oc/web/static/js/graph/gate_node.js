// Gate node: a boolean guard on a trigger. It TESTS a single live value (a readout, or a register
// slot) against an ordered list of conditions combined by and/or, optionally negated. A trigger
// lists the gates it must satisfy before it fires — the gate never fires anything itself, it only
// permits/blocks the trigger(s) wired to its out-port. See GateDef (backend). Rendering only —
// wiring lives in io_wire.js (wireGate), like every other node body.
import { h, frag, labAdd, labCell, srcRow, trashBtn } from "../dom.js";
import { sourcesInput } from "./sources_input.js";
import { slideToggle } from "./node_parts.js";

// Condition operators (GateCond.when) as [value, label]. EXPORTED + reused by router_node.js so the
// cond-row markup lives in ONE place (rule 7 — router imports GATE_WHENS + condRow, never re-inlines).
export const GATE_WHENS = [
    ["always", "always"], ["empty", "empty"], ["has_digit", "has digit"], ["all_digit", "is a number"],
    ["has_letter", "has letter"], ["all_letter", "is text"], ["equal", "equals"], ["not_equal", "not equal"],
    ["contains", "contains"], ["in", "in list"], ["gte", "gte num"], ["lte", "lte num"], ["gt", "gt num"],
    ["lt", "lt num"], ["eq", "eq num"], ["ne", "not eq"], ["between", "between"],
    ["crosses_up", "crosses up"], ["crosses_down", "crosses down"], ["changed", "changed"],
];
// ops that take NO argument — the arg input is hidden for these.
const NO_ARG = new Set(["always", "empty", "has_digit", "all_digit", "has_letter", "all_letter", "changed"]);

// One condition row: [when select] [arg input, unless a no-arg op] [remove]. `cls` scopes the wiring
// classes ("gate" / "routerb") so the two callers' handlers don't cross-fire; `ci` tags the row's
// index (data-idx). Shared by gate + router (rule 7).
export function condRow(cls, ci, c) {
    const wopt = ([v, l]) => h("option", { value: v, selected: v === c.when }, v === c.when ? `<${l}>` : l);
    return h("div", { class: `${cls}-condrow`, dataset: { idx: String(ci) } },
        h("select", { class: `${cls}-condwhen`, title: "how the tested value must behave for this condition to hold" }, GATE_WHENS.map(wopt)),
        NO_ARG.has(c.when) ? null
            : h("input", { class: `${cls}-condarg`, value: c.arg ?? "", type: "text", placeholder: "value",
                title: "value the condition compares against — a number, text, a comma list for 'in list', or lo,hi for 'between'" }),
        trashBtn({ cls: `${cls}-condrm`, title: "remove condition" }));
}

export function gateParts(g, model) {
    const conds = g.conds || [];
    const andOn = (g.logic || "or") === "and";
    // source picker: the single readout / register slot the gate tests. Shown as a chip once set.
    const source = srcRow("source", "the live value this gate tests",
        sourcesInput({
            chips: g.source ? [{ value: g.source, node: model.refNode(g.source) }] : [],
            free: model.sourceCandidates("gate", g.id).map((c) => c.ref),
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
    // destination: the trigger(s) this gate is wired to (it permits/blocks their fire). Shown as an
    // editable picker as well as the out-port; the trigger owns the ref (model.gateTriggers).
    const wired = model.gateTriggers(g.id);
    const dest = srcRow("gates", "triggers this gate applies to — it permits or blocks their fire",
        sourcesInput({
            chips: wired.map((tid) => ({ value: tid, node: `trigger:${tid}` })),
            free: (model.profile.triggers || []).map((t) => t.id).filter((tid) => !wired.includes(tid)),
            addLabel: "+ trigger", addinCls: "sv-addin gate-adddest", rmCls: "sv-rmin gate-rmdest" }));
    return {
        title: h("input", { class: "gi gi-id gate-rename", value: g.id, title: "rename gate" }),
        body: h("div", { class: "lab-grid" }, source, dest, logic, ifRow, negate),
        ports: frag(
            h("span", { class: "port in", title: "drag a readout or register here as the tested value" }),
            h("span", { class: "port out", title: "drag to a trigger this gate should gate" })),
    };
}
