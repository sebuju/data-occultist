// The settings cog: new-game creation, capture-backend + OCR device controls, the live frame
// limiter, and the backups section — all built fresh per-open. Also owns the topbar kill-GPU
// button's visibility sync (syncKillGpu), read by both this modal and initKillGpu's heartbeat
// subscription. Split out of main.js; createGame/loadGame stay in main and are imported back.
import * as api from "../api.js";
import { $, model, setStatus } from "./state.js";
import { h } from "../dom.js";
import { openModal } from "../modal.js";
import { timed } from "../log.js";
import { fmtBytes } from "../bytefmt.js";
import { applyLiveInterval } from "./panels/livewin.js";
import { buildBackups } from "./backups.js";
import { createGame, loadGame } from "./main.js";
import { richPickerPop } from "./rich_picker.js";

// Show the topbar kill-GPU button only while a GPU OCR session is actually LOADED
// (holding VRAM) — `ocr.gpu_active`, not merely "GPU is selected". The heartbeat hub
// pushes the device slice every beat, so the button (re)appears on its own when a read
// rebuilds the GPU session and hides after a kill frees it. Idempotent: touches the DOM
// only on a real change (steady-state ticks mutate nothing).
export function syncKillGpu(ocr) {
    const k = $("killGpuBtn"); if (!k) return;
    // A LOADED GPU OCR session — CUDA (gpu_active) OR DirectML (dml_active, e.g. the iGPU).
    // gpu_mem sums this process's dedicated VRAM across adapters, so it already reports the
    // iGPU's footprint; the button frees either session via release().
    const hidden = !(ocr && (ocr.gpu_active || ocr.dml_active));
    if (k.hidden !== hidden) k.hidden = hidden;
    // VRAM readout beside the button: the server process's dedicated GPU memory
    // (gpu_mem, bytes; null when unreadable). Same visibility as the button, and
    // textContent-only updates so steady-state beats mutate nothing.
    const lbl = $("gpuMemLbl"); if (!lbl) return;
    const memHidden = hidden || typeof ocr.gpu_mem !== "number";
    if (lbl.hidden !== memHidden) lbl.hidden = memHidden;
    const txt = memHidden ? "" : fmtBytes(ocr.gpu_mem);
    if (lbl.textContent !== txt) lbl.textContent = txt;
}

// Wire the OCR device + downscale selects inside a freshly-built settings modal.
// Friendly labels for the registry backend names; an unknown name falls back to itself,
// so a newly-registered backend still shows (just without a hand-written blurb).
const CAPTURE_LABELS = {
    wgc: "WGC (composited, no re-render)",
    printwindow: "PrintWindow (re-renders window)",
    mss: "MSS (screen region)",
};

async function wireCaptureControls(root) {
    const fgBtn = root.querySelector("#captureFg"), bgBtn = root.querySelector("#captureBg");
    if (!fgBtn || !bgBtn) return;
    try {
        const st = await api.captureBackend.getBackend();
        const label = (n) => CAPTURE_LABELS[n] || n;
        // Both grabbers pick from the same plain-backend list (sub_names), fetched once above —
        // the picker reads it live at click time (a thunk would refetch; this list never changes
        // mid-session, so the one fetch is enough).
        const names = st.sub_names || [];
        const sync = (s) => {
            if (s.foreground) fgBtn.textContent = `<${label(s.foreground)}>`;
            if (s.background) bgBtn.textContent = `<${label(s.background)}>`;
        };
        sync(st);
        const change = async (foreground, background) => {
            const done = timed(`capture: ${foreground} fg / ${background} bg`);
            try { sync(await api.captureBackend.setBackend({ foreground, background })); done(); }
            catch (e) { done(String(e.message || e), "err"); }
        };
        const cur = (btn) => (btn.textContent.match(/^<(.*)>$/) || [, ""])[1];
        const curName = (btn) => names.find((n) => label(n) === cur(btn)) || names[0];
        fgBtn.addEventListener("click", () => richPickerPop({
            anchor: fgBtn, current: curName(fgBtn),
            groups: [[null, names.map((n) => ({ value: n, label: label(n) }))]],
            onPick: (v) => change(v, curName(bgBtn)),
        }));
        bgBtn.addEventListener("click", () => richPickerPop({
            anchor: bgBtn, current: curName(bgBtn),
            groups: [[null, names.map((n) => ({ value: n, label: label(n) }))]],
            onPick: (v) => change(curName(fgBtn), v),
        }));
    } catch { /* ignore */ }
}

