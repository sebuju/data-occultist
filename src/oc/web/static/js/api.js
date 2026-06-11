// Thin wrapper around the backend HTTP API.

export async function listProfiles() {
  const r = await fetch("/api/profiles");
  return r.json();
}

export async function getProfile(name) {
  const r = await fetch(`/api/profiles/${encodeURIComponent(name)}`);
  if (!r.ok) throw new Error(`load ${name}: ${r.status}`);
  return r.json();
}

// merge=true upserts windows (teach page, single window); merge=false replaces the
// whole profile (graph editor, which holds the complete picture) so deletes persist.
export async function saveProfile(profile, merge = true) {
  const r = await fetch(`/api/profiles/${encodeURIComponent(profile.name)}?merge=${merge}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(profile),
  });
  if (!r.ok) throw new Error(`save: ${r.status} ${await r.text()}`);
  return r.json();
}

// OCR the current layout. Pass game+capture to read that stashed image (the one
// shown in the image node) instead of capturing the live window.
export async function preview(profile, game, capture) {
  let url = "/api/preview";
  if (game && capture) url += `?game=${encodeURIComponent(game)}&capture=${encodeURIComponent(capture)}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(profile),
  });
  if (!r.ok) throw new Error(`preview: ${r.status} ${await r.text()}`);
  return r.json();
}

// Returns { url, width, height, name }. stash=false skips saving (live view).
export async function capture(game, stash = true) {
  const r = await fetch(`/api/capture?game=${encodeURIComponent(game)}&stash=${stash}`);
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
  const r = await fetch(url);
  if (!r.ok) throw new Error(`suggest: ${r.status} ${await r.text()}`);
  return r.json();
}

// Evaluate detectors/states against the image: { anchors:{id:{matched,read}}, states:{...} }.
export async function detect(profile, game, capture) {
  let url = "/api/detect";
  if (game && capture) url += `?game=${encodeURIComponent(game)}&capture=${encodeURIComponent(capture)}`;
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(profile) });
  if (!r.ok) throw new Error(`detect: ${r.status}`);
  return r.json();
}

// Stashed captures for a game (newest first), and the URL to load one.
export async function listCaptures(game) {
  const r = await fetch(`/api/captures/${encodeURIComponent(game)}`);
  return r.ok ? r.json() : [];
}
export function captureUrl(game, name) {
  return `/api/captures/${encodeURIComponent(game)}/${encodeURIComponent(name)}`;
}

// Freeze an item cell from a stashed capture -> { name, url }. box is fractions.
export async function itemCutout(game, capture, box) {
  const q = `game=${encodeURIComponent(game)}&capture=${encodeURIComponent(capture)}&x=${box.x}&y=${box.y}&w=${box.w}&h=${box.h}`;
  const r = await fetch(`/api/item/cutout?${q}`, { method: "POST" });
  if (!r.ok) throw new Error(`cutout: ${r.status} ${await r.text()}`);
  return r.json();
}
export function cutoutUrl(game, name) {
  return `/api/item/cutout/${encodeURIComponent(game)}/${encodeURIComponent(name)}`;
}

// OCR device (cpu/gpu). Returns { device, gpu_available }.
export const ocr = {
  getDevice: () => fetch("/api/ocr/device").then((r) => r.json()),
  setDevice: (device) => fetch(`/api/ocr/device?device=${encodeURIComponent(device)}`, { method: "POST" }).then((r) => r.json()),
};

// Precapture: record frames fast, batch-OCR them, then save. Each call returns the
// session status { phase, frames, processed, fps, error, datasets:[{dataset,key_field,count,sample}] }.
const _pre = (game, path, signal, method = "POST") =>
  fetch(`/api/precapture/${encodeURIComponent(game)}/${path}`, { method, signal }).then((r) => r.json());
export const precapture = {
  recordStart: (game, maxFrames, intervalMs, signal) => _pre(game, `record/start?max_frames=${maxFrames}&interval_ms=${intervalMs}`, signal),
  recordStop: (game, signal) => _pre(game, "record/stop", signal),
  processStart: (game, signal) => _pre(game, "process/start", signal),
  pause: (game, on, signal) => _pre(game, `process/pause?on=${on}`, signal),
  cancel: (game, signal) => _pre(game, "cancel", signal),
  killAll: () => fetch("/api/precapture/kill-all", { method: "POST" }).then((r) => r.json()),
  reset: (game, signal) => _pre(game, "reset", signal),
  save: (game, signal) => _pre(game, "save", signal),
  status: (game, signal) => fetch(`/api/precapture/${encodeURIComponent(game)}/status`, { signal }).then((r) => r.json()),
};

