// Item / field / tell node wiring: the per-item cell-size + record-key controls, and the
// per-field / per-tell config nodes that split out of the item body. Every edit funnels through
// the shared update paths here (itemChanged / fieldChanged / tellChanged -> itemPaint + itemRead)
// so rebuild / box-redraw / grid-invalidate / cutout-reread / persist happen in the one right
// order. Split out of main.js; the shared rule-pipeline editor (wireFieldRules), the deferred-edit
// wrappers (nodeEdit / rulesEdit / onValueEdit) and inheritGroupFrom stay in main and are imported
// back. Also groups freshly-drawn field/tell child nodes with their item.
import * as api from "../api.js";
import * as groups from "./groups.js";
import * as nodeTxn from "./node_txn.js";
import { model, nodeEls, clearGrid } from "./state.js";
import { renameNode, moveItemPos, movePos } from "./node_lifecycle.js";
import { panZoomTo } from "./camera.js";
import { wireTools } from "./drawtool.js";
import {
    refreshItemBoxes, refreshImageBoxes, scheduleItemRead,
    setItemCellKeepingChildren, refreshItemReadout,
} from "./imaging.js";
import {
    render, autosave, rebuildNode, nodeEdit,
    onValueEdit, rulesEdit, wireFieldRules, inheritGroupFrom, armConfirm,
} from "./main.js";
import { richPickerPop } from "./rich_picker.js";
import { comboPopover } from "./combo_popover.js";
import {
    TYPES, TYPE_DESC, ALIGN_Y_OPTS, ALIGN_Y_DESC, ALIGN_X_OPTS, ALIGN_X_DESC,
    MATCH_MODES, MATCH_MODE_DESC, STRIP_MODES, STRIP_MODE_DESC,
} from "./node_parts.js";
import { TELL_KINDS } from "./imaging.js";

function syncCellSize(winId, itemId) {
    const node = nodeEls.get(`item:${winId}:${itemId}`), it = model.item(winId, itemId);
    if (!node || !it || !it.box) return;
    for (const k of ["w", "h"]) {
        const inp = node.querySelector(`.csize[data-k="${k}"]`);
        if (inp && document.activeElement !== inp) inp.value = +(+it.box[k]).toFixed(4);
    }
}


// THE single update path after ANY item edit. Every item handler calls this instead of
// hand-assembling rebuild/clear/refresh/read/save combos (which drifted and kept missing a
// step). Order matters: rebuild/render the DOM first, then redraw boxes + invalidate the
// stale window grid, re-read the cutout (item readout + tints), and persist — autosave's
// refresh re-runs the open window preview so the window canvas re-detects too.
//   rebuild: rebuild the item node DOM (the edit changed which controls show)
//   render:  full graph render (the edit changed nodes/edges — id rename, dict link)
//   reread:  the edit changed what/where OCR reads (geometry, tells, fields). FALSE for
//            edits that touch neither pixels nor boxes (id rename, record-key identity) —
//            skip the costly cutout re-read + window preview re-OCR for those.
function itemChanged(winId, itemId, opts = {}) {
    itemPaint(winId, itemId, opts);
    itemRead(winId, itemId, opts.reread ?? true)();
}

// The two halves, split so a deferred edit can run the cheap one now and the expensive one on
// commit. `itemPaint` only touches the DOM/overlay; `itemRead` returns the thunk that invalidates
// the grid, re-reads the cutout and persists — the part whose setNodeBusy would blur the input.
function itemPaint(winId, itemId, { rebuild = false, render: doRender = false } = {}) {
    if (doRender) render();
    else if (rebuild) rebuildNode(`item:${winId}:${itemId}`);
    refreshItemBoxes(winId, itemId);   // item cutout boxes
    refreshImageBoxes(winId);          // window image boxes + grid guides
}
const itemRead = (winId, itemId, reread = true) => () => {
    if (reread) {
        clearGrid(winId);                // detected window grid is now stale
        scheduleItemRead(winId, itemId); // re-read the cutout -> readout + box tints
    }
    autosave(reread ? winId : null);           // persist; re-run this window's preview/detect only when reread
};

