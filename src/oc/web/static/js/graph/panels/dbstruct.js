// DB-structure floating panel — shows the per-game SQLite store's shape: the file + size,
// each table (row count, columns, indexes) and a per-dataset breakdown (events / present /
// batches). Built on the shared createFloatWin primitive (like the stats/activity panels —
// never a copy). Refreshed on open and on any dataset-change push (dsevents); rows reconcile
// in place via keyed maps — no innerHTML per tick (CLAUDE.md rule 1).
import { createFloatWin } from "../floatwin.js";
import { h } from "../../dom.js";
import { persist } from "../persist.js";
import { $, model, nodeEls } from "../state.js";
import * as dsevents from "../dsevents.js";
import * as api from "../../api.js";
import { armedButton } from "../armbtn.js";
import { openDbBackupsModal } from "../dbbackups.js";
import { focusNode } from "../main.js";
import { panZoomTo } from "../camera.js";
import { fmtBytes as fmtSize } from "../../bytefmt.js";
import { log } from "../../log.js";

const game = () => model.profile.name;

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
            refresh(true);   // opening is the deliberate moment to pay for a size scan
        },
        onHide: () => {
            $("dbstructBtn")?.classList.toggle("active", false);
            if (dbUnsub) { dbUnsub(); dbUnsub = null; }
        },
        onPersist: () => persist.layout(),
    });
    dbWin.body.replaceChildren(
        h("div", { class: "db-panel" },
            h("div", { class: "db-head" }, h("span", { class: "db-head-txt" })),
            h("div", { class: "db-sec" }, h("div", { class: "db-h" }, "tables"), h("div", { class: "db-tables" })),
            h("div", { class: "db-sec" }, h("div", { class: "db-h" }, "datasets"), h("div", { class: "db-datasets" })),
        ));
    // Open the DB-backups modal (snapshots of the whole store; restore from there).
    const bkBtn = document.createElement("button");
    bkBtn.type = "button"; bkBtn.className = "armbtn db-bk"; bkBtn.textContent = "backups…";
    bkBtn.title = "view / create / restore database snapshots";
    bkBtn.addEventListener("click", () => { if (game()) openDbBackupsModal(game(), () => refresh(true)); });
    // Drop the whole store (fresh empty DB). Dataset nodes survive + resurrect on next write.
    const drop = armedButton({
        label: "drop", arm: "drop all?", cls: "db-drop db-danger", busy: "dropping…",
        title: "wipe the whole store; dataset nodes survive and resurrect on next write",
        onFire: async () => { await api.dropDatabase(game()); refresh(true); },   // re-measure: a drop guts the file
    });
    // Compact the file (VACUUM). NOT armed: it is non-destructive — it rewrites the same rows
    // and only hands SQLite's freelist back to the OS — so a confirm step would be friction for
    // an action that cannot lose anything. Hidden unless there is space worth reclaiming (see
    // render), on the same principle as the dataset compact button: never offer a no-op.
    const vac = document.createElement("button");
    vac.type = "button"; vac.className = "armbtn db-vacuum"; vac.textContent = "compact";
    vac.hidden = true;
    vac.addEventListener("click", async () => {
        if (!game()) return;
        const was = vac.textContent;
        vac.disabled = true; vac.textContent = "compacting…";
        try {
            const r = await api.vacuumDatabase(game());
            if (r.schema) { cacheSizes(r.schema); render(r.schema); }
            log(r.ok ? `compacted ${game()} — freed ${fmtSize(r.freed)}`
                     : "store busy — compact skipped, safe to retry", r.ok ? "ok" : "warn");
        } catch (e) { log(String(e.message || e), "err"); }
        finally { vac.disabled = false; vac.textContent = was; }
    });
    dbWin.body.querySelector(".db-head").append(bkBtn, vac, drop);
}

function scheduleRefresh() {
    clearTimeout(dbDebounce);
    dbDebounce = setTimeout(refresh, 250);   // coalesce a burst of dataset writes into one fetch
}

// Content sizes cost a full scan of every table (~80ms on a 45k-event store), and this panel
// refreshes on EVERY dataset write — so they are opt-in: fetched when the panel opens or after
// an explicit action, never on the write path. The last known values are cached here and kept on
// screen through light refreshes, so sizes stay visible (just slightly stale) instead of blinking
// out whenever a row lands.
const sizeCache = { tables: new Map(), datasets: new Map(), content: null };

function cacheSizes(d) {
    if (d.content == null) return;              // a light payload carries no sizes — keep the old
    sizeCache.content = d.content;
    for (const t of d.tables || []) sizeCache.tables.set(t.name, t.bytes);
    for (const x of d.datasets || []) sizeCache.datasets.set(x.dataset, x.bytes);
}

