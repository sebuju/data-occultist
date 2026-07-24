// Shared wiring for a field's RULE PIPELINE editor (region / item-field / readout nodes all call
// this), and the armed two-click "remove" primitive every sources-input chip list uses. Split out
// of main.js; armConfirm stays in main and is imported back.
import { makeArmed } from "./armbtn.js";
import { makeClip } from "./clipboard.js";
import { armConfirm } from "./main.js";
import { richPickerPop } from "./rich_picker.js";
import {
    RULE_WHEN, RULE_WHEN_DESC, RULE_THEN, RULE_THEN_DESC, EXTRACTS, EXTRACT_DESC,
    DICT_MODES, DICT_MODE_DESC, dictChoices, okRuleType,
} from "./node_parts.js";

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
    // when / then / strategy / dmode / udict are rich-dd-btn pickers (handover-rich-dropdowns):
    // click opens richPickerPop, pick mutates + (when/then/strategy/dmode) rebuilds since they
    // change the row's operands; the rest are plain in-place edits.
    const ftype = fd.type || "text";
    const pickBtn = (btnCls, opts, descs, current, onPick, disabledCode) => {
        div.querySelectorAll(btnCls).forEach((btn) => btn.addEventListener("click", (e) => {
            const b = e.currentTarget;
            richPickerPop({
                anchor: b, current: current(b),
                groups: [[null, opts.map((row) => ({ value: row[0], label: row[1], meta: descs[row[0]] || "",
                    disabled: disabledCode ? !okRuleType(row[disabledCode], ftype) : false }))]],
                onPick: (v) => onPick(b, v),
            });
        }));
    };
    pickBtn(".rule-when", RULE_WHEN, RULE_WHEN_DESC, (b) => rule({ target: b }).when || "always",
        (b, v) => restructure(() => { rule({ target: b }).when = v; }), 3);
    pickBtn(".rule-then", RULE_THEN, RULE_THEN_DESC, (b) => rule({ target: b }).then || "set",
        (b, v) => restructure(() => { rule({ target: b }).then = v; }), 2);
    pickBtn(".rule-dmode", DICT_MODES, DICT_MODE_DESC, (b) => rule({ target: b }).dict_mode || "correct",
        (b, v) => restructure(() => { rule({ target: b }).dict_mode = v; }));
    pickBtn(".rule-strategy", EXTRACTS.filter(([v]) => v !== "whole"), EXTRACT_DESC, (b) => rule({ target: b }).strategy || "number",
        (b, v) => restructure(() => { rule({ target: b }).strategy = v; }));
    div.querySelectorAll(".rule-udict").forEach((btn) => btn.addEventListener("click", (e) => {
        const b = e.currentTarget, r = rule({ target: b }), cur = r.dict_id || "";
        richPickerPop({
            anchor: b, current: cur,
            groups: [[null, dictChoices(cur).map(([v, l]) => ({ value: v, label: l }))]],
            onPick: (v) => { edit(() => { rule({ target: b }).dict_id = v; }); },
        });
    }));
    div.querySelectorAll(".rule-arg").forEach((inp) => inp.addEventListener("input", (e) => editVal(e, "arg")));
    div.querySelectorAll(".rule-val").forEach((inp) => inp.addEventListener("input", (e) => editVal(e, "value")));
    div.querySelectorAll(".rule-sep").forEach((inp) => inp.addEventListener("input", (e) => editVal(e, "sep")));
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
