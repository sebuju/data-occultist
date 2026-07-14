// Window node wiring: rename/live/static-grid/preprocess/item-priority controls, the game
// node's window-priority list, the detects section (mode + per-detector polarity), and the
// readout + scrollbar node bodies (incl. scroll-cutout capture/drag-reorder). Split out of
// main.js; render/rebuildNode/autosave/nodeEdit/onValueEdit/rulesEdit/wireFieldRules/
// rebuildReadoutConsumers stay in main and are imported back.
import * as api from "../api.js";
import * as nodeTxn from "./node_txn.js";
import { model, openImages, imageCanvases, clearGrid, setStatus } from "./state.js";
import {
    closeImage, openImage, refreshImageBoxes, armPreprocessPick, refreshGridPreview,
    refreshReadoutValues, refreshRuleTrace, scheduleWindowRead,
} from "./imaging.js";
import { moveWindowPos, movePos, renameNode } from "./node_lifecycle.js";
import { panZoomTo } from "./camera.js";
import { renderLiveWindow, syncWpDots, liveCollecting } from "./panels/livewin.js";
import {
    render, rebuildNode, autosave, nodeEdit, onValueEdit, rulesEdit, wireFieldRules,
    rebuildReadoutConsumers,
} from "./main.js";

// Switch a detector between kinds by toggling the discriminating fields (the model infers
// kind from which are set — see detectKind in node_parts). text=OCR; color/border=cheap.
export function setDetectKind(a, kind) {
    if (kind === "text") { a.text = a.text ?? ""; delete a.color; delete a.width; }
    else {                                  // color or border (both cheap, no OCR)
        delete a.text;
        a.color = a.color ?? ""; a.tolerance = a.tolerance ?? 32;
        if (kind === "border") a.width = a.width || 0.1; else delete a.width;
    }
}

