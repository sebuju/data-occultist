// Text appearance panel: teach how the region's text looks so OCR can clean it.
// `color` masks the taught text colour(s) (pick with the eyedropper) to crisp
// black-on-white; threshold/invert/scale cover the rest. Hit Preview to see the effect.
import { fieldset, mount, h, frag, TRASH } from "../dom.js";

const MODES = [
    ["none", "none"],
    ["color", "keep text colour(s)"],
    ["threshold", "auto threshold"],
    ["invert", "invert"],
];

export function renderAppearance(container, model, ctx) {
    const pp = model.preprocess;
    const chips = pp.colors.length
        ? pp.colors.map((c, i) => h("span", { class: "chip", style: `border-color:${c}` },
            h("span", { class: "sw", style: `background:${c}` }), c,
            h("button", { class: "chip-x", dataset: { i }, title: "remove" }, TRASH())))
        : h("span", { class: "muted" }, "no colours yet");

    const body = frag(
        h("label", "preprocess ", h("select", { id: "pp-mode" },
            MODES.map(([v, t]) => h("option", { value: v, selected: pp.mode === v }, t)))),
        h("div", { id: "pp-color", hidden: pp.mode !== "color" },
            h("div", { class: "chips" }, chips),
            h("div", { class: "row" },
                h("button", { id: "pp-pick" }, "⊙ pick from image"),
                h("input", { id: "pp-hex", placeholder: "#ffffff", style: "width:9ch" }),
                h("button", { id: "pp-add" }, "add")),
            h("label", "tolerance ",
                h("input", { type: "range", id: "pp-tol", min: "10", max: "200", value: pp.tolerance }),
                h("span", { class: "muted" }, pp.tolerance))),
        h("label", "upscale ",
            h("input", { type: "number", id: "pp-scale", step: "0.5", min: "1", max: "4", value: pp.scale }),
            h("span", { class: "muted" }, "(helps small fonts)")),
        h("p", { class: "hint" }, "Pick the text colour, choose “keep text colour(s)”, then Preview."),
    );
    const fs = fieldset("Text appearance", body, "Text appearance");

    const q = (s) => fs.querySelector(s);
    q("#pp-mode").addEventListener("change", (e) => { pp.mode = e.target.value; ctx.refresh(); });
    q("#pp-scale").addEventListener("input", (e) => { pp.scale = +e.target.value || 1; });
    q("#pp-tol")?.addEventListener("input", (e) => { pp.tolerance = +e.target.value; ctx.refresh(); });
    q("#pp-pick")?.addEventListener("click", () => ctx.pickColor());
    q("#pp-add")?.addEventListener("click", () => {
        const v = q("#pp-hex").value.trim();
        if (/^#?[0-9a-fA-F]{6}$/.test(v)) { pp.colors.push(v.startsWith("#") ? v : `#${v}`); ctx.refresh(); }
    });
    fs.querySelectorAll(".chip-x").forEach((b) =>
        b.addEventListener("click", () => { pp.colors.splice(+b.dataset.i, 1); ctx.refresh(); }));
    mount(container, fs);
}
