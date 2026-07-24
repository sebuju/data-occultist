// Precapture floating window — record/process/commit capture sessions in a movable panel.
// Extracted from main.js verbatim.
import * as api from "../../api.js";
import * as hub from "../../hub.js";
import { h, frag, TRASH, WARN, PAUSE } from "../../dom.js";
import { openModal } from "../../modal.js";
import { registerKey, SCOPE } from "../../inputbus.js";
import { makeReorderable, arrayMove } from "../../pretty/reorder.js";
import { fmtDateTimeSec } from "../../datefmt.js";
import { fmtBytes } from "../../bytefmt.js";
import { sessLabel, sessMeta } from "./live_sess.js";
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

let precapOpen = false;    // panel currently open/active (read by livewin: one OCR consumer at a time)
let pc = null;             // the createFloatWin instance (built once)
let pcNode = null;         // the .precap content node — MOVED between hosts (floatwin / pretty widget)
// Host adapter: pcNode mounts into whichever host is shown (floatwin body in graph, a
// pretty-widget host in pretty view). precapOpen already gates render; the adapter abstracts
// the chrome the panel used to poke directly (title, the topbar button, fit, close).
let A = null;
let winAdapter = null;     // floatwin-backed adapter (reclaimed on the panel's onShow)
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

// Shared "refetch as frames land" guard for a per-session cache (frame times / reclog steps
// below are the two callers). Gate on the highest `want` already REQUESTED, not on what the
// response came back holding: refetching whenever `have < want` (have = length of the received
// payload) re-trips on the fetch's own completion redraw whenever the server-side count the
// payload is keyed off (e.g. reclog's steps, which lag the frame counter until each step's
// trace line flushes) never quite reaches `want` — the success callback repaints the panel,
// the panel re-derives the same `want`, `have` is still short, and it fetches again with zero
// delay, hammering the server. Gating on `lastWant` instead means each distinct `want` is
// requested at most once, so the loop always terminates even when the payload permanently
// undercounts. `state` = { sid, [dataField], busy, lastWant }; `fetchFn(game, sid)` resolves
// the raw response; `onResult(r)` stores whatever shape the caller wants into `state[dataField]`
// (and may run an extra side effect, e.g. repainting an open lightbox).
function ensureLiveFetch(state, dataField, game, sid, want, fetchFn, onResult) {
    if (!sid) return null;
    if (state.sid !== sid) { state.sid = sid; state[dataField] = null; state.busy = false; state.lastWant = -1; }
    if (!state.busy && (state[dataField] === null || (want != null && want > state.lastWant))) {
        state.busy = true;
        state.lastWant = want != null ? want : state.lastWant;
        fetchFn(game, sid).then((r) => {
            if (state.sid !== sid) return;                   // session switched mid-fetch
            onResult(r);
            state.busy = false;
            if (precapLast) _pcDraw(precapLast);
        }).catch(() => { state.busy = false; });
    }
    return state[dataField];
}
// Frame capture times (file mtimes) of the active session, reused by both the frames-grid
// header and the processing-view stats bar. `want` is the live frame count: we (re)fetch when
// the session changes OR more frames have landed than we last asked for — so the span/fps keep
// climbing WHILE a recording writes frames, and settle right after it stops. On each load it
// repaints the panel (and any open frame viewer) so the numbers appear without a poll.
let pcTimes = { sid: null, times: null, busy: false, lastWant: -1 };
function ensureFrameTimes(game, sid, want) {
    return ensureLiveFetch(pcTimes, "times", game, sid, want, api.precapture.frameTimes, (r) => {
        pcTimes.times = r.times || [];
        if (pcLightbox && !pcLightbox.el.hidden && pcLightbox.sid === sid) setFramesLightboxIndex(pcLightbox.idx);
    });
}
// Per-step record trace (reclog.jsonl) of the active session, keyed by frame index, for the
// per-thumbnail timing column. Same live-refetch discipline as ensureFrameTimes: refetch when the
// session changes or more frames have landed than we last asked for, so timings fill in as the
// recording writes. Returns a Map<frameIndex, step> (a step's frame index is `frames - 1`).
let pcRec = { sid: null, map: null, busy: false, lastWant: -1 };
function ensureReclog(game, sid, want) {
    return ensureLiveFetch(pcRec, "map", game, sid, want, api.precapture.reclog, (r) => {
        const m = new Map();
        for (const s of (r.steps || [])) if (Number.isInteger(s.frames)) m.set(s.frames - 1, s);
        pcRec.map = m;
    });
}
// "22s · 5.0/s" — recording span (first→last frame) and its effective capture rate; null until
// at least two frame times are known.
function spanFpsText(times) {
    if (!times || times.length < 2) return null;
    const span = times[times.length - 1] - times[0];
    const fps = span > 0 ? (times.length - 1) / span : 0;   // n-1 intervals across the span
    return `${fmtSpan(span)} · ${fps.toFixed(1)}/s`;
}
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
    pcNode.replaceChildren(h("p", { class: "muted", style: "padding:12px" }, "loading…"));
    pc = createFloatWin({
        id: "precap", title: "precapture", state: pcState, bothAxes: true,
        onShow: () => { mountPrecap(winAdapter); showPrecap(); }, onHide: hidePrecap, onPersist: () => persist.layout(),
    });
    winAdapter = {
        host: pc.body, fit: () => pc.fitHeight(), close: () => pc.setVisible(false),
        setTitle: (s) => { const t = pc.el.querySelector(".fw-title"); if (t) t.textContent = s; },
        setActive: (on) => $("precapBtn")?.classList.toggle("active", on),
    };
    mountPrecap(winAdapter);

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
        if (precapBusy && (a === "newsess" || a === "loadsess" || a === "rensess" || a === "delsess" || a === "clearsess")) return;
        const mf = +pcNode.querySelector(".pc-frames")?.value || 1000;
        const iv = +pcNode.querySelector(".pc-interval")?.value || 0;
        const label = pcNode.querySelector(".pc-label")?.value || "";
        if (a === "recstop" || a === "cancel") { precapStopping = true; b.disabled = true; b.textContent = "stopping…"; }
        // back to the list -> stop any in-progress recording first (leaving the pane must not
        // leave a recorder running headless), then redraw + re-pull the sessions so their
        // frame/record counts reflect whatever the just-left detail pane changed
        if (a === "back") {
            const p = precapLast || {};
            if (p.phase === "recording" || (p.phase === "paused" && p.kind === "recording")) {
                precapStopping = true; _pcRun(() => api.precapture.recordStop(game, pcSig)); hub.kick();
            }
            precapPage = "list"; if (precapLast) _pcDraw(precapLast); _pcLoadSessions();
        }
        else if (a === "newsess") { precapView = "new"; precapPage = "detail"; if (precapLast) _pcDraw(precapLast); }
        // recordStart creates+persists a new session server-side, so leave the "new" pane at
        // once and show it as the active loaded session (its row appears via loadSessions).
        // recordStart takes a beat to spin up the worker -> show the button busy meanwhile.
        else if (a === "record") { b.classList.add("reading"); b.disabled = true; setLiveMode(false); const ap = !!pcNode.querySelector(".pc-autoproc")?.checked; precapView = "loaded"; precapPage = "detail"; _pcRun(async () => { const st = await api.precapture.recordStart(game, mf, iv, label, ap, pcSig); _pcLoadSessions(); return st; }); }
        else if (a === "recstop") _pcRun(() => api.precapture.recordStop(game, pcSig));
        else if (a === "process") { setLiveMode(false); _pcRun(() => api.precapture.processStart(game, pcSig)); }
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
                setTimeout(() => { b.dataset.armed = "0"; b.replaceChildren(TRASH()); b.classList.remove("armed"); }, 2500);
                return;
            }
            b.dataset.armed = "0"; b.replaceChildren(TRASH()); b.classList.remove("armed");   // clear the confirm now — the shared button gets repointed to the next session
            precapPage = "list"; precapView = null;   // deleted session is gone -> back to the list
            _pcSessAct(api.precapture.deleteSession(game, sid, pcSig));
        }
        else if (a === "clearsess") {
            if (b.dataset.armed !== "1") {   // inline confirm — armed two-click, no blocking dialog
                b.dataset.armed = "1"; b.textContent = "clear all?"; b.classList.add("armed");
                setTimeout(() => { b.dataset.armed = "0"; b.textContent = "clear"; b.classList.remove("armed"); }, 2500);
                return;
            }
            b.dataset.armed = "0"; b.textContent = "clear"; b.classList.remove("armed");
            precapPage = "list"; precapView = null;   // every session gone -> back to the list
            _pcSessAct(api.precapture.deleteAllSessions(game, pcSig));
        }
        else if (a === "rensess") beginRename(b.closest(".pc-sess"), sid);
        // worker state just changed -> beat the hub now so the tasks panel + precap indicator
        // reflect it without waiting out the cadence
        if (["record", "recstop", "process", "pause", "resume", "cancel"].includes(a)) hub.kick();
    });
}

