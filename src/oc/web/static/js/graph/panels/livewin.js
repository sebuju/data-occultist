// Live-tuning floating panel — master toggle, live stats, per-window detection list, and
// the client read loop / server-collector arm. Extracted from main.js verbatim.
import * as api from "../../api.js";
import * as hub from "../../hub.js";
import { log } from "../../log.js";
import { createFloatWin } from "../floatwin.js";
import { persist } from "../persist.js";
import { $, setStatus, model, readoutPreview } from "../state.js";
import { registerWorker, unregisterWorker } from "../workers.js";
import { pc, precapOpen, precapBusy } from "./precap.js";
import { fmtBytes } from "../../bytefmt.js";
import { prevHost, refreshDetect, refreshPreview } from "../imaging.js";
import { refreshLive } from "../main.js";
import { panZoomTo } from "../camera.js";
import { h, svg } from "../../dom.js";
import { confTier } from "../conf.js";
import { bgSetTimeout, bgClearTimeout } from "../../bgtimer.js";
import { sessLabel, sessMeta } from "./live_sess.js";

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
// "save all images" arm (default OFF): when on, the server collector saves EVERY OCR-due grab to
// the live/ image bucket, not only the frames that wrote a record. Rides the collector, so a mid-
// run toggle restarts it (like the frame limiter / save arm). Read-only tuning mode is unaffected.
let liveSaveRecog = false;
// "feed saved images" arm (default OFF): replay the game's saved live/ images through the SERVER
// collector instead of live capture, paced server-side by their timestamps. Always runs the armed
// collector (it writes records); saves no images while feeding. Auto-stops when all images are fed
// (the session reads not-running -> reflectExternalStop drops the toggle). Disabled when the live/
// bucket is empty (nothing to feed).
let liveFeed = false;
// Saved live sessions (one per live-capture start), newest first, and which one the feed replays.
// Refreshed alongside the saved-image stat; liveFeedSess defaults to the newest session and is
// re-pinned when the selected one disappears (flushed) — "" means "let the server pick the newest".
let liveSessions = [];
let liveFeedSess = "";
// Frame limiter (min SECONDS between collector reads) now lives in the SETTINGS modal and is
// persisted server-side; the collector reads it on start. applyLiveInterval() (exported) restarts
// a running collector when the modal changes it, so the new limit takes effect immediately.
let liveColStatus = null;   // latest server collector status (from the heartbeat) while collecting
// Last non-null collector status, kept AFTER live stops so the stat rows freeze on their final
// values instead of blanking to "–" (user: don't clear live stats when exiting live mode). Updated
// each beat while collecting; never cleared on stop. A fresh start overwrites it on its first beat.
let liveStatsLast = null;
let liveColUnsub = null;    // hub subscription active while the server collector runs
let liveSawServer = false;  // we've observed the server collector actually running this run (gates the external-stop reflect, so an optimistic pre-start beat can't kill a just-started toggle)
let liveStopping = false;   // user-initiated stop in flight: suppress ADOPT of stale "running" beats until a beat confirms the server actually stopped (worker join is up to 5s)
let liveImg = { count: 0, bytes: 0 };   // saved live-image stat (live tuning saves one frame/round)
// Two collapsible sections (stats + sessions) built on the shared `collapsible()` primitive; refs
// stashed so their toggles reconcile chevron/body without re-querying (stats open by default). The
// old OCR-log section lived here too (polled /api/live/{game}/debug) — replaced by the game node's
// "gamehistory" satellite (game_history_node.js), which rides the activity heartbeat like every
// other node's history instead of its own bespoke poll.
let statsOpen = true;
let statsChev = null, statsBody = null;
// Sessions collapsible (closed by default): saved live sessions as chips (click = play/switch
// feed, click the feeding one = stop) plus the saved-image stat + flush. Tucked at the bottom
// so the panel's top stays the live/save toggles only.
let sessOpen = false;
let sessChev = null, sessBody = null;
const chipRows = new Map();   // sessionId -> { row, name, meta } — reconciled like liveRows (rule 1)

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
        if (!running) liveStopping = false;   // server confirmed stopped -> future external starts may adopt again
        if (running && !liveOn && !liveStopping) adoptServerCollect(s);
        else if (!running && liveOn && (liveSave || liveFeed) && liveSawServer) reflectExternalStop();
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
            h("div", { class: "live-row" },
                h("label", { class: "live-toggle" },
                    h("button", { class: "act-enable live-saverecog", role: "switch", "aria-checked": "false", title: "save one image per OCR-due grab whose frame matched a window (any recognised window/state), not just frames that wrote a record — debug aid, off by default" },
                        switchSvg()),
                    h("span", { class: "live-saverecog-lbl" }, "save live session"))));
        // Stats collapsible (open by default): live-run readouts as fixed rows with placeholders so
        // the height is stable whether live is on or off. Boxed body, styled like the OCR log below.
        const stats = collapsible({ title: "stats", open: statsOpen, bodyClass: "live-statbox", headTitle: "live run stats (phase / saved / rate / rows)" });
        statsChev = stats.chev; statsBody = stats.body;
        stats.body.append(
            h("div", { class: "live-row" },
                h("span", { class: "live-int-lbl", title: "the window/state being read right now, or the reason we're not reading (throttled / no window / not recognised)" }, "phase"),
                h("span", { class: "live-statval live-stat-phase muted" }, "–")),
            h("div", { class: "live-row" },
                h("span", { class: "live-int-lbl", title: "records added/updated this run" }, "saved"),
                h("span", { class: "live-statval live-stat-saved muted" }, "–")),
            h("div", { class: "live-row" },
                h("span", { class: "live-int-lbl", title: "collector rate (armed) or client image rate (tuning)" }, "rate"),
                h("span", { class: "live-statval live-stat-rate muted" }, "–")),
            h("div", { class: "live-row" },
                h("span", { class: "live-int-lbl", title: "visible row-index span (mirror datasets only)" }, "rows"),
                h("span", { class: "live-statval live-stat-rows muted" }, "–")),
            h("div", { class: "live-row live-feed-row" },
                h("span", { class: "live-int-lbl", title: "replay progress: images fed / total, and the wait to the next image" }, "feed"),
                h("span", { class: "live-statval live-stat-feed muted" }, "–"),
                h("button", { class: "live-feed-skip", hidden: true, title: "skip to the next image now" }, "skip")),
            // faint separator, then the per-window detection list — one line each (dot folded into
            // the id label, detection count right-aligned like the stat values above).
            h("div", { class: "bdivider" }),
            h("div", { class: "live-wins" }));
        // Sessions collapsible -- collapsed by default; holds saved-session chips (click = play a
        // feed / switch to a different session / click the feeding one to stop) plus the
        // saved-image stat + flush. Placed LAST so the always-visible top of the panel stays the
        // live/save toggles.
        const sess = collapsible({ title: "sessions", open: sessOpen, bodyClass: "live-dbg-body", headTitle: "saved live sessions — click to feed, click again to stop" });
        sessChev = sess.chev; sessBody = sess.body;
        sess.body.append(
            h("div", { class: "live-chips pc-sess-rows" }),
            h("div", { class: "live-row live-imgs" },
                h("span", { class: "live-imgstat muted" }, " "),
                h("button", { class: "live-clear", dataset: { armed: "0" }, title: "delete every saved live image" }, "flush")));
        liveRoot.append(stats.section, sess.section);
        liveEmpty = document.createElement("div"); liveEmpty.className = "act-empty"; liveEmpty.textContent = "no live-enabled windows";
        // click a window row -> navigate to its window node on the graph (no-op in pretty)
        liveRoot.querySelector(".live-wins").addEventListener("click", (ev) => {
            if (ev.target.closest("button, input")) return;
            const row = ev.target.closest(".live-win[data-node]");
            if (row) A?.nav?.(row.dataset.node);
        });
        liveRoot.querySelector(".live-switch").addEventListener("click", () => setLiveMode(!liveOn));
        liveRoot.querySelector(".live-save").addEventListener("click", () => setLiveSave(!liveSave));
        liveRoot.querySelector(".live-saverecog").addEventListener("click", () => setLiveSaveRecog(!liveSaveRecog));
        // click a session row: feed it (starting or switching), or stop it if it's already feeding
        liveRoot.querySelector(".live-chips").addEventListener("click", (ev) => {
            const row = ev.target.closest(".pc-sess");
            if (row) feedSession(row.dataset.sid);
        });
        // skip the replay to the next image now (feed mode) — kick the heartbeat so the readout
        // reflects the jump without waiting for the next beat.
        liveRoot.querySelector(".live-feed-skip").addEventListener("click", () => {
            const game = model.profile.name;
            if (game) api.live.feedSkip(game).then(() => hub.kick()).catch((e) => log(`feed skip failed: ${e.message || e}`, "err"));
        });
        // clear saved live images -- armed two-click (no blocking confirm)
        const clr = liveRoot.querySelector(".live-clear");
        clr.addEventListener("click", () => {
            if (clr.dataset.armed !== "1") { clr.dataset.armed = "1"; clr.textContent = "sure?"; setTimeout(() => { if (clr.dataset.armed === "1") { clr.dataset.armed = "0"; clr.textContent = "flush"; } }, 2500); return; }
            clr.dataset.armed = "0"; clr.textContent = "flush";
            if (model.profile.name) api.liveCaptures.clear(model.profile.name).then((s) => { liveImg = s; liveSessions = []; renderLiveWindow(); }).catch((e) => log(`clear live images failed: ${e.message || e}`, "err"));
        });
        if (model.profile.name) api.liveCaptures.stats(model.profile.name).then((s) => { liveImg = s; renderLiveWindow(); }).catch(() => {});
        // stats header toggles its section; sessions header toggles its section.
        stats.head.addEventListener("click", () => setStatsOpen(!statsOpen));
        sess.head.addEventListener("click", () => setSessOpen(!sessOpen));
    }
    if (liveRoot.parentElement !== adapter.host) adapter.host.appendChild(liveRoot);
}

