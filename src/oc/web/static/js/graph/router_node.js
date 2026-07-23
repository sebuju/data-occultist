// Router node: branches a single live value (a readout, a register slot, or a dataset/subset's
// content-hash signature) to different targets.
// Each branch carries its own condition list (and/or) + target list; the FIRST branch whose conds
// match fires that branch's targets (producers/toasts/sounds/actions). See RouterDef (backend).
// Rendering only — wiring lives in io_wire.js (wireRouter), like every other node body. The cond
// rows reuse gate_node.js's shared condRow/GATE_WHENS (rule 7 — no duplicated cond-row markup).
import { h, frag, labAdd, labCell, srcRow } from "../dom.js";
import { sourcesInput } from "./sources_input.js";
import { slideToggle } from "./node_parts.js";
import { condRow } from "./gate_node.js";

export function routerParts(r, model) {
    // source picker: the single readout / register slot / dataset / subset every branch tests. Shown as a chip once set.
    const source = srcRow("source", "the live value this router tests",
        sourcesInput({
            chips: r.source ? [{ value: r.source, node: model.refNode(r.source) }] : [],
            free: () => model.sourceCandidates("router", r.id).map((c) => c.ref),
            addLabel: "+ source", addinCls: "sv-addin router-addsource", rmCls: "sv-rmin router-rmsource" }));

    // every id a branch could target (same set a trigger fires): producers / file sources / toasts /
    // sounds / actions. Filtered per-branch against what that branch already holds.
    const allTargets = () => [
        ...(model.profile.producers || []).map((p) => p.id),
        ...(model.profile.file_sources || []).map((s) => s.id),
        ...(model.profile.toasts || []).map((x) => x.id),
        ...(model.profile.sounds || []).map((x) => x.id),
        ...(model.profile.actions || []).map((x) => x.id),
    ];

    const branches = (r.branches || []).map((b, bi) => {
        const conds = b.conds || [];
        const andOn = (b.logic || "or") === "and";
        const have = new Set(b.targets || []);
        // cond rows are PER-BRANCH — scope with a wrapping [data-bi] so the wiring resolves the
        // branch. Branches are unnamed — the "if [+]" label heads each block, the add-condition
        // button carrying the branch index; stack order IS the priority (first match wins).
        const branchLabel = labAdd("if", "conditions for this branch (first matching branch wins)",
            "routerb-addcond", "add condition", true, { bi: String(bi) });
        const condsBox = h("div", { class: "routerb-conds", dataset: { bi: String(bi) } },
            ...conds.map((c, ci) => condRow("routerb", ci, c)));
        const logic = conds.length > 1
            ? h("label", { class: "gn-slide-wrap" },
                slideToggle({ on: andOn, cls: "routerb-logic", title: "and = all conditions hold; or = any" }),
                h("span", { class: "gn-slide-lbl" }, andOn ? "and" : "or"))
            : null;
        const targets = h("div", { class: "routerb-targets", dataset: { bi: String(bi) } },
            labCell("then", "targets fired when this branch's conditions hold"),
            sourcesInput({
                chips: (b.targets || []).map((p) => ({ value: p, node: model.refNode(p) })),
                free: () => allTargets().filter((p) => !have.has(p)),
                addLabel: "+ target", addinCls: "sv-addin routerb-addtarget", rmCls: "sv-rmin routerb-rmtarget" }));
        // remove-branch: a bare red text button ("remove branch" IS the button), hugging the right edge.
        const rmRow = h("div", { class: "routerb-rmrow" },
            h("button", { class: "router-rmbranch routerb-rmbtn", dataset: { bi: String(bi) }, title: "remove this branch" }, "remove branch"));
        // one full-width block per branch (spans both grid cols via .gspan): the label line heads
        // it, then conds / logic / targets / remove, all reading their bi off the wrapping [data-bi].
        return h("div", { class: "routerb gspan", dataset: { bi: String(bi) } },
            branchLabel, condsBox, logic, targets, rmRow);
    });

    // fired by: the trigger(s) that drive this router (they name it in their targets). Shown as an
    // editable picker as well as the in-port; the trigger owns the ref (model.routerTriggers).
    const wired = model.routerTriggers(r.id);
    const firedBy = srcRow("fired by", "triggers that fire this router",
        sourcesInput({
            chips: wired.map((tid) => ({ value: tid, node: `trigger:${tid}` })),
            free: () => (model.profile.triggers || []).map((t) => t.id).filter((tid) => !wired.includes(tid)),
            addLabel: "+ trigger", addinCls: "sv-addin router-adddest", rmCls: "sv-rmin router-rmdest" }));
    return {
        title: h("input", { class: "gi gi-id router-rename", value: r.id, title: "rename router" }),
        body: frag(source, firedBy, ...branches, h("button", { class: "router-addbranch" }, "+ branch")),
        ports: frag(
            h("span", { class: "port in", title: "drag a readout or register here" }),
            h("span", { class: "port out", title: "drag to a producer / toast / sound / action for the current branch" })),
    };
}
