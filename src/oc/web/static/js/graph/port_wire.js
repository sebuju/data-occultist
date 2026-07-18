// A node's out-port (and a trigger's second watch-port): what dropping the dragged wire onto a
// target node type does, and what dropping it on empty canvas mints. ONE mechanism for every
// source type — each contributes a `spec` (target/onDrop/onEmpty) consumed by startWire. Split
// out of main.js; placeAt/startWire stay in main and are imported back.
import { model } from "./state.js";
import { placeAt, startWire, bareNodeId } from "./main.js";

// Drag a node's out-port to wire its data somewhere. ONE mechanism for every source type;
// each type contributes a `spec` describing what kind of node it drops onto (`target`),
// what committing the drop does (`onDrop(targetId)`), and what an empty-canvas drop mints
// (`onEmpty(worldPt) -> newNodeId`). Producers (window/price) feed a DATASET; datasets and
// subsets feed a SUBSET. `selfId` blocks dropping a node onto itself.
// onDrop/onEmpty are PURE model mutations — startWire's onUp rebuilds both the source and the
// drop-target node itself after calling these, so no spec here needs its own rebuildNode.
function outPortSpec(n) {
    switch (n.type) {
        case "window": return {
            target: "dataset",
            onDrop: (ds) => model.setDataset(n.ref.id, ds),
            onEmpty: (pt) => { const ds = model.addDataset(); placeAt(`ds:${ds}`, pt); model.setDataset(n.ref.id, ds); return `ds:${ds}`; },
        };
        case "producer": return {
            target: "dataset",
            onDrop: (ds) => model.setProducerDataset(n.ref.id, ds),
            onEmpty: (pt) => { const ds = model.addDataset(); placeAt(`ds:${ds}`, pt); model.setProducerDataset(n.ref.id, ds); return `ds:${ds}`; },
        };
        case "dataset": return {
            // a dataset feeds a SUBSET (join), a PRODUCER node (price only these items), a
            // DICTIONARY (push its column values in as terms), or a TOAST ({{dataset:id}} tokens)
            target: ["subset", "producer", "dictionary", "toast"],
            onDrop: (id, ttype) => {
                if (ttype === "producer") model.addProducerSource(id, n.ref);
                else if (ttype === "dictionary") model.addDictFeed(id, n.ref);
                else if (ttype === "toast") model.addToastSource(id, `dataset:${n.ref}`);
                else model.addSubsetInput(id, n.ref);
            },
            onEmpty: (pt) => { const id = model.addSubset(n.ref); placeAt(`sub:${id}`, pt); return `sub:${id}`; },
        };
        case "subset": return {
            // a subset feeds another SUBSET, a PRODUCER node (price the rows it returns), or a
            // TOAST ({{subset:id}} tokens)
            target: ["subset", "producer", "toast"],
            selfId: n.ref.id,
            onDrop: (id, ttype) => {
                if (ttype === "producer") model.addProducerSource(id, n.ref.id);
                else if (ttype === "toast") model.addToastSource(id, `subset:${n.ref.id}`);
                else model.addSubsetInput(id, n.ref.id);
            },
            onEmpty: (pt) => { const id = model.addSubset(n.ref.id); placeAt(`sub:${id}`, pt); return `sub:${id}`; },
        };
        case "readout": return {
            // a readout feeds a TOAST its live value as a {{readout:id}} token, a REGISTER that holds
            // its latest value in an in-memory keyed map, or a PROCESS that runs it through a rules pipeline
            target: ["toast", "register", "process"],
            onDrop: (id, ttype) => {
                const ref = `readout:${n.ref.id}`;
                if (ttype === "register") model.addRegisterSource(id, ref);
                else if (ttype === "process") model.addProcessSource(id, ref);
                else model.addToastSource(id, ref);
            },
            onEmpty: (pt) => { const id = model.addRegister(); model.addRegisterSource(id, `readout:${n.ref.id}`); placeAt(`register:${id}`, pt); return `register:${id}`; },
        };
        case "register": return {
            // a register OPTIONALLY mirrors its held map into a DATASET (RegisterDef.persist), so that
            // state becomes joinable like any other dataset (same wiring shape as window/producer ->
            // dataset). A register SLOT can feed a process, but that's a per-key pick made from the
            // process's "+ input" picker (a whole-register drag has no single key), so no process target here.
            target: "dataset",
            onDrop: (ds) => model.setRegisterPersist(n.ref.id, ds),
            onEmpty: (pt) => { const ds = model.addDataset(); placeAt(`ds:${ds}`, pt); model.setRegisterPersist(n.ref.id, ds); return `ds:${ds}`; },
        };
        case "process": return {
            // a process feeds a REGISTER (hold its re-keyed output). Its inputs are single-key
            // (readout / register slot), so nothing takes a process AS input -> no process target.
            // Empty-canvas drop mints a register holding it, mirroring readout->register.
            target: "register",
            onDrop: (id) => model.addRegisterSource(id, `process:${n.ref.id}`),
            onEmpty: (pt) => { const id = model.addRegister(); model.addRegisterSource(id, `process:${n.ref.id}`); placeAt(`register:${id}`, pt); return `register:${id}`; },
        };
        case "filesource": return {
            target: "dataset",
            onDrop: (ds) => model.setSourceDataset(n.ref.id, ds),
            onEmpty: (pt) => { const ds = model.addDataset(); placeAt(`ds:${ds}`, pt); model.setSourceDataset(n.ref.id, ds); return `ds:${ds}`; },
        };
        case "trigger": return {
            // a trigger fires a PRODUCER (sweep), FILE SOURCE (read), TOAST (notify), SOUND (play), or ACTION (dataset op)
            target: ["producer", "filesource", "toast", "sound", "action"],
            onDrop: (pid) => model.addTriggerTarget(n.ref.id, pid),
        };
        case "action": return {
            // an action node operates on the DATASET(s) and REGISTER(s) it's wired to
            target: ["dataset", "register"],
            onDrop: (id, ttype) => model.addActionSource(n.ref.id, `${ttype}:${id}`),
        };
        default: return null;
    }
}

