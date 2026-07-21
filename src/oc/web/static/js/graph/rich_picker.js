// A dropdown whose options are RICH: each row is a label plus a second line of meta text, so the
// meaning of an option is visible while browsing rather than only after picking. A native <select>
// can't do this (an <option title> doesn't render cross-browser, and an <option> holds one line of
// text), which is why this exists.
//
// Two callers today — the register's aggregate fold (~23 modes across 5 groups, meta = what the
// mode does) and the live panel's feed-session dropdown (meta = image count + recording length).
// Both open under a `.gi` trigger button, so the shell is shared here instead of copied.
//
// Builds on the shared body-level popover SHELL (combo_popover.js: body-append + on-screen clamp +
// outside-press/Escape dismiss). comboPopover itself is the searchable-ADD sibling (fuzzy search +
// node-distance order); this is a fixed, no-search browse list, so it doesn't wrap comboPopover —
// just its shell.
import { h } from "../dom.js";
import { anchoredPopover } from "./combo_popover.js";

// richPickerPop({ anchor, groups, current, onPick })
//   anchor  : the trigger element (a `.gi` button) the popover opens under.
//   groups  : [[groupTitle | null, [{ value, label, meta }]]] — a null/blank title omits the
//             header, so a flat list is just one untitled group.
//   current : the currently-selected value — its row is marked with .sel and pre-highlighted.
//   onPick  : (value) => void — called with the picked value, then the popover closes.
export function richPickerPop({ anchor, groups, current, onPick }) {
    const list = h("div", { class: "sv-combo-list" });
    const pop = h("div", { class: "sv-combo-pop rich-pick-pop", tabIndex: -1 }, list);

    const rows = [], vals = [];   // flat option rows across groups (headers excluded from nav)
    let hl = -1;
    const setHl = (i) => {
        if (rows[hl]) rows[hl].classList.remove("hl");
        hl = Math.max(0, Math.min(i, rows.length - 1));
        const r = rows[hl];
        if (r) { r.classList.add("hl"); r.scrollIntoView({ block: "nearest" }); }
    };
    const pick = (v) => { close(); onPick(v); };

    const children = [];
    for (const [grp, opts] of groups) {
        if (grp) children.push(h("div", { class: "sv-combo-group" }, grp));
        for (const o of opts) {
            const row = h("div", { class: "sv-combo-opt rich-pick-opt" + (o.value === current ? " sel" : ""), onClick: () => pick(o.value) },
                h("span", { class: "rich-pick-lbl" }, o.label),
                h("span", { class: "sv-combo-meta" }, o.meta || ""));
            rows.push(row); vals.push(o.value);
            children.push(row);
        }
    }
    if (!rows.length) children.push(h("div", { class: "sv-combo-empty" }, "nothing to pick"));
    list.replaceChildren(...children);

    pop.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown") { e.preventDefault(); setHl(hl + 1); }
        else if (e.key === "ArrowUp") { e.preventDefault(); setHl(hl - 1); }
        else if (e.key === "Enter") { e.preventDefault(); if (vals[hl] != null) pick(vals[hl]); }
    });

    const close = anchoredPopover({ anchor, panel: pop });
    // land the highlight on the current value (fall back to the first row) so Enter with no arrow
    // press re-picks the same option rather than jumping to the top of the list.
    setHl(Math.max(0, vals.indexOf(current)));
    pop.focus();
}
