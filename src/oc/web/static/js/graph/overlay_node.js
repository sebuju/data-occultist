// Overlay node body: bind a window, choose what makes it visible, and lay the widgets out —
// all inside the node, over the window's captured frame.
//
// The overlay itself is drawn by a transparent child window over the game (oc/overlay/), not here.
//
// Shape mirrors the WINDOW node: a rebuildable controls section (`.ov-controls`) plus a live
// surface (`.ov-surface`) that a full node rebuild must not destroy. That split is what lets the
// widget list refresh on every edit while the backdrop image and widget DOM stay put — see
// `_LIVE_SECTIONS` in main.js.

import { h, frag, labCell, srcRow, subhead } from "../dom.js";
import { sourcesInput } from "./sources_input.js";
import { slideToggle } from "./node_parts.js";
import { iconFor } from "./node_icons.js";
import { widgetDef, WIDGET_LIST } from "../pretty/widgets/index.js";

// Widget types an overlay can actually use. The overlay window is click-through
// (WS_EX_TRANSPARENT) so nothing on it can ever be interacted with — button/control/form exist to
// take input and would be dead weight here. Display-only types only.
const OVERLAY_WIDGET_TYPES = ["label", "table", "chart", "container", "panel"];
export const overlayWidgetList = () => WIDGET_LIST.filter((d) => OVERLAY_WIDGET_TYPES.includes(d.type));

// Which window's client rect the overlay is anchored to. Window nodes are screens of the SAME OS
// window, so this picks the geometry basis AND (with follow_window) the state that shows it.
function windowSelect(x, model) {
    const wins = (model?.profile?.windows || []).map((w) => w.id);
    return h("select", { class: "ov-window gi", title: "the window this overlay is anchored to and sized against" },
        h("option", { value: "", selected: !x.window }, "<none>"),
        wins.map((id) => h("option", { value: id, selected: x.window === id }, id)));
}

// Detect states of the bound window that show the overlay. Empty = any state of that window.
function statesRow(x, model) {
    const win = (model?.profile?.windows || []).find((w) => w.id === x.window);
    const all = (win?.states || []).map((s) => (typeof s === "string" ? s : s.id)).filter(Boolean);
    if (!all.length) return null;
    const on = new Set(x.states || []);
    return frag(
        labCell("states", "limit the overlay to these detect states of the bound window. None ticked = any state."),
        h("div", { class: "ov-states" }, all.map((s) =>
            h("label", { class: "ov-state" },
                h("input", { type: "checkbox", class: "ov-state-cb", dataset: { state: s }, checked: on.has(s) }),
                h("span", {}, s)))));
}

// The rebuildable half: everything that changes when the config changes. Kept OUT of the surface
// so an edit never tears down the backdrop or the widget DOM.
export function overlayControls(x, model) {
    const wired = model ? model.overlaySources(x.id) : [];
    const avail = () => (model ? model.sourceCandidates("overlay", x.id).map((c) => c.ref) : []);
    return frag(
        srcRow("sources",
            "wired data feeders — a readout, dataset, or subset whose live value the widgets can interpolate as a {{token}}. Add here, or drag a node's out-port onto this overlay.",
            sourcesInput({
                chips: wired.map((s) => ({ value: s.ref, node: model && model.refNode(s.ref) })),
                free: avail, addinCls: "sv-addin ov-addsrc", rmCls: "sv-rmin ov-rmsrc" })),
        labCell("window", "the window this overlay draws over — its client rect is the coordinate space, so widget positions survive a resolution change"),
        windowSelect(x, model),
        labCell("follow window", "show while the bound window is the live recognised screen"),
        slideToggle({ on: x.follow_window !== false, cls: "ov-follow", title: "show while the bound window is live" }),
        statesRow(x, model),
        labCell("pulse", "how long a trigger fire shows this overlay (ms). 0 = leave it to the other visibility rules."),
        h("input", { class: "ov-pulse", type: "number", min: "0", step: "250", value: x.pulse_ms ?? 4000 }),
        labCell("manual", "force the overlay on, ignoring the window/gate rules — for authoring and testing"),
        slideToggle({ on: !!x.manual, cls: "ov-manual", title: "force this overlay visible" }),
        subhead("widgets", null,
            "drag to move, grips to resize — positions are fractions of the window, so they survive a resolution change"),
        // Own full-width row: the subhead's button slot is sized for a couple of icon buttons, and
        // the registry yields one TEXT button per widget type, which crushes them into it.
        h("div", { class: "ov-palette" }),   // filled by overlay_wire from the widget registry
        // Host capability line, filled from GET /api/overlays/host so a missing dependency reads as
        // a message instead of a window that never appears.
        h("div", { class: "ov-host muted" }));
}

