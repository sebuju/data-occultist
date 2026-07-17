// Page boot: the ?debug=1 flag ceremony, the full-page boot veil, the blocking startup-halt
// overlay, and the kill-stray-OCR-then-load sequence that runs once at module load. Split out
// of main.js; refreshGames/loadGame/setPrettyView/initKillGpu/finishBoot stay in main and are
// imported back.
import * as api from "../api.js";
import * as conn from "../conn.js";
import * as hub from "../hub.js";
import { h } from "../dom.js";
import { $, model, setStatus } from "./state.js";
import { log, setLogOpen } from "../log.js";
import { ocrBusyCount } from "./imaging.js";
import { routesSettled } from "./routing.js";
import { setPrettyView } from "./pretty_switch.js";
import { refreshGames, loadGame, initKillGpu, finishBoot } from "./main.js";

// ---- debug launch: ?debug=1 skips the slow/heavy boot ceremony ----------------
// A dev/inspect launch that comes up instantly by defaulting every slow-or-noisy boot
// step OFF. Each piece is individually toggleable so you can turn just one back on:
//   /?debug=1                every slow step off (fastest: bare shell, no OCR touched)
//   /?debug=1&load=1         load the game but skip the kill/settle waits + veil/log
//   /?debug=1&settle=1       load AND wait for boot OCR to drain (but no kill/veil/log)
//   /?kill=1&veil=1&...      force any single step back on regardless of debug
// Booleans read "0"/"false" as off, anything else (incl. bare "?veil") as on.
const _dq = new URLSearchParams(location.search);
const _flag = (k, dflt) => { const v = _dq.get(k); return v === null ? dflt : (v !== "0" && v !== "false"); };
const dbg = { on: _flag("debug", false) };
// when debug is on each slow step defaults OFF; `load` stays on (an empty shell is rarely useful).
dbg.kill    = _flag("kill",    !dbg.on);   // kill+await any stray OCR worker from a prior session
dbg.settle  = _flag("settle",  !dbg.on);   // block the veil until the boot OCR round drains (bootSettle)
dbg.veil    = _flag("veil",    !dbg.on);   // full-page boot spinner
dbg.bootlog = _flag("bootlog", !dbg.on);   // expand the log bar + mirror every request during boot
dbg.load    = _flag("load",    true);      // load the selected game at all (off ⇒ empty graph, instant)
if (dbg.on) log(`debug launch: kill=${dbg.kill} settle=${dbg.settle} veil=${dbg.veil} bootlog=${dbg.bootlog} load=${dbg.load}`);

// ---- boot veil: full-page spinner until the initial load has settled ----------
const veil = {
    drop() {
        document.body.classList.remove("booting");   // screen is interactive now -> CSS motion on (covers error/offline paths that skip finishBoot)
        // the boot log floats over the veil -> slide it down off-screen in step with the crop,
        // then strip its boot/open chrome so it lands back as the one-line collapsed strip.
        const lb = document.getElementById("logbar");
        if (lb && lb.classList.contains("boot")) {
            lb.classList.add("liftout");
            setTimeout(() => lb.classList.remove("liftout", "boot", "open"), 320);
        }
        const v = document.getElementById("bootveil");
        if (!v) return;
        v.classList.add("fade");
        setTimeout(() => v.remove(), 320);
    },
};

// Wait until the boot round of OCR work (detects/previews fired by reopening images)
// has DRAINED — quiet for a stretch, not just momentarily empty between two reads.
// Hard cap so a hung server can't keep the veil up forever.
export async function bootSettle(maxMs = 30000, quietMs = 600) {
    const t0 = performance.now();
    let quiet = 0;
    while (performance.now() - t0 < maxMs) {
        const busy = ocrBusyCount();
        quiet = busy ? 0 : quiet + 150;
        if (quiet >= quietMs) return;
        await new Promise((res) => setTimeout(res, 150));
    }
}

// Full-screen blocking error card with a title, message lines, and one or more action
// buttons. The ONE such overlay — startup-halt and a failed game-load both build on it (don't
// copy the markup). `lines` = [{text, muted?}]; `actions` = [{label, primary?, run}]. A click
// removes the overlay BEFORE running, so a `run` that rebuilds it (retry) starts clean. Only
// one is ever shown at a time (an existing card is replaced).
export function blockOverlay({ title, lines = [], actions = [] }) {
    document.querySelector(".startup-halt")?.remove();
    const o = h("div", { class: "startup-halt" },
        h("div", { class: "startup-halt-box" },
            h("h3", title),
            lines.map((l) => h("p", { class: l.muted ? "muted" : null }, l.text)),
            h("div", { class: "halt-actions" },
                actions.map((a) => h("button", {
                    class: `startup-halt-retry${a.primary ? "" : " ghost"}`,
                    onClick: () => { o.remove(); a.run(); },
                }, a.label)))));
    document.body.appendChild(o);
    return o;
}

