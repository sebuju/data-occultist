// e2e / debug: does a pure pan run on cached blits instead of re-stroking every wire? The edge
// renderer (edgecanvas.js + edgecache.js) rasters the wires once into an offscreen bitmap and a
// pan frame must be a single drawImage blit. This drives a ~2s right-drag pan and asserts, via
// window.__edgecanvas.stats, that the frames were blits (many) not rasters (a handful at most —
// margin-prefetch re-centres are allowed, per-frame re-rasters are the bug).
//
// Run:  node tests/e2e/edge-blit.mjs        (server must be up:  data-occultist serve)
import { chromium } from "playwright";

const URL = process.env.OC_URL || "http://localhost:8000/?sandbox=1";

(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const pageErrs = [];
    page.on("pageerror", (e) => pageErrs.push(String(e)));

    await page.goto(URL, { waitUntil: "domcontentloaded" });
    // wait for the router to populate the cache (one full layout pass), then let it settle so the
    // quiet-timer raster has fired and the cache is warm before we start measuring
    await page.waitForFunction(() => window.__routes && Object.keys(window.__routes()).length > 0, { timeout: 20000 });
    await page.waitForTimeout(1000);

    await page.evaluate(() => window.__edgecanvas.resetStats());

    // right-drag pan: down, ~2s of small back-and-forth moves (stays within the cache margin so
    // prefetch re-centres stay rare), up
    const cx = 800, cy = 500;
    await page.mouse.move(cx, cy);
    await page.mouse.down({ button: "right" });
    for (let i = 0; i < 120; i++) {
        const t = i / 120;
        await page.mouse.move(cx + Math.sin(t * Math.PI * 4) * 250, cy + Math.cos(t * Math.PI * 4) * 150);
        await page.waitForTimeout(16);
    }
    await page.mouse.up({ button: "right" });
    await page.waitForTimeout(300);

    const stats = await page.evaluate(() => window.__edgecanvas.stats);
    console.log(`blits:      ${stats.blits}`);
    console.log(`rasters:    ${stats.rasters}`);
    console.log(`directs:    ${stats.directs}`);
    console.log(`scaleBlits: ${stats.scaleBlits}`);
    if (pageErrs.length) { console.log("page errors:"); pageErrs.forEach((e) => console.log("   " + e)); }

    await browser.close();

    let failed = false;
    if (pageErrs.length) { console.error("\nFAIL: page errors above"); failed = true; }
    if (stats.blits <= 50) { console.error(`\nFAIL: only ${stats.blits} blit frames during a 2s pan (cache not engaging)`); failed = true; }
    if (stats.rasters > 3) { console.error(`\nFAIL: ${stats.rasters} rasters during the pan (should be a handful of prefetches at most)`); failed = true; }
    if (!failed) console.log("\nPASS: pan ran on cached blits");
    process.exit(failed ? 1 : 0);
})();
