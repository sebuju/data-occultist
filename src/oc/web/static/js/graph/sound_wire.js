// Sound node wiring: the file/synth picker, volume meter, audition button, and the inline
// synth "forge" (generator mode) — a live pitch-over-time plot editor with loop preview,
// presets and a random roll. Split out of main.js; the node's DOM is built in sound_node.js,
// this file binds its controls. Forge preview state (loop sources, playhead sweep) is private
// to this module.
import { model } from "./state.js";
import { renameNode, movePos } from "./node_lifecycle.js";
import { GENERATOR } from "./sound_node.js";
import { playCue } from "./sound.js";
import { playSynth, noteName } from "./synth.js";
import { makeClip } from "./clipboard.js";
import { SYNTH_DEFAULTS } from "../defaults.js";
import { onOutside } from "../inputbus.js";
import { setModalOpenHook } from "../modal.js";
import { observeResize } from "../dom.js";
import { render, autosave, rebuildNode } from "./main.js";

export function wireSound(div, n) {
    const x = n.ref;
    const $ = (sel) => div.querySelector(sel);
    stopForgePreview(x.id);   // a rebuild replaces the DOM — drop any stale preview + its doc listener
    $(".sndrename")?.addEventListener("change", (e) => {
        const oldId = x.id;
        renameNode(e.target, oldId,
            () => model.renameSound(oldId, (e.target.value || "").trim()),
            () => movePos(`sound:${oldId}`, `sound:${x.id}`),
            () => { render(); autosave(null); });
    });
    $(".sn-file")?.addEventListener("change", (e) => {
        // the "[generator]" sentinel flips the node into synth mode (seeds a default cue) and grows
        // the inline forge; any other value is a plain file. Rebuild so the forge appears/disappears.
        if (e.target.value === GENERATOR) model.enableSoundSynth(x.id);
        else model.setSoundFile(x.id, e.target.value);
        rebuildNode(`sound:${x.id}`);
        autosave(null);
    });
    // volume is a segmented meter now (confMeter) — it dispatches `change` on drag; the bar shows
    // its own level, so there's no separate % label to sync. autosave coalesces the writes.
    $(".sn-volume")?.addEventListener("change", (e) => {
        model.setSoundVolume(x.id, e.target.value);
        // if a forge loop is previewing, track the new volume live (no restart, no sweep reset)
        forgePreview.get(x.id)?.ctl?.setVolume(model.soundNode(x.id)?.volume ?? 1);
        autosave(null);
    });
    // ▶ audition. File mode: one-shot. Synth mode: toggle a LOOPING preview so you can tweak while
    // it repeats (a real fire is always one-shot — playCue in activity.js). Also unlocks autoplay.
    $(".sn-test")?.addEventListener("click", (e) => {
        const s = model.soundNode(x.id);
        if (!s) return;
        if (!s.synth) { playCue(s); return; }
        toggleForgePreview(div, x.id, e.currentTarget);
    });
    if (x.synth) wireForge(div, x.id);
}

