// Activity / tasks floating panel — lists every running background job for the current
// game (price sweeps, the precapture worker, triggers) from the shared heartbeat hub,
// with cancel/fire/enable controls. Extracted from main.js verbatim.
import * as api from "../../api.js";
import * as conn from "../../conn.js";
import * as hub from "../../hub.js";
import { log } from "../../log.js";
import { createFloatWin } from "../floatwin.js";
import { persist } from "../persist.js";
import { $, model, nodeEls } from "../state.js";
import { since, countdown } from "../../datefmt.js";
import { liveAgo, liveUntil, stopAgo } from "../../ago.js";
import { autosave } from "../main.js";
import { renderTriggerHistory } from "../history_node.js";
import { renderReadoutHistory } from "../readout_history_node.js";
import { renderProducerHistory } from "../producer_history_node.js";
import { renderRegisterHistory } from "../register_history_node.js";
import { renderProcessHistory } from "../process_history_node.js";
import { refreshRegister } from "../register_node.js";
import { liveCollecting } from "./livewin.js";
import { panZoomTo } from "../camera.js";
import { setGateStates } from "../routing.js";
import { playCues } from "../sound.js";
import * as dsevents from "../dsevents.js";
import { svg } from "../../dom.js";

// ---- activity panel (live sweeps + precapture) ----------------------------
// A floating window listing every running background job for the current game — price
// sweeps and the precapture worker — fetched from /api/activity while it's open. Network
// Data comes from the shared heartbeat hub (one poll feeds every panel); the hub sets the
// network cadence (fast while a job runs, slow when idle/backgrounded). A 500ms LOCAL ticker
// re-renders the cached snapshot in between so "fires in …" countdowns stay live without any
// server hit, and beats the hub the instant a countdown elapses. Rows reconcile in place
// (keyed map) so neither the beats nor the local ticker churn the DOM.
const actState = { visible: false, x: null, y: null, w: null, h: null };
let act = null;
// Host adapter: the panel content (actRoot) is mounted into a host (the floatwin body in graph
// view, a pretty-widget host in pretty view) and re-parented to whichever is shown. `active`
// gates the poll/render the same way `actState.visible` used to — independent of which host.
let A = null;                // current host adapter { host, fit(), nav(id) }
let active = false;          // poll + render live? (set by activate/deactivate)
let actRoot = null;          // the .act-list element, MOVED between hosts (keyed rows survive)
let winAdapter = null;       // the floatwin-backed adapter (reclaimed on the panel's onShow)
let actTick = null;          // local ticker for live countdowns (no server hit)
let actUnsub = null;         // heartbeat-hub subscription while the panel is open
let actData = null;          // last hub snapshot (re-rendered locally between beats)
let actAt = 0;               // Date.now() of the last snapshot, used to age the countdowns
const actRows = new Map();   // job key -> { row, title, prog }
const actPending = new Set();   // trigger ids whose enable toggle is mid-flight (debounce until the next update)
// job keys whose cancel was just clicked — optimistic "cancelling…" until the backend's own
// flag (s.cancel) confirms it. Cleared on confirm or when the row leaves. Without this the
// button's disabled/text were set once on click and never reconciled, so a recurring sweep
// (re-fired by a trigger → same row key reused) froze the button on "cancelling…" forever.
const actCancelReq = new Set();
let actEmpty = null;         // the reused "nothing active" placeholder (never innerHTML)
let actSpin = null;          // the reused first-load spinner, shown until the first snapshot lands
// register id -> newest push ts last seen on the beat, so the membank repaints the instant a value
// lands (live OR a teach-UI test feed), not only while liveCollecting. See updateTriggerNodes.
const _lastRegPush = new Map();
// trigger ids currently flagged 'gated off' (their .gnode carries `node-gated`) — tracked so each
// beat only ADDS/REMOVES the class that actually changed (reconcile in place, rule 1). Live-only:
// the snapshot's `gated` is empty when the collector is idle, which clears every cue.
let _gatedNodes = new Set();
// last-pushed gate pass/block signature — the gate->trigger line tints ride the beat too, but a
// canvas repaint only fires when a gate actually flips (rule 1: a steady beat repaints nothing).
let _gateSig = "";

