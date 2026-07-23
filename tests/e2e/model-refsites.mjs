// Headless model spec: rename/delete repointing across every reference site.
//
// GraphModel is DOM-free ESM (imports only ../defaults.js), so it runs straight in Node — no
// browser, no server. This pins the behavior the unified _refModel() registry must preserve:
// every rename carries its refs, every delete prunes them, and a mixed action `sources` array
// ("dataset:x","register:y") is repointed per-kind WITHOUT the two halves stepping on each other.
//
// Run:  node tests/e2e/model-refsites.mjs
import { GraphModel } from "../../src/oc/web/static/js/graph/model.js";

const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); console.log(`   ${cond ? "✓" : "✗"} ${msg}`); };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

// A fresh model wired with one of everything that holds a reference.
function build() {
    const m = new GraphModel();
    m.load({
        name: "t",
        windows: [{ id: "win1", dataset: "ds_a", fields: [{ id: "f1" }], detect: [], states: [], regions: [],
            readouts: [{ id: "ro_x", field: "f1" }],
            items: [{ id: "item1", box: { x: 0, y: 0, w: 0.1, h: 0.1 } }] }],
        datasets: [{ id: "ds_a" }, { id: "ds_b" }],
        subsets: [{ id: "sub1", sources: [{ dataset: "ds_a" }] }],
        producers: [{ id: "prod1", dataset: "ds_b", sources: [] }],
        file_sources: [{ id: "src1", dataset: "ds_a", match: [], fields: [] }],
        triggers: [{ id: "trg1", kind: "on_register", targets: ["prod1", "act1"],
            watch: ["ds_a", "sub1"], readout_watch: ["ro_x"],
            register_watch: ["reg1"], gates: ["gate1"], window_watch: ["win1"] },
            { id: "trg_item", kind: "on_item", targets: [], window_watch: ["win1"], item_watch: "item1" }],
        gates: [{ id: "gate1", source: "register:reg1#ro_x", conds: [{ when: "lt", arg: "3" }] }],
        actions: [{ id: "act1", sources: ["dataset:ds_a", "register:reg1"], slots: { reg1: ["ro_x"] }, dest: "ds_b" }],
        registers: [{ id: "reg1", sources: ["readout:ro_x"], persist: "ds_a" }],
        toasts: [{ id: "toast1", sources: ["dataset:ds_a", "subset:sub1", "readout:ro_x"],
            title: "{{dataset:ds_a.f1|sum}} / {{dataset:ds_b}}",
            message: "{{subset:sub1[0:2]|join:\", \"}} {{readout:ro_x}}",
            texts: [{ content: "{{readout:ro_x}}", style: "", align: "" }] }],
        dictionaries: [{ id: "dict1", feeds: [{ dataset: "ds_a" }] }],
        window_priority: ["win1"],
    });
    return m;
}
const P = (m) => m.profile;
const act = (m) => P(m).actions[0], trg = (m) => P(m).triggers[0], sub = (m) => P(m).subsets[0];
const reg = (m) => P(m).registers[0], toast = (m) => P(m).toasts[0], dict = (m) => P(m).dictionaries[0];
const gate = (m) => P(m).gates[0];
const trgItem = (m) => P(m).triggers[1];

// ---- rename dataset: every dataset ref moves, nothing else ----
{
    const m = build();
    const hits = []; m.setRenameHook((e) => hits.push(e));
    ok(m.renameDataset("ds_a", "ds_z"), "renameDataset returns true");
    eq(P(m).windows[0].dataset, "ds_z", "window feeder repointed");
    eq(sub(m).sources[0].dataset, "ds_z", "subset source repointed");
    eq(P(m).file_sources[0].dataset, "ds_z", "file-source feeder repointed");
    eq(trg(m).watch, ["ds_z", "sub1"], "trigger watch repointed (subset untouched)");
    eq(act(m).sources, ["dataset:ds_z", "register:reg1"], "action dataset source repointed, register source untouched");
    eq(reg(m).persist, "ds_z", "register persist repointed");
    eq(toast(m).sources[0], "dataset:ds_z", "toast dataset source repointed");
    eq(toast(m).title, "{{dataset:ds_z.f1|sum}} / {{dataset:ds_b}}",
        "toast dataset token repointed (.field|agg suffix kept, ds_b untouched)");
    eq(dict(m).feeds[0].dataset, "ds_z", "dict feed repointed");
    eq(act(m).dest, "ds_b", "action dest (ds_b) untouched");
    ok(m.datasets().includes("ds_z") && !m.datasets().includes("ds_a"), "datasets() shows new id, not old");
    eq(m.datasets().filter((d) => d === "ds_z").length, 1, "no duplicate/ghost dataset");
    eq(hits, [{ kind: "dataset", old: "ds_a", new: "ds_z", win: undefined }], "one dataset rename emitted");
}