// ---- the inline synth "forge" (generator mode) --------------------------------
// One live loop-preview source per open forge (keyed by node id) so PLAY toggles and edits restart
// it. Not persisted — purely a tweak aid.
const forgePreview = new Map();   // soundId -> { ctl, btn, off }
const forgeAnim = new Map();      // soundId -> () => kick the plot's playhead-sweep rAF (set by wireForge)
// Starting a loop is ASYNC (playSynth awaits the offline render). A stop/restart landing during that
// await used to leave the finished source attached to an already-dropped entry — a loop nothing held
// a reference to, so it played until a page reload. Every start/stop bumps this epoch; a start that
// finds its epoch superseded stops its own source and drops it.
const forgeGen = new Map();       // soundId -> monotonic epoch
const bumpForge = (id) => { const g = (forgeGen.get(id) || 0) + 1; forgeGen.set(id, g); return g; };
function stopForgePreview(id) {
    const p = forgePreview.get(id);
    bumpForge(id);
    if (!p) return;
    p.ctl?.stop(); p.off?.();
    p.btn && (p.btn.classList.remove("on"), p.btn.lastChild.textContent = "play");
    forgePreview.delete(id);
}
// Stop every open forge's loop preview at once — a preview must not keep sounding behind a modal
// or after switching between the node graph and pretty view (wired to setModalOpenHook + setPrettyView).
export function stopAllForgePreview() { for (const id of [...forgePreview.keys()]) stopForgePreview(id); }
setModalOpenHook(stopAllForgePreview);   // any modal spawning stops open forge previews
async function toggleForgePreview(div, id, btn) {
    if (forgePreview.get(id)) { stopForgePreview(id); return; }
    const s = model.soundNode(id);
    if (!s?.synth) return;
    const gen = bumpForge(id);
    const ctl = await playSynth(s.synth, s.volume ?? 1, { loop: true });
    if (forgeGen.get(id) !== gen) { ctl.stop(); return; }   // stopped/restarted while rendering
    // stop the preview when focus leaves the node — a pointerdown anywhere outside this node's card
    // (another node, empty canvas, a panel). Capture phase so a graph handler that stops propagation
    // can't swallow it. Clicks INSIDE the node (knobs, plot, presets, the button itself) are ignored
    // here and manage the loop themselves.
    const off = onOutside(div, () => stopForgePreview(id));
    forgePreview.set(id, { ctl, btn, off });
    btn.classList.add("on"); btn.lastChild.textContent = "stop";
    forgeAnim.get(id)?.();   // start the playhead sweep now that a loop is running
}
// restart the loop with the current spec so edits are audible immediately (no-op if not previewing)
async function refreshForgePreview(id) {
    const p = forgePreview.get(id);
    if (!p) return;
    const s = model.soundNode(id);
    p.ctl?.stop(); p.ctl = null;
    const gen = bumpForge(id);
    const ctl = s?.synth ? await playSynth(s.synth, s.volume ?? 1, { loop: true }) : null;
    // superseded while rendering (stopped, or a faster edit already restarted it) => discard ours
    if (forgeGen.get(id) !== gen || forgePreview.get(id) !== p) { ctl?.stop(); return; }
    p.ctl = ctl;
    forgeAnim.get(id)?.();   // new source => new start time; ensure the sweep loop is running
}

// The two forge clipboards (the rules pipeline has its own — same primitive, clipboard.js). Module
// scope, so a copy on one node pastes onto another for the rest of the session.
const pitchClip = makeClip(".sf-ppaste");
const shapeClip = makeClip(".sf-spaste");
// Every knob EXCEPT the envelope points — what "shape" copies (the wave rides along separately).
const SHAPE_KEYS = Object.keys(SYNTH_DEFAULTS).filter((k) => k !== "wave");

// The plot's ONE invariant: points are sorted by t and the outer two are pinned to the plot edges.
// Deleting the first or last point used to leave the curve spanning only part of the plot, and
// since a drag refuses to move t on the end points (below), that dead margin could never be
// reclaimed — the cue looked stale. Re-pinning here means a delete visibly re-spans the plot.
function normPts(s) {
    const pts = s.points || [];
    pts.sort((a, b) => a.t - b.t);
    if (pts.length) { pts[0].t = 0; pts[pts.length - 1].t = 1; }
}

