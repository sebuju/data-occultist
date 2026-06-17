// Live-tuning floating panel — master toggle, live stats, per-window detection list, and
// the client read loop / server-collector arm. Extracted from main.js verbatim.
import * as api from "../../api.js";
import * as hub from "../../hub.js";
import { log } from "../../log.js";
import { createFloatWin } from "../floatwin.js";
import { persist } from "../persist.js";
import { $, setStatus, model, nodeEls } from "../state.js";
import { registerWorker, unregisterWorker } from "../workers.js";
import { pc, pcState, precapOpen, precapBusy, fmtBytes } from "./precap.js";
import { prevHost, refreshDetect, refreshPreview } from "../imaging.js";
import { refreshLive } from "../main.js";

let timer = null;
// live floating panel state — declared BEFORE buildLiveWindow() runs at module-eval
// (it reads liveWin/liveWinState), else a `let` TDZ throws and aborts the whole script.
const liveWinState = { visible: false, x: null, y: null, w: null, h: null };
let liveWin = null;
let liveEmpty = null;
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
let liveColStatus = null;   // latest server collector status (from the heartbeat) while collecting
let liveColUnsub = null;    // hub subscription active while the server collector runs
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
    onShow: () => { $("liveBtn")?.classList.toggle("active", true); renderLiveWindow(); },
    onHide: () => { $("liveBtn")?.classList.toggle("active", false); },
    onPersist: () => persist.layout(),
  });
  liveWin.body.innerHTML = `
    <div class="live-row">
      <label class="live-toggle"><button class="act-enable live-switch" role="switch" aria-checked="false" title="enable / disable live mode">
          <svg viewBox="0 0 28 16" width="28" height="16" aria-hidden="true">
            <rect class="gt-track" x="1" y="1" width="26" height="14" rx="7" />
            <circle class="gt-thumb" cx="8" cy="8" r="5" /></svg>
        </button><span class="live-switch-lbl">live mode</span></label>
      <span class="live-stats muted"></span>
    </div>
    <div class="live-row">
      <label class="live-toggle"><button class="act-enable live-save" role="switch" aria-checked="true" title="save reads to datasets (runs the real collector: confirm-frames, dedup, store, triggers)">
          <svg viewBox="0 0 28 16" width="28" height="16" aria-hidden="true">
            <rect class="gt-track" x="1" y="1" width="26" height="14" rx="7" />
            <circle class="gt-thumb" cx="8" cy="8" r="5" /></svg>
        </button><span class="live-save-lbl">save to datasets</span></label>
    </div>
    <div class="live-wins"></div>
    <div class="live-row live-imgs"><span class="live-imgstat muted"></span><button class="live-clear" data-armed="0" title="delete every saved live image">clear</button></div>`;
  liveEmpty = document.createElement("div"); liveEmpty.className = "act-empty"; liveEmpty.textContent = "no live-enabled windows";
  liveWin.body.querySelector(".live-switch").addEventListener("click", () => setLiveMode(!liveOn));
  liveWin.body.querySelector(".live-save").addEventListener("click", () => setLiveSave(!liveSave));
  // clear saved live images — armed two-click (no blocking confirm; CLAUDE.md rule 2)
  const clr = liveWin.body.querySelector(".live-clear");
  clr.addEventListener("click", () => {
    if (clr.dataset.armed !== "1") { clr.dataset.armed = "1"; clr.textContent = "sure?"; setTimeout(() => { if (clr.dataset.armed === "1") { clr.dataset.armed = "0"; clr.textContent = "clear"; } }, 2500); return; }
    clr.dataset.armed = "0"; clr.textContent = "clear";
    if (model.profile.name) api.liveCaptures.clear(model.profile.name).then((s) => { liveImg = s; renderLiveWindow(); }).catch((e) => log(`clear live images failed: ${e.message || e}`, "err"));
  });
  if (model.profile.name) api.liveCaptures.stats(model.profile.name).then((s) => { liveImg = s; renderLiveWindow(); }).catch(() => {});
  renderLiveWindow();
}

function renderLiveWindow() {
  if (!liveWin || !liveWinState.visible) return;
  // sync the visual `.on` class INDEPENDENTLY of aria-checked — the markup ships
  // aria-checked already matching the default, so gating the class on an aria mismatch left
  // a default-on switch (save-to-datasets) visually off. Each touched only when it differs.
  const syncSwitch = (el, on) => {
    if (!el) return;
    if (el.getAttribute("aria-checked") !== String(on)) el.setAttribute("aria-checked", String(on));
    if (el.classList.contains("on") !== on) el.classList.toggle("on", on);
  };
  syncSwitch(liveWin.body.querySelector(".live-switch"), liveOn);
  syncSwitch(liveWin.body.querySelector(".live-save"), liveSave);
  const st = liveWin.body.querySelector(".live-stats");
  // collecting (armed): show what the server collector saved; tuning (disarmed): client fps.
  // blank when off (the switch already conveys that). No processing/idle flip — it toggled
  // every round (OCR vs the 200ms gap) and just flickered.
  const collecting = liveOn && liveSave;
  const stTxt = !liveOn ? ""
    : collecting ? `${liveColStatus?.written ?? 0} saved · ${(liveColStatus?.fps ?? 0).toFixed(1)}/s`
    : `${liveFps.toFixed(1)} img/s`;
  if (st && st.textContent !== stTxt) st.textContent = stTxt;
  // saved-live-image stat (touch DOM only on change)
  const ist = liveWin.body.querySelector(".live-imgstat");
  const itxt = liveImg.count ? `${liveImg.count} imgs · ${fmtBytes(liveImg.bytes)} saved` : "no live images saved";
  if (ist && ist.textContent !== itxt) ist.textContent = itxt;
  const clr = liveWin.body.querySelector(".live-clear");
  if (clr) clr.disabled = !liveImg.count;
  renderLiveWinList();
  fitLivePanelHeight();
}

