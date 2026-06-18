// Transient node-input overrides — the "pretty dirty" mechanism.
//
// A Pretty control writes a value into the LIVE shared model (so the node view reflects it)
// and POSTs it to the backend (so the running profile uses it) — but it is NEVER written to
// the authored YAML. We remember each overridden path's ORIGINAL authored value so we can
// revert, and `scrubForSave` hands persist.js a profile clone-of-behaviour where those paths
// read their original — so an unrelated node edit still saves everyone else while pretty
// values stay out of the YAML. "Save pretty to yaml" clears the dirty set first, so the next
// save bakes the live values in normally.

import { model } from "../graph/state.js";
import { clamp, inputMeta, nodeIdsForPath } from "./constraints.js";
import { pathGet, pathSet } from "./path.js";
import { notify } from "./data.js";
import * as papi from "./api.js";

let game = null;
const dirty = new Map();     // path -> original authored value

// Hooks injected by the node view (main.js) so this module never imports it (no cycle).
let _hooks = { rebuildNode: null, onChange: null, persistFlush: null };
export function setOverrideHooks(h) { _hooks = { ..._hooks, ...h }; }

function rebuildFor(path) {
    if (!_hooks.rebuildNode) return;
    for (const id of nodeIdsForPath(model, path)) _hooks.rebuildNode(id);
}
function fireChange() { _hooks.onChange && _hooks.onChange(); }

// Load any overrides the backend already holds (e.g. set earlier this session) and mirror
// them into the live model, marking the affected nodes dirty.
export async function initOverrides(g) {
    game = g;
    dirty.clear();
    try {
        const { overrides } = await papi.listOverrides(g);
        for (const [path, value] of Object.entries(overrides || {})) {
            if (!dirty.has(path)) dirty.set(path, pathGet(model.profile, path));
            pathSet(model.profile, path, value);
            notify(`node:${path}`);
            rebuildFor(path);
        }
    } catch { /* no backend overrides / offline — start clean */ }
    fireChange();
}

// Set one override: clamp to the node's real constraint, mirror into the model, push to the
// backend, and reflect it in the node view. The value affects the running profile at once.
export async function setOverride(path, rawValue) {
    const v = clamp(inputMeta(model, path), rawValue);
    if (v === undefined) return;
    if (!dirty.has(path)) dirty.set(path, pathGet(model.profile, path));
    pathSet(model.profile, path, v);
    notify(`node:${path}`);
    rebuildFor(path);
    fireChange();
    try { await papi.setOverride(game, path, v); } catch { /* backend offline — model still updated */ }
}

export function overrideValue(path) { return pathGet(model.profile, path); }

// Revert one path to its authored value (drops the override locally + on the backend).
export async function revert(path) {
    if (!dirty.has(path)) return;
    pathSet(model.profile, path, dirty.get(path));
    dirty.delete(path);
    notify(`node:${path}`);
    rebuildFor(path);
    fireChange();
    try { await papi.clearOverride(game, path); } catch { /* ignore */ }
}

export async function revertAll() {
    const paths = [...dirty.keys()];
    for (const path of paths) {
        pathSet(model.profile, path, dirty.get(path));
        notify(`node:${path}`);
    }
    dirty.clear();
    paths.forEach(rebuildFor);
    fireChange();
    try { await papi.clearOverride(game); } catch { /* ignore */ }
}

// Bake every override into the YAML: clear the dirty set FIRST (so the scrub no-ops and the
// live values save normally), force a profile save, then drop the backend's transient copies.
export async function commit() {
    if (!dirty.size) return;
    dirty.clear();
    fireChange();
    try { _hooks.persistFlush && (await _hooks.persistFlush()); } catch { /* surfaced by persist */ }
    try { await papi.clearOverride(game); } catch { /* ignore */ }
}

export function hasDirty() { return dirty.size > 0; }
export function dirtyCount() { return dirty.size; }
export function isNodeDirty(nodeId) {
    for (const path of dirty.keys()) if (nodeIdsForPath(model, path).includes(nodeId)) return true;
    return false;
}

// persist.js calls this before a profile save: temporarily restore the authored value at each
// overridden path and return a function that re-applies the live override values afterward.
// Net effect: pretty-dirty values never reach the YAML, but everything else saves.
export function scrubForSave(profile) {
    if (!dirty.size) return null;
    const live = new Map();
    for (const [path, orig] of dirty) {
        live.set(path, pathGet(profile, path));
        pathSet(profile, path, orig);
    }
    return () => { for (const [path, v] of live) pathSet(profile, path, v); };
}