// ---- rename register: register source + slot key + watch + conds move; dataset half untouched ----
{
    const m = build();
    ok(m.renameRegister("reg1", "reg9"), "renameRegister returns true");
    eq(act(m).sources, ["dataset:ds_a", "register:reg9"], "action register source repointed, dataset source untouched");
    ok(act(m).slots.reg9 && !act(m).slots.reg1, "action slots dict re-keyed reg1->reg9");
    eq(act(m).slots.reg9, ["ro_x"], "action slot keys preserved across register rename");
    eq(trg(m).register_watch, ["reg9"], "trigger register_watch repointed");
    eq(gate(m).source, "register:reg9#ro_x", "gate source register repointed (#key preserved)");
}

// ---- rename subset: subset refs move, dataset-only sites untouched ----
{
    const m = build();
    ok(m.renameSubset("sub1", "sub9"), "renameSubset returns true");
    eq(sub(m).id, "sub9", "subset def id renamed");
    eq(trg(m).watch, ["ds_a", "sub9"], "trigger watch subset ref repointed");
    eq(toast(m).sources[1], "subset:sub9", "toast subset source repointed");
    eq(toast(m).message, "{{subset:sub9[0:2]|join:\", \"}} {{readout:ro_x}}",
        "toast subset token repointed ([slice]|join suffix kept, readout token untouched)");
    eq(act(m).sources, ["dataset:ds_a", "register:reg1"], "action sources untouched by subset rename");
}

// ---- rename readout: structured refs + toast token both move ----
{
    const m = build();
    ok(m.renameReadout("win1", "ro_x", "ro_z"), "renameReadout returns true");
    eq(reg(m).sources[0], "readout:ro_z", "register readout source repointed");
    eq(toast(m).sources[2], "readout:ro_z", "toast readout source repointed");
    eq(trg(m).readout_watch, ["ro_z"], "trigger readout_watch repointed");
    eq(toast(m).texts[0].content, "{{readout:ro_z}}", "toast token rewritten");
}

// ---- rename readout: register #key refs follow (the register slot IS the readout id) ----
// A register key is the id of the readout feeding it, so a gate/router/process ref
// "register:<reg>#<readout>" must repoint its KEY on a readout rename, not just "readout:<id>"
// refs — else the ref points at a dead key and a gate over it silently never holds. The "@facet"
// count suffix is preserved. (Regression: this key half was previously left untouched.)
{
    const m = new GraphModel();
    m.load({
        name: "t2",
        windows: [{ id: "w", fields: [{ id: "f" }], detect: [], states: [], regions: [],
            readouts: [{ id: "ro_x", field: "f" }] }],
        registers: [{ id: "reg1", sources: ["readout:ro_x"] }],
        processes: [{ id: "p1", sources: [{ ref: "register:reg1#ro_x", out: "" }] }],
        gates: [{ id: "g1", source: "register:reg1#ro_x@nonblank", conds: [{ when: "gt", arg: "2" }] }],
        routers: [{ id: "r1", source: "register:reg1#ro_x", branches: [] }],
    });
    ok(m.renameReadout("w", "ro_x", "ro_z"), "renameReadout returns true");
    eq(m.profile.gates[0].source, "register:reg1#ro_z@nonblank", "gate register #key repointed, @facet preserved");
    eq(m.profile.routers[0].source, "register:reg1#ro_z", "router register #key repointed");
    eq(m.profile.processes[0].sources[0].ref, "register:reg1#ro_z", "process register-input #key repointed");
    ok(m.renameRegister("reg1", "reg9"), "renameRegister still works after");
    eq(m.profile.gates[0].source, "register:reg9#ro_z@nonblank", "register id repointed, #key + facet preserved");
    // delete the keyed readout -> the whole ref blanks (no malformed "register:reg9#@nonblank")
    m.removeReadout("w", "ro_z");
    eq(m.profile.gates[0].source, "", "gate register #key ref blanked on readout delete");
    eq(m.profile.processes[0].sources, [], "process register-input pruned on readout delete");
}

