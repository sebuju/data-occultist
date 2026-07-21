// Thin wrapper around the backend HTTP API.
import * as conn from "./conn.js";

// Every request gets a DEADLINE: a wedged server (e.g. a dead --reload worker whose
// parent still holds the port) leaves connections hanging forever instead of refusing
// them — without a timeout the whole UI just silently stalls. Light endpoints fail
// fast; OCR endpoints get longer since they queue behind the one GPU lock.
const LIGHT_MS = 30_000;
const OCR_MS = 60_000;

// ---- flood / stuck guards (every request rides these, so NO endpoint can be hammered or wedge
// the UI). Two centralized guards:
//   1. GET coalescing — concurrent identical in-flight GETs (no caller signal) share ONE request,
//      so a refresh storm or a render loop collapses to a single fetch instead of N. Each caller
//      gets its own response CLONE (the cached one stays unread, so every clone is readable).
//   2. Per-endpoint circuit breaker — after a few timeouts/conn-failures on a path, fail fast for a
//      cooldown instead of piling more doomed requests on a wedged endpoint. Informs once (so the
//      user knows why a panel went quiet) and auto-recovers: the first call after the cooldown is a
//      live trial; success clears the breaker. ----------------------------------------------------
const _inflightGet = new Map();        // url -> Promise<Response> for an in-flight idempotent GET
const _breaker = new Map();            // path -> { fails, openUntil }
const BREAKER_FAILS = 3;               // consecutive timeouts/conn-fails on a path before it trips
const BREAKER_COOLDOWN_MS = 10_000;    // fail-fast window before a trial request is allowed through

function _guardNotice(msg) {
    console.warn("[api guard]", msg);
    // decoupled from the UI layer: whoever cares (main.js) listens and surfaces it (setStatus/log).
    try { window.dispatchEvent(new CustomEvent("api-guard", { detail: msg })); } catch { /* no window */ }
}

// Optional per-request observer (main.js wires this during boot to mirror every request into the
// log bar). Called at request `start` and again on settle with `{ms, ok, status, reason}`. Kept a
// plain sink (not always-on events) so steady state pays nothing when no one is listening.
let _onRequest = null;
export function onApiRequest(fn) { _onRequest = fn || null; }
function _emitReq(ev) { if (_onRequest) { try { _onRequest(ev); } catch { /* observer must never break a request */ } } }
function _breakerOpen(path) { const b = _breaker.get(path); return !!b && b.openUntil > performance.now(); }
function _breakerOk(path) { if (_breaker.has(path)) _breaker.delete(path); }
function _breakerFail(path) {
    const b = _breaker.get(path) || { fails: 0, openUntil: 0 };
    b.fails += 1;
    if (b.fails >= BREAKER_FAILS) {
        b.openUntil = performance.now() + BREAKER_COOLDOWN_MS;
        b.fails = 0;
        _guardNotice(`${path} keeps timing out — pausing calls to it for ${BREAKER_COOLDOWN_MS / 1000}s`);
    }
    _breaker.set(path, b);
}

// THE guard, applied to one fetch. Installed on `window.fetch` below so EVERY request to our API
// rides it — raw `fetch("/api/...")` callers (refreshLive, the dataset/subset node fetches, stats,
// …) get coalescing + breaker + deadline + logging WITHOUT having to remember to call a wrapper.
// Non-API URLs (static assets) pass straight through. `init.__timeoutMs` overrides the deadline.
function _guardedFetch(native, input, init = {}) {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    if (!url.includes("/api/")) return native(input, init);   // only guard our backend API
    const path = url.split("?")[0];
    const method = (init.method || (typeof input !== "string" && input.method) || "GET").toUpperCase();
    // breaker tripped: fail fast (recoverable — the next call after the cooldown probes live).
    if (_breakerOpen(path)) {
        return Promise.reject(new Error(`${path}: paused after repeated timeouts (retrying shortly)`));
    }
    // coalesce side-effect-free GETs with no caller abort signal — concurrent identical fetches
    // (a render loop, a refresh storm, build + batches hitting the same dataset url) collapse to
    // ONE request; each caller gets its own response clone (the cached one stays unread).
    const coalesce = method === "GET" && !init.signal;
    if (coalesce) {
        const hit = _inflightGet.get(url);
        if (hit) return hit.then((r) => r.clone());
    }
    const ms = init.__timeoutMs || LIGHT_MS;
    const t0 = performance.now();
    _emitReq({ phase: "start", method, path });
    const deadline = AbortSignal.timeout(ms);
    const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
    const p = native(input, { ...init, signal }).then((r) => {
        conn.reportReachable();   // got a response (even an error status) -> backend is up
        _breakerOk(path);
        // Server-Timing (app.py's diagnostic middleware) tells us how long the HANDLER took,
        // so the boot log can show real server time next to the client-measured (jank-inflated) ms.
        const srvHdr = r.headers.get("Server-Timing");
        const srv = srvHdr ? Number(/dur=([\d.]+)/.exec(srvHdr)?.[1]) : undefined;
        _emitReq({ phase: "done", method, path, ms: Math.round(performance.now() - t0),
                   srv: Number.isFinite(srv) ? srv : undefined, ok: true, status: r.status });
        return r;
    }).catch((e) => {
        const userAborted = init.signal && init.signal.aborted;   // panel closed / navigation, not connectivity
        _emitReq({ phase: "done", method, path, ms: Math.round(performance.now() - t0), ok: false, reason: e.name === "TimeoutError" ? "timeout" : (e.message || e.name) });
        if (e.name === "TimeoutError") {
            const reason = `${path}: no response within ${ms / 1000}s`;
            if (!userAborted) { conn.reportUnreachable(reason); _breakerFail(path); }
            throw new Error(reason);
        }
        if (!userAborted && e.name === "TypeError") { conn.reportUnreachable(`${path}: ${e.message}`); _breakerFail(path); }
        throw e;
    }).finally(() => { if (coalesce) _inflightGet.delete(url); });
    if (coalesce) { _inflightGet.set(url, p); return p.then((r) => r.clone()); }   // keep the cached one unread
    return p;
}

