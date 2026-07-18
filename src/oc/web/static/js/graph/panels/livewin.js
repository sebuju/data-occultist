// Live-tuning floating panel — master toggle, live stats, per-window detection list, and
// the client read loop / server-collector arm. Extracted from main.js verbatim.
import * as api from "../../api.js";
import * as hub from "../../hub.js";
import { log } from "../../log.js";
import { createFloatWin } from "../floatwin.js";
import { persist } from "../persist.js";
import { $, setStatus, model, readoutPreview } from "../state.js";
import { registerWorker, unregisterWorker } from "../workers.js";
import { pc, precapOpen, precapBusy, fmtBytes } from "./precap.js";
import { prevHost, refreshDetect, refreshPreview } from "../imaging.js";
import { refreshLive } from "../main.js";
import { panZoomTo } from "../camera.js";
import { h, svg } from "../../dom.js";
import { confTier } from "../conf.js";
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
// "save all images" arm (default OFF): when on, the server collector saves EVERY OCR-due grab to
// the live/ image bucket, not only the frames that wrote a record. Rides the collector, so a mid-
// run toggle restarts it (like the frame limiter / save arm). Read-only tuning mode is unaffected.
let liveSaveRecog = false;
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
let liveImg = { count: 0, bytes: 0 };   // saved live-image stat (live tuning saves one frame/round)
// OCR log (expandable, below the stats): shows what OCR read, how it was corrected, and what
// was pushed to which dataset. Polled from /api/live/{game}/debug ONLY while expanded AND live is
// running (gated poll, like precap) — a stopped collector emits no reads. Reconciled in place
// (keyed by seq, rule 1), and capped (rule 4).
let dbgOpen = true;         // section expanded? (open by default)
let dbgTimer = null;        // poll timer while open (null = not polling)
let dbgSeq = 0;             // highest debug seq already rendered (incremental poll cursor)
const dbgRows = new Map();  // seq -> row element, reused across polls
const DBG_CAP = 200;        // max rendered debug rows — a log preview, not a data grid
// Two collapsible sections (stats + OCR log) built on the shared `collapsible()` primitive; refs
// stashed so their toggles reconcile chevron/body without re-querying (stats open by default).
let statsOpen = true;
let statsChev = null, statsBody = null, dbgChev = null, dbgBody = null;

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
            h("div", { class: "live-row" },
                h("label", { class: "live-toggle" },
                    h("button", { class: "act-enable live-saverecog", role: "switch", "aria-checked": "false", title: "save one image per OCR-due grab whose frame matched a window (any recognised window/state), not just frames that wrote a record — debug aid, off by default" },
                        switchSvg()),
                    h("span", { class: "live-saverecog-lbl" }, "capture recognised windows"))),
            h("div", { class: "live-wins" }));
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
                h("span", { class: "live-statval live-stat-rows muted" }, "–")));
        // OCR-log collapsible -- collapsed by default; when open it polls the server's read ring and
        // shows, per OCR-heavy tick, every field's raw text -> resolved value (marking corrections)
        // plus what was written to which dataset.
        const dbgClear = h("span", { class: "live-dbg-clear", role: "button", title: "clear the OCR log view" }, "clear");
        const dbg = collapsible({ title: "OCR log", open: dbgOpen, headExtra: dbgClear, bodyClass: "live-dbg-body",
            headTitle: "per-tick OCR reads, corrections, and dataset writes (polls only while open)" });
        dbgChev = dbg.chev; dbgBody = dbg.body;
        dbg.section.classList.toggle("live-dbg-open", dbgOpen);   // section flex-grows while open (CSS, no :has)
        dbg.body.append(
            h("div", { class: "live-dbg-empty muted" }, "waiting for reads…"),
            h("div", { class: "live-dbg-list" }));
        // saved-live-image stat + clear -- the LAST element of the whole panel, below both sections.
        const imgsRow = h("div", { class: "live-row live-imgs" },
            h("span", { class: "live-imgstat muted" }, " "),
            h("button", { class: "live-clear", dataset: { armed: "0" }, title: "delete every saved live image" }, "flush"));
        liveRoot.append(stats.section, dbg.section, imgsRow);
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
        // clear saved live images -- armed two-click (no blocking confirm)
        const clr = liveRoot.querySelector(".live-clear");
        clr.addEventListener("click", () => {
            if (clr.dataset.armed !== "1") { clr.dataset.armed = "1"; clr.textContent = "sure?"; setTimeout(() => { if (clr.dataset.armed === "1") { clr.dataset.armed = "0"; clr.textContent = "flush"; } }, 2500); return; }
            clr.dataset.armed = "0"; clr.textContent = "flush";
            if (model.profile.name) api.liveCaptures.clear(model.profile.name).then((s) => { liveImg = s; renderLiveWindow(); }).catch((e) => log(`clear live images failed: ${e.message || e}`, "err"));
        });
        if (model.profile.name) api.liveCaptures.stats(model.profile.name).then((s) => { liveImg = s; renderLiveWindow(); }).catch(() => {});
        // stats header toggles its section; OCR-log header toggles its section (and its gated poll),
        // or clears the rendered view when the inline "clear" is hit (server ring untouched).
        stats.head.addEventListener("click", () => setStatsOpen(!statsOpen));
        dbg.head.addEventListener("click", (ev) => {
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
    syncDebugPoll();   // resume the debug poll if the section was left open AND live is running
    requestAnimationFrame(() => fitLivePanelHeight());
    document.fonts?.ready?.then(() => { if (active) fitLivePanelHeight(); });
}
function deactivateLive() { active = false; stopDebugPoll(); }   // hidden panel polls nothing

// ---- debug log -------------------------------------------------------------
// Expandable section below the stats. Polls the server debug ring ONLY while open (gated, like
// precap), reconciles rows in place (keyed by seq, rule 1), and caps the rendered rows (rule 4).

// Shared collapsible primitive: a chevron+title header toggling a body. BOTH the stats section and
// the OCR-log section are built on this (rule 7) — the caller wires its own click handler (the OCR
// log also starts/stops a poll; stats just shows/hides) and reconciles via setCollapsed().
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

function setDebugOpen(on) {
    dbgOpen = on;
    setCollapsed(dbgChev, dbgBody, on);
    dbgBody.parentElement.classList.toggle("live-dbg-open", on);   // .clps section grows to fill (CSS, no :has)
    syncDebugPoll();
    fitLivePanelHeight();
}

// Start/stop the debug poll to match the gate: poll ONLY while the section is open, the panel is
// active, AND live mode is on (a stopped collector writes no new reads — nothing to poll for).
// Callers fire this freely on any of those edges; it's a no-op when already in the right state.
function syncDebugPoll() { if (dbgOpen && active && liveOn) startDebugPoll(); else stopDebugPoll(); }

function startDebugPoll() {
    if (dbgTimer || !dbgOpen || !active || !liveOn) return;
    pollDebug();   // immediate first pull, then a gated cadence
}
function stopDebugPoll() {
    if (dbgTimer) { bgClearTimeout(dbgTimer); dbgTimer = null; }
}

function pollDebug() {
    dbgTimer = null;
    const game = model.profile.name;
    if (!dbgOpen || !active || !liveOn || !game) return;
    api.live.debug(game, dbgSeq).then((r) => {
        if (r && r.entries && r.entries.length) renderDebugEntries(r.entries);
    }).catch(() => {}).finally(() => {
        // keep polling while open + live — on bgtimer so a backgrounded tab still ticks (like liveTick)
        if (dbgOpen && active && liveOn) dbgTimer = bgSetTimeout(pollDebug, 700);
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
        // capture-recognised mode names the image file this grab was written to (server sends `saved`)
        e.saved ? h("span", { class: "live-dbg-file", title: e.saved }, e.saved) : null,
        h("span", { class: "live-dbg-wrote" + (e.new ? " wrote" : "") }, wrote || `${e.kept ?? 0}/${e.read ?? 0} read`));
    const reads = (e.reads || []).map((rd) => buildReadRow(rd));
    // Readouts (live HUD scalars) read on a separate path — shown here too, tagged so they read
    // apart from record reads. Only the ones that CHANGED this tick are carried (see live.py).
    const roReads = (e.readout_reads || []).map((rd) => buildReadRow(rd, " readout"));
    return h("div", { class: "live-dbg-row" }, head, ...reads, ...roReads);
}

// One read line: each field's raw OCR text -> resolved value, flagging corrected fields. Shared by
// record reads and readout reads (readouts pass a `readout` class so they render distinctly).
function buildReadRow(rd, extraClass = "") {
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
    return h("div", { class: "live-dbg-read" + extraClass }, ...parts);
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
    // Stats render as fixed rows below the window list; "–" placeholder when off so height holds.
    // collecting (armed): show what the server collector saved; tuning (disarmed): client img rate.
    const collecting = liveOn && liveSave;
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
    // saved-live-image stat (touch DOM only on change)
    const ist = liveRoot.querySelector(".live-imgstat");
    const itxt = liveImg.count ? `${liveImg.count} imgs · ${fmtBytes(liveImg.bytes)}` : "";
    if (ist && ist.textContent !== itxt) ist.textContent = itxt;
    const clrBtn = liveRoot.querySelector(".live-clear");
    if (clrBtn) clrBtn.hidden = !liveImg.count;   // nothing saved -> hide clear
    const clr = liveRoot.querySelector(".live-clear");
    if (clr) clr.disabled = !liveImg.count;
    renderLiveWinList();
    renderReadoutValues();
    fitLivePanelHeight();
}

// The FieldDef a readout borrows its read config from (carries the consensus knobs
// stability_reads/min), looked up by window + readout id off the profile model.
function readoutField(winId, roId) {
    const w = model.profile.windows?.find((x) => x.id === winId);
    const v = w?.readouts?.find((r) => r.id === roId);
    return (w && v) ? model.readoutField(w, v) : null;
}

// Fill each readout node's `.ro-live` span with `value CONF% STATUS`. Source is single: the live
// collector's FULL values+confidence while it's running, else what the current image last read
// via /api/preview (readoutPreview.all) so the value shows even with live mode OFF. Confidence is
// shown as a whole percent. STATUS is a ✓ when the read is okay (high confidence); when a readout's
// CONSENSUS gate is in use (stability_reads > 0) it instead shows the live agreement — "⏸ held"
// while the gate is suppressing (the value shown is the last held one) or "✓ good/window" while it
// passes, so you can watch the gate work and tune N-of-M. Mirrors the register: an evaluated-but-
// empty/low-confidence readout shows blank (not "—"). "—" only when never evaluated. Reconciled in
// place (touch textContent/class only on change) so a steady value mutates the DOM zero times per
// heartbeat (CLAUDE.md rule 1).
function renderReadoutValues() {
    const running = !!(liveColStatus && liveColStatus.running);
    const lv = running ? (liveColStatus.readouts_all || {}) : {};
    const lc = running ? (liveColStatus.readout_confs_all || {}) : {};
    const rh = running ? (liveColStatus.readout_history || {}) : {};
    const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
    for (const el of document.querySelectorAll(".ro-live")) {
        const id = el.dataset.ro, win = el.dataset.win;
        let val, conf, found = true;
        if (has(lv, id)) { val = lv[id]; conf = lc[id]; }
        else if (has(readoutPreview.all, id)) { val = readoutPreview.all[id]; conf = readoutPreview.allConfs[id]; }
        else found = false;
        let txt, tint = null;   // "ok"=green, "reject"=red, "hold"=yellow-green (value fine, gate blocking)
        if (!found) txt = "—";
        else if (val === "") txt = "(none)";   // read happened but produced nothing -> dim (none)
        else {
            const pct = conf == null ? "" : ` ${Math.round(+conf * 100)}%`;
            // consensus status when the gate is in use; else a plain ✓ for a high-confidence read.
            const fd = readoutField(win, id);
            const m = fd?.stability_reads || 0;
            const hist = m > 0 ? (rh[`${win}:${id}`] || null) : null;
            let status = "";
            if (hist && hist.length) {
                const good = hist.slice(0, m).reduce((a, e) => a + (e.ok ? 1 : 0), 0);
                const cur = hist[0], held = !!cur.held;
                status = held ? " ⏸ held" : ` ✓ ${good}/${m}`;
                // held + this read was itself fine = value ok but consensus still blocking (yellow-
                // green); held + a bad read = reject (red); not held = accepted (green).
                tint = held ? (cur.ok ? "hold" : "reject") : "ok";
            } else if (conf != null) {
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
        el.classList.toggle("ro-hold", tint === "hold");      // yellow-green: value fine, gate blocking
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
        paintWdot(r.dot, w.id);
        const n = liveDetCount.get(w.id) || 0;          // how many times detected this run
        const ctxt = n ? `${n}×` : "";
        if (r.cnt.textContent !== ctxt) r.cnt.textContent = ctxt;
        if (r.cnt.title !== `detected ${n}×`) r.cnt.title = `detected ${n}×`;
    }
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
    api.live.start(game, null, liveSaveRecog).then(() => hub.kick()).catch((e) => setStatus(String(e.message || e)));   // null => server uses the persisted frame limiter; liveSaveRecog => save every recognised grab
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
    syncDebugPoll();   // adopted a server-side run on reload -> resume the OCR-log poll if open
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
    syncDebugPoll();   // adopted a running collector -> resume the OCR-log poll if its section is open
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
    stopDebugPoll();   // collector gone -> nothing to poll
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
    syncDebugPoll();   // live edge: start the OCR-log poll (if open) on, stop it on off
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

// Toggle "capture recognised windows". The flag rides the server collector (started with
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
