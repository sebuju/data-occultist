// The single owner of graph persistence. Nothing else in the front-end touches
// localStorage or the profile/graphlocal endpoints — every save/load funnels through
// here. It knows WHERE each piece of state lives:
//
//   • node CONFIG (positions, sizes, collapse, table widths, open images) → the
//     profile YAML, via the normal profile PUT. Travels with the game.
//   • per-device VIEWPORT (canvas zoom/pan, minimap) → a gitignored JSON sidecar.
//
// main.js stays the owner of the live state containers; it hands persist four small
// callbacks (collect/apply for each side) so this module never reaches into them.
//
// Saves are debounced. content() vs layout() both PUT the whole profile (which now
// carries `layout`); they differ only in whether the content-side callback fires (a
// preview/detect re-read). BOTH record an undo/redo snapshot — a node drag is undoable
// too — but only content() runs the preview re-read.

import * as api from "../api.js";
import { log } from "../log.js";
import { boot, afterBoot } from "./state.js";

let M = null;                 // the GraphModel
let collectLayout = null;     // () => write live node state into model.profile.layout
let collectLocal = null;      // () => ({ view, minimap }) for the sidecar
let onContentSaved = null;    // () => UI refresh after a real content save
let recordHistory = null;     // () => push an undo/redo snapshot (layout edits are undoable too)

let tProfile = null, tLocal = null;
let pendingContent = false;
const DEBOUNCE = 400;

// Pretty Studio injects a "scrub" here: before each save it temporarily restores any
// pretty-dirty node-input paths to their authored value (and returns an undo), so transient
// override values NEVER reach the YAML while everything else still saves. Null = no-op.
let scrubHook = null;
export function setScrubHook(fn) { scrubHook = fn; }

export function initPersist(opts) {
    M = opts.model;
    collectLayout = opts.collectLayout;
    collectLocal = opts.collectLocal;
    onContentSaved = opts.onContentSaved;
    recordHistory = opts.recordHistory;
}

async function flushProfile() {
    tProfile = null;
    if (!M?.profile?.name) return;
    collectLayout();                 // fold live node layout into the profile first
    const wasContent = pendingContent;
    pendingContent = false;
    const restore = scrubHook ? scrubHook(M.profile) : null;   // pretty values out of the YAML
    try {
        // A pure layout save (no content change) tells the server to skip the feed
        // re-pull + structural-snapshot diff — those only matter when content changed.
        await api.saveProfile(M.profile, false, !wasContent);
        if (wasContent) onContentSaved?.();
    } catch (e) {
        if (onContentSaved) onContentSaved(String(e.message || e));   // surface the error
    } finally {
        if (restore) restore();        // put the live override values back into the model
    }
}

// While a game is booting, every reopened image fires a layout save. Coalesce them all
// into ONE post-boot flush instead of racing the 400ms debounce against the OCR-warmup
// GIL storm — see afterBoot's doc comment (state.js). bootArmed guards against a double
// flush when persist.flush() (game-switch) drains the arm before flushBoot() gets to it.
let bootArmed = false;

function scheduleProfile(isContent) {
    if (isContent) pendingContent = true;
    if (boot.phase) {
        if (!bootArmed) {
            bootArmed = true;
            afterBoot(() => { if (!bootArmed) return; bootArmed = false; flushProfile(); });
        }
        return;
    }
    clearTimeout(tProfile);
    tProfile = setTimeout(flushProfile, DEBOUNCE);
}

async function flushLocal() {
    tLocal = null;
    if (!M?.profile?.name) return;
    try { await api.graphLocal.put(M.profile.name, collectLocal()); } catch (e) { log(`layout save failed: ${e.message || e}`, "warn"); }   // sidecar is best-effort
}

export const persist = {
    // A configuration edit: debounced profile save; fires onContentSaved on success.
    content() { scheduleProfile(true); },
    // A pure layout move (drag/resize/collapse/open-image): saved, but no UI side effects.
    // Records an undo snapshot (guarded internally: a no-op during an in-flight restore, and
    // identical snapshots dedup, so a boot-time re-save never spawns a phantom entry).
    layout() { recordHistory && recordHistory(); scheduleProfile(false); },
    // Viewport/minimap change: debounced sidecar save.
    local() { clearTimeout(tLocal); tLocal = setTimeout(flushLocal, DEBOUNCE); },

    // Force any pending saves out immediately (e.g. before switching games).
    async flush() {
        if (bootArmed) { bootArmed = false; await flushProfile(); }
        if (tProfile) { clearTimeout(tProfile); await flushProfile(); }
        if (tLocal) { clearTimeout(tLocal); await flushLocal(); }
    },

    // Load a game's profile + viewport sidecar, migrating any legacy localStorage once.
    // Returns { profile, local, migrated }; main.js does model.load + hydrate.
    async open(name) {
        const [profile, local] = await Promise.all([api.getProfile(name), api.graphLocal.get(name)]);
        const migrated = migrateLegacy(name, profile, local);
        return { profile, local, migrated };
    },
};

// ---- one-time migration off the old browser-localStorage scheme ------------------
// Old keys: `oc.graph.<name>` (positions/sizes/collapsed/openImages/view), `oc.nodemap`
// (minimap), `octbl:<id>` (table column state). Import into profile.layout + sidecar,
// then delete them. Runs only while the profile has no layout yet, so it never clobbers
// authored layout. Returns true if anything was imported (so main can persist it).
function migrateLegacy(name, profile, local) {
    let migrated = false;
    const hasLayout = profile.layout?.nodes && Object.keys(profile.layout.nodes).length;
    const rawStr = localStorage.getItem(`oc.graph.${name}`);
    if (rawStr && !hasLayout) {
        try {
            const raw = JSON.parse(rawStr);
            const L = (profile.layout = profile.layout || {});
            const nodes = (L.nodes = {});
            for (const [id, p] of Object.entries(raw.positions || {})) {
                if (Number.isFinite(p?.x) && Number.isFinite(p?.y)) nodes[id] = { x: p.x, y: p.y };
            }
            for (const [id, s] of Object.entries(raw.nodeSizes || {})) {
                nodes[id] = { ...(nodes[id] || { x: 0, y: 0 }), w: s.w, h: s.h };
            }
            for (const id of raw.collapsed || []) {
                nodes[id] = { ...(nodes[id] || { x: 0, y: 0 }), collapsed: true };
            }
            L.open_images = raw.openImages || [];
            L.tables = L.tables || {};
            for (const lk of localStorageKeys("octbl:")) {
                try { L.tables[lk.slice(6)] = JSON.parse(localStorage.getItem(lk)); } catch { /* skip */ }
            }
            if (raw.view) local.view = raw.view;
            migrated = true;
        } catch { /* corrupt legacy blob — ignore */ }
    }
    const nm = localStorage.getItem("oc.nodemap");
    if (nm && !local.minimap) { try { local.minimap = JSON.parse(nm); migrated = true; } catch { /* ignore */ } }

    // wipe the legacy keys regardless, so the app never reads localStorage again
    localStorage.removeItem(`oc.graph.${name}`);
    localStorage.removeItem("oc.nodemap");
    for (const lk of localStorageKeys("octbl:")) localStorage.removeItem(lk);
    return migrated;
}

function localStorageKeys(prefix) {
    const out = [];
    for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix)) out.push(k);
    }
    return out;
}
