// Live-tuning floating panel — master toggle, live stats, per-window detection list, and
// the client read loop / server-collector arm. Extracted from main.js verbatim.
import * as api from "../../api.js";
import * as hub from "../../hub.js";
import { log } from "../../log.js";
import { createFloatWin } from "../floatwin.js";
import { persist } from "../persist.js";
import { $, setStatus, model } from "../state.js";
import { registerWorker, unregisterWorker } from "../workers.js";
import { pc, precapOpen, precapBusy, fmtBytes } from "./precap.js";
import { prevHost, refreshDetect, refreshPreview, setGameGateBadge } from "../imaging.js";
import { refreshLive } from "../main.js";
import { panZoomTo } from "../camera.js";
import { h, svg } from "../../dom.js";
import { bgSetTimeout, bgClearTimeout } from "../../bgtimer.js";
import { fmtTimeSec } from "../../datefmt.js";

let timer = null;
// live floating panel state — declared BEFORE buildLiveWindow() runs at module-eval
// (it reads liveWin/liveWinState), else a `let` TDZ throws and aborts the whole script.
const liveWinState = { visible: false, x: null, y: null, w: null, h: null };
let liveWin = null;
let liveEmpty = null;
// Host adapter: the panel content (liveRoot) mounts into a host (floatwin body in graph view,
// a pretty-widget host in pretty view) and re-parents to whichever is shown. `active` gates
// render the way `liveWinState.visible` used to — independent of which host owns the content.
let A = null;                // current host adapter { host, fit(), nav(id) }
let active = false;          // panel shown -> render allowed
let liveRoot = null;         // the content element, MOVED between hosts (rows survive)
let winAdapter = null;       // floatwin-backed adapter (reclaimed on the panel's onShow)
const liveRows = new Map();    // winId -> { row, dot, name }
const liveRecog = new Map();   // winId -> recognized in the last live detect round?
const liveDetCount = new Map();   // winId -> how many times detected this run (shown per row)

// Live = re-read live-enabled windows continuously (view only, no saving). Saving is a
// deliberate precapture step now. live and precapture are mutually exclusive. The control
// surface is the LIVE floating panel (toggle + stats + per-window detection), built below.
let liveOn = false;
let liveFrames = 0, liveT0 = 0, liveFps = 0;
// "save to datasets" arm (default ON): when live + armed, a SERVER-SIDE collector runs the
// real pipeline (confirm_frames -> dedup -> store -> triggers). When live + disarmed, only
// the read-only client detect/preview loop runs (tuning, no writes).
let liveSave = true;
// Frame limiter (min SECONDS between collector reads) now lives in the SETTINGS modal and is
// persisted server-side; the collector reads it on start. applyLiveInterval() (exported) restarts
// a running collector when the modal changes it, so the new limit takes effect immediately.
let liveColStatus = null;   // latest server collector status (from the heartbeat) while collecting
let liveColUnsub = null;    // hub subscription active while the server collector runs
let liveSawServer = false;  // we've observed the server collector actually running this run (gates the external-stop reflect, so an optimistic pre-start beat can't kill a just-started toggle)
let liveImg = { count: 0, bytes: 0 };   // saved live-image stat (live tuning saves one frame/round)
// Debug log (expandable, below the stats): shows what OCR read, how it was corrected, and what
// was pushed to which dataset. Polled from /api/live/{game}/debug ONLY while expanded (gated poll,
// like precap), reconciled in place (keyed by seq, rule 1), and capped (rule 4).
let dbgOpen = false;        // section expanded?
let dbgTimer = null;        // poll timer while open (null = not polling)
let dbgSeq = 0;             // highest debug seq already rendered (incremental poll cursor)
const dbgRows = new Map();  // seq -> row element, reused across polls
const DBG_CAP = 200;        // max rendered debug rows — a log preview, not a data grid

// ---- live floating panel --------------------------------------------------
// Styled like the tasks panel: a master live toggle, live stats, and a list of every
// live-enabled window with a dot showing whether it's currently detected on screen.
// (State — liveWinState/liveWin/liveRows/… — is declared up by the buildLiveWindow()
// call site so it's initialized before that call runs at module-eval.)