// Install once: from here, NOTHING can fetch our API without the guard — calling fetch() directly
// is fine, it's still wrapped. (EventSource/SSE is a separate API and unaffected.)
if (typeof window !== "undefined" && window.fetch && !window.fetch.__apiGuarded) {
    const native = window.fetch.bind(window);
    const wrapped = (input, init) => _guardedFetch(native, input, init);
    wrapped.__apiGuarded = true;
    window.fetch = wrapped;
}

// A fetch with our timeout policy, for the typed api.* helpers. Coalescing/breaker/logging now live
// in the window.fetch guard, so this just carries the per-call deadline (OCR gets a longer one).
function tfetch(url, opts = {}, ms = LIGHT_MS) {
    return fetch(url, { ...opts, __timeoutMs: ms });
}

// Global OCR gate. The server serializes ALL OCR on one process-wide lock (see
// ocr/serialize.py): two OCR jobs never run at once, so firing many at once can't go
// faster. Worse, each in-flight request HOLDS one of the browser's ~6 per-host
// connections while it queues server-side, so a burst of OCR POSTs (preview+detect for
// every window on load) saturates the connection pool and starves plain GETs — the
// window image then waits seconds for a free socket even though serving it is ~4ms. So
// cap OCR requests in flight here, mirroring the server. 2 keeps the pipe full (one
// computing while the next uploads) without monopolising connections.
const OCR_MAX = 2;
let _ocrActive = 0;
const _ocrWaiters = [];
function _ocrRelease() {
    _ocrActive--;
    const next = _ocrWaiters.shift();
    if (next) { _ocrActive++; next(); }
}
// Run an OCR fetch through the gate: wait for a slot, then always release (even on error).
function tfetchOcr(url, opts = {}, ms = OCR_MS) {
    const start = () => tfetch(url, opts, ms).finally(_ocrRelease);
    if (_ocrActive < OCR_MAX) { _ocrActive++; return start(); }
    return new Promise((res, rej) => _ocrWaiters.push(() => start().then(res, rej)));
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

// Stale-tab save guard: tracks the structural ETag + local "opened at" time per profile
// name, set from GET/successful-PUT responses. saveProfile sends the remembered token
// back as If-Match so a save that would clobber a change made elsewhere (another tab, an
// external edit) since this tab last loaded/saved gets rejected (409) instead of silently
// overwriting it — see ProfileConflict below and graph/conflictmodal.js.
const _ver = new Map();   // name -> { token, openedAt }
export function profileVersion(name) { return _ver.get(name) || null; }

export class ProfileConflict extends Error {
    constructor(payload) {
        super("profile changed on server");
        this.payload = payload;   // { conflict, server_yaml, incoming_yaml, server_modified, server_version }
    }
}

export async function getProfile(name) {
    const r = await tfetch(`/api/profiles/${encodeURIComponent(name)}`);
    if (!r.ok) throw new Error(`load ${name}: ${r.status}`);
    const token = r.headers.get("ETag");
    if (token) _ver.set(name, { token, openedAt: new Date().toISOString() });
    return r.json();
}

// merge=true upserts windows (teach page, single window); merge=false replaces the
// whole profile (graph editor, which holds the complete picture) so deletes persist.
// layout=true marks a pure layout save (positions/open-images, no content change) so the
// server skips the feed re-pull + structural-snapshot diff those saves never need.
// `force` skips the If-Match guard entirely (the conflict modal's "overwrite server").
export async function saveProfile(profile, merge = true, layout = false, { force = false } = {}) {
    const known = _ver.get(profile.name);
    const headers = { "Content-Type": "application/json" };
    if (!force && known) headers["If-Match"] = known.token;
    const r = await tfetch(`/api/profiles/${encodeURIComponent(profile.name)}?merge=${merge}&layout=${layout}`, {
        method: "PUT",
        headers,
        body: JSON.stringify(profile),
    });
    if (r.status === 409) throw new ProfileConflict(await r.json());
    if (!r.ok) throw new Error(`save: ${r.status} ${await r.text()}`);
    const body = await r.json();
    const newToken = r.headers.get("ETag");
    if (newToken) _ver.set(profile.name, { token: newToken, openedAt: known?.openedAt || new Date().toISOString() });
    return body;
}

// Per-device graph viewport (zoom/pan + minimap), a gitignored sidecar — NOT part of
// the profile. Node layout itself lives in the profile. Used only by persist.js.
export const graphLocal = {
    get: (name) => tfetch(`/api/profiles/${encodeURIComponent(name)}/graphlocal`).then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
    put: (name, state) => tfetch(`/api/profiles/${encodeURIComponent(name)}/graphlocal`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state),
    }).then((r) => ok(r, "graphlocal save")).then((r) => r.json()),   // reject on HTTP error too — persist.js flushLocal logs it
};