// Panel shown: pull a fresh saved-image count + render + fit (after layout/fonts settle).
function activateLive() {
    active = true;
    refreshLiveImgStat(true);   // re-pull the saved-image count: it may be stale (fetched before a profile loaded, or frames saved while hidden)
    renderLiveWindow();
    requestAnimationFrame(() => fitLivePanelHeight());
    document.fonts?.ready?.then(() => { if (active) fitLivePanelHeight(); });
}
function deactivateLive() { active = false; }

// Shared collapsible primitive: a chevron+title header toggling a body. Both the stats section and
// the sessions section are built on this (rule 7) — the caller wires its own click handler and
// reconciles via setCollapsed().
function collapsible({ title, open = true, headExtra = null, headTitle = "", bodyClass = "" }) {
    const chev = h("span", { class: "clps-chev" }, open ? "▾" : "▸");
    const head = h("button", { class: "clps-head", title: headTitle },
        chev, h("span", { class: "clps-title" }, title), headExtra);
    const body = h("div", { class: "clps-body" + (bodyClass ? " " + bodyClass : "") });
    if (!open) body.hidden = true;
    return { section: h("div", { class: "clps" }, head, body), head, body, chev };
}
function setCollapsed(chev, body, on) {
    if (body) body.hidden = !on;
    const c = on ? "▾" : "▸";
    if (chev && chev.textContent !== c) chev.textContent = c;
}

