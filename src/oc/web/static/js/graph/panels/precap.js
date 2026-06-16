// Precapture floating window — record/process/commit capture sessions in a movable panel.
// Extracted from main.js verbatim.
import * as api from "../../api.js";
import * as hub from "../../hub.js";
import { esc, TRASH, CAMERA, WARN, PAUSE } from "../../dom.js";
import { openModal } from "../../modal.js";
import { log } from "../../log.js";
import { createFloatWin } from "../floatwin.js";
import { persist } from "../persist.js";
import { $, model, setStatus, imageCanvases, winPage } from "../state.js";
import { vtables, vtableFor, refreshAllDataNodes, refreshAllBatchesNodes } from "./datanodes.js";
import { registerWorker, unregisterWorker } from "../workers.js";
import { openImage, loadImage, updateImageLabel } from "../imaging.js";
import { setLiveMode } from "./livewin.js";
import {
  refreshLive, refreshAllSubsetNodes,
} from "../main.js";

// ---- precapture floating window -------------------------------------------
// A floating panel (built like the node map) rather than a modal, so it can be moved and
// left open while you work the game. Hiding it does NOT stop the worker — it keeps running
// in the background and is tracked/cancellable from the Activity panel; reopening rehydrates.

let precapOpen = false;    // panel currently open (read by livewin: one OCR consumer at a time)
let pc = null;             // the createFloatWin instance (built once)
let pcNode = null;         // the .precap body element handlers operate on
let pcSig = null;          // current AbortController signal (new each show → aborts on hide)
let pcCtl = null;          // current AbortController
let precapLast = null;     // last status drawn — so view switches can redraw without a fetch
let precapUnsub = null;   // heartbeat-hub subscription while the panel is open
let precapBusy = false;   // recording/processing/paused
let precapStopping = false;   // a stop/cancel was clicked, awaiting the worker to wind down
let precapLastPhase = null;
let precapSessions = [];   // saved recording sessions [{id,label,frames,bytes,processed,records,saved_at,active}]
let precapView = null;     // which item is selected: "new" (record inputs) or "loaded" (a session)
let precapPage = null;     // which page is shown: "list" (session list) or "detail" (the selected pane)
const pcState = { visible: false, x: null, y: null, w: null, h: null };

const _pcDraw = (st) => { precapLast = st; renderPrecap(pcNode, st); };
const _pcRun = async (fn) => {
  try { _pcDraw(await fn()); }
  catch (e) { if (e.name !== "AbortError") setStatus(String(e.message || e)); }   // ignore hide-aborts
};
// refresh the saved-session list (and the active status it returns)
const _pcLoadSessions = async () => {
  const game = model.profile.name; if (!game) return;
  try { const r = await api.precapture.sessions(game, pcSig); precapSessions = r.sessions || []; _pcDraw(r.status); }
  catch (e) { if (e.name !== "AbortError") setStatus(String(e.message || e)); }
};
// a session op returns { sessions, status } — update both at once
const _pcSessAct = async (p) => {
  try { const r = await p; precapSessions = r.sessions || precapSessions; _pcDraw(r.status); }
  catch (e) { if (e.name !== "AbortError") setStatus(String(e.message || e)); }
};

