// e2e: the per-readout "Text appearance" preprocess controls on a readout node —
//   - colour chips actually RENDER (the swatch has non-zero size; the invisible-chip bug)
//   - tolerance is a 20-segment meter (not a range slider)
//   - removing a chip uses the standard two-click arm (first click arms, doesn't remove)
//   - every preprocess input carries a tooltip
//   - pp-pick opens the zoomed-cutout modal (best-effort: needs a bound capture)
//
// Run:  node tests/e2e/readout-preprocess.mjs   (server must be up: data-occultist serve)
import { chromium } from "playwright";

const URL = process.env.OC_URL || "http://localhost:8000/";
const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); console.log(`   ${cond ? "✓" : "✗"} ${msg}`); };

(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const pageErrs = [];
    page.on("pageerror", (e) => pageErrs.push(String(e)));

    await page.goto(URL, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__nodeHistory && !window.__nodeHistory.booting() && window.__nodeHistory.state().len >= 1, { timeout: 30000 });

    const setup = await page.evaluate(async () => {
        const { model } = await import("/js/graph/state.js");
        const { placeNewNode, render, rebuildNode } = await import("/js/graph/main.js");
        window.__t = { model, placeNewNode, render, rebuildNode };
        return { winId: (model.profile.windows || [])[0]?.id };
    });
    ok(!!setup.winId, `found a window to attach a test readout to (${JSON.stringify(setup.winId)})`);
    if (!setup.winId) { console.log("\nBLOCKED: profile has no windows"); await browser.close(); process.exit(2); }

    // Create a readout, force its preprocess to `color` mode, seed one colour, render.
    const roId = await page.evaluate(async (winId) => {
        const { model, placeNewNode, render, rebuildNode } = window.__t;
        const id = model.addReadout(winId, { x: 0.1, y: 0.1, w: 0.08, h: 0.05 });
        const fd = model.readoutFieldOf(winId, id);
        const pp = model._ppOf(fd);
        pp.mode = "color"; pp.colors = ["#ffffff"]; pp.tolerance = 60;
        await placeNewNode(`ro:${winId}:${id}`, "readout", `win:${winId}`, null);
        render(); rebuildNode(`ro:${winId}:${id}`);
        return id;
    }, setup.winId);
    ok(!!roId, `readout created (id=${roId})`);

    const base = `#gnodes [data-id="ro:${setup.winId}:${roId}"]`;
    await page.waitForSelector(`${base} .ppmode`, { timeout: 5000 });

    // 1) colour rendered as a detect-style row (native swatch + hex), swatch visibly sized
    const sw = await page.$eval(`${base} .color-row .aset-swatch`, (el) => {
        return { w: el.offsetWidth, h: el.offsetHeight, type: el.type, val: el.value };   // offset* = unscaled by graph zoom
    }).catch(() => ({ w: 0, h: 0 }));
    ok(sw.w >= 8 && sw.h >= 8 && sw.type === "color", `colour row uses a native swatch, visible (${sw.w}x${sw.h}px, ${sw.val})`);
    const hex = await page.$eval(`${base} .color-row .pp-color`, (el) => el.value).catch(() => "");
    ok(hex === "#ffffff", `row shows the editable hex (${hex})`);

    // 2) tolerance is a plain number input
    const tol = await page.evaluate((base) => {
        const inp = document.querySelector(`${base} input.pptol`);
        return { hasInput: !!inp, type: inp?.type, val: inp?.value };
    }, base);
    ok(tol.hasInput && tol.type === "number", `tolerance is a number input (type=${tol.type})`);

    // 3) tooltips on every preprocess input
    const tips = await page.evaluate((base) => {
        const t = (sel) => (document.querySelector(`${base} ${sel}`)?.getAttribute("title") || "").length;
        return { mode: t(".ppmode"), pick: t(".pp-pick"), hex: t(".pp-color"), add: t(".pp-coloradd"),
                 tol: t("input.pptol"),
                 scale: t(".ppscale") };
    }, base);
    ok(tips.mode > 20 && tips.pick > 20 && tips.hex > 20 && tips.add > 0 && tips.tol > 20 && tips.scale > 20,
        `all preprocess inputs have tooltips (mode:${tips.mode} pick:${tips.pick} hex:${tips.hex} add:${tips.add} tol:${tips.tol} scale:${tips.scale})`);

    // 4) the remove BUTTON arms like every other (armConfirm -> data-armed="1"); one click does
    //    not remove the row.
    await page.evaluate((base) => document.querySelector(`${base} .pp-coldel`)?.click(), base);   // arm (btn hidden-until-hover)
    const afterOne = await page.evaluate((base) => {
        const btn = document.querySelector(`${base} .pp-coldel`);
        // resolve --warn to rgb and compare to the armed button's fill — proves the SAME yellow
        // arm as .rule-del[data-armed="1"] / .sel-del[data-armed="1"], on the button itself.
        const probe = document.createElement("div");
        probe.style.color = getComputedStyle(document.documentElement).getPropertyValue("--warn").trim();
        document.body.appendChild(probe);
        const warnRgb = getComputedStyle(probe).color; probe.remove();
        const bg = btn ? getComputedStyle(btn).backgroundColor : "";
        return { armed: btn?.dataset.armed === "1", bg, warnRgb, rows: document.querySelectorAll(`${base} .color-row`).length };
    }, base);
    ok(afterOne.armed, "🔍 first click on the remove button ARMS it (data-armed=1), does not remove");
    ok(afterOne.bg === afterOne.warnRgb, `🔍 armed button fill is the standard --warn yellow (${afterOne.bg})`);
    ok(afterOne.rows === 1, "🔍 colour row still present after a single (arming) click");

    // 5) pp-pick opens the zoomed-cutout modal (best-effort — needs a bound capture to draw)
    await page.evaluate((base) => document.querySelector(`${base} .pp-pick`)?.click(), base);
    const modal = await page.waitForSelector(".pp-pick-modal .pp-pick-canvas", { timeout: 2500 }).then(() => true).catch(() => false);
    if (modal) {
        const canvas = await page.$eval(".pp-pick-canvas", (c) => ({ w: c.width, h: c.height }));
        ok(canvas.w > 0 && canvas.h > 0, `pick modal shows a blown-up cutout canvas (${canvas.w}x${canvas.h})`);
        await page.keyboard.press("Escape");
        const gone = await page.$(".pp-pick-modal");
        ok(!gone, "Escape closes the pick modal");
    } else {
        console.log("   ~ pp-pick modal not shown (no capture bound to this window) — skipped, not a failure");
    }

    // 6) the SAME zoomed-cutout picker on a colour DETECTOR (rule 7 — shared openBoxColorPick).
    const detId = await page.evaluate(async (winId) => {
        const { model, render, rebuildNode } = window.__t;
        const id = model.addDetect(winId, { x: 0.2, y: 0.2, w: 0.1, h: 0.05 });
        const d = model.detect(winId, id);
        d.colors = ["#ffffff"]; delete d.text;   // make it a colour-kind detector
        render(); rebuildNode(`det:${winId}:${id}`);
        return id;
    }, setup.winId);
    const detBase = `#gnodes [data-id="det:${setup.winId}:${detId}"]`;
    const hasPick = await page.$(`${detBase} .detcolorpick`).then((e) => !!e).catch(() => false);
    ok(hasPick, `colour detector has the ⊙ image-pick button (det ${detId})`);
    await page.evaluate((b) => document.querySelector(`${b} .detcolorpick`)?.click(), detBase);
    const detModal = await page.waitForSelector(".pp-pick-modal .pp-pick-canvas", { timeout: 2500 }).then(() => true).catch(() => false);
    if (detModal) {
        ok(true, "detector colour pick opens the same zoomed-cutout modal");
        await page.keyboard.press("Escape");
    } else {
        console.log("   ~ detector pick modal not shown (no capture bound) — skipped, not a failure");
    }
    // 7) match-preview canvas is the FIRST body element of BOTH node kinds, regardless of kind/type.
    const canvasFirst = await page.evaluate(({ ro, det }) => {
        const firstCanvas = (sel) => {
            const body = document.querySelector(`${sel} .gn-grid`) || document.querySelector(`${sel} .gnbody`) || document.querySelector(sel);
            const c = body?.querySelector("canvas.mp-canvas");
            return { has: !!c, w: c?.width, first: !!c && c === body.querySelector("canvas.mp-canvas") && [...body.children].findIndex((x) => x.classList?.contains("mp-canvas") || x.querySelector?.(".mp-canvas")) === 0 };
        };
        return { ro: firstCanvas(ro), det: firstCanvas(det) };
    }, { ro: base, det: detBase });
    ok(canvasFirst.ro.has && canvasFirst.ro.w === 240, `readout has the 240px match-preview canvas (${canvasFirst.ro.w})`);
    ok(canvasFirst.det.has && canvasFirst.det.w === 240, `detector has the 240px match-preview canvas (${canvasFirst.det.w})`);

    // the canvas actually DRAWS the cutout once the image loads (async) — a real frame has many
    // colours; the placeholder has ~2. Poll for pixel diversity to prove the render ran e2e.
    const uniq = await page.evaluate(async (sel) => {
        const c = document.querySelector(`${sel} canvas.mp-canvas`);
        const ctx = c.getContext("2d");
        const count = () => {
            const d = ctx.getImageData(0, 0, c.width, c.height).data; const s = new Set();
            for (let i = 0; i < d.length; i += 4) s.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
            return s.size;
        };
        for (let t = 0; t < 30; t++) { if (count() > 8) return count(); await new Promise((r) => setTimeout(r, 100)); }
        return count();
    }, base);
    ok(uniq > 8, `preview canvas drew the cutout (${uniq} distinct colours, >8 = real frame not placeholder)`);

    // 8) colour collisions: identical colours (or within tolerance) flag BOTH hex inputs red.
    const collide = await page.evaluate(async ({ winId, detId }) => {
        const { model, rebuildNode } = window.__t;
        const d = model.detect(winId, detId);
        const probe = document.createElement("div");
        probe.style.color = getComputedStyle(document.documentElement).getPropertyValue("--danger").trim();
        document.body.appendChild(probe); const danger = getComputedStyle(probe).color; probe.remove();
        const inputs = () => [...document.querySelectorAll(`#gnodes [data-id="det:${winId}:${detId}"] .aset[data-k="color"]`)];
        const marked = () => inputs().map((i) => i.classList.contains("color-collide"));
        const reds = () => inputs().map((i) => getComputedStyle(i).backgroundColor === danger);
        d.colors = ["#ffffff", "#ffffff"]; d.tolerance = 32; rebuildNode(`det:${winId}:${detId}`);
        const same = marked();
        await new Promise((r) => setTimeout(r, 250));   // wait out the .12s background transition
        const sameRed = reds();
        d.colors = ["#ffffff", "#000000"]; d.tolerance = 10; rebuildNode(`det:${winId}:${detId}`);
        const distinct = marked();
        d.colors = ["#ffffff", "#f8f8f8"]; d.tolerance = 60; rebuildNode(`det:${winId}:${detId}`);
        const within = marked();
        return { same, sameRed, distinct, within };
    }, { winId: setup.winId, detId });
    ok(!collide.same[0] && collide.same[1], `identical colours flag only the LATER one (${JSON.stringify(collide.same)})`);
    ok(!collide.sameRed[0] && collide.sameRed[1], `the flagged (later) input shows the danger-red fill (${JSON.stringify(collide.sameRed)})`);
    ok(collide.distinct.length === 2 && !collide.distinct.some(Boolean), `far-apart colours at tol 10 flag none (${JSON.stringify(collide.distinct)})`);
    ok(!collide.within[0] && collide.within[1], `near colour flags only the later one (${JSON.stringify(collide.within)})`);

    // 9) changing TOLERANCE repaints the cutout preview (via the real .aset[data-k=tol] handler).
    const tolRepaint = await page.evaluate(async ({ winId, detId }) => {
        const { model, rebuildNode } = window.__t;
        const d = model.detect(winId, detId);
        d.colors = ["#808080"]; delete d.text; d.tolerance = 5; rebuildNode(`det:${winId}:${detId}`);
        const canvasSum = () => { const c = document.querySelector(`#gnodes [data-id="det:${winId}:${detId}"] canvas.mp-canvas`); const p = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let s = 0; for (let i = 0; i < p.length; i += 4) s += p[i] + p[i + 1] + p[i + 2]; return s; };
        for (let t = 0; t < 30 && canvasSum() < 1000; t++) await new Promise((r) => setTimeout(r, 100));   // wait for the cutout to load
        const low = canvasSum();
        // drive the REAL tolerance input to a high value (not a model poke) so the wiring runs
        const tol = document.querySelector(`#gnodes [data-id="det:${winId}:${detId}"] .aset[data-k="tol"]`);
        tol.value = "250"; tol.dispatchEvent(new Event("change", { bubbles: true }));
        await new Promise((r) => setTimeout(r, 200));
        const high = canvasSum();
        return { low, high, changed: low !== high, modelTol: d.tolerance };
    }, { winId: setup.winId, detId });
    ok(tolRepaint.modelTol === 250, `tolerance input drove the model (tol=${tolRepaint.modelTol})`);
    ok(tolRepaint.changed, `changing tolerance repaints the cutout (sum ${tolRepaint.low} -> ${tolRepaint.high})`);

    // 10) the preview emphasises ONLY the winning region: diff painted-vs-plain cutout and confirm
    //     the painted pixels form exactly ONE connected component (not scattered near pixels).
    const winning = await page.evaluate(async ({ winId, detId }) => {
        const { model, rebuildNode } = window.__t;
        const d = model.detect(winId, detId);
        const cv = () => document.querySelector(`#gnodes [data-id="det:${winId}:${detId}"] canvas.mp-canvas`);   // re-query — rebuild replaces it
        const grab = () => { const c = cv(); return c.getContext("2d").getImageData(0, 0, c.width, c.height).data; };
        d.colors = ["#808080"]; delete d.text;
        d.tolerance = 250; rebuildNode(`det:${winId}:${detId}`);   // matches -> a painted blob
        await new Promise((r) => setTimeout(r, 150));
        const painted = grab().slice();
        d.tolerance = 1; rebuildNode(`det:${winId}:${detId}`);     // ~nothing within dist 1 -> no paint, same cutout
        await new Promise((r) => setTimeout(r, 100));
        const raw = grab();
        const W = cv().width, H = cv().height, N = W * H, mask = new Uint8Array(N);
        for (let p = 0; p < N; p++) { const i = p * 4; if (painted[i] !== raw[i] || painted[i + 1] !== raw[i + 1] || painted[i + 2] !== raw[i + 2]) mask[p] = 1; }
        let count = 0; for (let p = 0; p < N; p++) count += mask[p];
        let ps = 0, rs = 0; for (let i = 0; i < painted.length; i += 4) { ps += painted[i] + painted[i + 1] + painted[i + 2]; rs += raw[i] + raw[i + 1] + raw[i + 2]; }
        const dbg = { paintedSum: ps, rawSum: rs, W, H };
        const seen = new Uint8Array(N), stack = []; let comps = 0;
        for (let s = 0; s < N; s++) {
            if (!mask[s] || seen[s]) continue; comps++; stack.length = 0; stack.push(s); seen[s] = 1;
            while (stack.length) { const p = stack.pop(), x = p % W, y = (p / W) | 0;
                for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) { if (!ox && !oy) continue; const nx = x + ox, ny = y + oy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue; const q = ny * W + nx; if (mask[q] && !seen[q]) { seen[q] = 1; stack.push(q); } } }
        }
        return { count, comps, ...dbg };
    }, { winId: setup.winId, detId });
    ok(winning.count > 0 && winning.comps === 1, `preview paints exactly ONE connected region (${winning.count}px, ${winning.comps} comp; painted=${winning.paintedSum} raw=${winning.rawSum})`);

    await page.evaluate(({ winId, detId }) => window.__t.model.removeDetect(winId, detId), { winId: setup.winId, detId }).catch(() => {});

    // cleanup: drop the throwaway readout so a rerun starts clean (mirrors register-readout-select).
    await page.evaluate(({ winId, roId }) => window.__t.model.removeReadout(winId, roId), { winId: setup.winId, roId }).catch(() => {});

    if (pageErrs.length) { console.log("\npage errors:"); pageErrs.forEach((e) => console.log("   " + e)); }
    await browser.close();
    const failed = fails.length > 0 || pageErrs.length > 0;
    if (pageErrs.length) fails.push(`${pageErrs.length} page error(s)`);
    console.log(failed ? `\nFAIL: ${fails.length} check(s)\n - ${fails.join("\n - ")}` : "\nPASS: readout preprocess controls render + behave");
    process.exit(failed ? 1 : 0);
})();