function setStatsOpen(on) {
    statsOpen = on;
    setCollapsed(statsChev, statsBody, on);
    fitLivePanelHeight();
}

function setSessOpen(on) {
    sessOpen = on;
    setCollapsed(sessChev, sessBody, on);
    fitLivePanelHeight();
}

// Apply a frame-limiter change made in the settings modal: restart a running server collector so
// the new (already-persisted) limit takes effect immediately. No-op when not collecting.
async function applyLiveInterval(seconds) {
    if (liveOn && liveSave) { await stopServerCollect(); startServerCollect(); }
    log(`live frame limit set (${seconds ? Math.round(seconds * 1000) + "ms" : "fastest"})`);
}

function renderLiveWindow() {
    syncWpDots();   // game-node priority dots update even when the live PANEL is closed (collector runs via hub)
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
    syncSwitch(liveRoot.querySelector(".live-saverecog"), liveSaveRecog);
    // disable a switch (prop + greyed class), touching the DOM only on a real change (rule 1)
    const setDisabled = (el, off) => {
        if (!el) return;
        if (el.disabled !== off) el.disabled = off;
        if (el.classList.contains("sw-disabled") !== off) el.classList.toggle("sw-disabled", off);
    };
    setDisabled(liveRoot.querySelector(".live-saverecog"), liveFeed);   // no image saving while feeding
    renderLiveChips();
    // Stats render as fixed rows below the window list; "–" placeholder when off so height holds.
    // collecting (armed): show what the server collector saved; tuning (disarmed): client img rate.
    const collecting = liveOn && (liveSave || liveFeed);   // feed runs the server collector too
    if (collecting && liveColStatus) liveStatsLast = liveColStatus;   // remember the last live snapshot
    // Stat source: the live collector while running, else the frozen final snapshot so the numbers
    // stay put after exiting live mode (rather than blanking). `frozen` = stopped but we have one.
    const statSrc = collecting ? liveColStatus : liveStatsLast;
    const frozen = !collecting && !!statSrc;
    // mirror datasets report the current visible row-index span [vlo,vhi] + calibration -> show live
    const sc = (collecting || frozen) ? statSrc?.scroll : null;
    const scm = (collecting || frozen) ? statSrc?.scroll_meta : null;
    const setStat = (cls, txt) => {
        const el = liveRoot.querySelector(cls);
        if (el && el.textContent !== txt) el.textContent = txt;
    };
    // current phase: the window/state being read now, else the REASON we aren't reading — taken
    // from the raw tick status (throttled between OCR slots, no-window, unrecognised, …).
    const win = (collecting || frozen) ? statSrc?.window : null;
    const reasonText = { throttled: "waiting (throttle)", unrecognised: "no window recognised",
        no_window: "game not found", not_foreground: "window not focused",
        state_invalid: "wrong state", moving: "screen moving" };
    setStat(".live-stat-phase", !collecting && !frozen ? "–"
        : win ? (statSrc.state ? `${win} / ${statSrc.state}` : win)
        : (reasonText[statSrc?.phase_status] || "waiting"));
    const phaseEl = liveRoot.querySelector(".live-stat-phase");
    // same scheme as the gate verdict: reading a phase = green, idle = amber, frozen/off = muted
    const phaseCls = "live-statval live-stat-phase " + (win && collecting ? "conf-ok" : collecting ? "conf-warn" : "muted");
    if (phaseEl && phaseEl.className !== phaseCls) phaseEl.className = phaseCls;
    setStat(".live-stat-saved", (collecting || frozen) ? String(statSrc?.written ?? 0) : "–");
    setStat(".live-stat-rate",
        collecting ? `${(liveColStatus?.fps ?? 0).toFixed(1)}/s`
        : liveOn ? `${liveFps.toFixed(1)} img/s`
        : frozen ? `${(statSrc?.fps ?? 0).toFixed(1)}/s` : "–");
    setStat(".live-stat-rows", sc
        ? `${Math.round(sc[0])}–${Math.round(sc[1])}${scm && scm.total ? ` / ${Math.round(scm.total)}` : ""}`
        : "–");
    // feed replay progress: images fed / total (+ wait to the next image), from the collector
    // status (feeding mode only). wait == null => the current image is the last one.
    const feed = (collecting || frozen) ? statSrc?.feed : null;
    const feeding = (collecting || frozen) ? statSrc?.feeding : false;
    let feedTxt = "–";
    if (feed) {
        feedTxt = `${feed.index} / ${feed.total}`;
        if (feeding && collecting && feed.wait != null) feedTxt += ` · ${feed.wait.toFixed(1)}s`;
    }
    setStat(".live-stat-feed", feedTxt);
    const feedStatEl = liveRoot.querySelector(".live-stat-feed");
    const feedStatCls = "live-statval live-stat-feed " + (feeding && collecting ? "conf-ok" : "muted");
    if (feedStatEl && feedStatEl.className !== feedStatCls) feedStatEl.className = feedStatCls;
    // skip button: only while actively feeding AND a next image exists (wait != null)
    const skipBtn = liveRoot.querySelector(".live-feed-skip");
    if (skipBtn) {
        const canSkip = !!(feeding && collecting && feed && feed.wait != null);
        if (skipBtn.hidden !== !canSkip) skipBtn.hidden = !canSkip;
    }
    // saved-live-image stat (touch DOM only on change)
    const ist = liveRoot.querySelector(".live-imgstat");
    const itxt = liveImg.count ? `${liveImg.count} imgs · ${fmtBytes(liveImg.bytes)}` : "";
    if (ist && ist.textContent !== itxt) ist.textContent = itxt;
    const clrBtn = liveRoot.querySelector(".live-clear");
    if (clrBtn) clrBtn.hidden = !liveImg.count;   // nothing saved -> hide clear
    const clr = liveRoot.querySelector(".live-clear");
    // no flush mid-feed: deleting the source images out from under an active replay would break it
    if (clr) clr.disabled = !liveImg.count || (liveFeed && liveOn);
    renderLiveWinList();
    renderReadoutValues();
    fitLivePanelHeight();
}

