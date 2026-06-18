// Boxes panel: list every box, click to select.
import { fieldset, mount, esc } from "../dom.js";

export function renderBoxList(container, model, ctx) {
    const items = model.boxes.map((b) => {
        const detail = b.role === "region" ? (b.field || "?")
            : b.role === "state_detect" ? (b.stateId || "?")
            : b.role === "detect" ? (b.text || "?") : "";
        const active = b.id === model.selectedId ? "active" : "";
        return `<li class="${active}" data-id="${esc(b.id)}"><span class="tag">${b.role}</span> ${esc(b.id)} <span class="muted">${esc(detail)}</span></li>`;
    }).join("");

    const fs = fieldset(`Boxes (${model.boxes.length})`, `<ul class="box-list">${items}</ul>`, "boxes");
    fs.querySelectorAll("li").forEach((li) => {
        li.addEventListener("click", () => { model.selectedId = li.dataset.id; ctx.refresh(); });
    });
    mount(container, fs);
}
