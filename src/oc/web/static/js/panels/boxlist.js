// Boxes panel: list every box, click to select.
import { fieldset, mount, h } from "../dom.js";

export function renderBoxList(container, model, ctx) {
    const items = model.boxes.map((b) => {
        const detail = b.role === "region" ? (b.field || "?")
            : b.role === "state_detect" ? (b.stateId || "?")
            : b.role === "detect" ? (b.text || "?") : "";
        const active = b.id === model.selectedId ? "active" : "";
        return h("li", { class: active, dataset: { id: b.id } },
            h("span", { class: "tag" }, b.role), " ", b.id, " ",
            h("span", { class: "muted" }, detail));
    });

    const fs = fieldset(`Boxes (${model.boxes.length})`, h("ul", { class: "box-list" }, items), "boxes");
    fs.querySelectorAll("li").forEach((li) => {
        li.addEventListener("click", () => { model.selectedId = li.dataset.id; ctx.refresh(); });
    });
    mount(container, fs);
}
