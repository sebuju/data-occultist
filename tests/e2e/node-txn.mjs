// e2e: deferred node-config edits (node_txn.js / edit_txn.js).
//
// The bug this guards: a config handler used to autosave() on every change, which schedules the
// window read, whose setNodeBusy sets `inert` on .gn-body — and `inert` FORCE-BLURS the focused
// element. Typing in a node kicked the caret out and greyed the card on every keystroke.
//
// Now an edit paints live but stashes the save; ✓ / Enter / a click outside runs it once, and
// Escape / ✕ puts the snapshot back. Asserted here against the REAL app:
//   - editing does not save, does not lock the node, does not steal focus
//   - the ✓/✕ bar appears while an edit is pending
//   - Escape restores the pre-edit value and never saves
//   - Enter commits exactly one save
//   - a pointerdown outside the card commits
//   - subset filter edits behave the same (they refetch the view, not OCR)
//
// DATA SAFETY: the committing cases write each input's EXISTING value back, so the profile PUT is
// a no-op on disk. Only the reverted cases type a different value.
//
// Run:  node tests/e2e/node-txn.mjs        (server must be up:  data-occultist serve)
import { chromium } from "playwright";

const URL = process.env.OC_URL || "http://localhost:8000/?debug=1&load=1";
const SETTLE = 1200;   // > READ_DEBOUNCE_MS (700) + slack: any deferred read would have fired by now
const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); console.log(`   ${cond ? "✓" : "✗"} ${msg}`); };

