// Selected-box panel: label the active box. Fields shown depend on the role.
import { fieldset, mount, esc } from "../dom.js";

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

  const roleOpts = ROLES.map(([v, t]) => `<option value="${v}" ${b.role === v ? "selected" : ""}>${t}</option>`).join("");
  const fieldOpts = model.fields.map((f) => `<option value="${esc(f.id)}" ${b.field === f.id ? "selected" : ""}>${esc(f.id)}</option>`).join("");
  const stateOpts = model.states.map((s) => `<option value="${esc(s.id)}" ${b.stateId === s.id ? "selected" : ""}>${esc(s.id)}</option>`).join("");

  const fs = fieldset("Selected box", `
    <label>role <select id="b-role">${roleOpts}</select></label>
    <label>id <input id="b-id" value="${esc(b.id)}" /></label>
    <label class="r-region">field
      <select id="b-field"><option value="">— pick / type —</option>${fieldOpts}</select>
      <input id="b-field-new" placeholder="or new field id" value="${esc(b.field)}" />
    </label>
    <label class="r-detect r-state">match text <input id="b-text" value="${esc(b.text)}" placeholder="EQUIPMENT" /></label>
    <label class="r-detect r-state">threshold <input type="number" id="b-thr" step="0.01" min="0" max="1" value="${b.threshold ?? 0.8}" /></label>
    <label class="r-state">state
      <select id="b-state"><option value="">— pick —</option>${stateOpts}</select>
    </label>
    <div class="row"><button id="b-del" class="danger">Delete box</button></div>
  `);
  fs.dataset.role = b.role;

  const q = (s) => fs.querySelector(s);
  q("#b-role").addEventListener("change", (e) => { b.role = e.target.value; fs.dataset.role = b.role; ctx.refresh(); });
  q("#b-id").addEventListener("input", (e) => { b.id = e.target.value.trim(); ctx.refreshList(); });
  q("#b-field").addEventListener("change", (e) => {
    if (e.target.value) { b.field = e.target.value; q("#b-field-new").value = e.target.value; ctx.refreshOverlay(); }
  });
  q("#b-field-new").addEventListener("input", (e) => { b.field = e.target.value.trim(); model.ensureField(b.field); });
  q("#b-text").addEventListener("input", (e) => { b.text = e.target.value; });
  q("#b-thr").addEventListener("input", (e) => { b.threshold = +e.target.value; });
  q("#b-state").addEventListener("change", (e) => { b.stateId = e.target.value; });
  q("#b-del").addEventListener("click", () => { model.remove(b.id); ctx.refresh(); });
  mount(container, fs);
}
