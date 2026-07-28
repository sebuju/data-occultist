// Overlay node handlers + the inline widget layout editor.
//
// The layout is edited IN THE NODE, over the bound window's CAPTURED frame — the live overlay is
// click-through (WS_EX_TRANSPARENT) and so cannot be dragged on the real game. Editing against a
// real captured frame is also what makes fractional geometry meaningful: the capture and the game
// client rect are the same rectangle, so what you see here is where it lands.
//
// Shared primitives used rather than re-implemented (rule 5):
//   makeDraggable / addResizeGrips - the one drag/resize loop (dragresize.js)
//   widgetDef / WIDGET_LIST        - the pretty widget registry, so a widget previews as the thing
//                                    it will actually be
//
// KNOWN DIVERGENCE: pretty's own canvas editor (pretty/canvas.js) is not reused — it is bound to
// pretty's page/profile model and px geometry. Placement therefore exists in two places (here and
// js/overlaywin/main.js); see the plan's open items.

import * as api from "../api.js";
import { h } from "../dom.js";
import { model, winPage, view, pos } from "./state.js";
import { placeAt } from "./node_layout.js";
import { makeDraggable, addResizeGrips } from "./dragresize.js";
import { widgetDef } from "../pretty/widgets/index.js";
import { overlayWidgetList } from "./overlay_node.js";
import { log } from "../log.js";

// --- config handlers (the rebuildable half) --------------------------------

// Called on first build AND after every `.ov-controls` rebuild (_LIVE_SECTIONS), so it must only
// touch that section — never the surface, which outlives it.
export function wireOverlayControls(el, n) {
    const id = n.ref.id;
    const ov = () => model.overlayNode(id);
    const save = () => import("./main.js").then((m) => m.autosave(null));

    el.querySelector(".ov-window")?.addEventListener("change", (ev) => {
        const o = ov(); if (!o) return;
        o.window = ev.target.value || "";
        o.states = [];                 // states belong to the old window — never carry them over
        save();
        import("./main.js").then((m) => m.rebuildNode(`overlay:${id}`));
        drawSurface(el, id);           // a new window means a new backdrop
    });
    el.querySelector(".ov-follow")?.addEventListener("change", (ev) => {
        const o = ov(); if (o) { o.follow_window = !!ev.target.checked; save(); }
    });
    el.querySelector(".ov-manual")?.addEventListener("change", (ev) => {
        const o = ov(); if (o) { o.manual = !!ev.target.checked; save(); }
    });
    el.querySelector(".ov-pulse")?.addEventListener("change", (ev) => {
        const o = ov(); if (o) { o.pulse_ms = Math.max(0, parseInt(ev.target.value, 10) || 0); save(); }
    });
    el.querySelectorAll(".ov-state-cb").forEach((cb) => cb.addEventListener("change", () => {
        const o = ov(); if (!o) return;
        o.states = [...el.querySelectorAll(".ov-state-cb")].filter((c) => c.checked)
            .map((c) => c.dataset.state);
        save();
    }));

    // Widget palette: one button per registered widget type.
    const palette = el.querySelector(".ov-palette");
    if (palette) {
        palette.replaceChildren(...overlayWidgetList().map((d) =>
            h("button", { class: "ov-add gi", type: "button", dataset: { type: d.type },
                title: `add a ${d.title} widget` }, d.title)));
        palette.addEventListener("click", (ev) => {
            const b = ev.target.closest("[data-type]");
            if (!b) return;
            const wid = model.addOverlayWidget(id, b.dataset.type);
            if (wid) placeWidgetNode(el, id, wid);
            persistOverlay(el, id, { structural: true });
        });
    }

    // Host capability: say WHY there's no overlay rather than leaving a silent dead node.
    const host = el.querySelector(".ov-host");
    if (host) {
        api.overlayHost().then((s) => {
            host.textContent = s.available ? "" : `overlay unavailable: ${s.reason}`;
            host.classList.toggle("conf-bad", !s.available);
        }).catch(() => { /* status is a hint; a failed probe just shows nothing */ });
    }
}

// Full first-build wiring: the controls, the test button (on the card, outside the rebuilt
// section), and the surface.
export function wireOverlayNode(el, n) {
    wireOverlayControls(el, n);
    const id = n.ref.id;
    el.querySelector(".ov-test")?.addEventListener("click", async () => {
        try {
            const r = await api.overlayPulse(model.profile.name, id);
            log(`overlay ${id}: pulsed${(r.visible || []).includes(id) ? "" : " (nothing to show — is the game running?)"}`);
        } catch (e) { log(`overlay test failed: ${e.message || e}`, "err"); }
    });
    drawSurface(el, id);
}

