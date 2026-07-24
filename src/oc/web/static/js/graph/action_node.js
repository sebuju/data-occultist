// Action node: when fired, does whatever is wired into its targets — runs a dataset op (clear, or
// clone/move into a destination) on every DATASET target, EACH register target's own op (set
// values, remove all keys, or clone/move — independent of the dataset op, so a dataset clear and a
// register set can coexist on one node), cues sound nodes to the browser, and fires other action
// nodes downstream (chaining). A trigger names this node's id in its `targets` (drag the trigger's
// fire-port here, or pick it in the trigger's "fires"), so any trigger condition can drive it — the
// shared fire_action funnel does the work for every path (collector, trigger fire-now, this node's
// own fire button).
//
// The body is kind-dependent: the dataset-op row only appears once a dataset is attached, one
// register-op block per attached register (its own op selector + kind-dependent sub-rows), the
// sound repeat rows only once a sound is attached, and `delay` (which defers the whole node) is
// always there. ALL timing is server-side — a backgrounded tab throttles its timers but not its SSE
// cue delivery, so the browser only ever plays a cue that just arrived and never schedules one.
// Rendering only — wiring is in io_wire.js (wireAction). Config persists in the profile YAML.
import { h, frag, labCell, srcRow } from "../dom.js";
import { sourcesInput } from "./sources_input.js";
import { keyRows, regWriteRows } from "./reg_slots.js";

// dataset ops this node can perform, on a DATASET target only (a register target runs its OWN op —
// see REG_OPS below, independent of this one). "" = no-op. clone/move copy into `dest` (batches =
// keep batch grouping; resolved = collapse to one). move also clears the source.
// `compact` applies each target dataset's own keep_batches window (a no-op without one).
const ACTIONS = [["", "no action"], ["clear", "clear targets"], ["compact", "compact to batch limit"],
    ["clone_batches", "clone data (batches)"], ["clone_resolved", "clone data (resolved)"],
    ["move_batches", "move data (batches)"], ["move_resolved", "move data (resolved)"]];

// register ops (GraphModel.REGISTER_OPS values, with labels) — each register target runs its own,
// independent of the dataset ACTIONS above (a dataset clear and a register set can coexist on one
// node). "set" writes/removes individual keys (regWriteRows, below); "remove_all" drops every held
// key (ignores key-narrowing); "clone" copies keys into dest keeping the register's own values,
// "move" also drops them — a register has no batch grouping, so unlike the dataset ACTIONS above
// there's no separate batches/resolved variant to pick between. clone/move's dest picks EITHER a
// dataset or another register from one combined "into" list — the kind is self-describing from
// what's picked (a prefixed ref), no separate kind field/toggle. Every register's dest on this node
// still shares one kind (not mixed): picking a NEW kind clears every other register's dest here.
const REG_OPS = [["", "no action"], ["set", "set values"], ["remove_all", "remove all keys"],
    ["clone", "clone data"], ["move", "move data"]];

// a "wait this long" input with its ms unit suffix — the trigger's throttle/settle shape (tg-secs),
// reused rather than restyled so every millisecond field in the graph reads the same.
const msRow = (cls, value, opts = {}) => h("span", { class: "tg-secs" },
    h("input", { class: `gi ${cls}`, type: "number", min: String(opts.min ?? 0),
        step: String(opts.step ?? 50), value }), " ms");

