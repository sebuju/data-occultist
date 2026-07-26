// Window node wiring: rename/live/static-grid/preprocess/item-priority controls, the game
// node's window-priority list, the detects section (mode + per-detector polarity), and the
// readout + scrollbar node bodies (incl. scroll-cutout capture/drag-reorder). Split out of
// main.js; render/rebuildNode/autosave/nodeEdit/onValueEdit stay in main and are imported back.
import * as api from "../api.js";
import * as nodeTxn from "./node_txn.js";
import { model, openImages, imageCanvases, clearGrid, setStatus } from "./state.js";
import {
    closeImage, openImage, refreshImageBoxes, armPreprocessPick, openReadoutColorPick,
    refreshGridPreview, refreshReadoutValues, scheduleWindowRead,
    mountMatchPreview, refreshMatchPreviews,
} from "./imaging.js";
import { markColorCollisions, mergeColors, WD_MODE_OPTS, WD_MODE_DESC, WD_NEG_OPTS, WD_NEG_DESC, PP_MODES, PP_MODE_DESC } from "./node_parts.js";
import { makeClip } from "./clipboard.js";
import { selectionIds } from "./selection.js";
import { richPickerPop } from "./rich_picker.js";
import { moveWindowPos, movePos, renameNode } from "./node_lifecycle.js";
import { renderReadoutHistory } from "./readout_history_node.js";
import { panZoomTo } from "./camera.js";
import { renderLiveWindow, syncWpDots, liveCollecting } from "./panels/livewin.js";
import {
    render, rebuildNode, autosave, nodeEdit, onValueEdit,
    armConfirm,
} from "./main.js";

// Switch a detector between kinds by toggling the discriminating fields (the model infers
// kind from which are set — see detectKind in node_parts). text=OCR; color/border=cheap.
export function setDetectKind(a, kind) {
    if (kind === "text") { a.text = a.text ?? ""; delete a.colors; delete a.width; }
    else {                                  // color or border (both cheap, no OCR)
        delete a.text;
        a.colors = a.colors?.length ? a.colors : [""];   // seed one empty color row
        a.tolerance = a.tolerance ?? 32;
        if (kind === "border") a.width = a.width || 0.1; else delete a.width;
    }
}

// Shared wiring for the "Text appearance" preprocess controls (mode/tolerance/upscale/colour
// eyedropper + chips) — ONE implementation for BOTH the window node (WindowDef.preprocess) and
// a readout node's per-readout override (FieldDef.preprocess), rule 7. ``holder`` is the object
// that carries ``.preprocess``; ``edit(mutate)`` runs the mutation in the owner node's read
// transaction + save; ``nodeId`` is the node to rebuild (so `color`-mode controls show/hide and
// chips refresh); ``pick()`` arms the eyedropper for the right sink. Selectors are scoped to
// ``div`` (each node has its own), so window and readout controls never cross-fire.
// Cross-node preprocess colour clipboard (the shared primitive — rules and the sound forge hold
// their own clips): "copy" stashes this holder's colour list, "paste" MERGES it into another's.
// One clip at module scope, re-wired to each body as it's built; since window and readout
// preprocess share this wiring, a window's colours paste straight onto a readout override.
const ppColorClip = makeClip(".ppcolpaste");

// The OTHER multi-selected nodes a colour paste should also land on. A paste is a selection-wide
// action (like the toolbar's size paste): with several nodes selected, pasting into one of them
// fans out to every sibling that carries a preprocess block — window nodes (WindowDef) and readout
// nodes (FieldDef), the two holders wirePreprocess already serves. Returns [] for a single
// selection, or when the clicked node isn't part of the selection (then it's a plain one-node paste).
// Siblings NOT in `color` mode are skipped: their colour list is inert, and silently flipping their
// OCR mode is not what a paste asked for — the caller reports the skips.
function ppFanoutTargets(nodeId) {
    const ids = selectionIds();
    if (ids.length < 2 || !ids.includes(nodeId)) return { targets: [], skipped: 0 };
    const targets = [];
    let skipped = 0;
    for (const id of ids) {
        if (id === nodeId) continue;
        let holder = null, winId = null;
        if (id.startsWith("win:")) { winId = id.slice(4); holder = model.window(winId); }
        else if (id.startsWith("ro:")) { const [, w, ro] = id.split(":"); winId = w; holder = model.readoutFieldOf(w, ro); }
        if (!holder) continue;                                   // node type with no preprocess
        if ((model._ppOf(holder).mode || "none") !== "color") { skipped++; continue; }
        targets.push({ id, holder, winId });
    }
    return { targets, skipped };
}

