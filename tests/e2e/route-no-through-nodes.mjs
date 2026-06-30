// e2e: the node-graph router must never paint an edge THROUGH a node it doesn't connect.
// Loads the live web UI (warframe profile — the graph that exhibited the through-node routing),
// lets the A* router settle, then reads the routed geometry (window.__routes) + every node rect
// (window.__nodeRects) and asserts no edge segment cuts the INTERIOR of a non-endpoint node.
// Also reports the source-face spread of data lines — the "leave from any of the 4 faces" fix
// means they must NOT all pin to one side (the old R/L-only behaviour).
//
// Run:  npm run test:e2e        (server must be up:  data-occultist serve)
import { chromium } from "playwright";

const URL = process.env.OC_URL || "http://localhost:8000/";
const INSET = 6;   // shrink each rect by this before testing: a line hugging an edge (legal) is fine;
                   // only a segment crossing the rect INTERIOR counts as "through the node".
const DATA_SRC = ["win:", "producer:", "ds:", "sub:", "src:"];

// segment a->b vs axis-aligned rect (inset) — identical straddle test the router uses internally.
const ccw = (a, b, c) => (c[1] - a[1]) * (b[0] - a[0]) - (b[1] - a[1]) * (c[0] - a[0]);
const segSeg = (p1, p2, p3, p4) => {
    const d1 = ccw(p3, p4, p1), d2 = ccw(p3, p4, p2), d3 = ccw(p1, p2, p3), d4 = ccw(p1, p2, p4);
    return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
};
function segHitsRect(a, b, r) {
    const x1 = r.x + INSET, y1 = r.y + INSET, x2 = r.x + r.w - INSET, y2 = r.y + r.h - INSET;
    if (x2 <= x1 || y2 <= y1) return false;
    const inside = (p) => p[0] >= x1 && p[0] <= x2 && p[1] >= y1 && p[1] <= y2;
    if (inside(a) || inside(b)) return true;
    const tl = [x1, y1], tr = [x2, y1], br = [x2, y2], bl = [x1, y2];
    return segSeg(a, b, tl, tr) || segSeg(a, b, tr, br) || segSeg(a, b, br, bl) || segSeg(a, b, bl, tl);
}

(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const pageErrs = [];
    page.on("pageerror", (e) => pageErrs.push(String(e)));

    await page.goto(URL, { waitUntil: "domcontentloaded" });
    // wait for the router to populate the cache (one full layout pass), then settle
    await page.waitForFunction(() => window.__routes && Object.keys(window.__routes()).length > 0, { timeout: 15000 });
    await page.waitForTimeout(800);

    const { routes, rects } = await page.evaluate(() => ({ routes: window.__routes(), rects: window.__nodeRects() }));

    const edgeKeys = Object.keys(routes);
    const violations = [];
    for (const key of edgeKeys) {
        const sp = key.indexOf(" ");
        const fromId = key.slice(0, sp), toId = key.slice(sp + 1);
        const pts = routes[key].pts;
        if (!pts || pts.length < 2) continue;
        for (const [nid, r] of Object.entries(rects)) {
            if (nid === fromId || nid === toId) continue;   // its own endpoints legitimately touch
            for (let i = 0; i + 1 < pts.length; i++) {
                if (segHitsRect(pts[i], pts[i + 1], r)) { violations.push({ edge: key, through: nid }); break; }
            }
        }
    }

    // face spread of data out-lines — the fix lets them leave any of the 4 faces
    const faces = { L: 0, R: 0, T: 0, B: 0 };
    let dataEdges = 0;
    for (const key of edgeKeys) {
        const fromId = key.slice(0, key.indexOf(" "));
        if (!DATA_SRC.some((p) => fromId.startsWith(p))) continue;
        dataEdges++;
        faces[routes[key].d1] = (faces[routes[key].d1] || 0) + 1;
    }

    console.log(`edges routed:        ${edgeKeys.length}`);
    console.log(`nodes:               ${Object.keys(rects).length}`);
    console.log(`data out-lines:      ${dataEdges}  faces L:${faces.L} R:${faces.R} T:${faces.T} B:${faces.B}`);
    console.log(`through-node hits:   ${violations.length}`);
    for (const v of violations.slice(0, 20)) console.log(`   ✗ "${v.edge}"  cuts  "${v.through}"`);
    if (pageErrs.length) { console.log("page errors:"); pageErrs.forEach((e) => console.log("   " + e)); }

    await browser.close();

    let failed = false;
    if (pageErrs.length) { console.error("\nFAIL: page errors above"); failed = true; }
    if (violations.length) { console.error(`\nFAIL: ${violations.length} edge(s) pass through a non-endpoint node`); failed = true; }
    if (!failed) console.log("\nPASS: no edge crosses a node it doesn't connect");
    process.exit(failed ? 1 : 0);
})();