function buildPrecap() {
  if (pc) return;
  pcNode = document.createElement("div");
  pcNode.className = "precap";
  pcNode.innerHTML = `<p class="muted" style="padding:12px">loading…</p>`;
  pc = createFloatWin({
    id: "precap", title: "precapture", state: pcState, bothAxes: true,
    onShow: showPrecap, onHide: hidePrecap, onPersist: () => persist.layout(),
  });
  pc.body.appendChild(pcNode);

  // Inline rename: swap the session's name span for an <input>, commit on Enter/blur,
  // cancel on Escape — no blocking prompt(). Restores the span so reconcile resumes.
  const beginRename = (row, sid) => {
    const game = model.profile.name;
    const nameEl = row.querySelector(".pc-sess-name");
    if (!nameEl || row._editing) return;
    row._editing = true;
    const input = document.createElement("input");
    input.className = "pc-sess-rename"; input.value = row.dataset.label || "";
    nameEl.replaceWith(input);
    input.focus(); input.select();
    let done = false;
    const finish = (commit) => {
      if (done) return; done = true;
      row._editing = false;
      input.replaceWith(nameEl);   // reconcile refreshes the span's text on the next draw
      const label = input.value.trim();
      if (commit && label !== (row.dataset.label || ""))
        _pcSessAct(api.precapture.renameSession(game, sid, label, pcSig));
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); finish(false); }
    });
    input.addEventListener("blur", () => finish(true));
  };

  // one delegated handler for every control (buttons AND the clickable session rows)
  pcNode.addEventListener("click", (ev) => {
    if (ev.target.closest("input, textarea")) return;   // never let a field click trigger an action
    const b = ev.target.closest("[data-act]");
    if (!b) return;
    const game = model.profile.name; if (!game) return;
    const a = b.dataset.act, sid = b.dataset.sid;
    // session-list actions are locked while a worker runs
    if (precapBusy && (a === "newsess" || a === "loadsess" || a === "rensess" || a === "delsess")) return;
    const mf = +pcNode.querySelector(".pc-frames")?.value || 300;
    const iv = +pcNode.querySelector(".pc-interval")?.value || 0;
    const label = pcNode.querySelector(".pc-label")?.value || "";
    if (a === "recstop" || a === "cancel") { precapStopping = true; b.disabled = true; b.textContent = "stopping…"; }
    if (a === "back") { precapPage = "list"; if (precapLast) _pcDraw(precapLast); }
    else if (a === "newsess") { precapView = "new"; precapPage = "detail"; if (precapLast) _pcDraw(precapLast); }
    // recordStart creates+persists a new session server-side, so leave the "new" pane at
    // once and show it as the active loaded session (its row appears via loadSessions)
    else if (a === "record") { precapView = "loaded"; _pcRun(async () => { const st = await api.precapture.recordStart(game, mf, iv, label, pcSig); _pcLoadSessions(); return st; }); }
    else if (a === "recstop") _pcRun(() => api.precapture.recordStop(game, pcSig));
    else if (a === "process") _pcRun(() => api.precapture.processStart(game, pcSig));
    else if (a === "pause") _pcRun(() => api.precapture.pause(game, true, pcSig));
    else if (a === "resume") _pcRun(() => api.precapture.pause(game, false, pcSig));
    else if (a === "cancel") _pcRun(() => api.precapture.cancel(game, pcSig));
    else if (a === "save") {
      b.classList.add("reading"); b.disabled = true;   // spinner until the commit returns
      (async () => {
        try {
          const r = await api.precapture.save(game, pcSig);
          refreshLive(); refreshAllDataNodes(); refreshAllBatchesNodes(); refreshAllSubsetNodes();
          setStatus(`committed ${JSON.stringify(r.written)}`); _pcLoadSessions(); _pcDraw(r.status);
        } catch (e) {
          if (e.name !== "AbortError") { setStatus(String(e.message || e)); if (precapLast) _pcDraw(precapLast); }   // redraw clears the spinner
        }
      })();
    }
    else if (a === "loadsess") { precapView = "loaded"; precapPage = "detail"; _pcSessAct(api.precapture.loadSession(game, sid, pcSig)); }
    else if (a === "delsess") {
      if (b.dataset.armed !== "1") {   // inline confirm — no blocking dialog (armed two-click)
        b.dataset.armed = "1"; b.textContent = "delete?"; b.classList.add("armed");
        setTimeout(() => { b.dataset.armed = "0"; b.innerHTML = TRASH; b.classList.remove("armed"); }, 2500);
        return;
      }
      b.dataset.armed = "0";
      _pcSessAct(api.precapture.deleteSession(game, sid, pcSig));
    }
    else if (a === "rensess") beginRename(b.closest(".pc-sess"), sid);
    // worker state just changed -> beat the hub now so the tasks panel + precap indicator
    // reflect it without waiting out the cadence
    if (["record", "recstop", "process", "pause", "resume", "cancel"].includes(a)) hub.kick();
  });
  // auto-scroll is configured per window now (window node's scroll section), not here.
}

