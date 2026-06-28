// Elements panel (edit mode): a flat list of every element on the current page. Click a row to
// select it, hover a row to highlight that element in the canvas, remove it (armed two-click).
// Built on the shared floating-window primitive, same as the other studio panels.

import { createFloatWin } from "../../graph/floatwin.js";
import { el } from "../widgets/util.js";

export const elementsState = { visible: false, x: null, y: null, w: 300, h: null, collapsed: false };

// friendly label for a widget (its content title/text/label or bound id), falling back to its type
const nameOf = (w) => { const c = w.config || {}; return c.title || c.text || c.label || (w.binding && w.binding.id) || w.type; };

export function buildElements(ctx) {
    const win = createFloatWin({ id: "pretty-elements", title: "elements", state: elementsState, onShow: () => refresh() });
    const list = el("div", "pw-el-list");
    win.body.append(list);

    function refresh() {
        list.textContent = "";
        const sel = ctx.selectionIds();
        const ws = ctx.currentWidgets();
        if (!ws.length) { list.appendChild(el("div", "pw-el-empty", "no elements")); return; }
        for (const w of ws) list.appendChild(row(w, sel.has(w.id)));
    }

    function row(w, active) {
        const r = el("div", "pw-el-row");
        if (active) r.classList.add("active");
        // hover a row -> highlight that element on the canvas; leaving clears it
        r.addEventListener("mouseenter", () => ctx.highlightWidget(w.id));
        r.addEventListener("mouseleave", () => ctx.highlightWidget(null));

        const name = el("button", "pw-el-name"); name.title = "select element";
        name.append(el("span", "pw-el-lab", nameOf(w)), el("span", "pw-el-id", w.id));
        name.addEventListener("click", () => ctx.selectWidget(w.id));

        const del = el("button", "pw-el-del"); del.appendChild(document.createTextNode("✕"));
        del.title = "remove element (click again to confirm)";
        del.addEventListener("click", (e) => {
            e.stopPropagation();
            if (del.dataset.armed !== "1") { del.dataset.armed = "1"; del.classList.add("armed"); setTimeout(() => { del.dataset.armed = "0"; del.classList.remove("armed"); }, 2500); return; }
            ctx.removeWidget(w.id);
        });

        r.append(name, del);
        return r;
    }

    return { win, refresh };
}
