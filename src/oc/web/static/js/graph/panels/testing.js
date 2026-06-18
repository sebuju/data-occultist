// Testing harness floating panel — play a recorded screen-capture clip through the live
// OCR pipeline (step/play frames as the live frame source) plus a capture-rate benchmark.
// Extracted from main.js verbatim.
import * as api from "../../api.js";
import * as conn from "../../conn.js";
import { log, timed } from "../../log.js";
import { createFloatWin } from "../floatwin.js";
import { persist } from "../persist.js";
import { $, model } from "../state.js";

// ---- testing harness: play a recorded video through the live OCR pipeline ----
// Import a screen-capture clip and step/play it as the live frame source so live
// mode's detect + OCR can be exercised with no game running. The frame source +
// playback position live server-side (one VideoSource); this panel just drives it
// and mirrors the returned status. Playback is browser-paced (a timer that steps
// one frame per tick); live mode reads whichever frame is current, independently.
const testState = { visible: false, x: null, y: null, w: null, h: null };
let testWin = null, testInfo = null, testTimer = null;

function testRender(info) {
    if (!testWin) return;
    if (info) testInfo = info;
    const i = testInfo || { loaded: false, count: 0, index: 0, enabled: false, name: "" };
    const b = testWin.body;
    const loaded = !!i.loaded;
    b.querySelector(".test-name").textContent =
        loaded ? `${i.name}  (${i.width}×${i.height}, ${i.fps || "?"}fps)` : "no video loaded";
    const seek = b.querySelector(".test-seek");
    seek.max = String(Math.max(0, (i.count || 1) - 1));
    if (document.activeElement !== seek) seek.value = String(i.index || 0);
    b.querySelector(".test-frame").textContent =
        loaded ? `${(i.index || 0) + 1} / ${i.count || "?"}` : "– / –";
    b.querySelector(".test-feed-cb").checked = !!i.enabled;
    b.querySelector(".test-play").textContent = testTimer ? "pause" : "▶ play";
    for (const el of b.querySelectorAll(".test-ctl")) el.disabled = !loaded;
}

function testStopPlay() {
    if (testTimer) { clearInterval(testTimer); testTimer = null; }
    testRender();
}

function testStartPlay() {
    if (testTimer || !testInfo?.loaded) return;
    const fps = testInfo.fps || 30;
    const ms = Math.max(100, Math.round(1000 / fps));   // cap pace so reads can keep up
    testTimer = setInterval(async () => {
        if (!conn.isOnline()) return;   // backend down -> halt playback stepping
        try {
            const info = await api.video.step(1);
            testRender(info);
            if (info.count && info.index >= info.count - 1) testStopPlay();   // hit the end
        } catch (e) { testStopPlay(); log(String(e.message || e), "err"); }
    }, ms);
    testRender();
}

