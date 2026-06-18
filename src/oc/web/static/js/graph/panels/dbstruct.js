// DB-structure floating panel — shows the per-game SQLite store's shape: the file + size,
// each table (row count, columns, indexes) and a per-dataset breakdown (events / present /
// batches). Built on the shared createFloatWin primitive (like the stats/activity panels —
// never a copy). Refreshed on open and on any dataset-change push (dsevents); rows reconcile
// in place via keyed maps — no innerHTML per tick (CLAUDE.md rule 1).
import { createFloatWin } from "../floatwin.js";
import { persist } from "../persist.js";
import { $, model } from "../state.js";
import * as dsevents from "../dsevents.js";

const dbState = { visible: false, x: null, y: null, w: null, h: null };
let dbWin = null;
let dbUnsub = null;
let dbDebounce = null;
const tableRows = new Map();   // table name -> { row, meta, cols }
const dsRows = new Map();      // dataset name -> { row, events, present, batches }

function buildDBStruct() {
    if (dbWin) return;
    dbWin = createFloatWin({
        id: "dbstruct", title: "database", state: dbState, bothAxes: true,
        onShow: () => {
            $("dbstructBtn")?.classList.toggle("active", true);
            dbUnsub = dsevents.subscribe(scheduleRefresh);   // counts shift as data is written
            refresh();
        },
        onHide: () => {
            $("dbstructBtn")?.classList.toggle("active", false);
            if (dbUnsub) { dbUnsub(); dbUnsub = null; }
        },
        onPersist: () => persist.layout(),
    });
    dbWin.body.innerHTML =
        `<div class="db-panel">` +
        `<div class="db-head"></div>` +
        `<div class="db-sec"><div class="db-h">tables</div><div class="db-tables"></div></div>` +
        `<div class="db-sec"><div class="db-h">datasets</div><div class="db-datasets"></div></div>` +
        `</div>`;
}

function scheduleRefresh() {
    clearTimeout(dbDebounce);
    dbDebounce = setTimeout(refresh, 250);   // coalesce a burst of dataset writes into one fetch
}

function fmtSize(n) {
    if (!n && n !== 0) return "";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function refresh() {
    if (!dbWin || !dbState.visible) return;
    const game = model.profile.name;
    if (!game) { render({ tables: [], datasets: [] }); return; }
    fetch(`/api/dbschema/${encodeURIComponent(game)}`)
        .then((r) => r.json())
        .then((d) => { if (dbState.visible) render(d); })
        .catch(() => {});
}

function setText(el, txt) { if (el.textContent !== txt) el.textContent = txt; }

function render(d) {
    if (!dbWin) return;
    const head = dbWin.body.querySelector(".db-head");
    setText(head, d.db ? `${d.db} · ${fmtSize(d.size)}` : "no database yet");

    // ---- tables (reconcile in place) ----
    const tlist = dbWin.body.querySelector(".db-tables");
    const tables = d.tables || [];
    const wantT = new Set(tables.map((t) => t.name));
    for (const [k, r] of tableRows) if (!wantT.has(k)) { r.row.remove(); tableRows.delete(k); }
    let i = 0;
    for (const t of tables) {
        let r = tableRows.get(t.name);
        if (!r) r = makeTableRow(t.name);
        const at = tlist.children[i];
        if (at !== r.row) tlist.insertBefore(r.row, at || null);
        i++;
        setText(r.meta, `${t.rows ?? "?"} rows`);
        setText(r.cols, (t.columns || []).map((c) => c.name).join(", "));
        const idx = (t.indexes || []).join(", ");
        setText(r.idx, idx ? `idx: ${idx}` : "");
    }

    // ---- datasets (reconcile in place) ----
    const dlist = dbWin.body.querySelector(".db-datasets");
    const datasets = d.datasets || [];
    const wantD = new Set(datasets.map((x) => x.dataset));
    for (const [k, r] of dsRows) if (!wantD.has(k)) { r.row.remove(); dsRows.delete(k); }
    let j = 0;
    for (const x of datasets) {
        let r = dsRows.get(x.dataset);
        if (!r) r = makeDsRow(x.dataset);
        const at = dlist.children[j];
        if (at !== r.row) dlist.insertBefore(r.row, at || null);
        j++;
        setText(r.events, `${x.events}`);
        setText(r.present, `${x.present}`);
        setText(r.batches, `${x.batches}`);
    }
    if (!datasets.length && !dsRows.size) {
        // leave the empty section; the head line already says "no database yet" when relevant
    }
    dbWin.fitHeight();
}

function makeTableRow(name) {
    const row = document.createElement("div");
    row.className = "db-trow";
    const title = document.createElement("div");
    title.className = "db-tname";
    const nm = document.createElement("b"); nm.textContent = name;
    const meta = document.createElement("span"); meta.className = "db-tmeta";
    title.append(nm, document.createTextNode(" · "), meta);
    const cols = document.createElement("div"); cols.className = "db-tcols";
    const idx = document.createElement("div"); idx.className = "db-tidx";
    row.append(title, cols, idx);
    const r = { row, meta, cols, idx };
    tableRows.set(name, r);
    return r;
}

function makeDsRow(name) {
    const row = document.createElement("div");
    row.className = "db-dsrow";
    const nm = document.createElement("b"); nm.className = "db-dsname"; nm.textContent = name;
    const mk = (cls, lbl) => {
        const chip = document.createElement("span");
        chip.className = `db-chip ${cls}`;
        const lab = document.createElement("i"); lab.textContent = lbl;
        const val = document.createElement("b");
        chip.append(lab, val);
        return [chip, val];
    };
    const [ec, events] = mk("db-events", "events");
    const [pc, present] = mk("db-present", "present");
    const [bc, batches] = mk("db-batches", "batches");
    row.append(nm, ec, pc, bc);
    const r = { row, events, present, batches };
    dsRows.set(name, r);
    return r;
}

export { dbWin, dbState, buildDBStruct };
