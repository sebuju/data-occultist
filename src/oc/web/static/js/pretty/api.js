// Pretty Studio HTTP wrappers. The design doc + transient overrides + manual record write
// live under /api/pretty; dataset/subset row reads reuse the existing /api/flow endpoints
// (the node view's tables read the same shapes). Thin on purpose — no ret[ry/timeout
// machinery beyond the browser default; Pretty is a local convenience surface.

const enc = encodeURIComponent;
const j = (r) => (r.ok ? r.json() : r.text().then((t) => Promise.reject(new Error(`${r.status} ${t}`))));
const PUT_JSON = (body) => ({ method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const POST_JSON = (body) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
// GETs are POLLED for live data — never let the browser serve a cached body (that's the
// "server has new rows but the UI shows old until reload" bug). no-store every read.
const GET = (url) => fetch(url, { cache: "no-store" });

// ---- the design document ----------------------------------------------------------
export const getPretty = (game) => GET(`/api/pretty/${enc(game)}`).then(j);
export const savePretty = (game, doc) => fetch(`/api/pretty/${enc(game)}`, PUT_JSON(doc)).then(j);

// ---- transient node-input overrides -----------------------------------------------
export const listOverrides = (game) => GET(`/api/pretty/${enc(game)}/overrides`).then(j);
export const setOverride = (game, path, value) => fetch(`/api/pretty/${enc(game)}/override`, POST_JSON({ path, value })).then(j);
export const clearOverride = (game, path) =>
    fetch(`/api/pretty/${enc(game)}/override${path ? `?path=${enc(path)}` : ""}`, { method: "DELETE" }).then(j);
export const commitOverrides = (game) => fetch(`/api/pretty/${enc(game)}/overrides/commit`, { method: "POST" }).then(j);

// ---- live data ---------------------------------------------------------------------
export const flowStatus = (game) => fetch(`/api/flow/${enc(game)}`).then(j);
export const datasetRows = (game, dataset) => fetch(`/api/flow/${enc(game)}/dataset/${enc(dataset)}`).then(j);
export const subsetRows = (game, subset) => fetch(`/api/flow/${enc(game)}/subset/${enc(subset)}`).then(j);

// ---- data entry (manual record into a dataset) ------------------------------------
export const recordRow = (game, dataset, values) =>
    fetch(`/api/pretty/${enc(game)}/dataset/${enc(dataset)}/record`, POST_JSON(values)).then(j);