function buildLiveWindow() {
    if (liveWin) return;
    liveWin = createFloatWin({
        id: "live", title: "live", state: liveWinState, bothAxes: true,
        onShow: () => { $("liveBtn")?.classList.toggle("active", true); mountLive(winAdapter); activateLive(); },
        onHide: () => { $("liveBtn")?.classList.toggle("active", false); deactivateLive(); },
        onPersist: () => persist.layout(),
    });
    winAdapter = { host: liveWin.body, fit: () => liveWin.fitHeight(), nav: (id) => panZoomTo(id) };
    mountLive(winAdapter);
    // Standing heartbeat watch (built once): ADOPT a server collector started elsewhere (a pretty
    // live button, another client) so the toggle + worker reflect it, and reflect an EXTERNAL stop.
    // Distinct from liveColUnsub (which mirrors status only while WE run) — this watches the on/off edge.
    hub.subscribe((s) => {
        const running = !!(s && s.live);
        if (running && !liveOn) adoptServerCollect(s);
        else if (!running && liveOn && liveSave && liveSawServer) reflectExternalStop();
        if (active) renderLiveWindow();    // reflect the pacing readout (reconciles in place, rule 1)
    });
}

// Build the content root once, wire its handlers, then (re-)parent it into `adapter.host`.
// Re-parenting moves the intact subtree so the keyed liveRows map stays valid (rule 1).
function mountLive(adapter) {
    if (!adapter) return;
    A = adapter;
    if (!liveRoot) {
        liveRoot = document.createElement("div"); liveRoot.className = "live-root";
        const switchSvg = () =>
            svg("svg", { viewBox: "0 0 28 16", width: "28", height: "16", "aria-hidden": "true" },
                svg("rect", { class: "gt-track", x: "1", y: "1", width: "26", height: "14", rx: "7" }),
                svg("circle", { class: "gt-thumb", cx: "8", cy: "8", r: "5" }));
        liveRoot.replaceChildren(
            h("div", { class: "live-row" },
                h("label", { class: "live-toggle" },
                    h("button", { class: "act-enable live-switch", role: "switch", "aria-checked": "false", title: "enable / disable live mode" },
                        switchSvg()),
                    h("span", { class: "live-switch-lbl" }, "live mode"))),
            h("div", { class: "live-row" },
                h("label", { class: "live-toggle" },
                    h("button", { class: "act-enable live-save", role: "switch", "aria-checked": "true", title: "save reads to datasets (runs the real collector: confirm-frames, dedup, store, triggers)" },
                        switchSvg()),
                    h("span", { class: "live-save-lbl" }, "save to datasets"))),
            h("div", { class: "live-wins" }),
            // Live stats sit BELOW the window list as fixed rows with "–" placeholders, so the
            // panel height is identical whether live mode is on or off (no jump on enable).
            h("div", { class: "live-statbox" },
                h("div", { class: "live-row" },
                    h("span", { class: "live-int-lbl", title: "the OCR-worthy phase being read right now (window/state), or idle when the worthiness gate is closed" }, "phase"),
                    h("span", { class: "live-statval live-stat-phase muted" }, "–")),
                h("div", { class: "live-row" },
                    h("span", { class: "live-int-lbl", title: "records added/updated this run" }, "saved"),
                    h("span", { class: "live-statval live-stat-saved muted" }, "–")),
                h("div", { class: "live-row" },
                    h("span", { class: "live-int-lbl", title: "collector rate (armed) or client image rate (tuning)" }, "rate"),
                    h("span", { class: "live-statval live-stat-rate muted" }, "–")),
                h("div", { class: "live-row" },
                    h("span", { class: "live-int-lbl", title: "visible row-index span (mirror datasets only)" }, "rows"),
                    h("span", { class: "live-statval live-stat-rows muted" }, "–"))),
            h("div", { class: "live-row live-imgs" },
                h("span", { class: "live-imgstat muted" }, " "),
                h("button", { class: "live-clear", dataset: { armed: "0" }, title: "delete every saved live image" }, "clear")),
            // Expandable debug log — collapsed by default; when open it polls the server's debug
            // ring and shows, per OCR-heavy tick, every field's raw text -> resolved value (marking
            // corrections) plus what was written to which dataset.
            h("div", { class: "live-debug" },
                h("button", { class: "live-dbg-head", title: "per-tick OCR reads, corrections, and dataset writes (polls only while open)" },
                    h("span", { class: "live-dbg-chev" }, "▸"),
                    h("span", { class: "live-dbg-title" }, "debug log"),
                    h("span", { class: "live-dbg-clear", role: "button", title: "clear the debug view" }, "clear")),
                h("div", { class: "live-dbg-body", hidden: true },
                    h("div", { class: "live-dbg-empty muted" }, "waiting for reads…"),
                    h("div", { class: "live-dbg-list" }))));
        liveEmpty = document.createElement("div"); liveEmpty.className = "act-empty"; liveEmpty.textContent = "no live-enabled windows";
        // click a window row -> navigate to its window node on the graph (no-op in pretty)
        liveRoot.querySelector(".live-wins").addEventListener("click", (ev) => {
            if (ev.target.closest("button, input")) return;
            const row = ev.target.closest(".live-win[data-node]");
            if (row) A?.nav?.(row.dataset.node);
        });
        liveRoot.querySelector(".live-switch").addEventListener("click", () => setLiveMode(!liveOn));
        liveRoot.querySelector(".live-save").addEventListener("click", () => setLiveSave(!liveSave));
        // clear saved live images — armed two-click (no blocking confirm)
        const clr = liveRoot.querySelector(".live-clear");
        clr.addEventListener("click", () => {
            if (clr.dataset.armed !== "1") { clr.dataset.armed = "1"; clr.textContent = "sure?"; setTimeout(() => { if (clr.dataset.armed === "1") { clr.dataset.armed = "0"; clr.textContent = "clear"; } }, 2500); return; }
            clr.dataset.armed = "0"; clr.textContent = "clear";
            if (model.profile.name) api.liveCaptures.clear(model.profile.name).then((s) => { liveImg = s; renderLiveWindow(); }).catch((e) => log(`clear live images failed: ${e.message || e}`, "err"));
        });
        if (model.profile.name) api.liveCaptures.stats(model.profile.name).then((s) => { liveImg = s; renderLiveWindow(); }).catch(() => {});
        // debug log: header toggles the section (and starts/stops its gated poll); clear wipes
        // the rendered view without touching the server ring (a fresh poll re-fills from `after`).
        liveRoot.querySelector(".live-dbg-head").addEventListener("click", (ev) => {
            if (ev.target.closest(".live-dbg-clear")) { clearDebugView(); return; }
            setDebugOpen(!dbgOpen);
        });
    }
    if (liveRoot.parentElement !== adapter.host) adapter.host.appendChild(liveRoot);
}

