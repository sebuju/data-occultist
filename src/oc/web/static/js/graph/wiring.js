// The server's wiring table (oc/profile/wiring.py), fetched once at boot and queried from here.
// It is the ONE answer to "what may connect to what": the boot checker validates against these
// exact rows, so a picker or a port-drop that derives from them can't offer a pairing the checker
// rejects — the drift this table replaced had every window-bound action node reported as broken.
//
// Nothing here touches the DOM or the model; it's pure lookup over the fetched rows. Consumers:
// model.sourceCandidates / _gateable / _refModel (pickers + rename registry), port_wire
// (out-port and watch-port drop targets), main.js (_TYPE_BY_PREFIX).
let TABLE = { kinds: [], links: [], facets: [], vocab: {}, aliases: {} };
let BY_NAME = new Map();
let PREFIX_TYPES = {};

// Install the fetched table. Called once, before the first game load (graph_boot.js).
export function setWiring(data) {
    TABLE = { kinds: data?.kinds || [], links: data?.links || [], facets: data?.facets || [],
        vocab: data?.vocab || {}, aliases: data?.aliases || {} };
    BY_NAME = new Map(TABLE.kinds.map((k) => [k.name, k]));
    PREFIX_TYPES = {};
    for (const k of TABLE.kinds) if (k.node_prefix) PREFIX_TYPES[k.node_prefix] = k.node_type;
}
export function kinds() { return TABLE.kinds; }
export function kind(name) { return BY_NAME.get(name) || null; }
export function links() { return TABLE.links; }
export function facets() { return TABLE.facets; }
// A kind name -> the front-end node type (`.gnode.<type>`); "file_source" -> "filesource".
export function nodeType(name) { return BY_NAME.get(name)?.node_type || name; }

// The one row for a field. `field` defaults to the node's own "sources" list, which is what
// every prefixed-source consumer (register/process/toast/action) stores its wiring in.
export function linkFor(owner, field = "sources") {
    return TABLE.links.find((l) => l.owner === owner && l.field === field) || null;
}
// The rows a node type owns (its body pickers + its out-port).
export function linksOf(owner) { return TABLE.links.filter((l) => l.owner === owner); }

// The kinds a consumer's "+ add" list offers for one field — narrower than what's LEGAL when the
// model accepts a form no picker mints (a register may source another register; only readouts and
// processes are listed). -> [] when nothing is wireable there.
export function pickerKinds(owner, field = "sources") {
    return linkFor(owner, field)?.picker || [];
}

// Out-port drop targets for a node of type `type`: the node TYPES a wire dragged from it may land
// on. Both directions exist in the graph and the table says which end owns the port — an action's
// port drops onto the dataset it operates on (`port: "owner"`), a dataset's port drops onto the
// subset that joins it (`port: "ref"`) — so this walks the rows rather than inverting blindly.
export function dropTargets(type) {
    const out = [];
    const add = (t) => { if (t && !out.includes(t)) out.push(t); };
    for (const l of TABLE.links) {
        if (l.port === "owner" && nodeType(l.owner) === type) l.ports.forEach((k) => add(nodeType(k)));
        else if (l.port === "ref" && l.ports.some((k) => nodeType(k) === type)) add(nodeType(l.owner));
    }
    return out;
}

// The watch-port row for a trigger of this kind (a trigger's SECOND port watches a dataset /
// producer / readout / register / window depending on its kind), or null when that kind has no
// watch port. `port_when` lists the kinds that show it.
export function watchLink(triggerKind) {
    return TABLE.links.find((l) => l.port === "watch" && l.port_when.includes(triggerKind)) || null;
}

// Graph node-id prefix -> node type, for every kind the profile declares ("ds" -> "dataset").
// Built once in setWiring (nodeTypeOf/bareNodeId are hot paths — don't rebuild per call). The
// view-only prefixes (previews, history tables, regions, items) have no profile row and stay
// hand-listed where they're used.
export function prefixTypes() { return PREFIX_TYPES; }

// ---- op vocabularies (dataset/register ops, trigger kinds, gate + filter ops) ----------------
// Closed value sets whose Python evaluator and UI picker must agree. Each entry is
// {id, label, desc, group, no_arg}; the pickers build their [value,label] pairs, meta lines and
// group headers from these, so a value can't be offered that nothing implements (or implemented
// and never offered — `no_digit`/`no_letter` were exactly that before the fold).
export function ops(vocab) { return TABLE.vocab[vocab] || []; }
export function opIds(vocab) { return ops(vocab).map((o) => o.id); }
// [value, label] pairs — the shape the rich pickers and richBtn take.
export function opPairs(vocab) { return ops(vocab).map((o) => [o.id, o.label]); }
// {id: desc} — the picker's per-option meta line.
export function opDesc(vocab) { return Object.fromEntries(ops(vocab).map((o) => [o.id, o.desc])); }
// [[group, [[value, label], ...]], ...] — grouped in table order, for the grouped rich picker.
export function opGroups(vocab) {
    const out = [];
    for (const o of ops(vocab)) {
        const g = out.find(([name]) => name === o.group);
        if (g) g[1].push([o.id, o.label]);
        else out.push([o.group, [[o.id, o.label]]]);
    }
    return out;
}
// The values of one group ("window" trigger kinds, the `no_arg` gate ops, ...).
export function opsInGroup(vocab, group) { return ops(vocab).filter((o) => o.group === group).map((o) => o.id); }
// Old values still found in saved profiles -> their replacement (normalized on load).
export function aliases(vocab) { return TABLE.aliases[vocab] || {}; }
