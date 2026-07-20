// Which inputs can be fed into a given graph node — the pure resolver behind the testing
// inspector (panels/inspector.js renders what this returns).
//
// A node is rarely fed directly: a gate tests a readout, a subset joins datasets, a trigger
// watches either. So this walks a node UPSTREAM to the two things a test can actually inject:
//   • readouts — ephemeral live scalars (LiveSession.feed_readouts)
//   • datasets — persistent rows (the manual-record endpoint)
// DOM-free and model-driven (takes the GraphModel in), so it runs headless under Node — see
// tests/e2e/feed-targets.mjs.

// Grid-side nodes read CELLS, not a live scalar — they have no readout to inject, so they
// resolve to their window's output dataset (write a row instead).
export const GRID_SIDE = new Set(["region", "detect", "item", "itemfield", "itemtell", "scrollbar", "preview"]);

export const TYPE_LABEL = {
    window: "window", readout: "readout", gate: "gate", router: "router", trigger: "trigger",
    register: "register", process: "process", toast: "toast", dataset: "dataset", subset: "subset",
    producer: "producer", filesource: "file source", action: "action", sound: "sound",
    region: "region", detect: "detector", item: "item", itemfield: "item field",
    itemtell: "item tell", scrollbar: "scrollbar",
};

const MAX_DEPTH = 5;

// Refs come in two shapes across the model: PREFIXED ("readout:ro_1", "register:r1#key") on
// register/process/toast/gate/router source lists, and BARE ids on subset joins, producer
// sources and trigger watches. walkRef handles the first, walkBare the second (subset before
// dataset — the same precedence model.refNode uses).
function walkBare(model, id, acc, seen, depth) {
    if (!id) return;
    if (model.subsetDef(id)) walk(model, "subset", id, acc, seen, depth);
    else walk(model, "dataset", id, acc, seen, depth);
}

function walkRef(model, ref, acc, seen, depth) {
    if (!ref) return;
    const i = ref.indexOf(":");
    if (i < 0) return walkBare(model, ref, acc, seen, depth);
    const kind = ref.slice(0, i);
    let id = ref.slice(i + 1);
    if (kind === "register") id = id.split("#")[0];   // register:<id>#<key>[@facet] -> the register
    walk(model, kind, id, acc, seen, depth);
}

function walk(model, type, id, acc, seen, depth = 0) {
    if (depth > MAX_DEPTH || !id) return;
    const k = `${type}:${id}`;
    if (seen.has(k)) return;   // a diamond in the wiring must not duplicate rows (or loop forever)
    seen.add(k);
    if (type === "readout") {
        const site = model.readoutSite(id);
        if (site) acc.ro.push({ id, win: site.win, field: model.readoutFieldOf(site.win, id) });
    } else if (type === "window") {
        const w = model.window(id);
        if (!w) return;
        // a window feeds BOTH ways: its readouts (live scalars) and its grid rows (the dataset)
        for (const v of (w.readouts || [])) if (v.enabled !== false) acc.ro.push({ id: v.id, win: w.id, field: model.readoutField(w, v) });
        const ds = model.datasetOf(w);
        if (ds) acc.ds.push(ds);
    } else if (type === "dataset") {
        acc.ds.push(id);
    } else if (type === "subset") {
        for (const src of model.subsetInputs(model.subsetDef(id))) walkBare(model, src, acc, seen, depth + 1);
    } else if (type === "gate") {
        walkRef(model, model.gateNode(id)?.source, acc, seen, depth + 1);
    } else if (type === "router") {
        walkRef(model, model.routerNode(id)?.source, acc, seen, depth + 1);
    } else if (type === "register") {
        for (const s of model.registerSources(id)) walkRef(model, s.ref, acc, seen, depth + 1);
    } else if (type === "process") {
        for (const s of model.processSources(id)) walkRef(model, s.ref, acc, seen, depth + 1);
    } else if (type === "toast") {
        for (const s of model.toastSources(id)) walkRef(model, s.ref, acc, seen, depth + 1);
    } else if (type === "producer") {
        for (const src of (model.producerNode(id)?.sources || [])) walkBare(model, src, acc, seen, depth + 1);
    } else if (type === "filesource") {
        const s = model.fileSource(id);
        if (s?.dataset) acc.ds.push(s.dataset);
    } else if (type === "trigger") {
        const t = model.trigger(id);
        for (const v of (t?.readout_watch || [])) walk(model, "readout", v, acc, seen, depth + 1);
        for (const w of (t?.watch || [])) walkBare(model, w, acc, seen, depth + 1);
        for (const r of (t?.register_watch || [])) walk(model, "register", r, acc, seen, depth + 1);
    }
}

// Resolve one graph node (a `model.nodes()` entry) to what can be fed into it.
// -> { label, tip, ro: [{id, win, field}], ds: [datasetId] }
export function resolveFeeds(model, n) {
    if (!n) return { label: "", tip: "", ro: [], ds: [] };
    const acc = { ro: [], ds: [] };
    const bare = typeof n.ref === "string" ? n.ref : n.ref?.id;
    if (GRID_SIDE.has(n.type) && n.win) {
        const ds = model.datasetOf(n.win);
        if (ds) acc.ds.push(ds);
    } else {
        walk(model, n.type, bare, acc, new Set());
    }
    // dedupe — a diamond upstream can reach the same readout/dataset by two paths
    const ro = [...new Map(acc.ro.map((r) => [r.id, r])).values()];
    const ds = [...new Set(acc.ds)];
    return { label: `${TYPE_LABEL[n.type] || n.type}: ${bare}`, tip: tipFor(n, ro), ro, ds };
}

function tipFor(n, ro) {
    let tip = "";
    if (n.type === "gate" && (n.ref.conds || []).length) {
        const joiner = (n.ref.logic || "or") === "and" ? " and " : " or ";
        tip = `passes when ${n.ref.conds.map((c) => `${c.when}${c.arg ? " " + c.arg : ""}`).join(joiner)}`;
    } else if (n.type === "router") {
        tip = "first matching branch fires its targets";
    } else if (n.type === "trigger") {
        tip = `kind: ${n.ref.kind || "?"}`;
    } else if (GRID_SIDE.has(n.type)) {
        tip = "reads cells, not a live scalar — writes a row into its window's dataset";
    }
    // an upstream walk (not the node's own readouts) is worth calling out — you're feeding its source
    if (ro.length && n.type !== "window" && n.type !== "readout") {
        tip += `${tip ? " · " : ""}feeds upstream readout${ro.length === 1 ? "" : "s"}`;
    }
    return tip;
}
