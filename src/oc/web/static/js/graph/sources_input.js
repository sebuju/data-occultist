// The ONE "sources input" widget (rule 7). A wrapping row of removable dataset/subset chips plus
// a "+ add" <select>. Subset joins, producer fetch-sources, and dictionary feeds all build their
// source list through this instead of hand-rolling the identical chip + add-select markup. Sits
// alongside list_block.js as a node-body primitive.
//
// It renders STRUCTURE only: callers pass the wiring-hook CLASSES (rmCls / addinCls), so the
// existing delegated handlers (keyed off those classes + the chip's data-ds) keep working
// unchanged. Any per-source config (a subset's join knobs, a dictionary's column pickers) is the
// caller's own concern — build it and append it after this row.
//
// sourcesInput({ ids, free, addLabel?, rmCls?, addinCls?, rmTitle? }) -> a `.sv-inputs` Node
//   ids      : source ids already wired (string[]) -> one removable chip each
//   free     : ids addable via the select (string[])
//   addLabel : the select's placeholder option text (default "+ source")
//   rmCls    : class on each chip's trash button (default "sv-rmin")
//   addinCls : class on the add <select>            (default "sv-addin")
//   rmTitle  : each chip trash's tooltip            (default "remove input")
import { h, trashBtn } from "../dom.js";

export function sourcesInput({ ids, free, addLabel = "+ source", rmCls = "sv-rmin", addinCls = "sv-addin", rmTitle = "remove input" }) {
    const chips = (ids || []).map((d) => h("span", { class: "sv-input" }, d,
        trashBtn({ cls: rmCls, dataset: { ds: d }, title: rmTitle })));
    const addOpts = [h("option", { value: "" }, addLabel), (free || []).map((d) => h("option", { value: d }, d))];
    return h("div", { class: "sv-inputs" }, chips,
        h("span", { class: "sv-input sv-add" }, h("select", { class: addinCls }, addOpts)));
}