// Panel shown: pull a fresh saved-image count + render + fit (after layout/fonts settle).
function activateLive() {
    active = true;
    refreshLiveImgStat(true);   // re-pull the saved-image count: it may be stale (fetched before a profile loaded, or frames saved while hidden)
    renderLiveWindow();
    if (dbgOpen) startDebugPoll();   // resume the debug poll if the section was left open
    requestAnimationFrame(() => fitLivePanelHeight());
    document.fonts?.ready?.then(() => { if (active) fitLivePanelHeight(); });
}
function deactivateLive() { active = false; stopDebugPoll(); }   // hidden panel polls nothing

// ---- debug log -------------------------------------------------------------
// Expandable section below the stats. Polls the server debug ring ONLY while open (gated, like
// precap), reconciles rows in place (keyed by seq, rule 1), and caps the rendered rows (rule 4).

function setDebugOpen(on) {
    dbgOpen = on;
    const body = liveRoot?.querySelector(".live-dbg-body");
    const chev = liveRoot?.querySelector(".live-dbg-chev");
    if (body) body.hidden = !on;
    if (chev && chev.textContent !== (on ? "▾" : "▸")) chev.textContent = on ? "▾" : "▸";
    if (on) startDebugPoll(); else stopDebugPoll();
    fitLivePanelHeight();
}

function startDebugPoll() {
    if (dbgTimer || !active) return;
    pollDebug();   // immediate first pull, then a gated cadence
}
function stopDebugPoll() {
    if (dbgTimer) { bgClearTimeout(dbgTimer); dbgTimer = null; }
}