async function showPrecap() {
  const game = model.profile.name;
  if (!game) { setStatus("load a game first"); pc.setVisible(false); return; }
  setLiveMode(false);                         // mutually exclusive with live
  precapOpen = true;
  precapStopping = false; precapView = null; precapPage = null;
  $("precapBtn").classList.add("active");
  pc.el.querySelector(".fw-title").textContent = `precapture: ${game}`;
  pcCtl = new AbortController(); pcSig = pcCtl.signal;
  await _pcLoadSessions();
  // The heartbeat hub already carries the precapture worker's status (only while it's
  // busy), so subscribe instead of running our own status poll. When the worker finishes
  // the hub stops carrying it — that falling edge (busy was true, now absent) is the one
  // moment we fetch directly, to pull the final "done"/idle state the hub won't push.
  precapUnsub = hub.subscribe((s) => {
    if (!precapOpen) return;
    if (s.precapture) _pcDraw(s.precapture);
    else if (precapBusy) _pcRun(() => api.precapture.status(model.profile.name, pcSig));
  });
  hub.kick();   // beat now so a busy worker shows immediately on open
}

// Hiding the panel does NOT cancel the worker (the Activity panel monitors/cancels it).
// Just stop polling and abort in-flight fetches; reopening rehydrates from the server.
function hidePrecap() {
  if (precapUnsub) { precapUnsub(); precapUnsub = null; }
  if (pcCtl) { pcCtl.abort(); pcCtl = null; }
  unregisterWorker("precap");
  precapOpen = false; precapStopping = false;
  $("precapBtn").classList.remove("active");
}

// Staged-data preview: one VTable per dataset (virtualized + searchable), reconciled IN
// PLACE so the 700ms poll doesn't churn the tables or reset scroll/search — each dataset's
// section + host is reused; setData only fires when its sample actually changes.
function renderPrecapData(dataEl, datasets) {
  datasets = datasets || [];
  if (!dataEl._ds) {
    dataEl._ds = new Map();   // dataset -> { section, label, host, _sig }
    dataEl._empty = document.createElement("p");
    dataEl._empty.className = "muted"; dataEl._empty.style.padding = "8px";
    dataEl._empty.textContent = "no data staged yet — process the frames to read them";
  }
  if (!datasets.length) {
    for (const [k, e] of dataEl._ds) { vtables.get(`pc:${k}`)?.destroy(); vtables.delete(`pc:${k}`); e.section.remove(); dataEl._ds.delete(k); }
    if (!dataEl.contains(dataEl._empty)) dataEl.appendChild(dataEl._empty);
    return;
  }
  if (dataEl.contains(dataEl._empty)) dataEl._empty.remove();
  // drop sections whose dataset is gone
  const want = new Set(datasets.map((d) => d.dataset));
  for (const [k, e] of dataEl._ds) if (!want.has(k)) { vtables.get(`pc:${k}`)?.destroy(); vtables.delete(`pc:${k}`); e.section.remove(); dataEl._ds.delete(k); }

  for (const d of datasets) {
    let e = dataEl._ds.get(d.dataset);
    if (!e) {
      const section = document.createElement("div"); section.className = "pc-ds";
      const label = document.createElement("div"); label.className = "pc-ds-h";
      const host = document.createElement("div"); host.className = "pc-ds-vt";
      section.append(label, host);
      e = { section, label, host, _sig: null }; dataEl._ds.set(d.dataset, e);
    }
    dataEl.appendChild(e.section);   // (re)append in server order
    const meta = `${d.count} row${d.count === 1 ? "" : "s"}`;
    if (e.label._meta !== meta) { e.label.innerHTML = `<b>${esc(d.dataset)}</b> <span class="muted">${esc(meta)}</span>`; e.label._meta = meta; }
    const rows = d.sample || [];
    const sig = `${d.count}|${JSON.stringify(rows)}`;   // skip setData when nothing changed (poll churn)
    if (e._sig === sig) continue;
    e._sig = sig;
    const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    const vt = vtableFor(`pc:${d.dataset}`, e.host);
    vt.pinned = null;   // fit the container height (datasets share pc-data, then scroll)
    vt.setData(cols, rows);
  }
}

