// Node-input control. Binds to ONE input path (e.g. a trigger interval, a price throttle, a
// field's confidence) and writes a TRANSIENT override — the running profile changes at once,
// the YAML does not, and the node shows as pretty-dirty. Presentation (slider/number/select/
// toggle/radio/stepper) and the author's range/options narrow WITHIN the node's real
// constraint; values are always clamped to it (constraints.js).

import { el } from "./util.js";

function autoPresentation(meta) {
  if (meta.kind === "bool") return "toggle";
  if (meta.kind === "enum") return "select";
  if (meta.kind === "number") return (meta.min != null && meta.max != null) ? "slider" : "number";
  return "text";
}

export default {
  type: "control",
  title: "Control",
  icon: "⎉",
  defaults: () => ({ path: "", config: { presentation: "", label: "", options: [] }, w: 240, h: 64 }),
  create(host, widget, ctx) {
    host.className = "pw-control";
    const path = widget.path || "";
    const meta = ctx.constraints.inputMeta(ctx.model, path);
    const pres = widget.config.presentation || autoPresentation(meta);
    const label = el("label", "pw-ctl-lab", widget.config.label || prettyLabel(path));
    host.appendChild(label);

    if (!path) { host.appendChild(el("div", "pw-ctl-unset", "bind to a node input")); return { update() {}, destroy() {} }; }

    const cur = () => ctx.overrides.overrideValue(path);
    const commit = (v) => { ctx.overrides.setOverride(path, v); ctx.data.publish(widget.id, ctx.overrides.overrideValue(path)); };

    let control, sync;
    const opts = (widget.config.options && widget.config.options.length)
      ? widget.config.options.map((o) => (typeof o === "object" ? o : { label: String(o), value: o }))
      : (meta.options || []).map((o) => ({ label: String(o), value: o }));

    if (pres === "toggle") {
      control = el("input"); control.type = "checkbox";
      control.addEventListener("change", () => commit(control.checked));
      sync = () => { control.checked = !!cur(); };
    } else if (pres === "select" || pres === "radio") {
      if (pres === "select") {
        control = el("select");
        for (const o of opts) { const op = el("option", null, o.label); op.value = o.value; control.appendChild(op); }
        control.addEventListener("change", () => commit(control.value));
        sync = () => { control.value = String(cur() ?? ""); };
      } else {
        control = el("div", "pw-radio");
        opts.forEach((o) => {
          const id = `r_${widget.id}_${o.value}`;
          const r = el("input"); r.type = "radio"; r.name = `rg_${widget.id}`; r.value = o.value; r.id = id;
          r.addEventListener("change", () => r.checked && commit(o.value));
          const lab = el("label", "pw-radio-opt", o.label); lab.prepend(r); lab.htmlFor = id;
          control.appendChild(lab);
        });
        sync = () => { control.querySelectorAll("input").forEach((r) => { r.checked = String(cur() ?? "") === r.value; }); };
      }
    } else if (pres === "stepper") {
      control = el("div", "pw-stepper");
      const minus = el("button", "pw-step", "−"), plus = el("button", "pw-step", "+");
      const out = el("input", "pw-step-val"); out.type = "number";
      const step = widget.config.step ?? meta.step ?? 1;
      minus.addEventListener("click", () => commit((Number(cur()) || 0) - step));
      plus.addEventListener("click", () => commit((Number(cur()) || 0) + step));
      out.addEventListener("change", () => commit(out.value));
      control.append(minus, out, plus);
      sync = () => { out.value = cur() ?? ""; };
    } else if (pres === "slider") {
      control = el("div", "pw-slider");
      const range = el("input"); range.type = "range";
      range.min = widget.config.min ?? meta.min ?? 0;
      range.max = widget.config.max ?? meta.max ?? 100;
      range.step = widget.config.step ?? meta.step ?? 1;
      const out = el("span", "pw-slider-val");
      range.addEventListener("input", () => { out.textContent = range.value; commit(parseFloat(range.value)); });
      control.append(range, out);
      sync = () => { range.value = cur() ?? range.min; out.textContent = range.value; };
    } else {   // number / text
      control = el("input"); control.type = meta.kind === "number" ? "number" : "text";
      if (meta.kind === "number") {
        if ((widget.config.min ?? meta.min) != null) control.min = widget.config.min ?? meta.min;
        if ((widget.config.max ?? meta.max) != null) control.max = widget.config.max ?? meta.max;
        control.step = widget.config.step ?? meta.step ?? 1;
      }
      control.addEventListener("change", () => commit(meta.kind === "number" ? parseFloat(control.value) : control.value));
      sync = () => { control.value = cur() ?? ""; };
    }
    host.appendChild(control);
    const unsub = ctx.data.subscribe(`node:${path}`, sync);
    sync();
    ctx.data.publish(widget.id, cur());
    return { update: sync, destroy: unsub };
  },
};

function prettyLabel(path) {
  const m = /\.([A-Za-z_]\w*)$/.exec(path || "");
  return m ? m[1].replace(/_/g, " ") : (path || "control");
}
