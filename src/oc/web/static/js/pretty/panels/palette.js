// Widget palette (edit mode): a floating panel of widget types; click one to drop it on the
// current page. A panel toggle, not inline chrome (rule 7) — built on the shared floatwin.

import { createFloatWin } from "../../graph/floatwin.js";
import { WIDGET_LIST } from "../widgets/index.js";
import { el } from "../widgets/util.js";

export const paletteState = { visible: false, x: null, y: null, w: 180, h: null, collapsed: false };

export function buildPalette(ctx) {
    const win = createFloatWin({ id: "pretty-palette", title: "widgets", state: paletteState, autoFit: false });
    for (const def of WIDGET_LIST) {
        const b = el("button", "pw-pal-item");
        b.innerHTML = `<span class="pw-pal-ic">${def.icon || "▫"}</span><span>${def.title}</span>`;
        b.addEventListener("click", () => ctx.addWidget(def.type));
        win.body.appendChild(b);
    }
    return { win, refresh() {} };
}