function wirePreprocess(div, holder, { nodeId, winId, edit, pick }) {
    // colour list: hex inputs that collide (same colour, or within tolerance of another) go red.
    const remarkCollide = () => markColorCollisions(div.querySelectorAll(".pp-color"), model._ppOf(holder).colors || [], model._ppOf(holder).tolerance ?? 60);
    div.querySelector(".ppmode")?.addEventListener("click", (e) => {
        const btn = e.currentTarget;
        richPickerPop({
            anchor: btn, current: model._ppOf(holder).mode || "none",
            groups: [[null, PP_MODES.map(([v, l]) => ({ value: v, label: l, meta: PP_MODE_DESC[v] || "" }))]],
            onPick: (v) => { edit(() => { model._ppOf(holder).mode = v; rebuildNode(nodeId); }); },
        });
    });
    div.querySelector(".pptol")?.addEventListener("change", (e) => {
        edit(() => { model._ppOf(holder).tolerance = Math.max(0, Math.trunc(+e.target.value) || 0); });
        remarkCollide();               // tolerance change can create/clear a collision (doesn't rebuild)
        refreshMatchPreviews(winId);   // ...and changes which pixels the cutout preview paints
    });
    div.querySelector(".ppscale")?.addEventListener("change", (e) => {
        edit(() => { model._ppOf(holder).scale = +e.target.value || 1; });
    });
    // Detector split knobs: blank -> engine default (delete the key rather than store a
    // stale number), matching the "placeholder: default" UI. Neither needs a rebuild or
    // preview refresh — they change what the DETECTOR sees, not the mask/preview pixels.
    div.querySelector(".ppunclip")?.addEventListener("change", (e) => {
        const v = e.target.value === "" ? null : +e.target.value;
        edit(() => {
            if (v == null || Number.isNaN(v)) delete model._ppOf(holder).det_unclip_ratio;
            else model._ppOf(holder).det_unclip_ratio = v;
        });
    });
    div.querySelector(".ppboxthresh")?.addEventListener("change", (e) => {
        const v = e.target.value === "" ? null : +e.target.value;
        edit(() => {
            if (v == null || Number.isNaN(v)) delete model._ppOf(holder).det_box_thresh;
            else model._ppOf(holder).det_box_thresh = v;
        });
    });
    div.querySelector(".ppdenoise")?.addEventListener("change", (e) => {
        // UI is a percent (0-100); stored as a fraction of the largest blob's area.
        const pct = Math.min(100, Math.max(0, Math.trunc(+e.target.value) || 0));
        edit(() => { model._ppOf(holder).min_frac = pct / 100; });
        refreshMatchPreviews(winId);   // changes which blobs survive in the cutout preview
    });
    div.querySelector(".pp-pick")?.addEventListener("click", () => pick());   // ⊙ sample-from-image
    div.querySelector(".pp-coloradd")?.addEventListener("click", () => {      // ＋ add an empty row
        edit(() => { model._ppOf(holder).colors.push(""); rebuildNode(nodeId); });
    });
    // copy/paste the whole colour list (buttons ride the mode row). Paste MERGES + dedups rather
    // than replacing — see mergeColors; the rebuild re-runs remarkCollide, so a pasted colour that
    // is redundant within tolerance goes red immediately. With several nodes selected it lands on
    // ALL of them (ppFanoutTargets): the clicked node through its own transaction, the siblings as
    // a straight mutation + their own autosave (a node txn owns ONE surface at a time, so arming
    // one per sibling would just commit the previous — and their bodies aren't being edited).
    ppColorClip.wire(div, {
        copyCls: ".ppcolcopy", pasteCls: ".ppcolpaste",
        read: () => model._ppOf(holder).colors || [],
        write: (colors) => {
            const { targets, skipped } = ppFanoutTargets(nodeId);
            edit(() => {
                const pp = model._ppOf(holder);
                pp.colors = mergeColors(pp.colors || [], colors);
                rebuildNode(nodeId);
            });
            for (const t of targets) {
                const pp = model._ppOf(t.holder);
                pp.colors = mergeColors(pp.colors || [], colors);
                rebuildNode(t.id);
                autosave(t.winId);                     // preprocess changed -> persist + re-read that window
            }
            refreshMatchPreviews(winId);
            for (const t of targets) refreshMatchPreviews(t.winId);
            if (targets.length || skipped) {
                setStatus(`colours pasted to ${targets.length + 1} node${targets.length ? "s" : ""}`
                    + (skipped ? ` — ${skipped} selected node${skipped === 1 ? "" : "s"} skipped (not in colour mode)` : ""));
            }
        },
    });
    // native swatch (OS colour picker) and the editable hex both write colour[i] — same shape as a
    // colour detector's rows (rule 7).
    div.querySelectorAll(".pp-colorpick").forEach((inp) => inp.addEventListener("change", (e) => {
        edit(() => { model._ppOf(holder).colors[+e.target.dataset.i] = e.target.value; rebuildNode(nodeId); });
    }));
    div.querySelectorAll(".pp-color").forEach((inp) => inp.addEventListener("change", (e) => {
        edit(() => { model._ppOf(holder).colors[+e.target.dataset.i] = e.target.value.trim(); rebuildNode(nodeId); });
    }));
    // remove a colour row — the SAME armed remove button as a rule row / selection delete
    // (rule 7): armConfirm turns the button yellow via [data-armed="1"], a second click fires.
    div.querySelectorAll(".pp-coldel").forEach((b) => armConfirm(b, () => {
        edit(() => { model._ppOf(holder).colors.splice(+b.dataset.i, 1); rebuildNode(nodeId); });
    }, { silent: true, resetOnOutside: true }));
    remarkCollide();   // initial paint (add/remove/swatch/hex edits all rebuild -> re-run this)
}

