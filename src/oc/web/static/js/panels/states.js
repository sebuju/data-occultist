// States panel: distinguishable modes of the window (e.g. sort orders). Each
// carries valid_for_save — records are only collected while in a save-worthy
// state, which is how "don't catalogue at the wrong order" is taught.
import { fieldset, mount, h, frag, TRASH } from "../dom.js";

const KINDS = ["ordering", "filter", "scroll", "generic"];

export function renderStates(container, model, ctx) {
    const rows = model.states.map((s, i) => {
        const nDetect = model.boxes.filter((b) => b.role === "state_detect" && b.stateId === s.id).length;
        return h("tr", { dataset: { i } },
            h("td", h("input", { class: "s-id", value: s.id })),
            h("td", h("select", { class: "s-kind" },
                KINDS.map((k) => h("option", { selected: k === s.kind }, k)))),
            h("td", h("input", { type: "checkbox", class: "s-valid", checked: s.valid_for_save, title: "save-worthy" })),
            h("td", { class: "muted" }, `${nDetect} detector(s)`),
            h("td", h("button", { class: "s-del danger", title: "remove" }, TRASH())),
        );
    });

    const body = frag(
        h("p", { class: "hint" },
            "Draw ", h("b", "state detect"), " boxes and assign them to a state below. Records save only in save-worthy states."),
        h("table", { class: "grid-table" },
            h("thead", h("tr", h("th", "id"), h("th", "kind"), h("th", "save?"), h("th"), h("th"))),
            h("tbody", rows)),
        h("div", { class: "row" },
            h("input", { id: "s-new", placeholder: "new state id (e.g. order_by_name)" }),
            h("button", { id: "s-add" }, "Add state")),
    );
    const fs = fieldset("States", body, "States");

    fs.querySelectorAll("tbody tr").forEach((tr) => {
        const s = model.states[+tr.dataset.i];
        const oldId = s.id;
        tr.querySelector(".s-id").addEventListener("change", (e) => {
            const nid = e.target.value.trim();
            // keep any detectors pointing at the renamed state
            model.boxes.forEach((b) => { if (b.role === "state_detect" && b.stateId === oldId) b.stateId = nid; });
            s.id = nid; ctx.refresh();
        });
        tr.querySelector(".s-kind").addEventListener("change", (e) => { s.kind = e.target.value; });
        tr.querySelector(".s-valid").addEventListener("change", (e) => { s.valid_for_save = e.target.checked; });
        tr.querySelector(".s-del").addEventListener("click", () => { model.removeState(s.id); ctx.refresh(); });
    });
    fs.querySelector("#s-add").addEventListener("click", () => {
        const id = fs.querySelector("#s-new").value.trim();
        if (id) { model.addState(id); ctx.refresh(); }
    });
    mount(container, fs);
}