// Put a brand-new widget node beside its overlay rather than in the shared type column.
// ensurePositions places an unknown node by ABSOLUTE type column (node_layout COLX), which for a
// child node lands it wherever that column happens to be — potentially thousands of px from the
// overlay it belongs to, once the overlay has been moved. Stack them down the overlay's right side.
function placeWidgetNode(el, ovId, wid) {
    const p = pos.get(`overlay:${ovId}`);
    if (!p) return;
    const n = (model.overlayNode(ovId)?.widgets || []).length - 1;   // index of the one just added
    placeAt(`ovw:${ovId}:${wid}`, { x: p.x + (el.offsetWidth || 300) + 60, y: p.y + n * 150 });
}

// A widget edit is a normal profile save (debounced + undo-snapshotted by persist.js). Adding or
// removing a widget also adds/removes its NODE, so the graph itself has to re-render — a plain
// rebuild of this node would leave the widget node orphaned on the canvas.
function persistOverlay(el, id, { structural = false } = {}) {
    import("./persist.js").then((m) => m.persist.content(null));
    drawSurface(el, id);
    if (structural) import("./main.js").then((m) => m.render());
}

// --- the inline layout surface ---------------------------------------------

async function backdropFor(game, winId) {
    // The capture the window node is already bound to — same binding the window's own image surface
    // uses, so the overlay is laid out over the frame the user has been teaching against.
    //
    // A binding is a LIST of pages, not one name (a window can bind several captures), and the
    // window node shows whichever page `winPage` currently points at. Match that page.
    try {
        const bindings = await api.getBindings(game);
        const list = bindings && bindings[winId];
        const names = Array.isArray(list) ? list : (list ? [list] : []);
        if (!names.length) return null;
        const page = Math.min(Math.max(0, winPage.get(winId) || 0), names.length - 1);
        return api.captureUrl(game, names[page]);
    } catch { return null; }
}

export async function drawSurface(el, id) {
    const surface = el.querySelector(".ov-surface");
    if (!surface) return;
    const ov = model.overlayNode(id);
    if (!ov) return;

    const url = ov.window ? await backdropFor(model.profile.name, ov.window) : null;
    surface.style.backgroundImage = url ? `url("${url}")` : "";
    surface.classList.toggle("ov-nobg", !url);

    surface.replaceChildren(...(ov.widgets || []).map((w) => buildWidget(el, id, surface, w)));
}

function buildWidget(el, id, surface, w) {
    const frame = h("div", { class: `ov-w pw pw-t-${w.type}`, dataset: { id: w.id } });
    const place = () => {
        frame.style.left = `${(w.x || 0) * 100}%`;
        frame.style.top = `${(w.y || 0) * 100}%`;
        frame.style.width = `${(w.w || 0) * 100}%`;
        frame.style.height = `${(w.h || 0) * 100}%`;
    };
    place();
    const host = h("div", { class: "pw-content pw-host" });
    frame.appendChild(host);
    // Preview with the real widget implementation so the node shows the actual thing.
    const def = widgetDef(w.type);
    if (def) {
        try { def.create(host, w, editorCtx()); } catch { host.textContent = w.type; }
    } else {
        host.textContent = w.type;
    }
    const del = h("button", { class: "ov-wdel", type: "button", title: "remove this widget" }, "x");
    del.addEventListener("click", (ev) => {
        ev.stopPropagation();
        model.removeOverlayWidget(id, w.id);
        persistOverlay(el, id, { structural: true });
    });
    frame.appendChild(del);

    // Geometry is stored as FRACTIONS, so every drag/resize converts through the surface size.
    // beginDrag hands its callbacks the EVENT (not a delta), so deltas are computed here against
    // the position captured at mousedown.
    const rect = () => surface.getBoundingClientRect();
    const clamp = (v) => Math.max(0, Math.min(1, v));
    let sx = 0, sy = 0, bx = 0, by = 0;
    const dragTo = (ev) => {
        const r = rect();
        return { x: clamp(bx + (ev.clientX - sx) / r.width),
                 y: clamp(by + (ev.clientY - sy) / r.height) };
    };
    makeDraggable(frame, {
        onStart: (ev) => { sx = ev.clientX; sy = ev.clientY; bx = w.x || 0; by = w.y || 0; },
        onMove: (ev) => {
            const p = dragTo(ev);
            frame.style.left = `${p.x * 100}%`;
            frame.style.top = `${p.y * 100}%`;
        },
        onSettle: (ev) => {
            const p = dragTo(ev);
            w.x = p.x; w.y = p.y;
            place();
            import("./persist.js").then((m) => m.persist.content(null));
        },
    });
    // addResizeGrips writes el.style.width/height in px itself, so there is nothing to do per-move
    // — only convert the resulting box back into fractions on settle. place() then re-applies them
    // as percentages, replacing the px the grip left behind.
    //
    // `zoom` is REQUIRED: the grip turns a screen-space mouse delta into element px by dividing by
    // it, and these widgets live inside the transformed #gworld. Leaving it at the default 1 makes
    // the box drift away from the cursor at any zoom but 100% (the same accessor node_resize.js
    // passes for node grips).
    addResizeGrips(frame, {
        both: true,
        zoom: () => view.zoom,
        onSettle: () => {
            const r = rect(), fr = frame.getBoundingClientRect();
            w.w = Math.max(0.01, Math.min(1, fr.width / r.width));
            w.h = Math.max(0.01, Math.min(1, fr.height / r.height));
            place();
            import("./persist.js").then((m) => m.persist.content(null));
        },
    });
    return frame;
}