function renderPrecap(node, st) {
  const phase = st.phase || "idle";
  const recording = phase === "recording";
  const processing = phase === "processing";
  const paused = phase === "paused";
  precapBusy = recording || processing || paused;   // gate modal dismissal
  // surface the backend worker in the log bar with an emergency kill
  if (precapBusy) registerWorker("precap", `precapture ${phase}`, () => api.precapture.cancel(model.profile.name).catch(() => {}));
  else unregisterWorker("precap");
  if (phase !== precapLastPhase) {                   // log phase transitions
    if (phase === "recording") log("precapture: recording…", "run");
    else if (phase === "recorded") log(`precapture: recorded ${st.frames} frames`, "ok");
    else if (phase === "processing") log("precapture: processing…", "run");
    else if (phase === "done") {
      const t = st.timing || {};
      log(`precapture done: ${st.processed} frames · ${t.ms_per_frame || 0} ms/frame on ${t.device || "cpu"} (decode ${t.decode_ms || 0} · classify ${t.classify_ms || 0} · read ${t.read_ms || 0}) · ${st.fps}/s`, "ok");
      // recognition breakdown: which window/state each frame classified to (no-match = no window)
      const rec = st.recognized || [];
      const recStr = rec.map((r) => `${r.miss ? "no-match" : r.key} ${r.count}`).join(" · ");
      if (recStr) log(`  recognized: ${recStr}`, rec.some((r) => !r.miss) ? "ok" : "warn");
      // staging: rows read vs dropped for an incomplete key, and what landed per dataset
      const ds = (st.datasets || []).map((d) => `${d.dataset} ${d.count}`).join(" · ") || "none";
      const nothingStaged = (st.read || 0) > 0 && !(st.datasets || []).length;
      log(`  staged: ${st.read || 0} read · ${st.no_key || 0} dropped (no key) · datasets: ${ds}`, nothingStaged ? "warn" : "ok");
    }
    else if (phase === "cancelled") log("precapture: cancelled", "warn");
    else if (phase === "saved") log("precapture: committed", "ok");
    // recording just finished -> flip to the loaded session's controls (process / save /
    // delete) so the just-recorded frames are ready to work with, on the detail page
    if (precapLastPhase === "recording" && phase !== "recording") { precapView = "loaded"; precapPage = "detail"; }
    precapLastPhase = phase;
  }
  // first paint: pick the pane from what's on disk — a session with frames opens loaded,
  // otherwise the new-recording pane
  if (precapView === null) precapView = (st.session && st.frames) ? "loaded" : "new";
  // a loaded session that vanished (deleted, none left) falls back to the new pane
  if (precapView === "loaded" && !st.session) precapView = "new";
  // first paint: a running worker opens straight to the detail page, otherwise the list
  if (precapPage === null) precapPage = precapBusy ? "detail" : "list";

  // closing always works now and cancels the run — say so on the button
  const x = node.closest(".modal")?.querySelector(".modal-x");
  if (x) x.title = precapBusy ? "close & cancel the run (Esc)" : "close (Esc)";
  if (!precapBusy) precapStopping = false;   // worker wound down -> clear the stopping state
  const pct = st.frames ? Math.round((100 * st.processed) / st.frames) : 0;
  const staged = (st.datasets || []).reduce((n, d) => n + d.count, 0);
  const busyRun = processing || paused;
  const canProcess = st.frames > 0 && !recording && !processing && !paused;

  // Paged skeleton built ONCE — list page = session list; detail page = back bar + the
  // selected pane. One page is shown at a time (precapPage); the back button returns to list.
  if (!node.querySelector(".pc-main")) {
    node.innerHTML = `<div class="pc-main">
        <div class="pc-page pc-page-list"><div class="pc-left"></div></div>
        <div class="pc-page pc-page-detail">
          <div class="pc-detail-head"><button class="pc-back" data-act="back" title="back to sessions">←</button><span class="pc-detail-title"></span><button class="pc-detail-del danger" data-act="delsess" title="delete session" hidden>${TRASH}</button></div>
          <div class="pc-right"></div>
        </div>
      </div>`;
  }
  const onList = precapPage === "list";
  node.querySelector(".pc-page-list").hidden = !onList;
  node.querySelector(".pc-page-detail").hidden = onList;
  renderPrecapLeft(node.querySelector(".pc-left"), st);
  // detail-page heading reflects the selected pane
  const dTitle = node.querySelector(".pc-detail-title");
  if (dTitle) dTitle.textContent = precapView === "new" ? "new session"
    : (st.session ? (st.label || fmtCaptureTime(st.session)) : "session");
  // delete (trash) lives in the detail head — only for a loaded session, locked while busy
  const dDel = node.querySelector(".pc-detail-del");
  if (dDel) {
    dDel.hidden = precapView !== "loaded" || !st.session;
    dDel.dataset.sid = st.session || "";
    dDel.disabled = (recording || busyRun) || !st.session;
  }

  // The right pane's STRUCTURE depends only on which pane is shown and whether a worker
  // is running. Rebuild its innerHTML only when that shape changes — otherwise the 700ms
  // poll would clobber the record inputs and steal focus while the user types in them.
  const right = node.querySelector(".pc-right");
  const shape = `${precapView}|${recording}|${busyRun}`;
  if (right.dataset.shape !== shape) {
    right.dataset.shape = shape;
    right.innerHTML = precapView === "new"
      ? `<div class="pc-opts">
           <label class="flab">max frames <input type="number" class="pc-frames" value="300" min="1"></label>
           <label class="flab">interval ms <input type="number" class="pc-interval" value="0" min="0"></label>
           <label class="flab">label <input type="text" class="pc-label" placeholder="(optional)"></label>
         </div>
         <div class="pc-ctl"></div>`
      : `<div class="pc-bar"></div>
         <div class="pc-ctl"></div>
         <div class="pc-progress"><div class="pc-fill"></div></div>
         <div class="pc-recog"></div>
         <div class="pc-data"></div>`;
  }

  const tm = st.timing || {};
  // A paused worker can be EITHER a recording (auto-scroll hit the list end) or a
  // processing run; st.kind disambiguates so the right counters/controls show.
  const recPaused = paused && st.kind === "recording";   // recording, auto-paused at list end
  const procLive = processing || (paused && st.kind === "processing");
  const recLive = recording || recPaused;
  // Live counters ONLY — show numbers while a worker is actually moving them. A recording
  // shows its frame count; a processing run shows processed/read/fps + timing. An
  // idle/done/just-loaded session shows nothing (static text is just noise).
  const stats = [];
  if (recLive || procLive) stats.push(`${st.frames} frames`);
  if (procLive) stats.push(`${st.processed} processed`, `${st.read || 0} read`, `${st.fps} /s`);
  const bar = right.querySelector(".pc-bar");   // absent in the new-session pane
  if (bar) bar.innerHTML = `
    ${stats.length ? `<span class="muted">${stats.join(" · ")}</span>` : ""}
    ${procLive ? `<span class="muted">· ${tm.ms_per_frame || 0} ms/frame (${esc(tm.device || "cpu")})</span>` : ""}
    ${procLive && st.window ? `<span class="conf-good" title="window/state recognised this frame">· ${esc(st.window)}/${esc(st.state)}</span>` : ""}
    ${recPaused ? `<span class="conf-warn">${PAUSE} auto-scroll reached the list end — resume to retry, or uncheck it</span>` : ""}
    ${st.warning ? `<span class="conf-warn">${WARN} ${esc(st.warning)}</span>` : ""}
    ${st.error ? `<span class="conf-bad">${esc(st.error)}</span>` : ""}`;
  // recognition tally: per-window/state frame counts (the "" key is a miss — no window matched)
  const recogEl = right.querySelector(".pc-recog");
  if (recogEl) {
    const rec = st.recognized || [];
    recogEl.innerHTML = rec.map((r) =>
      `<span class="pc-recog-chip${r.miss ? " miss" : ""}">${r.miss ? "no match" : esc(r.key)} · ${r.count}</span>`).join("");
  }
  // progress bar matters only WHILE processing — gone once done so it doesn't linger
  const prog = right.querySelector(".pc-progress");
  if (prog) {
    prog.hidden = !procLive;
    right.querySelector(".pc-fill").style.width = `${pct}%`;
  }

  // the record inputs are only present (and only editable) in the new-session pane
  right.querySelectorAll(".pc-opts input").forEach((i) => { i.disabled = recording; });

  const justSaved = phase === "saved";
  const anyRun = recording || busyRun;   // any worker running -> save/delete locked
  let ctl;
  if (precapView === "new") {
    // recording immediately flips to the loaded pane, so the new pane is just the trigger
    ctl = `<button data-act="record"><span class="ic ic-rec">●</span> record</button>`;
  } else {
    const proc = precapStopping ? `<button disabled>stopping…</button>`
      : recording ? `<button data-act="recstop"><span class="ic ic-rec">■</span> stop recording</button>`
      : processing ? `<button data-act="pause">‖ pause</button>`
      : paused ? `<button data-act="resume">► resume</button>${recPaused ? `<button data-act="recstop"><span class="ic ic-rec">■</span> stop recording</button>` : ""}`
      : `<button data-act="process" ${canProcess ? "" : "disabled"}>process${st.frames ? ` ${st.frames}` : ""}</button>`;
    // auto-scroll hit the list end -> the recording is done; offer stop, not discard
    const cancel = busyRun && !precapStopping && !recPaused ? `<button data-act="cancel" class="warn">cancel</button>` : "";
    // commit only makes sense when nothing's running AND processing has staged records —
    // hide it entirely while a worker is active or before the precapture's been processed
    // (keep showing it right after a commit for the "committed" feedback).
    const save = (anyRun || (!staged && !justSaved)) ? ""
      : `<button data-act="save" class="${justSaved ? "pc-saved" : ""}" ${(staged && !precapStopping && !justSaved) ? "" : "disabled"}>${justSaved ? "committed" : `commit${staged ? ` ${staged}` : ""}`}</button>`;
    ctl = `${proc}${cancel}${save}`;
  }
  const ctlEl = right.querySelector(".pc-ctl");
  // don't clobber a live INPUT the user is editing (the clicks field) on a poll tick;
  // a focused button must NOT block the rebuild (else post-save state wouldn't render)
  const editing = ctlEl.contains(document.activeElement) && document.activeElement.matches("input");
  if (!editing) ctlEl.innerHTML = ctl;

  const data = right.querySelector(".pc-data");
  if (data) renderPrecapData(data, st.datasets);
}

