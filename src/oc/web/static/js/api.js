// Thin wrapper around the backend HTTP API.

// Every request gets a DEADLINE: a wedged server (e.g. a dead --reload worker whose
// parent still holds the port) leaves connections hanging forever instead of refusing
// them — without a timeout the whole UI just silently stalls. Light endpoints fail
// fast; OCR endpoints get longer since they queue behind the one GPU lock.
const LIGHT_MS = 30_000;
const OCR_MS = 60_000;
function tfetch(url, opts = {}, ms = LIGHT_MS) {
  const deadline = AbortSignal.timeout(ms);
  const signal = opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline;
  return fetch(url, { ...opts, signal }).catch((e) => {
    if (e.name === "TimeoutError")
      throw new Error(`${url.split("?")[0]} timed out after ${ms / 1000}s — server hung or restarting?`);
    throw e;
  });
}

// Throw on a non-OK response, but first dump the server's FULL error (the backend now
// returns the real traceback) to the browser console so a 500 isn't opaque.
async function ok(r, label) {
  if (r.ok) return r;
  let body = "";
  try { body = await r.text(); } catch { /* ignore */ }
  let detail = body;
  try { const j = JSON.parse(body); detail = j.detail || body; if (j.traceback) body = j.traceback; } catch { /* not json */ }
  console.error(`[api] ${label} -> ${r.status}\n${body}`);
  throw new Error(`${label}: ${r.status} ${detail}`);
}

export async function listProfiles() {
  const r = await tfetch("/api/profiles");
  return r.json();
}

export async function getProfile(name) {
  const r = await tfetch(`/api/profiles/${encodeURIComponent(name)}`);
  if (!r.ok) throw new Error(`load ${name}: ${r.status}`);
  return r.json();
}

