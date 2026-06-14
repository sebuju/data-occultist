// Fields panel (window-specific schema). Each field: text / number / pips, a
// declarative extract strategy (no regex), and dictionary learning + fuzzy.
import { fieldset, mount, esc, TRASH } from "../dom.js";

const TYPES = [["text", "text"], ["number", "number"], ["pips", "pips (dots)"]];
const EXTRACTS = [
  ["whole", "whole text"], ["number", "first number"],
  ["number_before", "number before sep"], ["number_after", "number after sep"],
  ["text_before", "text before sep"], ["text_after", "text after sep"],
];
const NEEDS_SEP = new Set(["number_before", "number_after", "text_before", "text_after"]);

export function renderFields(container, model, ctx) {
  const rows = model.fields.map((f, i) => {
    const typeOpts = TYPES.map(([v, t]) => `<option value="${v}" ${f.type === v ? "selected" : ""}>${t}</option>`).join("");
    const exOpts = EXTRACTS.map(([v, t]) => `<option value="${v}" ${(f.extract || "whole") === v ? "selected" : ""}>${t}</option>`).join("");
    const sepHidden = NEEDS_SEP.has(f.extract) && f.type !== "pips" ? "" : "hidden";
    const exHidden = f.type === "pips" ? "hidden" : "";
    return `<tr data-i="${i}">
      <td><input class="f-id" value="${esc(f.id)}" /></td>
      <td><select class="f-type">${typeOpts}</select></td>
      <td>
        <select class="f-ex" ${exHidden}>${exOpts}</select>
        <input class="f-sep" value="${esc(f.separator || "/")}" style="width:4ch" ${sepHidden} />
        ${f.type === "pips" ? '<span class="muted">counts dots</span>' : ""}
      </td>
      <td><input type="checkbox" class="f-learn" ${f.learn ? "checked" : ""} title="learn the dictionary from confident reads" /></td>
      <td><input type="number" class="f-fz" step="0.05" min="0" max="1" value="${f.fuzzy ?? 0.82}"
            title="similarity (0-1) to snap a noisy read to a known word; higher = stricter" /></td>
      <td><button class="f-del danger" title="remove">${TRASH}</button></td></tr>`;
  }).join("");

  const fs = fieldset("Fields (this window)", `
    <table class="grid-table">
      <thead><tr><th>id</th><th>type</th><th>extract</th><th>learn</th><th>fuzzy</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table>
    <div class="row"><input id="f-new" placeholder="new field id" /><button id="f-add">Add field</button></div>
  `, "fields");

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