function wireForge(div, id) {
    const $ = (sel) => div.querySelector(sel);
    const canvas = $(".sf-plot-c");
    if (!canvas) return;
    const gx = canvas.getContext("2d", { willReadFrequently: true });   // software canvas: no accelerated-canvas compositor layer (see overlay.js)
    const spec = () => model.soundNode(id)?.synth;
    // the note a point SOUNDS as — synth.js owns the pitch->name mapping (transpose included), so a
    // plot label can never drift from what you hear
    const pToNote = (p) => noteName(p, spec()?.transpose ?? SYNTH_DEFAULTS.transpose);
    const commit = () => autosave(null);
    let drag = -1;

    const nt = () => getComputedStyle(canvas).getPropertyValue("--nt").trim() || "#c98cf0";
    function draw() {
        const s = spec(); if (!s) return;
        const r = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
        canvas.width = Math.max(1, Math.round(r.width * dpr)); canvas.height = Math.max(1, Math.round(r.height * dpr));
        const W = canvas.width, H = canvas.height, pts = s.points || [];
        gx.clearRect(0, 0, W, H);
        gx.lineWidth = 1; gx.strokeStyle = "rgba(201,140,240,.14)";
        for (let i = 0; i <= 12; i++) { const gxx = i / 12 * W; gx.beginPath(); gx.moveTo(gxx, 0); gx.lineTo(gxx, H); gx.stroke(); }
        for (let j = 0; j <= 6; j++) { const gy = j / 6 * H; gx.beginPath(); gx.moveTo(0, gy); gx.lineTo(W, gy); gx.stroke(); }
        const col = nt();
        // dashed vertical at each point marks a transition; the segment durations sit along the bottom
        gx.setLineDash([4 * dpr, 4 * dpr]); gx.lineWidth = 1; gx.strokeStyle = "rgba(201,140,240,.35)";
        pts.forEach((pt) => { const x = pt.t * W; gx.beginPath(); gx.moveTo(x, 0); gx.lineTo(x, H); gx.stroke(); });
        gx.setLineDash([]);
        const line = (w, c, blur) => { gx.lineWidth = w; gx.strokeStyle = c; gx.shadowColor = c; gx.shadowBlur = blur;
            gx.beginPath(); pts.forEach((pt, i) => { const px = pt.t * W, py = (1 - pt.p) * H; i ? gx.lineTo(px, py) : gx.moveTo(px, py); }); gx.stroke(); };
        line(5, "rgba(201,140,240,.18)", 0); line(2.4, col, 10); gx.shadowBlur = 0;
        const muted = getComputedStyle(canvas).getPropertyValue("--muted").trim() || "#8b93a3";
        // Label size is a FRACTION of the plot height, not a fixed px — so labels scale WITH the node
        // as the graph zooms (a fixed-px label stayed the same on-screen size and looked oversized
        // when the node shrank on zoom-out). Everything below is derived from `lf`.
        const lf = Math.max(6, H * 0.075);
        // a pill-backed label centred at (cx,cy), clamped to stay fully inside the canvas so the
        // first/last point's note isn't clipped by the edges. `fh` = its font height (sizes the pill).
        const drawLabel = (text, cx, cy, fg, fh, minTop = 0) => {
            const w = gx.measureText(text).width, padX = fh * 0.4, h = fh * 1.5, rad = fh * 0.35;
            const x = Math.min(W - padX - w / 2, Math.max(padX + w / 2, cx));
            const y = Math.min(H - h / 2, Math.max(minTop + h / 2, cy));
            gx.textAlign = "center"; gx.textBaseline = "middle";
            gx.fillStyle = "rgba(10,14,21,.82)";
            gx.beginPath(); gx.roundRect(x - w / 2 - padX, y - h / 2, w + 2 * padX, h, rad); gx.fill();
            gx.fillStyle = fg; gx.fillText(text, x, y);
        };
        // points first, then labels ON TOP (with backgrounds). Dot radius also rides `lf` so it scales.
        pts.forEach((pt) => { const px = pt.t * W, py = (1 - pt.p) * H;
            gx.fillStyle = "#0c1119"; gx.strokeStyle = col; gx.lineWidth = Math.max(1, lf * 0.14);
            gx.beginPath(); gx.arc(px, py, lf * 0.55, 0, 7); gx.fill(); gx.stroke();
            gx.fillStyle = col; gx.beginPath(); gx.arc(px, py, lf * 0.2, 0, 7); gx.fill();
        });
        // segment durations (ms) pinned along the BOTTOM, centred under each segment between its two
        // transition lines — recomputed every draw, so they track the shape/length live.
        gx.font = `${Math.round(lf * 0.92)}px ui-monospace, monospace`;
        for (let i = 0; i < pts.length - 1; i++) {
            const a = pts[i], b = pts[i + 1];
            drawLabel(`${Math.round((b.t - a.t) * s.length_ms)}ms`, (a.t + b.t) / 2 * W, H - lf, muted, lf * 0.92);
        }
        // note labels above each dot (flipped below near the top edge). Reserve the top HUD band (the
        // DOM total-duration + help overlay) so a high-pitch point's pill doesn't draw over it —
        // measure the HUD's real bottom edge in canvas device-px (exact; draw() is interaction-driven).
        const hud = div.querySelector(".sf-hud"), pr = canvas.getBoundingClientRect();
        const topInset = hud ? Math.max(0, (hud.getBoundingClientRect().bottom - pr.top) * dpr) : 0;
        gx.font = `${Math.round(lf)}px ui-monospace, monospace`;
        pts.forEach((pt) => { const px = pt.t * W, py = (1 - pt.p) * H;
            drawLabel(pToNote(pt.p), px, py + (py > lf * 2 ? -lf * 1.05 : lf * 1.05), col, lf, topInset);
        });
        const len = div.querySelector(".sf-len");
        // guard the write: draw() runs every frame while the sweep animates, and a poll/tick redraw
        // must make zero DOM mutations in steady state (only writes when the length actually changed).
        if (len && len.textContent !== `${s.length_ms} ms`) len.textContent = `${s.length_ms} ms`;
        // playhead sweep: while a loop preview runs, draw a vertical line at the current playback
        // position so you can SEE which part of the cue is sounding. Map ctx time onto the cue length
        // (0..1); the buffer carries ~60ms of tail silence past length_ms, so clamp/hide past the end.
        const ctl = forgePreview.get(id)?.ctl;
        if (ctl?.ctx && ctl.startedAt != null && s.length_ms > 0) {
            const period = s.length_ms / 1000;
            const ph = ((ctl.ctx.currentTime - ctl.startedAt) % ctl.duration) / period;
            if (ph >= 0 && ph <= 1) {
                const px = ph * W;
                gx.save(); gx.setLineDash([]);
                gx.lineWidth = 2 * dpr; gx.strokeStyle = col; gx.shadowColor = col; gx.shadowBlur = 8 * dpr;
                gx.beginPath(); gx.moveTo(px, 0); gx.lineTo(px, H); gx.stroke();
                gx.restore();
            }
        }
    }
    // playhead-sweep animation: a self-terminating rAF that redraws the plot each frame WHILE a loop
    // preview runs (draw() paints the moving line), then stops rescheduling once the preview ends —
    // the final frame clears the line. Kicked by the preview lifecycle (toggle/refresh) via forgeAnim.
    let raf2 = 0;
    const playhead = () => {
        raf2 = 0;
        if (!canvas.isConnected) { dropAnim(); return; }
        draw();
        if (forgePreview.get(id)) raf2 = requestAnimationFrame(playhead);
    };
    const kick = () => { if (!raf2 && canvas.isConnected) raf2 = requestAnimationFrame(playhead); };
    // forgeAnim is keyed by sound id, but a node rebuild runs wireForge AGAIN over new DOM — so a
    // stale closure's cleanup must never evict the LIVE kicker the newer wireForge installed (that
    // left the sweep dead: audio looped, no playhead line). Only drop the entry if it's still ours.
    const dropAnim = () => { if (forgeAnim.get(id) === kick) forgeAnim.delete(id); };
    forgeAnim.set(id, kick);
    // restart the loop preview live while dragging a point/knob, throttled so a fast drag doesn't
    // machine-gun the audio source — you hear the shape change as you move (no-op if not previewing).
    let lastLive = 0;
    const liveRefresh = () => {
        if (!forgePreview.get(id)) return;
        const now = performance.now();
        if (now - lastLive < 110) return;
        lastLive = now; refreshForgePreview(id);
    };
    const pos = (e) => { const r = canvas.getBoundingClientRect();
        return { t: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), p: Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height)) }; };
    const nearest = (q) => { const pts = spec()?.points || []; let bi = -1, bd = 1;
        pts.forEach((pt, i) => { const d = Math.hypot(pt.t - q.t, pt.p - q.p); if (d < bd) { bd = d; bi = i; } }); return bd < 0.07 ? bi : -1; };
    // A press only ever GRABS an existing point — adding is a double-click (a single click kept
    // dropping stray points while aiming at a dot).
    canvas.addEventListener("pointerdown", (e) => {
        if (e.button === 2) return;
        const s = spec(); if (!s) return;
        const hit = nearest(pos(e));
        if (hit < 0) return;
        drag = hit;
        canvas.classList.add("grabbing");
        canvas.setPointerCapture(e.pointerId); draw();
    });
    canvas.addEventListener("dblclick", (e) => {
        const s = spec(); if (!s) return;
        const q = pos(e);
        if (nearest(q) >= 0) return;   // double-clicking an existing point must not stack a twin on it
        s.points.push(q); normPts(s); draw(); commit(); refreshForgePreview(id);
    });
    canvas.addEventListener("pointermove", (e) => {
        const s = spec(); if (!s) return;
        if (drag < 0) {
            // hover feedback: a grab cursor over a draggable dot, the crosshair everywhere else
            canvas.classList.toggle("over-dot", nearest(pos(e)) >= 0);
            return;
        }
        const q = pos(e), pt = s.points[drag];
        pt.p = q.p; if (drag > 0 && drag < s.points.length - 1) pt.t = q.t;
        normPts(s); drag = s.points.indexOf(pt); draw(); liveRefresh();
    });
    canvas.addEventListener("pointerup", () => {
        canvas.classList.remove("grabbing");
        if (drag < 0) return; drag = -1; commit(); refreshForgePreview(id);
    });
    canvas.addEventListener("contextmenu", (e) => {
        e.preventDefault(); const s = spec(); if (!s) return;
        const hit = nearest(pos(e));
        if (hit >= 0 && s.points.length > 2) { s.points.splice(hit, 1); normPts(s); draw(); commit(); refreshForgePreview(id); }
    });
    // waveform toggles
    div.querySelector(".sf-waves")?.addEventListener("click", (e) => {
        const b = e.target.closest(".sf-wbtn"); if (!b) return; const s = spec(); if (!s) return;
        div.querySelectorAll(".sf-wbtn").forEach((w) => w.classList.toggle("on", w === b));
        s.wave = b.dataset.wave; commit(); refreshForgePreview(id);
    });
    // knobs: live label update on input, persist + restart loop on change (release)
    div.querySelectorAll(".sf-k").forEach((el) => {
        const kv = div.querySelector(`.sf-kv[data-kv="${el.dataset.k}"]`);
        el.addEventListener("input", () => { const s = spec(); if (!s) return; s[el.dataset.k] = +el.value; if (kv) kv.textContent = el.value; if (el.dataset.k === "length_ms") draw(); liveRefresh(); });
        el.addEventListener("change", () => { commit(); refreshForgePreview(id); });
    });
    // sync every control + the canvas from the current spec (used when a preset/roll REPLACES it —
    // done in place, not via rebuildNode, so a running preview switches to the new cue seamlessly).
    const applySpec = () => {
        const s = spec(); if (!s) return;
        div.querySelectorAll(".sf-wbtn").forEach((w) => w.classList.toggle("on", w.dataset.wave === s.wave));
        div.querySelectorAll(".sf-k").forEach((el) => {
            // a spec authored before a knob existed omits it — show the neutral default, never the
            // slider's minimum (which would silently RE-AUTHOR the cue on the next drag)
            const v = s[el.dataset.k] ?? SYNTH_DEFAULTS[el.dataset.k];
            el.value = v;
            const kv = div.querySelector(`.sf-kv[data-kv="${el.dataset.k}"]`);
            if (kv) kv.textContent = String(v);
        });
        draw();
    };
    // load the new cue, then PLAY IT: restart the loop if previewing, else one-shot audition. Never
    // keep playing the previous cue.
    const loadCue = (mk) => {
        model.setSoundSynth(id, mk); applySpec(); commit();
        if (forgePreview.get(id)) refreshForgePreview(id); else playCue(model.soundNode(id));
    };
    div.querySelector(".sn-roll")?.addEventListener("click", () => loadCue(rollSynth()));
    // section copy/paste. Both write THROUGH the live spec (never rebuildNode) so a running preview
    // switches to the pasted material without a gap — the same in-place path as roll/preset.
    const pasted = () => { normPts(spec()); applySpec(); commit();
        if (forgePreview.get(id)) refreshForgePreview(id); else playCue(model.soundNode(id)); };
    pitchClip.wire(div, {
        copyCls: ".sf-pcopy", pasteCls: ".sf-ppaste",
        read: () => spec()?.points || [],
        write: (points) => { const s = spec(); if (!s) return; s.points = points; pasted(); },
    });
    shapeClip.wire(div, {
        copyCls: ".sf-scopy", pasteCls: ".sf-spaste",
        read: () => { const s = spec() || {}; return { wave: s.wave, ...Object.fromEntries(SHAPE_KEYS.map((k) => [k, s[k] ?? SYNTH_DEFAULTS[k]])) }; },
        write: (shape) => { const s = spec(); if (!s) return; Object.assign(s, shape); pasted(); },
    });
    // re-fit + redraw the canvas whenever the node (and thus the plot) resizes — points are 0..1 so
    // nothing to recompute, just keep the backing store crisp (dom.js observeResize, rule 7).
    observeResize(canvas, draw);
    // Graph ZOOM scales the node via a CSS transform on #gworld — that does NOT fire ResizeObserver,
    // so the backing store would stay at 1× and blur when zoomed in. Watch the world transform and
    // refit only when the SCALE part changed. Zoom vs pan is decided from the style string itself —
    // never read geometry here: a getBoundingClientRect right after the transform write forces a
    // sync layout of the whole document on every pan frame (traced as the pan jank).
    const gworld = document.getElementById("gworld");
    if (gworld) {
        let raf = 0, lastScale = "";
        const mo = new MutationObserver(() => {
            if (!canvas.isConnected) { mo.disconnect(); cancelAnimationFrame(raf2); dropAnim(); return; }   // node removed → self-clean
            const sc = (/scale\(([^)]*)\)/.exec(gworld.style.transform) || [, "1"])[1];
            if (sc === lastScale || raf) return;   // pan (scale unchanged) → zero layout work
            lastScale = sc;
            raf = requestAnimationFrame(() => { raf = 0; draw(); });
        });
        mo.observe(gworld, { attributes: true, attributeFilter: ["style"] });
    }
    draw();
}

