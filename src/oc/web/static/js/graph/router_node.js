// Router node: branches a single live value (a readout, or a register slot) to different targets.
// Each branch carries its own condition list (and/or) + target list; the FIRST branch whose conds
// match fires that branch's targets (producers/toasts/sounds/actions). See RouterDef (backend).
// Rendering only — wiring lives in io_wire.js (wireRouter), like every other node body. The cond
// rows reuse gate_node.js's shared condRow/GATE_WHENS (rule 7 — no duplicated cond-row markup).
import { h, frag, labAdd, srcRow, trashBtn } from "../dom.js";
import { sourcesInput } from "./sources_input.js";
import { slideToggle } from "./node_parts.js";
import { condRow } from "./gate_node.js";

export function routerParts(r, model) {
    // source picker: the single readout / register slot every branch tests. Shown as a chip once set.
    const source = srcRow("source", "the live value this router tests",
        sourcesInput({
            chips: r.source ? [{ value: r.source, node: model.refNode(r.source) }] : [],
            free: model.sourceCandidates("router", r.id).map((c) => c.ref),
            addLabel: "+ source", addinCls: "sv-addin router-addsource", rmCls: "sv-rmin router-rmsource" }));

    // every id a branch could target (same set a trigger fires): producers / file sources / toasts /
    // sounds / actions. Filtered per-branch against what that branch already holds.
    const allTargets = [
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
        // branch. The whole "branch N · if [+]" is ONE label line (labAdd), the add-condition button
        // carrying the branch index like other nodes.
        const branchLabel = labAdd(`branch ${bi + 1} · if`, "conditions for this branch (first matching branch wins)",
            "routerb-addcond", "add condition", true, { bi: String(bi) });
        const condsBox = h("div", { class: "routerb-conds", dataset: { bi: String(bi) } },
            ...conds.map((c, ci) => condRow("routerb", ci, c)));
        const logic = conds.length > 1
            ? h("label", { class: "gn-slide-wrap" },
                slideToggle({ on: andOn, cls: "routerb-logic", title: "and = all conditions hold; or = any" }),
                h("span", { class: "gn-slide-lbl" }, andOn ? "and" : "or"))
            : null;
        const targets = h("div", { class: "routerb-targets", dataset: { bi: String(bi) } },
            sourcesInput({
                chips: (b.targets || []).map((p) => ({ value: p, node: model.refNode(p) })),
                free: allTargets.filter((p) => !have.has(p)),
                addLabel: "+ target", addinCls: "sv-addin routerb-addtarget", rmCls: "sv-rmin routerb-rmtarget" }));
        // the whole branch is one [data-bi] block (cond rows + targets read their bi off it). The
        // label line (branchLabel) sits in grid col 1, this body in col 2.
        const branchBody = h("div", { class: "routerb", dataset: { bi: String(bi) } },
            condsBox, logic, targets,
            trashBtn({ cls: "router-rmbranch", dataset: { bi: String(bi) }, title: "remove branch" }));
        return frag(branchLabel, branchBody);
    });

    // fired by: the trigger(s) that drive this router (they name it in their targets). Shown as an
    // editable picker as well as the in-port; the trigger owns the ref (model.routerTriggers).
    const wired = model.routerTriggers(r.id);
    const firedBy = srcRow("fired by", "triggers that fire this router",
        sourcesInput({
            chips: wired.map((tid) => ({ value: tid, node: `trigger:${tid}` })),
            free: (model.profile.triggers || []).map((t) => t.id).filter((tid) => !wired.includes(tid)),
            addLabel: "+ trigger", addinCls: "sv-addin router-adddest", rmCls: "sv-rmin router-rmdest" }));
    return {
        title: h("input", { class: "gi gi-id router-rename", value: r.id, title: "rename router" }),
        body: h("div", { class: "lab-grid" }, source, firedBy, ...branches, h("button", { class: "router-addbranch" }, "+ branch")),
        ports: frag(
            h("span", { class: "port in", title: "drag a readout or register here" }),
            h("span", { class: "port out", title: "drag to a producer / toast / sound / action for the current branch" })),
    };
}