// merge=true upserts windows (teach page, single window); merge=false replaces the
// whole profile (graph editor, which holds the complete picture) so deletes persist.
export async function saveProfile(profile, merge = true) {
  const r = await tfetch(`/api/profiles/${encodeURIComponent(profile.name)}?merge=${merge}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(profile),
  });
  if (!r.ok) throw new Error(`save: ${r.status} ${await r.text()}`);
  return r.json();
}

// Per-device graph viewport (zoom/pan + minimap), a gitignored sidecar — NOT part of
// the profile. Node layout itself lives in the profile. Used only by persist.js.
export const graphLocal = {
  get: (name) => tfetch(`/api/profiles/${encodeURIComponent(name)}/graphlocal`).then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
  put: (name, state) => tfetch(`/api/profiles/${encodeURIComponent(name)}/graphlocal`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state),
  }).then((r) => r.json()).catch(() => {}),
};

// Versioned profile backups: list snapshots (meta only), fetch one's full profile,
// or restore one (which re-saves it live and snapshots the current state first).
export const backups = {
  list: (name) => tfetch(`/api/profiles/${encodeURIComponent(name)}/backups`).then((r) => (r.ok ? r.json() : [])),
  get: (name, stamp) => tfetch(`/api/profiles/${encodeURIComponent(name)}/backups/${encodeURIComponent(stamp)}`).then((r) => ok(r, "backup").then((x) => x.json())),
  restore: (name, stamp) => tfetch(`/api/profiles/${encodeURIComponent(name)}/backups/${encodeURIComponent(stamp)}/restore`, { method: "POST" }).then((r) => ok(r, "restore").then((x) => x.json())),
};

// OCR the current layout. Pass game+capture to read that stashed image (the one
// shown in the image node) instead of capturing the live window.
export async function preview(profile, game, capture) {
  let url = "/api/preview";
  if (game && capture) url += `?game=${encodeURIComponent(game)}&capture=${encodeURIComponent(capture)}`;
  const r = await tfetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(profile),
  }, OCR_MS);
  if (!r.ok) throw new Error(`preview: ${r.status} ${await r.text()}`);
  return r.json();
}

// Returns { url, width, height, name }. stash=false skips saving (live view).
export async function capture(game, stash = true) {
  const r = await tfetch(`/api/capture?game=${encodeURIComponent(game)}&stash=${stash}`, {}, OCR_MS);
  if (!r.ok) throw new Error(`capture: ${r.status} ${await r.text()}`);
  const width = Number(r.headers.get("X-Client-Width"));
  const height = Number(r.headers.get("X-Client-Height"));
  const name = r.headers.get("X-Capture-Name");
  const blob = await r.blob();
  return { url: URL.createObjectURL(blob), width, height, name };
}

// Analyse the live window and suggest a reading layout. Pass a search box
// (fractions) to focus on the item area; omit to scan the whole window.
export async function suggest(game, search) {
  let url = `/api/suggest?game=${encodeURIComponent(game)}`;
  if (search) url += `&sx=${search.x}&sy=${search.y}&sw=${search.w}&sh=${search.h}`;
  const r = await tfetch(url, {}, OCR_MS);
  if (!r.ok) throw new Error(`suggest: ${r.status} ${await r.text()}`);
  return r.json();
}

// Evaluate detectors/states against the image: { detect:{id:{matched,read}}, states:{...} }.
export async function detect(profile, game, capture) {
  let url = "/api/detect";
  if (game && capture) url += `?game=${encodeURIComponent(game)}&capture=${encodeURIComponent(capture)}`;
  const r = await tfetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(profile) }, OCR_MS);
  if (!r.ok) throw new Error(`detect: ${r.status}`);
  return r.json();
}

// Stashed captures for a game (newest first), and the URL to load one.
export async function listCaptures(game) {
  const r = await tfetch(`/api/captures/${encodeURIComponent(game)}`);
  return r.ok ? r.json() : [];
}
export function captureUrl(game, name) {
  return `/api/captures/${encodeURIComponent(game)}/${encodeURIComponent(name)}`;
}

// Freeze an item cell from a stashed capture -> { name, url }. box is fractions.
export async function itemCutout(game, capture, box) {
  const q = `game=${encodeURIComponent(game)}&capture=${encodeURIComponent(capture)}&x=${box.x}&y=${box.y}&w=${box.w}&h=${box.h}`;
  const r = await tfetch(`/api/item/cutout?${q}`, { method: "POST" });
  if (!r.ok) throw new Error(`cutout: ${r.status} ${await r.text()}`);
  return r.json();
}
export function cutoutUrl(game, name) {
  return `/api/item/cutout/${encodeURIComponent(game)}/${encodeURIComponent(name)}`;
}

// Read one item's frozen cutout with the current settings -> { cutout:[w,h],
// fields:{id:{raw,value,confidence,substituted,box}}, tells:[...], valid, cell }.
export async function itemRead(profile, game, win, item) {
  const q = `game=${encodeURIComponent(game)}&win=${encodeURIComponent(win)}&item=${encodeURIComponent(item)}`;
  const r = await tfetch(`/api/item/read?${q}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(profile),
  }, OCR_MS);
  if (!r.ok) throw new Error(`item read: ${r.status} ${await r.text()}`);
  return r.json();
}

// OCR device (cpu/gpu). Returns { device, gpu_available }.
export const ocr = {
  getDevice: () => tfetch("/api/ocr/device").then((r) => r.json()),
  setDevice: (device) => tfetch(`/api/ocr/device?device=${encodeURIComponent(device)}`, { method: "POST" }).then((r) => r.json()),
  setScale: (n) => tfetch(`/api/ocr/scale?scale=${encodeURIComponent(n)}`, { method: "POST" }).then((r) => r.json()),
};

// Precapture: record frames fast, batch-OCR them, then save. Each call returns the
// session status { phase, frames, processed, fps, error, datasets:[{dataset,count,sample}] }.
const _pre = (game, path, signal, method = "POST", ms) =>
  tfetch(`/api/precapture/${encodeURIComponent(game)}/${path}`, { method, signal }, ms).then((r) => r.json());