const PC_PAGE = 30;   // session rows rendered per window; grows by this much on scroll-to-bottom

// The left pane: "＋ new session" (the record-inputs pane) on top, then every saved
// recording, newest first. The selected item is highlighted; switching is locked while a
// worker is busy. Loading is whole-row; ✎ renames. Delete lives in the right pane.
//
// Reconciled IN PLACE — never rebuild innerHTML (like renderWorkers). The poll redraws on
// every busy tick; wiping the list would churn buttons and steal focus each tick. The new
// button + header are made once; rows are a keyed map, reused/reordered/updated in place.
function renderPrecapLeft(left, st) {
  if (!left._rows) {
    left._new = document.createElement("button");
    left._new.className = "pc-sess-new"; left._new.dataset.act = "newsess";
    left._new.title = "record a new session"; left._new.textContent = "＋ new session";
    const h = document.createElement("div");
    h.className = "pc-sess-h muted"; h.textContent = "sessions";
    left.append(left._new, h);
    left._head = h;           // header carries the all-sessions total image size
    // rows live in their own scroll box that FILLS the panel height; we render a window of
    // the newest sessions and grow it (load more) as the user scrolls toward the bottom, so
    // a huge session list never builds hundreds of rows up front. (＋new + header stay above.)
    left._rowsBox = document.createElement("div");
    left._rowsBox.className = "pc-sess-rows";
    left.appendChild(left._rowsBox);
    left._rows = new Map();   // sid -> { row, load, ren }
    left._renderN = PC_PAGE;  // how many rows are currently rendered
    left._rowsBox.addEventListener("scroll", () => {
      const b = left._rowsBox;
      if (b.scrollTop + b.clientHeight >= b.scrollHeight - 48 && left._renderN < precapSessions.length) {
        left._renderN += PC_PAGE;
        renderPrecapLeft(left, left._st);   // re-render with the bigger window
      }
    });
  }
  left._st = st;   // remembered so the scroll handler can re-render with the latest status
  left._new.classList.toggle("active", precapView === "new");
  left._new.disabled = precapBusy;

  // render only the newest _renderN sessions; the rest appear as you scroll (see above)
  const vis = precapSessions.slice(0, left._renderN);
  const want = new Set(vis.map((s) => s.id));
  for (const [sid, r] of left._rows) if (!want.has(sid)) { r.row.remove(); left._rows.delete(sid); }

  let i = 0;   // slot index into _rowsBox so rows are MOVED only when not already in place
  for (const s of vis) {
    let r = left._rows.get(s.id);
    if (!r) {
      const row = document.createElement("div");
      row.className = "pc-sess"; row.dataset.act = "loadsess"; row.dataset.sid = s.id; row.title = "load this session";
      const name = document.createElement("span"); name.className = "pc-sess-name";
      const meta = document.createElement("span"); meta.className = "muted pc-sess-meta";
      const ren = document.createElement("button");
      ren.className = "pc-sess-ren"; ren.dataset.act = "rensess"; ren.dataset.sid = s.id; ren.title = "rename"; ren.textContent = "✎";
      row.append(name, meta, ren);
      r = { row, name, meta, ren }; left._rows.set(s.id, r);
    }
    const at = left._rowsBox.children[i];        // keep DOM order = newest-first WITHOUT
    if (at !== r.row) left._rowsBox.insertBefore(r.row, at || null);   // detaching settled rows
    i++;
    r.row.dataset.label = s.label || "";   // source of truth for the rename input
    r.row.classList.toggle("active", precapView === "loaded" && s.id === st.session);
    if (!r.row._editing) {     // don't clobber the rename input mid-edit
      const nm = s.label || fmtCaptureTime(s.id);
      if (r.name.textContent !== nm) r.name.textContent = nm;
    }
    const meta = `${s.frames}f · ${fmtBytes(s.bytes || 0)} · ${s.records || 0} rec${s.saved_at ? ' · <span class="tc-ok">committed</span>' : ""}`;
    if (r.meta._html !== meta) { r.meta.innerHTML = meta; r.meta._html = meta; }   // touch DOM only on change
    r.ren.disabled = precapBusy;
  }
  // header shows the total image size across every session (touch DOM only on change)
  const total = precapSessions.reduce((a, s) => a + (s.bytes || 0), 0);
  const htxt = precapSessions.length ? `sessions · ${fmtBytes(total)}` : "sessions";
  if (left._head.textContent !== htxt) left._head.textContent = htxt;
}