// Wire the window node's controls (extracted so rebuildNode can re-bind them
// without recreating the node — which would destroy the embedded image canvas).
export function wireWindowControls(div, n) {
    div.querySelector(".gi-id").addEventListener("change", async (e) => {
        const oldId = n.ref.id, newId = e.target.value.trim();
        const oldDs = model.datasetOf(n.ref);   // explicit dataset (if any) is independent of the window id
        if (!model.renameWindow(oldId, newId)) { e.target.value = oldId; return; }
        // The capture binding + open image are keyed by window id — carry them across so the
        // image canvas doesn't blank on rename. Move the binding (server), drop the old-keyed
        // canvas, then re-open under the new id (which loads from the moved binding). winPage rides
        // moveWindowPos below (remapNodeState carries every per-id store, this one included).
        const game = model.profile.name, wasOpen = openImages.has(oldId);
        try {
            const caps = await api.bindingList(game, oldId);   // all image pages move with the window
            if (caps.length) { await api.setBindings(game, newId, caps); await api.setBindings(game, oldId, []); }
        } catch { /* binding move failed -> image just reloads empty, not fatal */ }
        if (imageCanvases.has(oldId)) closeImage(oldId);
        moveWindowPos(oldId, newId);            // win + all child nodes (pos/size/collapse/tab/winPage/…)
        const newDs = model.datasetOf(n.ref);
        if (oldDs && newDs && newDs !== oldDs) movePos(`ds:${oldDs}`, `ds:${newDs}`);
        // a rename changes only the id/wiring — no pixels or boxes change, so DON'T trigger the
        // all-open-windows detect/preview refresh (autosave(null)). The reopened image below
        // re-detects just the renamed window.
        render();
        rebuildNode("game");   // refresh the game node's window-priority list — render() leaves an existing node body put
        autosave(null);
        if (wasOpen) await openImage(newId);    // restore the image against the moved binding
    });
    // this window's OCR-firing edits (preprocess + static grid) defer as one transaction
    const winEdit = (mutate) => nodeEdit(n.id, "read", mutate, () => autosave(n.ref.id));
    div.querySelector(".winlive")?.addEventListener("change", (e) => {
        nodeTxn.commitIfDirty();   // autosave(null) knob: nothing re-reads, so it never joined the txn — land one first
        model.setWindowLive(n.ref.id, e.target.checked);
        model._syncWindowPriority();   // add/drop this window from the game node's priority list
        rebuildNode("game");           // reflect the add/drop in the priority list now
        autosave(null);          // a live-view flag changes nothing other nodes re-read
        renderLiveWindow();       // reflect in the live panel's window list
    });
    div.querySelector(".winstatic")?.addEventListener("change", (e) => {
        winEdit(() => {
            model.setWindowStaticGrid(n.ref.id, e.target.checked);
            [...imageCanvases.keys()].includes(n.ref.id) && clearGrid(n.ref.id);   // grid<->locator
            // static toggles whether OCR locate applies — re-bind item nodes so their locate
            // radios enable/disable to match (rebuildNode keeps each item's live cutout canvas)
            for (const it of model.window(n.ref.id)?.items || []) rebuildNode(`item:${n.ref.id}:${it.id}`);
            refreshImageBoxes(n.ref.id);   // redraw guides; re-detect this window only, on commit
        });
    });
    div.querySelectorAll(".winscroll").forEach((inp) => inp.addEventListener("change", (e) => {
        nodeTxn.commitIfDirty();   // precapture-only knob (autosave(null)) — stays immediate
        const k = e.target.dataset.k;
        if (k === "autoscroll") {
            model.setScrollAutoscroll(n.ref.id, e.target.checked);
            rebuildNode(`win:${n.ref.id}`);   // show/hide the "auto-scroll clicks" flab
        } else if (k === "clicks") model.setScrollClicks(n.ref.id, Math.max(1, +e.target.value || 1));
        autosave(null);   // precapture-only knobs — the reader/preview never use them, so don't re-OCR
    }));
    // Text appearance (window-level OCR preprocess). Every knob changes what OCR SEES, so
    // autosave(winId) re-reads THIS window (unlike the precapture-only scroll knobs above).
    div.querySelector(".ppmode")?.addEventListener("change", (e) => {
        winEdit(() => {
            model.setPreprocessMode(n.ref.id, e.target.value);
            rebuildNode(`win:${n.ref.id}`);   // show/hide the colour controls for `color` mode
        });
    });
    div.querySelector(".pptol")?.addEventListener("input", (e) => {
        winEdit(() => model.setPreprocessTolerance(n.ref.id, +e.target.value));
    });
    div.querySelector(".ppscale")?.addEventListener("change", (e) => {
        winEdit(() => model.setPreprocessScale(n.ref.id, +e.target.value || 1));
    });
    div.querySelector(".pp-pick")?.addEventListener("click", () => armPreprocessPick(n.ref.id));
    div.querySelector(".pp-add")?.addEventListener("click", () => {
        const el = div.querySelector(".pp-hex"); const v = el.value.trim();
        if (/^#?[0-9a-fA-F]{6}$/.test(v)) winEdit(() => {
            model.addPreprocessColor(n.ref.id, v.startsWith("#") ? v : `#${v}`);
            rebuildNode(`win:${n.ref.id}`);
        });
    });
    div.querySelectorAll(".pp-cx").forEach((b) => b.addEventListener("click", () => {
        winEdit(() => {
            model.removePreprocessColor(n.ref.id, +b.dataset.i);
            rebuildNode(`win:${n.ref.id}`);
        });
    }));
    // reorder the item-template priority list: ▲/▼ swap a template up/down, re-numbering
    // priorities to match the new order (top = highest, bottom = 0 base). Base may change -> reread.
    div.querySelectorAll(".wimv").forEach((b) => b.addEventListener("click", () => {
        model.moveItemPriority(n.ref.id, b.dataset.id, +b.dataset.d);
        windowItemsReordered(n.ref.id);
    }));
    // click a template name -> jump to its item node (don't swallow the ▲/▼ button clicks)
    div.querySelectorAll(".wi-row .wi-name").forEach((el) => el.addEventListener("click", (e) => {
        panZoomTo(`item:${n.ref.id}:${el.closest(".wi-row").dataset.id}`);
    }));
    wireDetectsSection(div, n.ref.id);   // combine mode + per-detector polarity + name jumps
}

// The game node's window-priority list: ▲/▼ reorder (highest-priority on top) + click a name to
// jump to that window's node. Reorder persists window_priority and refreshes the list's disabled
// states. Bound on the initial build and re-bound by the _LIVE_SECTIONS rebuild (div = node el).
export function wireGamePriority(div) {
    div.querySelectorAll(".wpmv").forEach((b) => b.addEventListener("click", () => {
        if (model.moveWindowPriority(b.dataset.id, +b.dataset.d)) {
            rebuildNode("game");   // refresh order + ▲/▼ disabled ends
            autosave(null);        // priority only steers the live classifier — no node re-OCR
        }
    }));
    div.querySelectorAll(".wp-row .wp-name").forEach((el) => el.addEventListener("click", () => {
        panZoomTo(`win:${el.closest(".wp-row").dataset.id}`);
    }));
    syncWpDots();   // paint the freshly-built dots to current live recognition (no wait for the next tick)
}