export const precapture = {
  recordStart: (game, maxFrames, intervalMs, label, autoscroll, clicks, signal) => _pre(game, `record/start?max_frames=${maxFrames}&interval_ms=${intervalMs}&label=${encodeURIComponent(label || "")}&autoscroll=${autoscroll ? 1 : 0}&clicks=${clicks || 1}`, signal),
  recordStop: (game, signal) => _pre(game, "record/stop", signal),
  setAutoscroll: (game, on, clicks, signal) => _pre(game, `record/autoscroll?on=${on ? 1 : 0}${clicks != null ? `&clicks=${clicks}` : ""}`, signal),
  processStart: (game, signal) => _pre(game, "process/start", signal),
  pause: (game, on, signal) => _pre(game, `process/pause?on=${on}`, signal),
  cancel: (game, signal) => _pre(game, "cancel", signal),
  killAll: () => tfetch("/api/precapture/kill-all", { method: "POST" }, 15_000).then((r) => r.json()),   // server waits up to 5s per worker
  reset: (game, signal) => _pre(game, "reset", signal),
  save: (game, signal) => _pre(game, "save", signal, "POST", 180_000),   // commit can be slow; allow 3 min
  status: (game, signal) => tfetch(`/api/precapture/${encodeURIComponent(game)}/status`, { signal }).then((r) => r.json()),
  // saved recording sessions: list / load / rename / delete. Each returns { sessions, status }.
  sessions: (game, signal) => _pre(game, "sessions", signal, "GET"),
  loadSession: (game, sid, signal) => _pre(game, `sessions/${encodeURIComponent(sid)}/load`, signal),
  renameSession: (game, sid, label, signal) => _pre(game, `sessions/${encodeURIComponent(sid)}/rename?label=${encodeURIComponent(label || "")}`, signal),
  deleteSession: (game, sid, signal) => _pre(game, `sessions/${encodeURIComponent(sid)}`, signal, "DELETE"),
};

// Wipe a dataset's stored records + ledger.
export async function clearDataset(game, dataset) {
  const r = await tfetch(`/api/flow/${encodeURIComponent(game)}/dataset/${encodeURIComponent(dataset)}/clear`, { method: "POST" });
  if (!r.ok) throw new Error(`clear: ${r.status} ${await r.text()}`);
  return r.json();
}

// Permanently delete a dataset's stored files, so removing its node doesn't leave the
// dataset re-spawning from disk on the next live refresh.
export async function deleteDataset(game, dataset) {
  const r = await tfetch(`/api/flow/${encodeURIComponent(game)}/dataset/${encodeURIComponent(dataset)}/delete`, { method: "POST" });
  if (!r.ok) throw new Error(`delete: ${r.status} ${await r.text()}`);
  return r.json();
}

// Move a dataset's stored records to a new name (so a profile rename doesn't orphan
// the old data and re-spawn it in the graph). 409 if the target name already has data.
export async function renameDataset(game, dataset, to) {
  const r = await tfetch(`/api/flow/${encodeURIComponent(game)}/dataset/${encodeURIComponent(dataset)}/rename?to=${encodeURIComponent(to)}`, { method: "POST" });
  if (!r.ok) throw new Error(`rename: ${r.status} ${await r.text()}`);
  return r.json();
}

// Revert (on=true) or restore (on=false) a whole dataset batch. Returns refreshed
// { records, batches }.
export async function revertDatasetBatch(game, dataset, batch, on = true) {
  const r = await tfetch(`/api/flow/${encodeURIComponent(game)}/dataset/${encodeURIComponent(dataset)}/revert?batch=${batch}&on=${on}`, { method: "POST" });
  if (!r.ok) throw new Error(`revert: ${r.status} ${await r.text()}`);
  return r.json();
}

// Permanently delete one batch from a dataset's ledger.
export async function removeDatasetBatch(game, dataset, batch) {
  const r = await tfetch(`/api/flow/${encodeURIComponent(game)}/dataset/${encodeURIComponent(dataset)}/remove-batch?batch=${batch}`, { method: "POST" });
  if (!r.ok) throw new Error(`remove: ${r.status} ${await r.text()}`);
  return r.json();
}