function pollDebug() {
    dbgTimer = null;
    const game = model.profile.name;
    if (!dbgOpen || !active || !game) return;
    api.live.debug(game, dbgSeq).then((r) => {
        if (r && r.entries && r.entries.length) renderDebugEntries(r.entries);
    }).catch(() => {}).finally(() => {
        // keep polling while open — on bgtimer so a backgrounded tab still ticks (like liveTick)
        if (dbgOpen && active) dbgTimer = bgSetTimeout(pollDebug, 700);
    });
}

// Clear the rendered view only (server ring untouched). Next poll re-fills from the current seq.
function clearDebugView() {
    dbgRows.clear();
    const list = liveRoot?.querySelector(".live-dbg-list");
    if (list) list.replaceChildren();
    const empty = liveRoot?.querySelector(".live-dbg-empty");
    if (empty) empty.hidden = false;
    fitLivePanelHeight();
}

// Reconcile new debug entries into the list. Newest at TOP (prepend). Keyed by seq so a re-poll
// never duplicates a row; capped at DBG_CAP (oldest rows dropped) so the DOM stays a preview.
function renderDebugEntries(entries) {
    const list = liveRoot?.querySelector(".live-dbg-list");
    if (!list) return;
    const empty = liveRoot?.querySelector(".live-dbg-empty");
    if (empty && !empty.hidden) empty.hidden = true;
    // entries arrive oldest-first; prepend each so the newest ends up on top.
    for (const e of entries) {
        if (e.seq > dbgSeq) dbgSeq = e.seq;
        if (dbgRows.has(e.seq)) continue;
        const row = buildDebugRow(e);
        dbgRows.set(e.seq, row);
        list.insertBefore(row, list.firstChild || null);
    }
    // cap: drop the oldest (lowest seq) rows beyond DBG_CAP
    if (dbgRows.size > DBG_CAP) {
        const seqs = [...dbgRows.keys()].sort((a, b) => a - b);
        for (const s of seqs.slice(0, dbgRows.size - DBG_CAP)) {
            dbgRows.get(s)?.remove();
            dbgRows.delete(s);
        }
    }
    fitLivePanelHeight();
}

// One debug entry: a header (time · window/state · write summary) and a per-read list showing
// each field's raw OCR text -> resolved value, flagging corrected fields.
function buildDebugRow(e) {
    const phase = e.state ? `${e.window}/${e.state}` : (e.window || "?");
    const wrote = e.new ? `+${e.new}${e.dataset ? " → " + e.dataset : ""}` : "";
    const head = h("div", { class: "live-dbg-row-head" },
        h("span", { class: "live-dbg-time" }, fmtTimeSec(e.t * 1000)),
        h("span", { class: "live-dbg-phase" }, phase),
        h("span", { class: "live-dbg-wrote" + (e.new ? " wrote" : "") }, wrote || `${e.kept ?? 0}/${e.read ?? 0} read`));
    const reads = (e.reads || []).map((rd) => {
        const cor = new Set(rd.corrected || []);
        const parts = Object.entries(rd.values).map(([fid, val]) => {
            const raw = rd.raw?.[fid];
            const shownVal = val === null || val === undefined ? "∅" : String(val);
            const corrected = cor.has(fid);
            // raw -> value only when they differ (or the field was corrected); else just the value
            const changed = corrected || (raw != null && String(raw) !== shownVal);
            return h("span", { class: "live-dbg-fld" + (corrected ? " cor" : "") },
                h("span", { class: "live-dbg-fid" }, fid + ":"),
                changed && raw != null ? h("span", { class: "live-dbg-raw" }, String(raw)) : null,
                changed && raw != null ? h("span", { class: "live-dbg-arrow" }, "→") : null,
                h("span", { class: "live-dbg-val" }, shownVal));
        });
        return h("div", { class: "live-dbg-read" }, ...parts);
    });
    return h("div", { class: "live-dbg-row" }, head, ...reads);
}