export function overlayParts(x, model) {
    return {
        title: h("input", { class: "gi gi-id ovrename", value: x.id, title: "rename overlay" }),
        body: frag(
            h("div", { class: "ov-controls gn-grid" }, overlayControls(x, model)),
            // The live layout surface: the bound capture with the widgets on it. Built once by
            // overlay_wire.js and preserved across rebuilds (_LIVE_SECTIONS).
            h("div", { class: "ov-surface" })),
        foot: h("button", { class: "ov-test", title: "show this overlay now for its pulse duration" },
            iconFor("overlay"), "test"),
    };
}


// ---- one node per widget --------------------------------------------------
// A widget is its own node (like a window's regions/readouts), so its settings are real inputs
// instead of a row in a list. Geometry is shown in PERCENT because that is what a fraction of the
// game's client rect reads as; the model stores 0..1.

const pct = (v) => Math.round(((v || 0) * 100) * 10) / 10;

// Per-type config inputs, derived from the widget module's own defaults() merged over the widget's
// current config — so a new widget type gets an editor for free instead of needing a branch here.
// Input kind follows the DEFAULT's type (the authored shape), not the current value, so a blanked
// number field doesn't silently become a text box.
function configRows(w) {
    const def = widgetDef(w.type);
    const defaults = (def?.defaults?.() || {}).config || {};
    const keys = [...new Set([...Object.keys(defaults), ...Object.keys(w.config || {})])];
    if (!keys.length) return null;
    return frag(...keys.map((k) => {
        const proto = defaults[k];
        const cur = (w.config || {})[k];
        const val = cur === undefined ? proto : cur;
        const common = { class: "ovw-cfg", dataset: { k } };
        if (typeof proto === "boolean" || typeof val === "boolean")
            // slideToggle owns its own markup, so the key rides a wrapper the handler reads via
            // closest() rather than being stamped on the input itself.
            return frag(labCell(k, `${k} (${w.type})`),
                h("div", { class: "ovw-cfgwrap", dataset: { k } },
                    slideToggle({ on: !!val, cls: "ovw-cfg-bool", title: k })));
        if (typeof proto === "number" || (proto === undefined && typeof val === "number"))
            return frag(labCell(k, `${k} (${w.type})`),
                h("input", { ...common, type: "number", value: val ?? "" }));
        return frag(labCell(k, `${k} (${w.type}) — supports {{tokens}}`),
            h("input", { ...common, value: val ?? "" }));
    }));
}

export function overlayWidgetParts(w, ov) {
    return {
        title: h("input", { class: "gi gi-id ovwrename", value: w.id, title: "rename widget" }),
        body: frag(
            labCell("type", "which widget this is — display-only types, since the overlay is click-through"),
            h("select", { class: "ovw-type gi" },
                overlayWidgetList().map((d) =>
                    h("option", { value: d.type, selected: w.type === d.type }, d.title))),
            labCell("x / y", "position as a percentage of the game window's client rect — survives a resolution change"),
            h("div", { class: "ovw-xy" },
                h("input", { class: "ovw-geom", dataset: { k: "x" }, type: "number", step: "0.5", value: pct(w.x) }),
                h("input", { class: "ovw-geom", dataset: { k: "y" }, type: "number", step: "0.5", value: pct(w.y) })),
            labCell("w / h", "size as a percentage of the client rect"),
            h("div", { class: "ovw-xy" },
                h("input", { class: "ovw-geom", dataset: { k: "w" }, type: "number", step: "0.5", value: pct(w.w) }),
                h("input", { class: "ovw-geom", dataset: { k: "h" }, type: "number", step: "0.5", value: pct(w.h) })),
            configRows(w),
            h("div", { class: "ovw-owner muted" }, `on overlay: ${ov.id}`)),
    };
}