// Wire an item node's id + tells/fields lists (rebuildNode re-binds these,
// preserving the live cutout canvas). Every edit funnels through itemChanged().
function wireItemControls(div, n) {
    const winId = n.win.id, itemId = n.ref.id;
    div.querySelectorAll(".csize").forEach((inp) => inp.addEventListener("change", (e) => {
        const it = model.item(winId, itemId);
        if (!it || !it.box) return;
        const k = e.target.dataset.k, v = +e.target.value;
        if (!(v > 0)) { e.target.value = +(+it.box[k]).toFixed(4); return; }   // reject 0/blank
        nodeEdit(n.id, "read", () => {
            setItemCellKeepingChildren(winId, itemId, { ...it.box, [k]: v });   // resize, keep fields put
            itemPaint(winId, itemId);
        }, itemRead(winId, itemId));
    }));
    div.querySelector(".csize-match")?.addEventListener("click", () => {
        const it = model.item(winId, itemId);
        const base = (n.win.items || []).find((x) => (x.priority || 0) === 0);   // the grid's base cell
        if (!it || !it.box || !base || !base.box) return;
        setItemCellKeepingChildren(winId, itemId, { ...it.box, w: base.box.w, h: base.box.h });
        itemChanged(winId, itemId); syncCellSize(winId, itemId);   // copy P0 w/h, reflect in inputs
    });
    // min-coverage (occlusion guard) — stored as a 0..1 fraction, edited as a %. Re-read so the
    // canvas immediately reflects which cells the new threshold dismisses.
    div.querySelectorAll(".ccover").forEach((inp) => inp.addEventListener("change", (e) => {
        const it = model.item(winId, itemId);
        if (!it) return;
        const axis = e.target.dataset.k;
        model.setItemCover(winId, itemId, axis, +e.target.value || 0);
        itemChanged(winId, itemId);
    }));
    // terminator toggle — pure config (no pixels change), so persist without a re-read
    div.querySelector(".iterm")?.addEventListener("change", (e) => {
        model.setItemTerminator(winId, itemId, e.target.checked);
        itemChanged(winId, itemId, { reread: false });
    });
    div.querySelector(".gi-id").addEventListener("change", (e) => {
        renameNode(e.target, itemId,
            () => model.renameItem(winId, itemId, e.target.value.trim()),
            () => moveItemPos(winId, itemId, n.ref.id),   // carry the item AND its field/tell child nodes (no jump)
            () => { itemChanged(winId, n.ref.id, { render: true, reread: false }); rebuildNode(`win:${winId}`); });   // id only — no pixels/boxes change; refresh the window's items list too
    });
    // the merged fields/tells table has no indirect removal buttons — a field/tell is removed on
    // its OWN node. A row click just pans to that child node (its box is selectable on the cutout).
    div.querySelectorAll(".mr-row").forEach((row) => row.addEventListener("mousedown", () => {
        if (row.dataset.fid) panZoomTo(`fld:${winId}:${itemId}:${row.dataset.fid}`);
        else if (row.dataset.tid) panZoomTo(`tell:${winId}:${itemId}:${row.dataset.tid}`);
    }));
    // cutout draw-mode buttons live in the node body now: pick the active draw kind. The canvas
    // overlay reads the armed tool off this node (see openItemImage's kindOf). wireTools marks the
    // whole node as the tool host so right-click / Escape / click-outside can drop the tool centrally.
    wireTools(div);
    // record-key config: mutate the item's own KeyDef (created from the effective one on
    // first edit). The key preview recomputes from the cached read; itemChanged rebuilds.
    const keyEdit = (fn) => {
        const k = model.ensureItemKey(winId, itemId);
        if (!k) return;
        fn(k);
        itemChanged(winId, itemId, { rebuild: true, reread: false });   // record identity only — no OCR change
        refreshItemReadout(winId, itemId);   // the key lives in the merged table now; refresh it (the re-read is debounced)
    };
    div.querySelectorAll(".kfield").forEach((btn) => btn.addEventListener("click", (e) => {
        const b = e.currentTarget, i = +b.dataset.i;
        const k = model.effectiveItemKey(winId, itemId);
        const fid = (k.fields || [])[i];
        const it = model.item(winId, itemId);
        const fids = [...new Set((it?.fields || []).map((f) => f.field))];
        richPickerPop({
            anchor: b, current: fid,
            groups: [[null, (fids.includes(fid) ? fids : [fid, ...fids]).map((f) => ({ value: f, label: f }))]],
            onPick: (v) => {
                b.textContent = `<${v}>`;
                keyEdit((kk) => { kk.fields[i] = v; });
            },
        });
    }));
    div.querySelectorAll(".kmv").forEach((b) => b.addEventListener("click", () => keyEdit((k) => {
        const i = +b.dataset.i, j = i + (+b.dataset.d);
        if (j < 0 || j >= k.fields.length) return;
        [k.fields[i], k.fields[j]] = [k.fields[j], k.fields[i]];
    })));
    div.querySelectorAll(".kdel").forEach((b) => armConfirm(b, () =>
        keyEdit((k) => { if (k.fields.length > 1) k.fields.splice(+b.dataset.i, 1); }), { silent: true, resetOnOutside: true }));
    div.querySelector(".kadd")?.addEventListener("click", (e) => {
        const k = model.effectiveItemKey(winId, itemId);
        const used = k.fields || [];
        const it = model.item(winId, itemId);
        const fids = [...new Set((it?.fields || []).map((f) => f.field))];
        const addable = fids.filter((f) => !used.includes(f));
        comboPopover({
            anchor: e.currentTarget, placeholder: "search fields...",
            options: addable.map((f) => ({ value: f, label: f })),
            onPick: (v) => { if (v) keyEdit((kk) => { kk.fields.push(v); }); },
        });
    });
    div.querySelector(".ksep")?.addEventListener("change", (e) => keyEdit((k) => { k.sep = e.target.value || "|"; }));
    div.querySelector(".kcase")?.addEventListener("change", (e) => keyEdit((k) => { k.case_sensitive = e.target.checked; }));
    // fill the freshly-built merged table from the last cached read (the canvas may be closed, so
    // refreshItemBoxes wouldn't run) — subsequent reads update it in place via refreshItemBoxes.
    refreshItemReadout(winId, itemId);
}

