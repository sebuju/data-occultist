// Bottom terminal-style log bar: shows the latest message; click to expand into a
// scrollable history. `timed(label)` logs a "…" line and returns a done() that logs
// the same label with the elapsed, human-readable duration.

const MAX = 500;
let bar = null, latest = null, body = null, ready = false;
const buffer = [];

function ensure() {
  if (ready) return ready;
  bar = document.getElementById("logbar");
  if (!bar) return false;
  latest = bar.querySelector(".log-latest");
  body = bar.querySelector(".log-body");
  bar.querySelector(".log-head").addEventListener("click", () => bar.classList.toggle("open"));
  ready = true;
  for (const e of buffer.splice(0)) append(e);   // flush anything logged before DOM was ready
  return true;
}

function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

function append({ ts, msg, level }) {
  latest.textContent = msg;
  latest.className = `log-latest lvl-${level}`;
  const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 30;
  const row = document.createElement("div");
  row.className = `log-row lvl-${level}`;
  row.innerHTML = `<span class="log-ts">${ts}</span>${esc(msg)}`;
  body.appendChild(row);
  while (body.children.length > MAX) body.removeChild(body.firstChild);
  if (atBottom) body.scrollTop = body.scrollHeight;
}

export function fmtDur(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function log(msg, level = "info") {
  const e = { ts: new Date().toLocaleTimeString("en-GB", { hour12: false }), msg: String(msg), level };
  if (ensure()) append(e); else buffer.push(e);
}

// timed("load image"): logs "load image…" now, returns done(extra?, level?) that logs
// "load image <extra> (1.2s)". Use done() on success, done(msg, "err") on failure.
export function timed(label) {
  const t0 = performance.now();
  log(`${label}…`, "run");
  return (extra = "", level = "ok") =>
    log(`${label}${extra ? " " + extra : ""} (${fmtDur(performance.now() - t0)})`, level);
}
