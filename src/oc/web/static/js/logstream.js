// Server activity-log stream -> the bottom log bar. The backend (oc.eventlog) publishes one
// line per trigger watch/fire and per external API fetch (warframe.market); this pipes them
// into log() so they show without devtools open. The server stream is short-lived (it closes
// its window periodically); we reconnect and pass the last seq we saw so the backfill skips
// lines already shown (and survives reconnects without dupes).
import { log } from "./log.js";

let es = null;
let lastSeq = 0;
let curGame = null;
let retry = null;

function connect() {
    if (!curGame) return;
    try {
        es = new EventSource(`/api/log/${encodeURIComponent(curGame)}?after=${lastSeq}`);
        es.addEventListener("log", (e) => {
            let ev; try { ev = JSON.parse(e.data); } catch { return; }
            if (ev.seq && ev.seq <= lastSeq) return;   // dedup across reconnects / backfill overlap
            if (ev.seq) lastSeq = ev.seq;
            log(ev.msg, ev.level || "info");
        });
        // a clean server-side window close (or a transient drop) surfaces as `error`; recreate the
        // source so the ?after= cursor stays fresh instead of letting EventSource refetch from 0.
        es.addEventListener("error", () => {
            if (es) { es.close(); es = null; }
            clearTimeout(retry); retry = setTimeout(connect, 1500);
        });
    } catch { /* no EventSource -> server log mirroring simply off */ }
}

export function openLogStream(game) {
    closeLogStream();
    curGame = game || null;
    if (curGame) connect();
}

export function closeLogStream() {
    clearTimeout(retry); retry = null;
    if (es) { es.close(); es = null; }
    curGame = null;
}
