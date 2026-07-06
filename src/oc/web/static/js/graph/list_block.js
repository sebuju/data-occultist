// The ONE add/delete (optionally reorderable) in-node list primitive (rule 7). Every editable
// list inside a node — subset filters/derived/sort, producer/source field lists, toast blocks,
// the record key — builds its rows through this instead of hand-rolling `items.map(row + trash)`
// + a "+ add" control. It renders STRUCTURE only: the caller supplies the per-row cells and the
// wiring-hook CLASSES, so the existing delegated handlers (which key off those classes + the
// row's `data-<idKey>`) keep working unchanged. Reordering reuses `moveButtons` (the shared ▲/▼).
//
// listBlock({ items, render, rowClass, idKey?, idOf?, del?, reorder?, add? }) -> a DocumentFragment
//   items    : the array to render (falsy -> just the add control, if any)
//   render   : (item, i) => Node | Node[]   the row's content cells (WITHOUT the trash/move buttons)
//   rowClass : class on each row div (e.g. "sub-row", "key-row")
//   idKey    : dataset key carrying the row id, on BOTH the row and its trash/move buttons (default "i")
//   idOf     : (item, i) => id   value for idKey (default the index i)
//   del      : { cls, title? }   -> append a trashBtn (hollow-danger) to each row, wired via `cls`
//   reorder  : { cls, upTitle?, downTitle? } -> prepend ▲/▼ (disabled at ends), wired via `cls`
//   add      : { cls, label?, opts? } -> a trailing add control:
//              opts (array of <option> nodes) -> an add-<select>; else a "+ label" button
import { h, frag, trashBtn } from "../dom.js";
import { moveButtons } from "./node_parts.js";

export function listBlock({ items, render, rowClass, idKey = "i", idOf = (_it, i) => i, del, reorder, add }) {
    const list = items || [];
    const rows = list.map((it, i) => {
        const id = idOf(it, i);
        return h("div", { class: rowClass, dataset: { [idKey]: id } },
            reorder && moveButtons(i, list.length, reorder.cls, { [idKey]: id },
                { upTitle: reorder.upTitle, downTitle: reorder.downTitle }),
            render(it, i),
            del && trashBtn({ cls: del.cls, dataset: { [idKey]: id }, title: del.title || "remove" }));
    });
    const adder = add
        ? (add.opts
            ? h("select", { class: add.cls }, add.opts)
            : h("button", { class: `${add.cls} listblock-add` }, add.label || "+"))
        : null;
    return frag(...rows, adder);
}
