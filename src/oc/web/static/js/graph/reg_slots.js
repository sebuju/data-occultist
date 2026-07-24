// Register-key list editors for an action node's per-register ops (CLAUDE.md rule 7 — the two
// shapes below are siblings, kept together so they can't drift). BOTH are hand-typed key lists, not
// pick-lists: register keys are created at RUNTIME by whatever wiring or manual "set" op first
// reports them, so a key an op targets may not be wired (or even exist yet) at edit time — a
// chip-picker sourced from the register's currently-known keys could never express that. Rendering
// AND wiring both live here so callers can't drift; extracted from action_node.js/io_wire.js where
// it used to be action-only.
import { h, frag, labAdd, trashBtn } from "../dom.js";
import { wireArmedRemove } from "./rules_editor.js";
import { slideToggle } from "./node_parts.js";

// Clone/move key-narrowing: N hand-typed key rows (`reg_ops[id].keys`, [] = all — the canonical
// form setActionRegKeys persists). `hint` = the row's help text. Sibling of regWriteRows below
// (same free-text-row shape, one field instead of key+value+remove).
export function keyRows({ regId, keys, hint }) {
    return frag(
        labAdd("keys", hint, "ac-kaddrow", "add a key row", true, { reg: regId }),
        h("div", { class: "ac-krows", dataset: { reg: regId } },
            keys.map((k, idx) => h("div", { class: "ac-krow", dataset: { reg: regId, idx } },
                h("input", { class: "gi ac-kval", type: "text", value: k, placeholder: "key name", spellcheck: false }),
                trashBtn({ cls: "ac-krmrow", title: "remove this row" })))));
}

// Bind add/edit/remove handlers for every clone/move key-list block under `scope`. `add(regId)`
// appends a blank row; `removeRow(regId, idx)`/`setKey(regId, idx, v)` edit one row; `after()` runs
// after each edit (rebuild + autosave — matches wireRegWriteRows below).
export function wireKeyRows(scope, { add, removeRow, setKey, after }) {
    scope.querySelectorAll(".ac-kaddrow").forEach((btn) => btn.addEventListener("click", () => {
        add(btn.dataset.reg); after();
    }));
    scope.querySelectorAll(".ac-krow").forEach((row) => {
        const regId = row.dataset.reg, idx = +row.dataset.idx;
        row.querySelector(".ac-kval")?.addEventListener("change", (e) => { setKey(regId, idx, e.target.value); after(); });
        wireArmedRemove(row, ".ac-krmrow", () => { removeRow(regId, idx); after(); }, { pill: ".ac-krow" });
    });
}

// One register's "set values" editor: N key rows (a register's own action op, not the clone/move
// key-narrowing above) — each row a hand-typed KEY, a VALUE, and a toggle meaning "remove this key
// entirely instead of setting it" (empty value ≠ removing the key — the value input's placeholder
// says so). `rows` = the stored `RegisterWrite` list (`[{key, value, remove}]`). Sibling of keyRows
// above (a different row shape — key+value+remove vs. key only), mirroring process_node.js's
// `.pr-maprow` (row + trash, not a `.sv-input` pill).
// The "+" add lives IN the "set values" label (labAdd), like every other section's add button
// (headers/query maps, explode list) — not a trailing button inside the rows block.
export function regWriteRows({ regId, rows }) {
    return frag(
        labAdd("set values", "keys this action writes when fired — one row per key",
            "ac-waddrow", "add a key row", true, { reg: regId }),
        h("div", { class: "ac-wrows", dataset: { reg: regId } },
            rows.map((w, idx) => h("div", { class: "ac-wrow", dataset: { reg: regId, idx } },
                h("input", { class: "gi ac-wkey", type: "text", value: w.key, placeholder: "key name", spellcheck: false }),
                h("input", { class: "gi ac-wval", type: "text", value: w.value, placeholder: "empty = clears value",
                    disabled: !!w.remove, spellcheck: false }),
                slideToggle({ on: !!w.remove, cls: "ac-wrm", title: "remove this key entirely (instead of setting its value)" }),
                trashBtn({ cls: "ac-wrmrow", title: "remove this row" })))));
}

// Bind add/edit/remove handlers for every "set values" block under `scope`. `add(regId)` appends a
// blank row; `removeRow(regId, idx)`/`setKey`/`setValue`/`setRemove(regId, idx, v)` edit one row;
// `after()` runs after each edit (rebuild + autosave) — a key/remove edit changes what the register
// node scaffolds (registerDeclaredKeys) and what the value input's disabled state shows, so those
// need the rebuild; a bare value keystroke does not (autosave only, like any other free-text field).
export function wireRegWriteRows(scope, { add, removeRow, setKey, setValue, setRemove, after, autosaveOnly }) {
    scope.querySelectorAll(".ac-waddrow").forEach((btn) => btn.addEventListener("click", () => {
        add(btn.dataset.reg); after();
    }));
    scope.querySelectorAll(".ac-wrow").forEach((row) => {
        const regId = row.dataset.reg, idx = +row.dataset.idx;
        row.querySelector(".ac-wkey")?.addEventListener("change", (e) => { setKey(regId, idx, e.target.value); after(); });
        row.querySelector(".ac-wval")?.addEventListener("change", (e) => { setValue(regId, idx, e.target.value); autosaveOnly(); });
        row.querySelector(".ac-wrm")?.addEventListener("change", (e) => { setRemove(regId, idx, e.target.checked); after(); });
        wireArmedRemove(row, ".ac-wrmrow", () => { removeRow(regId, idx); after(); }, { pill: ".ac-wrow" });
    });
}
