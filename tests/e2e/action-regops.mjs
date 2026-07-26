// Headless model spec: an action node's per-REGISTER op (reg_ops) — independent of the shared
// dataset action/dest. GraphModel is DOM-free ESM, so this runs straight in Node — no browser, no
// server (same harness as action-targets.mjs / model-refsites.mjs). What it pins:
//   - setActionRegOp validates against REGISTER_OPS and round-trips; "" drops the whole entry
//   - "set values" rows (add/remove/edit key, value, remove-toggle) round-trip
//   - clone/move key rows (add/edit/remove) round-trip and accept a hand-typed key not currently
//     wired to the register (register keys are runtime-created, not statically known)
//   - setActionRegKeys canonicalizes "covers every wired key" down to [] (the "all" form), like the
//     old shared setActionSlots did
//   - a register's own op is independent of another register's, and of the shared dataset action
//   - removeActionSource drops the whole reg_ops entry for that register (no orphan)
//   - registerDeclaredKeys() shows a manual "set" key even though nothing wired it
//   - REG_OP_ALIAS normalizes the pre-collapse clone_batches/clone_resolved/move_batches/move_resolved
//     vocabulary (register has no batches) to plain clone/move, both via the legacy action/slots/dest
//     fold and on an already-saved reg_ops entry
//   - actionRegDest is a prefixed ref ("dataset:<id>"/"register:<id>") -- self-describing kind, no
//     separate field; setActionRegDest enforces ONE dest kind per node by clearing every OTHER
//     register's dest when a NEW kind is picked (no mixing dataset/register dest on one action)
//
// Run:  node tests/e2e/action-regops.mjs
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
        datasets: [{ id: "ds_a" }, { id: "ds_b" }],
        registers: [{ id: "hp", sources: ["readout:health", "readout:shield"] }, { id: "mp", sources: ["readout:mana"] }],
        actions: [{ id: "act1", sources: ["register:hp", "register:mp"] }],
    });
    return m;
}
const op = (m, regId) => m.actionNode("act1").reg_ops[regId];

console.log("setActionRegOp validates + round-trips");
{
    const m = build();
    m.setActionRegOp("act1", "hp", "bogus");
    eq(op(m, "hp"), undefined, "unknown op refused, no entry created");
    m.setActionRegOp("act1", "hp", "set");
    eq(m.actionRegOp("act1", "hp"), "set", "op round-trips");
    m.setActionRegOp("act1", "hp", "remove_all");
    eq(m.actionRegOp("act1", "hp"), "remove_all", "op switches cleanly");
    m.setActionRegOp("act1", "hp", "");
    eq(op(m, "hp"), undefined, "\"\" drops the whole entry (keeps YAML clean)");
    eq(m.actionRegOp("act1", "hp"), "", "actionRegOp reads back \"\" once dropped");
}

console.log("per-register op is independent of another register's, and of the shared dataset action");
{
    const m = build();
    m.setActionKind("act1", "clear");           // the SHARED dataset op
    m.setActionRegOp("act1", "hp", "set");
    m.setActionRegOp("act1", "mp", "remove_all");
    eq(m.actionNode("act1").action, "clear", "shared dataset action untouched by register ops");
    eq(m.actionRegOp("act1", "hp"), "set", "hp keeps its own op");
    eq(m.actionRegOp("act1", "mp"), "remove_all", "mp keeps its own, different op");
}

console.log("set-values rows: add / edit / remove round-trip");
{
    const m = build();
    m.setActionRegOp("act1", "hp", "set");
    m.addActionWrite("act1", "hp");
    eq(m.actionWrites("act1", "hp"), [{ key: "", value: "", remove: false }], "blank row added");
    m.setActionWriteKey("act1", "hp", 0, "combo");
    m.setActionWriteValue("act1", "hp", 0, "5");
    eq(m.actionWrites("act1", "hp"), [{ key: "combo", value: "5", remove: false }], "key + value set");
    m.addActionWrite("act1", "hp");
    m.setActionWriteKey("act1", "hp", 1, "health");
    m.setActionWriteRemove("act1", "hp", 1, true);
    eq(m.actionWrites("act1", "hp"), [
        { key: "combo", value: "5", remove: false },
        { key: "health", value: "", remove: true },
    ], "second row added as a remove row");
    m.removeActionWrite("act1", "hp", 0);
    eq(m.actionWrites("act1", "hp"), [{ key: "health", value: "", remove: true }], "first row removed, second shifts down");
}

console.log("setActionRegKeys canonicalizes \"all\" to []");
{
    const m = build();
    m.setActionRegOp("act1", "hp", "clone");
    m.setActionRegKeys("act1", "hp", ["health"]);
    eq(m.actionRegKeys("act1", "hp"), ["health"], "narrowed to one key");
    m.setActionRegKeys("act1", "hp", ["health", "shield"]);   // covers every wired key of hp
    eq(m.actionRegKeys("act1", "hp"), [], "covering every wired key canonicalizes to [] (=all)");
    m.setActionRegKeys("act1", "hp", []);
    eq(m.actionRegKeys("act1", "hp"), [], "empty stays []");
}

console.log("clone/move key rows: add / edit / remove round-trip, hand-typed key not required to be wired");
{
    const m = build();
    m.setActionRegOp("act1", "hp", "clone");
    m.addActionRegKey("act1", "hp");
    eq(m.actionRegKeys("act1", "hp"), [""], "blank row added");
    m.setActionRegKey("act1", "hp", 0, "combo");   // "combo" isn't a wired key of hp -- still accepted
    eq(m.actionRegKeys("act1", "hp"), ["combo"], "hand-typed key not present in hp's wired keys");
    m.addActionRegKey("act1", "hp");
    m.setActionRegKey("act1", "hp", 1, "health");
    eq(m.actionRegKeys("act1", "hp"), ["combo", "health"], "second row added");
    m.removeActionRegKey("act1", "hp", 0);
    eq(m.actionRegKeys("act1", "hp"), ["health"], "first row removed, second shifts down");
}