function buildActivity() {
    if (act) return;
    act = createFloatWin({
        id: "activity", title: "tasks", state: actState, bothAxes: true,
        onShow: () => { $("activityBtn")?.classList.toggle("active", true); mountActivity(winAdapter); activateActivity(); },
        onHide: () => { $("activityBtn")?.classList.toggle("active", false); deactivateActivity(); },
        onPersist: () => persist.layout(),
    });
    winAdapter = { host: act.body, fit: () => act.fitHeight(), nav: (id) => panZoomTo(id) };
    // regaining focus -> the backgrounded cadence is stale; beat the hub right away
    window.addEventListener("focus", () => { if (active) hub.kick(); });
    // Trigger NODE progress (.tg-prog: live countdown / idle) tracks EVERY heartbeat, panel open
    // or not — a timed trigger must keep counting down (and a fire must refresh its history) even
    // while the tasks panel is closed. The panel's own render (gated on `active`) only drives the
    // panel rows; the node progress is independent. Reconciles in place (textContent only when
    // changed; countdown via the shared ago.js ticker), so an always-on beat costs nothing (rule 1).
    hub.subscribe((s) => updateTriggerNodes(s));
    // Sound plays off the INSTANT fire push (dsevents `fire` channel), NOT the polled activity
    // snapshot — the snapshot lags a fire by a disk sidecar + the ~0.8-2.5s SSE pump, which made
    // a cue trail its trigger by seconds. This is the single funnel for every fire source
    // (interval / on_change / on_register / manual), all of which route through _emit_fire and so
    // publish_fire (rule 7). Subscribed once here, panel open or not.
    dsevents.subscribeFire((ev) => playFire(ev));
    mountActivity(winAdapter);
}

// Build the content root once, then (re-)parent it into `adapter.host`. Re-parenting moves the
// intact subtree, so the keyed actRows map stays valid across a host switch (rule 1: no rebuild).
function mountActivity(adapter) {
    if (!adapter) return;
    A = adapter;
    if (!actRoot) {
        actRoot = document.createElement("div"); actRoot.className = "act-list";
        actEmpty = document.createElement("div"); actEmpty.className = "act-empty"; actEmpty.textContent = "nothing active";
        actSpin = document.createElement("div"); actSpin.className = "st-spin"; actSpin.textContent = "loading…";
        wireActivityClicks(actRoot);
    }
    if (actRoot.parentElement !== adapter.host) adapter.host.appendChild(actRoot);
}

