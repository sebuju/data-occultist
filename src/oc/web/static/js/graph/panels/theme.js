// Theme floating panel (node view): live CSS-var color overrides for base.css's `:root`
// palette + a manager for every custom group color scheme. Mirrors toolbox.js's shape
// (session-only geometry, createFloatWin, $("themeBtn") toggle) -- see panels_init.js for the
// button wiring + shift-reset registration.
import { h, fieldset } from "../../dom.js";
import { $ } from "../state.js";
import { createFloatWin } from "../floatwin.js";
import { persist } from "../persist.js";
import { colorField } from "../colorfield.js";
import * as theme from "../theme.js";
import * as groups from "../groups.js";

export const themeState = { visible: false, x: null, y: null, w: 300, h: null, collapsed: false };
export let tw = null;

let unsubscribeSchemes = null;
const _varFields = new Map();   // "--var" -> colorField instance (resynced after a shared/reset edit)
let sharedHost = null;
let schemesHost = null;

// The "shared colors" section: vars that currently resolve to the same value, over ONE
// colorField per distinct value -- editing it rewrites every member var at once. Rebuilt only
// on commit (blur / picker-close), never on a live drag tick, so it never yanks a control out
// from under an in-progress edit (its own, or a sibling var row's).
function renderSharedSection() {
    if (!sharedHost) return;
    const coll = theme.collisions();
    if (!coll.size) { sharedHost.replaceChildren(h("div", { class: "gp-mgr-empty" }, "no vars currently share a color")); return; }
    const rows = [...coll].map(([val, names]) => {
        const cf = colorField({
            value: val, colorClass: "gp-mgr-c", textClass: "gp-mgr-t",
            onChange: (v) => {
                theme.applySharedColor(names, v);
                persist.layout();
                for (const n of names) _varFields.get(n)?.set(v);
            },
            onCommit: () => renderSharedSection(),
        });
        return h("div", { class: "gp-mgr-crow" },
            h("span", { class: "gp-mgr-clab", title: names.join(", ") },
                `${names.length}× ${names.map((n) => n.replace(/^--/, "")).join(", ")}`),
            cf.row);
    });
    sharedHost.replaceChildren(...rows);
}

function varRow(name) {
    const cf = colorField({
        value: theme.effective(name), title: name, clearTitle: "reset to default",
        onChange: (v) => { theme.applyVar(name, v); persist.layout(); },
        onCommit: () => renderSharedSection(),
        onClear: () => theme.applyVar(name, ""),
    });
    _varFields.set(name, cf);
    return h("div", { class: "gp-mgr-crow" }, h("span", { class: "gp-mgr-clab" }, name.replace(/^--/, "")), cf.row);
}

function resetAllBtn() {
    const b = h("button", { class: "theme-reset", title: "reset every var to its default" }, "reset all to default");
    b.addEventListener("click", () => {
        theme.resetAll();
        persist.layout();
        for (const [name, cf] of _varFields) cf.set(theme.effective(name));
        renderSharedSection();
    });
    return b;
}

// Resync every control from live state -- called after a game load (theme.hydrate /
// groups.hydrateSchemes just ran) so a stale panel never shows the PREVIOUS game's colors.
export function refreshTheme() {
    if (!tw) return;
    for (const [name, cf] of _varFields) cf.set(theme.effective(name));
    renderSharedSection();
    if (schemesHost) groups.renderSchemeManager(schemesHost, () => {});
}

export function buildTheme() {
    if (tw) return tw;
    tw = createFloatWin({
        id: "graph-theme", title: "theme", state: themeState, bothAxes: true, autoFit: false,
        onShow: () => {
            $("themeBtn")?.classList.toggle("active", true);
            unsubscribeSchemes = groups.onSchemesChanged(() => schemesHost && groups.renderSchemeManager(schemesHost, () => {}));
            refreshTheme();
        },
        onHide: () => {
            $("themeBtn")?.classList.toggle("active", false);
            unsubscribeSchemes?.(); unsubscribeSchemes = null;
        },
        onPersist: () => persist.layout(),
    });

    sharedHost = h("div", { class: "gp-mgr-list" });
    schemesHost = h("div", { class: "gp-mgr-list" });
    renderSharedSection();
    groups.renderSchemeManager(schemesHost, () => {});

    tw.body.replaceChildren(
        fieldset("shared colors", sharedHost, "theme-shared"),
        ...theme.THEME_GROUPS.map((g) =>
            fieldset(g.label, h("div", { class: "gp-mgr-list" }, ...g.vars.map(varRow)), `theme-${g.key}`)),
        fieldset("schemes", schemesHost, "theme-schemes"),
        resetAllBtn(),
    );
    return tw;
}