// Fill each readout node's `.ro-live` span with `value CONF% STATUS`. Source is single: the live
// collector's FULL values+confidence while it's running, else what the current image last read
// via /api/preview (readoutPreview.all) so the value shows even with live mode OFF. Confidence is
// shown as a whole percent. STATUS is a ✓ when the read is okay (high confidence). Mirrors the
// register: an evaluated-but-empty/low-confidence readout shows blank (not "—"). "—" only when
// never evaluated. Reconciled in place (touch textContent/class only on change) so a steady value
// mutates the DOM zero times per heartbeat (CLAUDE.md rule 1).
function renderReadoutValues() {
    const running = !!(liveColStatus && liveColStatus.running);
    const lv = running ? (liveColStatus.readouts_all || {}) : {};
    const lc = running ? (liveColStatus.readout_confs_all || {}) : {};
    const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
    for (const el of document.querySelectorAll(".ro-live")) {
        const id = el.dataset.ro, win = el.dataset.win;
        let val, conf, found = true;
        if (has(lv, id)) { val = lv[id]; conf = lc[id]; }
        else if (has(readoutPreview.all, id)) { val = readoutPreview.all[id]; conf = readoutPreview.allConfs[id]; }
        else found = false;
        let txt, tint = null;   // "ok"=green, "reject"=red
        if (!found) txt = "—";
        else if (val === "") txt = "(none)";   // read happened but produced nothing -> dim (none)
        else {
            const pct = conf == null ? "" : ` ${Math.round(+conf * 100)}%`;
            let status = "";
            if (conf != null) {
                const tier = confTier(+conf);
                if (tier === "ok") { status = " ✓"; tint = "ok"; }
                else if (tier === "bad") tint = "reject";
            }
            txt = `${val}${pct}${status}`;
        }
        if (el.textContent !== txt) el.textContent = txt;
        const dim = !found || val === "";   // never-evaluated (—) or empty read ((none)) both show dim
        if (el.classList.contains("muted") !== dim) el.classList.toggle("muted", dim);
        el.classList.toggle("ro-accept", tint === "ok");      // green (var --ok)
        el.classList.toggle("ro-reject", tint === "reject");  // red   (var --danger)
    }
}
// A fresh /api/preview readout batch landed (non-live source) — repaint the readout values.
window.addEventListener("readout-preview", renderReadoutValues);