// Block the whole UI with an unmissable message and refuse to continue.
function haltStartup(msg) {
    veil.drop();   // the halt overlay must be visible (the veil sits above it)
    log(msg, "err");
    blockOverlay({
        title: "Background OCR still running",
        lines: [{ text: msg },
            { text: "Nothing was loaded. Kill the stray worker (or the python process), then retry.", muted: true }],
        actions: [{ label: "retry", primary: true, run: () => location.reload() }],
    });
}

// Until the initial load completes, a reconnect can't just "resume" — the graph was
// never loaded. Reload to run boot cleanly. After boot, a reconnect simply lets the
// gated pollers pick back up (conn.js hides the overlay), no reload needed.
let booted = false;
conn.onChange((up) => { if (up && !booted) location.reload(); });

// On page load, kill any background OCR worker from a prior session and WAIT for it to
// die. Do NOT load the graph until it's confirmed gone — a stray worker keeps hammering
// the GPU/game and is the thing you'd otherwise have to hunt down in Task Manager.
async function killStrayOcrThenBoot() {
    if (!dbg.veil) veil.drop();   // debug launch: no full-page spinner
    if (dbg.bootlog) setLogOpen(true);   // show the log history during boot so initial-load progress is visible
    // During boot, mirror EVERY api request into the log bar so the initial-load sequence (and any
    // stuck/slow endpoint) is visible live. Cleared once booted so steady state isn't noisy.
    if (dbg.bootlog) api.onApiRequest((ev) => {
        if (booted) return;
        if (ev.phase === "start") log(`→ ${ev.method} ${ev.path}`);
        else log(`${ev.ok ? "✓" : "✗"} ${ev.method} ${ev.path} · ${ev.ms}ms${ev.srv != null ? ` (srv ${ev.srv}ms)` : ""}${ev.ok ? "" : " " + (ev.reason || "failed")}`, ev.ok ? undefined : "err");
    });
    // a tripped circuit breaker (an endpoint that kept timing out) surfaces here so the user learns
    // why a panel went quiet — it auto-recovers when the endpoint responds again.
    if (!window._apiGuardWired) { window._apiGuardWired = true; window.addEventListener("api-guard", (e) => { setStatus(String(e.detail)); log(String(e.detail), "err"); }); }
    if (dbg.kill) try {
        log("stopping stray OCR…");
        const r = await api.precapture.killAll();
        if (r.alive && r.alive.length) {
            haltStartup(`OCR worker for ${r.alive.join(", ")} would not stop within the timeout.`);
            return;   // refuse to proceed
        }
        if (r.killed && r.killed.length) setStatus(`stopped stray OCR: ${r.killed.join(", ")}`);
    } catch (e) {
        if (!conn.isOnline()) {           // server unreachable, not an OCR problem
            veil.drop();                    // conn shows its own offline overlay; reconnect reloads
            return;
        }
        haltStartup(`Could not confirm background OCR was stopped: ${e.message || e}`);
        return;   // can't verify -> don't proceed
    }
    try {
        log("loading profile…");
        await refreshGames();
        model.sounds = await api.sounds.list().catch(() => []);   // trigger-sound picker options (global, once)
        if (dbg.load && $("gameSelect").value) await loadGame($("gameSelect").value);
        // ?view=pretty (the desktop window passes it) boots into the pretty dashboard;
        // a plain browser has no param and stays on the node view.
        if (new URLSearchParams(location.search).get("view") === "pretty") setPrettyView(true);
        initKillGpu();
        hub.init(() => model.profile.name);   // single backend heartbeat for every panel
        hub.start();
        log("first read…");
        if (dbg.settle) await bootSettle();
        finishBoot();   // boot OCR drained -> re-OCR fresh on later reads + run the one edge/group pass
        if (dbg.settle) await routesSettled();   // hold the veil until the edge routing pass lands — lines settle under it, not after
    } catch (e) {
        if (!conn.isOnline()) { veil.drop(); return; }   // dropped mid-boot -> offline overlay handles it
        log(String(e.message || e), "err");   // boot hiccup: show the page anyway
    }
    booted = true;
    api.onApiRequest(null);   // stop mirroring requests into the log bar (boot done)
    veil.drop();   // also slides the boot log down + collapses it once the crop finishes
}

export function bootGraph() {
    killStrayOcrThenBoot();
}