// The detectors section (mode select + polarity selects + name jumps) on a window node. A
// change re-runs detect for that window (autosave re-OCRs it) so .wd-status/.wd-verdict refresh.
function wireDetectsSection(div, ownerId) {
    const saveDet = () => autosave(ownerId);
    div.querySelector(".wd-mode")?.addEventListener("change", (e) => {
        model.setDetectMode(ownerId, e.target.value); saveDet();
    });
    div.querySelectorAll(".wd-neg").forEach((sel) => sel.addEventListener("change", (e) => {
        model.setDetectNegate(ownerId, e.target.dataset.id, e.target.value === "absent"); saveDet();
    }));
    div.querySelectorAll(".wd-row .wd-name").forEach((el) => el.addEventListener("click", () => {
        panZoomTo(`det:${ownerId}:${el.closest(".wd-row").dataset.id}`);
    }));
}

// After a priority reorder: refresh the window's ordered list (arrows/disabled), rebuild
// every item node (the priority-0 base changed -> "match base" button visibility), drop the
// stale grid (base pitch may differ), and re-run this window's preview.
function windowItemsReordered(winId) {
    rebuildNode(`win:${winId}`);
    for (const it of model.window(winId)?.items || []) rebuildNode(`item:${winId}:${it.id}`);
    clearGrid(winId);
    refreshImageBoxes(winId);
    autosave(winId);
}

// Readout node (self-contained): its name (what a trigger watches) + the inline read-config
// (`.roset` on the linked FieldDef, exactly like a region node).
export function wireReadout(div, n) {
    const winId = n.win.id, vid = n.ref.id;
    const fld = n.field;
    // With live mode OFF the collector isn't feeding values, so read this readout's value off the
    // current image. `refetch` = immediate (node just OPENED — show a value right away, matches
    // scheduleItemRead's img.onload pattern). Only fired below when no edit txn is armed on this
    // node: fillNode re-runs this wiring on every rebuildNode (a type change, a rule add/remove),
    // and an unconditional refetch() there would OCR the box WHILE the edit is still uncommitted —
    // worse, /api/preview also feeds live registers, so a persist-set register would silently write
    // the dataset mid-edit. `scheduleRefetch` = an EDIT changed the read config — queue it on the
    // shared window-read clock (scheduleWindowRead) instead of firing its own separate un-debounced
    // fetch, so it settles in the SAME beat as the rest of that edit's fallout, once committed.
    const refetch = () => { if (!liveCollecting()) refreshReadoutValues(winId); };
    const scheduleRefetch = () => { if (!liveCollecting()) scheduleWindowRead(winId, { readouts: true }); };
    div.querySelector(".gi-id")?.addEventListener("change", (e) => {
        renameNode(e.target, vid,
            () => model.renameReadout(winId, vid, e.target.value.trim()),
            () => movePos(`ro:${winId}:${vid}`, `ro:${winId}:${n.ref.id}`),
            () => { render(); rebuildReadoutConsumers(); autosave(winId); });   // repoint toast chips + watch dropdown
    });
    // inline read-config, edited straight on the FieldDef (like a region). Only the
    // capture/confidence knobs live here; value processing is the rule pipeline (wired below).
    div.querySelectorAll(".roset").forEach((inp) => onValueEdit(inp, (e, live) => {
        if (!fld) return;
        const k = e.target.dataset.k;
        nodeEdit(n.id, "read", () => {
            if (k === "type") { fld.type = e.target.value; if (!live) rebuildNode(n.id); }  // re-filters the rule menus
            else if (k === "isolate") fld.isolate = e.target.checked;
            else if (k === "glyph_check") fld.glyph_check = e.target.checked;
            else if (k === "minconf") fld.min_confidence = +e.target.value || 0;
        }, () => { autosave(winId); scheduleRefetch(); });   // read config changed -> re-read the value off the current image
    }));
    if (fld) wireFieldRules(div, fld, {
        edit: rulesEdit(n.id, () => { autosave(winId); scheduleRefetch(); }),
        retrace: (el) => refreshRuleTrace(winId, fld.id, n.id, el),
    });
    // initial value off the current image — but ONLY on a genuine node-open, not a mid-edit
    // rebuild. While a config txn is armed the read is deferred to commit (scheduleRefetch
    // aftermath); firing here would OCR uncommitted. Mirrors the armed-gate in refreshRuleTrace.
    if (!nodeTxn.armed(n.id)) refetch();
}