// The trigger's SECOND out-port (`.port.pwatch`, left face): drag to a dataset/view to make an
// on_change trigger watch it. Separate from the fires port so the two control lines never share a dot.
function watchPortSpec(n) {
    if (n.type !== "trigger") return null;
    if (n.ref.kind === "on_change" || n.ref.kind === "on_any_change") return {
        side: "L",
        target: ["dataset", "subset"],
        onDrop: (id) => model.addTriggerWatch(n.ref.id, id),
    };
    if (n.ref.kind === "on_new_batch") return {
        side: "L",
        target: ["dataset", "subset"],   // a subset watch fires on its underlying dataset's batch
        onDrop: (id) => model.addTriggerWatch(n.ref.id, id),
    };
    if (n.ref.kind === "on_ready") return {
        side: "L",
        target: ["producer"],   // on_ready fires when the watched producer's sweep finishes
        onDrop: (id) => model.addTriggerWatch(n.ref.id, id),
    };
    if (n.ref.kind === "on_readout") return {
        side: "L",
        target: ["readout"],
        // the dropped id is the readout NODE id (ro:<win>:<vid>) — the watch stores the bare vid
        onDrop: (id) => model.addTriggerReadoutWatch(n.ref.id, String(id).split(":").pop()),
    };
    if (n.ref.kind === "on_register") return {
        side: "L",
        target: ["register"],   // watch a register; a key sub-select narrows which keys fire
        onDrop: (id) => model.addTriggerRegisterWatch(n.ref.id, id),
    };
    return null;
}

export function wireOutPort(div, n) {
    div._outId = n.id;
    const spec = outPortSpec(n);
    if (spec) { div._outSpec = spec; wirePortHandle(div.querySelector(".port.out"), n.id, spec); }   // reused by placePortDots
    const wspec = watchPortSpec(n);
    if (wspec) { div._watchSpec = wspec; wirePortHandle(div.querySelector(".port.pwatch"), n.id, wspec); }
}
function wirePortHandle(port, id, spec) {
    if (port) port.addEventListener("mousedown", (ev) => startWire(id, ev, spec));
}

// the source id a drop target commits to: a dataset node's name, or a node's bare id
// (every other target carries a prefixed node id in data-id). bareNodeId strips the prefix via
// the master _TYPE_BY_PREFIX map, so a new drop-target type never needs a hand-edited strip list.
export function targetIdOf(el, target) {
    return target === "dataset" ? el.dataset.ds : bareNodeId(el.dataset.id || "");
}