function buildTesting() {
    if (testWin) return;
    testWin = createFloatWin({
        id: "testing", title: "testing", state: testState, bothAxes: true,   // auto-fit height; user can still resize
        onShow: () => { $("testingBtn")?.classList.toggle("active", true);
            api.video.status().then(testRender).catch(() => {}); },
        onHide: () => { $("testingBtn")?.classList.toggle("active", false); testStopPlay(); },
        onPersist: () => persist.layout(),
    });
    testWin.body.innerHTML = `<div class="test-panel">
    <input type="file" class="test-file" accept="video/*" />
    <div class="test-name">no video loaded</div>
    <div class="test-bar">
      <button class="test-ctl test-back" title="step back one frame">◀</button>
      <button class="test-ctl test-play" title="play / pause">▶ play</button>
      <button class="test-ctl test-fwd" title="step forward one frame">▶</button>
    </div>
    <input type="range" class="test-ctl test-seek" min="0" max="0" value="0" />
    <div class="test-frame">– / –</div>
    <label class="test-feed"><input type="checkbox" class="test-ctl test-feed-cb" /> feed live mode from video</label>
    <div class="test-hint">enable feed, open a window, then turn on <b>live</b> to OCR each frame.</div>
    <div class="test-sep"></div>
    <div class="test-cap">
      <div class="test-cap-head">capture rate
        <select class="test-cap-be" title="capture backend to measure"></select>
        <button class="test-cap-run">measure</button>
      </div>
      <div class="test-cap-out">– not measured –</div>
      <div class="test-hint"><b>grabs/s</b> = how fast capture returns. <b>frames/s</b> = real new frames
        (WGC is capped at the monitor refresh; a static screen yields ~0). PrintWindow forces a game
        re-render per grab — WGC does not.</div>
    </div>
  </div>`;
    const b = testWin.body;
    b.querySelector(".test-file").addEventListener("change", async (ev) => {
        const f = ev.target.files?.[0];
        if (!f) return;
        const done = timed(`load video ${f.name}`);
        testStopPlay();
        try { testRender(await api.video.upload(f)); done(); }
        catch (e) { done(String(e.message || e), "err"); }
    });
    b.querySelector(".test-back").addEventListener("click", async () => {
        testStopPlay();
        try { testRender(await api.video.step(-1)); } catch (e) { log(String(e.message || e), "err"); }
    });
    b.querySelector(".test-fwd").addEventListener("click", async () => {
        testStopPlay();
        try { testRender(await api.video.step(1)); } catch (e) { log(String(e.message || e), "err"); }
    });
    b.querySelector(".test-play").addEventListener("click", () => {
        if (testTimer) testStopPlay(); else testStartPlay();
    });
    const seek = b.querySelector(".test-seek");
    seek.addEventListener("input", () => {   // live label while dragging, no server call
        b.querySelector(".test-frame").textContent = `${Number(seek.value) + 1} / ${testInfo?.count || "?"}`;
    });
    seek.addEventListener("change", async () => {
        testStopPlay();
        try { testRender(await api.video.seek(Number(seek.value))); } catch (e) { log(String(e.message || e), "err"); }
    });
    b.querySelector(".test-feed-cb").addEventListener("change", async (ev) => {
        try { testRender(await api.video.enable(ev.target.checked)); } catch (e) { log(String(e.message || e), "err"); }
    });
    wireCaptureBench(b);
    testRender();
}

// Capture-rate tester (lives in the testing panel). Populates the backend dropdown
// once from /api/bench/backends (so wgc only shows when windows-capture is installed),
// then "measure" runs a short server-side grab benchmark and prints the rate. All
// click-driven — no poll — so a plain innerHTML write of the small result is fine.
let benchBackendsLoaded = false;
function wireCaptureBench(b) {
    const sel = b.querySelector(".test-cap-be");
    const out = b.querySelector(".test-cap-out");
    const run = b.querySelector(".test-cap-run");
    const loadBackends = async () => {
        if (benchBackendsLoaded) return;
        try {
            const { backends, default: def } = await api.bench.backends();
            sel.replaceChildren(...backends.map((n) => {
                const o = document.createElement("option");
                o.value = n; o.textContent = n === def ? `${n} (default)` : n;
                if (n === def) o.selected = true;
                return o;
            }));
            benchBackendsLoaded = true;
        } catch (e) { log(String(e.message || e), "err"); }
    };
    loadBackends();
    run.addEventListener("click", async () => {
        const game = model.profile.name;
        if (!game) { out.textContent = "load a game first"; return; }
        run.disabled = true; out.textContent = `measuring ${sel.value}…`;
        const done = timed(`bench ${sel.value}`);
        try {
            const r = await api.bench.run(game, sel.value, 3);
            const cap = r.captured ? `${r.captured[0]}×${r.captured[1]}` : "?";
            const fps = r.frames_per_s == null
                ? `frames/s = grabs/s (fresh frame per grab)`
                : `frames/s = <b>${r.frames_per_s}</b> (${r.frames} distinct${r.frames_per_s < 1 ? " — static screen" : ""})`;
            out.innerHTML = `<b>${r.backend}</b> @ ${cap}<br>`
                + `grabs/s = <b>${r.grabs_per_s}</b> (${r.ms_per_grab} ms/grab)<br>${fps}`;
            done();
        } catch (e) { out.textContent = String(e.message || e); done(String(e.message || e), "err"); }
        finally { run.disabled = false; }
    });
}

export {
    testWin, testState, testRender, testStopPlay, testStartPlay, buildTesting,
    wireCaptureBench,
};
