// Pages panel (edit mode): the page manager — list every pretty page, switch to one by clicking
// it, drag rows to reorder, rename in place (double-click), delete (armed two-click), and add a
// new page. Replaces the old topbar page dropdown + "+ page" button (moved in here). Built on the
// shared floating-window primitive (createFloatWin), same as every other studio panel.

import { createFloatWin } from "../../graph/floatwin.js";
import { el } from "../widgets/util.js";
import { svg } from "../../dom.js";

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
        name.title = "click to switch";
        name.addEventListener("click", () => { ctx.switchPage(p.id); refresh(); });

        // rename: a pencil button (matches the rest of the UI's explicit controls — no double-click).
        const edit = el("button", "pw-pages-edit"); edit.title = "rename page";
        edit.appendChild(svg("svg", { viewBox: "0 0 16 16", width: "12", height: "12", "aria-hidden": "true" },
            svg("path", {
                d: "M11.5 2.5l2 2L6 12l-2.5.5L4 10l7.5-7.5zM10.5 3.5l2 2",
                fill: "none", stroke: "currentColor", "stroke-width": "1.3", "stroke-linecap": "round", "stroke-linejoin": "round",
            })));
        edit.addEventListener("click", (e) => { e.stopPropagation(); beginRename(r, p, name); });

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
        r.append(grip, name, edit, del);
        return r;
    }

    // inline rename: swap the name button for an input. Enter commits; a rejected name (empty or a
    // COLLISION with another page) flashes and stays open to fix. Escape / blur-while-invalid cancels.
    function beginRename(r, p, name) {
        const inp = el("input", "pw-pages-rename"); inp.value = p.title; inp.spellcheck = false;
        let done = false;
        const close = () => { if (done) return; done = true; refresh(); };
        // try to apply the typed name; true = handled (committed or unchanged), false = rejected.
        const tryCommit = () => {
            const v = inp.value.trim();
            if (v === p.title) { close(); return true; }       // no change
            if (!v || !ctx.renamePage(p.id, v)) return false;   // empty or name collision -> reject
            close(); return true;
        };
        inp.addEventListener("input", () => inp.classList.remove("bad"));
        inp.addEventListener("keydown", (e) => {
            if (e.key === "Enter") { e.preventDefault(); if (!tryCommit()) { inp.classList.add("bad"); inp.select(); } }
            else if (e.key === "Escape") { e.preventDefault(); close(); }
        });
        inp.addEventListener("blur", () => { if (!tryCommit()) close(); });   // invalid on blur -> just cancel (revert)
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
