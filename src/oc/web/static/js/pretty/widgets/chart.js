// Chart bound to a dataset/subset. Redraws only when the bound rows change. Type, x column,
// and y series are authored in the inspector; colours fall back to a built-in palette.

import { resolveRows, dataKeyForBinding } from "../binding.js";
import { drawChart } from "../chart_draw.js";
import { keySubscription } from "./util.js";

export default {
    type: "chart",
    title: "Chart",
    icon: "▮",
    defaults: () => ({ binding: { src: "dataset", id: "" },
        config: { chart_type: "bar", x: "name", y: [], colorBy: {}, title: "" }, w: 380, h: 240 }),
    create(host, widget, ctx) {
        host.className = "pw-chart-host";
        const sub = keySubscription(ctx, render);
        function render() {
            const c = widget.config || {};
            const y = c.y || [];
            drawChart(host, { type: c.chart_type || "bar", rows: resolveRows(ctx, widget.binding),
                x: c.x || "name", y, colors: y.map((k) => (c.colorBy || {})[k]), title: c.title || "" });
        }
        sub.sync([dataKeyForBinding(widget.binding)]);
        // size changes (resize in edit mode) need a redraw too — observe the host box
        const ro = new ResizeObserver(() => render());
        ro.observe(host);
        render();
        return { update: render, destroy() { ro.disconnect(); sub.destroy(); } };
    },
};
