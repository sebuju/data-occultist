// e2e: an on_register trigger (and action) must list a register's PROCESS-fed keys, not just its
// readout keys — the single-truth model.registerKeys(id) SSOT. And deleting a watched register must
// drop it out of every trigger body (watch chip + free select) live, no reload.
//   bug 2: trigger "+ key" dropdown was empty for a process-fed register (readout-only filter).
//   bug 1: watch select stale after register removal (regression-locked here).
//
// Run:  node tests/e2e/register-process-keys.mjs   (server must be up: data-occultist serve)
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
        const { removeNode } = await import("/js/graph/node_remove.js");
        window.__t = { model, placeNewNode, render, rebuildNode, removeNode };
        const winId = (model.profile.windows || [])[0]?.id;
        return { winId, hadModules: !!(model && placeNewNode && render && rebuildNode && removeNode) };
    });
    ok(setup.hadModules, "grabbed live model + placeNewNode/render/rebuildNode/removeNode");
    ok(!!setup.winId, `found an existing window (got ${JSON.stringify(setup.winId)})`);
    if (!setup.winId) { console.log("\nBLOCKED: profile has no windows to test against"); await browser.close(); process.exit(2); }

    // Build readout -> process(out rename "procKey") -> register(fed by the process) -> on_register trigger.
    const ids = await page.evaluate(async (winId) => {
        const { model, placeNewNode, render } = window.__t;
        const readoutId = model.addReadout(winId, { x: 0.1, y: 0.1, w: 0.05, h: 0.05 });
        const pid = model.addProcess();
        model.addProcessSource(pid, `readout:${readoutId}`);
        model.setProcessSourceOut(pid, `readout:${readoutId}`, "procKey");   // renamed output key
        const reg = model.addRegister();
        model.addRegisterSource(reg, `process:${pid}`);                       // register fed by PROCESS, not readout
        const tid = model.addTrigger("on_register");
        model.addTriggerRegisterWatch(tid, reg);
        await placeNewNode(`register:${reg}`, "register", null, null);
        await placeNewNode(`process:${pid}`, "process", null, null);
        await placeNewNode(`trigger:${tid}`, "trigger", null, null);
        render();
        return { readoutId, pid, reg, tid };
    }, setup.winId);
    ok(!!ids.pid && !!ids.reg && !!ids.tid, `built readout=${ids.readoutId} process=${ids.pid} register=${ids.reg} trigger=${ids.tid}`);

    // --- bug 2: the trigger's "+ key" condition dropdown lists the process output key ---
    const condSel = `#gnodes [data-id="trigger:${ids.tid}"] select.tg-addcond`;
    await page.waitForSelector(condSel, { timeout: 5000 });
    const keyOpts = await page.$$eval(`${condSel} option`, (os) => os.map((o) => o.value).filter(Boolean));
    console.log(`   trigger + key options: ${JSON.stringify(keyOpts)}`);
    ok(keyOpts.includes("procKey"), "🔍 process output key 'procKey' appears in the on_register trigger's + key dropdown (bug 2)");

    // the register node itself scaffolds the same key (parity with the SSOT it now shares).
    const regKeys = await page.evaluate((reg) => window.__t.model.registerKeys(reg), ids.reg);
    ok(regKeys.includes("procKey"), `model.registerKeys('${ids.reg}') = ${JSON.stringify(regKeys)} includes the process key`);

    // --- bug 1: the watched register shows as a chip; deleting it drops the chip + any select option ---
    const chipSel = `#gnodes [data-id="trigger:${ids.tid}"] .sv-input[data-node="register:${ids.reg}"]`;
    const hadChip = await page.$$eval(chipSel, (c) => c.length);
    ok(hadChip >= 1, `watched register shows as a watch chip on the trigger (found ${hadChip})`);

    await page.evaluate((reg) => {
        const { model, removeNode } = window.__t;
        const n = model.nodes().find((x) => x.id === `register:${reg}`);
        removeNode(n);   // the real delete path (render() + rebuildRefConsumers sweep)
    }, ids.reg);

    const chipAfter = await page.$$eval(chipSel, (c) => c.length).catch(() => 0);
    ok(chipAfter === 0, "🔍 deleting the register drops its watch chip from the trigger live (bug 1)");
    const watchOpts = await page.$$eval(`#gnodes [data-id="trigger:${ids.tid}"] select.tg-addregwatch option`, (os) => os.map((o) => o.value).filter(Boolean)).catch(() => []);
    ok(!watchOpts.includes(ids.reg), `deleted register is gone from the + watch register select too (opts=${JSON.stringify(watchOpts)})`);

    // cleanup the trigger + process + readout so a re-run starts clean.
    await page.evaluate((a) => {
        const { model, render } = window.__t;
        const t = model.nodes().find((x) => x.id === `trigger:${a.tid}`);
        const p = model.nodes().find((x) => x.id === `process:${a.pid}`);
        if (t) window.__t.removeNode(t);
        if (p) window.__t.removeNode(p);
        model.removeReadout(a.winId, a.readoutId);
        render();
    }, { ...ids, winId: setup.winId });

    if (pageErrs.length) { console.log("\npage errors:"); pageErrs.forEach((e) => console.log("   " + e)); }
    await browser.close();

    const failed = fails.length > 0 || pageErrs.length > 0;
    if (pageErrs.length) fails.push(`${pageErrs.length} page error(s)`);
    console.log(failed ? `\nFAIL: ${fails.length} check(s)\n - ${fails.join("\n - ")}` : "\nPASS: register key lists share one truth (process keys shown; removal live)");
    process.exit(failed ? 1 : 0);
})();
