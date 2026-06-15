// conn.js — backend connection state + an offline overlay.
//
// Single source of truth for "can we reach the data-rig server". api.js's tfetch()
// reports every request's outcome here: any completed response (even a 500) proves the
// backend is reachable; a network-level failure or timeout means it's down. While
// offline we:
//   * show a full-screen overlay (reusing the .startup-halt look) with a Retry button,
//   * auto-probe a cheap health endpoint so the overlay AUTO-dismisses the instant the
//     server is back,
//   * and let every poller halt (they check isOnline()) so nothing hammers a dead
//     server or mutates the DOM while we're blind.

const HEALTH_URL = "/api/ocr/device";   // cheapest always-present GET; also serve.ps1's up-probe
const PROBE_MS = 2500;                   // auto-retry cadence while offline

let online = true;
let probeTimer = null;
let checking = false;                    // a manual/auto probe is in flight
const listeners = new Set();

export function isOnline() { return online; }

// Subscribe to transitions; returns an unsubscribe fn. Fires with the NEW state.
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit() { for (const fn of listeners) { try { fn(online); } catch { /* ignore */ } } }

// Reported by tfetch (api.js) on every outcome. Idempotent: only the actual up<->down
// transition does any work, so reporting on every request is cheap. `reason` is the
// real failure (which request, what error) so the overlay can show what actually went
// wrong instead of guessing a cause.
let reason = "";
export function reportReachable() { setState(true); }
export function reportUnreachable(detail = "") { reason = detail || ""; setState(false); }

// Force offline from outside (boot detects the server is down before any poll runs).
export function markOffline() { reason = ""; setState(false); }

function setState(up) {
  if (online === up) return;
  online = up;
  overlay(!up);
  if (up) { clearTimeout(probeTimer); probeTimer = null; }
  else startProbe();
  emit();
}

// A health ping that BYPASSES tfetch — it must touch the network even while we count as
// offline, and must NOT recurse back into this module. True iff the server answers.
async function ping() {
  try {
    const r = await fetch(HEALTH_URL, { cache: "no-store", signal: AbortSignal.timeout(5000) });
    return r.ok;
  } catch { return false; }
}

function startProbe() {
  if (probeTimer) return;
  const tick = async () => {
    probeTimer = null;
    if (online) return;
    if (await ping()) { setState(true); return; }
    probeTimer = setTimeout(tick, PROBE_MS);
  };
  probeTimer = setTimeout(tick, PROBE_MS);
}

// Manual Retry button: probe once now; dismiss on success, else keep waiting.
async function retryNow() {
  if (checking) return;
  checking = true; setBtnBusy(true);
  const up = await ping();
  checking = false; setBtnBusy(false);
  if (up) setState(true);
}

// ---- overlay (reuses the .startup-halt look) -------------------------------------
let el = null, btn = null, reasonEl = null;

function ensureEl() {
  if (el) return;
  el = document.createElement("div");
  el.className = "startup-halt offline-overlay";
  el.hidden = true;
  // Heading states only what we KNOW (a request didn't get a response); the cause
  // line below shows the actual failing request/error rather than guessing whether
  // the server is "down". The probe decides reachable-vs-not and auto-dismisses.
  el.innerHTML = `<div class="startup-halt-box">
    <h3>No response from the backend</h3>
    <p>A request failed and the server isn't answering the health check yet. It may be
       busy, restarting, or unreachable.</p>
    <p class="muted offline-reason"></p>
    <p class="muted">Retrying automatically — all updates are paused until it answers.</p>
    <button class="startup-halt-retry" type="button">retry now</button></div>`;
  btn = el.querySelector(".startup-halt-retry");
  reasonEl = el.querySelector(".offline-reason");
  btn.addEventListener("click", retryNow);
  document.body.appendChild(el);
}

function overlay(show) {
  ensureEl();
  if (show) reasonEl.textContent = reason ? `last failure — ${reason}` : "";
  el.hidden = !show;
}

function setBtnBusy(b) {
  if (!btn) return;
  btn.disabled = b;
  btn.textContent = b ? "checking…" : "retry now";
}
