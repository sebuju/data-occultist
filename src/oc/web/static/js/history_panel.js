// The edit-history floating panel — a scrollable list of every recorded edit, the current point
// highlighted, click a row to travel there (undo/redo are the header arrows). ONE builder, shared
// by the node graph and the Pretty studio (each hands it its own `createHistory` instance, so the
// two histories stay independent). Built on the shared floatwin primitive like every other panel.
//
// Reconciles in place (CLAUDE.md rule 1): rows are POSITIONAL (index == list position), so a
// steady subscribe/tick reuses the row nodes and only rewrites changed text/class — never a full
// innerHTML rebuild. A delegated click reads the row's data-i so handlers never churn.

import { createFloatWin } from "./graph/floatwin.js";
import { h } from "./dom.js";
import { sinceShort } from "./datefmt.js";

export function createHistoryPanel({ hist, id, title = "history", state, onPersist = null, onShow = null, onHide = null }) {
    let win = null;
    let list = null;
    let undoBtn = null, redoBtn = null, counter = null;
    let tick = null;
    let lastCur = -1, lastLen = -1;   // skip scroll/fit when neither moved (steady tick = no churn)
    const rows = [];   // positional pool: rows[i] = { row, lbl, time }

    undoBtn = h("button", { class: "hist-nav", title: "undo (Ctrl+Z)", onClick: () => hist.undo() }, "◄");
    redoBtn = h("button", { class: "hist-nav", title: "redo (Ctrl+Y)", onClick: () => hist.redo() }, "►");
    counter = h("span", { class: "hist-count" });

    win = createFloatWin({
        id, title, state,
        headerExtra: h("span", { class: "hist-nav-wrap" }, counter, undoBtn, redoBtn),
        bothAxes: true,
        onShow: () => { render(); startTick(); onShow && onShow(); },
        onHide: () => { stopTick(); onHide && onHide(); },
        onPersist,
    });
    list = h("div", { class: "hist-list" });
    win.body.replaceChildren(list);
    // one delegated click: travel to the clicked entry (non-destructive jump)
    list.addEventListener("click", (ev) => {
        const r = ev.target.closest(".hist-row");
        if (r) hist.jumpTo(+r.dataset.i);
    });

    function makeRow() {
        // <bdi> isolates the label as an LTR run so the parent's direction:rtl (which puts the
        // ellipsis on the LEFT) doesn't reorder trailing punctuation like the closing quote.
        const lblTxt = h("bdi");
        const lbl = h("span", { class: "hist-lbl" }, lblTxt);
        const time = h("span", { class: "hist-time" });
        const row = h("div", { class: "hist-row" }, lbl, time);
        list.appendChild(row);
        return { row, lbl, lblTxt, time };
    }

    function render() {
        if (!win || !state.visible) return;
        const entries = hist.entries();
        const cur = hist.index();
        while (rows.length > entries.length) rows.pop().row.remove();
        for (let i = 0; i < entries.length; i++) {
            const e = entries[i];
            const r = rows[i] || (rows[i] = makeRow());
            if (r.lblTxt.textContent !== e.label) { r.lblTxt.textContent = e.label; r.lbl.title = e.label; }
            const t = sinceShort(e.ts);
            if (r.time.textContent !== t) r.time.textContent = t;
            if (r.row.dataset.i !== String(i)) r.row.dataset.i = String(i);
            const kind = e.kind || "change";
            if (r.row.dataset.kind !== kind) r.row.dataset.kind = kind;   // colour by edit type
            r.row.classList.toggle("hist-cur", i === cur);
            r.row.classList.toggle("hist-future", i > cur);   // redoable (dimmed)
        }
        const cnt = entries.length ? `${cur + 1}/${entries.length}` : "";
        if (counter.textContent !== cnt) counter.textContent = cnt;
        if (undoBtn.disabled === hist.canUndo()) undoBtn.disabled = !hist.canUndo();
        if (redoBtn.disabled === hist.canRedo()) redoBtn.disabled = !hist.canRedo();
        // structure/position changed only on a real edit or jump — scroll + refit then, not on the
        // steady "since" tick (which leaves the DOM untouched).
        if (cur !== lastCur || entries.length !== lastLen) {
            rows[cur]?.row.scrollIntoView({ block: "nearest" });
            win.fitHeight();
            lastCur = cur; lastLen = entries.length;
        }
    }

    // "since" labels drift; refresh them on a slow tick while the panel is open (no edits needed).
    function startTick() { stopTick(); tick = setInterval(render, 10000); }
    function stopTick() { if (tick) { clearInterval(tick); tick = null; } }

    // re-render on every history change (edit / undo / redo / jump / reset)
    hist.subscribe(render);

    return win;
}
