// Trigger node: fires its target price node(s) on a condition. `interval` fires every N
// seconds; `on_change` fires when a watched dataset gains rows (pricing just those, live);
// `manual` never auto-fires (the sweep button drives it). All config persists in the
// profile YAML. Targets are wired by dragging the out-port to a price node; watch datasets
// and targets can also be added from the dropdowns here. Rendering only — wiring is in main.js.
import { esc, TRASH } from "../dom.js";

const KINDS = [["interval", "interval (periodic)"], ["on_change", "on change (live)"], ["manual", "manual only"]];

const chip = (val, attr, cls) =>
  `<span class="tg-chip" ${attr}="${esc(val)}">${esc(val)} <button class="${cls}" ${attr}="${esc(val)}" title="remove">${TRASH}</button></span>`;

export function triggerParts(t, model) {
  const kind = KINDS.some(([v]) => v === t.kind) ? t.kind : "interval";
  const kopt = ([v, l]) => `<option value="${v}"${v === kind ? " selected" : ""}>${l}</option>`;

  const interval = kind === "interval"
    ? `<label class="flab" title="seconds between automatic sweeps">every <span class="tg-secs"><input class="tg-interval" type="number" min="1" step="1" value="${t.interval_s || 300}" /> s</span></label>`
    : "";

  let watch = "";
  if (kind === "on_change") {
    const have = new Set(t.watch || []);
    // watch datasets OR views (a view fires when any of its source datasets gains rows)
    const sources = [...model.datasets(), ...(model.profile.subsets || []).map((s) => s.id)];
    const opts = sources.filter((d) => !have.has(d)).map((d) => `<option>${esc(d)}</option>`).join("");
    watch = `<div class="tg-watch"><div class="sub-lbl">watch <span class="muted">(fires on new rows)</span></div>
      <div class="tg-chips">${(t.watch || []).map((w) => chip(w, "data-ds", "tg-rmwatch")).join("")}<select class="tg-addwatch"><option value="">+ watch source…</option>${opts}</select></div></div>`;
  }

  // targets are wired by dragging the out-port to a price node — no add dropdown (redundant)
  const targets = `<div class="tg-targets"><div class="sub-lbl">fires <span class="muted">(drag ▸ to a price node)</span></div>
    <div class="tg-chips">${(t.targets || []).map((p) => chip(p, "data-p", "tg-rmtarget")).join("") || `<span class="muted">none — wire a price node</span>`}</div></div>`;

  return {
    title: `<input class="gi gi-id tgrename" value="${esc(t.id)}" title="rename trigger" />`,
    body: `<label class="flab">kind <select class="tg-kind">${KINDS.map(kopt).join("")}</select></label>
      ${interval}${watch}${targets}
      <div class="gn-foot"><button class="tg-fire">↻ fire now</button><span class="tg-prog muted"></span></div>`,
    ports: `<span class="port out" title="drag to a price node this trigger should fire"></span>`,
  };
}