// Apply a frame-limiter change made in the settings modal: restart a running server collector so
// the new (already-persisted) limit takes effect immediately. No-op when not collecting.
async function applyLiveInterval(seconds) {
    if (liveOn && liveSave) { await stopServerCollect(); startServerCollect(); }
    log(`live frame limit set (${seconds ? Math.round(seconds * 1000) + "ms" : "fastest"})`);
}

function renderLiveWindow() {
    if (!liveRoot || !active) return;
    // sync the visual `.on` class INDEPENDENTLY of aria-checked — the markup ships
    // aria-checked already matching the default, so gating the class on an aria mismatch left
    // a default-on switch (save-to-datasets) visually off. Each touched only when it differs.
    const syncSwitch = (el, on) => {
        if (!el) return;
        if (el.getAttribute("aria-checked") !== String(on)) el.setAttribute("aria-checked", String(on));
        if (el.classList.contains("on") !== on) el.classList.toggle("on", on);
    };
    syncSwitch(liveRoot.querySelector(".live-switch"), liveOn);
    syncSwitch(liveRoot.querySelector(".live-save"), liveSave);
    // Stats render as fixed rows below the window list; "–" placeholder when off so height holds.
    // collecting (armed): show what the server collector saved; tuning (disarmed): client img rate.
    const collecting = liveOn && liveSave;
    // mirror datasets report the current visible row-index span [vlo,vhi] + calibration -> show live
    const sc = collecting ? liveColStatus?.scroll : null;
    const scm = collecting ? liveColStatus?.scroll_meta : null;
    const setStat = (cls, txt) => {
        const el = liveRoot.querySelector(cls);
        if (el && el.textContent !== txt) el.textContent = txt;
    };
    // current phase: the window/state being read now, else the REASON we aren't reading — taken
    // from the raw tick status (gate-closed is only ONE of them; no-window is different).
    const win = collecting ? liveColStatus?.window : null;
    const reasonText = { idle: "idle (gate closed)", unrecognised: "no window recognised",
        no_window: "game not found", not_foreground: "window not focused",
        state_invalid: "wrong state", moving: "screen moving" };
    setStat(".live-stat-phase", !collecting ? "–"
        : win ? (liveColStatus.state ? `${win} / ${liveColStatus.state}` : win)
        : (reasonText[liveColStatus?.phase_status] || "idle"));
    const phaseEl = liveRoot.querySelector(".live-stat-phase");
    // same scheme as the gate verdict: reading a phase = green, idle = amber, off = muted
    const phaseCls = "live-statval live-stat-phase " + (win ? "conf-ok" : collecting ? "conf-warn" : "muted");
    if (phaseEl && phaseEl.className !== phaseCls) phaseEl.className = phaseCls;
    setStat(".live-stat-saved", collecting ? String(liveColStatus?.written ?? 0) : "–");
    setStat(".live-stat-rate",
        collecting ? `${(liveColStatus?.fps ?? 0).toFixed(1)}/s`
        : liveOn ? `${liveFps.toFixed(1)} img/s` : "–");
    setStat(".live-stat-rows", sc
        ? `${Math.round(sc[0])}–${Math.round(sc[1])}${scm && scm.total ? ` / ${Math.round(scm.total)}` : ""}`
        : "–");
    // saved-live-image stat (touch DOM only on change)
    const ist = liveRoot.querySelector(".live-imgstat");
    const itxt = liveImg.count ? `${liveImg.count} imgs · ${fmtBytes(liveImg.bytes)}` : "";
    if (ist && ist.textContent !== itxt) ist.textContent = itxt;
    const clrBtn = liveRoot.querySelector(".live-clear");
    if (clrBtn) clrBtn.hidden = !liveImg.count;   // nothing saved -> hide clear
    const clr = liveRoot.querySelector(".live-clear");
    if (clr) clr.disabled = !liveImg.count;
    renderLiveWinList();
    fitLivePanelHeight();
}