export function actionParts(x, model) {
    const cur = x.action || "";
    const needsDest = cur.startsWith("clone_") || cur.startsWith("move_");
    const srcs = model.actionSources(x.id);                    // [{kind,id,ref}] datasets/registers/sounds/actions
    const have = new Set(srcs.map((s) => s.ref));
    // which rows the body shows follows what's actually attached: the shared dataset-op row for
    // DATASET targets only (a register target runs its OWN op — see regSrcs below), repeat for
    // sounds, nothing extra for a chained action (it's a chip only).
    const datasets = srcs.filter((s) => s.kind === "dataset");
    const regSrcs = srcs.filter((s) => s.kind === "register");
    const sounds = srcs.filter((s) => s.kind === "sound");
    // free options: everything not already wired, each a prefixed ref with a typed label. Another
    // action can be chained, but never this one (a self-chain would cascade forever). A thunk so the
    // "+" list is recomputed live on open (node creation skips the consumer-rebuild sweep).
    const free = () => [
        ...model.datasets().filter((d) => !have.has(`dataset:${d}`)).map((d) => ({ value: `dataset:${d}`, label: d })),
        ...model.registers().filter((r) => !have.has(`register:${r}`)).map((r) => ({ value: `register:${r}`, label: r })),
        ...(model.profile.sounds || []).map((s) => s.id).filter((s) => !have.has(`sound:${s}`))
            .map((s) => ({ value: `sound:${s}`, label: s })),
        ...(model.profile.actions || []).map((a) => a.id)
            .filter((a) => a !== x.id && !have.has(`action:${a}`) && !model._actionReaches(a, x.id))
            .map((a) => ({ value: `action:${a}`, label: a })),
    ];
    // dataset op's clone/move dest excludes the action's own dataset targets so you can't pick one
    // as its own dest (the server no-ops that anyway).
    const dsSrc = new Set(datasets.map((s) => s.id));
    const dsFree = model.datasets().filter((d) => !dsSrc.has(d));
    const repeat = x.repeat ?? 1;
    // Per-register op block: each register target picks its OWN op (independent of the shared
    // dataset action above) — "set" shows the key/value/remove rows, clone/move show key-narrowing
    // + an "into" dest picker, remove_all shows nothing extra (it always drops every held key).
    const regBlocks = regSrcs.flatMap((s) => {
        const op = model.actionRegOp(x.id, s.id);
        const regNeedsDest = op === "clone" || op === "move";
        const dest = model.actionRegDest(x.id, s.id);   // "" | "dataset:<id>" | "register:<id>"
        // one combined list: a dataset (excluding this node's own dataset targets, like the shared
        // dataset op's dest does) or another register (excluding this row's own register — can't
        // clone/move into itself). setActionRegDest enforces one dest KIND per node on write.
        const regFree = model.registers().filter((r) => r !== s.id);
        return [
            labCell(s.id, `what this action does to register '${s.id}' when fired`),
            h("select", { class: "ac-regop", dataset: { reg: s.id } },
                REG_OPS.map(([v, l]) => h("option", { value: v, selected: v === op }, v === op ? `<${l}>` : l))),
            op === "set" && regWriteRows({ regId: s.id, rows: model.actionWrites(x.id, s.id) }),
            regNeedsDest && keyRows({
                regId: s.id, keys: model.actionRegKeys(x.id, s.id),
                hint: `which of ${s.id}'s keys this copies/moves (default all) — hand-typed, register keys aren't statically known` }),
            regNeedsDest && labCell("into", `destination for '${s.id}' — a dataset, or another register`),
            regNeedsDest && h("select", { class: "ac-regdest", dataset: { reg: s.id } },
                h("option", { value: "" }, "- destination -"),
                h("optgroup", { label: "datasets" },
                    dsFree.map((d) => h("option", { value: `dataset:${d}`, selected: dest === `dataset:${d}` },
                        dest === `dataset:${d}` ? `<${d}>` : d))),
                h("optgroup", { label: "registers" },
                    regFree.map((r) => h("option", { value: `register:${r}`, selected: dest === `register:${r}` },
                        dest === `register:${r}` ? `<${r}>` : r)))),
        ];
    });
    return {
        title: h("input", { class: "gi gi-id acrename", value: x.id, title: "rename action" }),
        body: frag(
            srcRow("targets", "datasets, registers, sounds and actions this node operates on when fired",
                sourcesInput({
                    chips: srcs.map((s) => ({ value: s.ref, label: s.id, node: model.refNode(s.ref) })),
                    free, addLabel: "+ target", addinCls: "sv-addin ac-addsrc", rmCls: "sv-rmin ac-rmsrc" })),
            labCell("delay", "wait this long after being fired before running (0 = run now)"),
            msRow("ac-delay", x.delay_ms ?? 0),
            datasets.length > 0 && labCell("action", "what this node does to its datasets when fired"),
            datasets.length > 0 && h("select", { class: "ac-action" },
                ACTIONS.map(([v, l]) => h("option", { value: v, selected: v === cur }, v === cur ? `<${l}>` : l))),
            datasets.length > 0 && needsDest && labCell("into", "destination dataset for clone/move"),
            datasets.length > 0 && needsDest && h("select", { class: "ac-dest" },
                h("option", { value: "" }, "- dataset -"),
                dsFree.map((d) => h("option", { selected: d === x.dest }, d === x.dest ? `<${d}>` : d))),
            ...regBlocks,
            sounds.length > 0 && labCell("repeat", "how many times to play the attached sound(s)"),
            sounds.length > 0 && h("span", { class: "tg-secs" },
                h("input", { class: "gi ac-repeat", type: "number", min: "1", step: "1", value: repeat }), " plays"),
            sounds.length > 0 && repeat > 1 && labCell("every", "gap between those plays"),
            sounds.length > 0 && repeat > 1 && msRow("ac-repms", x.repeat_ms ?? 300, { min: 10, step: 10 })),
        foot: h("button", { class: "ac-fire", title: "run this action now on its targets" }, "↻ fire"),
        ports: h("span", { class: "port out", title: "drag to a dataset, register, sound or action this node operates on" }),
    };
}