// Is the server live collector running (feeding readout values)? When false, readout nodes read
// their value off the current image via a preview instead (see imaging.refreshReadoutValues).
export function liveCollecting() { return !!(liveColStatus && liveColStatus.running); }

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
            // one stat-style line: [dot + id] on the left (dot folded into the label), detection
            // count hard against the right edge like the stat values above it.
            const row = document.createElement("div"); row.className = "live-row live-win";
            row.dataset.node = `win:${w.id}`; row.title = "go to this window's node";
            const label = document.createElement("span"); label.className = "live-wlabel";
            const dot = document.createElement("span"); dot.className = "live-wdot";
            const name = document.createElement("span"); name.className = "live-wname";
            label.append(dot, name);
            const cnt = document.createElement("span"); cnt.className = "live-statval live-wcount";   // detections, right-justified
            row.append(label, cnt);
            r = { row, dot, name, cnt }; liveRows.set(w.id, r);
        }
        const at = list.children[i];
        if (at !== r.row) list.insertBefore(r.row, at || null);
        i++;
        if (r.name.textContent !== w.id) r.name.textContent = w.id;
        paintWdot(r.dot, w.id);
        const n = liveDetCount.get(w.id) || 0;          // how many times detected this run
        const ctxt = n ? `${n}×` : "";
        if (r.cnt.textContent !== ctxt) r.cnt.textContent = ctxt;
        if (r.cnt.title !== `detected ${n}×`) r.cnt.title = `detected ${n}×`;
    }
}