function refresh(withSizes = false) {
    if (!dbWin || !dbState.visible) return;
    const game = model.profile.name;
    if (!game) { render({ tables: [], datasets: [] }); return; }
    const q = withSizes ? "?sizes=1" : "";
    fetch(`/api/dbschema/${encodeURIComponent(game)}${q}`)
        .then((r) => r.json())
        .then((d) => { if (dbState.visible) { cacheSizes(d); render(d); } })
        .catch(() => {});
}

function headLine(d) {
    const parts = [d.db, `${fmtSize(d.size)} file`];
    if (d.live_bytes != null) parts.push(`${fmtSize(d.live_bytes)} live`);
    // only worth mentioning once it is actually worth reclaiming
    if (d.free_bytes > 1024 * 1024) parts.push(`${fmtSize(d.free_bytes)} reclaimable`);
    return parts.join(" · ");
}

function setText(el, txt) { if (el.textContent !== txt) el.textContent = txt; }

function render(d) {
    if (!dbWin) return;
    const head = dbWin.body.querySelector(".db-head-txt");
    // Answer "why is this file so big?" right in the header. `live` vs `free` comes from O(1)
    // page-header reads, so it is always present; the reclaimable figure is what a VACUUM would
    // hand back to the OS (SQLite parks deleted pages on a freelist and never shrinks on its own).
    setText(head, d.db ? headLine(d) : "no database yet");
    const vac = dbWin.body.querySelector(".db-vacuum");
    if (vac) {
        const worth = (d.free_bytes || 0) > 1024 * 1024;   // below a MB it is not worth a rewrite
        if (vac.hidden === worth) vac.hidden = !worth;     // touch the DOM only on a real change
        if (worth) {
            const t = `reclaim ${fmtSize(d.free_bytes)} of unused pages (rewrites the file; no data is changed)`;
            if (vac.title !== t) vac.title = t;
        }
    }

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
        const tb = sizeCache.tables.get(t.name);
        setText(r.meta, `${t.rows ?? "?"} rows${tb != null ? ` · ${fmtSize(tb)}` : ""}`);
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
        const db = sizeCache.datasets.get(x.dataset);
        setText(r.size, db != null ? fmtSize(db) : "–");
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
    // clear this physical table's rows (low-level — name is fixed per reused row)
    const clear = armedButton({
        label: "clear", arm: "clear table?", cls: "db-act db-danger", busy: "…",
        title: `delete every row in ${name}`,
        onFire: async () => { await api.clearDbTable(game(), name); refresh(true); },
    });
    title.append(nm, document.createTextNode(" · "), meta, clear);
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
    const head = document.createElement("div");
    head.className = "db-dshead";   // name (left) + clear/remove (top-right corner)
    const nm = document.createElement("b"); nm.className = "db-dsname"; nm.textContent = name;
    nm.title = "jump to this dataset's node";
    // inline "no node" note — created hidden, shown when a click hits a missing node
    const miss = document.createElement("i"); miss.className = "db-dsmiss"; miss.hidden = true;
    miss.textContent = "no node for this dataset";
    // click name -> pan/zoom + select the ds:<name> node; if it has no node, flash red + tell
    nm.addEventListener("click", () => {
        const id = `ds:${name}`;
        if (nodeEls.has(id)) {
            nm.classList.remove("missing"); miss.hidden = true;
            if (r.missTimer) { clearTimeout(r.missTimer); r.missTimer = null; }
            focusNode(id); panZoomTo(id);
            return;
        }
        nm.classList.add("missing"); miss.hidden = false;
        if (r.missTimer) clearTimeout(r.missTimer);
        r.missTimer = setTimeout(() => {
            nm.classList.remove("missing"); miss.hidden = true; r.missTimer = null;
        }, 2500);
    });
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
    const [zc, size] = mk("db-size", "size");
    // clear = empty this dataset's records but keep it registered; remove = delete it
    // entirely (its graph node survives and resurrects it on the next write).
    const clear = armedButton({
        label: "clear", arm: "clear data?", cls: "db-act db-danger", busy: "…",
        title: `empty ${name}'s records (keeps the dataset registered)`,
        onFire: async () => { await api.clearDataset(game(), name); refresh(true); },
    });
    const remove = armedButton({
        label: "remove", arm: "remove?", cls: "db-act db-rm db-danger", busy: "…",
        title: `delete ${name} entirely (its node survives and resurrects it)`,
        onFire: async () => { await api.deleteDataset(game(), name); refresh(true); },
    });
    const acts = document.createElement("div");
    acts.className = "db-acts";
    acts.append(clear, remove);
    head.append(nm, miss, acts);
    row.append(head, ec, pc, bc, zc);   // header, then one stat per row
    const r = { row, events, present, batches, size, missTimer: null };
    dsRows.set(name, r);
    return r;
}

export { dbWin, dbState, buildDBStruct };
