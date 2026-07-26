// e2e: WASD-nudging a readout/detector box straight from its match-preview cutout —
//   - clicking the cutout ARMS it (visible marker) and hands it the keyboard
//   - W/A/S/D move the box exactly one image-native pixel, shift+WASD resizes
//   - the cutout repaints as the box moves
//   - Escape reverts the whole burst (it rides the node transaction), a click elsewhere disarms
//     and hands WASD back to node-move
//
// Run:  node tests/e2e/mp-nudge.mjs   (server must be up: data-occultist serve)
import { chromium } from "playwright";

const URL = process.env.OC_URL || "http://localhost:8000/?sandbox=1";
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
        const { model, busy, pos } = await import("/js/graph/state.js");
        const { placeNewNode, render, rebuildNode, focusNode } = await import("/js/graph/main.js");
        window.__t = { model, busy, pos, placeNewNode, render, rebuildNode, focusNode };
        return { winId: (model.profile.windows || [])[0]?.id };
    });
    ok(!!setup.winId, `found a window to attach a test readout to (${JSON.stringify(setup.winId)})`);
    if (!setup.winId) { console.log("\nBLOCKED: profile has no windows"); await browser.close(); process.exit(2); }

    const roId = await page.evaluate(async (winId) => {
        const { model, placeNewNode, render, rebuildNode } = window.__t;
        const id = model.addReadout(winId, { x: 0.2, y: 0.2, w: 0.1, h: 0.06 });
        await placeNewNode(`ro:${winId}:${id}`, "readout", `win:${winId}`, null);
        render(); rebuildNode(`ro:${winId}:${id}`);
        return id;
    }, setup.winId);
    const nodeId = `ro:${setup.winId}:${roId}`;
    const base = `#gnodes [data-id="${nodeId}"]`;
    await page.waitForSelector(`${base} canvas.mp-canvas`, { timeout: 5000 });

    // wait for the cutout to actually draw (a real frame has many colours) — the nudge repaint check
    // below is meaningless against a placeholder.
    const drew = await page.evaluate(async (sel) => {
        const c = document.querySelector(`${sel} canvas.mp-canvas`), ctx = c.getContext("2d");
        const uniq = () => { const d = ctx.getImageData(0, 0, c.width, c.height).data; const s = new Set();
            for (let i = 0; i < d.length; i += 4) s.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]); return s.size; };
        for (let t = 0; t < 40; t++) { if (uniq() > 8) return true; await new Promise((r) => setTimeout(r, 100)); }
        return false;
    }, base);
    if (!drew) { console.log("\nBLOCKED: no capture bound to this window — the cutout never drew"); await browser.close(); process.exit(2); }

    // the fresh readout kicks off its first OCR read; a busy node refuses the nudge (same guard the
    // overlay's WASD applies), so let it settle first.
    const settled = await page.waitForFunction((id) => !window.__t.busy.get(id), nodeId, { timeout: 40000 })
        .then(() => true).catch(() => false);
    ok(settled, "the new readout's first read settled (a busy node refuses the nudge)");

    // 1) click the cutout -> armed (dispatched in-page: the node may sit outside the viewport)
    await page.evaluate((sel) => document.querySelector(`${sel} canvas.mp-canvas`).click(), base);
    const armed = await page.evaluate((sel) => ({
        marked: document.querySelector(`${sel} canvas.mp-canvas`).classList.contains("mp-nudge"),
        status: document.querySelector("#logbar .log-latest")?.textContent || "",
    }), base);
    ok(armed.marked, "clicking the cutout arms it (.mp-nudge)");
    ok(/WASD/.test(armed.status), `the arm announces itself ("${armed.status}")`);

    // 2) WASD moves the box exactly one image-native pixel, and the cutout repaints
    const moved = await page.evaluate(({ winId, roId, sel }) => {
        const { model } = window.__t;
        const ro = () => (model.window(winId).readouts || []).find((r) => r.id === roId);
        const c = document.querySelector(`${sel} canvas.mp-canvas`), ctx = c.getContext("2d");
        const sum = () => { const d = ctx.getImageData(0, 0, c.width, c.height).data; let s = 0;
            for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2]; return s; };
        window.__mp = { before: { ...ro().box }, sum0: sum(), ro, sum };
        return { box: { ...ro().box } };
    }, { winId: setup.winId, roId, sel: base });

    await page.keyboard.press("d");
    await page.keyboard.press("s");
    const afterMove = await page.evaluate(async () => {
        await new Promise((r) => requestAnimationFrame(r));
        const { before, sum0, ro, sum } = window.__mp;
        const img = document.querySelector("#gnodes canvas.mp-canvas");   // step size comes from the IMAGE
        const { model } = window.__t;
        return { before, after: { ...ro().box }, sum0, sum1: sum(), hasImg: !!img };
    });
    const px = await page.evaluate(async (winId) => {
        const { imageCanvases } = await import("/js/graph/state.js");
        const live = imageCanvases.get(winId)?.overlay?.img;
        return { w: live?.naturalWidth || null };
    }, setup.winId);
    const dx = afterMove.after.x - afterMove.before.x, dy = afterMove.after.y - afterMove.before.y;
    ok(dx > 0 && dy > 0, `D and S moved the box right + down (dx=${dx.toFixed(6)} dy=${dy.toFixed(6)})`);
    ok(dx < 0.002 && dy < 0.002, `one press = one image pixel, not a grid step (dx=${dx.toFixed(6)}${px.w ? ` vs 1/${px.w}=${(1 / px.w).toFixed(6)}` : ""})`);
    ok(afterMove.sum1 !== afterMove.sum0, `the cutout repainted as the box moved (${afterMove.sum0} -> ${afterMove.sum1})`);

    // 3) shift+WASD resizes
    const beforeW = await page.evaluate(() => ({ ...window.__mp.ro().box }));
    await page.keyboard.press("Shift+d");
    const afterW = await page.evaluate(() => ({ ...window.__mp.ro().box }));
    ok(afterW.w > beforeW.w && afterW.x === beforeW.x, `shift+D grows the width, leaves x put (w ${beforeW.w.toFixed(5)} -> ${afterW.w.toFixed(5)})`);

    // 4) Escape reverts the whole burst (the nudge rides the node transaction)
    await page.keyboard.press("Escape");
    const reverted = await page.evaluate(() => ({ box: { ...window.__mp.ro().box }, before: window.__mp.before }));
    const same = ["x", "y", "w", "h"].every((k) => Math.abs(reverted.box[k] - reverted.before[k]) < 1e-9);
    ok(same, `Escape puts the box back where it started (${JSON.stringify(reverted.box)} vs ${JSON.stringify(reverted.before)})`);

    // 5) a press outside the node disarms — WASD goes back to moving the NODE
    await page.evaluate((sel) => document.querySelector(`${sel} canvas.mp-canvas`).click(), base);   // re-arm
    // a pointerdown landing outside the node — what onOutside actually listens for
    await page.evaluate(() => document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
    const disarmed = await page.evaluate(({ sel, nodeId }) => {
        window.__t.focusNode(nodeId);
        return { marked: document.querySelector(`${sel} canvas.mp-canvas`)?.classList.contains("mp-nudge"),
            box: { ...window.__mp.ro().box }, at: { ...window.__t.pos.get(nodeId) } };
    }, { sel: base, nodeId });
    ok(!disarmed.marked, "a press outside the node disarms the cutout");
    await page.keyboard.press("d");
    const afterDisarm = await page.evaluate(({ nodeId }) =>
        ({ box: { ...window.__mp.ro().box }, at: { ...window.__t.pos.get(nodeId) } }), { nodeId });
    ok(JSON.stringify(afterDisarm.box) === JSON.stringify(disarmed.box), "disarmed: WASD no longer moves the box");
    ok(afterDisarm.at.x !== disarmed.at.x, `disarmed: WASD moves the NODE again (x ${disarmed.at.x} -> ${afterDisarm.at.x})`);

    // cleanup
    await page.evaluate(({ winId, roId }) => { window.__t.model.removeReadout(winId, roId); window.__t.render(); },
        { winId: setup.winId, roId }).catch(() => {});

    if (pageErrs.length) { console.log("\npage errors:"); pageErrs.forEach((e) => console.log("   " + e)); }
    await browser.close();
    if (pageErrs.length) fails.push(`${pageErrs.length} page error(s)`);
    console.log(fails.length ? `\nFAIL: ${fails.length} check(s)\n - ${fails.join("\n - ")}` : "\nPASS: match-preview WASD nudge");
    process.exit(fails.length ? 1 : 0);
})();