// ---- rename producer / action / window: target + priority carry ----
{
    const m = build();
    ok(m.renameProducer("prod1", "prod9"), "renameProducer returns true");
    eq(trg(m).targets[0], "prod9", "trigger target (producer) repointed");
    ok(m.renameAction("act1", "act9"), "renameAction returns true");
    eq(trg(m).targets[1], "act9", "trigger target (action) repointed");
    ok(m.renameWindow("win1", "win9"), "renameWindow returns true");
    eq(P(m).window_priority, ["win9"], "window_priority repointed");
    eq(trg(m).window_watch, ["win9"], "on_register trigger's window_watch repointed on window rename");
    eq(trgItem(m).window_watch, ["win9"], "on_item trigger's window_watch repointed on window rename");
    eq(trgItem(m).item_watch, "item1", "on_item's item_watch untouched by a WINDOW rename");
}

// ---- rename/delete item: on_item's item_watch tracks it (window-scoped, not the generic registry) ----
{
    const m = build();
    ok(m.renameItem("win1", "item1", "item9"), "renameItem returns true");
    eq(trgItem(m).item_watch, "item9", "on_item's item_watch repointed on item rename");
    m.removeItem("win1", "item9");
    eq(trgItem(m).item_watch, "", "on_item's item_watch cleared on item delete (no dangling ref)");
}

// ---- delete window: window_watch pruned (mirrors window_priority above) ----
{
    const m = build();
    m.removeWindow("win1");
    eq(trg(m).window_watch, [], "on_register trigger's window_watch pruned on window delete");
    eq(trgItem(m).window_watch, [], "on_item trigger's window_watch pruned on window delete");
}

// ---- delete dataset: refs blanked+pruned, no ghost ----
{
    const m = build();
    m.removeDataset("ds_b");
    eq(P(m).producers[0].dataset, "", "producer feeder blanked");
    eq(act(m).dest, "", "action dest blanked");
    ok(!m.datasets().includes("ds_b"), "datasets() no longer lists ds_b");
    eq(toast(m).title, "{{dataset:ds_a.f1|sum}} / ", "toast ds_b token stripped, ds_a token untouched");
}

// ---- delete subset: toast token stripped ----
{
    const m = build();
    m.removeSubset("sub1");
    eq(toast(m).message, " {{readout:ro_x}}", "toast subset token stripped, readout token untouched");
}

// ---- delete register: source dropped, slot + watch + conds cleared, no 'register:' ghost ----
{
    const m = build();
    m.removeRegister("reg1");
    eq(act(m).sources, ["dataset:ds_a"], "register source pruned (no 'register:' ghost)");
    ok(!act(m).slots.reg1, "action slot dropped");
    eq(trg(m).register_watch, [], "trigger register_watch cleared");
    eq(gate(m).source, "", "gate source register pruned (no 'register:' ghost)");
}

// ---- delete readout: structured refs + toast token stripped ----
{
    const m = build();
    m.removeReadout("win1", "ro_x");
    eq(reg(m).sources, [], "register readout source dropped");
    eq(toast(m).sources, ["dataset:ds_a", "subset:sub1"], "toast readout source dropped");
    eq(trg(m).readout_watch, [], "trigger readout_watch cleared");
    eq(toast(m).texts[0].content, "", "toast token stripped");
}

if (fails.length) { console.error(`\n${fails.length} FAILED:\n - ${fails.join("\n - ")}`); process.exit(1); }
console.log("\nall good");
