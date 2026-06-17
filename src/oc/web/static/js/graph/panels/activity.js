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
import { since } from "../../datefmt.js";
import { liveAgo, stopAgo } from "../../ago.js";
import { autosave, panZoomTo } from "../main.js";

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
let actTick = null;          // local ticker for live countdowns (no server hit)
let actUnsub = null;         // heartbeat-hub subscription while the panel is open
let actData = null;          // last hub snapshot (re-rendered locally between beats)
let actAt = 0;               // Date.now() of the last snapshot, used to age the countdowns
const actRows = new Map();   // job key -> { row, title, prog }
const actPending = new Set();   // trigger ids whose enable toggle is mid-flight (debounce until the next update)
let actEmpty = null;         // the reused "nothing active" placeholder (never innerHTML)

function buildActivity() {
  if (act) return;
  act = createFloatWin({
    id: "activity", title: "tasks", state: actState, bothAxes: true,
    onShow: () => { $("activityBtn")?.classList.toggle("active", true); startActivityPoll(); },
    onHide: () => { $("activityBtn")?.classList.toggle("active", false); stopActivityPoll(); },
    onPersist: () => persist.layout(),
  });
  act.body.innerHTML = `<div class="act-list"></div>`;
  actEmpty = document.createElement("div"); actEmpty.className = "act-empty"; actEmpty.textContent = "nothing active";
  // regaining focus -> the backgrounded cadence is stale; beat the hub right away
  window.addEventListener("focus", () => { if (actState.visible) hub.kick(); });
  // Trigger NODE labels (.tg-last "last fired") track EVERY heartbeat, panel open or not —
  // a trigger that fires while the tasks panel is closed must still update its node, else the
  // label sticks at "never fired" forever. The panel's own render (gated on visibility) only
  // drives the panel rows; the node labels are independent. Reconciles in place (textContent
  // only when changed), so an always-on beat costs nothing at steady state (rule 1).
  hub.subscribe((s) => updateTriggerNodes(s));
  // one delegated handler for every row's button (cancel a job, or fire a trigger now)
  act.body.addEventListener("click", (ev) => {
    const game = model.profile.name; if (!game) return;
    const c = ev.target.closest("button[data-cancel]");
    if (c && !c.disabled) {
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
      autosave(false);                 // persist; a disabled toggle changes nothing others re-read
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
    // clicked the row body (not a control) -> pan+zoom to the bound graph node
    const nav = ev.target.closest(".act-row[data-node]");
    if (nav) panZoomTo(nav.dataset.node);
  });
}

// Human-readable duration: 45s / 5m / 5m 30s / 2h 10m.
function fmtDur(s) {
  s = Math.max(0, Math.round(s || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), rs = s % 60;
  if (m < 60) return rs ? `${m}m ${rs}s` : `${m}m`;
  const h = Math.floor(m / 60), rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

function stopActivityPoll() {
  if (actTick) { clearInterval(actTick); actTick = null; }
  if (actUnsub) { actUnsub(); actUnsub = null; }
}

// any interval trigger whose countdown has just hit zero since the last fetch -> it fired,
// so the server state changed and a refresh is due (don't wait out the cadence)
function actDueForRefresh(elapsed) {
  return (actData?.triggers || []).some((t) => t.kind === "interval" && (t.next_in || 0) > 0 && (t.next_in - elapsed) <= 0);
}

function startActivityPoll() {
  stopActivityPoll();
  const game = model.profile.name;
  if (!game) { actData = { sweeps: [], precapture: null }; actAt = Date.now(); renderActivity(actData, 0); }
  // Data arrives from the heartbeat hub (one poll feeds every panel); this panel just
  // renders its slice of each snapshot.
  actUnsub = hub.subscribe((s) => {
    if (!actState.visible) return;
    actData = s; actAt = Date.now(); renderActivity(actData, 0);
  });
  hub.kick();   // immediate beat on open
  // Local ticker: re-render the cached payload so the "fires in …" countdowns keep ticking
  // between beats (no server hit), and beat the hub the instant a countdown elapses so the
  // fired trigger's new schedule lands promptly.
  actTick = setInterval(() => {
    if (!actState.visible || !conn.isOnline()) return;   // backend down -> halt countdowns
    const elapsed = (Date.now() - actAt) / 1000;
    if (elapsed >= 1.5 && actDueForRefresh(elapsed)) hub.kick();
    else if (actData) renderActivity(actData, elapsed);
  }, 500);
}

// Map a raw status object to display row specs. Each job: { key, title, prog, cls?, action? }
// where action is {type:"cancel",kind,ds?} | {type:"fire",id} | null.
function activityJobs(data, elapsed = 0) {
  const jobs = [];
  for (const s of (data.sweeps || [])) {
    jobs.push({
      key: `sweep:${s.dataset}`, action: { type: "cancel", kind: "sweep", ds: s.dataset },
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
    if (!enabled) {
      prog = t.kind === "interval" ? `disabled · every ${fmtDur(t.interval_s)}`
        : t.kind === "on_change" ? `disabled · on change: ${(t.watch || []).join(", ") || "—"}`
        : "disabled";
    } else if (t.kind === "interval") {
      const remaining = Math.max(0, (t.next_in || 0) - elapsed);   // age locally between fetches
      prog = running ? "firing now…"
        : remaining <= 0 ? `due… · every ${fmtDur(t.interval_s)}`
        : `fires in ${fmtDur(remaining)} · every ${fmtDur(t.interval_s)}`;
    } else if (t.kind === "on_change") {
      prog = `on change: ${(t.watch || []).join(", ") || "—"}${running ? " · firing now…" : ""}`;
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

// Reflect each trigger's last-activation onto its node (reconcile-in-place: textContent set
// only when it actually changes — steady-state is zero DOM writes except as the "since" label
// ticks over).
function updateTriggerNodes(data) {
  for (const t of (data.triggers || [])) {
    const span = nodeEls.get(`trigger:${t.id}`)?.querySelector(".tg-last");
    if (!span) continue;
    const running = (t.targets || []).some((x) => x.running);
    if (!running && t.last_fired) {
      liveAgo(span, t.last_fired, (s) => `last fired ${s}`);   // ticks every 1s, panel open or not
    } else {
      stopAgo(span);
      const txt = running ? "firing now…" : "never fired";
      if (span.textContent !== txt) span.textContent = txt;
    }
  }
}

function renderActivity(data, elapsed = 0) {
  if (!act) return;
  updateTriggerNodes(data);
  const list = act.body.querySelector(".act-list");
  const jobs = activityJobs(data, elapsed);
  const want = new Set(jobs.map((j) => j.key));
  for (const [key, r] of actRows) if (!want.has(key)) { r.row.remove(); actRows.delete(key); }
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
      let enableBtn = null;
      if (j.enable) {
        enableBtn = document.createElement("button");
        enableBtn.className = "act-enable"; enableBtn.setAttribute("role", "switch");
        enableBtn.dataset.enable = j.enable.id;
        enableBtn.title = "enable / disable this trigger";
        enableBtn.innerHTML = `<svg viewBox="0 0 28 16" width="28" height="16" aria-hidden="true">
          <rect class="gt-track" x="1" y="1" width="26" height="14" rx="7" />
          <circle class="gt-thumb" cx="8" cy="8" r="5" /></svg>`;
        row.append(enableBtn);
      }
      // button is stable per key (sweep/precap → cancel, trigger → fire)
      if (j.action?.type === "cancel") {
        const btn = document.createElement("button");
        btn.className = "act-cancel"; btn.textContent = "cancel";
        btn.dataset.cancel = j.action.kind; if (j.action.ds) btn.dataset.ds = j.action.ds;
        row.append(btn);
      } else if (j.action?.type === "fire") {
        const btn = document.createElement("button");
        btn.className = "act-fire"; btn.textContent = "fire";
        btn.dataset.fire = j.action.id;
        row.append(btn);
      }
      r = { row, title, prog, last, enableBtn, cls: j.cls || "" }; actRows.set(j.key, r);
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
    if (r.title.textContent !== j.title) r.title.textContent = j.title;
    if (r.prog.textContent !== j.prog) r.prog.textContent = j.prog;
    if (r.last) {
      if (j.lastTs) liveAgo(r.last, j.lastTs, (s) => `last fired ${s}`);   // ticks every 1s
      else { stopAgo(r.last); if (r.last.textContent !== (j.last || "")) r.last.textContent = j.last || ""; }
    }
  }
  fitActivityHeight();   // grow/shrink the panel to its contents (unless the user resized it)
}

// Auto-fit delegates to the shared floatwin height-fit (one primitive for every panel).
function fitActivityHeight() { act?.fitHeight(); }

export {
  act, actState, buildActivity, fmtDur, stopActivityPoll, actDueForRefresh,
  startActivityPoll, activityJobs, renderActivity, fitActivityHeight,
};
