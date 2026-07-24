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

// per-op meta line for the rich picker (handover-rich-dropdowns recipe A) — mined from the old
// single `-condwhen` tooltip, split per option since a native <option title> never renders.
export const GATE_WHEN_DESC = {
    always: "holds unconditionally — every tick",
    empty: "the value is empty/blank",
    has_digit: "the value contains at least one digit",
    all_digit: "the value is all digits (a whole number)",
    has_letter: "the value contains at least one letter",
    all_letter: "the value is all letters (no digits)",
    equal: "the value equals the given text/number exactly",
    not_equal: "the value does not equal the given text/number",
    contains: "the value contains the given substring",
    in: "the value matches one of a comma-separated list",
    gte: "the value, read as a number, is >= the given number",
    lte: "the value, read as a number, is <= the given number",
    gt: "the value, read as a number, is > the given number",
    lt: "the value, read as a number, is < the given number",
    eq: "the value, read as a number, equals the given number",
    ne: "the value, read as a number, does not equal the given number",
    between: "the value, read as a number, falls between lo,hi (inclusive)",
    crosses_up: "the value just crossed UP through the given number this tick (was below, now at/above)",
    crosses_down: "the value just crossed DOWN through the given number this tick (was above, now at/below)",
    changed: "the value (or dataset/subset content signature) changed since the last tick",
};

// One condition row: [when rich-picker button] [arg input, unless a no-arg op] [remove]. `cls`
// scopes the wiring classes ("gate" / "routerb") so the two callers' handlers don't cross-fire;
// `ci` tags the row's index (data-idx). Shared by gate + router (rule 7). The picker itself opens
// from the wiring side (io_wire.js), which has model access this pure builder doesn't.
export function condRow(cls, ci, c) {
    const label = (GATE_WHENS.find(([v]) => v === c.when) || [, c.when])[1];
    return h("div", { class: `${cls}-condrow`, dataset: { idx: String(ci) } },
        h("button", { class: `${cls}-condwhen rich-dd-btn`, type: "button",
            title: GATE_WHEN_DESC[c.when] || "how the tested value must behave for this condition to hold" }, `<${label}>`),
        NO_ARG.has(c.when) ? null
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
    const allGateable = () => [
        ...(model.profile.triggers || []).map((t) => t.id),
        ...(model.profile.producers || []).map((p) => p.id),
        ...(model.profile.file_sources || []).map((s) => s.id),
        ...(model.profile.toasts || []).map((x) => x.id),
        ...(model.profile.sounds || []).map((x) => x.id),
        ...(model.profile.actions || []).map((x) => x.id),
        ...(model.profile.routers || []).map((r) => r.id),
    ];
    const dest = srcRow("targets", "nodes this gate applies to — it permits or blocks each one",
        sourcesInput({
            chips: wired.map((ref) => ({ value: ref, node: model.refNode(ref) })),
            free: () => allGateable().filter((ref) => !wired.includes(ref)),
            addLabel: "+ target", addinCls: "sv-addin gate-adddest", rmCls: "sv-rmin gate-rmdest" }));
    return {
        title: h("input", { class: "gi gi-id gate-rename", value: g.id, title: "rename gate" }),
        body: frag(source, dest, logic, ifRow, negate),
        ports: frag(
            h("span", { class: "port in", title: "drag a readout or register here as the tested value" }),
            h("span", { class: "port out", title: "drag to a node this gate should gate" })),
    };
}
