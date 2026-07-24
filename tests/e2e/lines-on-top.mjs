// e2e / debug: does the router paint two DIFFERENT edges on top of each other? A wire is "stacked"
// when one of its H (or V) segments shares a coordinate with another edge's same-axis segment
// (within TOL px) AND their runs overlap along the shared axis (> MIN_OV px) — i.e. they render as
// one line but are really two. This is the "lines running on top of each other" bug (distinct from
// route-no-through-nodes.mjs, which checks edges cutting through a node card — a different defect).
//
// Reads window.__routes() (the routed geometry, keyed `${from} ${to}`) once the router settles.
//
// Run:  node tests/e2e/lines-on-top.mjs        (server must be up:  data-occultist serve)
import { chromium } from "playwright";

const URL = process.env.OC_URL || "http://localhost:8000/?sandbox=1";
const TOL = 2;      // two same-axis segments this close in their fixed coord read as the same lane
const MIN_OV = 12;  // and must overlap at least this far along the run to count as stacked

// break a polyline into its axis-aligned segments: H = horizontal (fixed y), V = vertical (fixed x)
function segsOf(key, pts) {
    const out = [];
    for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i], b = pts[i + 1];
        if (Math.abs(a[1] - b[1]) < 0.6 && Math.abs(a[0] - b[0]) > 1)
            out.push({ key, axis: "H", coord: a[1], lo: Math.min(a[0], b[0]), hi: Math.max(a[0], b[0]) });
        else if (Math.abs(a[0] - b[0]) < 0.6 && Math.abs(a[1] - b[1]) > 1)
            out.push({ key, axis: "V", coord: a[0], lo: Math.min(a[1], b[1]), hi: Math.max(a[1], b[1]) });
    }
    return out;
}

(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const pageErrs = [];
    page.on("pageerror", (e) => pageErrs.push(String(e)));

    await page.goto(URL, { waitUntil: "domcontentloaded" });
    // wait for the router to populate the cache (one full layout pass), then let it settle
    await page.waitForFunction(() => window.__routes && Object.keys(window.__routes()).length > 0, { timeout: 20000 });
    await page.waitForTimeout(1000);

    const routes = await page.evaluate(() => window.__routes());

    // flatten every edge to its segments, then compare every pair of segments from DIFFERENT edges
    const segs = [];
    for (const [key, r] of Object.entries(routes)) {
        if (r.pts && r.pts.length >= 2) segs.push(...segsOf(key, r.pts));
    }
    const stacked = [];
    for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
        const s = segs[i], t = segs[j];
        if (s.key === t.key || s.axis !== t.axis) continue;
        if (Math.abs(s.coord - t.coord) > TOL) continue;
        const ov = Math.min(s.hi, t.hi) - Math.max(s.lo, t.lo);
        if (ov <= MIN_OV) continue;
        stacked.push({ axis: s.axis, coord: Math.round(s.coord), overlapPx: Math.round(ov), a: s.key, b: t.key });
    }
    // one line per pair of edges (an edge pair can share several segments — collapse to the worst)
    const worst = new Map();
    for (const v of stacked) {
        const k = [v.a, v.b].sort().join("  ||  ");
        if (!worst.has(k) || worst.get(k).overlapPx < v.overlapPx) worst.set(k, v);
    }

    console.log(`edges routed:        ${Object.keys(routes).length}`);
    console.log(`segments:            ${segs.length}`);
    console.log(`stacked edge pairs:  ${worst.size}`);
    for (const v of [...worst.values()].sort((a, b) => b.overlapPx - a.overlapPx)) {
        console.log(`   ✗ ${v.axis}@${v.coord}  overlap ${v.overlapPx}px`);
        console.log(`        "${v.a}"`);
        console.log(`        "${v.b}"`);
    }
    if (pageErrs.length) { console.log("page errors:"); pageErrs.forEach((e) => console.log("   " + e)); }

    await browser.close();

    let failed = false;
    if (pageErrs.length) { console.error("\nFAIL: page errors above"); failed = true; }
    if (worst.size) { console.error(`\nFAIL: ${worst.size} pair(s) of edges run on top of each other`); failed = true; }
    if (!failed) console.log("\nPASS: no two edges stacked on the same lane");
    process.exit(failed ? 1 : 0);
})();
