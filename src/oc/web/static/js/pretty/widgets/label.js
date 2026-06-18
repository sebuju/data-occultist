// Label / dynamic text. Plain text plus {{tokens}} that splice in live data, status, or a
// node-input value — e.g. "Total worth: {{ subset:portfolio.plat | sum }} pt". Re-renders
// only when a referenced source changes (data layer notifies on change, not every tick).

import { renderDynamicText } from "../binding.js";
import { keySubscription, textKeys } from "./util.js";

export default {
    type: "label",
    title: "Label",
    icon: "T",
    defaults: () => ({ config: { text: "Label" }, w: 240, h: 44 }),
    create(host, widget, ctx) {
        host.className = "pw-label";
        const sub = keySubscription(ctx, render);
        function render() { host.textContent = renderDynamicText(ctx, widget.config.text || ""); }
        sub.sync(textKeys(widget.config.text || ""));
        render();
        return { update: render, destroy: sub.destroy };
    },
};