// Reconcile the live-enabled window list in place (keyed Map, no innerHTML per tick).
function renderLiveWinList() {
    const list = liveRoot?.querySelector(".live-wins");
    if (!list) return;
    const wins = (model.profile.windows || []).filter((w) => w.live !== false);
    const want = new Set(wins.map((w) => w.id));
    for (const [id, r] of liveRows) if (!want.has(id)) { r.row.remove(); liveRows.delete(id); }
    if (!wins.length) { if (!liveEmpty.isConnected) list.appendChild(liveEmpty); return; }
    if (liveEmpty.isConnected) liveEmpty.remove();
    let i = 0;
    for (const w of wins) {
        let r = liveRows.get(w.id);
        if (!r) {
            const row = document.createElement("div"); row.className = "act-row live-win";
            row.dataset.node = `win:${w.id}`; row.title = "go to this window's node";
            const dot = document.createElement("span"); dot.className = "live-wdot";
            const name = document.createElement("div"); name.className = "act-title";
            const cnt = document.createElement("span"); cnt.className = "live-wcount";   // detections, right-justified
            row.append(dot, name, cnt);
            r = { row, dot, name, cnt }; liveRows.set(w.id, r);
        }
        const at = list.children[i];
        if (at !== r.row) list.insertBefore(r.row, at || null);
        i++;
        if (r.name.textContent !== w.id) r.name.textContent = w.id;
        const det = liveOn && !!liveRecog.get(w.id);
        if (r.dot.classList.contains("on") !== det) r.dot.classList.toggle("on", det);
        const dt = det ? "detected" : (liveOn ? "not detected yet" : "live off");
        if (r.dot.title !== dt) r.dot.title = dt;
        const n = liveDetCount.get(w.id) || 0;          // how many times detected this run
        const ctxt = n ? `${n}×` : "";
        if (r.cnt.textContent !== ctxt) r.cnt.textContent = ctxt;
        if (r.cnt.title !== `detected ${n}×`) r.cnt.title = `detected ${n}×`;
    }
}

// Auto-fit delegates to the host adapter (floatwin height-fit in graph; no-op in a pretty widget).
function fitLivePanelHeight() { A?.fit?.(); }

function showLiveStats(on) {
    liveFrames = 0; liveT0 = on ? performance.now() : 0; liveFps = 0;
    renderLiveStats();
}
function renderLiveStats() {
    const now = performance.now();
    if (liveT0 && now - liveT0 >= 1000) {            // recompute rate over a ~1s window
        liveFps = (liveFrames * 1000) / (now - liveT0);
        liveFrames = 0; liveT0 = now;
    }
    renderLiveWindow();   // stats + detection dots now live only in the live panel
}

// Self-paced: a round AWAITS its detect+preview before the next is scheduled, so live
// mode adapts to how fast OCR actually is and never piles requests on the OCR queue
// (a fixed interval would stack them until each took tens of seconds). Iterates every
// LIVE-ENABLED window (not just the ones with an open image) — detect captures its own frame.
async function liveTick() {
    if (!liveOn || liveSave) return;   // client tuning loop only runs in read-only (disarmed) mode
    refreshLive();   // dataset counts
    const game = model.profile.name;
    if (game) {
        let anyDet = false;   // did ANY live window detect this round? gates the frame save
        for (const w of model.profile.windows || []) {
            if (!liveOn || liveSave) break;
            if (w.live === false || w.enabled === false) continue;   // skip windows opted out of live
            await refreshDetect(w.id, true);   // sets liveRecog + refreshes the panel
            if (liveRecog.get(w.id)) anyDet = true;
            liveFrames++;
            if (prevHost(w.id)?.dataset.ran === "1") await refreshPreview(w.id, true);
        }
        // save what live mode sees ONLY when a window was actually detected — don't bucket blank
        // grabs. one frame per detecting round (fire-and-forget; a capture failure mustn't stall
        // tuning). grab returns the running {count,bytes}.
        if (anyDet) api.liveCaptures.grab(game).then((s) => { liveImg = s; }).catch((e) => log(`live grab failed: ${e.message || e}`, "err"));
        renderLiveStats();   // recompute fps + refresh the panel after the round
    }
    // Schedule via the worker-backed timer so the tuning loop keeps ticking when the tab is
    // backgrounded (a plain setTimeout would clamp to ~1/min while hidden — exactly when you tune
    // against the foregrounded game). The round body still runs on the main thread (fetch + canvas).
    if (liveOn && !liveSave) timer = bgSetTimeout(liveTick, 200);   // next round only AFTER this one drained
}