// Reconcile the saved-session rows in place (keyed Map, no innerHTML per tick — rule 1). Rows
// reuse the precapture session-list look (.pc-sess, rule 7). A row plays its session on click
// (feedSession); the one currently feeding shows .active (same selection style precap uses).
function renderLiveChips() {
    const list = liveRoot?.querySelector(".live-chips");
    if (!list) return;
    const want = new Set(liveSessions.map((s) => s.id));
    for (const [id, r] of chipRows) if (!want.has(id)) { r.row.remove(); chipRows.delete(id); }
    if (!liveSessions.length) {
        if (!list._empty) { list._empty = document.createElement("div"); list._empty.className = "live-chips-empty muted"; list._empty.textContent = "no saved sessions"; }
        if (!list._empty.isConnected) list.appendChild(list._empty);
        return;
    }
    if (list._empty?.isConnected) list._empty.remove();
    const feedingId = (liveFeed && liveOn) ? selectedSession() : null;
    let i = 0;
    for (const s of liveSessions) {
        let r = chipRows.get(s.id);
        if (!r) {
            const row = document.createElement("div"); row.className = "pc-sess"; row.dataset.sid = s.id;
            const name = document.createElement("span"); name.className = "pc-sess-name";
            const meta = document.createElement("span"); meta.className = "pc-sess-meta";
            row.append(name, meta);
            r = { row, name, meta }; chipRows.set(s.id, r);
        }
        const at = list.children[i];
        if (at !== r.row) list.insertBefore(r.row, at || null);
        i++;
        const lbl = sessLabel(s);
        if (r.name.textContent !== lbl) r.name.textContent = lbl;
        const mt = sessMeta(s, { withBytes: true });
        if (r.meta.textContent !== mt) r.meta.textContent = mt;
        const feeding = s.id === feedingId;
        if (r.row.classList.contains("active") !== feeding) r.row.classList.toggle("active", feeding);
        const t = feeding ? "stop feeding this session" : "feed this saved session";
        if (r.row.title !== t) r.row.title = t;
    }
}

