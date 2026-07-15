// Runtime CSS-var overrides for the node view's color palette (base.css `:root`), plus
// collision detection so vars that share a color today can be retuned together instead of
// one at a time. Session state is the live override map; collect()/hydrate() carry it in the
// game profile's layout.theme (see game_lifecycle.js), same funnel as node positions/groups.
import * as groups from "./groups.js";
import { drawEdges } from "./routing.js";
import { clearColorCache } from "./colors.js";

// Color tokens exposed by the theme panel, grouped to mirror base.css's own sections. One
// source of truth for the panel body AND collect/hydrate -- a var added here is the only
// place that needs touching to expose it. Font vars are deliberately excluded (colors only).
export const THEME_GROUPS = [
    { key: "surfaces", label: "surfaces", vars: [
        "--bg", "--panel", "--card-2", "--line", "--line-soft",
        "--float-panel", "--float-head", "--float-line", "--node-head", "--log-bg",
    ] },
    { key: "text", label: "text", vars: [
        "--text", "--muted", "--dim", "--log-fg", "--log-dim",
    ] },
    { key: "semantic", label: "semantic / status", vars: [
        "--accent", "--sel", "--sel-node", "--danger", "--ok", "--warn", "--record",
        "--trigger-line", "--watch-line", "--toast", "--sound", "--purple", "--window",
        "--neutral", "--phase-done", "--data",
    ] },
    { key: "nodeTypes", label: "node types", vars: [
        "--nt-game", "--nt-window", "--nt-region", "--nt-detect", "--nt-scrollbar", "--nt-item",
        "--nt-itemfield", "--nt-itemtell", "--nt-readout", "--nt-dataset", "--nt-subset",
        "--nt-producer", "--nt-dictionary", "--nt-trigger", "--nt-toast", "--nt-sound",
        "--nt-action", "--nt-register", "--nt-history", "--nt-filesource",
    ] },
    { key: "effects", label: "effects", vars: [
        "--hover", "--zebra", "--shadow",
    ] },
];
export const ALL_VARS = THEME_GROUPS.flatMap((g) => g.vars);

const overrides = new Map();     // "--var" -> value currently applied (mirrors profile.layout.theme.vars)
const _baseCache = new Map();    // "--var" -> compiled default, captured before any override ever lands

const root = () => document.documentElement;

// The var's compiled default from base.css's `:root` rule -- captured the FIRST time it's
// asked for and cached forever after. Must be one-shot: an override lives on the element's
// OWN inline style (higher specificity than `:root`), so re-reading after an override exists
// would return the override, not the base.
function baseValue(name) {
    if (_baseCache.has(name)) return _baseCache.get(name);
    const v = getComputedStyle(root()).getPropertyValue(name).trim();
    _baseCache.set(name, v);
    return v;
}
// Pre-warm every exposed var's default at module load, before hydrate() can ever run.
for (const name of ALL_VARS) baseValue(name);

export function effective(name) { return overrides.has(name) ? overrides.get(name) : baseValue(name); }
export function isOverridden(name) { return overrides.has(name); }

// Repaint everything that reads a CSS var through JS, not just the DOM cascade: the canvas
// group/edge renderer caches getComputedStyle reads (colors.js), so a var change needs an
// explicit invalidate + redraw or the canvas keeps showing the old color.
function repaint() {
    clearColorCache();
    groups.renderGroups();
    drawEdges();
}

// Set (or clear, val falsy / back to default) one var's live override + repaint. Caller owns
// WHEN to persist (theme.js has no opinion — the panel calls persist.layout() after).
export function applyVar(name, val) {
    if (!val || val === baseValue(name)) { overrides.delete(name); root().style.removeProperty(name); }
    else { overrides.set(name, val); root().style.setProperty(name, val); }
    repaint();
}

export function resetAll() {
    for (const name of overrides.keys()) root().style.removeProperty(name);
    overrides.clear();
    repaint();
}

// Vars that currently share the same effective color -> Map<hex, varName[]>, most-shared
// first. Only entries with 2+ members are real collisions; a lone var isn't "shared".
export function collisions() {
    const byVal = new Map();
    for (const name of ALL_VARS) {
        const v = effective(name);
        if (!v) continue;
        let arr = byVal.get(v);
        if (!arr) { arr = []; byVal.set(v, arr); }
        arr.push(name);
    }
    for (const [v, names] of byVal) if (names.length < 2) byVal.delete(v);
    return new Map([...byVal].sort((a, b) => b[1].length - a[1].length));
}

// Write every var in `names` to `val` in one shared-color edit -- one repaint, not one per var.
export function applySharedColor(names, val) {
    for (const name of names) {
        if (!val || val === baseValue(name)) { overrides.delete(name); root().style.removeProperty(name); }
        else { overrides.set(name, val); root().style.setProperty(name, val); }
    }
    repaint();
}

export function collect() {
    return overrides.size ? { vars: Object.fromEntries(overrides) } : undefined;
}
export function hydrate(theme) {
    for (const name of overrides.keys()) root().style.removeProperty(name);
    overrides.clear();
    const vars = theme?.vars;
    if (vars) for (const [name, val] of Object.entries(vars)) {
        if (!ALL_VARS.includes(name) || !val) continue;
        overrides.set(name, val);
        root().style.setProperty(name, val);
    }
    clearColorCache();   // the load path's own finishBoot() drives the one real repaint after this
}