// Versioned profile backups: list snapshots (meta only), fetch one's full profile,
// or restore one (which re-saves it live and snapshots the current state first).
export const backups = {
    // a page of snapshots, newest first -> { total, items }. Only this page is parsed server-side.
    list: (name, limit = 10, offset = 0) =>
        tfetch(`/api/profiles/${encodeURIComponent(name)}/backups?limit=${limit}&offset=${offset}`)
            .then((r) => (r.ok ? r.json() : { total: 0, items: [] })),
    get: (name, stamp) => tfetch(`/api/profiles/${encodeURIComponent(name)}/backups/${encodeURIComponent(stamp)}`).then((r) => ok(r, "backup").then((x) => x.json())),
    restore: (name, stamp) => tfetch(`/api/profiles/${encodeURIComponent(name)}/backups/${encodeURIComponent(stamp)}/restore`, { method: "POST" }).then((r) => ok(r, "restore").then((x) => x.json())),
};

// Database backups: list snapshots of a game's SQLite store, take one on demand, or
// restore one (which snapshots the current state first). Mirrors `backups` but for data.
export const dbbackups = {
    list: (game) => tfetch(`/api/dbbackup/${encodeURIComponent(game)}`)
        .then((r) => (r.ok ? r.json() : { items: [] })),
    create: (game) => tfetch(`/api/dbbackup/${encodeURIComponent(game)}/create`, { method: "POST" })
        .then((r) => ok(r, "backup").then((x) => x.json())),
    restore: (game, stamp) => tfetch(`/api/dbbackup/${encodeURIComponent(game)}/${encodeURIComponent(stamp)}/restore`, { method: "POST" })
        .then((r) => ok(r, "restore").then((x) => x.json())),
};

// OCR the current layout. Pass game+capture to read that stashed image (the one
// shown in the image node) instead of capturing the live window.
export async function preview(profile, game, capture, preferCache = false, feed = false) {
    let url = "/api/preview";
    if (game && capture) url += `?game=${encodeURIComponent(game)}&capture=${encodeURIComponent(capture)}`;
    if (preferCache) url += `${url.includes("?") ? "&" : "?"}prefer_cache=1`;
    // feed=1: read like a live tick (readout consensus/history + register/watch blobs + on_readout).
    if (feed) url += `${url.includes("?") ? "&" : "?"}feed=1`;
    const r = await tfetchOcr(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(profile),
    }, OCR_MS);
    if (!r.ok) throw new Error(`preview: ${r.status} ${await r.text()}`);
    return r.json();
}

// Debug the window's rule pipelines: read every field off the current canvas and trace each
// value through its rules in ONE OCR pass. Field nodes coalesce into this single batch so the
// whole trace fleet costs one window read. Returns
// { fields: { [fieldId]: { trace:[{i,when,then,in,out,fired}], value, dropped, raw } } }.
export async function ruleTrace(profile, game, capture) {
    let url = "/api/rule_trace";
    if (game && capture) url += `?game=${encodeURIComponent(game)}&capture=${encodeURIComponent(capture)}`;
    const r = await tfetchOcr(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(profile),
    }, OCR_MS);
    if (!r.ok) throw new Error(`rule_trace: ${r.status} ${await r.text()}`);
    return r.json();
}

// Re-read the current layout and COMMIT the keyable cells into the window's dataset
// store (one revertable batch). Returns { dataset, written, skipped, cells }.
export async function previewCommit(profile, game, capture) {
    let url = "/api/preview/commit";
    if (game && capture) url += `?game=${encodeURIComponent(game)}&capture=${encodeURIComponent(capture)}`;
    const r = await tfetchOcr(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(profile),
    }, OCR_MS);
    if (!r.ok) throw new Error(`commit: ${r.status} ${await r.text()}`);
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

// Evaluate detectors/states against the image: { detect:{id:{matched,read}}, states:{...} }.
export async function detect(profile, game, capture, preferCache = false) {
    let url = "/api/detect";
    if (game && capture) url += `?game=${encodeURIComponent(game)}&capture=${encodeURIComponent(capture)}`;
    if (preferCache) url += `${url.includes("?") ? "&" : "?"}prefer_cache=1`;
    const r = await tfetchOcr(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(profile) }, OCR_MS);
    if (!r.ok) throw new Error(`detect: ${r.status}`);
    return r.json();
}

