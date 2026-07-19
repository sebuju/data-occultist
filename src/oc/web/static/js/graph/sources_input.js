// The ONE "sources input" widget (rule 7). A wrapping row of removable dataset/subset/etc. chips
// plus a "+ add" <select>. Subset joins, producer fetch-sources, dictionary feeds, dataset
// sources, register readouts, trigger watch/targets, toast sources, and action datasets all build
// their source list through this instead of hand-rolling chip + add-select markup (this replaced
// the older, near-identical srcChip/srcInputs pair in dom.js — one widget, not two).
//
// STRUCTURE only (render only — wiring lives in main.js, same rule every other node-body builder
// in this codebase follows). Each chip carries the data main.js's generic per-node wiring needs:
//   - `data-node` (if the chip has a source node) -> click the pill body (not the trash) to
//     pan+zoom the canvas there. Wired ONCE, generically, for every `.sv-input[data-node]`.
//   - the trash carries `rmCls` (default `sv-rmin`) + `data-val="<value>"` -> two-stage armed
//     removal (CLAUDE.md rule 2 — no confirm()), wired per-list via `wireArmedRemove` (main.js),
//     which turns the WHOLE pill `.armed` (yellow) on the first click.
//
// sourcesInput({ chips, free, addLabel?, rmCls?, addinCls?, rmTitle? }) -> a `.sv-inputs` Node
//   chips    : [{ value, label?, node? }]  one removable pill each (label defaults to value;
//              node = a graph node id, e.g. from model.refNode(ref) — omit/null if not focusable)
//   free     : addable options for the "+" select — string[] or [{ value, label? }]
//   addLabel : the select's placeholder option text (default "+ source")
//   rmCls    : class on each chip's trash button (default "sv-rmin") — give lists sharing one
//              node (e.g. a trigger's targets/watch/readout-watch) distinct classes so their
//              armed-remove wiring doesn't cross-fire.
//   addinCls : class on the add <select>, the caller's own delegated "change" wiring hook
//   rmTitle  : each chip trash's tooltip (default "remove input")
import { h, trashBtn } from "../dom.js";
import { comboPopover } from "./combo_popover.js";

export function sourcesInput({ chips, free, addLabel = "+ source", rmCls = "sv-rmin", addinCls = "sv-addin", rmTitle = "remove input" }) {
    const pills = (chips || []).map((c) => h("span", { class: "sv-input", dataset: c.node ? { node: c.node } : null },
        c.label ?? c.value,
        trashBtn({ cls: rmCls, dataset: { val: c.value }, title: rmTitle })));
    const freeOpts = (free || []).map((f) => (typeof f === "string" ? { value: f, label: f } : f));
    // The add control is a readonly "+" trigger that carries addinCls (so every caller's delegated
    // `change` handler still finds it, unchanged). Clicking opens the searchable combo popover; on
    // pick we set the trigger's value + fire a `change` so the caller's existing wiring runs, then
    // clear it back to "+" (the node usually rebuilds and drops the trigger anyway). This is the
    // graph's ONE searchable dropdown (combo_popover.js) — the native <select> it replaced couldn't
    // host a search field.
    const trigger = h("input", { class: addinCls, type: "text", readOnly: true, placeholder: "+",
        title: addLabel.replace(/^\+\s*/, "add "), spellcheck: false });
    trigger.addEventListener("mousedown", (e) => {
        e.preventDefault();   // don't focus the readonly trigger — the popover's search field takes focus
        comboPopover({ anchor: trigger, options: freeOpts, placeholder: addLabel.replace(/^\+\s*/, "search "),
            onPick: (val) => { trigger.value = val; trigger.dispatchEvent(new Event("change", { bubbles: true })); trigger.value = ""; } });
    });
    return h("div", { class: "sv-inputs" }, pills,
        h("span", { class: "sv-input sv-add" }, trigger));
}
