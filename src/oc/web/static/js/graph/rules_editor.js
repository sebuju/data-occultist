// Shared wiring for a field's RULE PIPELINE editor (region / item-field / readout nodes all call
// this), and the armed two-click "remove" primitive every sources-input chip list uses. Split out
// of main.js; armConfirm stays in main and is imported back.
import { makeArmed } from "./armbtn.js";
import { makeClip } from "./clipboard.js";
import { armConfirm } from "./main.js";

// `edit(mutate, { rebuild })` is the ONE way a rule row changes the model: the caller wraps it in
// its node's transaction (nodeEdit), which must clone the clean state BEFORE `mutate` runs — so
// every handler here hands its mutation over rather than performing it and reporting after.
// `rebuild: true` means the row's controls change shape (new operands, a row added/removed), so
// the node body is rebuilt — mid-transaction, without saving, and without ending the transaction.
// Cross-field rule clipboard: "copy" stashes a field's whole pipeline here, "paste" replaces
// another field's rules with a deep clone of it (survives across nodes for this session).
// The shared primitive (clipboard.js) — the forge's pitch/shape sections hold their own clips.
const ruleClip = makeClip(".rulepaste");

export function wireFieldRules(div, fd, { edit }) {
    fd.rules = fd.rules || [];
    const rule = (e) => fd.rules[+e.target.dataset.ri];
    const editVal = (e, k) => { edit(() => { rule(e)[k] = e.target.value; }); };
    const editNum = (e, k) => { edit(() => { rule(e)[k] = +e.target.value; }); };
    const restructure = (mutate) => edit(mutate, { rebuild: true });

    div.querySelector(".ruleadd")?.addEventListener("click", () => {
        restructure(() => fd.rules.push({ when: "always", then: "set", value: "" }));
    });
    ruleClip.wire(div, {
        copyCls: ".rulecopy", pasteCls: ".rulepaste",
        read: () => fd.rules,
        write: (rules) => restructure(() => { fd.rules = rules; }),   // paste REPLACES all current rules
    });
    div.querySelectorAll(".rulemv").forEach((b) => b.addEventListener("click", (e) => {
        const i = +e.currentTarget.dataset.ri, j = i + +e.currentTarget.dataset.d;
        if (j < 0 || j >= fd.rules.length) return;
        restructure(() => { const [r] = fd.rules.splice(i, 1); fd.rules.splice(j, 0, r); });   // reorder = pipeline order
    }));
    // when / then change the row's operands -> rebuild; the rest are plain in-place edits
    div.querySelectorAll(".rule-when").forEach((s) => s.addEventListener("change", (e) => restructure(() => { rule(e).when = e.target.value; })));
    div.querySelectorAll(".rule-then").forEach((s) => s.addEventListener("change", (e) => restructure(() => { rule(e).then = e.target.value; })));
    div.querySelectorAll(".rule-dmode").forEach((s) => s.addEventListener("change", (e) => restructure(() => { rule(e).dict_mode = e.target.value; })));
    div.querySelectorAll(".rule-strategy").forEach((s) => s.addEventListener("change", (e) => restructure(() => { rule(e).strategy = e.target.value; })));   // toggles the sep input
    div.querySelectorAll(".rule-arg").forEach((inp) => inp.addEventListener("input", (e) => editVal(e, "arg")));
    div.querySelectorAll(".rule-val").forEach((inp) => inp.addEventListener("input", (e) => editVal(e, "value")));
    div.querySelectorAll(".rule-sep").forEach((inp) => inp.addEventListener("input", (e) => editVal(e, "sep")));
    div.querySelectorAll(".rule-udict").forEach((s) => s.addEventListener("change", (e) => editVal(e, "dict_id")));
    div.querySelectorAll(".rule-fuzzy").forEach((inp) => inp.addEventListener("change", (e) => editNum(e, "fuzzy")));
    // delete is an armed two-click (rule 2): first click turns it yellow, a click anywhere else
    // or Escape resets it, a second click removes the rule.
    div.querySelectorAll(".rule-del").forEach((b) => armConfirm(b, () => {
        restructure(() => fd.rules.splice(+b.dataset.ri, 1));
    }, { silent: true, resetOnOutside: true }));
}

// Two-stage armed removal for a sources-input chip's trash (CLAUDE.md rule 2 — no confirm()).
// ONE helper every wired-source list's remove wiring calls (rule 7) — the pill turns `.armed`
// (yellow) on the first click within `container`, and `onFire(value)` (the actual model mutation
// + rebuild/edges/autosave the caller needs) runs only on a second click within the arm window.
// `selector` scopes to one chip list (default the generic "sv-rmin" trash class; a node with more
// than one sources-input list — e.g. a trigger's targets/watch/readout-watch — gives each its own
// class so their removals don't cross-fire).
export function wireArmedRemove(container, selector, onFire, { pill = ".sv-input" } = {}) {
    container.querySelectorAll(selector).forEach((b) => {
        const el = b.closest(pill);   // arm target — the whole pill/row (caller picks; process arms .pr-maprow)
        if (!el) return;
        const armed = makeArmed({
            onArm: () => el.classList.add("armed"),
            onTimeout: () => el.classList.remove("armed"),
            onFire: () => onFire(b.dataset.val),
        });
        b.addEventListener("click", (e) => { e.stopPropagation(); armed.trigger(); });
    });
}