// Roll a genuinely fresh random cue — every click gives something new (an earlier version derived
// everything from length_ms alone, so rolling twice produced the identical cue). Randomizes wave,
// length, the pitch-over-time points, and the shape knobs across sane musical ranges. The colour
// knobs (sub/noise/echo/repeat/crush/vibrato) fire only SOMETIMES: rolling every one of them every
// time just averages out to the same wall of mud each click.
const _rr = (a, b) => a + Math.random() * (b - a);
const _some = (chance, a, b) => (Math.random() < chance ? Math.round(_rr(a, b)) : 0);
function rollSynth() {
    const n = 3 + ((Math.random() * 4) | 0);   // 3..6 points, endpoints pinned at t=0 and t=1
    const points = [];
    for (let i = 0; i < n; i++) points.push({ t: i / (n - 1), p: +(0.1 + Math.random() * 0.85).toFixed(3) });
    const waves = ["square", "sine", "sawtooth", "triangle"];
    const filtered = Math.random() < 0.45;
    return {
        wave: waves[(Math.random() * waves.length) | 0],
        points,
        length_ms: Math.round(_rr(120, 700)),
        attack: Math.round(_rr(0, 20)),
        decay: Math.round(_rr(30, 80)),
        release: _some(0.35, 10, 60),
        repeat: Math.random() < 0.25 ? 2 + ((Math.random() * 3) | 0) : 1,
        glide: Math.random() < 0.3 ? Math.round(_rr(0, 40)) : 100,   // sometimes a stepped arp
        transpose: Math.random() < 0.4 ? Math.round(_rr(-12, 12)) : 0,
        vibrato: _some(0.4, 5, 60),
        sub: _some(0.35, 20, 70),
        noise: _some(0.3, 8, 45),
        cutoff: filtered ? Math.round(_rr(35, 85)) : 100,
        reso: filtered ? Math.round(_rr(0, 70)) : 0,   // resonance only means anything under a cutoff
        crush: _some(0.5, 5, 40),
        echo: _some(0.3, 20, 65),
        echo_ms: Math.round(_rr(40, 220)),
    };
}
