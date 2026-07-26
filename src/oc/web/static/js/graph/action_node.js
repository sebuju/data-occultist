// Action node: when fired, does whatever is wired into its targets — runs a dataset op (clear, or
// clone/move into a destination) on every DATASET target, EACH register target's own op (set
// values, remove all keys, or clone/move — independent of the dataset op, so a dataset clear and a
// register set can coexist on one node), cues sound nodes to the browser, sends a scripted
// key/mouse/scroll sequence to a bound WINDOW target (gated on that window being foreground — see
// oc.collect.triggers._run_action), and fires other action nodes downstream (chaining). A trigger
// names this node's id in its `targets` (drag the trigger's fire-port here, or pick it in the
// trigger's "fires"), so any trigger condition can drive it — the shared fire_action funnel does
// the work for every path (collector, trigger fire-now, this node's own fire button).
//
// The body is kind-dependent: the dataset-op row only appears once a dataset is attached, one
// register-op block per attached register (its own op selector + kind-dependent sub-rows), the
// send-events row editor only once a window is attached (input_rows.js), the sound repeat rows
// only once a sound is attached, and `delay` (which defers the whole node) is always there. ALL
// timing is server-side — a backgrounded tab throttles its timers but not its SSE cue delivery, so
// the browser only ever plays a cue that just arrived and never schedules one.
// Rendering only — wiring is in io_wire.js (wireAction). Config persists in the profile YAML.
import { h, frag, labCell, srcRow } from "../dom.js";
import { sourcesInput } from "./sources_input.js";
import { keyRows, regWriteRows } from "./reg_slots.js";
import { inputRows } from "./input_rows.js";
import * as wiring from "./wiring.js";

// The two op vocabularies this node edits come from the server's wiring table (wiring.js), which
// is also what oc.store.dataset_ops / oc.collect.register_ops dispatch on — so an op offered here
// always has an implementation, and one that exists server-side is always offered.
//   dataset_actions — run on every attached DATASET target ("" = no-op; clone/move copy into
//                     `dest`, batches = keep batch grouping, resolved = collapse to one; `compact`
//                     applies each target's own keep_batches window).
//   register_ops    — run per attached REGISTER target, independent of the dataset op above (a
//                     dataset clear and a register set can coexist on one node). A register has no
//                     batch grouping, so there is no batches/resolved split here; clone/move pick
//                     EITHER a dataset or another register as `dest` (a prefixed ref — the kind is
//                     self-describing, no separate toggle), and every register's dest on this node
//                     shares one kind: picking a NEW kind clears the others.
// Thunks, not constants: the table lands at boot, after this module is evaluated.
export const ACTIONS = () => wiring.opPairs("dataset_actions");
export const ACTION_DESC = () => wiring.opDesc("dataset_actions");
export const REG_OPS = () => wiring.opPairs("register_ops");
export const REG_OP_DESC = () => wiring.opDesc("register_ops");

// a rich-dd-btn button built from [value,label] pairs, marking `val` current — mirrors optSel
// (node_parts.js); wiring (io_wire.js) has the model access to open the picker.
const richBtn = (val, opts, cls, title, dataset) =>
    h("button", { class: `${cls} rich-dd-btn`, type: "button", title: title || "", dataset },
        `<${(opts.find(([v]) => v === val) || [, val])[1]}>`);

// a "wait this long" input with its ms unit suffix — the trigger's throttle/settle shape (tg-secs),
// reused rather than restyled so every millisecond field in the graph reads the same.
const msRow = (cls, value, opts = {}) => h("span", { class: "tg-secs" },
    h("input", { class: `gi ${cls}`, type: "number", min: String(opts.min ?? 0),
        step: String(opts.step ?? 50), value }), " ms");

