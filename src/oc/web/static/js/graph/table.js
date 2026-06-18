// Enhance a rendered <table class="grid-table"> with click-to-sort headers and
// drag-to-resize columns. Column identity is the header TEXT (robust to column
// reordering); state survives the frequent re-renders the poll loop does. Called after
// each innerHTML build.
//
// Sort: left-click a header cycles none → desc → asc → none. Shift-click ADDS a column
// to the sort (multi-key, in click order). The sort indicator overlays the header
// (absolute), so it never steals column width.
//
// Per-table state (widths + sort) persists in the PROFILE (layout.tables[id]) via an
// injected store, so it travels with the game — table.js itself stays decoupled from the
// model and persist internals. Until wired, an in-memory fallback keeps it working.

import { colResizeDrag } from "./dragresize.js";

let _store = (() => {
    const mem = new Map();
    return { load: (id) => mem.get(id) || {}, save: (id, st) => mem.set(id, st) };
})();
export function setTableStore(store) { _store = store; }

const loadState = (id) => _store.load(id);
const saveState = (id, st) => _store.save(id, st);

function fontOf(el) {
    const s = getComputedStyle(el);
    return `${s.fontStyle} ${s.fontWeight} ${s.fontSize}/${s.lineHeight} ${s.fontFamily}`;
}

// Natural pixel width that fits column i's header + every body cell (text is nowrap),
// clamped. Header gets extra room for the sort-icon + grip overlays. Used both to guess
// default widths and to autofit on grip double-click. Measures via canvas → independent
// of the table's current (fixed) layout.
function measureColWidth(table, i, names) {
    const cv = measureColWidth._cv || (measureColWidth._cv = document.createElement("canvas"));
    const ctx = cv.getContext("2d");
    const th = table.tHead.rows[0].cells[i];
    ctx.font = fontOf(th);
    let max = ctx.measureText(names[i] ?? "").width + 22;   // header text + icon/grip overlay room
    const body = table.tBodies[0];
    if (body && body.rows.length) {
        ctx.font = fontOf(body.rows[0].cells[i] || th);
        for (const row of body.rows) max = Math.max(max, ctx.measureText(row.cells[i]?.textContent ?? "").width);
    }
    return Math.min(600, Math.max(40, Math.ceil(max) + 10));   // + cell padding/slack
}

function cellCmp(a, b) {
    const sa = (a ?? "").trim(), sb = (b ?? "").trim();
    if (sa === sb) return 0;
    if (sa === "") return 1;            // blanks always sink
    if (sb === "") return -1;
    const na = Number(sa), nb = Number(sb);
    if (sa !== "" && sb !== "" && !Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
    return sa.toLowerCase() < sb.toLowerCase() ? -1 : 1;
}

export function enhanceTable(table, id) {
    if (!table || !table.tHead || !table.tHead.rows[0]) return;
    const ths = [...table.tHead.rows[0].cells];
    const names = ths.map((th) => th.dataset.col || th.textContent.trim());
    ths.forEach((th, i) => { th.dataset.col = names[i]; });

    const st = loadState(id);
    st.sorts = st.sorts || [];          // [{col, dir}] dir: -1 desc, 1 asc
    st.widths = st.widths || {};        // col name -> px

    // fixed layout + a <colgroup> so column widths are honoured (and clip overflow)
    table.querySelector("colgroup")?.remove();
    const cg = document.createElement("colgroup");
    ths.forEach((th, i) => {
        const col = document.createElement("col");
        const w = st.widths[names[i]];
        col.style.width = `${w || measureColWidth(table, i, names)}px`;   // stored, else guess from data
        cg.appendChild(col);
    });
    table.insertBefore(cg, table.firstChild);
    table.classList.add("colsized");

    applySort(table, names, st.sorts);

    ths.forEach((th, i) => {
        th.classList.add("th-sortable");
        let icon = th.querySelector(".th-sort");
        if (!icon) { icon = document.createElement("span"); icon.className = "th-sort"; th.appendChild(icon); }
        let grip = th.querySelector(".th-grip");
        if (!grip) { grip = document.createElement("span"); grip.className = "th-grip"; th.appendChild(grip); }
        grip.onmousedown = (e) => startColResize(e, cg.children[i], names[i], id, st, table);
        grip.ondblclick = (e) => {                  // autofit column to header + data
            e.preventDefault(); e.stopPropagation();
            const w = measureColWidth(table, i, names);
            cg.children[i].style.width = `${w}px`;
            st.widths[names[i]] = w;
            saveState(id, st);
        };
        th.onclick = (e) => {
            if (e.target === grip) return;           // a resize drag isn't a sort click
            if (table.__resized) { table.__resized = false; return; }   // drag ended over th, not grip
            cycleSort(st, names[i], e.shiftKey);
            saveState(id, st);
            applySort(table, names, st.sorts);
            renderIcons(ths, names, st);
        };
    });
    renderIcons(ths, names, st);
}

function cycleSort(st, col, shift) {
    const at = st.sorts.findIndex((s) => s.col === col);
    if (shift) {
        if (at < 0) st.sorts.push({ col, dir: -1 });          // add as a new key (desc first)
        else if (st.sorts[at].dir === -1) st.sorts[at].dir = 1;
        else st.sorts.splice(at, 1);                          // desc → asc → drop
        return;
    }
    // no shift: this column becomes the sole sort, cycling desc → asc → none
    if (st.sorts.length === 1 && at === 0) {
        if (st.sorts[0].dir === -1) st.sorts[0].dir = 1;
        else st.sorts = [];
    } else {
        st.sorts = [{ col, dir: -1 }];
    }
}

function applySort(table, names, sorts) {
    const tb = table.tBodies[0];
    if (!tb || !sorts.length) return;            // none = leave server/DOM order
    const idx = sorts.map((s) => ({ i: names.indexOf(s.col), dir: s.dir })).filter((s) => s.i >= 0);
    const rows = [...tb.rows];
    rows.sort((ra, rb) => {
        for (const s of idx) {
            const c = cellCmp(ra.cells[s.i]?.textContent, rb.cells[s.i]?.textContent) * s.dir;
            if (c) return c;
        }
        return 0;
    });
    rows.forEach((r) => tb.appendChild(r));      // stable reorder in place
}

function renderIcons(ths, names, st) {
    ths.forEach((th, i) => {
        const icon = th.querySelector(".th-sort");
        if (!icon) return;
        const at = st.sorts.findIndex((s) => s.col === names[i]);
        if (at < 0) { icon.hidden = true; icon.textContent = ""; return; }
        icon.hidden = false;
        icon.textContent = (st.sorts[at].dir < 0 ? "▼" : "▲") + (st.sorts.length > 1 ? `${at + 1}` : "");
    });
}

function startColResize(e, col, name, id, st, table) {
    const startW = parseFloat(col.style.width) || col.offsetWidth || 80;
    colResizeDrag(e, {
        moved: () => { table.__resized = true; },   // suppress the trailing sort click
        onDelta: (dx) => { col.style.width = `${Math.max(36, Math.round(startW + dx))}px`; },
        onSettle: () => { st.widths[name] = parseFloat(col.style.width); saveState(id, st); },
    });
}