async function wireOcrControls(root) {
    const sel = root.querySelector("#ocrDevice");
    if (!sel) return;
    try {
        const st = await api.ocr.getDevice();
        const DEVICE_OPTS = [["auto", "Auto (CPU; GPU for precapture)"], ["cpu", "CPU"], ["gpu", "GPU"]];
        let deviceGate = { noCuda: false, noEngine: false };   // set by gateDevice, read by the picker
        // GPU + Auto need CUDA AND an engine that honours it. No CUDA install -> "(n/a)";
        // an engine that can't use CUDA (OpenVINO runs CPU/iGPU) -> "(n/a: OpenVINO)". Either
        // way the device switch would be a no-op, so grey them out. Re-run when the engine
        // changes (cuda_capable is per-engine).
        function gateDevice(s) {
            deviceGate = { noCuda: !s.gpu_available, noEngine: s.cuda_capable === false };
        }
        const deviceLabel = (v) => {
            const base = (DEVICE_OPTS.find(([dv]) => dv === v) || [, v])[1];
            const { noCuda, noEngine } = deviceGate;
            if (v === "gpu") return noCuda ? "GPU (n/a)" : noEngine ? "GPU (n/a: OpenVINO)" : base;
            if (v === "auto") return noEngine ? "Auto (n/a: OpenVINO)" : base;
            return base;
        };
        const setDeviceLabel = (v) => { sel.dataset.v = v; sel.textContent = `<${deviceLabel(v)}>`; };
        sel.addEventListener("click", () => richPickerPop({
            anchor: sel, current: sel.dataset.v || "auto",
            groups: [[null, DEVICE_OPTS.map(([v]) => ({
                value: v, label: deviceLabel(v),
                disabled: v !== "cpu" && (deviceGate.noCuda || deviceGate.noEngine),
            }))]],
            onPick: async (v) => {
                setDeviceLabel(v);
                const done = timed(`OCR device → ${v}`);
                // Keep the user's pick; only correct it if the server reports a different MODE.
                // (Never fall back to the live device — under "auto" that's cpu and would yank it.)
                try { const r = await api.ocr.setDevice(v); if (r.mode) setDeviceLabel(r.mode); syncKillGpu(r); syncCompute(r); done(); }
                catch (e) { done(String(e.message || e), "err"); }
            },
        }));
        // "running on" line: the ACTUAL compute target, so DirectML (iGPU) never reads as
        // "cpu". Prefers a live session (gpu_active/dml_active); falls back to what the config
        // WILL run on the next read when the lazy session isn't built yet.
        const computeRow = root.querySelector("#ocrComputeRow"), computeLbl = root.querySelector("#ocrComputeLbl");
        function computeTarget(s) {
            if (s.dml_active || s.dml_requested) return "GPU · DirectML" + (s.dml_active ? "" : " (loads on next read)");
            if (s.gpu_active) return "GPU · CUDA";
            if (s.mode === "gpu" && s.gpu_available && s.cuda_capable !== false) return "GPU · CUDA (loads on next read)";
            if (s.engine_type === "openvino") return "CPU / iGPU · OpenVINO";
            return "CPU";
        }
        function syncCompute(s) {
            if (!computeRow || !computeLbl) return;
            const txt = computeTarget(s);
            if (computeLbl.textContent !== txt) computeLbl.textContent = txt;
            if (computeRow.hidden) computeRow.hidden = false;
        }
        gateDevice(st);
        setDeviceLabel(st.mode || st.device);   // the button reflects the MODE, not the live device
        syncKillGpu(st);
        syncCompute(st);

        // Backend-specific knobs: the state reports null for anything the live engine
        // lacks, so a control only appears when it would actually do something.
        const engRow = root.querySelector("#ocrEngineRow"), engSel = root.querySelector("#ocrEngine");
        if (engRow && st.engine_type && (st.engine_types || []).length) {
            engRow.hidden = false;
            const engTypes = st.engine_types;
            const setEngLabel = (v) => { engSel.dataset.v = v; engSel.textContent = `<${v}>`; };
            setEngLabel(st.engine_type);
            engSel.addEventListener("click", () => richPickerPop({
                anchor: engSel, current: engSel.dataset.v,
                groups: [[null, engTypes.map((n) => ({ value: n, label: n }))]],
                onPick: async (v) => {
                    setEngLabel(v);
                    const done = timed(`OCR engine → ${v}`);
                    // GPU/Auto availability is per-engine (OpenVINO can't use CUDA), so re-gate
                    // the device picker from the fresh state the switch returns.
                    try {
                        const r = await api.ocr.setEngineType(v);
                        if (r.engine_type) setEngLabel(r.engine_type);
                        gateDevice(r); syncKillGpu(r); syncCompute(r);
                        done();
                    } catch (e) { done(String(e.message || e), "err"); }
                },
            }));
        }
        const thRow = root.querySelector("#ocrThreadsRow"), thIn = root.querySelector("#ocrThreads");
        if (thRow && st.threads != null) {
            thRow.hidden = false;
            thIn.value = String(st.threads);
            thIn.addEventListener("change", async () => {
                const done = timed(`OCR cpu threads → ${thIn.value || 0}`);
                try { const r = await api.ocr.setThreads(Math.max(0, parseInt(thIn.value, 10) || 0)); thIn.value = String(r.threads ?? 0); done(); }
                catch (e) { done(String(e.message || e), "err"); }
            });
        }
        const scRow = root.querySelector("#ocrScaleRow"), scBtn = root.querySelector("#ocrScale");
        if (scRow && st.scale != null) {   // null => engine has no downscale knob -> stay hidden
            scRow.hidden = false;
            wireOcrScale(scBtn, String(st.scale || 1));   // shared wiring helper (rule 7)
        }
        const gmRow = root.querySelector("#ocrGpuMemRow"), gmIn = root.querySelector("#ocrGpuMem");
        if (gmRow && st.gpu_mem_gb != null) {
            gmRow.hidden = false;
            gmIn.value = String(st.gpu_mem_gb);
            gmIn.addEventListener("change", async () => {
                const done = timed(`OCR gpu mem cap → ${gmIn.value} GB`);
                try { const r = await api.ocr.setGpuMemGb(parseFloat(gmIn.value) || 3); gmIn.value = String(r.gpu_mem_gb ?? 3); done(); }
                catch (e) { done(String(e.message || e), "err"); }
            });
        }
    } catch { /* ignore */ }
}

