// Text appearance panel: teach how the region's text looks so OCR can clean it.
// `color` masks the taught text colour(s) (pick with the eyedropper) to crisp
// black-on-white; threshold/invert/scale cover the rest. Hit Preview to see the effect.
import { fieldset, mount, esc, TRASH } from "../dom.js";

const MODES = [
  ["none", "none"],
  ["color", "keep text colour(s)"],
  ["threshold", "auto threshold"],
  ["invert", "invert"],
];

export function renderAppearance(container, model, ctx) {
  const pp = model.preprocess;
  const modeOpts = MODES.map(([v, t]) => `<option value="${v}" ${pp.mode === v ? "selected" : ""}>${t}</option>`).join("");
  const chips = pp.colors.map((c, i) => `
    <span class="chip" style="border-color:${esc(c)}">
      <span class="sw" style="background:${esc(c)}"></span>${esc(c)}
      <button class="chip-x" data-i="${i}" title="remove">${TRASH}</button>
    </span>`).join("") || `<span class="muted">no colours yet</span>`;

  const showColor = pp.mode === "color" ? "" : "hidden";
  const fs = fieldset("Text appearance", `
    <label>preprocess <select id="pp-mode">${modeOpts}</select></label>
    <div id="pp-color" ${showColor}>
      <div class="chips">${chips}</div>
      <div class="row">
        <button id="pp-pick">⊙ pick from image</button>
        <input id="pp-hex" placeholder="#ffffff" style="width:9ch" />
        <button id="pp-add">add</button>
      </div>
      <label>tolerance <input type="range" id="pp-tol" min="10" max="200" value="${pp.tolerance}" />
        <span class="muted">${pp.tolerance}</span></label>
    </div>
    <label>upscale <input type="number" id="pp-scale" step="0.5" min="1" max="4" value="${pp.scale}" />
      <span class="muted">(helps small fonts)</span></label>
    <p class="hint">Pick the text colour, choose “keep text colour(s)”, then Preview.</p>
  `);

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