// Server-side collector (the real pipeline): started when live + save are both on. The
// heartbeat carries its status; we mirror recognized windows into liveRecog for the dots.
// Subscribe to the heartbeat and mirror the server collector's status into the panel. Used
// both when STARTING a collector and when ADOPTING one that's already running (page reload).
function subscribeCollector() {
    if (liveColUnsub) return;
    liveColUnsub = hub.subscribe((s) => {
        if (!liveOn || !liveSave) return;
        liveColStatus = s.live || null;
        if (liveColStatus) liveSawServer = true;   // confirmed running -> external-stop reflect may now fire
        liveRecog.clear(); liveDetCount.clear();
        for (const r of (liveColStatus?.recognized || [])) {   // cumulative tally → per-window count
            if (!r.miss && r.key.includes("/")) {
                const wid = r.key.split("/")[0];
                liveDetCount.set(wid, (liveDetCount.get(wid) || 0) + (r.count || 0));
            }
        }
        // dot reflects what's detected RIGHT NOW (the current tick's window), NOT the cumulative
        // tally — else a window detected once stays green for the whole run after it left screen.
        if (liveColStatus?.window) liveRecog.set(liveColStatus.window, true);
        // game node worthiness badge: live phase from the server collector (● collecting / ◯ waiting)
        setGameGateBadge(liveColStatus?.gated ? !!liveColStatus.phase : null);
        refreshLiveImgStat();   // server collector saves frames to disk — keep the saved-image stat fresh
        renderLiveWindow();
    });
}

function startServerCollect() {
    const game = model.profile.name;
    if (!game) return;
    liveColStatus = null;
    liveSawServer = false;   // not yet observed running -> don't let the pre-start beat reflect a stop
    // Optimistic beat for instant "starting" feedback, then an AUTHORITATIVE beat once the server
    // has actually started: the immediate kick races the worker and usually reads live=false, which
    // would schedule the hub at IDLE cadence (~3s) — so activity:live-gated elements lagged badly.
    // Requesting a beat on resolution flips them as soon as the worker is up.
    api.live.start(game, null).then(() => hub.kick()).catch((e) => setStatus(String(e.message || e)));   // null => server uses the persisted frame limiter
    subscribeCollector();
    hub.kick();   // beat now so collection status shows immediately
}

// Page reload while a server collector is mid-run: the LiveSession survives on the SERVER, but
// the freshly-booted client has liveOn=false so the toggle reads "off" while collection runs.
// Re-query status and ADOPT the running collector (subscribe to the heartbeat WITHOUT restarting
// it) so the UI reflects reality. Only the armed/server path is recoverable — the read-only
// tuning loop is purely client-side and leaves no server state to resume.
async function syncLiveFromServer() {
    const game = model.profile.name;
    if (!game || liveOn) return;   // already on (user toggled before sync landed) → leave it
    let st;
    try { st = await api.live.status(game); } catch { return; }
    if (!st?.running || liveOn) return;   // re-check liveOn: the await may have raced a user toggle
    liveOn = true; liveSave = true; liveSawServer = true;
    liveColStatus = st;
    registerWorker("live", "live collection", () => setLiveMode(false));
    showLiveStats(true);
    subscribeCollector();
    hub.kick();
    renderLiveWindow();   // reflect the adopted toggle
}
// Adopt a server collector observed running on the heartbeat (started by another client / a pretty
// live button) — flip the toggle + register the worker WITHOUT restarting it. Like syncLiveFromServer
// but driven off a live snapshot, not a fresh status fetch.
function adoptServerCollect(s) {
    if (liveOn) return;
    const lv = s && s.live;
    liveOn = true; liveSave = true; liveSawServer = true;
    liveColStatus = lv || null;
    registerWorker("live", "live collection", () => setLiveMode(false));
    showLiveStats(true);
    subscribeCollector();
    log("live collection adopted", "run");
    renderLiveWindow();
}

// Reflect an EXTERNAL stop (the server collector we were tracking is no longer running) — drop the
// toggle + worker locally without issuing another stop (the server is already stopped).
function reflectExternalStop() {
    liveOn = false; liveSawServer = false;
    if (timer) { bgClearTimeout(timer); timer = null; }
    liveRecog.clear(); liveDetCount.clear();
    if (liveColUnsub) { liveColUnsub(); liveColUnsub = null; }
    liveColStatus = null;
    unregisterWorker("live");
    showLiveStats(false);
    log("live mode stopped (external)");
    renderLiveWindow();
}

