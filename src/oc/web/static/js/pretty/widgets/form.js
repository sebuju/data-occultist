// Data-entry form: inputs mapped to a dataset's columns; submit writes one record (keyed
// exactly as the collector would). Each field's live value is published to the reactive scope
// under widget:<id>.<column> so other elements can react to what's being typed.

import * as papi from "../api.js";
import { el } from "./util.js";

export default {
  type: "form",
  title: "Form",
  icon: "✎",
  defaults: () => ({ config: { dataset: "", submit: "Add",
    fields: [{ column: "name", input: "text", label: "Name", required: true }] }, w: 280, h: 200 }),
  create(host, widget, ctx) {
    host.className = "pw-form";
    const c = widget.config || {};
    const inputs = new Map();
    const values = {};
    const publish = () => ctx.data.publish(widget.id, { ...values });

    for (const f of c.fields || []) {
      const row = el("label", "pw-form-row");
      row.appendChild(el("span", "pw-form-lab", f.label || f.column));
      let inp;
      if (f.input === "select") {
        inp = el("select");
        for (const o of (f.options || [])) { const op = el("option", null, String(o)); op.value = o; inp.appendChild(op); }
      } else {
        inp = el("input"); inp.type = f.input === "number" ? "number" : "text";
      }
      inp.addEventListener("input", () => { values[f.column] = inp.value; publish(); });
      inputs.set(f.column, { inp, f });
      values[f.column] = "";
      row.appendChild(inp);
      host.appendChild(row);
    }

    const msg = el("div", "pw-form-msg");
    const btn = el("button", "pw-form-submit", c.submit || "Add");
    btn.addEventListener("click", async () => {
      const missing = (c.fields || []).some((f) => f.required && !String(values[f.column] || "").trim());
      if (missing) { msg.textContent = "fill required fields"; return; }
      const payload = {};
      for (const [col, { inp, f }] of inputs) {
        let v = inp.value;
        if (f.input === "number" && v !== "") v = Number(v);
        if (v !== "") payload[col] = v;
      }
      btn.disabled = true; msg.textContent = "saving…";
      try {
        const r = await papi.recordRow(ctx.game, c.dataset, payload);
        msg.textContent = r.written ? "added ✓" : "no change";
        ctx.data.refresh(`dataset:${c.dataset}`);   // update bound tables/charts immediately
        for (const [, { inp }] of inputs) inp.value = "";
        for (const k of Object.keys(values)) values[k] = "";
        publish();
      } catch (e) { msg.textContent = String(e.message || e); }
      finally { btn.disabled = false; }
    });
    host.appendChild(btn); host.appendChild(msg);
    publish();
    return { update() {}, destroy() {} };
  },
};
