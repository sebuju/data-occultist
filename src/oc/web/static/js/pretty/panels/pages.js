// Pages panel (edit mode): the page manager — list every pretty page, switch to one by clicking
// it, drag rows to reorder, rename in place (double-click), delete (armed two-click), and add a
// new page. Replaces the old topbar page dropdown + "+ page" button (moved in here). Built on the
// shared floating-window primitive (createFloatWin), same as every other studio panel.

import { createFloatWin } from "../../graph/floatwin.js";
import { el } from "../widgets/util.js";

export const pagesState = { visible: false, x: null, y: null, w: 300, h: null, collapsed: false };

export function buildPages(ctx) {
    const win = createFloatWin({ id: "pretty-pages", title: "pages", state: pagesState, onShow: () => refresh() });
    const list = el("div", "pw-pages-list");
    const add = el("button", "pw-pages-add", "+ page");
    add.addEventListener("click", () => { ctx.addPage(); refresh(); });
    win.body.append(list, add);

    let dragId = null;

    function refresh() {
        list.textContent = "";
        const cur = ctx.currentPageId();
        for (const p of ctx.pretty.pages()) list.appendChild(row(p, cur));
    }

    function row(p, cur) {
        const r = el("div", "pw-pages-row");
        if (p.id === cur) r.classList.add("active");
        r.draggable = true;
        r.addEventListener("dragstart", (e) => { dragId = p.id; r.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; });
        r.addEventListener("dragend", () => { dragId = null; r.classList.remove("dragging"); });
        r.addEventListener("dragover", (e) => { if (dragId && dragId !== p.id) { e.preventDefault(); r.classList.add("drop-into"); } });
        r.addEventListener("dragleave", () => r.classList.remove("drop-into"));
        r.addEventListener("drop", (e) => { e.preventDefault(); r.classList.remove("drop-into"); if (dragId && dragId !== p.id) reorder(dragId, p.id); });

        const grip = el("span", "pw-pages-grip", "⠿"); grip.title = "drag to reorder";
        const name = el("button", "pw-pages-name", p.title);
        name.title = "click to switch · double-click to rename";
        name.addEventListener("click", () => { ctx.switchPage(p.id); refresh(); });
        name.addEventListener("dblclick", (e) => { e.preventDefault(); beginRename(r, p, name); });

        // delete: armed two-click (no blocking confirm — rule 2). Disabled when it's the last page.
        const del = el("button", "pw-pages-del");
        del.appendChild(document.createTextNode("✕"));
        if (ctx.pretty.pages().length <= 1) { del.disabled = true; del.title = "can't delete the only page"; }
        else {
            del.title = "delete page (click again to confirm)";
            del.addEventListener("click", () => {
                if (del.dataset.armed !== "1") { del.dataset.armed = "1"; del.classList.add("armed"); setTimeout(() => { del.dataset.armed = "0"; del.classList.remove("armed"); }, 2500); return; }
                if (ctx.removePage(p.id)) refresh();
            });
        }
        r.append(grip, name, del);
        return r;
    }

    // inline rename: swap the name button for an input, commit on Enter/blur, cancel on Escape.
    function beginRename(r, p, name) {
        const inp = el("input", "pw-pages-rename"); inp.value = p.title; inp.spellcheck = false;
        let done = false;
        const commit = () => { if (done) return; done = true; const v = inp.value.trim(); if (v) ctx.renamePage(p.id, v); refresh(); };
        const cancel = () => { if (done) return; done = true; refresh(); };
        inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } else if (e.key === "Escape") { e.preventDefault(); cancel(); } });
        inp.addEventListener("blur", commit);
        r.replaceChild(inp, name); inp.focus(); inp.select();
    }

    function reorder(fromId, toId) {
        const ids = ctx.pretty.pages().map((p) => p.id);
        const from = ids.indexOf(fromId), to = ids.indexOf(toId);
        if (from < 0 || to < 0) return;
        ids.splice(to, 0, ids.splice(from, 1)[0]);
        ctx.reorderPages(ids);
        refresh();
    }

    return { win, refresh };
}