// Throttled saved-image stat refresh — the heartbeat fires often, but stat() globs the live/
// dir, so re-fetch at most every ~5s. Without this the armed (server-collector) path never
// refreshes liveImg and the panel reads "no live images saved" while frames pile up on disk.
let liveImgStatT0 = 0;
function refreshLiveImgStat(force = false) {
    const game = model.profile.name;
    if (!game) return;
    const now = performance.now();
    if (!force && liveImgStatT0 && now - liveImgStatT0 < 5000) return;
    liveImgStatT0 = now;
    api.liveCaptures.stats(game).then((s) => { liveImg = s; renderLiveWindow(); }).catch(() => {});
}
function stopServerCollect() {
    const game = model.profile.name;
    if (liveColUnsub) { liveColUnsub(); liveColUnsub = null; }
    // the server stop joins the worker before responding -> await this before any restart so a
    // re-arm (e.g. an interval change) can't race the teardown and leave collection stopped.
    const done = game ? api.live.stop(game).catch((e) => log(`live stop failed: ${e.message || e}`) || null) : Promise.resolve();
    liveColStatus = null;
    liveSawServer = false;   // teardown -> the watcher must re-observe before reflecting another stop
    refreshLiveImgStat(true);   // final count after the run stops
    hub.kick();                       // optimistic beat
    done.then(() => hub.kick());      // authoritative beat once the worker is joined and live reads false
    return done;
}

function setLiveMode(on) {
    // Mutually exclusive with precapture, but only the WORKER actually competes for OCR — a
    // merely-open (idle) precap panel doesn't. Block live while precap is busy; otherwise just
    // close the idle precap panel and proceed (don't silently no-op like before).
    if (on && precapBusy) { setStatus("precapture is running — stop it before live mode"); renderLiveWindow(); return; }
    if (on && precapOpen) pc.setVisible(false);   // idle precap panel open → close it (one OCR consumer at a time)
    if (on === liveOn) { renderLiveWindow(); return; }   // no change → don't double-start; keep the switch in sync
    liveOn = on;
    hub.setLiveActive(on);   // keep the heartbeat FAST while live runs, even with the tab unfocused
    if (timer) { bgClearTimeout(timer); timer = null; }
    if (!on) { liveRecog.clear(); liveDetCount.clear(); }   // drop stale dots + counts
    showLiveStats(on);
    if (on) {
        log(liveSave ? "live collection started" : "live mode started (read-only)", "run");
        registerWorker("live", liveSave ? "live collection" : "live view", () => setLiveMode(false));
        if (liveSave) startServerCollect(); else liveTick();   // armed → server collector; else client tuning loop
    } else {
        log("live mode stopped");
        unregisterWorker("live");
        stopServerCollect();   // harmless if not running
    }
    renderLiveWindow();   // reflect the toggle + cleared dots
}

// Arm/disarm saving. While live is on, this swaps between the server collector (armed) and
// the client tuning loop (disarmed) without leaving live mode.
function setLiveSave(on) {
    if (on === liveSave) return;
    liveSave = on;
    if (liveOn) {
        if (timer) { bgClearTimeout(timer); timer = null; }   // stop the client loop either way
        if (on) { stopServerCollect().then(startServerCollect); }   // await teardown, then (re)start
        else { stopServerCollect(); liveTick(); }                  // back to read-only tuning
        registerWorker("live", on ? "live collection" : "live view", () => setLiveMode(false));
        log(on ? "live saving armed" : "live saving disarmed", on ? "run" : undefined);
    }
    renderLiveWindow();
}

export {
    liveWin, liveWinState, liveRecog, liveDetCount,
    buildLiveWindow, mountLive, activateLive, deactivateLive,
    renderLiveWindow, renderLiveWinList, fitLivePanelHeight,
    showLiveStats, renderLiveStats, liveTick, startServerCollect, stopServerCollect,
    setLiveMode, setLiveSave, syncLiveFromServer, applyLiveInterval,
};