function wireActivityClicks(root) {
    // one delegated handler for every row's button (cancel a job, or fire a trigger now)
    root.addEventListener("click", (ev) => {
        const game = model.profile.name; if (!game) return;
        const c = ev.target.closest("button[data-cancel]");
        if (c && !c.disabled) {
            const key = c.dataset.cancel === "sweep" ? `sweep:${c.dataset.ds}` : "precap";
            actCancelReq.add(key);   // optimistic — reconcile keeps the button on "cancelling…" until confirmed
            c.disabled = true; c.textContent = "cancelling…";
            const p = c.dataset.cancel === "sweep" ? api.prices.cancel(game, c.dataset.ds) : api.precapture.cancel(game);
            p.catch((e) => log(`cancel failed: ${e.message || e}`, "err")).finally(() => setTimeout(hub.kick, 300));   // state changed -> beat the hub
            return;
        }
        const f = ev.target.closest("button[data-fire]");
        if (f && !f.disabled) {
            f.disabled = true; f.classList.add("loading");   // spinner overlay, label stays put (no resize/flicker)
            api.triggers.fire(game, f.dataset.fire).catch((e) => log(`trigger fire failed: ${e.message || e}`, "err"))
                .finally(() => { f.disabled = false; f.classList.remove("loading"); hub.kick(); });   // refresh next-fire time
            return;
        }
        // enable/disable a trigger: flip it in the profile + save; the row reflects it on the
        // next render (optimistically patched so it's instant), the server reads it after save
        const en = ev.target.closest("button[data-enable]");
        if (en) {
            const id = en.dataset.enable;
            if (actPending.has(id)) return;   // debounce: ignore further clicks until this update lands
            const t = model.trigger(id);
            if (!t) return;
            actPending.add(id);
            t.enabled = !(t.enabled !== false);
            const live = (actData?.triggers || []).find((x) => x.id === t.id);
            if (live) live.enabled = t.enabled;
            autosave(null);                  // persist; a disabled toggle changes nothing others re-read
            if (actData) renderActivity(actData, 0);
            // poll ONLY after the save has actually landed (flush the debounce), so the server's
            // schedule already reflects the new enabled state — no stale flip-back. Clearing the
            // pending guard re-enables the toggle on the next render.
            persist.flush().then(hub.kick).catch(() => hub.kick()).finally(() => {
                actPending.delete(id);
                if (actData) renderActivity(actData, 0);
            });
            return;
        }
        // clicked the row body (not a control) -> navigate to the bound graph node (no-op in pretty)
        const nav = ev.target.closest(".act-row[data-node]");
        if (nav) A?.nav?.(nav.dataset.node);
    });
}

// duration formatting is the shared `countdown` (datefmt.js) — one formatter for the panel's
// "fires in …" and the node's "next in …" (rule 7).
const fmtDur = countdown;

function deactivateActivity() {
    active = false;
    if (actTick) { clearInterval(actTick); actTick = null; }
    if (actUnsub) { actUnsub(); actUnsub = null; }
}
// kept name for back-compat with any external callers
const stopActivityPoll = deactivateActivity;

// Show the first-load spinner ONLY before any snapshot has rendered — once a beat lands
// (rows or the "nothing active" placeholder), renderActivity removes it and a steady poll over
// existing rows leaves it gone (zero DOM churn). No-op if the hub already replayed a snapshot.
function showActLoading() {
    if (!actRoot || actData || actRows.size || actEmpty?.isConnected) return;
    if (!actSpin.isConnected) { actRoot.appendChild(actSpin); fitActivityHeight(); }
}

// any interval trigger whose countdown has just hit zero since the last fetch -> it fired,
// so the server state changed and a refresh is due (don't wait out the cadence)
function actDueForRefresh(elapsed) {
    return (actData?.triggers || []).some((t) => (t.kind === "interval" || t.kind === "true_interval") && (t.next_in || 0) > 0 && (t.next_in - elapsed) <= 0);
}

function activateActivity() {
    deactivateActivity();
    active = true;
    const game = model.profile.name;
    if (!game) { actData = { sweeps: [], precapture: null }; actAt = Date.now(); renderActivity(actData, 0); }
    // Data arrives from the heartbeat hub (one poll feeds every panel); this panel just
    // renders its slice of each snapshot.
    actUnsub = hub.subscribe((s) => {
        if (!active) return;
        actData = s; actAt = Date.now(); renderActivity(actData, 0);
    });
    hub.kick();   // immediate beat on open
    showActLoading();   // spinner until the first snapshot lands (no-op if the hub already replayed one)
    // Local ticker: re-render the cached payload so the "fires in …" countdowns keep ticking
    // between beats (no server hit), and beat the hub the instant a countdown elapses so the
    // fired trigger's new schedule lands promptly.
    actTick = setInterval(() => {
        if (!active || !conn.isOnline()) return;   // backend down -> halt countdowns
        const elapsed = (Date.now() - actAt) / 1000;
        if (elapsed >= 1.5 && actDueForRefresh(elapsed)) hub.kick();
        else if (actData) renderActivity(actData, elapsed);
    }, 500);
}
const startActivityPoll = activateActivity;