// One batch: its events + a preview of what applying it changes. Returns
// { dataset, batch, events:[...], preview:[...], batches:[...] }.
const _dsUrl = (game, dataset) => `/api/flow/${encodeURIComponent(game)}/dataset/${encodeURIComponent(dataset)}`;
export async function batchDetail(game, dataset, batch) {
  const r = await tfetch(`${_dsUrl(game, dataset)}/batch/${batch}`);
  if (!r.ok) throw new Error(`batch: ${r.status} ${await r.text()}`);
  return r.json();
}
async function _evt(game, dataset, batch, eventId, path, extra = "", body) {
  const opt = { method: "POST" };
  if (body !== undefined) { opt.headers = { "Content-Type": "application/json" }; opt.body = JSON.stringify(body); }
  const r = await tfetch(`${_dsUrl(game, dataset)}/event/${eventId}/${path}?batch=${batch}${extra}`, opt);
  if (!r.ok) throw new Error(`event ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}
export const revertDatasetEvent = (game, dataset, batch, eventId, on = true) =>
  _evt(game, dataset, batch, eventId, "revert", `&on=${on}`);
export const editDatasetEvent = (game, dataset, batch, eventId, values) =>
  _evt(game, dataset, batch, eventId, "edit", "", values);
export const removeDatasetEvent = (game, dataset, batch, eventId) =>
  _evt(game, dataset, batch, eventId, "remove");

// Prices: warframe.market price history / portfolio for a dataset, plus the throttled
// background sweep. Reads come straight off the stored price file; refresh drives the
// sweep and status polls its progress.
const _pg = (game) => encodeURIComponent(game);
export const prices = {
  summary: (game, dataset) => tfetch(`/api/prices/${_pg(game)}/summary?dataset=${encodeURIComponent(dataset)}`).then((r) => ok(r, "price summary").then((x) => x.json())),
  portfolio: (game, dataset) => tfetch(`/api/prices/${_pg(game)}/portfolio?dataset=${encodeURIComponent(dataset)}`).then((r) => ok(r, "portfolio").then((x) => x.json())),
  item: (game, slug) => tfetch(`/api/prices/${_pg(game)}/item/${encodeURIComponent(slug)}`).then((r) => ok(r, "price item").then((x) => x.json())),
  movers: (game, days = 7, threshold = 0.15) => tfetch(`/api/prices/${_pg(game)}/movers?days=${days}&threshold=${threshold}`).then((r) => ok(r, "movers").then((x) => x.json())),
  refresh: (game, dataset) => tfetch(`/api/prices/${_pg(game)}/refresh?dataset=${encodeURIComponent(dataset)}`, { method: "POST" }, 30_000).then((r) => ok(r, "price refresh").then((x) => x.json())),
  cancel: (game) => tfetch(`/api/prices/${_pg(game)}/cancel`, { method: "POST" }).then((r) => r.json()),
  status: (game) => tfetch(`/api/prices/${_pg(game)}/status`).then((r) => r.json()),
};

// Dictionaries: the shared term files under config/dictionaries/. The picker lists
// what's available (source + word count); get() fetches one file's terms so a newly
// referenced dictionary node shows them at once.
export const dictionaries = {
  list: () => tfetch("/api/dictionaries").then((r) => (r.ok ? r.json() : [])),
  get: (source) => tfetch(`/api/dictionaries/${encodeURIComponent(source)}`).then((r) => ok(r, "dictionary").then((x) => x.json())),
};

// Views: outer-join the source datasets on the shared key, then filter/derive/sort.
// Returns { subset, datasets, columns, rows }.
export async function getSubset(game, subset) {
  const r = await tfetch(`/api/flow/${encodeURIComponent(game)}/subset/${encodeURIComponent(subset)}`);
  if (!r.ok) throw new Error(`subset: ${r.status} ${await r.text()}`);
  return r.json();
}

// Per-window stash bindings: which capture a window opens with. The whole map is fetched
// then indexed per window by many callers (image open, preview, detect, …), so on a graph
// load several windows would each refetch the identical map. Cache the in-flight promise
// per game — concurrent boot reads share one request, later reads reuse it — and drop it
// only when a bind mutates it (the sole writer). A failed fetch isn't cached.
const _bindingsCache = new Map();   // game -> Promise<{window_id: capture_name}>
export function getBindings(game) {
  let p = _bindingsCache.get(game);
  if (!p) {
    p = tfetch(`/api/captures/${encodeURIComponent(game)}/bindings`)
      .then((r) => (r.ok ? r.json() : {}))
      .catch((e) => { _bindingsCache.delete(game); throw e; });
    _bindingsCache.set(game, p);
  }
  return p;
}
export function invalidateBindings(game) {
  if (game === undefined) _bindingsCache.clear(); else _bindingsCache.delete(game);
}
export async function bindCapture(game, window, name) {
  await tfetch(`/api/captures/${encodeURIComponent(game)}/bind?window=${encodeURIComponent(window)}&name=${encodeURIComponent(name)}`, { method: "POST" });
  invalidateBindings(game);   // next read re-fetches the updated map
}