export function actionParts(x, model) {
    const cur = x.action || "";
    const needsDest = cur.startsWith("clone_") || cur.startsWith("move_");
    const srcs = model.actionSources(x.id);                    // [{kind,id,ref}] datasets/registers/sounds/actions
    // which rows the body shows follows what's actually attached: the shared dataset-op row for
    // DATASET targets only (a register target runs its OWN op — see regSrcs below), repeat for
    // sounds, nothing extra for a chained action (it's a chip only).
    const datasets = srcs.filter((s) => s.kind === "dataset");
    const regSrcs = srcs.filter((s) => s.kind === "register");
    const sounds = srcs.filter((s) => s.kind === "sound");
    const windows = srcs.filter((s) => s.kind === "window");
    // free options: everything the wiring table's action.sources row accepts and this node hasn't
    // wired yet — datasets, registers, sounds, other actions, and a WINDOW this action sends its
    // input_events sequence to (at most one makes sense: there's one flat send sequence per node,
    // not per-window, though nothing enforces it — a second window chip just has nowhere to send).
    // A thunk, so the list is recomputed live on open (node creation skips the consumer-rebuild
    // sweep). The one rule the table can't state: never chain into an action that reaches back here.
    const free = () => model.sourceCandidates("action", x.id)
        .filter((c) => c.kind !== "action" || !model._actionReaches(c.ref.slice("action:".length), x.id));
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
        const destLabel = dest === "" ? "- destination -" : dest.startsWith("dataset:") ? dest.slice(8) : dest.slice(9);
        return [
            labCell(s.id, `what this action does to register '${s.id}' when fired`),
            richBtn(op, REG_OPS(), "ac-regop", REG_OP_DESC()[op] || "", { reg: s.id }),
            op === "set" && regWriteRows({ regId: s.id, rows: model.actionWrites(x.id, s.id) }),
            regNeedsDest && keyRows({
                regId: s.id, keys: model.actionRegKeys(x.id, s.id),
                hint: `which of ${s.id}'s keys this copies/moves (default all) — hand-typed, register keys aren't statically known` }),
            regNeedsDest && labCell("into", `destination for '${s.id}' — a dataset, or another register`),
            regNeedsDest && h("button", { class: "ac-regdest rich-dd-btn", type: "button", dataset: { reg: s.id } },
                dest === "" ? destLabel : `<${destLabel}>`),
        ];
    });
    return {
        title: h("input", { class: "gi gi-id acrename", value: x.id, title: "rename action" }),
        body: frag(
            srcRow("targets", "datasets, registers, sounds, a window (to send input to) and actions this node operates on when fired",
                sourcesInput({
                    chips: srcs.map((s) => ({ value: s.ref, label: s.id, node: model.refNode(s.ref) })),
                    free, addLabel: "+ target", addinCls: "sv-addin ac-addsrc", rmCls: "sv-rmin ac-rmsrc" })),
            labCell("delay", "wait this long after being fired before running (0 = run now)"),
            msRow("ac-delay", x.delay_ms ?? 0),
            datasets.length > 0 && labCell("action", "what this node does to its datasets when fired"),
            datasets.length > 0 && richBtn(cur, ACTIONS(), "ac-action", ACTION_DESC()[cur] || ""),
            datasets.length > 0 && needsDest && labCell("into", "destination dataset for clone/move"),
            datasets.length > 0 && needsDest && h("button", { class: "ac-dest rich-dd-btn", type: "button" },
                x.dest ? `<${x.dest}>` : "- dataset -"),
            ...regBlocks,
            windows.length > 0 && inputRows({ rows: model.actionInputEvents(x.id) }),
            sounds.length > 0 && labCell("repeat", "how many times to play the attached sound(s)"),
            sounds.length > 0 && h("span", { class: "tg-secs" },
                h("input", { class: "gi ac-repeat", type: "number", min: "1", step: "1", value: repeat }), " plays"),
            sounds.length > 0 && repeat > 1 && labCell("every", "gap between those plays"),
            sounds.length > 0 && repeat > 1 && msRow("ac-repms", x.repeat_ms ?? 300, { min: 10, step: 10 })),
        foot: h("button", { class: "ac-fire", title: "run this action now on its targets" }, "↻ fire"),
        ports: h("span", { class: "port out", title: "drag to a dataset, register, sound, window or action this node operates on" }),
    };
}