// The ctx a previewed widget sees in the NODE. Same minimal read-only shape the overlay page builds
// (js/overlaywin/main.js) — kept in step so a widget cannot behave differently in the two.
function editorCtx() {
    return {
        mode: "view",
        game: model.profile.name,
        model,
        data: { read: () => "", require() {}, release() {}, subscribe: () => () => {} },
        pretty: { theme: () => ({}) },
        currentPageId: () => "overlay",
        selectedWidget: () => null,
        selectionIds: () => [],
        requestSave: () => {},
        refresh: () => {},
    };
}

// --- the per-widget node ----------------------------------------------------

// A widget node edits the SAME object the surface renders, so every change redraws the parent
// overlay's surface — the two are two views of one model, never two copies of it.
export function wireOverlayWidgetNode(el, n) {
    const ovId = n.ov.id, wid = n.ref.id;
    const w = () => model.overlayWidget(ovId, wid);
    const parentEl = () => document.querySelector(`.gnode.overlay[data-id="overlay:${ovId}"]`)
        || [...document.querySelectorAll(".gnode.overlay")].find((x) => x.querySelector(".ov-surface"));
    const save = (structural = false) => {
        import("./persist.js").then((m) => m.persist.content(null));
        const p = parentEl();
        if (p) drawSurface(p, ovId);
        if (structural) import("./main.js").then((m) => m.render());
    };

    el.querySelector(".ovwrename")?.addEventListener("change", (ev) => {
        const next = ev.target.value.trim();
        if (!model.renameOverlayWidget(ovId, wid, next)) { ev.target.value = wid; return; }
        save(true);   // the node's own id changed -> the graph must re-key it
    });
    el.querySelector(".ovw-type")?.addEventListener("change", (ev) => {
        const x = w(); if (!x) return;
        x.type = ev.target.value;
        // A type swap changes which config keys exist, so the body has to rebuild too.
        save();
        import("./main.js").then((m) => m.rebuildNode(n.id));
    });
    el.querySelectorAll(".ovw-geom").forEach((inp) => inp.addEventListener("change", () => {
        const x = w(); if (!x) return;
        const k = inp.dataset.k;
        // Shown as percent, stored as a 0..1 fraction of the game's client rect.
        const v = parseFloat(inp.value);
        x[k] = Math.max(0, Math.min(1, (Number.isFinite(v) ? v : 0) / 100));
        save();
    }));
    el.querySelectorAll("input.ovw-cfg").forEach((inp) => inp.addEventListener("change", () => {
        const x = w(); if (!x) return;
        x.config = x.config || {};
        x.config[inp.dataset.k] = inp.type === "number"
            ? (Number.isFinite(parseFloat(inp.value)) ? parseFloat(inp.value) : 0)
            : inp.value;
        save();
    }));
    el.querySelectorAll(".ovw-cfgwrap .ovw-cfg-bool").forEach((cb) => cb.addEventListener("change", (ev) => {
        const x = w(); if (!x) return;
        x.config = x.config || {};
        x.config[ev.target.closest(".ovw-cfgwrap").dataset.k] = !!ev.target.checked;
        save();
    }));
}