// Map a raw status object to display row specs. Each job: { key, title, prog, cls?, action? }
// where action is {type:"cancel",kind,ds?} | {type:"fire",id} | null.
function activityJobs(data, elapsed = 0) {
    const jobs = [];
    for (const s of (data.sweeps || [])) {
        jobs.push({
            key: `sweep:${s.dataset}`, action: { type: "cancel", kind: "sweep", ds: s.dataset, cancelling: !!s.cancel },
            title: `sweep · ${s.dataset}`,
            prog: `${s.done}/${s.total || "…"} · ${s.fetched} ok${s.failed ? ` · ${s.failed} failed` : ""}${s.cancel ? " · cancelling…" : ""}${s.last ? ` · ${s.last}` : ""}`,
        });
    }
    // sweeps refused because another node/process held the per-game gate — no running thread, so
    // they'd otherwise be invisible. Skip one that's since started running (shown above).
    const running = new Set((data.sweeps || []).map((s) => s.dataset));
    for (const b of (data.blocked || [])) {
        if (running.has(b.dataset)) continue;
        jobs.push({ key: `blocked:${b.dataset}`, cls: "act-trigger act-off",
            title: `sweep · ${b.dataset}`, prog: `blocked · ${b.blocked_by || "another sweep running"}` });
    }
    const p = data.precapture;
    if (p) {
        const recog = p.window ? ` · ${p.window}/${p.state}` : "";
        const prog = p.phase === "recording" ? `${p.frames} frames`
            : `${p.processed}/${p.frames} · ${p.read || 0} read · ${p.fps}/s${recog}`;
        jobs.push({ key: "precap", action: { type: "cancel", kind: "precap" }, title: `precapture · ${p.phase}`, prog });
    }
    for (const t of (data.triggers || [])) {
        const enabled = t.enabled !== false;
        const running = (t.targets || []).some((x) => x.running);
        let prog;
        const watchLabel = t.kind === "on_any_change" ? "any change"
            : t.kind === "on_new_batch" ? "new batch" : "on change";
        const watched = t.kind === "on_change" || t.kind === "on_any_change" || t.kind === "on_new_batch";
        const timed = t.kind === "interval" || t.kind === "true_interval";
        if (!enabled) {
            prog = timed ? `disabled · every ${fmtDur(t.interval_s)}`
                : watched ? `disabled · ${watchLabel}: ${(t.watch || []).join(", ") || "—"}`
                : "disabled";
        } else if (timed) {
            const remaining = Math.max(0, (t.next_in || 0) - elapsed);   // age locally between fetches
            prog = running ? "firing now…"
                : remaining <= 0 ? `due… · every ${fmtDur(t.interval_s)}`
                : `fires in ${fmtDur(remaining)} · every ${fmtDur(t.interval_s)}`;
        } else if (watched) {
            prog = `${watchLabel}: ${(t.watch || []).join(", ") || "—"}${running ? " · firing now…" : ""}`;
        } else { prog = t.kind; }
        // last-activation gets its OWN (third) row, not crammed onto the status line. `lastTs`
        // (set only when it's a real elapsed time) drives the optimistic 1s "ago" tick; `last` is
        // the static fallback text for the running / never-fired states.
        const lastTs = !running && t.last_fired ? t.last_fired : null;
        const last = running ? "firing now…" : (t.last_fired ? `last fired ${since(t.last_fired)}` : "never fired");
        jobs.push({ key: `trigger:${t.id}`, cls: `act-trigger${enabled ? "" : " act-off"}`,
            action: { type: "fire", id: t.id }, enable: { id: t.id, enabled }, node: `trigger:${t.id}`,
            title: `trigger · ${t.id}`, prog, last, lastTs });
    }
    return jobs;
}

