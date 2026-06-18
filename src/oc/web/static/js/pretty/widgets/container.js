// Container / panel: a titled box for grouping. It's a visual frame (its own fill/border via
// style) with an optional dynamic title; child widgets sit over it by position + z-order.

import { renderDynamicText } from "../binding.js";
import { keySubscription, textKeys, el } from "./util.js";

export default {
    type: "container",
    title: "Panel",
    icon: "▭",
    defaults: () => ({ config: { title: "Panel" }, w: 320, h: 200 }),
    create(host, widget, ctx) {
        host.className = "pw-container";
        const head = el("div", "pw-container-title");
        host.appendChild(head);
        const sub = keySubscription(ctx, render);
        function render() { head.textContent = renderDynamicText(ctx, widget.config.title || ""); head.hidden = !head.textContent; }
        sub.sync(textKeys(widget.config.title || ""));
        render();
        return { update: render, destroy: sub.destroy };
    },
};