// Wire the window node's controls (extracted so rebuildNode can re-bind them
// without recreating the node — which would destroy the embedded image canvas).
export function wireWindowControls(div, n) {
    div.querySelector(".gi-id").addEventListener("change", async (e) => {
        const oldId = n.ref.id, newId = e.target.value.trim();
        const oldDs = model.datasetOf(n.ref);   // explicit dataset (if any) is independent of the window id
        if (!model.renameWindow(oldId, newId)) {
            e.target.value = oldId;
            if (newId && newId !== oldId) setStatus(`Window "${newId}" already exists — rename skipped`, "warn");
            return;
        }
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
    wirePreprocess(div, model.window(n.ref.id), {
        nodeId: `win:${n.ref.id}`, winId: n.ref.id, edit: winEdit,
        pick: () => armPreprocessPick(n.ref.id),
    });
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
    div.querySelector(".wd-mode")?.addEventListener("click", (e) => {
        const btn = e.currentTarget;
        richPickerPop({
            anchor: btn, current: model.window(ownerId)?.detect_mode || "all",
            groups: [[null, WD_MODE_OPTS.map(([v, l]) => ({ value: v, label: l, meta: WD_MODE_DESC[v] || "" }))]],
            onPick: (v) => { model.setDetectMode(ownerId, v); btn.textContent = `<${(WD_MODE_OPTS.find(([x]) => x === v) || [, v])[1]}>`; saveDet(); },
        });
    });
    div.querySelectorAll(".wd-neg").forEach((btn) => btn.addEventListener("click", (e) => {
        const el = e.currentTarget, id = el.dataset.id;
        if (el.disabled) return;
        const cur = model.detect(ownerId, id)?.negate ? "absent" : "present";
        richPickerPop({
            anchor: el, current: cur,
            groups: [[null, WD_NEG_OPTS.map(([v, l]) => ({ value: v, label: l, meta: WD_NEG_DESC[v] || "" }))]],
            onPick: (v) => { model.setDetectNegate(ownerId, id, v === "absent"); el.textContent = `<${(WD_NEG_OPTS.find(([x]) => x === v) || [, v])[1]}>`; saveDet(); },
        });
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
            () => { render(); autosave(winId); });   // render()'s _refKey gate repoints toast chips + watch dropdown
    });
    // inline read-config, edited straight on the FieldDef (like a region). Only the
    // capture/confidence knobs live here; value processing is the rule pipeline (wired below).
    div.querySelectorAll(".roset").forEach((inp) => onValueEdit(inp, (e, live) => {
        if (!fld) return;
        const k = e.target.dataset.k;
        nodeEdit(n.id, "read", () => {
            if (k === "isolate") fld.isolate = e.target.checked;
            else if (k === "glyph_check") fld.glyph_check = e.target.checked;
            else if (k === "minconf") fld.min_confidence = +e.target.value || 0;
            else if (k === "corroborate") fld.corroborate = e.target.checked;
            else if (k === "confirm") fld.confirm = Math.max(1, parseInt(e.target.value, 10) || 1);
        }, () => { autosave(winId); scheduleRefetch(); });   // read config changed -> re-read the value off the current image
    }));
    // per-readout preprocess override: same shared controls as the window,
    // sunk into THIS readout's FieldDef (rule 7). Changes what OCR sees -> re-read on commit.
    if (fld) wirePreprocess(div, fld, {
        nodeId: n.id, winId, pick: () => openReadoutColorPick(winId, vid),   // modal: zoomed box cutout
        edit: (m) => nodeEdit(n.id, "read", m, () => { autosave(winId); scheduleRefetch(); refreshMatchPreviews(winId); }),
    });
    // initial value off the current image — but ONLY on a genuine node-open, not a mid-edit
    // rebuild. While a config txn is armed the read is deferred to commit (scheduleRefetch
    // aftermath); firing here would OCR uncommitted.
    if (!nodeTxn.armed(n.id)) refetch();
    // cutout preview: this readout's box, matched pixels painted when its preprocess masks a colour.
    mountMatchPreview(n.id, winId, div.querySelector(".mp-canvas"), () => n.ref.box, () => {
        const p = fld?.preprocess;
        // mask:true -> preview paints EVERY near-colour pixel (readout OCR keeps them all), not
        // the detector's largest-blob; minFrac mirrors the live denoise (drop small components).
        return p?.mode === "color" ? { colors: p.colors, tolerance: p.tolerance, mask: true, minFrac: p.min_frac || 0 } : {};
    });
    // paint the read-history satellite from the last heartbeat snapshot (no-op when it's hidden),
    // so a just-opened satellite shows immediately instead of waiting for the next beat.
    renderReadoutHistory(winId, vid);
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
    div.querySelector(".sbset")?.addEventListener("click", (e) => {
        const btn = e.currentTarget, cur = n.ref.scrollbar_orientation || "vertical";
        richPickerPop({
            anchor: btn, current: cur,
            groups: [[null, [["vertical", "vertical"], ["horizontal", "horizontal"]].map(([v, l]) => ({ value: v, label: l }))]],
            onPick: (v) => { model.setScrollbarOrientation(winId, v); btn.textContent = `<${v}>`; autosave(winId); },
        });
    });
    div.querySelectorAll(".sbcut[data-k='rows']").forEach((inp) => inp.addEventListener("change", (e) => {
        model.setScrollSampleRows(winId, +e.target.dataset.i, e.target.value); relearn();
    }));
    div.querySelectorAll(".sbcut-rm").forEach((b) => armConfirm(b, () => {
        model.removeScrollSample(winId, +b.dataset.i); relearn();
    }, { silent: true, resetOnOutside: true }));
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
