// Node-log topbar panel: one big vttable merging EVERY node's satellite log into a single view.
// Unlike a per-node satellite (opened per node, one table each), this is the "everything at once"
// overview — spans the full window width, docked at the bottom above the logbar (see the
// `span:"bottom"` option on createFloatWin, added for this panel).
//
// AUTO-DISCOVERED, not a hand-maintained list: every history ring rides the activity heartbeat as a
// `<kind>_history: {id: [entries...]}` top-level snapshot field (see build_activity /
// history_ring.HistoryRing.snapshot — that shape IS the ring convention every satellite feeder
// builds on, rule 7; trigger/readout/producer history and the on_input considered-event ring
// (`input_history`) all migrated onto it too). This panel just walks `Object.entries(snap)` for any
// key ending `_history` and flattens it — a NEW satellite log that follows the same convention shows
// up here with ZERO changes to this file. (readout_history's per-entry key happens to be "win:ro"
// rather than a bare id — no special-case needed, it's still one string.)
//
// Columns are kept to what's COMMON across every kind (`when`/`node`/`kind`); everything else in an
// entry is dumped into one trailing `detail` column (rule 4: a preview, not a bespoke grid per kind).
// A cap keeps the row count sane like every other capped table (rule 4).
import * as hub from "../../hub.js";
import { createFloatWin } from "../floatwin.js";
import { VTable } from "../../vtable.js";
import { fmtDateTimeMs } from "../../datefmt.js";

const ROW_CAP = 200;   // a merged preview, not a data grid (rule 4)
const COLS = ["when", "node", "kind", "detail"];
const _HISTORY_SUFFIX = "_history";

// One entry field -> its detail-column text. Arrays/objects (e.g. a gate's per-cond breakdown, a
// router's per-branch list) stringify recursively rather than needing a per-kind formatter.
function fmtVal(v) {
    if (v == null) return "";
    if (Array.isArray(v)) return v.map(fmtVal).join("|");
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
}

// Every OTHER field of one entry, compacted to "key=value key2=value2 …" — generic across every
// history shape, so a new ring's new fields show up automatically with no formatter to write.
function detailOf(e) {
    return Object.keys(e).filter((k) => k !== "ts" && k !== "t")
        .map((k) => `${k}=${fmtVal(e[k])}`).join(" ");
}

// Every ring stamps EITHER `ts` (ISO string — the ring convention) or `t` (epoch seconds — the game
// node's tick-debug entries, which predate the ring convention and were adapted rather than
// reshaped). Both are handled here so a future new-shape ring is one `if` away from fitting in.
function tsOf(e) { return e.ts != null ? Date.parse(e.ts) : (e.t != null ? e.t * 1000 : 0); }
function whenOf(e) { const ms = tsOf(e); return ms ? fmtDateTimeMs(ms) : ""; }

function pushRows(rows, node, kind, entries) {
    for (const e of entries || [])
        rows.push({ when: whenOf(e), node, kind, detail: detailOf(e), _ts: tsOf(e) });
}

// Flatten every history bucket in the latest heartbeat snapshot into one row list, newest first,
// capped at ROW_CAP (rule 4 — dropped rows are simply not shown, this is a live preview).
function flatten(snap) {
    if (!snap) return [];
    const rows = [];
    for (const key in snap) {
        if (!key.endsWith(_HISTORY_SUFFIX)) continue;
        const bucket = snap[key];
        if (!bucket || typeof bucket !== "object") continue;
        const kind = key.slice(0, -_HISTORY_SUFFIX.length);
        for (const id in bucket) pushRows(rows, `${kind}:${id}`, kind, bucket[id]);
    }
    rows.sort((a, b) => b._ts - a._ts);
    return rows.slice(0, ROW_CAP);
}

let vt = null;
let unsub = null;

function render(snap) {
    if (!vt) return;
    vt.setData(COLS, flatten(snap));
}

export function buildNodeLog(state) {
    const win = createFloatWin({
        id: "nodelog", title: "node log", state, span: "bottom", bothAxes: true, autoFit: false,
        resetW: 600,
        onShow: () => {
            if (!vt) vt = new VTable(win.body, "nodelog");
            unsub = hub.subscribe((s) => render(s));
            hub.kick();
        },
        onHide: () => { unsub && unsub(); unsub = null; },
    });
    return win;
}