const SCALE_OPTS = [["1", "1× full"], ["2", "1/2 (1/4 px)"], ["4", "1/4 (1/16 px)"]];

// Wire the OCR detection-downscale rich-dd-btn to its api setter, echoing the server's canonical
// value back into the button. Lives in the settings modal (was the live panel). `cur` seeds the
// button's initial label.
export function wireOcrScale(btn, cur) {
    const setLabel = (v) => { btn.dataset.v = v; btn.textContent = `<${(SCALE_OPTS.find(([sv]) => sv === v) || [, v])[1]}>`; };
    setLabel(cur);
    btn.addEventListener("click", () => richPickerPop({
        anchor: btn, current: btn.dataset.v,
        groups: [[null, SCALE_OPTS.map(([v, l]) => ({ value: v, label: l }))]],
        onPick: async (v) => {
            setLabel(v);
            const done = timed(`OCR downscale → ${v}×`);
            try { const r = await api.ocr.setScale(v); setLabel(String(r.scale || 1)); done(); }
            catch (e) { done(String(e.message || e), "err"); }
        },
    }));
}

// Settings modal (cog): new-game creation, OCR controls, and a backups section — all
// built fresh per-open and wired here (no persistent holder; the modal owns its DOM).
export function wireSettingsButton() {
    $("settingsBtn")?.addEventListener("click", () => {
        const wrap = h("div", { class: "settings" },
            h("section", { class: "set-sec" },
                h("h4", "general"),
                h("div", { class: "set-row" },
                    h("input", { id: "newGameName", placeholder: "new game name" }),
                    h("button", { id: "newGameBtn" }, "create"))),
            h("section", { class: "set-sec" },
                h("h4", "capture"),
                // Capture is a per-grab focus switch: a foreground grabber (game on top) and a
                // background grabber (occluded). Set both the same for single-backend capture.
                h("label", { class: "set-row", title: "How frames are grabbed while the game IS the focused window — cheapest wins (MSS: CPU BitBlt, no GPU). Options come from the live registry." },
                    h("span", "foreground"),
                    h("button", { id: "captureFg", class: "rich-dd-btn", type: "button" }, "<…>")),
                h("label", { class: "set-row", title: "How frames are grabbed while the game is backgrounded/occluded — must read the window's own surface (PrintWindow: GPU-light, re-renders; WGC: GPU-streamed, no re-render). Set the same as foreground for single-backend capture." },
                    h("span", "background"),
                    h("button", { id: "captureBg", class: "rich-dd-btn", type: "button" }, "<…>"))),
            h("section", { class: "set-sec" },
                h("h4", "OCR"),
                h("label", { class: "set-row", title: "OCR device — GPU needs onnxruntime-gpu + CUDA. Auto: CPU for editing, GPU for the precapture batch." },
                    h("span", "device"),
                    h("button", { id: "ocrDevice", class: "rich-dd-btn", type: "button" }, "<…>")),
                // Where OCR inference ACTUALLY runs. The device select above is the CUDA cpu/gpu
                // MODE; it reads "cpu" even when OCR runs on a non-NVIDIA GPU via DirectML (the
                // iGPU path), which is confusing — this line states the real compute target.
                h("div", { class: "set-row muted", id: "ocrComputeRow", hidden: true, title: "The inference engine + adapter OCR is running on right now." },
                    h("span", "running on"),
                    h("span", { id: "ocrComputeLbl" }, "")),
                // Backend-specific knobs: hidden until the server reports the engine has them.
                h("label", { class: "set-row", id: "ocrEngineRow", hidden: true, title: "Inference engine for the ppocr5 OCR backend. OpenVINO is often the faster CPU path on Intel; only installed runtimes are listed. Takes effect on the next read (model rebuilds lazily)." },
                    h("span", "engine"),
                    h("button", { id: "ocrEngine", class: "rich-dd-btn", type: "button" }, "<…>")),
                h("label", { class: "set-row", id: "ocrThreadsRow", hidden: true, title: "CPU threads each OCR inference may use. 0 = one per core (fastest reads, starves a running game); low values keep reads polite at some latency cost. Takes effect on the next read." },
                    h("span", "cpu threads"),
                    h("input", { id: "ocrThreads", type: "number", min: "0", max: "64", step: "1" })),
                // Detection downscale — only shown when the live engine has the knob.
                h("label", { class: "set-row", id: "ocrScaleRow", hidden: true, title: "Detection downscale — the DETECTION pass is the biggest single GPU burst per read; ½ = a quarter of the detect pixels = a much shorter stall. Recognition still crops from the full-detail frame, so text quality holds. Applies live to a running collector." },
                    h("span", "downscale"),
                    h("button", { id: "ocrScale", class: "rich-dd-btn", type: "button" }, "<…>")),
                h("label", { class: "set-row", id: "ocrGpuMemRow", hidden: true, title: "Hard VRAM ceiling (GB) for the GPU OCR session — it can never hold more than this. Too low and a big detect fails to allocate; 3 clears real 4K workloads. Applies on the next GPU session build." },
                    h("span", "gpu mem cap (GB)"),
                    h("input", { id: "ocrGpuMem", type: "number", min: "0.5", max: "64", step: "0.5" }))),
            h("section", { class: "set-sec" },
                h("h4", "live collection"),
                h("label", { class: "set-row", title: "Frame limiter — minimum milliseconds between collector reads. 0 (or blank) = as fast as possible (more CPU/GPU). Persists across restarts; a running collector restarts in place so it applies immediately." },
                    h("span", "frame limit (ms)"),
                    h("input", { id: "liveLimit", type: "number", min: "0", step: "10", placeholder: "0" }))),
            h("section", { class: "set-sec set-backups" }, h("h4", "backups"), h("div")));

        const name = model.profile.name;
        const handle = openModal({ title: "settings", size: "medium", node: wrap });

        // new game
        const ngName = wrap.querySelector("#newGameName");
        const submitGame = () => { if (createGame(ngName.value)) handle.close(); };
        wrap.querySelector("#newGameBtn").addEventListener("click", submitGame);
        ngName.addEventListener("keydown", (e) => { if (e.key === "Enter") submitGame(); });

        // capture backend
        wireCaptureControls(wrap);

        // OCR device + downscale
        wireOcrControls(wrap);

        // live frame limiter — persisted server-side; a running collector restarts in place so it
        // applies immediately (applyLiveInterval, exported by livewin, owns that restart).
        const limIn = wrap.querySelector("#liveLimit");
        if (limIn) {
            api.live.getInterval(handle.signal).then((r) => {
                const ms = Math.round((r.interval || 0) * 1000);
                limIn.value = ms > 0 ? String(ms) : "";
            }).catch(() => {});
            limIn.addEventListener("change", async () => {
                const ms = parseFloat(limIn.value);
                const secs = Number.isFinite(ms) && ms > 0 ? ms / 1000 : 0;
                if (secs === 0) limIn.value = "";
                const done = timed(`live frame limit → ${secs ? Math.round(secs * 1000) + "ms" : "off"}`);
                try { const r = await api.live.setInterval(secs); await applyLiveInterval(r.interval); done(); }
                catch (e) { done(String(e.message || e), "err"); }
            });
        }

        // backups (restoring re-saves the backup live -> reload it fresh)
        const bkHost = wrap.querySelector(".set-backups > div");
        if (name) {
            buildBackups(bkHost, name, {
                onRestored: () => { loadGame(name); setStatus("restored backup"); },
                signal: handle.signal, close: handle.close,
            });
        } else {
            bkHost.replaceChildren(h("div", { class: "muted bk-pad" }, "load a game to see its backups"));
        }
    });
}