// Add a freshly-created field/tell node to whatever group its item node belongs to, so a
// child drawn from an item stays grouped with it (no-op when the item isn't grouped).
function addFieldToItemGroup(winId, itemId, fid) {
    inheritGroupFrom(`fld:${winId}:${itemId}:${fid}`, `item:${winId}:${itemId}`);
}
function addTellToItemGroup(winId, itemId, tid) {
    inheritGroupFrom(`tell:${winId}:${itemId}:${tid}`, `item:${winId}:${itemId}`);
}

// On load, pull every ORPHAN item-child node (fields/tells) into its item's group, so a child
// that became its own node sits with the item it was moved from. Idempotent; an already-grouped
// child (incl. one the user moved elsewhere) is left alone. Needs nodes rendered (for rects).
function groupOrphanChildren(type) {
    const byGroup = {};
    for (const n of model.nodes()) {
        if (n.type !== type || groups.groupOf(n.id)) continue;
        const g = groups.groupOf(`item:${n.win.id}:${n.item.id}`);
        if (g) (byGroup[g.id] = byGroup[g.id] || []).push(n.id);
    }
    for (const [gid, ids] of Object.entries(byGroup)) groups.addToGroup(gid, ids);
}

// THE update path after a FIELD-node edit (mirrors itemChanged, but a field config also
// affects the item's tells-mirror/key/summary, so optionally rebuild the item node too).
//   rebuild:     the field node DOM (type/tell/locate toggled which controls show)
//   rebuildItem: the item node DOM (tell flag / conf changed -> its mirror + key)
//   render:      full graph render (id rename, dict link, node add/remove)
function fieldChanged(winId, itemId, fid, opts = {}) {
    fieldPaint(winId, itemId, fid, opts);
    itemRead(winId, itemId)();
}

// The cheap half (see itemPaint). The expensive half is `itemRead(winId, itemId)` — identical to
// the item node's, since a field edit re-reads the same cutout.
function fieldPaint(winId, itemId, fid, { rebuild = false, rebuildItem = false, render: doRender = false } = {}) {
    if (doRender) render();
    else {
        if (rebuild) rebuildNode(`fld:${winId}:${itemId}:${fid}`);
        if (rebuildItem) rebuildNode(`item:${winId}:${itemId}`);
    }
    refreshItemBoxes(winId, itemId);
    refreshImageBoxes(winId);
}

