// e2e: a register node's sources add-select must pick up a readout created AFTER the register
// node is already open on screen — without a page reload. The unified consumer sweep
// (rebuildRefConsumers, gated on render()'s _refKey) rebuilds the register body's free list.
//
// Run:  node tests/e2e/register-readout-select.mjs   (server must be up: data-occultist serve)
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

    // Pull the SAME live singletons the running app uses (module cache hit on identical specifier).
    const setup = await page.evaluate(async () => {
        const { model } = await import("/js/graph/state.js");
        const { placeNewNode, render, rebuildNode } = await import("/js/graph/main.js");
        window.__t = { model, placeNewNode, render, rebuildNode };
        const winId = (model.profile.windows || [])[0]?.id;
        return { winId, hadModules: !!(model && placeNewNode && render && rebuildNode) };
    });
    ok(setup.hadModules, "grabbed live model/placeNewNode/render/rebuildNode via dynamic import");
    ok(!!setup.winId, `found an existing window to attach a test readout to (got ${JSON.stringify(setup.winId)})`);
    if (!setup.winId) { console.log("\nBLOCKED: profile has no windows to test against"); await browser.close(); process.exit(2); }

    // 1) Create a register node and place it (mirrors toolbox.js createRegisterNode).
    const regId = await page.evaluate(async () => {
        const { model, placeNewNode, render } = window.__t;
        const id = model.addRegister();
        await placeNewNode(`register:${id}`, "register", null, null);
        render();
        return id;
    });
    ok(!!regId, `register node created (id=${regId})`);

    // Sanity: the add-select should exist and NOT yet contain a readout we haven't made yet.
    const selSel = `#gnodes [data-id="register:${regId}"] select.reg-addsrc`;
    await page.waitForSelector(selSel, { timeout: 5000 });
    const optsBefore = await page.$$eval(`${selSel} option`, (os) => os.map((o) => o.value));
    console.log(`   register's add-select options before: ${JSON.stringify(optsBefore)}`);

    // 2) Create a NEW readout on an existing window, exactly like imaging.js's draw-readout path:
    //    model.addReadout(winId, box) then rebuildReadoutConsumers()-equivalent refresh.
    const readoutId = await page.evaluate((winId) => {
        const { model, render, rebuildNode } = window.__t;
        const id = model.addReadout(winId, { x: 0.1, y: 0.1, w: 0.05, h: 0.05 });
        // the unified consumer sweep runs off render()'s _refKey gate (adding a readout flips it),
        // rebuilding every consumer body — including the register's sources-input free list.
        render();
        rebuildNode(`win:${winId}`);
        return id;
    }, setup.winId);
    ok(!!readoutId, `new readout created on window "${setup.winId}" (id=${readoutId})`);

    // 3) Without any reload, the ALREADY-OPEN register's select must now list the new readout.
    const optsAfter = await page.$$eval(`${selSel} option`, (os) => os.map((o) => o.value));
    console.log(`   register's add-select options after:  ${JSON.stringify(optsAfter)}`);
    ok(optsAfter.includes(`readout:${readoutId}`), `new readout "${readoutId}" appears in the OPEN register's + readout select without reload`);

    // 4) Probe: wiring it as a source removes it from the free-options list (existing behavior),
    //    and removing the readout drops it back out of the select live too.
    await page.evaluate(async (a) => {
        const { model, rebuildNode } = window.__t;
        model.addRegisterSource(a.regId, `readout:${a.readoutId}`);
        rebuildNode(`register:${a.regId}`);
    }, { regId, readoutId });
    const optsWired = await page.$$eval(`${selSel} option`, (os) => os.map((o) => o.value));
    ok(!optsWired.includes(`readout:${readoutId}`), "wiring the readout as a source removes it from the free-options list");
    const chipSel = `#gnodes [data-id="register:${regId}"] .sv-input`;
    const chipCount = await page.$$eval(chipSel, (c) => c.length).catch(() => 0);
    ok(chipCount >= 1, `wired source shows as a chip on the register node (found ${chipCount})`);

    await page.evaluate((a) => {
        const { model, render, rebuildNode } = window.__t;
        model.removeRegisterSource(a.regId, `readout:${a.readoutId}`);
        model.removeReadout(a.winId, a.readoutId);
        render();
        rebuildNode(`win:${a.winId}`);
    }, { regId, readoutId, winId: setup.winId });
    const optsFinal = await page.$$eval(`${selSel} option`, (os) => os.map((o) => o.value));
    ok(!optsFinal.includes(`readout:${readoutId}`), "🔍 deleting the readout drops it from the register's select live too (not just missing, actually gone)");

    if (pageErrs.length) { console.log("\npage errors:"); pageErrs.forEach((e) => console.log("   " + e)); }
    await browser.close();

    const failed = fails.length > 0 || pageErrs.length > 0;
    if (pageErrs.length) fails.push(`${pageErrs.length} page error(s)`);
    console.log(failed ? `\nFAIL: ${fails.length} check(s)\n - ${fails.join("\n - ")}` : "\nPASS: register add-select tracks readout create/wire/delete live");
    process.exit(failed ? 1 : 0);
})();
