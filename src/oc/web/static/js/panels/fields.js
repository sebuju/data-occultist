// Fields panel (window-specific schema). Each field: text / number / pips, a
// declarative extract strategy (no regex), and dictionary learning + fuzzy.
import { fieldset, mount, h, frag, TRASH } from "../dom.js";

const TYPES = [["text", "text"], ["number", "number"], ["pips", "pips (dots)"]];
const EXTRACTS = [
    ["whole", "whole text"], ["number", "first number"],
    ["number_before", "number before sep"], ["number_after", "number after sep"],
    ["text_before", "text before sep"], ["text_after", "text after sep"],
];
const NEEDS_SEP = new Set(["number_before", "number_after", "text_before", "text_after"]);

export function renderFields(container, model, ctx) {
    const rows = model.fields.map((f, i) => {
        const sepHidden = !(NEEDS_SEP.has(f.extract) && f.type !== "pips");
        const exHidden = f.type === "pips";
        return h("tr", { dataset: { i } },
            h("td", h("input", { class: "f-id", value: f.id })),
            h("td", h("select", { class: "f-type" },
                TYPES.map(([v, t]) => h("option", { value: v, selected: f.type === v }, t)))),
            h("td",
                h("select", { class: "f-ex", hidden: exHidden },
                    EXTRACTS.map(([v, t]) => h("option", { value: v, selected: (f.extract || "whole") === v }, t))),
                h("input", { class: "f-sep", value: f.separator || "/", style: "width:4ch", hidden: sepHidden }),
                f.type === "pips" ? h("span", { class: "muted" }, "counts dots") : null),
            h("td", h("input", { type: "checkbox", class: "f-learn", checked: f.learn, title: "learn the dictionary from confident reads" })),
            h("td", h("input", { type: "number", class: "f-fz", step: "0.05", min: "0", max: "1", value: f.fuzzy ?? 0.82,
                title: "similarity (0-1) to snap a noisy read to a known word; higher = stricter" })),
            h("td", h("button", { class: "f-del danger", title: "remove" }, TRASH())),
        );
    });

    const body = frag(
        h("table", { class: "grid-table" },
            h("thead", h("tr",
                h("th", "id"), h("th", "type"), h("th", "extract"),
                h("th", "learn"), h("th", "fuzzy"), h("th"))),
            h("tbody", rows)),
        h("div", { class: "row" },
            h("input", { id: "f-new", placeholder: "new field id" }),
            h("button", { id: "f-add" }, "Add field")),
    );
    const fs = fieldset("Fields (this window)", body, "fields");

    fs.querySelectorAll("tbody tr").forEach((tr) => {
        const f = model.fields[+tr.dataset.i];
        tr.querySelector(".f-id").addEventListener("input", (e) => { f.id = e.target.value.trim(); });
        tr.querySelector(".f-type").addEventListener("change", (e) => { f.type = e.target.value; ctx.refresh(); });
        tr.querySelector(".f-ex").addEventListener("change", (e) => {
            f.extract = e.target.value; tr.querySelector(".f-sep").hidden = !NEEDS_SEP.has(f.extract);
        });
        tr.querySelector(".f-sep").addEventListener("input", (e) => { f.separator = e.target.value || "/"; });
        tr.querySelector(".f-learn").addEventListener("change", (e) => { f.learn = e.target.checked; });
        tr.querySelector(".f-fz").addEventListener("input", (e) => { f.fuzzy = +e.target.value; });
        tr.querySelector(".f-del").addEventListener("click", () => { model.removeField(f.id); ctx.refresh(); });
    });
    fs.querySelector("#f-add").addEventListener("click", () => {
        const id = fs.querySelector("#f-new").value.trim();
        if (id) { model.ensureField(id); ctx.refresh(); }
    });
    mount(container, fs);
}