// Wire one item-field node: the per-field config that used to live inline in the item node.
function wireItemField(div, n) {
    const winId = n.win.id, itemId = n.item.id, fid = n.ref.id;
    // one deferred field edit: paint now, re-read the cutout + persist once on commit
    const fieldEdit = (mutate, opts = {}) =>
        nodeEdit(n.id, "read", () => { mutate(); fieldPaint(winId, itemId, fid, opts); }, itemRead(winId, itemId));
    div.querySelector(".gi-id").addEventListener("change", (e) => {
        nodeTxn.commitIfDirty();   // rename render()s + changes node identity — land any pending edit first
        renameNode(e.target, fid,
            () => model.renameItemField(winId, itemId, fid, e.target.value.trim()),
            () => movePos(`fld:${winId}:${itemId}:${fid}`, `fld:${winId}:${itemId}:${n.ref.id}`),
            () => fieldChanged(winId, itemId, n.ref.id, { render: true }));
    });
    // Only the capture/confidence knobs live on the field body now; all value processing is
    // authored in the rule pipeline (wired below). `type` rebuilds so the rule menus re-filter.
    div.querySelectorAll(".ffset").forEach((inp) => onValueEdit(inp, (e) => {
        const f = model.itemField(winId, itemId, fid);
        const fd = f && (n.win.fields || []).find((x) => x.id === f.field);
        if (!fd) return;
        const k = e.target.dataset.k;
        fieldEdit(() => {
            if (k === "minconf") fd.min_confidence = +e.target.value || 0;
            else if (k === "isolate") fd.isolate = e.target.checked;
            else if (k === "glyph_check") fd.glyph_check = e.target.checked;
        }, { rebuild: false });
    }));
    // type rebuilds so the rule menus re-filter (a number-only rule greys out for text).
    div.querySelector(".ffset-type")?.addEventListener("click", (e) => {
        const f = model.itemField(winId, itemId, fid);
        const fd = f && (n.win.fields || []).find((x) => x.id === f.field);
        if (!fd) return;
        const btn = e.currentTarget;
        richPickerPop({
            anchor: btn, current: fd.type || "text",
            groups: [[null, TYPES.map(([v, l]) => ({ value: v, label: l, meta: TYPE_DESC[v] || "" }))]],
            onPick: (v) => { fieldEdit(() => { fd.type = v; }, { rebuild: true }); },
        });
    });
    if (n.field) wireFieldRules(div, n.field, {
        // `rebuild` is handled by rulesEdit (it rebuilds THIS node); the boxes/grid resync and the
        // cutout re-read split across paint-now / read-on-commit.
        edit: rulesEdit(n.id, itemRead(winId, itemId)),
    });
    div.querySelector(".itell")?.addEventListener("change", (e) => {
        fieldEdit(() => model.setItemFieldTell(winId, itemId, fid, e.target.checked),
            { rebuild: true, rebuildItem: true });   // show/hide tell-conf + item mirror
    });
    div.querySelector(".itellconf")?.addEventListener("change", (e) => {
        fieldEdit(() => model.setItemFieldTellConf(winId, itemId, fid, +e.target.value || 0), { rebuildItem: true });
    });
    div.querySelector(".itelltext")?.addEventListener("change", (e) => {
        fieldEdit(() => model.setItemFieldTellAllowText(winId, itemId, fid, e.target.checked));
    });
    div.querySelector(".iloc")?.addEventListener("change", (e) => {
        fieldEdit(() => model.setItemFieldLocate(winId, itemId, fid, e.target.checked), { rebuild: true });   // show/hide the align dropdown
    });
    div.querySelector(".itellalign")?.addEventListener("click", (e) => {
        const btn = e.currentTarget;
        richPickerPop({
            anchor: btn, current: btn.textContent.replace(/^<|>$/g, ""),
            groups: [[null, ALIGN_Y_OPTS.map(([v, l]) => ({ value: v, label: l, meta: ALIGN_Y_DESC[v] || "" }))]],
            onPick: (v) => { fieldEdit(() => model.setItemFieldAlign(winId, itemId, fid, v)); btn.textContent = `<${v}>`; },
        });
    });
    div.querySelector(".itellalignx")?.addEventListener("click", (e) => {
        const btn = e.currentTarget;
        richPickerPop({
            anchor: btn, current: btn.textContent.replace(/^<|>$/g, ""),
            groups: [[null, ALIGN_X_OPTS.map(([v, l]) => ({ value: v, label: l, meta: ALIGN_X_DESC[v] || "" }))]],
            // x-anchor changes where columns land -> re-read
            onPick: (v) => { fieldEdit(() => model.setItemFieldAlignX(winId, itemId, fid, v)); btn.textContent = `<${v}>`; },
        });
    });
}