// Play/switch/stop a saved session's feed. Clicking the session already feeding stops it;
// clicking any other session starts (or switches to) feeding it — one feed runs at a time, but
// switching between sessions is a single click.
function feedSession(sid) {
    if (liveFeed && liveOn && selectedSession() === sid) { liveFeed = false; setLiveMode(false); return; }
    if (!liveImg.count) { setStatus("no saved live images to feed"); return; }
    liveFeedSess = sid;
    liveFeed = true;
    if (!liveOn) { setLiveMode(true); return; }
    stopServerCollect().then(startServerCollect);   // restart in feed mode against the new session
    registerWorker("live", "live feed", () => setLiveMode(false));
    log("feeding saved images");
    syncTuningSession();
    renderLiveWindow();
}

// The ONE live-recognition-dot painter, shared by the live panel's window list AND the game
// node's window-priority rows (rule 7 — one predicate, no second copy). In place: only touches
// the class/title when they actually change (rule 1). `.on` == this window is recognised on
// screen right now (needs live running); off shows why (not-yet / live-off).
function paintWdot(dot, winId) {
    const det = liveOn && !!liveRecog.get(winId);
    if (dot.classList.contains("on") !== det) dot.classList.toggle("on", det);
    const t = det ? "detected" : (liveOn ? "not detected yet" : "live off");
    if (dot.title !== t) dot.title = t;
}

// Repaint the game node's window-priority dots to match live recognition, in place. Called on
// every live tick (renderLiveWindow) and after each gamePriority rebuild (wireGamePriority).
// No-op when the game node isn't rendered — the query just matches nothing.
export function syncWpDots() {
    for (const row of document.querySelectorAll(".game-priority .wp-row")) {
        const dot = row.querySelector(".live-wdot");
        if (dot) paintWdot(dot, row.dataset.id);
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
        if (!liveOn || !(liveSave || liveFeed)) return;
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
    // null => server uses the persisted frame limiter; liveSaveRecog => save every recognised grab
    // (forced off while feeding — a replay saves nothing); liveFeed => replay the picked saved
    // session (blank = whatever the server sees as newest).
    api.live.start(game, null, liveFeed ? false : liveSaveRecog, liveFeed, liveFeed ? selectedSession() : "").then(() => hub.kick()).catch((e) => setStatus(String(e.message || e)));
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
    liveFeed = !!st.feeding;   // reflect a feed-saved-images run adopted on reload
    if (st.feed_session) liveFeedSess = st.feed_session;   // ...and which session it's replaying
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
    liveFeed = !!(lv && lv.feeding);   // reflect a feed-saved-images run adopted off the heartbeat
    if (lv && lv.feed_session) liveFeedSess = lv.feed_session;   // ...and which session it's replaying
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
    liveOn = false; liveSawServer = false; liveFeed = false;   // a finished feed drops the toggle
    if (timer) { bgClearTimeout(timer); timer = null; }
    liveRecog.clear(); liveDetCount.clear();
    if (liveColUnsub) { liveColUnsub(); liveColUnsub = null; }
    liveColStatus = null;
    unregisterWorker("live");
    showLiveStats(false);
    stopDebugPoll();   // collector gone -> nothing to poll
    syncTuningSession();   // live is off now -> close any tuning session
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
    // the session list rides the same throttle — the feed dropdown reads from it
    api.liveCaptures.sessions(game).then((ss) => { liveSessions = ss || []; renderLiveWindow(); }).catch(() => {});
}

// The read-only tuning loop saves its frames through /live/grab, which has no start or stop of its
// own — so the client marks the boundary: one tuning run = one session folder. The armed collector
// opens and closes its own session server-side, so this only tracks the disarmed loop. Idempotent
// (a repeated same-state call is dropped), and safe to call on every live/save/feed edge.
let tuningSess = false;
function syncTuningSession() {
    const want = liveOn && !liveSave && !liveFeed;
    const game = model.profile.name;
    if (!game || want === tuningSess) return;
    tuningSess = want;
    (want ? api.liveCaptures.sessionBegin(game) : api.liveCaptures.sessionEnd(game))
        .then(() => { if (!want) refreshLiveImgStat(true); })   // a closed session is a new pickable recording
        .catch(() => {});
}

// Which session the feed will replay: the picked one while it still exists, else the newest
// (what the server falls back to when we send no session at all).
function selectedSession() {
    if (liveFeedSess && liveSessions.some((s) => s.id === liveFeedSess)) return liveFeedSess;
    return liveSessions.length ? liveSessions[0].id : "";
}
function stopServerCollect() {
    const game = model.profile.name;
    if (liveColUnsub) { liveColUnsub(); liveColUnsub = null; }
    // the server stop joins the worker before responding -> await this before any restart so a
    // re-arm (e.g. an interval change) can't race the teardown and leave collection stopped.
    const done = game ? api.live.stop(game).catch((e) => log(`live stop failed: ${e.message || e}`) || null) : Promise.resolve();
    liveColStatus = null;
    liveSawServer = false;   // teardown -> the watcher must re-observe before reflecting another stop
    liveStopping = true;     // don't let a stale in-flight "running" beat re-adopt during the worker join
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
        // feed replays saved images through the server collector, so it counts as "armed" (writes
        // records) even if the save-to-datasets switch is off.
        const armed = liveSave || liveFeed;
        log(liveFeed ? "live feed started (saved images)" : liveSave ? "live collection started" : "live mode started (read-only)", "run");
        registerWorker("live", liveFeed ? "live feed" : liveSave ? "live collection" : "live view", () => setLiveMode(false));
        if (armed) startServerCollect(); else liveTick();   // armed → server collector; else client tuning loop
    } else {
        log("live mode stopped");
        unregisterWorker("live");
        stopServerCollect();   // harmless if not running
    }
    syncTuningSession();   // disarmed loop -> its own session folder, opened/closed on this edge
    renderLiveWindow();   // reflect the toggle + cleared dots
}

