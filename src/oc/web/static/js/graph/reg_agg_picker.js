// Popover picker for the register's aggregate fold. A native <select>'s <option title> doesn't
// render cross-browser, and this roster is ~23 modes across 5 groups — a picker needs each mode's
// meaning visible WHILE browsing, not just after picking. Builds on the shared anchoredPopover
// shell (combo_popover.js: body-append + on-screen clamp + outside-press/Escape dismiss) rather
// than re-deriving that boilerplate (rule 7). comboPopover itself is the searchable-ADD sibling
// (fuzzy search + node-distance order); this picker is a fixed, grouped, no-search browse list, so
// it doesn't wrap comboPopover — just its shell.
import { h } from "../dom.js";
import { anchoredPopover } from "./combo_popover.js";
import { REG_AGGREGATES, AGG_DESC } from "./register_node.js";

// aggPickerPop({ anchor, current, onPick })
//   anchor  : the trigger element (.reg-agg-btn) the popover opens under.
//   current : the currently-selected mode value ("" = latest) — marked with .sel.
//   onPick  : (value) => void — called with the picked mode, then the popover closes.
export function aggPickerPop({ anchor, current, onPick }) {
    const list = h("div", { class: "sv-combo-list" });
    const pop = h("div", { class: "sv-combo-pop agg-pick-pop", tabIndex: -1 }, list);

    let rows = [], vals = [], hl = -1;   // flat option rows across groups (headers excluded from nav)
    const setHl = (i) => {
        if (rows[hl]) rows[hl].classList.remove("hl");
        hl = Math.max(0, Math.min(i, rows.length - 1));
        const r = rows[hl];
        if (r) { r.classList.add("hl"); r.scrollIntoView({ block: "nearest" }); }
    };
    const pick = (v) => { close(); onPick(v); };

    const children = [];
    for (const [grp, opts] of REG_AGGREGATES) {
        children.push(h("div", { class: "sv-combo-group" }, grp));
        for (const [v, lbl] of opts) {
            const row = h("div", { class: "sv-combo-opt agg-pick-opt" + (v === current ? " sel" : ""), onClick: () => pick(v) },
                h("span", { class: "agg-pick-lbl" }, lbl),
                h("span", { class: "sv-combo-meta" }, AGG_DESC[v] || ""));
            rows.push(row); vals.push(v);
            children.push(row);
        }
    }
    list.replaceChildren(...children);

    pop.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown") { e.preventDefault(); setHl(hl + 1); }
        else if (e.key === "ArrowUp") { e.preventDefault(); setHl(hl - 1); }
        else if (e.key === "Enter") { e.preventDefault(); if (vals[hl] != null) pick(vals[hl]); }
    });

    const close = anchoredPopover({ anchor, panel: pop });
    // land the highlight on the current mode (fall back to the first row) so Enter with no arrow
    // press re-picks the same mode rather than jumping to <latest>.
    setHl(Math.max(0, vals.indexOf(current)));
    pop.focus();
}
