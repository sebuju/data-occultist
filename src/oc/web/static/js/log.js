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

// Expand/collapse the log history programmatically (boot opens it so the initial-load
// progress is visible, then collapses it once the page is ready).
export function setLogOpen(on) {
    if (!ensure()) return;
    bar.classList.toggle("open", !!on);
    bar.classList.toggle("boot", !!on);   // boot lifts it above the boot veil (z-index)
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

// Mirror uncaught errors + console.error/warn into the log bar so problems show up without
// devtools open. Only the brief message is logged (never the full stack — the bar is a
// glanceable strip; devtools still has the trace). Idempotent; call once at boot.
let mirrored = false;
export function mirrorConsole() {
    if (mirrored) return;
    mirrored = true;
    const brief = (v) => {
        if (v instanceof Error) return v.message || String(v);
        if (v && typeof v === "object") { try { return JSON.stringify(v); } catch { return String(v); } }
        return String(v);
    };
    const join = (args) => args.map(brief).join(" ").trim();
    for (const kind of ["error", "warn"]) {
        const orig = console[kind].bind(console);
        console[kind] = (...args) => { orig(...args); try { log(join(args), kind === "warn" ? "warn" : "err"); } catch { /* never let logging throw */ } };
    }
    window.addEventListener("error", (e) => log(e.error?.message || e.message || "script error", "err"));
    window.addEventListener("unhandledrejection", (e) => {
        const r = e.reason;
        log((r && (r.message || (typeof r === "string" && r))) || "unhandled promise rejection", "err");
    });
}

// timed("load image"): logs "load image…" now, returns done(extra?, level?, ms?) that logs
// "load image <extra> (1.2s)". Use done() on success, done(msg, "err") on failure. Pass an
// explicit `ms` to show a server-reported compute time instead of client wall-clock — OCR
// ops issued together serialize on the backend lock, so wall-since-issue is mostly queue
// wait and reads ~identical for every op; the server's own per-op time is the true cost.
export function timed(label) {
    const t0 = performance.now();
    log(`${label}…`, "run");
    return (extra = "", level = "ok", ms = null) =>
        log(`${label}${extra ? " " + extra : ""} (${fmtDur(ms == null ? performance.now() - t0 : ms)})`, level);
}