// Play a fired trigger's SOUND NODES, driven by the instant `fire` push (dsevents). The cue carries
// `sounds` — the sound ids the SERVER resolved for this fire (a router may have SELECTED them by a
// live value, and direct sound targets land there too). We play exactly those; only if the cue
// carries none do we fall back to the trigger's own sound targets (back-compat with old servers).
// Sounds are browser-played (unlike a server-fired toast/producer). The push is un-backfilled (only
// live fires arrive), so no replay guard is needed — it fires the moment the trigger does.
function playFire(ev) {
    const tid = ev?.trigger;
    if (!tid) return;
    const ids = (ev.sounds && ev.sounds.length) ? ev.sounds : (model.trigger(tid)?.targets || []);
    // one batch (playCues), not a playCue per id — several sound nodes on one trigger must sound
    // together; playing them one-by-one staggered them by each cue's own render/await.
    playCues(ids.map((pid) => model.soundNode(pid)).filter(Boolean));
}

// Reflect each trigger's live PROGRESS onto its node's `.tg-prog` span (reconcile-in-place:
// textContent set only when it changes — steady-state is zero DOM writes except as a countdown
// ticks). Timed kinds show a live "idle (next in: …)"; an on_readout crosses shows the saved
// value it compares against; every other kind shows plain idle / firing now.
function updateTriggerNodes(data) {
    // 'gated off' cue: flag every trigger node whose gates currently block it (live-only; the
    // snapshot's `gated` is empty when idle -> clears all). Reconcile via the tracked set so a
    // steady beat writes ZERO classes (rule 1): only a gate flipping adds/removes its node's class.
    const gatedSet = new Set(data.gated || []);
    for (const id of _gatedNodes) if (!gatedSet.has(id)) nodeEls.get(`trigger:${id}`)?.classList.remove("node-gated");
    for (const id of gatedSet) if (!_gatedNodes.has(id)) nodeEls.get(`trigger:${id}`)?.classList.add("node-gated");
    _gatedNodes = gatedSet;
    // gate->trigger line tint: push the per-gate pass/block only when it actually changed, so a
    // steady beat triggers no canvas repaint (rule 1). Empty when idle -> lines fall back to grey.
    const gs = data.gate_states || {};
    const sig = Object.keys(gs).sort().map((k) => k + (gs[k] ? "1" : "0")).join(",");
    if (sig !== _gateSig) { _gateSig = sig; setGateStates(new Map(Object.entries(gs))); }
    // (sound playback moved off this polled beat to the instant `fire` push — see playFire)
    // readout read-history satellites ride the same beat (readout_history, keyed "<win>:<ro>");
    // TOP-LEVEL (not under `live`) so a test feed updates them with the collector stopped too.
    // paint each OPEN one (no-op / no host when hidden). VTable reconciles in place (rule 1).
    const roHist = data.readout_history || {};
    for (const key in roHist) {
        const sep = key.indexOf(":");
        if (sep < 0) continue;
        renderReadoutHistory(key.slice(0, sep), key.slice(sep + 1), roHist[key]);
    }
    // producer fetch-history satellites ride the same beat (producer_history, keyed by producer id);
    // paint each OPEN one (no-op / no host when hidden). VTable reconciles in place (rule 1).
    const prHist = data.producer_history || {};
    for (const pid in prHist) renderProducerHistory(pid, prHist[pid]);
    // process input/output-history satellites ride the same beat (process_history, keyed by process
    // id); TOP-LEVEL (not under `live`) so a test feed updates them with the collector stopped too.
    // paint each OPEN one (no-op / no host when hidden). VTable reconciles in place (rule 1).
    const procHist = data.process_history || {};
    for (const pid in procHist) renderProcessHistory(pid, procHist[pid]);
    // register push-history satellites ride the same beat (register_history, keyed by register id);
    // TOP-LEVEL (not under `live`) so a test feed updates them with the collector stopped too.
    // paint each OPEN one (no-op / no host when hidden). VTable reconciles in place (rule 1).
    const regHist = data.register_history || {};
    const regRefresh = new Set();   // registers whose membank to repaint this beat (deduped, flushed below)
    for (const rid in regHist) {
        renderRegisterHistory(rid, regHist[rid]);
        // the MEMBANK rides the same push signal: a value landing (register_history's newest ts moved)
        // repaints it whether the push came from live collection OR a teach-UI test feed — the beat's
        // liveCollecting gate below misses the feed case (collector stopped), which left the membank
        // stale until a manual rebuild / reload.
        const latest = regHist[rid][0]?.ts;
        if (latest && latest !== _lastRegPush.get(rid)) { _lastRegPush.set(rid, latest); regRefresh.add(rid); }
    }
    for (const t of (data.triggers || [])) {
        // the heartbeat carries each trigger's history now (trigger_sched.py), so this just
        // paints it into an OPEN satellite — no-op / no network when it's hidden.
        renderTriggerHistory(t.id, t.history);
        const span = nodeEls.get(`trigger:${t.id}`)?.querySelector(".tg-prog");
        if (!span) continue;
        const running = (t.targets || []).some((x) => x.running);
        const timed = t.kind === "interval" || t.kind === "true_interval";
        if (!running && timed && t.next_in != null) {
            // live countdown, panel open or not — re-registered each beat so the deadline re-syncs
            liveUntil(span, t.next_in, (s, r) => (r <= 0 ? "due…" : `idle (next in: ${s})`));
            continue;
        }
        stopAgo(span);
        const txt = running ? "firing now…" : "idle";
        if (span.textContent !== txt) span.textContent = txt;
    }
    // Register membank refetch (no-op / no host when the node isn't shown; renderBank reconciles in
    // place, rule 1). While collecting, refetch EVERY register each beat (covers a register that
    // hasn't pushed yet — empty-ring initial paint — and holds it fresh). Otherwise only those that
    // got a fresh push this beat (regRefresh) repaint, so an idle session never fires a fetch.
    if (liveCollecting())
        for (const id of model.registers()) regRefresh.add(id);
    for (const id of regRefresh) refreshRegister(id);
}

