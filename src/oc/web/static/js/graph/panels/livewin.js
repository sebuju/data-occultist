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
import { prevHost, refreshDetect, refreshPreview } from "../imaging.js";
import { refreshLive } from "../main.js";
import { panZoomTo } from "../camera.js";
import { h, svg } from "../../dom.js";

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
// Frame limiter: minimum SECONDS between collector reads (the panel input is in ms and
// converts). 0 = as fast as possible (no throttle). Default 0.2s (200ms) — a sane frame limiter
// that keeps CPU/GPU sane. Changeable while live is on — the server collector is restarted in place
// so the new limit takes effect immediately.
let liveInterval = 0.2;
let liveColStatus = null;   // latest server collector status (from the heartbeat) while collecting
let liveColUnsub = null;    // hub subscription active while the server collector runs
let liveSawServer = false;  // we've observed the server collector actually running this run (gates the external-stop reflect, so an optimistic pre-start beat can't kill a just-started toggle)
let liveImg = { count: 0, bytes: 0 };   // saved live-image stat (live tuning saves one frame/round)

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
                    h("span", { class: "live-switch-lbl" }, "live mode")),
                h("span", { class: "live-stats muted" })),
            h("div", { class: "live-row" },
                h("label", { class: "live-toggle" },
                    h("button", { class: "act-enable live-save", role: "switch", "aria-checked": "true", title: "save reads to datasets (runs the real collector: confirm-frames, dedup, store, triggers)" },
                        switchSvg()),
                    h("span", { class: "live-save-lbl" }, "save to datasets"))),
            h("div", { class: "live-row live-int-row" },
                h("span", { class: "live-int-lbl", title: "frame limiter — minimum milliseconds between collector reads. 0 (or blank) = as fast as possible (more CPU/GPU). Applies live while collecting." }, "limit (ms)"),
                h("input", { class: "live-int-in", type: "number", min: "0", step: "10", value: "200", placeholder: "0", title: "minimum milliseconds between reads; 0 = as fast as possible" })),
            h("div", { class: "live-wins" }),
            h("div", { class: "live-row live-imgs" },
                h("span", { class: "live-imgstat muted" }, " "),
                h("button", { class: "live-clear", dataset: { armed: "0" }, title: "delete every saved live image" }, "clear")));
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
        // frame-limiter input (milliseconds): commit on change/blur. Blank/0 -> 0s -> as fast
        // as possible. While collecting, restart the server collector so the new limit applies now.
        const intIn = liveRoot.querySelector(".live-int-in");
        const commitInterval = async () => {
            const ms = parseFloat(intIn.value);
            const next = Number.isFinite(ms) && ms > 0 ? ms / 1000 : 0;   // ms -> seconds; blank/0/neg = fastest
            if (next === 0) intIn.value = "";
            if (next === liveInterval) return;
            liveInterval = next;
            // re-arm with the new limit: await teardown FIRST so start can't race the stop
            if (liveOn && liveSave) { await stopServerCollect(); startServerCollect(); }
        };
        intIn.addEventListener("change", commitInterval);
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
    const st = liveRoot.querySelector(".live-stats");
    // collecting (armed): show what the server collector saved; tuning (disarmed): client fps.
    // blank when off (the switch already conveys that). No processing/idle flip — it toggled
    // every round (OCR vs the 200ms gap) and just flickered.
    const collecting = liveOn && liveSave;
    // mirror datasets report the current visible row-index span [vlo,vhi] + calibration -> show live
    const sc = collecting ? liveColStatus?.scroll : null;
    const scm = collecting ? liveColStatus?.scroll_meta : null;
    const scTxt = sc
        ? ` · rows ${Math.round(sc[0])}–${Math.round(sc[1])}${scm && scm.total ? ` / ${Math.round(scm.total)}` : ""}`
        : "";
    const stTxt = !liveOn ? ""
        : collecting ? `${liveColStatus?.written ?? 0} saved · ${(liveColStatus?.fps ?? 0).toFixed(1)}/s${scTxt}`
        : `${liveFps.toFixed(1)} img/s`;
    if (st && st.textContent !== stTxt) st.textContent = stTxt;
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
    if (liveOn && !liveSave) timer = setTimeout(liveTick, 200);   // next round only AFTER this one drained
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
    api.live.start(game, liveInterval).then(() => hub.kick()).catch((e) => setStatus(String(e.message || e)));
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
    if (Number.isFinite(st.interval) && st.interval > 0) {   // restore the frame-limiter input
        liveInterval = st.interval;
        const intIn = liveRoot?.querySelector(".live-int-in");
        if (intIn) intIn.value = String(Math.round(st.interval * 1000));
    }
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
    if (lv && Number.isFinite(lv.interval) && lv.interval > 0) {   // restore the frame-limiter input
        liveInterval = lv.interval;
        const intIn = liveRoot?.querySelector(".live-int-in");
        if (intIn) intIn.value = String(Math.round(lv.interval * 1000));
    }
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
    if (timer) { clearTimeout(timer); timer = null; }
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
    if (timer) { clearTimeout(timer); timer = null; }
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
        if (timer) { clearTimeout(timer); timer = null; }   // stop the client loop either way
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
    setLiveMode, setLiveSave, syncLiveFromServer,
};