// THE update path after a TELL-node edit (mirrors fieldChanged): a tell change affects the
// item's readout, the cutout boxes, the window grid (locate anchors rows), and the item
// node's tell summary — so re-OCR + persist, optionally rebuilding the tell node / full graph.
//   rebuild: the tell node DOM (a control toggled which others show)
//   render:  full graph render (id rename, locate toggle -> sibling tell nodes, node add/remove)
//   reread:  the edit changed what/where OCR reads. FALSE for id-only renames.
function tellChanged(winId, itemId, tid, opts = {}) {
    tellPaint(winId, itemId, tid, opts);
    itemRead(winId, itemId, opts.reread ?? true)();
}

// cheap half (see itemPaint); the expensive half is the shared itemRead(winId, itemId)
function tellPaint(winId, itemId, tid, { rebuild = false, render: doRender = false } = {}) {
    if (doRender) render();
    else if (rebuild) rebuildNode(`tell:${winId}:${itemId}:${tid}`);
    refreshItemBoxes(winId, itemId);
    refreshImageBoxes(winId);
}

// Wire one tell node: the per-tell controls that used to live inline in the item node.
function wireItemTell(div, n) {
    const winId = n.win.id, itemId = n.item.id, tid = n.ref.id;
    div.querySelector(".gi-id").addEventListener("change", (e) => {
        nodeTxn.commitIfDirty();   // rename render()s + changes node identity — land any pending edit first
        renameNode(e.target, tid,
            () => model.renameItemTell(winId, itemId, tid, e.target.value.trim()),
            () => movePos(`tell:${winId}:${itemId}:${tid}`, `tell:${winId}:${itemId}:${n.ref.id}`),
            () => tellChanged(winId, itemId, n.ref.id, { render: true, reread: false }));   // id only — no pixels/boxes
    });
    // the tell's KIND: swaps which kind-specific controls show (rebuild this node) and what the
    // merged table shows (rebuild the item node). A re-read reflects the new check.
    // one deferred tell edit: paint now, re-read the cutout + persist once on commit
    const tellEdit = (mutate, opts = {}) =>
        nodeEdit(n.id, "read", () => { mutate(); tellPaint(winId, itemId, tid, opts); }, itemRead(winId, itemId));
    div.querySelector(".tkind")?.addEventListener("click", (e) => {
        const btn = e.currentTarget;
        richPickerPop({
            anchor: btn, current: btn.textContent.replace(/^<|>$/g, ""),
            groups: [[null, TELL_KINDS.map(([v, l, , desc]) => ({ value: v, label: l, meta: desc || "" }))]],
            onPick: (v) => {
                tellEdit(() => {
                    model.setItemTellProp(winId, itemId, tid, "kind", v);
                    rebuildNode(`item:${winId}:${itemId}`);   // merged table shows the kind
                }, { rebuild: true });
            },
        });
    });
    // mode/strip/align/align_x are rich-dd-btn enums (tset-enum), not part of the generic .tset
    // input sweep below — each carries its own opts/desc + default and rebuild need.
    const TSET_ENUM = {
        match: { opts: MATCH_MODES, desc: MATCH_MODE_DESC, def: "partial", rebuild: true },
        strip: { opts: STRIP_MODES, desc: STRIP_MODE_DESC, def: "alnum", rebuild: false },
        align: { opts: ALIGN_Y_OPTS, desc: ALIGN_Y_DESC, def: "center", rebuild: false },
        align_x: { opts: ALIGN_X_OPTS, desc: ALIGN_X_DESC, def: "left", rebuild: false },
    };
    div.querySelectorAll(".tset-enum").forEach((btn) => btn.addEventListener("click", (e) => {
        const b = e.currentTarget, k = b.dataset.k;
        if (k === "field") {
            const cur = n.ref.field || "";
            const fids = [...new Set((n.item.fields || []).map((f) => f.field))];
            richPickerPop({
                anchor: b, current: cur,
                groups: [[null, [
                    { value: "", label: "—", meta: "check ANY column's read — not tied to one field" },
                    ...fids.map((f) => ({ value: f, label: f })),
                ]]],
                onPick: (v) => {
                    tellEdit(() => model.setItemTellProp(winId, itemId, tid, "field", v || null));
                    b.textContent = `<${v || "—"}>`;
                },
            });
            return;
        }
        const spec = TSET_ENUM[k];
        if (!spec) return;
        richPickerPop({
            anchor: b, current: b.textContent.replace(/^<|>$/g, ""),
            groups: [[null, spec.opts.map(([v, l]) => ({ value: v, label: l, meta: spec.desc[v] || "" }))]],
            onPick: (v) => {
                tellEdit(() => model.setItemTellProp(winId, itemId, tid, k, v), { rebuild: spec.rebuild });
                b.textContent = `<${v}>`;
            },
        });
    }));
    div.querySelectorAll(".tset").forEach((inp) => onValueEdit(inp, (e, live) => {
        const k = e.target.dataset.k;
        let prop = k, v;
        if (k === "threshold") v = +e.target.value || 0;
        else if (k === "width") v = Math.max(0, Math.min(0.5, +e.target.value || 0));
        else if (k === "margin") v = Math.max(0, Math.min(1, +e.target.value || 0));
        else if (k === "minchars") { prop = "min_chars"; v = Math.max(0, Math.trunc(+e.target.value) || 0); }
        else if (k === "case") { prop = "case_sensitive"; v = e.target.checked; }
        else v = e.target.value;
        // text empty<->set adds/removes the match knobs; mode change shows/hides "read ⊆ text"
        // (ignored by full/exact) -> rebuild this node's body in both cases
        tellEdit(() => {
            model.setItemTellProp(winId, itemId, tid, prop, v);
            // margin grows the search crop — redraw this template tell's reference preview to show it
            if (k === "margin" && n.ref.kind === "template") drawTellTemplateRef(div, n);
        }, (!live && (k === "text" || k === "match")) ? { rebuild: true } : {});
    }));
    // sync hex text <-> color swatch on color/border tells
    const _colorSpan = div.querySelector(".aset-color");
    if (_colorSpan) {
        const _hex = _colorSpan.querySelector("input[type='text']");
        const _picker = _colorSpan.querySelector("input[type='color']");
        if (_hex && _picker) {
            _hex.addEventListener("input", () => { _picker.value = _hex.value || "#000000"; });
            _picker.addEventListener("input", () => { _hex.value = _picker.value; });
        }
    }
    div.querySelector(".tloc")?.addEventListener("change", (e) => {
        // locate is single-choice across the item's tells — clear the others, set this one. It
        // render()s (sibling tell nodes change), so it stays immediate; land any pending edit first.
        nodeTxn.commitIfDirty();
        for (const t of n.item.tells || []) model.setItemTellProp(winId, itemId, t.id, "locate", false);
        model.setItemTellProp(winId, itemId, tid, "locate", e.target.checked);
        tellChanged(winId, itemId, tid, { render: true });   // align dropdown + sibling tell nodes
    });
    if (n.ref.kind === "template") drawTellTemplateRef(div, n);
}