// (Re-)parent pcNode into `adapter.host`. The node moves intact, so the session list + its
// keyed rows survive a host switch (rule 1: no rebuild).
function mountPrecap(adapter) {
    if (!adapter) return;
    A = adapter;
    if (pcNode.parentElement !== adapter.host) adapter.host.appendChild(pcNode);
}

async function showPrecap() {
    const game = model.profile.name;
    if (!game) { setStatus("load a game first"); A?.close?.(); return; }
    // NB: merely OPENING the panel must NOT stop live — an idle precap panel doesn't compete for
    // OCR, and this hook also fires on a pure visibility restore (mode switch, pretty embed), where
    // stopping live would be a surprise. The mutual exclusion is enforced where precapture actually
    // RUNS (record/process below) instead.
    precapOpen = true;
    precapStopping = false; precapView = null; precapPage = null;
    // reopening starts from the latest few sessions again — don't rebuild whatever big window
    // a prior scroll grew the list to (keeps the panel light + sized for ~5 rows on open)
    const left = pcNode.querySelector(".pc-left");
    if (left && left._rows) left._renderN = PC_FIRST;
    A?.setActive?.(true);
    A?.setTitle?.(`precapture: ${game}`);
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
    // re-fit once layout settles and again once web fonts swap in — a first-open fit can measure
    // rows before the font loads and come out short (resetting later reads correct because the
    // font is already in by then).
    requestAnimationFrame(() => fitPrecapHeight());
    document.fonts?.ready?.then(() => { if (precapOpen) fitPrecapHeight(); });
}