// Human-readable byte size (1 KB = 1024 B). Whole numbers for B and >=100;
// one decimal otherwise — so "47f · 12.3 MB" reads cleanly in the session list.
function fmtBytes(n) {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let v = n, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${i === 0 || v >= 100 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

// Capture filenames are "YYYYMMDD-HHMMSS-ffffff.jpg" — pull the time out for display.
function fmtCaptureTime(name) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(name);
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : name;
}

// Pick which stashed captures a window uses — a thumbnail grid where each is toggled in or
// out of the window's image pages. "use N" commits the selection (in newest-first order, which
// becomes the page order); "capture new" appends a fresh grab. Multi-select, no blocking dialog.
async function openCaptureModal(winId) {
  const game = model.profile.name;
  const node = document.createElement("div");
  node.innerHTML = `<p class="muted" style="padding:12px">loading…</p>`;
  const modal = openModal({ title: `${winId} — choose images`, size: "data", node });
  // load the picked pages, flip to page 0, and refresh the canvas + label
  const apply = async (names) => {
    await api.setBindings(game, winId, names);
    winPage.set(winId, 0);
    if (!imageCanvases.has(winId)) await openImage(winId);
    else await loadImage(winId, false);
    updateImageLabel(winId);
  };
  try {
    const [caps, binds] = await Promise.all([api.listCaptures(game), api.getBindings(game)]);
    const cur = binds[winId];
    const sel = new Set(Array.isArray(cur) ? cur : (cur ? [cur] : []));
    // which windows each capture is bound to — current window tracked by live `sel`, the
    // rest from the persisted map. One image can be used by several windows (multi-bind).
    const usedBy = (name) => {
      const wins = sel.has(name) ? [winId] : [];
      for (const [w, v] of Object.entries(binds)) {
        if (w === winId) continue;
        const list = Array.isArray(v) ? v : (v ? [v] : []);
        if (list.includes(name)) wins.push(w);
      }
      return wins;
    };
    const draw = () => {
      const grid = caps.map((name) => {
        const wins = usedBy(name), label = wins.join(", ");
        return `
        <button class="cap-cell ${sel.has(name) ? "sel" : ""} ${wins.length ? "used" : ""}" data-name="${esc(name)}" title="${esc(name)}">
          <img loading="lazy" src="${api.captureUrl(game, name)}" alt="" />
          <span class="cap-time">${esc(fmtCaptureTime(name))}</span>
          <span class="cap-wins" title="${esc(label)}">${esc(label)}</span>
        </button>`;
      }).join("");
      node.innerHTML = `<div class="cap-head"><button class="cap-new">${CAMERA} capture new</button>
          <span class="muted">${sel.size} of ${caps.length} selected</span><span class="spacer"></span>
          <button class="cap-use" ${sel.size ? "" : "disabled"}>use ${sel.size || ""}</button></div>
        ${caps.length ? `<div class="cap-grid">${grid}</div>` : '<p class="cap-empty">no stashed captures yet</p>'}`;
      // toggle a cell in/out of the selection (modal redraw on click is fine — not a poll)
      node.querySelectorAll(".cap-cell").forEach((b) => b.addEventListener("click", () => {
        const nm = b.dataset.name;
        if (sel.has(nm)) sel.delete(nm); else sel.add(nm);
        draw();
      }));
      node.querySelector(".cap-use")?.addEventListener("click", async () => {
        await apply(caps.filter((c) => sel.has(c)));   // listing order (newest first) = page order
        modal.close();
      });
      node.querySelector(".cap-new").addEventListener("click", async () => {
        modal.close();
        try {
          const c = await api.capture(game);            // fresh grab → appended as a new last page
          const list = await api.bindingList(game, winId);
          list.push(c.name);
          await api.setBindings(game, winId, list);
          winPage.set(winId, list.length - 1);
          if (!imageCanvases.has(winId)) await openImage(winId);
          else await loadImage(winId, false);
          updateImageLabel(winId);
        } catch (e) { setStatus(String(e.message || e)); }
      });
    };
    draw();
  } catch (e) {
    node.innerHTML = `<p class="muted" style="padding:12px">${esc(String(e))}</p>`;
  }
}

export {
  pc, pcState, precapOpen, precapBusy,
  buildPrecap, showPrecap, hidePrecap, renderPrecap, renderPrecapData, renderPrecapLeft,
  openCaptureModal, fmtBytes, fmtCaptureTime, PC_PAGE,
};