function renderActivity(data, elapsed = 0) {
    if (!actRoot) return;
    if (actSpin?.isConnected) actSpin.remove();   // first snapshot landed -> spinner done (one-shot; later ticks no-op)
    updateTriggerNodes(data);
    const list = actRoot;
    const jobs = activityJobs(data, elapsed);
    const want = new Set(jobs.map((j) => j.key));
    for (const [key, r] of actRows) if (!want.has(key)) { r.row.remove(); actRows.delete(key); actCancelReq.delete(key); }
    if (!jobs.length) {
        if (!actEmpty.isConnected) list.appendChild(actEmpty);   // reuse the placeholder, no innerHTML
        return;
    }
    if (actEmpty.isConnected) actEmpty.remove();
    let i = 0;
    for (const j of jobs) {
        let r = actRows.get(j.key);
        if (!r) {
            const row = document.createElement("div"); row.className = `act-row${j.cls ? ` ${j.cls}` : ""}`;
            if (j.node) { row.dataset.node = j.node; row.title = "go to this node"; }   // click navigates (key fixes a row's type, so this never changes per tick)
            const body = document.createElement("div"); body.className = "act-body";
            const title = document.createElement("div"); title.className = "act-title";
            const prog = document.createElement("div"); prog.className = "act-prog";
            body.append(title, prog);
            // optional third row: last-activity line (triggers). Created once iff the job carries
            // `last`; the key namespace fixes a row's type, so its presence never changes per tick.
            let last = null;
            if (j.last !== undefined) {
                last = document.createElement("div"); last.className = "act-last";
                body.append(last);
            }
            row.append(body);
            // enable/disable toggle (triggers only) sits just before the action button
            let enableBtn = null, cancelBtn = null;
            if (j.enable) {
                enableBtn = document.createElement("button");
                enableBtn.className = "act-enable"; enableBtn.setAttribute("role", "switch");
                enableBtn.dataset.enable = j.enable.id;
                enableBtn.title = "enable / disable this trigger";
                enableBtn.append(
                    svg("svg", { viewBox: "0 0 28 16", width: "28", height: "16", "aria-hidden": "true" },
                        svg("rect", { class: "gt-track", x: "1", y: "1", width: "26", height: "14", rx: "7" }),
                        svg("circle", { class: "gt-thumb", cx: "8", cy: "8", r: "5" })));
                row.append(enableBtn);
            }
            // button is stable per key (sweep/precap → cancel, trigger → fire)
            if (j.action?.type === "cancel") {
                cancelBtn = document.createElement("button");
                cancelBtn.className = "act-cancel"; cancelBtn.textContent = "cancel";
                cancelBtn.dataset.cancel = j.action.kind; if (j.action.ds) cancelBtn.dataset.ds = j.action.ds;
                row.append(cancelBtn);
            } else if (j.action?.type === "fire") {
                const btn = document.createElement("button");
                btn.className = "act-fire"; btn.textContent = "fire";
                btn.dataset.fire = j.action.id;
                row.append(btn);
            }
            r = { row, title, prog, last, enableBtn, cancelBtn, cls: j.cls || "" }; actRows.set(j.key, r);
        }
        // place at slot i ONLY if it isn't already there — no needless detach/reattach (which
        // flashes as a "recreate" in devtools + thrashes layout every tick)
        const at = list.children[i];
        if (at !== r.row) list.insertBefore(r.row, at || null);
        i++;
        if (r.cls !== (j.cls || "")) { r.row.className = `act-row${j.cls ? ` ${j.cls}` : ""}`; r.cls = j.cls || ""; }
        if (r.enableBtn) {
            const on = j.enable?.enabled !== false;
            if (r.enableBtn.getAttribute("aria-checked") !== String(on)) {
                r.enableBtn.setAttribute("aria-checked", on);
                r.enableBtn.classList.toggle("on", on);
            }
            const dis = actPending.has(j.enable?.id);   // disabled while a toggle is mid-flight (debounce)
            if (r.enableBtn.disabled !== dis) r.enableBtn.disabled = dis;
        }
        // cancel button reflects the backend's drain state, NEVER a frozen click-time value: a
        // confirmed cancel (j.action.cancelling) clears the optimistic flag; a fresh sweep reusing
        // this row key reports cancelling=false → button re-enables to "cancel".
        if (r.cancelBtn) {
            if (j.action?.cancelling) actCancelReq.delete(j.key);   // backend confirmed → optimistic no longer needed
            const busy = !!j.action?.cancelling || actCancelReq.has(j.key);
            if (r.cancelBtn.disabled !== busy) r.cancelBtn.disabled = busy;
            const ctxt = busy ? "cancelling…" : "cancel";
            if (r.cancelBtn.textContent !== ctxt) r.cancelBtn.textContent = ctxt;
        }
        if (r.title.textContent !== j.title) r.title.textContent = j.title;
        if (r.prog.textContent !== j.prog) r.prog.textContent = j.prog;
        if (r.last) {
            if (j.lastTs) liveAgo(r.last, j.lastTs, (s) => `last fired ${s}`);   // ticks every 1s
            else { stopAgo(r.last); if (r.last.textContent !== (j.last || "")) r.last.textContent = j.last || ""; }
        }
    }
    fitActivityHeight();   // grow/shrink the panel to its contents (unless the user resized it)
}

// Auto-fit delegates to the host adapter (floatwin height-fit in graph; no-op in a pretty widget).
function fitActivityHeight() { A?.fit?.(); }

export {
    act, actState, buildActivity, mountActivity, activateActivity, deactivateActivity,
    fmtDur, stopActivityPoll, actDueForRefresh,
    startActivityPoll, activityJobs, renderActivity, fitActivityHeight,
};
