// The in-game overlay page: renders each overlay node's widgets over the game and shows/hides
// them off the server's `overlay` SSE event.
//
// Loaded ONLY by the transparent host window (oc/overlay/_overlay_child.py), never by the SPA.
// Navigated exactly ONCE per child process — a transparent pywebview window steals the foreground
// on every navigation — so everything after boot happens in-page.
//
// WHAT IS SHARED, AND WHAT IS NOT (rule 5):
//   shared  - the widget registry (pretty/widgets/index.js), the style system
//             (pretty/style.js), token binding (pretty/binding.js) and the data layer
//             (pretty/data.js). Widget behaviour has ONE implementation; this page is another
//             caller of it, not a copy.
//   not     - pretty's `renderPage` (canvas.js). That function is the EDITOR surface: config/style
//             profile previews, anchor cues, selection, resize observers, px geometry. The overlay
//             needs none of it and must position in fractions of the game's client rect. Composing
//             the registry directly here is smaller than bending renderPage into a headless mode.
//             KNOWN CONSEQUENCE: placement/anchoring logic now exists in two places, so a widget
//             can look different in the editor than on screen. See the plan's open items.
//
// Data arrives over the SAME SSE stream the SPA uses (pretty/data.js is push-primary), so this
// page adds no polling of its own.

import { model } from "../graph/state.js";
import * as data from "../pretty/data.js";
import { applyStyle, mergeStyle } from "../pretty/style.js";
import { widgetDef } from "../pretty/widgets/index.js";

const game = new URLSearchParams(location.search).get("game") || "";
const layersHost = document.getElementById("layers");

// overlay id -> { layer, recs: Map(widgetId -> {frame, host, inst}) }
const layers = new Map();
let overlays = [];              // OverlayDef list from the profile
let visible = new Set();

// The widget ctx. Deliberately minimal and READ-ONLY: widgets reach data through `ctx.data` and
// node-input tokens through `ctx.model.profile` (see pretty/binding.js resolveToken). Nothing here
// can mutate the profile — the overlay is a display, and an editing method reachable from it would
// be a way for a click-through window to write to the user's config.
const ctx = {
    mode: "view",
    game,
    model,
    data,
    // Widgets that ask for the page theme get the overlay's: no page chrome, no background (the
    // colour key must show through wherever a widget does not paint).
    pretty: { theme: () => ({}) },
    currentPageId: () => "overlay",
    // Editor-only surface, stubbed so a widget that probes for it degrades instead of throwing.
    selectedWidget: () => null,
    selectionIds: () => [],
    requestSave: () => {},
    refresh: () => {},
};

function fetchJSON(url) {
    return fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status} ${url}`))));
}

// --- rendering -------------------------------------------------------------

// Geometry is FRACTIONAL (0..1 of the game's client rect). The host window IS that rect, so a
// fraction maps straight onto a percentage of the viewport and a resolution change moves nothing.
function place(frame, w) {
    frame.style.left = `${(w.x || 0) * 100}%`;
    frame.style.top = `${(w.y || 0) * 100}%`;
    frame.style.width = `${(w.w || 0) * 100}%`;
    frame.style.height = `${(w.h || 0) * 100}%`;
    frame.style.zIndex = String(w.z || 1);
}

function buildLayer(ov) {
    const layer = document.createElement("div");
    layer.className = "occ-layer";
    layer.dataset.id = ov.id;
    const recs = new Map();
    for (const w of ov.widgets || []) {
        const def = widgetDef(w.type);
        if (!def) continue;
        const frame = document.createElement("div");
        frame.className = `pw pw-t-${w.type}`;
        frame.dataset.id = w.id;
        place(frame, w);
        applyStyle(frame, mergeStyle({}, w.style));
        const host = document.createElement("div");
        host.className = "pw-content";
        frame.appendChild(host);
        layer.appendChild(frame);
        let inst = { update() {}, destroy() {} };
        try {
            inst = def.create(host, w, ctx) || inst;
        } catch (e) {
            // A broken widget must not take the whole overlay down with it.
            host.textContent = String((e && e.message) || e);
        }
        host.classList.add("pw-host");
        recs.set(w.id, { frame, host, inst });
    }
    layersHost.appendChild(layer);
    layers.set(ov.id, { layer, recs });
}

function destroyLayers() {
    for (const { layer, recs } of layers.values()) {
        for (const rec of recs.values()) {
            try { rec.inst.destroy && rec.inst.destroy(); } catch { /* teardown must not throw */ }
        }
        layer.remove();
    }
    layers.clear();
}

// Show/hide is a class flip on an already-built layer — never a rebuild. The host window stays up
// while anything is visible, so this is the only thing that changes on a visibility event.
function applyVisible() {
    for (const [id, { layer }] of layers) layer.classList.toggle("on", visible.has(id));
}

// --- boot ------------------------------------------------------------------

async function boot() {
    if (!game) return;
    const profile = await fetchJSON(`/api/profiles/${encodeURIComponent(game)}`);
    // pretty/binding.js resolves `node:` tokens against this, and pretty/data.js reads it for
    // dataset/subset lookups — the same shared model object the SPA uses.
    model.profile = profile;
    overlays = (profile.overlays || []).filter((o) => o.enabled !== false);

    destroyLayers();
    for (const ov of overlays) buildLayer(ov);

    data.initData(game);
    data.startData();

    // Seed from the server's current truth, then follow the push. Without the seed an overlay that
    // was already visible when this page booted would stay blank until the set next changed.
    try {
        const cur = await fetchJSON(`/api/overlays/${encodeURIComponent(game)}/visible`);
        visible = new Set(cur.overlays || []);
        applyVisible();
    } catch { /* the stream will correct us on the next change */ }

    const es = new EventSource(`/api/events/${encodeURIComponent(game)}`);
    es.addEventListener("overlay", (ev) => {
        try {
            visible = new Set(JSON.parse(ev.data).overlays || []);
            applyVisible();
        } catch { /* a malformed frame must not kill the stream */ }
    });
}

boot();
