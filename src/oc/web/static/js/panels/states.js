// States panel: distinguishable modes of the window (e.g. sort orders). Each
// carries valid_for_save — records are only collected while in a save-worthy
// state, which is how "don't catalogue at the wrong order" is taught.
import { fieldset, mount, esc, TRASH } from "../dom.js";

const KINDS = ["ordering", "filter", "scroll", "generic"];

export function renderStates(container, model, ctx) {
    const rows = model.states.map((s, i) => {
        const kinds = KINDS.map((k) => `<option ${k === s.kind ? "selected" : ""}>${k}</option>`).join("");
        const nDetect = model.boxes.filter((b) => b.role === "state_detect" && b.stateId === s.id).length;
        return `
      <tr data-i="${i}">
        <td><input class="s-id" value="${esc(s.id)}" /></td>
        <td><select class="s-kind">${kinds}</select></td>
        <td><input type="checkbox" class="s-valid" ${s.valid_for_save ? "checked" : ""} title="save-worthy" /></td>
        <td class="muted">${nDetect} detector(s)</td>
        <td><button class="s-del danger" title="remove">${TRASH}</button></td>
      </tr>`;
    }).join("");

    const fs = fieldset("States", `
    <p class="hint">Draw <b>state detect</b> boxes and assign them to a state below. Records save only in save-worthy states.</p>
    <table class="grid-table">
      <thead><tr><th>id</th><th>kind</th><th>save?</th><th></th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="row"><input id="s-new" placeholder="new state id (e.g. order_by_name)" /><button id="s-add">Add state</button></div>
  `);

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
