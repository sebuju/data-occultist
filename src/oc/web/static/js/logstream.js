// Server activity-log stream -> the bottom log bar. The backend (oc.eventlog) publishes one
// line per trigger watch/fire and per external API fetch (warframe.market); this pipes them
// into log() so they show without devtools open.
//
// NO own EventSource: log lines are multiplexed on the ONE shared dsevents stream (its `log`
// channel) so the page holds a single SSE socket — a second always-on stream permanently eats
// one of the browser's ~6 per-host connections and starves plain GETs (the window image). The
// shared bus owns reconnect + the ?after= seq cursor + cross-reconnect dedup; here we just point
// it at the game and fan its log events into the log bar.
import { log } from "./log.js";
import * as dsevents from "./graph/dsevents.js";
import * as profileAlert from "./profile_alert.js";

let unsub = null;

export function openLogStream(game) {
    closeLogStream();
    profileAlert.clearIssues();   // drop the previous game's stale banner, if any
    if (!game) return;
    dsevents.setGame(game);   // ensure the shared stream is pointed at the game (idempotent)
    unsub = dsevents.subscribeLog((ev) => {
        log(ev.msg, ev.level || "info");
        if (ev.kind === "profile_check") profileAlert.reportIssue(ev);
    });
}

export function closeLogStream() {
    if (unsub) { unsub(); unsub = null; }
}
