// Headless spec for the testing inspector's feed resolver (graph/feed_targets.js).
//
// resolveFeeds() is DOM-free and takes the GraphModel in, so it runs straight in Node — no
// browser, no server. This pins WHICH node types resolve to WHICH injectable inputs: a gate
// tests a readout, a subset joins datasets, a trigger watches either, a grid-side node writes
// its window's dataset. Getting this wrong makes the inspector silently offer nothing (or the
// wrong thing) for a node, which is invisible until you're mid-test.
//
// Run:  node tests/e2e/feed-targets.mjs
import { GraphModel } from "../../src/oc/web/static/js/graph/model.js";
import { resolveFeeds } from "../../src/oc/web/static/js/graph/feed_targets.js";

const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); console.log(`   ${cond ? "✓" : "✗"} ${msg}`); };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

// One of every wiring shape the resolver walks.
function build() {
    const m = new GraphModel();
    m.load({
        name: "t",
        windows: [{
            id: "win1", dataset: "ds_a", fields: [{ id: "f1", type: "number" }, { id: "f2", type: "text" }],
            detect: [], states: [], regions: [{ id: "r1", field: "f2" }],
            readouts: [{ id: "ro_x", field: "f1", enabled: true }, { id: "ro_y", field: "f2", enabled: true }],
        }],
        datasets: [{ id: "ds_a" }, { id: "ds_b" }],
        subsets: [{ id: "sub1", sources: [{ dataset: "ds_a" }, { dataset: "ds_b" }] }],
        producers: [{ id: "prod1", dataset: "ds_b", sources: ["ds_a"] }],
        file_sources: [{ id: "src1", dataset: "ds_b", match: [], fields: [] }],
        triggers: [
            { id: "trg_ro", kind: "on_readout", readout_watch: ["ro_x"], watch: [], register_watch: [], targets: [], gates: [] },
            { id: "trg_ds", kind: "on_change", watch: ["ds_a", "sub1"], readout_watch: [], register_watch: [], targets: [], gates: [] },
            { id: "trg_reg", kind: "on_register", register_watch: ["reg1"], watch: [], readout_watch: [], targets: [], gates: [] },
        ],
        gates: [{ id: "gate_ro", source: "readout:ro_x", conds: [{ when: "lt", arg: "3" }], logic: "or" },
                { id: "gate_reg", source: "register:reg1#ro_x", conds: [] }],
        routers: [{ id: "rt1", source: "readout:ro_y", branches: [] }],
        registers: [{ id: "reg1", sources: ["readout:ro_x"] }],
        processes: [{ id: "proc1", sources: [{ ref: "readout:ro_y", out: "" }] }],
        toasts: [{ id: "toast1", sources: ["readout:ro_x", "dataset:ds_b"] }],
        window_priority: ["win1"],
    });
    return m;
}

const m = build();
const node = (id) => m.nodes().find((n) => n.id === id);
const feeds = (id) => resolveFeeds(m, node(id));
const roIds = (id) => feeds(id).ro.map((r) => r.id).sort();

console.log("window -> its readouts AND its output dataset");
{
    const f = feeds("win:win1");
    eq(roIds("win:win1"), ["ro_x", "ro_y"], "window offers both readouts");
    eq(f.ds, ["ds_a"], "window also offers its grid dataset");
    eq(f.ro[0].win, "win1", "readout entry carries its window");
    ok(f.ro[0].field?.type === "number", "readout entry carries its linked FieldDef (type)");
}

console.log("readout -> just itself");
{
    eq(roIds("ro:win1:ro_x"), ["ro_x"], "readout offers only itself");
    eq(feeds("ro:win1:ro_x").ds, [], "readout offers no dataset");
}

console.log("gate / router -> the source they test");
{
    eq(roIds("gate:gate_ro"), ["ro_x"], "readout-source gate resolves to that readout");
    eq(roIds("router:rt1"), ["ro_y"], "router resolves to its source readout");
    // a register-source gate walks THROUGH the register to whatever feeds it
    eq(roIds("gate:gate_reg"), ["ro_x"], "register-source gate walks through to the feeding readout");
    ok(feeds("gate:gate_ro").tip.includes("passes when lt 3"), "gate tip states its condition");
}

console.log("register / process / toast -> their source readouts");
{
    eq(roIds("register:reg1"), ["ro_x"], "register resolves to its readout source");
    eq(roIds("process:proc1"), ["ro_y"], "process resolves to its readout source");
    eq(roIds("toast:toast1"), ["ro_x"], "toast resolves to its readout source");
    eq(feeds("toast:toast1").ds, ["ds_b"], "toast also resolves its dataset source");
}

console.log("trigger -> whatever its kind watches");
{
    eq(roIds("trigger:trg_ro"), ["ro_x"], "on_readout trigger resolves its readout_watch");
    eq(feeds("trigger:trg_ds").ds, ["ds_a", "ds_b"], "on_change trigger resolves watch (subset expanded to its datasets)");
    eq(roIds("trigger:trg_reg"), ["ro_x"], "on_register trigger walks the register to its readout");
}

console.log("subset / producer / file source -> datasets");
{
    eq(feeds("sub:sub1").ds, ["ds_a", "ds_b"], "subset resolves to its joined datasets");
    eq(feeds("producer:prod1").ds, ["ds_a"], "producer resolves to its source dataset");
    eq(feeds("src:src1").ds, ["ds_b"], "file source resolves to its output dataset");
    eq(feeds("ds:ds_a").ds, ["ds_a"], "dataset resolves to itself");
}

console.log("grid-side node -> its window's dataset, no readouts");
{
    const f = feeds("reg:win1:r1");
    eq(f.ds, ["ds_a"], "region resolves to its window's dataset");
    eq(f.ro, [], "region offers no readout (it reads cells)");
    ok(f.tip.includes("reads cells"), "region tip explains the redirect");
}

console.log("dedupe + termination");
{
    // sub1 joins ds_a and ds_b; trg_ds watches BOTH ds_a and sub1 -> ds_a must appear once
    eq(feeds("trigger:trg_ds").ds, ["ds_a", "ds_b"], "a dataset reachable by two paths is listed once");
    // self-referencing subset must not hang the walk
    const m2 = build();
    m2.profile.subsets.push({ id: "loop1", sources: [{ dataset: "loop1" }] });
    const f = resolveFeeds(m2, m2.nodes().find((n) => n.id === "sub:loop1"));
    ok(Array.isArray(f.ds), "a self-referencing subset terminates instead of looping");
}

console.log(fails.length ? `\n${fails.length} FAILED` : "\nall passed");
process.exit(fails.length ? 1 : 0);