console.log("actionRegDest: prefixed ref, one kind per node -- picking a NEW kind clears every OTHER register's dest");
{
    const m = build();
    m.setActionRegOp("act1", "hp", "clone");
    m.setActionRegDest("act1", "hp", "dataset:ds_a");
    m.setActionRegOp("act1", "mp", "move");
    m.setActionRegDest("act1", "mp", "dataset:ds_b");
    eq(m.actionRegDest("act1", "hp"), "dataset:ds_a", "hp's dataset dest set");
    eq(m.actionRegDest("act1", "mp"), "dataset:ds_b", "mp's dataset dest set independently");
    m.setActionRegDest("act1", "mp", "dataset:ds_a");   // SAME kind (dataset) as hp -- no conflict
    eq(m.actionRegDest("act1", "hp"), "dataset:ds_a", "same-kind dest on another register leaves this one alone");
    m.setActionRegDest("act1", "mp", "register:hp");   // NEW kind (register) for mp
    eq(m.actionRegDest("act1", "mp"), "register:hp", "mp switched to a register dest");
    eq(m.actionRegDest("act1", "hp"), "", "hp's stale dataset-kind dest cleared by mp's kind switch (no mixing)");
}

console.log("actionRegDest round-trips independently of the shared dest");
{
    const m = build();
    m.setActionDest("act1", "ds_a");
    m.setActionRegOp("act1", "hp", "clone");
    m.setActionRegDest("act1", "hp", "dataset:ds_b");
    eq(m.actionNode("act1").dest, "ds_a", "shared dataset dest untouched");
    eq(m.actionRegDest("act1", "hp"), "dataset:ds_b", "register's own dest set independently");
}

console.log("removeActionSource drops the whole reg_ops entry (no orphan)");
{
    const m = build();
    m.setActionRegOp("act1", "hp", "set");
    m.addActionWrite("act1", "hp");
    ok(op(m, "hp") !== undefined, "entry exists before removal");
    m.removeActionSource("act1", "register:hp");
    eq(m.actionNode("act1").sources, ["register:mp"], "source dropped");
    eq(op(m, "hp"), undefined, "reg_ops entry dropped with it, no orphan");
}

console.log("registerDeclaredKeys() surfaces a manual set-key nothing wired");
{
    const m = build();
    eq(m.registerDeclaredKeys("hp"), ["health", "shield"], "wired keys only, before any manual key");
    m.setActionRegOp("act1", "hp", "set");
    m.addActionWrite("act1", "hp");
    m.setActionWriteKey("act1", "hp", 0, "combo");
    eq(m.registerDeclaredKeys("hp"), ["health", "shield", "combo"], "manual key appended, wired keys first");
    // switching the op away from "set" drops the declared key (scaffold follows the live op, not history)
    m.setActionRegOp("act1", "hp", "remove_all");
    eq(m.registerDeclaredKeys("hp"), ["health", "shield"], "manual key gone once the op is no longer \"set\"");
}

console.log("legacy migration twin (load-time): narrowed clear -> set+remove-rows, unnarrowed -> remove_all");
{
    const m = new GraphModel();
    m.load({
        name: "t2",
        registers: [{ id: "hp", sources: ["readout:health", "readout:shield"] }],
        actions: [
            { id: "narrow", action: "clear", sources: ["register:hp"], slots: { hp: ["shield"] } },
            { id: "wide", action: "clear", sources: ["register:hp"] },
            { id: "mover", action: "move_resolved", sources: ["register:hp"], slots: { hp: ["health"] }, dest: "ds_x" },
        ],
    });
    const byId = (id) => m.profile.actions.find((a) => a.id === id);
    eq(byId("narrow").reg_ops.hp, { op: "set", dest: "", keys: [], writes: [{ key: "shield", value: "", remove: true }] },
        "narrowed legacy clear -> set op with one remove row");
    eq(byId("wide").reg_ops.hp, { op: "remove_all", dest: "", keys: [], writes: [] },
        "unnarrowed legacy clear -> remove_all");
    // legacy dataset-shaped move_resolved aliases to plain "move" -- a register has no batches;
    // the legacy bare dest ("ds_x") is coerced to a prefixed "dataset:ds_x" ref too
    eq(byId("mover").reg_ops.hp, { op: "move", dest: "dataset:ds_x", keys: ["health"], writes: [] },
        "clone/move maps across (aliased to plain clone/move), slots -> keys, dest carried + prefixed");
}

console.log("REG_OP_ALIAS/dest-prefix normalize an EXISTING reg_ops entry's old shape, not just a freshly-folded one");
{
    const m = new GraphModel();
    m.load({
        name: "t3",
        registers: [{ id: "hp", sources: ["readout:health"] }],
        actions: [
            { id: "act", sources: ["register:hp"], reg_ops: { hp: { op: "clone_batches", dest: "ds_x", keys: [], writes: [] } } },
        ],
    });
    eq(m.actionNode("act").reg_ops.hp.op, "clone", "pre-collapse op value fixed on load even with no legacy action field");
    eq(m.actionNode("act").reg_ops.hp.dest, "dataset:ds_x", "pre-feature bare dest coerced to a prefixed ref too");
}

if (fails.length) { console.error(`\n${fails.length} FAILED:\n - ${fails.join("\n - ")}`); process.exit(1); }
console.log("\nall good");
