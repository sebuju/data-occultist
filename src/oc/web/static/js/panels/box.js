// Selected-box panel: label the active box. Fields shown depend on the role.
import { fieldset, mount, h, frag } from "../dom.js";

const ROLES = [
    ["region", "region (data field)"],
    ["detect", "detect (window detect)"],
    ["state_detect", "state detect"],
    ["scrollbar", "scrollbar"],
    ["search", "search area (for Suggest)"],
];

export function renderBox(container, model, ctx) {
    const b = model.selected;
    if (!b) { container.replaceChildren(); return; }

    const body = frag(
        h("label", "role ", h("select", { id: "b-role" },
            ROLES.map(([v, t]) => h("option", { value: v, selected: b.role === v }, t)))),
        h("label", "id ", h("input", { id: "b-id", value: b.id })),
        h("label", { class: "r-region" }, "field",
            h("select", { id: "b-field" },
                h("option", { value: "" }, "— pick / type —"),
                model.fields.map((f) => h("option", { value: f.id, selected: b.field === f.id }, f.id))),
            h("input", { id: "b-field-new", placeholder: "or new field id", value: b.field })),
        h("label", { class: "r-detect r-state" }, "match text ",
            h("input", { id: "b-text", value: b.text, placeholder: "EQUIPMENT" })),
        h("label", { class: "r-detect r-state" }, "mode",
            h("select", { id: "b-mode" },
                h("option", { value: "partial", selected: (b.match ?? "partial") === "partial" }, "partial (substring, loose)"),
                h("option", { value: "full", selected: b.match === "full" }, "full (whole-string)"),
                h("option", { value: "exact", selected: b.match === "exact" }, "exact (equal)"),
                h("option", { value: "prefix", selected: b.match === "prefix" }, "prefix (starts-with)"))),
        h("label", { class: "r-detect r-state" }, "threshold ",
            h("input", { type: "number", id: "b-thr", step: "0.01", min: "0", max: "1", value: b.threshold ?? 0.8 })),
        h("label", { class: "r-detect r-state" }, "min chars ",
            h("input", { type: "number", id: "b-minchars", step: "1", min: "0", value: b.min_chars ?? 0 })),
        h("label", { class: "r-detect r-state" }, "strip",
            h("select", { id: "b-strip" },
                h("option", { value: "alnum", selected: (b.strip ?? "alnum") === "alnum" }, "alnum (ignore spaces+punct)"),
                h("option", { value: "spaces", selected: b.strip === "spaces" }, "spaces only"),
                h("option", { value: "none", selected: b.strip === "none" }, "none (raw)"))),
        h("label", { class: "r-detect r-state inline" },
            h("input", { type: "checkbox", id: "b-incl", checked: b.included }), " read inside text (included)"),
        h("label", { class: "r-detect r-state inline" },
            h("input", { type: "checkbox", id: "b-case", checked: b.case_sensitive }), " case sensitive"),
        h("label", { class: "r-state" }, "state",
            h("select", { id: "b-state" },
                h("option", { value: "" }, "— pick —"),
                model.states.map((s) => h("option", { value: s.id, selected: b.stateId === s.id }, s.id)))),
        h("div", { class: "row" }, h("button", { id: "b-del", class: "danger" }, "Delete box")),
    );
    const fs = fieldset("Selected box", body, "Selected box");
    fs.dataset.role = b.role;

    const q = (s) => fs.querySelector(s);
    q("#b-role").addEventListener("change", (e) => { b.role = e.target.value; fs.dataset.role = b.role; ctx.refresh(); });
    q("#b-id").addEventListener("input", (e) => { b.id = e.target.value.trim(); ctx.refreshList(); });
    q("#b-field").addEventListener("change", (e) => {
        if (e.target.value) { b.field = e.target.value; q("#b-field-new").value = e.target.value; ctx.refreshOverlay(); }
    });
    q("#b-field-new").addEventListener("input", (e) => { b.field = e.target.value.trim(); model.ensureField(b.field); });
    q("#b-text").addEventListener("input", (e) => { b.text = e.target.value; });
    q("#b-mode").addEventListener("change", (e) => { b.match = e.target.value; ctx.refresh(); });
    q("#b-thr").addEventListener("input", (e) => { b.threshold = +e.target.value; });
    q("#b-minchars").addEventListener("input", (e) => { b.min_chars = Math.max(0, Math.trunc(+e.target.value) || 0); });
    q("#b-strip").addEventListener("change", (e) => { b.strip = e.target.value; });
    q("#b-incl").addEventListener("change", (e) => { b.included = e.target.checked; });
    q("#b-case").addEventListener("change", (e) => { b.case_sensitive = e.target.checked; });
    q("#b-state").addEventListener("change", (e) => { b.stateId = e.target.value; });
    q("#b-del").addEventListener("click", () => { model.remove(b.id); ctx.refresh(); });
    mount(container, fs);
}