// Wipe a dataset's stored records + ledger.
export async function clearDataset(game, dataset) {
  const r = await fetch(`/api/flow/${encodeURIComponent(game)}/dataset/${encodeURIComponent(dataset)}/clear`, { method: "POST" });
  if (!r.ok) throw new Error(`clear: ${r.status} ${await r.text()}`);
  return r.json();
}

// Revert (on=true) or restore (on=false) a whole dataset batch. Returns refreshed
// { records, batches }.
export async function revertDatasetBatch(game, dataset, batch, on = true) {
  const r = await fetch(`/api/flow/${encodeURIComponent(game)}/dataset/${encodeURIComponent(dataset)}/revert?batch=${batch}&on=${on}`, { method: "POST" });
  if (!r.ok) throw new Error(`revert: ${r.status} ${await r.text()}`);
  return r.json();
}

// Permanently delete one batch from a dataset's ledger.
export async function removeDatasetBatch(game, dataset, batch) {
  const r = await fetch(`/api/flow/${encodeURIComponent(game)}/dataset/${encodeURIComponent(dataset)}/remove-batch?batch=${batch}`, { method: "POST" });
  if (!r.ok) throw new Error(`remove: ${r.status} ${await r.text()}`);
  return r.json();
}

// One batch: its events + a preview of what applying it changes. Returns
// { dataset, batch, events:[...], preview:[...], batches:[...] }.
const _dsUrl = (game, dataset) => `/api/flow/${encodeURIComponent(game)}/dataset/${encodeURIComponent(dataset)}`;
export async function batchDetail(game, dataset, batch) {
  const r = await fetch(`${_dsUrl(game, dataset)}/batch/${batch}`);
  if (!r.ok) throw new Error(`batch: ${r.status} ${await r.text()}`);
  return r.json();
}
async function _evt(game, dataset, batch, eventId, path, extra = "", body) {
  const opt = { method: "POST" };
  if (body !== undefined) { opt.headers = { "Content-Type": "application/json" }; opt.body = JSON.stringify(body); }
  const r = await fetch(`${_dsUrl(game, dataset)}/event/${eventId}/${path}?batch=${batch}${extra}`, opt);
  if (!r.ok) throw new Error(`event ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}
export const revertDatasetEvent = (game, dataset, batch, eventId, on = true) =>
  _evt(game, dataset, batch, eventId, "revert", `&on=${on}`);
export const editDatasetEvent = (game, dataset, batch, eventId, values) =>
  _evt(game, dataset, batch, eventId, "edit", "", values);
export const removeDatasetEvent = (game, dataset, batch, eventId) =>
  _evt(game, dataset, batch, eventId, "remove");

// Subsets: a filtered/derived view over a dataset. Returns { columns, rows, enriched }.
export async function getSubset(game, subset) {
  const r = await fetch(`/api/flow/${encodeURIComponent(game)}/subset/${encodeURIComponent(subset)}`);
  if (!r.ok) throw new Error(`subset: ${r.status} ${await r.text()}`);
  return r.json();
}
// Same view, but also runs the subset's enrichers (network — explicit action).
export async function enrichSubset(game, subset) {
  const r = await fetch(`/api/flow/${encodeURIComponent(game)}/subset/${encodeURIComponent(subset)}/enrich`, { method: "POST" });
  if (!r.ok) throw new Error(`enrich: ${r.status} ${await r.text()}`);
  return r.json();
}

// Per-window stash bindings: which capture a window opens with.
export async function getBindings(game) {
  const r = await fetch(`/api/captures/${encodeURIComponent(game)}/bindings`);
  return r.ok ? r.json() : {};
}
export async function bindCapture(game, window, name) {
  await fetch(`/api/captures/${encodeURIComponent(game)}/bind?window=${encodeURIComponent(window)}&name=${encodeURIComponent(name)}`, { method: "POST" });
}