// Cross-check every window against every other using bound reference images:
// { windows:[{window,capture,verdict,winner,collides_with,matches:[{window,matched,detectors}]}] }
export async function detectCollisions(game, signal) {
    const r = await tfetchOcr(`/api/detect/collisions/${encodeURIComponent(game)}`, { signal }, OCR_MS);
    if (!r.ok) throw new Error(`collisions: ${r.status}`);
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

// Saved live-mode images live in their own bucket: grab one now (live tuning calls this
// each round), read the {count,bytes} stat, or clear them all. grab returns the new stats.
export const liveCaptures = {
    grab: (game) => tfetch(`/api/captures/${encodeURIComponent(game)}/live/grab`, { method: "POST" }, OCR_MS).then((r) => ok(r, "live grab")).then((r) => r.json()),
    stats: (game) => tfetch(`/api/captures/${encodeURIComponent(game)}/live/stats`).then((r) => r.json()),
    clear: (game) => tfetch(`/api/captures/${encodeURIComponent(game)}/live/clear`, { method: "POST" }).then((r) => ok(r, "clear live")).then((r) => r.json()),
    // Live-bucket image names (newest first) for the picker's live tab, the URL to load one, and
    // "promote" — copy a live image into the permanent bucket so a flush can't delete it (returns
    // the chosen filename, now a normal capture).
    list: (game) => tfetch(`/api/captures/${encodeURIComponent(game)}/live/list`).then((r) => (r.ok ? r.json() : [])),
    imgUrl: (game, name) => `/api/captures/${encodeURIComponent(game)}/live/img/${encodeURIComponent(name)}`,
    promote: (game, name) => tfetch(`/api/captures/${encodeURIComponent(game)}/live/promote?name=${encodeURIComponent(name)}`, { method: "POST" }).then((r) => ok(r, "promote live")).then((r) => r.json()).then((j) => j.name),
};

// URL of one frame image (NNNNN.jpg) of a saved precapture session — for the capture picker.
// `w` > 0 requests a width-w thumbnail (server-side, cached) instead of the full 4K frame.
export const precaptureFrameUrl = (game, sid, idx, w = 0) =>
    `/api/precapture/${encodeURIComponent(game)}/${encodeURIComponent(sid)}/frame/${idx}${w > 0 ? `?w=${w}` : ""}`;

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

// Freeze a taught cutout from a stashed capture -> { name, url }. box is fractions. The crop
// is one reference glyph/symbol for the game's cutout atlas (which pool it joins is tagged
// client-side onto the CutoutDef — the store itself doesn't care).
export async function atlasCutout(game, capture, box) {
    const q = `game=${encodeURIComponent(game)}&capture=${encodeURIComponent(capture)}&x=${box.x}&y=${box.y}&w=${box.w}&h=${box.h}`;
    const r = await tfetch(`/api/atlas/cutout?${q}`, { method: "POST" });
    if (!r.ok) throw new Error(`cutout: ${r.status} ${await r.text()}`);
    return r.json();
}
export function atlasUrl(game, name) {
    return `/api/atlas/cutout/${encodeURIComponent(game)}/${encodeURIComponent(name)}`;
}
// Auto-glypher: OCR a region box, split each recognised word into one crop per character with
// the label prefilled from OCR. Returns [{char, image, url}] for the user to correct + confirm
// (nothing is saved to the profile yet).
export async function glyphAuto(game, capture, box) {
    const q = `game=${encodeURIComponent(game)}&capture=${encodeURIComponent(capture)}&x=${box.x}&y=${box.y}&w=${box.w}&h=${box.h}`;
    const r = await tfetch(`/api/glyph/auto?${q}`, { method: "POST" });
    if (!r.ok) throw new Error(`auto-glyph: ${r.status} ${await r.text()}`);
    return r.json();
}
// Read the scrollbar thumb position (0..1) from a cutout PNG data URL — one scroll-calibration
// sample — and save the cutout server-side. Returns { pos, conf, thumb_px, thumb_len, name }
// (pos null if no thumb found; name null if game wasn't given). The data URL is sent once and
// never stored inline in the profile — only the returned `name` is (ScrollSample.file).
export async function scrollPos(game, image, orientation = "vertical") {
    const r = await tfetch("/api/scroll/pos", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ game, image, orientation }),
    });
    if (!r.ok) throw new Error(`scroll pos: ${r.status} ${await r.text()}`);
    return r.json();
}
export function scrollCutoutUrl(game, name) {
    return `/api/scroll/cutout/${encodeURIComponent(game)}/${encodeURIComponent(name)}`;
}

// POST a rendered node-canvas PNG (Blob) -> stashed under .trash/ on the server.
// `view` ("canvas" whole graph | "viewport" on-screen) tags the saved filename.
// Returns { path, name }. OCR_MS deadline: a big graph can take a moment to encode.
export async function stashScreenshot(game, blob, view = "canvas") {
    const r = await tfetch(`/api/screenshot/${encodeURIComponent(game)}?view=${encodeURIComponent(view)}`,
        { method: "POST", headers: { "Content-Type": "image/png" }, body: blob }, OCR_MS);
    return ok(r, "screenshot").then((x) => x.json());
}