// Hiding the panel does NOT cancel the worker (the Activity panel monitors/cancels it).
// Just stop polling and abort in-flight fetches; reopening rehydrates from the server.
function hidePrecap() {
    if (precapUnsub) { precapUnsub(); precapUnsub = null; }
    if (pcCtl) { pcCtl.abort(); pcCtl = null; }
    unregisterWorker("precap");
    closeFramesLightbox();   // never leave the frame viewer floating over a hidden panel
    precapOpen = false; precapStopping = false;
    A?.setActive?.(false);
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
        if (e.label._meta !== meta) {
            e.label._meta = meta;
            e.label.replaceChildren(h("b", d.dataset), " ", h("span", { class: "muted" }, meta));
        }
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

// Thumbnail grid of a session's recorded frames (shown for an un-processed loaded session).
// `head` gets the frame count (top of the pane); `grid` gets one keyed <img> per frame index,
// reconciled IN PLACE and reused across polls (images are lazy so off-screen frames aren't
// fetched). Capped so a huge recording never builds thousands of nodes (header shows the true
// total). Zero frames -> a placeholder. Clicking a thumbnail opens the full-size viewer.
const PC_FRAME_CAP = 400;
// Human duration between first and last frame: "22s", "1m 05s". A span, not a clock time
// (rule 9 is about dates/times-of-day), so it's fine to format inline here.
function fmtSpan(sec) {
    sec = Math.max(0, Math.round(sec));
    if (sec < 60) return `${sec}s`;
    const m = Math.floor(sec / 60), s = sec % 60;
    return s ? `${m}m ${String(s).padStart(2, "0")}s` : `${m}m`;
}
// Single-row frames header: "111 frames · 22s · 5.0/s" — count, then (once the frame times
// have loaded) the recording span and its effective frames-per-second.
function framesHeadText(total, times) {
    const base = total === 0 ? "0 frames"
        : total > PC_FRAME_CAP ? `${total} frames — showing first ${PC_FRAME_CAP}`
        : `${total} frame${total === 1 ? "" : "s"}`;
    const sf = spanFpsText(times);
    return sf ? `${base} · ${sf}` : base;
}
function renderPrecapFrames(grid, head, st) {
    const game = model.profile.name, sid = st.session;
    const total = st.frames || 0;
    const n = Math.min(total, PC_FRAME_CAP);
    const times = ensureFrameTimes(game, sid, total);   // refetches as frames land; drives header span/fps + viewer stamps
    if (head) {
        const htxt = framesHeadText(total, times);
        if (head.textContent !== htxt) head.textContent = htxt;
    }
    const rec = ensureReclog(game, sid, Math.max(0, total - 1));   // steps = frames-1 (frame 0 is the top, no step)
    if (!grid._cells) { grid._cells = new Map(); grid._sid = null; grid._ph = null; }
    if (grid._sid !== sid) { grid._sid = sid; grid._cells.clear(); grid._ph = null; grid.replaceChildren(); }   // new session -> fresh grid
    grid._total = total;
    if (total === 0) {   // nothing recorded yet -> centered placeholder (see .pc-frames-grid.empty)
        grid.classList.add("empty");
        if (!grid._ph) { grid._ph = h("div", { class: "pc-frames-empty muted" }, "no frames captured yet — record to fill this"); grid.replaceChildren(grid._ph); grid._cells.clear(); }
        return;
    }
    if (grid._ph) { grid._ph.remove(); grid._ph = null; }
    grid.classList.remove("empty");
    const keepScroll = grid.scrollTop;   // a poll must NOT yank the list to the top (rule 1); pin it
    for (let i = 0; i < n; i++) {
        let cell = grid._cells.get(i);
        if (!cell) {   // build the row ONCE (thumbnail left, timing right); reused across polls
            const img = h("img", {
                class: "pc-frame", loading: "lazy", src: api.precaptureFrameUrl(game, sid, i, 256),
                alt: "", title: `frame ${i + 1} — click to view`,
                onClick: () => openFramesLightbox(model.profile.name, grid._sid, grid._total, i),
            });
            const time = h("div", { class: "pc-frame-time" });
            const row = h("div", { class: "pc-frame-row" }, img, time);
            cell = { row, time, key: null };
            grid._cells.set(i, cell); grid.appendChild(row);
        }
        // reconcile ONLY the timing text when it changes (poll-safe, rule 1)
        const key = frameTimeKey(i, rec ? rec.get(i) : undefined);
        if (cell.key !== key) { cell.key = key; cell.time.replaceChildren(...frameTimeNodes(i, rec ? rec.get(i) : undefined)); }
    }
    for (const [i, cell] of grid._cells) if (i >= n) { cell.row.remove(); grid._cells.delete(i); }   // shrank
    if (grid.scrollTop !== keepScroll) grid.scrollTop = keepScroll;   // restore after any relayout/refit
}
// Per-frame timing cell content. Frame 0 is the top shot (no step); each later frame maps to its
// reclog step by index. `key` gates the DOM rebuild so polls don't churn unchanged rows.
function frameTimeKey(i, step) {
    if (i === 0) return "top";
    if (!step) return `f${i}`;
    return `${step.period_ms}|${step.moved}|${step.stall}|${step.pos}`;
}
function frameTimeNodes(i, step) {
    const num = h("div", { class: "pc-ft-num" }, `#${i + 1}`);   // image number (1-based)
    if (i === 0) return [num, h("div", { class: "pc-ft-sub" }, "top of list")];
    if (!step) return [num, h("div", { class: "pc-ft-sub" }, "…")];
    const period = step.period_ms != null ? `${Math.round(step.period_ms)} ms` : "—";
    const stalled = step.moved === false;
    const sub = `${stalled ? `stall ${step.stall}` : "moved"}${step.pos != null ? ` · pos ${step.pos}` : ""}`;
    return [h("div", { class: "pc-ft-num" }, `#${i + 1} · ${period}`),
            h("div", { class: stalled ? "pc-ft-sub pc-ft-warn" : "pc-ft-sub" }, sub)];
}

// ---- full-size frame viewer (lightbox) ------------------------------------
// A fullscreen overlay (built once, reused) showing one frame nearly screen-sized with its
// name. Close: ✕ / Esc / backdrop click. Navigate: ‹ › buttons / Left+Right arrows (wraps).
let pcLightbox = null;
function openFramesLightbox(game, sid, total, startIdx) {
    if (!total) return;
    ensureFrameTimes(game, sid, total);   // warm the per-frame stamps (may already be cached)
    if (!pcLightbox) {
        const img = h("img", { class: "pc-lb-img", alt: "" });
        const name = h("div", { class: "pc-lb-name" });
        const stage = h("div", { class: "pc-lb-stage" }, img);
        const closeBtn = h("button", { class: "pc-lb-close", title: "close (Esc)", "aria-label": "close" }, "✕");
        const prev = h("button", { class: "pc-lb-nav pc-lb-prev", title: "previous (←)", "aria-label": "previous" }, "‹");
        const next = h("button", { class: "pc-lb-nav pc-lb-next", title: "next (→)", "aria-label": "next" }, "›");
        const el = h("div", { class: "pc-lightbox", hidden: true }, closeBtn, prev, stage, next, name);
        document.body.appendChild(el);
        pcLightbox = { el, img, name, idx: 0, total: 0, game: "", sid: "" };
        closeBtn.onclick = closeFramesLightbox;
        prev.onclick = (e) => { e.stopPropagation(); stepFramesLightbox(-1); };
        next.onclick = (e) => { e.stopPropagation(); stepFramesLightbox(1); };
        // click the dark backdrop (not the image itself) closes
        el.addEventListener("click", (e) => { if (e.target === el || e.target === stage) closeFramesLightbox(); });
        // Frames-lightbox nav on the central bus: priority 120 (above the graph shortcuts + modal, so
        // A/D page frames instead of nudging a node) and CONSUMING (stop), active only while the
        // lightbox is visible. Registered once with the lightbox element (created lazily here).
        registerKey({
            scope: SCOPE.ANY, priority: 120, stop: true,
            when: () => pcLightbox && !pcLightbox.el.hidden,
            run: (e) => {
                const k = e.key.toLowerCase();
                if (e.key === "Escape") { e.preventDefault(); closeFramesLightbox(); return true; }
                if (e.key === "ArrowLeft" || k === "a") { e.preventDefault(); stepFramesLightbox(-1); return true; }
                if (e.key === "ArrowRight" || k === "d") { e.preventDefault(); stepFramesLightbox(1); return true; }
                return false;
            },
        });
    }
    Object.assign(pcLightbox, { game, sid, total, ts: fmtSessionStamp(sid) });
    setFramesLightboxIndex(Math.max(0, Math.min(startIdx, total - 1)));
    pcLightbox.el.hidden = false;
}
function stepFramesLightbox(d) {
    if (!pcLightbox || pcLightbox.el.hidden) return;
    let i = pcLightbox.idx + d;
    if (i < 0) i = pcLightbox.total - 1;             // wrap around both ends
    if (i >= pcLightbox.total) i = 0;
    setFramesLightboxIndex(i);
}
function setFramesLightboxIndex(i) {
    const lb = pcLightbox;
    lb.idx = i;
    lb.img.src = api.precaptureFrameUrl(lb.game, lb.sid, i);
    // per-frame capture stamp (this frame's own mtime, from the shared cache) — falls back to
    // the session start time only until the frame times have loaded
    const times = pcTimes.sid === lb.sid ? pcTimes.times : null;
    const t = times && times[i];
    const ts = t ? fmtDateTimeSec(t * 1000) : lb.ts;
    lb.name.replaceChildren(frag(
        `${String(i).padStart(5, "0")}.jpg · ${i + 1} / ${lb.total}`,
        ts ? h("span", { class: "pc-lb-ts" }, ts) : null));
}
// Session id is "YYYYMMDD-HHMMSS-ffffff" (the recording's capture time) -> dd/mm/yy HH:MM:SS.
function fmtSessionStamp(sid) {
    const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(sid || "");
    return m ? fmtDateTimeSec(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`) : "";
}
function closeFramesLightbox() {
    if (pcLightbox) { pcLightbox.el.hidden = true; pcLightbox.img.removeAttribute("src"); }
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
        else if (phase === "paused" && st.kind === "recording")
            log(`precapture: auto-scroll done — reached list end (${st.frames} frames)`, "ok");
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
        node.replaceChildren(
            h("div", { class: "pc-main" },
                h("div", { class: "pc-page pc-page-list" }, h("div", { class: "pc-left" })),
                h("div", { class: "pc-page pc-page-detail" },
                    h("div", { class: "pc-detail-head" },
                        h("button", { class: "pc-back", dataset: { act: "back" }, title: "back to sessions" }, "←"),
                        h("span", { class: "pc-detail-title" }),
                        h("button", { class: "pc-detail-del danger", dataset: { act: "delsess" }, title: "delete session", hidden: true }, TRASH())),
                    h("div", { class: "pc-right" }))));
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
        // one shared button, repointed per session -> a stale armed "delete?" must never carry
        // over to a different session (looks like the wrong one is armed for a moment)
        if (dDel.dataset.sid !== (st.session || "") && dDel.dataset.armed === "1") {
            dDel.dataset.armed = "0"; dDel.replaceChildren(TRASH()); dDel.classList.remove("armed");
        }
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
        if (precapView === "new") {
            right.replaceChildren(
                h("div", { class: "pc-opts" },
                    h("label", { class: "flab" }, "max frames ", h("input", { type: "number", class: "pc-frames", value: "1000", min: "1" })),
                    h("label", { class: "flab" }, "target ms ", h("input", { type: "number", class: "pc-interval", value: "500", min: "0" })),
                    h("label", { class: "flab" }, "label ", h("input", { type: "text", class: "pc-label", placeholder: "(optional)" })),
                    h("label", { class: "flab", title: "process the frames automatically when auto-scroll reaches the list end" }, "auto-process", h("input", { type: "checkbox", class: "pc-autoproc" }))),
                h("div", { class: "pc-ctl" }));
        } else {
            // frames count on top, then live bar/recog/progress, the frame grid (or data tables)
            // fills the middle, and the run control (process / stop recording) is pinned to the
            // BOTTOM (margin-top:auto) so "stop recording" is always visible while frames scroll.
            right.replaceChildren(
                h("div", { class: "pc-frames-h muted", hidden: true }),
                h("div", { class: "pc-bar" }),
                h("div", { class: "pc-recog" }),
                h("div", { class: "pc-progress" }, h("div", { class: "pc-fill" })),
                h("div", { class: "pc-frames-grid", hidden: true }),
                h("div", { class: "pc-data" }),
                h("div", { class: "pc-ctl" }));
        }
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
    if (procLive) stats.push(`${st.frames} frames`);   // recording's frame count lives in the frames-view header now
    if (procLive) stats.push(`${st.processed} processed`, `${st.read || 0} read`, `${st.fps} /s`);
    // one stat per row (.pc-bar is a column) — each counter, timing, window/state, and
    // warning/error is its own line instead of a single ·-joined run
    const barRows = stats.map((s) => h("span", { class: "muted" }, s));
    // recording capture span + rate (first→last frame) — same stat the frames-grid header shows,
    // surfaced here too so it stays visible once a session moves into the processing view
    if (procLive) {
        const cap = spanFpsText(ensureFrameTimes(model.profile.name, st.session, st.frames));
        if (cap) barRows.push(h("span", { class: "muted" }, `captured ${cap}`));
    }
    if (procLive) barRows.push(h("span", { class: "muted" }, `${tm.ms_per_frame || 0} ms/frame (${tm.device || "cpu"})`));
    if (procLive && st.window) barRows.push(h("span", { class: "conf-good", title: "window/state recognised this frame" }, `${st.window}/${st.state}`));
    if (recLive && st.auto_process) barRows.push(h("span", { class: "muted" }, "auto-process when auto-scroll ends"));
    // recording: make the step-and-shoot LOOP TIMING visible so a hitch is measured, not guessed.
    // cycle = one scroll+settle+write; max flags the worst stall; clicks = current self-tuned step.
    // record-loop timing — shown while recording AND kept visible after stop (never reset here),
    // so the last run's cadence stays readable.
    {
        const r = st.rec || {};
        if (r.cycle_ms != null) barRows.push(h("span", { class: "muted" },
            `period ${r.cycle_ms}ms (dwell ${r.wait_ms}) · worst ${r.max_cycle_ms}ms · ${r.clicks}-notch`));
    }
    if (recPaused) barRows.push(h("span", { class: "conf-warn" }, PAUSE(), " auto-scroll reached the list end — resume to retry, or stop recording"));
    if (st.warning) barRows.push(h("span", { class: "conf-warn" }, WARN(), " ", st.warning));
    if (st.error) barRows.push(h("span", { class: "conf-bad" }, st.error));
    const bar = right.querySelector(".pc-bar");   // absent in the new-session pane
    if (bar) { bar.replaceChildren(...barRows); bar.hidden = !barRows.length; }   // no live stats -> collapse (no empty gap)
    // recognition tally: per-window/state frame counts (the "" key is a miss — no window matched)
    const recogEl = right.querySelector(".pc-recog");
    if (recogEl) {
        const rec = st.recognized || [];
        recogEl.hidden = !rec.length;   // nothing recognised yet -> collapse
        recogEl.replaceChildren(...rec.map((r) =>
            h("span", { class: "pc-recog-chip" + (r.miss ? " miss" : "") }, `${r.miss ? "no match" : r.key} · ${r.count}`)));
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
    const recBtn = (act, glyph, label) =>
        h("button", { dataset: { act } }, h("span", { class: "ic ic-rec" }, glyph), " " + label);
    let ctlNodes;
    if (precapView === "new") {
        // recording immediately flips to the loaded pane, so the new pane is just the trigger
        ctlNodes = [recBtn("record", "●", "record")];
    } else {
        const proc = precapStopping ? h("button", { disabled: true }, "stopping…")
            : recording ? recBtn("recstop", "■", "stop recording")
            : processing ? h("button", { dataset: { act: "pause" } }, "‖ pause")
            : paused ? frag(h("button", { dataset: { act: "resume" } }, "► resume"), recPaused ? recBtn("recstop", "■", "stop recording") : null)
            : h("button", { dataset: { act: "process" }, disabled: !canProcess }, `process${st.frames ? ` ${st.frames}` : ""}`);
        // auto-scroll hit the list end -> the recording is done; offer stop, not discard
        const cancel = busyRun && !precapStopping && !recPaused ? h("button", { dataset: { act: "cancel" }, class: "warn" }, "cancel") : null;
        // commit only makes sense when nothing's running AND processing has staged records —
        // hide it entirely while a worker is active or before the precapture's been processed
        // (keep showing it right after a commit for the "committed" feedback).
        const save = (anyRun || (!staged && !justSaved)) ? null
            : h("button", { dataset: { act: "save" }, class: justSaved ? "pc-saved" : null, disabled: !(staged && !precapStopping && !justSaved) },
                justSaved ? "committed" : `commit${staged ? ` ${staged}` : ""}`);
        ctlNodes = [proc, cancel, save];
    }
    const ctlEl = right.querySelector(".pc-ctl");
    ctlEl.replaceChildren(...ctlNodes.filter(Boolean));

    // an un-processed loaded session (nothing staged yet) shows its captured frames as a
    // thumbnail grid — so you can eyeball what was recorded before spending OCR on it. Empty
    // shows a placeholder. Once processed (datasets present) the data tables take over; while a
    // processing run is live the progress view owns the pane.
    const showFrames = precapView === "loaded" && st.session && !(st.datasets || []).length && !procLive;
    const gridEl = right.querySelector(".pc-frames-grid");
    const headEl = right.querySelector(".pc-frames-h");
    if (headEl) headEl.hidden = !showFrames;
    if (gridEl) { gridEl.hidden = !showFrames; if (showFrames) renderPrecapFrames(gridEl, headEl, st); }
    const data = right.querySelector(".pc-data");
    if (data) { data.hidden = showFrames; renderPrecapData(data, st.datasets); }
    const gridScroll = gridEl && showFrames ? gridEl.scrollTop : null;   // fit resizes the panel -> can drop scroll
    fitPrecapHeight();   // size the panel to what it's showing (skipped once the user resizes it)
    if (gridScroll != null && gridEl.scrollTop !== gridScroll) gridEl.scrollTop = gridScroll;   // pin it back
}

// Auto-fit delegates to the host adapter (floatwin height-fit in graph; no-op in a pretty widget).
function fitPrecapHeight() { A?.fit?.(); }

const PC_FIRST = 5;   // session rows shown on (re)open — the rest load as you scroll down
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
        // rows live in their own scroll box that FILLS the panel height; we render a window of
        // the newest sessions and grow it (load more) as the user scrolls toward the bottom, so
        // a huge session list never builds hundreds of rows up front. (＋new on top, footer below.)
        left._rowsBox = document.createElement("div");
        left._rowsBox.className = "pc-sess-rows";
        // footer pinned at the BOTTOM, right-justified: the all-sessions total size + a clear-all
        // button (armed two-click). Header text carries the running total image size.
        left._head = document.createElement("span");
        left._head.className = "pc-sess-h muted"; left._head.textContent = "sessions";
        left._clear = document.createElement("button");
        left._clear.className = "pc-sess-clear danger"; left._clear.dataset.act = "clearsess";
        left._clear.title = "remove all sessions"; left._clear.textContent = "clear";
        left._foot = document.createElement("div");
        left._foot.className = "pc-sess-foot";
        left._foot.append(left._head, left._clear);
        left.append(left._new, left._rowsBox, left._foot);
        left._rows = new Map();   // sid -> { row, load, ren }
        left._renderN = PC_FIRST;  // how many rows are currently rendered (grows on scroll)
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
        const committed = !!s.saved_at;
        const sig = `${s.frames}|${s.bytes || 0}|${s.records || 0}|${committed ? 1 : 0}`;   // value sig: touch DOM only on change
        if (r.meta._sig !== sig) {
            r.meta._sig = sig;
            const txt = `${s.frames}f · ${fmtBytes(s.bytes || 0)} · ${s.records || 0} rec`;
            r.meta.replaceChildren(frag(txt, committed ? " · " : null, committed ? h("span", { class: "tc-ok" }, "committed") : null));
        }
        r.ren.disabled = precapBusy;
    }
    // footer shows the total image size across every session (touch DOM only on change)
    const total = precapSessions.reduce((a, s) => a + (s.bytes || 0), 0);
    const htxt = precapSessions.length ? `${precapSessions.length} sessions · ${fmtBytes(total)}` : "";
    if (left._head.textContent !== htxt) left._head.textContent = htxt;
    left._clear.disabled = precapBusy;
    left._clear.hidden = !precapSessions.length;   // nothing to clear -> hide it
    // no sessions -> collapse the rows box + footer entirely (nothing to show)
    const empty = !precapSessions.length;
    left._rowsBox.hidden = empty;
    left._foot.hidden = empty;
    // The rows box is height-capped (CSS), so a small first window might not overflow it — then
    // there's nothing to scroll and the load-more handler can never fire. If more sessions remain
    // and the box isn't scrollable yet, grow the window (once per frame) until it is. Measured
    // after layout settles; a no-op once the box overflows, so it stays quiet in steady state.
    // setTimeout (not rAF): the panel is height-fitted AFTER this render returns, and rAF is
    // frozen in a backgrounded tab — a timer still fires (throttled) so the fill can't get stuck.
    if (!empty && left._renderN < precapSessions.length && !left._fillT) {
        left._fillT = setTimeout(() => {
            left._fillT = 0;
            const b = left._rowsBox;
            if (!b.hidden && b.scrollHeight <= b.clientHeight + 4 && left._renderN < precapSessions.length) {
                left._renderN += PC_PAGE;
                renderPrecapLeft(left, left._st);
            }
        }, 0);
    }
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
    node.replaceChildren(h("p", { class: "muted", style: "padding:12px" }, "loading…"));
    // load the picked pages, flip to page 0, and refresh the canvas + label
    const apply = async (names) => {
        await api.setBindings(game, winId, names);
        winPage.set(winId, 0);
        if (!imageCanvases.has(winId)) await openImage(winId);
        else await loadImage(winId, false);
        updateImageLabel(winId);
    };
    let order = [], dirty = false;
    const orderedSel = () => order.filter((n) => caps.includes(n));   // guard against stale names
    // save on ANY close (×, Esc, backdrop) — only if something changed. Fire-and-forget: apply
    // reloads the canvas + label itself, and onClose isn't awaited.
    const modal = openModal({
        title: `${winId} — choose images`, size: "large", node,
        onClose: () => { if (dirty) apply(orderedSel()).catch((e) => setStatus(String(e.message || e))); },
    });
    let caps = [], binds = {};
    try {
        [caps, binds] = await Promise.all([api.listCaptures(game), api.getBindings(game)]);
        const cur = binds[winId];
        // chosen captures in page order (page 0 = order[0]). Selection membership = order.includes.
        order = Array.isArray(cur) ? [...cur] : (cur ? [cur] : []);
        // toggle a pool cell in/out of the selection; a fresh pick appends to the end (last page).
        const toggle = (name) => {
            const i = order.indexOf(name);
            if (i >= 0) order.splice(i, 1); else order.push(name);
            dirty = true; draw();
        };
        // which windows each capture is bound to — current window tracked by live `order`, the
        // rest from the persisted map. One image can be used by several windows (multi-bind).
        const usedBy = (name) => {
            const wins = order.includes(name) ? [winId] : [];
            for (const [w, v] of Object.entries(binds)) {
                if (w === winId) continue;
                const list = Array.isArray(v) ? v : (v ? [v] : []);
                if (list.includes(name)) wins.push(w);
            }
            return wins;
        };
        // fresh grab → appended as the last page and left selected; the picker stays open and
        // close persists it (save-on-close owns the commit).
        const onCapNew = async () => {
            try {
                const c = await api.capture(game);
                if (!caps.includes(c.name)) caps.unshift(c.name);   // newest-first listing order
                if (!order.includes(c.name)) order.push(c.name);
                dirty = true; draw();
            } catch (e) { setStatus(String(e.message || e)); }
        };
        // one thumb factory shared by both grids: badgeNum (1-based page order) shown only when set.
        // Hovering a thumb (either grid) drives the large preview on the right.
        const cell = (name, badgeNum, onClick) => {
            const wins = usedBy(name), label = wins.join(", ");
            return h("button", {
                class: "cap-cell" + (order.includes(name) ? " sel" : "") + (wins.length ? " used" : ""),
                dataset: { name }, title: name, onClick, onMouseEnter: () => setPreview(name),
            },
                h("img", { loading: "lazy", src: api.captureUrl(game, name), alt: "" }),
                badgeNum ? h("span", { class: "cap-order" }, String(badgeNum)) : null,
                h("span", { class: "cap-time" }, fmtCaptureTime(name)),
                h("span", { class: "cap-wins", title: label }, label));
        };

        // --- split shell (built ONCE) so the preview element survives every draw() ---
        const left = h("div", { class: "cap-left" });
        const previewImg = h("img", { class: "cap-preview-img", alt: "" });
        const previewCap = h("div", { class: "cap-preview-cap" });
        const previewEmpty = h("div", { class: "cap-preview-empty" }, "hover an image to preview");
        const right = h("div", { class: "cap-right" }, previewImg, previewCap, previewEmpty);
        // node IS the split flex row (no wrapper) so height:100% resolves against modal-body —
        // an intermediate auto-height div breaks the chain and .cap-left never gets to scroll.
        node.className = "cap-split";
        node.replaceChildren(left, right);
        let previewName = null, previewLive = false;
        // picker tab; the live tab is two levels — the saved SESSIONS (one per live-capture start,
        // null = not loaded yet), then the images inside the one drilled into (liveSid/liveNames).
        let tab = "stashed", sessions = null, liveSid = "", liveNames = null;
        // show `name` big on the right; null -> the hint. `liveOnly` previews a not-yet-promoted
        // live image (from the drilled-into session) via its live URL. Caption: time · page N (or
        // "live") · bound windows.
        const setPreview = (name, liveOnly = false) => {
            previewName = name; previewLive = liveOnly && !!name;
            const on = !!name;
            previewImg.hidden = !on; previewCap.hidden = !on; previewEmpty.hidden = on;
            if (!on) return;
            previewImg.src = previewLive ? api.liveCaptures.imgUrl(game, liveSid, name) : api.captureUrl(game, name);
            const pg = order.indexOf(name), wins = usedBy(name);
            previewCap.textContent = [fmtCaptureTime(name),
                previewLive ? "live" : (pg >= 0 ? `page ${pg + 1}` : null),
                wins.length ? wins.join(", ") : null].filter(Boolean).join("\n");
        };

        // Choosing a live image PROMOTES it (copies into the permanent bucket so a flush can't
        // delete it), then selects it and flips to the stashed tab so the kept capture is visible.
        const promoteLive = async (name) => {
            try {
                const nm = await api.liveCaptures.promote(game, liveSid, name);
                if (!nm) return;
                if (!caps.includes(nm)) caps.unshift(nm);   // newest-first, like a fresh grab
                if (!order.includes(nm)) order.push(nm);
                dirty = true; tab = "stashed"; draw();
            } catch (e) { setStatus(String(e.message || e)); }
        };
        // one live-tab thumb: click promotes+keeps it; an already-promoted name reads "saved".
        const liveCell = (name) => {
            const saved = caps.includes(name);
            return h("button", {
                class: "cap-cell" + (saved ? " used" : ""), dataset: { name },
                title: saved ? `${name} (saved)` : name,
                onClick: () => promoteLive(name), onMouseEnter: () => setPreview(name, !saved),
            },
                h("img", { loading: "lazy", src: api.liveCaptures.imgUrl(game, liveSid, name), alt: "" }),
                h("span", { class: "cap-time" }, fmtCaptureTime(name)),
                h("span", { class: "cap-wins" }, saved ? "saved" : ""));
        };
        const loadSessions = async () => {
            try { sessions = await api.liveCaptures.sessions(game); } catch { sessions = []; }
        };
        // drill into a session (load its image names) or back out to the session list.
        const openSession = async (sid) => {
            liveSid = sid; liveNames = null; previewName = null; draw();
            try { liveNames = await api.liveCaptures.list(game, sid); } catch { liveNames = []; }
            draw();
        };
        const backToSessions = () => { liveSid = ""; liveNames = null; previewName = null; draw(); };
        // delete one recording — armed two-click (no blocking dialog, rule 2).
        const deleteSession = async (btn, sid) => {
            if (btn.dataset.armed !== "1") {
                btn.dataset.armed = "1"; btn.textContent = "sure?";
                setTimeout(() => { if (btn.isConnected && btn.dataset.armed === "1") { btn.dataset.armed = "0"; btn.textContent = "✕"; } }, 2500);
                return;
            }
            try {
                await api.liveCaptures.clear(game, sid);
                await loadSessions();
                if (liveSid === sid) backToSessions(); else draw();
            } catch (e) { setStatus(String(e.message || e)); }
        };
        // one session row: when it was recorded + how many images, how big, how long it runs.
        const sessRow = (s) => {
            const del = h("button", { class: "cap-sess-del", dataset: { armed: "0" }, title: "delete this recording" }, "✕");
            del.addEventListener("click", (ev) => { ev.stopPropagation(); deleteSession(del, s.id); });
            return h("button", { class: "cap-sess", title: s.id, onClick: () => openSession(s.id) },
                h("span", { class: "cap-sess-name" }, sessLabel(s)),
                h("span", { class: "muted cap-sess-meta" }, sessMeta(s, { withBytes: true })),
                del);
        };
        // switch tabs; lazy-load the live sessions the first time that tab opens.
        const switchTab = async (t) => {
            if (tab === t) return;
            tab = t;
            if (t === "live" && sessions === null) await loadSessions();
            draw();
        };

        const draw = () => {
            const tabBtn = (t, label) => h("button",
                { class: "cap-tab" + (tab === t ? " on" : ""), onClick: () => switchTab(t) }, label);
            const sess = (sessions || []).find((s) => s.id === liveSid) || null;
            const liveTotal = (sessions || []).reduce((a, s) => a + s.count, 0);
            const head = h("div", { class: "cap-head" },
                tabBtn("stashed", "stashed"),
                tabBtn("live", liveTotal ? `live (${liveTotal})` : "live"),
                // drilled into a session -> a back crumb naming it
                tab === "live" && liveSid
                    ? h("button", { class: "cap-back", onClick: backToSessions, title: "back to the recordings" }, `‹ ${sessLabel(sess)}`)
                    : null,
                h("span", { class: "spacer" }),
                tab === "stashed" ? h("button", { class: "cap-new", onClick: onCapNew }, "capture") : null,
                h("span", { class: "muted" }, tab !== "live"
                    ? `${order.length} of ${caps.length} selected`
                    : (liveSid ? sessMeta(sess) : `${(sessions || []).length} recordings · ${liveTotal} imgs`)));
            const kids = [head];
            let chosen = null;
            if (tab === "live" && !liveSid) {
                // level 1: the recordings themselves, newest first
                kids.push((sessions && sessions.length)
                    ? h("div", { class: "cap-sess-list" }, sessions.map((s) => sessRow(s)))
                    : h("p", { class: "cap-empty" }, sessions === null ? "loading…" : "no live images saved"));
            } else if (tab === "live") {
                // level 2: the images inside the drilled-into recording
                kids.push((liveNames && liveNames.length)
                    ? h("div", { class: "cap-grid" }, liveNames.map((n) => liveCell(n)))
                    : h("p", { class: "cap-empty" }, liveNames === null ? "loading…" : "this recording is empty"));
            } else {
                // chosen row (page order, drag to reorder) sits above the full pool grid.
                chosen = order.length
                    ? h("div", { class: "cap-chosen" }, order.map((n, i) => cell(n, i + 1, null)))
                    : null;
                const pool = caps.length
                    ? h("div", { class: "cap-grid" },
                        caps.map((n) => cell(n, order.includes(n) ? order.indexOf(n) + 1 : 0, () => toggle(n))))
                    : h("p", { class: "cap-empty" }, "no stashed captures yet");
                if (chosen) kids.push(chosen);
                kids.push(pool);
            }
            left.replaceChildren(...kids);
            // drag-to-reorder the chosen row via the shared primitive. Wrapping grid -> 2-D "wrap"
            // axis (caret marker); marks only, never mutates DOM.
            if (chosen) makeReorderable(chosen, {
                itemSel: ".cap-cell", axis: "wrap",
                onReorder: (from, insertBefore) => { arrayMove(order, from, insertBefore); dirty = true; draw(); },
            });
            // keep the last hover if still valid, else default: first image of the drilled-into
            // recording (live tab) / first chosen. The session LIST level has nothing to preview.
            if (tab === "live") {
                const names = liveSid ? (liveNames || []) : [];
                const pn = (previewName && names.includes(previewName)) ? previewName : (names[0] || null);
                setPreview(pn, pn ? !caps.includes(pn) : false);
            } else {
                setPreview(previewName && caps.includes(previewName) ? previewName : (order[0] || null));
            }
        };
        draw();
    } catch (e) {
        node.replaceChildren(h("p", { class: "muted", style: "padding:12px" }, String(e)));
    }
}

export {
    pc, pcState, precapOpen, precapBusy,
    buildPrecap, mountPrecap, showPrecap, hidePrecap, renderPrecap, renderPrecapData, renderPrecapLeft,
    openCaptureModal, fmtCaptureTime, PC_PAGE,
};
