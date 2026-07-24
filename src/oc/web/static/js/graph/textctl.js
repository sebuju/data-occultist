// Reusable text-element style controls for the toast image editor (built with the ONE dom.js
// hyperscript, rule 7). Pure builders: they return DOM carrying stable classes + data-attrs; the
// wiring (reading the model, writing back) lives in main.js's wireToastImage, matching the render/
// wire split every other graph node uses. Mirrors the intent of pretty's style_editor.js, but the
// substrate differs (PIL element fields vs a CSS Style dict, h() vs el()), so it is not a copy.

import { h } from "../dom.js";

// Nine-point codes: vertical t/m/b (top/middle/bottom) + horizontal l/c/r (left/centre/right).
export const NINE_CODES = ["tl", "tc", "tr", "ml", "mc", "mr", "bl", "bc", "br"];

// Font families the editor offers; value = the key the PIL renderer maps to a face file
// (see toast_image._FONT_FILES). "" = the platform default (Segoe UI, matching the toast's text).
export const FONT_CHOICES = [
    ["", "default"], ["arial", "Arial"], ["calibri", "Calibri"], ["consolas", "Consolas"],
    ["georgia", "Georgia"], ["tahoma", "Tahoma"], ["times", "Times"], ["verdana", "Verdana"],
    ["impact", "Impact"],
];

export const BORDER_STYLES = [["solid", "solid"], ["dashed", "dashed"], ["dotted", "dotted"]];

// A 3x3 anchor picker. `cur` is the active 9-point code; each cell carries data-code so the wiring
// reads the clicked point. `cls` distinguishes multiple grids in one inspector (align / corner /
// target). `title` labels the whole grid for hover.
export function nineGrid(cur, cls, title = "") {
    return h("div", { class: "tn-nine " + cls, title },
        NINE_CODES.map((code) => h("button", {
            class: "tn-nine-b" + (code === (cur || "tl") ? " on" : ""),
            dataset: { code }, type: "button", title: code,
        })));
}

// Font family rich-dd-btn (data-driven from FONT_CHOICES) — the row label itself renders in the
// picked typeface (row: font-family set per option in the popover, wired in toast_wire.js) so a
// face's look is visible while browsing, not only after picking.
export function fontSelect(cur, cls) {
    const label = (FONT_CHOICES.find(([v]) => v === (cur || "")) || [, cur])[1];
    return h("button", { class: `${cls} rich-dd-btn`, type: "button", title: "font family" }, `<${label}>`);
}

// Bold / italic / underline toggle group. Each button carries data-k (the element field it flips)
// and an `on` class reflecting the current value.
export function biuGroup(t, cls) {
    const b = (k, lab) => h("button", { class: "tn-biu-b" + (t[k] ? " on" : ""), dataset: { k },
        type: "button", title: k }, lab);
    return h("div", { class: "tn-biu " + cls }, b("bold", "B"), b("italic", "I"), b("underline", "U"));
}

// A colour control = a native picker (class `cls`) + a linked hex text input (class `cls`+"-hex").
// The wiring in main.js keeps the two in sync (edit either, the other follows). Value is a #hex.
export function colorPair(cls, value, title = "") {
    return h("span", { class: "tn-cpair" },
        h("input", { class: cls, type: "color", value: value || "#000000", title }),
        h("input", { class: cls + "-hex", type: "text", value: value || "", placeholder: "#rrggbb", title }));
}

// Per-side border editor: a side picker (all | T R B L) + width / colour / style controls that
// retarget to the active side (data-side="" = the base/all border, else t/r/b/l). The controls show
// the BASE border's values initially; the wiring repoints them when a side is picked (mirrors
// pretty's borderRow). Values come from `t.border` (base) + `t.border_sides` (overrides).
export function borderEditor(t) {
    const base = t.border || { w: 0, color: "#ffffff", style: "solid" };
    const sides = [["all", ""], ["T", "t"], ["R", "r"], ["B", "b"], ["L", "l"]];
    const isSet = (sv) => (sv ? ((t.border_sides || {})[sv]?.w > 0) : (base.w > 0));
    return h("div", { class: "tn-bd" },
        h("div", { class: "tn-bd-sides" },
            sides.map(([lab, sv]) => h("button", {
                class: "tn-bd-side" + (sv === "" ? " on" : "") + (isSet(sv) ? " set" : ""),
                dataset: { side: sv }, type: "button", title: sv ? `${sv} side` : "all sides",
            }, lab))),
        h("input", { class: "tn-bd-w", type: "number", min: "0", value: base.w || 0, title: "border width (px) — 0 = none" }),
        h("span", { class: "tn-il-u" }, "px"),
        colorPair("tn-bd-c", base.color || "#ffffff", "border colour"),
        h("button", { class: "tn-bd-s rich-dd-btn", type: "button", title: "border style" }, `<${base.style || "solid"}>`));
}

// Anchor row: "anchor to" (image or a sibling element index) + this-point + target-point grids. The
// sibling options exclude the element itself (index `j`). `n` is the element count.
export function anchorRow(t, j, n) {
    const a = t.anchor || { to: "", corner: "tl", target: "tl" };
    // one row: target select + this-point + target-point grids (the row's "anchor" label is
    // supplied by the inspector's lrow wrapper, so it is not repeated here).
    // grids stay ENABLED for the image too — anchoring to the image pins THIS element's `corner`
    // 9-point onto the image canvas's `target` 9-point (server: target box = whole image).
    const toLabel = !a.to ? "image" : `element ${+a.to + 1}`;
    return h("div", { class: "tn-anch" },
        h("button", { class: "tn-anch-to rich-dd-btn", type: "button",
            title: "anchor this element to the image, or to another element" }, `<${toLabel}>`),
        h("label", { class: "tn-anch-gl" }, "this", nineGrid(a.corner, "tn-anch-corner", "which point of THIS element")),
        h("label", { class: "tn-anch-gl" }, "to", nineGrid(a.target, "tn-anch-target", "which point of the target")));
}