// Arm/disarm saving. While live is on, this swaps between the server collector (armed) and
// the client tuning loop (disarmed) without leaving live mode.
function setLiveSave(on) {
    if (on === liveSave) return;
    liveSave = on;
    if (liveOn) {
        if (timer) { bgClearTimeout(timer); timer = null; }   // stop the client loop either way
        const armed = on || liveFeed;   // feed keeps the collector running even with save off
        if (armed) { stopServerCollect().then(startServerCollect); }   // await teardown, then (re)start
        else { stopServerCollect(); liveTick(); }                      // back to read-only tuning
        registerWorker("live", liveFeed ? "live feed" : on ? "live collection" : "live view", () => setLiveMode(false));
        log(on ? "live saving armed" : "live saving disarmed", on ? "run" : undefined);
    }
    syncTuningSession();   // armed <-> disarmed swaps who owns the session
    renderLiveWindow();
}

// Toggle "save live session" (label; internally still saverecog/saveRecog). The flag rides the server collector (started with
// save_recognized), so a change while it's running restarts it in place to take effect (like the
// frame limiter). No effect in read-only tuning mode — there's no server collector, only the
// client detect loop.
function setLiveSaveRecog(on) {
    if (on === liveSaveRecog) return;
    liveSaveRecog = on;
    if (liveOn && liveSave) { stopServerCollect().then(startServerCollect); }   // restart so save_recognized applies
    log(on ? "saving every recognised-window grab" : "saving write frames only");
    renderLiveWindow();
}

export {
    liveWin, liveWinState, liveRecog, liveDetCount,
    buildLiveWindow, mountLive, activateLive, deactivateLive,
    renderLiveWindow, renderLiveWinList, fitLivePanelHeight,
    showLiveStats, renderLiveStats, liveTick, startServerCollect, stopServerCollect,
    setLiveMode, setLiveSave, syncLiveFromServer, applyLiveInterval,
};