// Reconcile the live-enabled window list in place (keyed Map, no innerHTML per tick).
function renderLiveWinList() {
  const list = liveWin.body.querySelector(".live-wins");
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

// Auto-fit the panel height to its contents until the user resizes it (a size write only
// happens when the target actually differs, so a steady tick mutates nothing).
function fitLivePanelHeight() {
  if (!liveWin || !liveWinState.visible || liveWinState.collapsed || liveWinState.userSized) return;
  const headerH = liveWin.el.querySelector(".fw-head")?.offsetHeight || 28;
  // Measure CONTENT, not body.scrollHeight: the body is flex:1 so its scrollHeight is at
  // least its own clientHeight — feeding that back grew the panel ~14px every tick. The body's
  // children are block-flow, so their intrinsic offsetHeight sums to the true content height.
  const bs = getComputedStyle(liveWin.body);
  const padV = parseFloat(bs.paddingTop) + parseFloat(bs.paddingBottom);
  const content = [...liveWin.body.children].reduce((h, c) => h + c.offsetHeight, 0);
  const target = Math.round(Math.min(window.innerHeight - 60, headerH + content + padV));
  if (Math.abs(liveWin.el.offsetHeight - target) > 1) { liveWin.el.style.height = `${target}px`; liveWinState.h = target; }
}

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
    // save what live mode sees: one frame per round into the live bucket (fire-and-forget;
    // a capture failure must never stall tuning). grab returns the running {count,bytes}.
    api.liveCaptures.grab(game).then((s) => { liveImg = s; }).catch((e) => log(`live grab failed: ${e.message || e}`, "err"));
    for (const w of model.profile.windows || []) {
      if (!liveOn || liveSave) break;
      if (w.live === false || w.enabled === false) continue;   // skip windows opted out of live
      await refreshDetect(w.id, true);   // sets liveRecog + refreshes the panel
      liveFrames++;
      if (prevHost(w.id)?.dataset.ran === "1") await refreshPreview(w.id, true);
    }
    renderLiveStats();   // recompute fps + refresh the panel after the round
  }
  if (liveOn && !liveSave) timer = setTimeout(liveTick, 200);   // next round only AFTER this one drained
}

// Server-side collector (the real pipeline): started when live + save are both on. The
// heartbeat carries its status; we mirror recognized windows into liveRecog for the dots.
function startServerCollect() {
  const game = model.profile.name;
  if (!game) return;
  liveColStatus = null;
  api.live.start(game).catch((e) => setStatus(String(e.message || e)));
  if (!liveColUnsub) liveColUnsub = hub.subscribe((s) => {
    if (!liveOn || !liveSave) return;
    liveColStatus = s.live || null;
    liveRecog.clear(); liveDetCount.clear();
    for (const r of (liveColStatus?.recognized || [])) {   // cumulative tally → dots + per-window count
      if (!r.miss && r.key.includes("/")) {
        const wid = r.key.split("/")[0];
        liveRecog.set(wid, true);
        liveDetCount.set(wid, (liveDetCount.get(wid) || 0) + (r.count || 0));
      }
    }
    renderLiveWindow();
  });
  hub.kick();   // beat now so collection status shows immediately
}
function stopServerCollect() {
  const game = model.profile.name;
  if (liveColUnsub) { liveColUnsub(); liveColUnsub = null; }
  if (game) api.live.stop(game).catch((e) => log(`live stop failed: ${e.message || e}`, "err"));
  liveColStatus = null;
  hub.kick();
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
    if (on) { stopServerCollect(); startServerCollect(); }   // (re)start the collector
    else { stopServerCollect(); liveTick(); }                // back to read-only tuning
    registerWorker("live", on ? "live collection" : "live view", () => setLiveMode(false));
    log(on ? "live saving armed" : "live saving disarmed", on ? "run" : undefined);
  }
  renderLiveWindow();
}

export {
  liveWin, liveWinState, liveRecog, liveDetCount,
  buildLiveWindow, renderLiveWindow, renderLiveWinList, fitLivePanelHeight,
  showLiveStats, renderLiveStats, liveTick, startServerCollect, stopServerCollect,
  setLiveMode, setLiveSave,
};
