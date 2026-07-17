// Shared "which register keys" sub-row (CLAUDE.md rule 7). One row per targeted/watched register: a
// chip list of that register's wired-readout KEYS the owner acts on (default = all keys). Removing a
// chip narrows the set; the trailing "+" re-adds a key. Backs BOTH the action node (which keys an op
// clears/moves) and the trigger node (which keys an on_register watch fires on) — same store shape (a
// `{regId: [keys]}` slots map, [] = all). Rendering AND wiring both live here so the two callers can't
// drift; extracted from action_node.js/io_wire.js where it used to be action-only.
import { h, srcRow } from "../dom.js";
import { sourcesInput } from "./sources_input.js";
import { wireArmedRemove } from "./rules_editor.js";

// active keys = the stored slot narrowed to still-wired keys, or ALL keys when the slot is empty
// ([] = all, the canonical form setActionSlots/setTriggerRegisterSlots persist).
function activeKeys(keys, targeted) {
    return (targeted && targeted.length) ? targeted.filter((k) => keys.includes(k)) : keys;
}

// One register's key sub-row. `keys` = all of the register's wired-readout keys; `targeted` = the
// stored slot ([] = all); `hint` = the row's help text; `label` = the row's left-cell caption (each
// caller supplies its own so the wording fits its node). The row carries `data-reg` so wireSlotRows
// knows which register a slot edit targets.
export function slotRow({ regId, keys, targeted, hint, label }) {
    const active = activeKeys(keys, targeted);
    const activeSet = new Set(active);
    const free = keys.filter((k) => !activeSet.has(k));
    return srcRow(label ?? "keys", hint,
        h("div", { class: "sv-slotrow", dataset: { reg: regId } },
            sourcesInput({
                chips: active.map((k) => ({ value: k, label: k })),
                free, addLabel: "+ key", addinCls: "sv-addin sv-slotadd", rmCls: "sv-rmin sv-slotrm",
                rmTitle: "narrow to fewer keys" })));
}

// Bind add/remove handlers for every register key sub-row under `scope`. `keysFor(regId)` = all
// wired-readout keys; `get(regId)` = the stored slot; `set(regId, keys)` persists it ([] = all);
// `after()` runs after each edit (rebuild + autosave). Shared by wireAction + wireTrigger.
export function wireSlotRows(scope, { keysFor, get, set, after }) {
    scope.querySelectorAll(".sv-slotrow").forEach((row) => {
        const regId = row.dataset.reg;
        const effective = () => activeKeys(keysFor(regId), get(regId));
        row.querySelector(".sv-slotadd")?.addEventListener("change", (e) => {
            if (!e.target.value) return;
            set(regId, [...effective(), e.target.value]);
            after();
        });
        wireArmedRemove(row, ".sv-slotrm", (val) => {
            set(regId, effective().filter((k) => k !== val));
            after();
        });
    });
}
