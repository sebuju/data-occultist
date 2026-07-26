// Headless model spec: an action node's non-dataset targets — SOUND cues and ACTION chaining.
//
// GraphModel is DOM-free ESM, so this runs straight in Node — no browser, no server (same harness
// as model-refsites.mjs). What it pins:
//   - a sound / another action can be added to `sources` as a prefixed ref, an unknown one can't
//   - a chain never closes a cycle (self-chain and a->b->a are both refused, in the MODEL, so the
//     drag never persists something the server would have to defend against)
//   - refNode resolves "sound:" / "action:" refs, WITHOUT which the action->target edge never draws
//   - rename/delete of a sound or a chained action repoints/prunes the action's refs (rule 5)
//
// Run:  node tests/e2e/action-targets.mjs
import { GraphModel } from "../../src/oc/web/static/js/graph/model.js";
import { loadWiring } from "./_wiring.mjs";

loadWiring();   // the real /api/wiring table (see _wiring.mjs) — no browser, no server

const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); console.log(`   ${cond ? "✓" : "✗"} ${msg}`); };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

function build() {
    const m = new GraphModel();
    m.load({
        name: "t",
        datasets: [{ id: "ds_a" }],
        actions: [{ id: "act1", sources: [] }, { id: "act2", sources: [] }],
        sounds: [{ id: "beep", file: "beep.wav" }],
    });
    return m;
}
const srcs = (m, id) => m.actionNode(id).sources;
const edgeTo = (m, from, to) => m.edges().some((e) => e.from === from && e.to === to);

console.log("action targets: sounds + chaining");
{
    const m = build();
    ok(m.addActionSource("act1", "sound:beep") === true, "sound target added");
    ok(m.addActionSource("act1", "action:act2") === true, "action target added (chain)");
    ok(m.addActionSource("act1", "sound:ghost") === false, "unknown sound refused");
    ok(m.addActionSource("act1", "action:ghost") === false, "unknown action refused");
    ok(m.addActionSource("act1", "sound:beep") === false, "duplicate refused");
    eq(srcs(m, "act1"), ["sound:beep", "action:act2"], "sources hold prefixed refs");
}

console.log("cycles refused");
{
    const m = build();
    ok(m.addActionSource("act1", "action:act1") === false, "self-chain refused");
    m.addActionSource("act1", "action:act2");
    ok(m.addActionSource("act2", "action:act1") === false, "a->b->a refused");
    eq(srcs(m, "act2"), [], "the refused chain left no ref behind");
}

console.log("edges draw");
{
    const m = build();
    m.addActionSource("act1", "sound:beep");
    m.addActionSource("act1", "action:act2");
    ok(m.refNode("sound:beep") === "sound:beep", "refNode resolves a sound ref");
    ok(m.refNode("action:act2") === "action:act2", "refNode resolves an action ref");
    ok(edgeTo(m, "action:act1", "sound:beep"), "action -> sound edge");
    ok(edgeTo(m, "action:act1", "action:act2"), "action -> action edge");
}

console.log("rename / delete repointing");
{
    const m = build();
    m.addActionSource("act1", "sound:beep");
    m.addActionSource("act1", "action:act2");
    m.renameSound("beep", "boop");
    m.renameAction("act2", "act9");
    eq(srcs(m, "act1"), ["sound:boop", "action:act9"], "both refs followed their rename");
    m.removeSound("boop");
    eq(srcs(m, "act1"), ["action:act9"], "deleted sound pruned");
    m.removeAction("act9");
    eq(srcs(m, "act1"), [], "deleted chained action pruned");
}

console.log("timing knobs clamp");
{
    const m = build();
    m.setActionDelay("act1", "-5"); m.setActionRepeat("act1", "0"); m.setActionRepeatMs("act1", "1");
    const x = m.actionNode("act1");
    eq([x.delay_ms, x.repeat, x.repeat_ms], [0, 1, 10], "clamped to their floors");
    m.setActionDelay("act1", "250"); m.setActionRepeat("act1", "3"); m.setActionRepeatMs("act1", "120");
    eq([x.delay_ms, x.repeat, x.repeat_ms], [250, 3, 120], "real values kept");
}

console.log(fails.length ? `\n${fails.length} FAILED:\n - ${fails.join("\n - ")}` : "\nall good");
process.exit(fails.length ? 1 : 0);