// Read one item's frozen cutout with the current settings -> { cutout:[w,h],
// fields:{id:{raw,value,confidence,substituted,box}}, tells:[...], valid, cell }.
export async function itemRead(profile, game, win, item, preferCache = false) {
    let q = `game=${encodeURIComponent(game)}&win=${encodeURIComponent(win)}&item=${encodeURIComponent(item)}`;
    if (preferCache) q += "&prefer_cache=1";
    const r = await tfetchOcr(`/api/item/read?${q}`, {
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
    setYield: (ms) => tfetch(`/api/ocr/yield?ms=${encodeURIComponent(ms)}`, { method: "POST" }).then((r) => r.json()),
    setThreads: (n) => tfetch(`/api/ocr/threads?n=${encodeURIComponent(n)}`, { method: "POST" }).then((r) => r.json()),
    setEngineType: (name) => tfetch(`/api/ocr/engine?name=${encodeURIComponent(name)}`, { method: "POST" }).then((r) => r.json()),
    setGpuMemGb: (gb) => tfetch(`/api/ocr/gpumem?gb=${encodeURIComponent(gb)}`, { method: "POST" }).then((r) => r.json()),
    releaseGpu: () => tfetch("/api/ocr/release", { method: "POST" }).then((r) => r.json()),
};

// Capture backend (wgc/printwindow/mss). Returns { name, names } — names is the live
// registry list, so a backend that fails to import simply never appears in the dropdown.
export const captureBackend = {
    getBackend: () => tfetch("/api/capture/backend").then((r) => r.json()),
    setBackend: ({ foreground, background } = {}) => {
        const q = [];
        if (foreground) q.push(`foreground=${encodeURIComponent(foreground)}`);
        if (background) q.push(`background=${encodeURIComponent(background)}`);
        return tfetch(`/api/capture/backend?${q.join("&")}`, { method: "POST" }).then((r) => r.json());
    },
};

// Testing harness: a recorded video as a stand-in for the live game window.
// status/seek/step/enable/close return the same status blob:
// { loaded, name, index, count, fps, enabled, width, height }.
export const video = {
    upload: (file) => {
        const fd = new FormData();
        fd.append("file", file);
        // big file + decode on the server: give it a generous deadline.
        return tfetch("/api/video/upload", { method: "POST", body: fd }, 120_000)
            .then((r) => ok(r, "video upload")).then((r) => r.json());
    },
    status: () => tfetch("/api/video/status").then((r) => r.json()),
    seek: (index) => tfetch(`/api/video/seek?index=${index}`, { method: "POST" }).then((r) => r.json()),
    step: (n = 1) => tfetch(`/api/video/step?n=${n}`, { method: "POST" }).then((r) => r.json()),
    enable: (on) => tfetch(`/api/video/enable?on=${on ? "true" : "false"}`, { method: "POST" }).then((r) => r.json()),
    close: () => tfetch("/api/video/close", { method: "POST" }).then((r) => r.json()),
};

// Testing inspector: feed synthetic readout values into a game's live session as if they
// had just been OCR'd off that window (no image, no OCR) — same fold `/api/preview?feed=1`
// uses, so registers/gates/routers/on_readout triggers all react exactly as they would live.
export const testfeed = {
    readouts: (game, profile, windowId, values) =>
        tfetch(`/api/test/feed_readouts?game=${encodeURIComponent(game)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ profile, window_id: windowId, values }),
        }).then((r) => ok(r, "feed").then((x) => x.json())),
};

// Capture benchmark: measure raw grab throughput (no OCR) for the live window, and
// list which capture backends this machine has (wgc only if windows-capture is
// installed). run() blocks ~`seconds` server-side, so give it a long deadline.
export const bench = {
    backends: () => tfetch("/api/bench/backends").then((r) => r.json()),
    run: (game, capture, seconds = 3) => {
        let url = `/api/bench?game=${encodeURIComponent(game)}&seconds=${seconds}`;
        if (capture) url += `&capture=${encodeURIComponent(capture)}`;
        return tfetch(url, {}, 60_000).then((r) => ok(r, "bench").then((x) => x.json()));
    },
};

// Precapture: record frames fast, batch-OCR them, then save. Each call returns the
// session status { phase, frames, processed, fps, error, datasets:[{dataset,count,sample}] }.
const _pre = (game, path, signal, method = "POST", ms) =>
    tfetch(`/api/precapture/${encodeURIComponent(game)}/${path}`, { method, signal }, ms).then((r) => r.json());
export const precapture = {
    recordStart: (game, maxFrames, intervalMs, label, autoProcess, signal) => _pre(game, `record/start?max_frames=${maxFrames}&interval_ms=${intervalMs}&label=${encodeURIComponent(label || "")}&auto_process=${!!autoProcess}`, signal),
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
    frameTimes: (game, sid, signal) => tfetch(`/api/precapture/${encodeURIComponent(game)}/${encodeURIComponent(sid)}/frametimes`, { signal }).then((r) => r.json()),
    reclog: (game, sid, signal) => tfetch(`/api/precapture/${encodeURIComponent(game)}/${encodeURIComponent(sid)}/reclog`, { signal }).then((r) => r.json()),
    loadSession: (game, sid, signal) => _pre(game, `sessions/${encodeURIComponent(sid)}/load`, signal),
    renameSession: (game, sid, label, signal) => _pre(game, `sessions/${encodeURIComponent(sid)}/rename?label=${encodeURIComponent(label || "")}`, signal),
    deleteSession: (game, sid, signal) => _pre(game, `sessions/${encodeURIComponent(sid)}`, signal, "DELETE"),
    deleteAllSessions: (game, signal) => _pre(game, "sessions", signal, "DELETE"),
};

// Live collection: run the real collector pipeline server-side, writing to datasets.
// Status { running, frames, written, fps, window, state, recognized:[{key,count,miss}] }.
export const live = {
    // interval omitted (null/undefined) => server uses tuning.collect_interval; a number
    // overrides it (the live panel's frame limiter — min seconds between collector reads).
    // saveRecognized => the collector saves every OCR-due grab whose frame matched a window to
    // the live/ bucket, not only writes.
    // feedImages => replay the saved live/ images through the pipeline instead of live capture,
    // paced server-side by their timestamps (see collect/replay.py). Saves nothing while feeding.
    start: (game, interval, saveRecognized, feedImages, signal) => {
        let url = `/api/live/${encodeURIComponent(game)}/start`;
        const q = [];
        if (interval != null && Number.isFinite(interval)) q.push(`interval=${encodeURIComponent(interval)}`);
        if (saveRecognized) q.push("save_recognized=1");
        if (feedImages) q.push("feed_images=1");
        if (q.length) url += `?${q.join("&")}`;
        return tfetch(url, { method: "POST", signal }).then((r) => r.json());
    },
    stop: (game, signal) => tfetch(`/api/live/${encodeURIComponent(game)}/stop`, { method: "POST", signal }).then((r) => ok(r, "live stop")).then((r) => r.json()),
    // Skip the feed-saved-images replay to the next image now (feed_images mode only).
    feedSkip: (game, signal) => tfetch(`/api/live/${encodeURIComponent(game)}/feed/skip`, { method: "POST", signal }).then((r) => r.json()),
    status: (game, signal) => tfetch(`/api/live/${encodeURIComponent(game)}/status`, { signal }).then((r) => r.json()),
    // Debug log: incremental poll (entries newer than `after`). { running, seq, entries:[...] }.
    debug: (game, after = 0, signal) => tfetch(`/api/live/${encodeURIComponent(game)}/debug?after=${encodeURIComponent(after)}`, { signal }).then((r) => r.json()),
    // Persisted frame limiter (seconds; 0 = fastest). getInterval → { interval }; setInterval persists.
    getInterval: (signal) => tfetch("/api/live/interval", { signal }).then((r) => r.json()),
    setInterval: (seconds) => tfetch(`/api/live/interval?seconds=${encodeURIComponent(seconds)}`, { method: "POST" }).then((r) => r.json()),
};

// A register node's held in-memory map (live session memory only). registerDetail → { records };
// empty when no session runs. clearRegister wipes the held map. `aggregate`/`arg` are the node's
// CURRENT fold selection + its tuning knob — passed so the server folds the ring with them right
// away (the session's own profile is frozen mid-run, so it would otherwise lag the select); the
// ONE fold lives server-side (rule 7).
export async function registerDetail(game, id, aggregate = "", arg = 0) {
    const params = new URLSearchParams();
    if (aggregate) params.set("aggregate", aggregate);
    if (arg) params.set("arg", arg);
    const q = params.toString() ? `?${params}` : "";
    const r = await tfetch(`/api/live/${encodeURIComponent(game)}/register/${encodeURIComponent(id)}${q}`);
    if (!r.ok) throw new Error(`register: ${r.status} ${await r.text()}`);
    return r.json();
}
export async function clearRegister(game, id) {
    const r = await tfetch(`/api/live/${encodeURIComponent(game)}/register/${encodeURIComponent(id)}/clear`, { method: "POST" });
    if (!r.ok) throw new Error(`clear register: ${r.status} ${await r.text()}`);
    return r.json();
}
// Carry the held map to the register's new id after a rename — else it reads empty under the
// new id until the next collector tick repopulates it from readouts.
export async function renameRegister(game, oldId, newId) {
    const r = await tfetch(`/api/live/${encodeURIComponent(game)}/register/${encodeURIComponent(oldId)}/rename`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ new_id: newId }),
    });
    if (!r.ok) throw new Error(`rename register: ${r.status} ${await r.text()}`);
    return r.json();
}
// Carry a process's live output + input/output history to its new id after a rename — else its
// "raw" satellite reads empty under the new id until the next collector tick repopulates it.
export async function renameProcess(game, oldId, newId) {
    const r = await tfetch(`/api/live/${encodeURIComponent(game)}/process/${encodeURIComponent(oldId)}/rename`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ new_id: newId }),
    });
    if (!r.ok) throw new Error(`rename process: ${r.status} ${await r.text()}`);
    return r.json();
}

// Wipe a dataset's stored records + ledger.
export async function clearDataset(game, dataset) {
    const r = await tfetch(`/api/flow/${encodeURIComponent(game)}/dataset/${encodeURIComponent(dataset)}/clear`, { method: "POST" });
    if (!r.ok) throw new Error(`clear: ${r.status} ${await r.text()}`);
    return r.json();
}

// Apply a dataset's keep_batches window now: batches past it fold into a per-key base event.
// Rows and their aggregates survive; the old per-observation detail does not. -> {…, folded}.
export async function compactDataset(game, dataset) {
    const r = await tfetch(`/api/flow/${encodeURIComponent(game)}/dataset/${encodeURIComponent(dataset)}/compact`, { method: "POST" });
    if (!r.ok) throw new Error(`compact: ${r.status} ${await r.text()}`);
    return r.json();
}

// Permanently delete a dataset's stored files, so removing its node doesn't leave the
// dataset re-spawning from disk on the next live refresh.
export async function deleteDataset(game, dataset) {
    const r = await tfetch(`/api/flow/${encodeURIComponent(game)}/dataset/${encodeURIComponent(dataset)}/delete`, { method: "POST" });
    if (!r.ok) throw new Error(`delete: ${r.status} ${await r.text()}`);
    return r.json();
}

// Drop the whole game store and leave a fresh empty one. Dataset nodes survive (profile
// untouched) and resurrect their dataset on the next write. Returns refreshed dbschema.
export async function dropDatabase(game) {
    const r = await tfetch(`/api/dbschema/${encodeURIComponent(game)}/drop`, { method: "POST" });
    if (!r.ok) throw new Error(`drop: ${r.status} ${await r.text()}`);
    return r.json();
}

// Empty ONE physical SQLite table (low-level). Returns refreshed dbschema.
// Compact the store file (VACUUM) — hands SQLite's freed pages back to the OS. Not destructive;
// rewrites the same content. -> {ok, before, after, freed, schema}. ok:false = store was busy.
export async function vacuumDatabase(game) {
    const r = await tfetch(`/api/dbschema/${encodeURIComponent(game)}/vacuum`, { method: "POST" }, 120_000);
    if (!r.ok) throw new Error(`compact: ${r.status} ${await r.text()}`);
    return r.json();
}

export async function clearDbTable(game, table) {
    const r = await tfetch(`/api/dbschema/${encodeURIComponent(game)}/table/${encodeURIComponent(table)}/clear`, { method: "POST" });
    if (!r.ok) throw new Error(`clear table: ${r.status} ${await r.text()}`);
    return r.json();
}

// Move a dataset's stored records to a new name (so a profile rename doesn't orphan
// the old data and re-spawn it in the graph). 409 if the target name already has data.
export async function renameDataset(game, dataset, to) {
    const r = await tfetch(`/api/flow/${encodeURIComponent(game)}/dataset/${encodeURIComponent(dataset)}/rename?to=${encodeURIComponent(to)}`, { method: "POST" });
    if (!r.ok) throw new Error(`rename: ${r.status} ${await r.text()}`);
    return r.json();
}

// Repoint {{token}} references in the game's Pretty doc after a graph-node rename, so a
// renamed dataset/subset/window/field/item/trigger/producer id doesn't leave stale tokens
// (which resolve to empty). Best-effort: a failure never blocks the rename. `rewrites` is a
// list of { kind, old, new, win? }.
export async function repointPretty(game, rewrites) {
    if (!game || !rewrites || !rewrites.length) return;
    try {
        await tfetch(`/api/pretty/${encodeURIComponent(game)}/repoint`,
            { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rewrites }) });
    } catch { /* pretty token repoint is a convenience — never fail a rename over it */ }
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
    refresh: (game, dataset, mode = "", type = "http") => tfetch(`/api/prices/${_pg(game)}/refresh?dataset=${encodeURIComponent(dataset)}&mode=${encodeURIComponent(mode)}&type=${encodeURIComponent(type)}`, { method: "POST" }, 30_000).then((r) => ok(r, "producer refresh").then((x) => x.json())),
    cancel: (game, dataset) => tfetch(`/api/prices/${_pg(game)}/cancel?dataset=${encodeURIComponent(dataset)}`, { method: "POST" }).then((r) => ok(r, "cancel sweep")).then((r) => r.json()),
    status: (game, dataset) => tfetch(`/api/prices/${_pg(game)}/status?dataset=${encodeURIComponent(dataset)}`).then((r) => r.json()),
    // producer satellite: what it WILL fetch/output (no sweep), and a live one-item test-fetch
    preview: (game, dataset, limit = 50) => tfetch(`/api/prices/${_pg(game)}/preview?dataset=${encodeURIComponent(dataset)}&limit=${limit}`).then((r) => ok(r, "producer preview").then((x) => x.json())),
    probe: (game, dataset, item = "") => tfetch(`/api/prices/${_pg(game)}/probe?dataset=${encodeURIComponent(dataset)}&item=${encodeURIComponent(item)}`, { method: "POST" }, 30_000).then((r) => ok(r, "producer probe").then((x) => x.json())),
};

// Triggers: fire a price-node sweep on a condition. `list` shows wiring + per-target status;
// `fire` runs a trigger's sweeps now (for testing outside the collector loop).
export const triggers = {
    list: (game) => tfetch(`/api/triggers/${_pg(game)}`).then((r) => ok(r, "triggers").then((x) => x.json())),
    fire: (game, id) => tfetch(`/api/triggers/${_pg(game)}/${encodeURIComponent(id)}/fire`, { method: "POST" }, 30_000).then((r) => ok(r, "fire trigger").then((x) => x.json())),
};

// Actions: run a dataset op (clear / clone / move) NOW on the action node's targets — the manual
// fire button. Same funnel a trigger uses, so a test fire matches an automatic one.
export const actions = {
    fire: (game, id) => tfetch(`/api/actions/${_pg(game)}/${encodeURIComponent(id)}/fire`, { method: "POST" }, 30_000).then((r) => ok(r, "fire action").then((x) => x.json())),
};

// Toast nodes: raise an OS desktop notification. `test` pops the toast now with its current
// config (the node's test button) — behaves like a trigger firing it, minus the wiring.
export const toasts = {
    test: (game, id) => tfetch(`/api/toasts/${_pg(game)}/${encodeURIComponent(id)}/test`, { method: "POST" }, 10_000).then((r) => ok(r, "test toast").then((x) => x.json())),
    // render a hero/inline image SPEC to a live PNG (the node editor's preview) — returns
    // `{ url, boxes }`: an object URL for the blob (caller revokes it) plus the per-text-line pixel
    // boxes (from the X-Text-Boxes header) the editor overlays as clickable elements. null on
    // failure. Not funnelled through ok()/json().
    previewImage: async (game, spec, focus = null) => {
        const qs = focus == null ? "" : `?focus=${encodeURIComponent(focus)}`;
        const r = await fetch(`/api/toasts/${_pg(game)}/preview${qs}`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(spec) });
        if (!r.ok) return null;
        let boxes = [];
        try { boxes = JSON.parse(r.headers.get("X-Text-Boxes") || "[]"); } catch { boxes = []; }
        return { url: URL.createObjectURL(await r.blob()), boxes };
    },
};

// File sources: read a game log/config file into a dataset. `read` fires a read now; `preview`
// parses the in-progress config WITHOUT writing (live editor preview); `find` auto-finds the file.
export const sources = {
    read: (game, id, signal) => tfetch(`/api/sources/${_pg(game)}/${encodeURIComponent(id)}/read`, { method: "POST", signal }, 30_000).then((r) => ok(r, "read source").then((x) => x.json())),
    preview: (game, body, signal) => tfetch(`/api/sources/${_pg(game)}/preview`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
    }, 15_000).then((r) => ok(r, "source preview").then((x) => x.json())),
    // propose extraction fields by inspecting the file's data (the node's "auto-resolve")
    resolve: (game, body, signal) => tfetch(`/api/sources/${_pg(game)}/resolve`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
    }, 15_000).then((r) => ok(r, "resolve fields").then((x) => x.json())),
    find: (game, body, signal) => tfetch(`/api/sources/${_pg(game)}/find`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}), signal,
    }, 30_000).then((r) => ok(r, "find source").then((x) => x.json())),
    peek: (game, path, signal) => tfetch(`/api/sources/${_pg(game)}/peek`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }), signal,
    }, 15_000).then((r) => ok(r, "peek file").then((x) => x.json())),
};

// Activity: one poll for the floating Activity panel — every running price sweep, the
// precapture worker (when busy), and the enabled triggers + their next-fire countdown.
// Returns { sweeps:[...], precapture: status|null, triggers:[...] }.
export const activity = {
    get: (game, signal) => tfetch(`/api/activity/${_pg(game)}`, { signal }).then((r) => r.json()),
    // Tell the server this viewer is on/off screen, so its activity beat can drop to the idle
    // cadence while nobody is looking (events.py:_hidden_viewers). `keepalive` because the hide
    // report is fired exactly as the tab goes away, and a plain fetch would be cancelled.
    setVisible: (cid, visible) => tfetch(
        `/api/events/visible?cid=${encodeURIComponent(cid)}&visible=${visible ? "true" : "false"}`,
        { method: "POST", keepalive: true }).catch(() => { /* fail-safe: server treats it as visible */ }),
};

// Dictionaries: the shared term files under config/dictionaries/. The picker lists
// what's available (source + word count); get() fetches one file's terms so a newly
// referenced dictionary node shows them at once.
export const dictionaries = {
    list: () => tfetch("/api/dictionaries").then((r) => (r.ok ? r.json() : [])),
    get: (source) => tfetch(`/api/dictionaries/${encodeURIComponent(source)}`).then((r) => ok(r, "dictionary").then((x) => x.json())),
};

// Sounds: audio files under the web static sounds/ folder, served at /sounds/<name>.
// A trigger names one to play (in the browser) when it fires; the picker lists them.
export const sounds = {
    list: () => tfetch("/api/sounds").then((r) => (r.ok ? r.json() : [])),
};

// Views: outer-join the source datasets on the shared key, then filter/derive/sort.
// Returns { subset, datasets, columns, rows }.
export async function getSubset(game, subset) {
    const r = await tfetch(`/api/flow/${encodeURIComponent(game)}/subset/${encodeURIComponent(subset)}`);
    if (!r.ok) throw new Error(`subset: ${r.status} ${await r.text()}`);
    return r.json();
}

// One round-trip for many nodes' data: every listed dataset's detail + subset's view, computed
// server-side sharing one store per dataset (so a dataset feeding several views parses once).
// Returns { datasets: {id: detail}, subsets: {id: view} }. Used by the boot prefetch.
export async function flowDetails(game, datasets, subsets, signal) {
    const r = await tfetch(`/api/flow/${encodeURIComponent(game)}/details`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ datasets: datasets || [], subsets: subsets || [] }),
        signal,
    });
    if (!r.ok) throw new Error(`details: ${r.status} ${await r.text()}`);
    return r.json();
}

// ---- server-backed node tables (windowed search/sort/scroll) ----
// One window of a dataset/subset: filter (q, the AND/OR/NOT/glob grammar) + sort + slice, server-side.
// Returns { rows, total, columns } (+ has_removed for datasets). `total` is the full match count so
// the client scrollbar spans the whole result while only the window is held in memory.
const _pageQS = (o = {}) => {
    const p = new URLSearchParams();
    if (o.q) p.set("q", o.q);
    if (o.sort) p.set("sort", o.sort);
    if (o.desc) p.set("desc", "true");
    if (o.offset) p.set("offset", String(o.offset));
    if (o.limit) p.set("limit", String(o.limit));
    if (o.removed) p.set("removed", "true");
    const s = p.toString();
    return s ? `?${s}` : "";
};
export async function datasetPage(game, dataset, o = {}) {
    const r = await tfetch(`/api/flow/${encodeURIComponent(game)}/dataset/${encodeURIComponent(dataset)}/page${_pageQS(o)}`);
    if (!r.ok) throw new Error(`page: ${r.status} ${await r.text()}`);
    return r.json();
}
export async function subsetPage(game, subset, o = {}) {
    const r = await tfetch(`/api/flow/${encodeURIComponent(game)}/subset/${encodeURIComponent(subset)}/page${_pageQS(o)}`);
    if (!r.ok) throw new Error(`page: ${r.status} ${await r.text()}`);
    return r.json();
}
// The ledger (batches + history) WITHOUT the record dump — for a dataset node's batches tab.
export async function datasetBatches(game, dataset) {
    const r = await tfetch(`/api/flow/${encodeURIComponent(game)}/dataset/${encodeURIComponent(dataset)}/batches`);
    if (!r.ok) throw new Error(`batches: ${r.status} ${await r.text()}`);
    return r.json();
}
// Distinct non-empty values of one column (for the join-sample cycler).
export async function datasetDistinct(game, dataset, field, limit = 0) {
    const r = await tfetch(`/api/flow/${encodeURIComponent(game)}/dataset/${encodeURIComponent(dataset)}/distinct?field=${encodeURIComponent(field)}${limit ? `&limit=${limit}` : ""}`);
    return r.ok ? (await r.json()).values || [] : [];
}
export async function subsetDistinct(game, subset, field, limit = 0) {
    const r = await tfetch(`/api/flow/${encodeURIComponent(game)}/subset/${encodeURIComponent(subset)}/distinct?field=${encodeURIComponent(field)}${limit ? `&limit=${limit}` : ""}`);
    return r.ok ? (await r.json()).values || [] : [];
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
    await tfetch(`/api/captures/${encodeURIComponent(game)}/bind?window=${encodeURIComponent(window)}&name=${encodeURIComponent(name)}`, { method: "POST" }).then((r) => ok(r, "bind capture"));
    invalidateBindings(game);   // next read re-fetches the updated map
}
// Bind a window to an ordered list of stashes (its image pages); empty list unbinds.
export async function setBindings(game, window, names) {
    await tfetch(`/api/captures/${encodeURIComponent(game)}/bindlist?window=${encodeURIComponent(window)}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(names) });
    invalidateBindings(game);
}
// A window's bound capture list (the route always returns an array; this guards legacy
// callers/undefined). Callers index it by the current page.
export async function bindingList(game, window) {
    const v = (await getBindings(game))[window];
    return Array.isArray(v) ? v.slice() : (v ? [v] : []);
}
