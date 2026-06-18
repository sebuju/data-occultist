// Background-worker registry — the log-bar live count + per-worker emergency kill button.
// Extracted from main.js verbatim.
import { $ } from "./state.js";

// ---- background worker registry -------------------------------------------
// Anything doing real background work — the backend precapture worker, the live
// re-read loop, future long jobs — registers here. The log bar then shows a live
// count on its far right plus a per-worker emergency kill button.
const workers = new Map();   // id -> { label, kill }
function registerWorker(id, label, kill) {
    const w = workers.get(id);
    if (w) { w.kill = kill; if (w.label === label) return; w.label = label; }   // same label -> nothing visible changed
    else workers.set(id, { label, kill });
    renderWorkers();
}
function unregisterWorker(id) { if (workers.delete(id)) renderWorkers(); }

// Reconcile the indicator IN PLACE — never rebuild innerHTML (the precapture poll
// re-registers every 700ms; rebuilding would restart the spinner animation and churn
// the buttons every tick). Fixed spinner + count are made once; buttons are reused.
let wkSpin = null, wkCount = null;
const workerBtns = new Map();   // id -> <button>
function renderWorkers() {
    const el = $("logWorkers");
    if (!el) return;
    el.hidden = workers.size === 0;
    if (!wkSpin) {
        wkSpin = document.createElement("span"); wkSpin.className = "lw-spin";
        wkCount = document.createElement("span"); wkCount.className = "lw-count";
        el.append(wkSpin, wkCount);
    }
    wkCount.textContent = `${workers.size} worker${workers.size === 1 ? "" : "s"}`;
    for (const [id, btn] of workerBtns) if (!workers.has(id)) { btn.remove(); workerBtns.delete(id); }
    for (const [id, w] of workers) {
        let btn = workerBtns.get(id);
        if (!btn) {
            btn = document.createElement("button");
            btn.className = "lw-kill"; btn.dataset.kill = id; btn.title = "emergency stop";
            el.appendChild(btn); workerBtns.set(id, btn);
        }
        if (btn._label !== w.label) { btn.textContent = `⨯ ${w.label}`; btn._label = w.label; }
    }
}

export { workers, registerWorker, unregisterWorker, renderWorkers };