(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const pageErrs = [];
    page.on("pageerror", (e) => pageErrs.push(String(e)));

    // every write/read the app can make in response to an edit
    let saves = 0, reads = 0;
    page.on("request", (r) => {
        const u = r.url();
        if (r.method() === "PUT" && /\/api\/profiles\//.test(u)) saves++;
        else if (/\/api\/(preview|detect|item\/read|subset)/.test(u)) reads++;
    });
    const counts = () => ({ saves, reads });
    const zero = () => { saves = 0; reads = 0; };

    await page.goto(URL, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__nodeHistory && !window.__nodeHistory.booting(), { timeout: 40000 });
    // Boot re-OCRs every window with a bound image, which legitimately spins those nodes for tens
    // of seconds. Wait for the graph to go QUIET first — otherwise "is the node busy?" measures the
    // boot, not the edit. (This is what a first pass at this test got wrong.)
    await page.waitForFunction(
        () => ![...document.querySelectorAll(".gnode")].some((e) => e.classList.contains("busy")),
        { timeout: 120000 });
    await page.waitForTimeout(SETTLE);   // let the boot's own reads drain before we count anything

    // Edit an input the way a user does: focus it, change its value, fire `change` WITHOUT blurring
    // (blur would move focus itself and mask the inert force-blur we're testing for).
    const editInput = async (sel, value) => (await waitQuiet(), page.evaluate(({ sel, value }) => {
        const el = document.querySelector(sel);
        el.focus();
        el.value = value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
    }, { sel, value }));

    // A real commit spins the node, and `inert` blocks focus while it does — so any test that types
    // must wait for the previous commit's work to settle first, or it types into a dead card.
    const waitQuiet = () => page.waitForFunction(
        () => ![...document.querySelectorAll(".gnode")].some((e) => e.classList.contains("busy")),
        { timeout: 60000 });

    const probe = (sel) => page.evaluate((sel) => {
        const el = document.querySelector(sel);
        const card = el?.closest(".gnode");
        return {
            value: el?.value,
            focused: document.activeElement === el,
            busy: !!card?.classList.contains("busy"),
            inert: !!card?.querySelector(".gn-body")?.inert,
            bar: !!card?.querySelector(".node-txn"),
        };
    }, sel);

    // ---- detect node: the worst offender (autosave(win) -> doDetect -> withBusy on this node) ----
    console.log("detect node:");
    // Pin to ONE detect node by id, so `reads` below is attributable: an edit only re-runs detect
    // for windows whose image canvas is open (fireWindowRead iterates imageCanvases).
    const detId = await page.evaluate(() => {
        for (const el of document.querySelectorAll(".gnode.detect"))
            if (el.querySelector('.aset[data-k="tol"]')) return el.id;
        return null;
    });
    ok(!!detId, "found a detect node with a numeric knob");
    if (!detId) { await browser.close(); process.exit(1); }
    const DET = `[id="${detId}"] .aset[data-k="tol"]`;
    const detWas = await page.$eval(DET, (el) => el.value);

    const detAlt = String(Number(detWas) + 7);

    zero();
    await editInput(DET, detAlt);
    await page.waitForTimeout(SETTLE);
    let s = await probe(DET);
    ok(s.value === detAlt, "the typed value is actually applied");   // else the revert below proves nothing
    ok(s.bar, "pending edit shows the ✓/✕ bar");
    ok(s.focused, "input keeps focus (no inert force-blur)");
    ok(!s.busy && !s.inert, "node does not lock while editing");
    ok(counts().saves === 0, `no save while pending (saw ${saves})`);
    ok(counts().reads === 0, `no OCR read while pending (saw ${reads})`);

    // ---- dirty is a VALUE comparison, not "a handler ran" ----
    // Type it back to the original and the edit ceases to exist: no bar, and committing does nothing.
    zero();
    await editInput(DET, detWas);
    await page.waitForTimeout(250);
    s = await probe(DET);
    ok(!s.bar, "typing the value back to its original hides the bar again");
    await page.mouse.click(5, 5);   // commit gesture on a no-net-change edit
    await page.waitForTimeout(SETTLE);
    ok(counts().saves === 0, `a no-net-change edit commits nothing (saw ${saves} saves)`);
    ok(counts().reads === 0, `a no-net-change edit re-reads nothing (saw ${reads} reads)`);
    ok((await probe(DET)).value === detWas, "value still the original");

    // Escape reverts to the snapshot and still never saves
    zero();
    await editInput(DET, detAlt);
    ok((await probe(DET)).bar, "re-editing re-opens the transaction");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(SETTLE);
    s = await probe(DET);
    ok(s.value === detWas, `Escape restores the pre-edit value (got ${s.value}, want ${detWas})`);
    ok(!s.bar, "Escape removes the bar");
    ok(counts().saves === 0, `Escape never saves (saw ${saves})`);

    // Enter commits exactly one save (a REAL change this time)
    zero();
    await editInput(DET, detAlt);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(SETTLE);
    s = await probe(DET);
    ok(!s.bar, "Enter removes the bar");
    ok(s.value === detAlt, "Enter kept the new value");
    ok(counts().saves === 1, `Enter commits exactly one save (saw ${saves})`);
    ok(counts().reads >= 1, `Enter triggers the deferred read (saw ${reads})`);

    // a pointerdown outside the card commits (back to the original -> a real change again)
    zero();
    await editInput(DET, detWas);
    await page.mouse.click(5, 5);   // graph background, outside every node
    await page.waitForTimeout(SETTLE);
    s = await probe(DET);
    ok(!s.bar, "click outside removes the bar");
    ok(s.value === detWas, "click outside kept the new value");
    ok(counts().saves === 1, `click outside commits one save (saw ${saves})`);

    // ---- REAL keystrokes: `input` fires, `change` does NOT until blur ----
    // Regressions this pins: (a) the bar only appeared once you left the input; (b) clicking
    // outside ran the commit on pointerdown, a beat BEFORE the blur delivered the `change`, so the
    // typed value was stranded in a fresh pending edit instead of being saved.
    console.log("typing (no blur):");
    const typeInto = async (sel, v) => {
        await waitQuiet();          // the last commit's loader must be gone: `inert` refuses focus
        await page.focus(sel);
        await page.keyboard.press("Control+A");
        await page.keyboard.type(v, { delay: 20 });
    };
    zero();
    await typeInto(DET, detAlt);
    await page.waitForTimeout(250);   // no blur has happened: `change` has not fired
    s = await probe(DET);
    ok(s.bar, "the ✓/✕ bar appears WHILE TYPING, before any blur");
    ok(s.focused, "still focused mid-typing");
    ok(counts().saves === 0, `typing alone never saves (saw ${saves})`);

    // now click away: blur fires `change`, and the commit must carry the typed value
    zero();
    await page.mouse.click(5, 5);
    await page.waitForTimeout(SETTLE);
    s = await probe(DET);
    ok(!s.bar, "click-outside after typing leaves NO stranded pending edit");
    ok(s.value === detAlt, `committed value is the typed one (got ${s.value})`);
    ok(counts().saves === 1, `click-outside after typing commits exactly one save (saw ${saves})`);

    // real typing + Enter: the blur `change` must land in the SAME batch, not reopen a new one
    zero();
    await typeInto(DET, detWas);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(SETTLE);
    s = await probe(DET);
    ok(!s.bar, "Enter after real typing leaves no bar (blur `change` didn't reopen the transaction)");
    ok(s.value === detWas, "Enter after real typing kept the typed value");
    ok(counts().saves === 1, `Enter after real typing commits exactly one save (saw ${saves})`);

    // ---- commit latency: loader is lit in-frame, debounces flushed not waited out ----
    zero();
    await editInput(DET, detAlt);   // a real change, so the commit actually does work
    const lit = await page.evaluate(async (id) => {
        const card = document.getElementById(id);
        const t0 = performance.now();
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        for (let i = 0; i < 120; i++) {
            if (card.classList.contains("busy")) return performance.now() - t0;
            await new Promise((r) => requestAnimationFrame(r));
        }
        return -1;
    }, detId);
    ok(lit >= 0 && lit < 50, `commit lights the node's loader immediately (${lit.toFixed(1)}ms)`);
    await page.waitForTimeout(250);   // well under the 400ms save / 700ms read debounces
    ok(counts().saves === 1, `commit flushes the save immediately (saw ${saves} within 250ms)`);
    ok(counts().reads >= 1, `commit flushes the read immediately (saw ${reads} within 250ms)`);
    await page.waitForTimeout(SETTLE * 3);
    ok(!(await probe(DET)).busy, "the loader clears once the flushed work settles");

    // put the profile back the way we found it
    await editInput(DET, detWas);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(SETTLE);
    ok((await probe(DET)).value === detWas, "restored the detector's original value");

    // ---- subset node: filters (the case the user named) ----
    console.log("subset filter:");
    const SF = ".gnode.subset .sf-val";
    if (await page.$(SF)) {
        const subWas = await page.$eval(SF, (el) => el.value);
        const typed = `${subWas}zzz`;
        zero();
        await editInput(SF, typed);
        await page.waitForTimeout(SETTLE);
        s = await probe(SF);
        ok(s.bar, "pending filter edit shows the bar");
        ok(s.focused, "filter input keeps focus");
        ok(s.value === typed, "the typed filter value is actually applied");   // else the revert below proves nothing
        ok(counts().saves === 0, `no save while filter edit pending (saw ${saves})`);

        // typed back to the original => no longer a change
        zero();
        await editInput(SF, subWas);
        await page.waitForTimeout(250);
        ok(!(await probe(SF)).bar, "filter typed back to its original hides the bar");
        await page.mouse.click(5, 5);
        await page.waitForTimeout(SETTLE);
        ok(counts().saves === 0, `a no-net-change filter edit commits nothing (saw ${saves})`);

        zero();
        await editInput(SF, typed);
        await page.keyboard.press("Escape");
        await page.waitForTimeout(SETTLE);
        // Escape's restore rebuilds the node body from the model, so this input is a FRESH element
        // carrying the model's value — checking it here checks the model, not just the DOM.
        s = await probe(SF);
        ok(s.value === subWas, `Escape restores the filter value (got "${s.value}", want "${subWas}")`);
        ok(counts().saves === 0, `Escape never saves the filter (saw ${saves})`);
    } else {
        ok(false, "no subset filter input found to test");
    }

    ok(pageErrs.length === 0, `no page errors (${pageErrs.join(" | ")})`);

    await browser.close();
    if (fails.length) { console.error(`\n${fails.length} FAILED:\n - ${fails.join("\n - ")}`); process.exit(1); }
    console.log("\nall good");
})();
