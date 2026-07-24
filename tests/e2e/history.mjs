// e2e: edit history (undo / redo / travel) for BOTH the node graph and the Pretty studio, and
// that the two histories are INDEPENDENT. Drives the real edit funnels via the read-only test
// handles window.__nodeHistory / window.__prettyHistory (same convention as window.__routes).
//
// Covers: baseline seeded on load; each edit records one entry; undo/redo walk; clicking a history
// row travels there; travel is NON-DESTRUCTIVE (older entries keep their redoable future); a fresh
// edit made in the past truncates the future; node edits never touch pretty's stack and vice versa.
//
// Run:  node tests/e2e/history.mjs        (server must be up:  data-occultist serve)
import { chromium } from "playwright";

const URL = process.env.OC_URL || "http://localhost:8000/?sandbox=1";
const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); console.log(`   ${cond ? "✓" : "✗"} ${msg}`); };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const pageErrs = [];
    page.on("pageerror", (e) => pageErrs.push(String(e)));

    await page.goto(URL, { waitUntil: "domcontentloaded" });
    // wait for boot to FULLY settle (boot.phase clears after bootSettle) — history recording is
    // suppressed during boot, so an edit fired mid-boot wouldn't register.
    await page.waitForFunction(() => window.__nodeHistory && !window.__nodeHistory.booting() && window.__nodeHistory.state().len >= 1, { timeout: 30000 });

    // ---- NODE view --------------------------------------------------------------------
    console.log("NODE history:");
    const nh = (fn, ...a) => page.evaluate(({ fn, a }) => window.__nodeHistory[fn](...a), { fn, a });
    const nstate = () => page.evaluate(() => window.__nodeHistory.state());
    const ndatasets = () => page.evaluate(() => window.__nodeHistory.datasets());

    let s = await nstate();
    eq(s.index, s.len - 1, "baseline: parked on the last entry");
    ok(s.len === 1, "baseline: exactly one entry after load");
    const nodeBaseDs = await ndatasets();

    const ds1 = await nh("edit", "e2e_ds_1");
    const ds2 = await nh("edit", "e2e_ds_2");
    s = await nstate();
    eq(s.len, 3, "two edits -> 3 entries (baseline + 2)");
    eq(s.index, 2, "parked on the newest edit");
    ok((await ndatasets()).includes(ds1) && (await ndatasets()).includes(ds2), "both datasets present after edits");
    ok(/e2e_ds_2/.test(s.labels[2]), `newest label names the added dataset  (got "${s.labels[2]}")`);

    await nh("undo");
    ok((await ndatasets()).includes(ds1) && !(await ndatasets()).includes(ds2), "undo drops the 2nd dataset, keeps the 1st");
    await nh("undo");
    let d = await ndatasets();
    ok(!d.includes(ds1) && !d.includes(ds2), "second undo drops both -> back to baseline datasets");
    eq((await nstate()).index, 0, "two undos park on the baseline");
    await nh("redo");
    ok((await ndatasets()).includes(ds1) && !(await ndatasets()).includes(ds2), "redo re-adds the 1st dataset only");

    // non-destructive travel: jump to newest, then back to baseline; the stack length never changes
    await nh("jump", 2);
    ok((await ndatasets()).includes(ds2), "jump to newest restores both");
    await nh("jump", 0);
    eq((await nstate()).len, 3, "travel is non-destructive: stack length unchanged");
    d = await ndatasets();
    ok(!d.includes(ds1) && !d.includes(ds2), "jump to baseline shows neither dataset");

    // a fresh edit made while parked in the past truncates the redoable future
    const ds3 = await nh("edit", "e2e_ds_3");
    s = await nstate();
    eq(s.len, 2, "editing in the past truncates the future (baseline + new edit)");
    d = await ndatasets();
    ok(d.includes(ds3) && !d.includes(ds1) && !d.includes(ds2), "after branch: only the new dataset exists");

    // ---- NODE layout is IN history (positions travel with undo) -----------------------
    console.log("NODE layout (node positions):");
    const gp0 = await page.evaluate(() => window.__nodeHistory.nodePos("game"));
    ok(gp0 && Number.isFinite(gp0.x), "the game node has a position");
    const lenBeforeMove = (await nstate()).len;
    await page.evaluate((p) => window.__nodeHistory.moveNode("game", p.x + 137, p.y + 91), gp0);
    eq((await nstate()).len, lenBeforeMove + 1, "moving a node records ONE history entry");
    let gp1 = await page.evaluate(() => window.__nodeHistory.nodePos("game"));
    eq(gp1, { x: gp0.x + 137, y: gp0.y + 91 }, "node moved to the new spot");
    await nh("undo");
    eq(await page.evaluate(() => window.__nodeHistory.nodePos("game")), gp0, "undo restores the node's original position");
    await nh("redo");
    eq(await page.evaluate(() => window.__nodeHistory.nodePos("game")), { x: gp0.x + 137, y: gp0.y + 91 }, "redo re-applies the move");
    await nh("undo");   // leave it back at the origin

    // node SIZE (w AND h) must restore on undo/redo — render re-applies position, not size, so this
    // needs the explicit reapplyNodeSizes() in restore. Use a freely-resizable node (a dataset node).
    const rid = "ds:" + (await ndatasets())[0];
    const sz0 = await page.evaluate((a) => window.__nodeHistory.nodeSize(a.id), { id: rid });
    if (sz0) {
        await page.evaluate((a) => window.__nodeHistory.resizeNode(a.id, 420, 360), { id: rid });
        eq(await page.evaluate((a) => window.__nodeHistory.nodeSize(a.id), { id: rid }), { w: 420, h: 360 }, "resize applied (w+h)");
        await nh("undo");
        eq(await page.evaluate((a) => window.__nodeHistory.nodeSize(a.id), { id: rid }), sz0, "undo restores BOTH width and height");
        await nh("redo");
        eq(await page.evaluate((a) => window.__nodeHistory.nodeSize(a.id), { id: rid }), { w: 420, h: 360 }, "redo re-applies the resize");
        await nh("undo");
    }

    // ---- NODE vttable column widths travel with history (live re-apply) ----------------
    console.log("NODE vttable column widths:");
    const tbl = await page.evaluate(() => window.__nodeHistory.firstTable());
    if (!tbl) {
        console.log("   – no live vttable on screen; skipping the live-reapply check (mechanism still wired)");
    } else {
        const startW = tbl.width;
        const newW = (startW || 120) + 44;
        const idxB = (await nstate()).index;
        await page.evaluate((a) => window.__nodeHistory.setTableWidth(a.id, a.col, a.px), { id: tbl.id, col: tbl.col, px: newW });
        eq(await page.evaluate((a) => window.__nodeHistory.tableWidth(a.id, a.col), tbl), newW, "width applied live to the open table");
        eq((await nstate()).index, idxB + 1, "a column-width change advances the history one step");
        await nh("undo");
        eq(await page.evaluate((a) => window.__nodeHistory.tableWidth(a.id, a.col), tbl), startW, "undo restores the vttable column width ON THE LIVE TABLE (no rebuild)");
        await nh("redo");
        eq(await page.evaluate((a) => window.__nodeHistory.tableWidth(a.id, a.col), tbl), newW, "redo re-applies the width live");
        await nh("undo");

        // SORT must restore too — and the ROWS must actually reorder, not just the arrow. Sort ASC
        // then DESC (guaranteed different first row for >1 distinct values), then undo back to ASC.
        const cols = await page.evaluate((a) => window.__nodeHistory.tableCols(a.id), tbl);
        const sortCol = cols.find((c) => c !== "_seq") || cols[0];
        // settle any in-flight server-mode window fetch (a no-op for array-mode tables), then read
        // the first row — so the reorder is observed after the fetch, not before.
        const idle = () => page.evaluate((a) => window.__nodeHistory.tableIdle(a.id), tbl);
        const first = async () => { await idle(); return page.evaluate((a) => window.__nodeHistory.tableFirstRow(a.id, a.col), { id: tbl.id, col: sortCol }); };
        await page.evaluate((a) => window.__nodeHistory.setTableSort(a.id, a.col, 1), { id: tbl.id, col: sortCol });
        const firstAsc = await first();
        await page.evaluate((a) => window.__nodeHistory.setTableSort(a.id, a.col, -1), { id: tbl.id, col: sortCol });
        const firstDesc = await first();
        ok(firstAsc !== firstDesc, "asc vs desc actually REORDERED the rows (not just the arrow)");
        await nh("undo");   // back to the ASC entry
        await idle();       // server-mode undo refetches under the restored sort
        eq(await page.evaluate((a) => window.__nodeHistory.tableSort(a.id).dir, tbl), 1, "undo restores the previous sort direction");
        eq(await first(), firstAsc, "undo actually RE-SORTED the rows back to the ascending order");
        await nh("redo");
        await idle();
        eq(await first(), firstDesc, "redo re-sorts the rows to descending");
        await nh("undo");
        await idle();
    }

    // ---- NODE history PANEL (DOM + click-to-travel) -----------------------------------
    console.log("NODE history panel:");
    await page.click("#historyBtn");
    await page.waitForSelector("#history:not([hidden]) .hist-list .hist-row", { timeout: 5000 });
    const rowCount = await page.$$eval("#history .hist-row", (rs) => rs.length);
    eq(rowCount, (await nstate()).len, "panel renders one row per entry");
    const curIdx = await page.$$eval("#history .hist-row", (rs) => rs.findIndex((r) => r.classList.contains("hist-cur")));
    eq(curIdx, (await nstate()).index, "the current entry row is marked hist-cur");
    // click the first row -> travel to baseline
    await page.click("#history .hist-row[data-i='0']");
    eq((await nstate()).index, 0, "clicking a history row travels to it");
    d = await ndatasets();
    ok(!d.includes(ds3), "after clicking baseline row, the edit is undone in the model");

    const nodeLenBeforePretty = (await nstate()).len;

    // ---- PRETTY view ------------------------------------------------------------------
    console.log("PRETTY history:");
    await page.click("#vtPretty");
    await page.waitForFunction(() => window.__prettyHistory && window.__prettyHistory.state().len >= 1, { timeout: 15000 });
    const ph = (fn, ...a) => page.evaluate(({ fn, a }) => window.__prettyHistory[fn](...a), { fn, a });
    const pstate = () => page.evaluate(() => window.__prettyHistory.state());
    const ppages = () => page.evaluate(() => window.__prettyHistory.pages());

    let ps = await pstate();
    eq(ps.index, ps.len - 1, "pretty baseline: parked on last entry");
    const pBasePages = (await ppages()).length;

    await ph("edit", "e2e_pg_1");
    await ph("edit", "e2e_pg_2");
    ps = await pstate();
    eq(ps.len, 3, "two pretty edits -> 3 entries");
    eq((await ppages()).length, pBasePages + 2, "two pages added");
    await ph("undo");
    eq((await ppages()).length, pBasePages + 1, "pretty undo removes a page");
    await ph("undo");
    eq((await ppages()).length, pBasePages, "second pretty undo -> baseline page count");
    await ph("redo");
    eq((await ppages()).length, pBasePages + 1, "pretty redo re-adds a page");
    await ph("jump", 0);
    eq((await ppages()).length, pBasePages, "pretty travel to baseline");
    eq((await pstate()).len, 3, "pretty travel is non-destructive");

    // ---- INDEPENDENCE -----------------------------------------------------------------
    console.log("INDEPENDENCE:");
    eq((await nstate()).len, nodeLenBeforePretty, "pretty edits did NOT change the node history length");
    ok((await pstate()).len === 3 && (await nstate()).len === nodeLenBeforePretty, "the two histories are independent stacks");

    if (pageErrs.length) { console.log("\npage errors:"); pageErrs.forEach((e) => console.log("   " + e)); }
    await browser.close();

    const failed = fails.length > 0 || pageErrs.length > 0;
    if (pageErrs.length) fails.push(`${pageErrs.length} page error(s)`);
    console.log(failed ? `\nFAIL: ${fails.length} check(s)\n - ${fails.join("\n - ")}` : "\nPASS: all history checks green");
    process.exit(failed ? 1 : 0);
})();
