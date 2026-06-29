// Action button. One of a small set of glue actions: fire a trigger, run a price sweep, set a
// node-input value (a transient override), or switch the Pretty page. The button reads as a
// normal styled element; its action runs on click.

import * as api from "../../api.js";
import * as hub from "../../hub.js";
import { el } from "./util.js";

const ACTIONS = ["fire_trigger", "run_sweep", "set_value", "switch_page", "live_on", "live_off", "live_toggle"];
export { ACTIONS };

export default {
    type: "button",
    title: "Button",
    icon: "⏺",
    defaults: () => ({ config: { action: "fire_trigger", target: "", value: "", page: "", label: "Run" }, style: { alignH: "center", alignV: "middle", fill: true }, w: 80, h: 28 }),
    create(host, widget, ctx) {
        host.className = "pw-button-host";
        const c = widget.config || {};
        const btn = el("button", "pw-button", c.label || "Run");
        applyPlacement(host, btn, widget.style || {});
        // no in-button status text — the action just runs (errors surface in the console/log, not on the button)
        btn.addEventListener("click", async () => {
            btn.disabled = true;
            try {
                if (c.action === "fire_trigger") { await api.triggers.fire(ctx.game, c.target); }
                else if (c.action === "run_sweep") { await api.prices.refresh(ctx.game, c.target); }
                else if (c.action === "set_value") { await ctx.overrides.setOverride(c.target, c.value); }
                else if (c.action === "switch_page") { ctx.switchPage(c.page); }
                // live actions kick the heartbeat so every activity-bound part of the UI (indicators,
                // the live panel, activity:* conditions) reflects the new state at once, not next cadence.
                else if (c.action === "live_on") { await api.live.start(ctx.game); hub.kick(); }
                else if (c.action === "live_off") { await api.live.stop(ctx.game); hub.kick(); }
                else if (c.action === "live_toggle") {
                    // toggle off the live heartbeat the activity source reports, else start it
                    const on = !!(ctx.data.read("activity") || {}).live;
                    if (on) await api.live.stop(ctx.game); else await api.live.start(ctx.game);
                    hub.kick();
                }
            } catch { /* action error — left silent per design (no in-button message) */ }
            finally { btn.disabled = false; }
        });
        host.append(btn);
        // re-apply placement on update so STYLE edits (alignH/alignV/fill) take effect live via restyle,
        // without a full canvas rebuild (label changes still need a rebuild — they live in config).
        // styleTarget: the canvas paints the widget's Style onto the INNER button (it has its own chrome
        // that would otherwise hide the frame's), so bg/border/radius/colour/font all reach the button.
        return { update() { applyPlacement(host, btn, widget.style || {}); }, destroy() {}, styleTarget: btn };
    },
};

// Placement of the button within its (frame-filling) host — a STYLE concern, not config: justify-content
// = horizontal, align-items = vertical; `fill` stretches the button to the whole host (both axes), so the
// align picks only matter when it doesn't fill. Set deterministically (clears when toggled off). Defaults
// reproduce the old look (left / middle / no-fill).
function applyPlacement(host, btn, st) {
    const H = { left: "flex-start", center: "center", right: "flex-end" };
    const V = { top: "flex-start", middle: "center", bottom: "flex-end" };
    host.style.justifyContent = H[st.alignH] || "flex-start";
    host.style.alignItems = V[st.alignV] || "center";
    btn.style.flex = st.fill ? "1 1 auto" : "";
    btn.style.alignSelf = st.fill ? "stretch" : "";
}