// Scrollbar node: orientation + visible-rows, the cutout list (rows-from-top, remove,
// drag-reorder), capture, and auto-learn. All calibration knobs are collector-only -> save
// without re-OCR.
export function wireScrollbar(div, n) {
    const winId = n.win.id;
    // re-fit the gain from the cutouts after any change, refresh the node, save, and re-read the
    // window image so its row-index labels update (works even with the preview node closed).
    // refreshImageBoxes: the cutout count decides the box's locked flag on the window canvas.
    const relearn = () => { model.learnScrollGain(winId); rebuildNode(n.id); autosave(null); refreshGridPreview(winId); refreshImageBoxes(winId); };
    div.querySelectorAll(".sbset").forEach((inp) => inp.addEventListener("change", (e) => {
        if (e.target.dataset.k === "orient") { model.setScrollbarOrientation(winId, e.target.value); autosave(winId); }
    }));
    div.querySelectorAll(".sbcut[data-k='rows']").forEach((inp) => inp.addEventListener("change", (e) => {
        model.setScrollSampleRows(winId, +e.target.dataset.i, e.target.value); relearn();
    }));
    div.querySelectorAll(".sbcut-rm").forEach((b) => b.addEventListener("click", () => {
        model.removeScrollSample(winId, +b.dataset.i); relearn();
    }));
    div.querySelector(".sb-capture")?.addEventListener("click", () =>
        captureScrollCutout(n).catch((err) => setStatus(String(err.message || err), "err")));
    wireCutoutDrag(div, n);
}

// Crop the scrollbar region out of the open window image into a new cutout, ask the server for
// the thumb position, and add it as a calibration sample.
async function captureScrollCutout(n) {
    const winId = n.win.id;
    const src = imageCanvases.get(winId)?.overlay?.img;   // the raw window image (client area)
    if (!src || !src.naturalWidth) throw new Error("open the window image first (scroll it to a known position)");
    const box = model.scrollbar(winId);
    if (!box) throw new Error("draw a scrollbar box first");
    const cw = src.naturalWidth, ch = src.naturalHeight;
    const sx = Math.max(0, Math.round(box.x * cw)), sy = Math.max(0, Math.round(box.y * ch));
    const sw = Math.max(1, Math.round(box.w * cw)), sh = Math.max(1, Math.round(box.h * ch));
    const off = document.createElement("canvas");
    off.width = sw; off.height = sh;
    off.getContext("2d").drawImage(src, sx, sy, sw, sh, 0, 0, sw, sh);
    const img = off.toDataURL("image/png");
    const orientation = model.window(winId)?.scroll?.scrollbar_orientation || "vertical";
    let pos = null, conf = null, px = null, file = null;
    try {
        const r = await api.scrollPos(model.profile.name, img, orientation);
        pos = r.pos; conf = r.conf; px = r.thumb_px; file = r.name;
    } catch (e) { setStatus(`thumb read failed: ${e.message || e}`, "warn"); }
    if (!file) { setStatus("cutout save failed — not added", "err"); return; }
    model.addScrollSample(winId, { file, rows: 0, pos, conf, px });
    model.learnScrollGain(winId);             // re-fit with the new cutout
    rebuildNode(`sb:${winId}:scrollbar`);
    autosave(null);
    refreshGridPreview(winId);                // re-read the window image -> row-index labels update
    refreshImageBoxes(winId);                 // first cutout locks the box on the window canvas
}

// HTML5 drag-reorder of the cutout rows (drop onto another row moves before it).
function wireCutoutDrag(div, n) {
    const list = div.querySelector(".sb-cuts");
    if (!list) return;
    let from = null;
    list.querySelectorAll(".sb-cut").forEach((row) => {
        row.addEventListener("dragstart", (e) => { from = +row.dataset.i; e.dataTransfer.effectAllowed = "move"; });
        row.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; });
        row.addEventListener("drop", (e) => {
            e.preventDefault();
            const to = +row.dataset.i;
            if (from != null && from !== to) {
                model.moveScrollSample(n.win.id, from, to);
                model.learnScrollGain(n.win.id);   // reorder is cosmetic for the fit, but keep it in sync
                rebuildNode(n.id); autosave(null);
            }
            from = null;
        });
    });
}