// A 'template' tell matches a saved sub-image: the tell box cropped from the item's frozen
// cutout. Draw that exact crop into the tell node so the user sees its reference (mirrors the
// cell-rel→cutout-fraction mapping the reader uses in read_cutout / item_templates).
function drawTellTemplateRef(div, n) {
    const cv = div.querySelector(".tt-ref-canvas");
    const it = n.item, t = n.ref;
    if (!cv || !it.cutout || !it.cutout_box) return;
    const cb = it.cutout_box, ib = it.box;
    if (!(cb.w > 0 && cb.h > 0 && ib.w > 0 && ib.h > 0)) return;
    const iw = ib.w / cb.w, ih = ib.h / cb.h;          // cell size in cutout fractions
    const ox = (ib.x - cb.x) / cb.w, oy = (ib.y - cb.y) / cb.h;
    const fx = ox + t.box.x * iw, fy = oy + t.box.y * ih, fw = t.box.w * iw, fh = t.box.h * ih;
    const m = Math.max(0, t.margin ?? 0.25);           // search margin (per side, fraction of the box)
    const img = new Image();
    img.onload = () => {
        const W = img.naturalWidth, H = img.naturalHeight;
        // the actual tell box, in source pixels — this is what template matching saves/compares
        const bx = fx * W, by = fy * H, bw = Math.max(1, fw * W), bh = Math.max(1, fh * H);
        // the search region the live reader scans = box grown by the margin on every side, clamped
        // to the image. The box is drawn as an outline inside it so the margin band is visible.
        const ex = Math.max(0, bx - bw * m), ey = Math.max(0, by - bh * m);
        const eR = Math.min(W, bx + bw * (1 + m)), eB = Math.min(H, by + bh * (1 + m));
        const sx = Math.round(ex), sy = Math.round(ey);
        const sw = Math.max(1, Math.round(eR) - sx), sh = Math.max(1, Math.round(eB) - sy);
        // supersample the backing to ~>=220px wide at an INTEGER scale, so the pixel-art crop
        // stays crisp AND the dimension label drawn on top is legible (not 30px-tall text)
        const scale = Math.max(1, Math.ceil(220 / sw));
        const BW = sw * scale, BH = sh * scale;
        cv.width = BW; cv.height = BH;
        const ctx = cv.getContext("2d", { willReadFrequently: true });   // software canvas: no accelerated-canvas compositor layer (see overlay.js)
        ctx.imageSmoothingEnabled = false;                          // nearest-neighbour: keep the crop pixelated
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, BW, BH);
        // outline the actual box inside the margin-grown crop (skip when margin is 0 — box == crop)
        if (m > 0) {
            ctx.imageSmoothingEnabled = true;
            ctx.strokeStyle = "rgba(120,180,255,0.95)";
            ctx.lineWidth = Math.max(1, scale);
            ctx.strokeRect((bx - sx) * scale + ctx.lineWidth / 2, (by - sy) * scale + ctx.lineWidth / 2,
                bw * scale - ctx.lineWidth, bh * scale - ctx.lineWidth);
        }
        // the crop's NATIVE pixel size (what template matching actually compares), bottom-left
        ctx.imageSmoothingEnabled = true;                           // smooth glyphs
        const txt = `${Math.round(bw)}×${Math.round(bh)}`, fs = Math.max(9, Math.round(BW * 0.05)), pad = fs * 0.3;
        ctx.font = `${fs}px system-ui`;
        const tw = ctx.measureText(txt).width, plateH = fs + pad * 2;
        ctx.fillStyle = "rgba(0,0,0,0.65)";
        ctx.fillRect(0, BH - plateH, tw + pad * 2, plateH);         // readable plate behind the text
        ctx.fillStyle = "#fff";
        ctx.textBaseline = "bottom";
        ctx.fillText(txt, pad, BH - pad);
    };
    img.src = api.cutoutUrl(model.profile.name, it.cutout);
}

// Redraw the live reference crop for every template tell of an item — called when the CELL or a
// tell box resizes/moves (which shifts the crop region), so each tell node's preview tracks its
// box without a full node rebuild. Cheap: only template tells, and the cutout image is cached.
function refreshItemTemplateRefs(winId, itemId) {
    const it = model.item(winId, itemId), w = model.window(winId);
    if (!it || !w) return;
    for (const t of it.tells || []) {
        if (t.kind !== "template") continue;
        const el = nodeEls.get(`tell:${winId}:${itemId}:${t.id}`);
        if (el) drawTellTemplateRef(el, { item: it, ref: t, win: w });
    }
}

export {
    syncCellSize, itemChanged, wireItemControls, wireItemField, wireItemTell,
    groupOrphanChildren, addFieldToItemGroup, addTellToItemGroup, refreshItemTemplateRefs,
};
