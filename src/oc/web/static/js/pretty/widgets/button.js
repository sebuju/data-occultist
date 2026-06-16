// Action button. One of a small set of glue actions: fire a trigger, run a price sweep, set a
// node-input value (a transient override), or switch the Pretty page. The button reads as a
// normal styled element; its action runs on click.

import * as api from "../../api.js";
import { el } from "./util.js";

const ACTIONS = ["fire_trigger", "run_sweep", "set_value", "switch_page"];
export { ACTIONS };

export default {
  type: "button",
  title: "Button",
  icon: "⏺",
  defaults: () => ({ config: { action: "fire_trigger", target: "", value: "", page: "", label: "Run" }, w: 140, h: 44 }),
  create(host, widget, ctx) {
    host.className = "pw-button-host";
    const c = widget.config || {};
    const btn = el("button", "pw-button", c.label || "Run");
    const msg = el("span", "pw-button-msg");
    btn.addEventListener("click", async () => {
      btn.disabled = true; msg.textContent = "";
      try {
        if (c.action === "fire_trigger") { await api.triggers.fire(ctx.game, c.target); msg.textContent = "fired"; }
        else if (c.action === "run_sweep") { await api.prices.refresh(ctx.game, c.target); msg.textContent = "sweeping"; }
        else if (c.action === "set_value") { await ctx.overrides.setOverride(c.target, c.value); msg.textContent = "set"; }
        else if (c.action === "switch_page") { ctx.switchPage(c.page); }
      } catch (e) { msg.textContent = String(e.message || e); }
      finally { btn.disabled = false; setTimeout(() => { msg.textContent = ""; }, 2000); }
    });
    host.append(btn, msg);
    return { update() {}, destroy() {} };
  },
};
