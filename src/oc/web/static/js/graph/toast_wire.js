// Toast node wiring: the notification's app/duration/icon fields, rich-text blocks, wired data
// sources + {{token}} chips, and the generated-image editor (a full per-element inspector with a
// draggable/resizable box overlay, anchoring, per-side borders and WASD nudging). Split out of
// main.js; the node DOM is built elsewhere, this binds its controls. Element geometry edits ride
// the shared rect transaction (edit_txn.js) so a drag/nudge batch is one save + one server render.
import * as api from "../api.js";
import * as rectTxn from "./edit_txn.js";
import { model, setStatus, afterBoot } from "./state.js";
import { h, svg } from "../dom.js";
import { renameNode, movePos } from "./node_lifecycle.js";
import { drawEdges } from "./routing.js";
import { persist } from "./persist.js";
import { beginDrag } from "./dragresize.js";
import { onGlobal } from "../inputbus.js";
import { render, autosave, rebuildNode, wireArmedRemove, NUDGE, armConfirm } from "./main.js";

function wireToast(div, n) {
    const x = n.ref;
    const $ = (sel) => div.querySelector(sel);
    $(".toastrename")?.addEventListener("change", (e) => {
        const oldId = x.id;
        renameNode(e.target, oldId,
            () => model.renameToast(oldId, (e.target.value || "").trim()),
            () => movePos(`toast:${oldId}`, `toast:${x.id}`),
            () => { render(); autosave(null); });
    });
    $(".tn-app")?.addEventListener("change", (e) => { model.setToastProp(x.id, "app_name", e.target.value); autosave(null); });
    $(".tn-duration")?.addEventListener("change", (e) => { model.setToastProp(x.id, "duration", e.target.value); autosave(null); });
    $(".tn-icon")?.addEventListener("change", (e) => { model.setToastProp(x.id, "icon", e.target.value); autosave(null); });
    $(".tn-attr")?.addEventListener("change", (e) => { model.setToastProp(x.id, "attribution", e.target.value); autosave(null); });
    $(".tn-replacekey")?.addEventListener("change", (e) => { model.setToastProp(x.id, "replace_key", e.target.value); autosave(null); });
    $(".tn-accumcap")?.addEventListener("change", (e) => { model.setToastProp(x.id, "accumulate_cap", Math.max(1, +e.target.value || 1)); autosave(null); });
    // rich-text blocks: content + per-block style/align/max-lines edits persist in place; add /
    // remove / reorder rebuild the node body (the block list + its indices change).
    div.querySelectorAll(".tn-bk-content").forEach((el) => el.addEventListener("change", (e) => { model.setToastText(x.id, +el.dataset.i, "content", e.target.value); autosave(null); }));
    div.querySelectorAll(".tn-bk-style").forEach((el) => el.addEventListener("change", (e) => { model.setToastText(x.id, +el.dataset.i, "style", e.target.value); autosave(null); }));
    div.querySelectorAll(".tn-bk-align").forEach((el) => el.addEventListener("change", (e) => { model.setToastText(x.id, +el.dataset.i, "align", e.target.value); autosave(null); }));
    div.querySelectorAll(".tn-bk-max").forEach((el) => el.addEventListener("change", (e) => { model.setToastText(x.id, +el.dataset.i, "max_lines", e.target.value); autosave(null); }));
    $(".tn-bk-add")?.addEventListener("click", () => { model.addToastText(x.id); rebuildNode(n.id); autosave(null); });
    div.querySelectorAll(".tn-bk-del").forEach((b) => armConfirm(b, () => { model.removeToastText(x.id, +b.dataset.i); rebuildNode(n.id); autosave(null); }, { silent: true, resetOnOutside: true }));
    div.querySelectorAll(".tn-bk-up").forEach((b) => b.addEventListener("click", () => { if (model.moveToastText(x.id, +b.dataset.i, -1)) { rebuildNode(n.id); autosave(null); } }));
    div.querySelectorAll(".tn-bk-dn").forEach((b) => b.addEventListener("click", () => { if (model.moveToastText(x.id, +b.dataset.i, 1)) { rebuildNode(n.id); autosave(null); } }));
    // generated image editors — one wiring pass per image section (scoped by data-i), plus "+ image"
    div.querySelectorAll(".tn-img").forEach((sec) => wireToastImage(sec, x, n));
    div.querySelector(".tn-img-add")?.addEventListener("click", () => { model.addToastImage(x.id); rebuildNode(n.id); autosave(null); });
    // sources row: add/remove a wired data feeder (readout/dataset/subset) — the picker twin of
    // dragging a node's out-port here. Rebuild refreshes the pills + the {{token}} chips; drawEdges
    // adds/drops the source's data edge.
    $(".tn-addsrc")?.addEventListener("change", (e) => { if (model.addToastSource(x.id, e.target.value)) { rebuildNode(n.id); drawEdges(); autosave(null); } });
    wireArmedRemove(div, ".tn-rmsrc", (val) => { model.removeToastSource(x.id, val); rebuildNode(n.id); drawEdges(); autosave(null); });
    // token chips: click to COPY the source's {{token}} to the clipboard, ready to paste into any
    // text block or image text line (the palette sits below the images, away from the fields).
    div.querySelectorAll(".tn-rotoken").forEach((b) => b.addEventListener("click", async () => {
        const token = `{{${b.dataset.token}}}`;
        try { await navigator.clipboard.writeText(token); setStatus(`copied ${token}`); }
        catch { setStatus(`copy failed — ${token}`); }
    }));
    // slide toggles are native checkboxes now — read `.checked` on change
    $(".tn-muted")?.addEventListener("change", (e) => {
        model.setToastProp(x.id, "muted", e.currentTarget.checked); autosave(null);
    });
    $(".tn-showicon")?.addEventListener("change", (e) => {
        model.setToastProp(x.id, "show_icon", e.currentTarget.checked); autosave(null);
    });
    $(".tn-accum")?.addEventListener("change", (e) => {
        model.setToastProp(x.id, "accumulate", e.currentTarget.checked); autosave(null);
    });
    // test button: pop the toast now with its current config (mirrors the trigger's ↻ fire). The
    // server reads the toast from the SAVED profile, so commit the live field values + FLUSH the
    // pending save first — no need to defocus an input before clicking test.
    $(".tn-test")?.addEventListener("click", async () => {
        div.querySelectorAll(".tn-bk-content").forEach((el) => model.setToastText(x.id, +el.dataset.i, "content", el.value));
        for (const [sel, key] of [[".tn-app", "app_name"], [".tn-icon", "icon"], [".tn-attr", "attribution"]]) {
            const el = $(sel); if (el) model.setToastProp(x.id, key, el.value);
        }
        autosave(null);
        try { await persist.flush(); await api.toasts.test(model.profile.name, x.id); }
        catch (err) { setStatus(`toast test failed: ${err.message || err}`); }
    });
}

// Wire ONE generated-image editor section. `sec` is the `.tn-img` element (data-i = image index).
// The text elements are edited through a mini-inspector: the preview overlays a clickable box on
// every element, and the compact list + boxes SELECT which element the inspector edits (its full
// controls). Field edits persist + autosave + repreview (debounced); structural changes (bg type,
// add/remove element/image) rebuild the node so indices + conditional controls stay correct.
// 9-point code ("tl".."br") -> [fx, fy] fractions of a box (mirrors toast_image._frac server-side).
function _frac9(code) {
    const c = (code || "tl").toLowerCase();
    const v = { t: 0, m: 0.5, b: 1 }[c[0]] ?? 0;
    const hh = { l: 0, c: 0.5, r: 1 }[c[1]] ?? 0;
    return [hh, v];
}
// resize handle directions (edges + corners), like the OCR-cell canvas overlay
const _TN_HANDLES = [["nw", -1, -1], ["n", 0, -1], ["ne", 1, -1], ["e", 1, 0],
    ["se", 1, 1], ["s", 0, 1], ["sw", -1, 1], ["w", -1, 0]];

// canonicalise a typed hex ("#abc" -> "#aabbcc", "abc123" -> "#abc123"); null = reject (not 3/6 hex)
const normHex = (v) => { v = (v || "").trim().replace(/^#?/, "#"); if (/^#[0-9a-fA-F]{6}$/.test(v)) return v.toLowerCase(); if (/^#[0-9a-fA-F]{3}$/.test(v)) return ("#" + v[1] + v[1] + v[2] + v[2] + v[3] + v[3]).toLowerCase(); return null; };
// Wire a colorPair (native picker `cls` + linked hex text `cls`-hex) inside `root`, kept in sync:
// edit either, the other follows; `apply(hex)` persists. Returns a setter that pushes a value into
// both inputs (so a caller e.g. the border side-picker can repoint them).
function bindColorPair(root, cls, apply) {
    const c = root.querySelector(cls), tx = root.querySelector(cls + "-hex");
    c?.addEventListener("input", () => { if (tx) tx.value = c.value; apply(c.value); });
    tx?.addEventListener("change", () => { const n = normHex(tx.value); if (n) { c.value = n; tx.value = n; apply(n); } });
    return (v) => { if (c) c.value = v || "#000000"; if (tx) tx.value = v || ""; };
}

function wireToastImage(sec, x, n) {
    const idx = +sec.dataset.i;
    const q = (s) => sec.querySelector(s);
    let pvTimer = null;
    let pvSeq = 0;          // monotonically rising id: only the LATEST request's response is applied
    let curBoxes = [];      // per-element pixel boxes from the last preview (image-space)
    let scale = { sx: 1, sy: 1 };   // display px per image px, from the last layout
    let sel = model.toastImageSel(x.id, idx);   // selected element index (null when no elements)
    let bdSide = "";                 // active border side in the inspector ("" = base/all)
    let syncInspector = null;        // reconcile-in-place fn (assigned once by wireInspector)
    const im = () => model.toastImage(x.id, idx);
    const texts = () => (im() || {}).texts || [];
    const nw = () => (im() || {}).width || 1;      // image size in image px
    const nh = () => (im() || {}).height || 1;
    const boxByI = (i) => curBoxes.find((b) => b.i === i);
    const focusPv = () => q(".tn-img-pv")?.focus();
    // px delta -> the image's stored unit (px, or % of the image dimension), as an int.
    const toUnit = (px, dim) => Math.round((im() || {}).unit === "pct" ? px / dim * 100 : px);
    const unitMin = () => ((im() || {}).unit === "pct" ? 1 : 4);
    const setText = (i, k, v) => model.setToastImageText(x.id, idx, i, k, v);
    // Box + guide overlays reveal via an explicit `.tn-active` class (graph.css), NOT :focus-within —
    // so editing the inspector (or clicking a non-focusable gap in it) never hides them or drops the
    // selection. The section is active while worked in, inactive when a click lands outside it.
    const setActive = (on) => sec.classList.toggle("tn-active", on);
    // Flush a pending change-bound inspector edit (colour hex, etc.) to the CURRENTLY selected element
    // BEFORE the selection changes. A box mousedown preventDefaults to keep the drag alive, which
    // swallows the blur that would fire the field's `change` — silently dropping the edit (or, if the
    // blur landed later, writing it to the newly-selected element). An explicit blur commits it now.
    const commitFocusedField = () => {
        const a = document.activeElement;
        if (a && sec.contains(a) && (a.tagName === "INPUT" || a.tagName === "SELECT" || a.tagName === "TEXTAREA")) a.blur();
    };

    // ---- anchor guides: an SVG overlay drawing the selected element's anchor leg (target point ->
    // the element's own corner), so anchoring reads like pretty's cue layer. Redrawn on select/drag.
    const drawGuides = (i) => {
        const g = q(".tn-guides"); if (!g) return;
        const b = i == null ? null : boxByI(i);
        if (!b) { g.replaceChildren(); return; }
        const t = texts()[i] || {};
        const a = t.anchor || { to: "", corner: "tl", target: "tl" };
        let tb = { x: 0, y: 0, w: nw(), h: nh() };                 // anchor target = image, or a sibling
        if (a.to !== "" && a.to != null) { const sb = boxByI(+a.to); if (sb) tb = sb; }
        const [tfx, tfy] = _frac9(a.target); const [cfx, cfy] = _frac9(a.corner);
        const tp = [(tb.x + tfx * tb.w) * scale.sx, (tb.y + tfy * tb.h) * scale.sy];
        const cp = [(b.x + cfx * b.w) * scale.sx, (b.y + cfy * b.h) * scale.sy];
        g.replaceChildren(
            svg("line", { x1: tp[0], y1: tp[1], x2: cp[0], y2: cp[1], class: "tn-guide-leg" }),
            svg("circle", { cx: tp[0], cy: tp[1], r: 3.5, class: "tn-guide-t" }),
            svg("rect", { x: cp[0] - 3, y: cp[1] - 3, width: 6, height: 6, class: "tn-guide-c" }));
    };

    // px value of a stored coord in the image's unit (inverse of toUnit) — for local box resolve.
    const unitToPx = (v, dim) => ((im() || {}).unit === "pct" ? Math.round((v || 0) / 100 * dim) : (v || 0));
    // resolve one element's box (image px) straight from the model — mirrors the server so the
    // overlay can be moved/resized LOCALLY during a drag/nudge without a server round-trip.
    // mirror the server's _fixed: a match_w/match_h (sibling index) WINS, scaled by match_*_pct;
    // else an explicit width/height; else null = auto (fall back to the last server box's size).
    const rawLocal = (i, axis) => { const b = boxByI(i); return b ? (axis === "w" ? b.w : b.h) : 0; };
    const fixedLocal = (i, axis, stack) => {
        const t = texts()[i]; if (!t) return null;
        const ref = String((axis === "w" ? t.match_w : t.match_h) || "").trim();
        if (ref === "image") {   // match the image canvas size on this axis, scaled by the percent
            const base = axis === "w" ? nw() : nh();
            const pct = (axis === "w" ? t.match_w_pct : t.match_h_pct) || 100;
            return base ? Math.max(1, Math.round(base * pct / 100)) : null;
        }
        if (/^-?\d+$/.test(ref)) {
            const j = +ref;
            if (j >= 0 && j < texts().length && j !== i && !stack.has(j)) {
                const base = fixedLocal(j, axis, new Set(stack).add(i)) ?? rawLocal(j, axis);
                if (base) {
                    const pct = (axis === "w" ? t.match_w_pct : t.match_h_pct) || 100;
                    return Math.max(1, Math.round(base * pct / 100));
                }
            }
        }
        const explicit = axis === "w" ? unitToPx(t.width, nw()) : unitToPx(t.height, nh());
        return explicit > 0 ? explicit : null;
    };
    const resolveLocal = (i) => {
        const t = texts()[i]; if (!t) return null;
        const b0 = boxByI(i); const W = nw(), H = nh();
        const fw = fixedLocal(i, "w", new Set()), fh = fixedLocal(i, "h", new Set());
        const sw = fw != null ? fw : (b0 ? b0.w : 1), sh = fh != null ? fh : (b0 ? b0.h : 1);
        const a = t.anchor || { to: "", corner: "tl", target: "tl" };
        let tb = { x: 0, y: 0, w: W, h: H };
        if (a.to !== "" && a.to != null) { const sb = boxByI(+a.to); if (sb) tb = sb; }
        const [tfx, tfy] = _frac9(a.target); const [cfx, cfy] = _frac9(a.corner);
        return { x: Math.round(tb.x + tfx * tb.w - cfx * sw + unitToPx(t.x, W)),
                 y: Math.round(tb.y + tfy * tb.h - cfy * sh + unitToPx(t.y, H)), w: sw, h: sh };
    };
    // repaint the selected box + guides locally from the model (no server); update curBoxes too so
    // guides and later local resolves stay consistent through a continuous drag/nudge.
    const paintSel = () => {
        if (sel == null) return;
        const b = resolveLocal(sel); if (!b) return;
        const cb = boxByI(sel); if (cb) { cb.x = b.x; cb.y = b.y; cb.w = b.w; cb.h = b.h; }
        const el = sec.querySelector(`.tn-img-boxes .tn-box[data-i="${sel}"]`);
        if (el) { const { sx, sy } = scale; el.style.left = `${(b.x * sx).toFixed(1)}px`; el.style.top = `${(b.y * sy).toFixed(1)}px`;
            el.style.width = `${Math.max(6, b.w * sx).toFixed(1)}px`; el.style.height = `${Math.max(6, b.h * sy).toFixed(1)}px`; }
        drawGuides(sel);
    };
    let _raf = 0;
    const rafPaint = () => { if (_raf) return; _raf = requestAnimationFrame(() => { _raf = 0; paintSel(); }); };
    // defer the expensive save + server re-render until edits settle, so holding WASD or dragging
    // fires ONE render+save at the end, not one per step (the overlay updates live via paintSel).
    // Moving/resizing/nudging an element is a rect edit, so it rides the SAME transaction every box
    // overlay uses (edit_txn.js): the drag only paints, and Enter / the ✓ button / a click outside
    // the node runs the expensive save + server re-render ONCE for the whole batch; Escape puts every
    // touched element back. Unlike a canvas box this editor WRITES the model live (resolveLocal reads
    // it back to place the overlay without a round-trip), so the clean state is a snapshot, not the
    // model — `txnSnap` holds each element's geometry as it was before this batch touched it.
    const TXN_KEY = `toast:${x.id}:${idx}`;
    const txnSnap = new Map();   // element index -> {x, y, width, height} before the batch
    const toastSpec = () => ({
        host: q(".tn-img-pv"),
        isOutside: (t) => !sec.closest(".gnode")?.contains(t),
        commit: () => { txnSnap.clear(); autosave(null); refreshPreview(); },
        restore: () => {
            for (const [i, g] of txnSnap) for (const k of ["x", "y", "width", "height"]) setText(i, k, g[k]);
            txnSnap.clear();
            syncGeomInputs(); rafPaint();
        },
    });
    // Call BEFORE the first setText of a gesture: opens/extends the batch and snapshots the element's
    // pre-edit geometry exactly once.
    const beginEdit = (i) => {
        rectTxn.begin(TXN_KEY, toastSpec);
        const t = texts()[i];
        if (t && !txnSnap.has(i)) txnSnap.set(i, { x: t.x, y: t.y, width: t.width, height: t.height });
    };
    const touchEdit = (i) => {
        const t = texts()[i];
        if (t) rectTxn.touch(i, { role: "toast", x: t.x || 0, y: t.y || 0, w: t.width || 0, h: t.height || 0 });
    };

    // one draggable/resizable overlay box for element b.i
    const makeBox = (b) => {
        const sx = scale.sx, sy = scale.sy;
        const nameOf = (bi) => { const t = texts()[bi]; const c = (t?.content || "").trim(); return `${bi + 1}: ${c || "(empty)"}`; };
        const d = h("div", { class: "tn-box" + (b.i === sel ? " sel" : ""), dataset: { i: b.i },
            title: "drag to move · drag an edge to resize · click to select (click again to deselect)",
            style: `left:${(b.x * sx).toFixed(1)}px;top:${(b.y * sy).toFixed(1)}px;width:${Math.max(6, b.w * sx).toFixed(1)}px;height:${Math.max(6, b.h * sy).toFixed(1)}px` },
            h("span", { class: "tn-box-lab" }, nameOf(b.i)));
        // MOVE: press inside (not on a handle) -> beginDrag (shared loop). A press w/o drag on an
        // UNselected box selects it; the same press on the ALREADY-selected box toggles it off
        // (deselect -> pick back to "(none)"). A real drag never deselects.
        d.addEventListener("mousedown", (ev) => {
            if (ev.button !== 0 || ev.target.classList.contains("tn-box-h")) return;
            ev.preventDefault();
            const wasSel = (b.i === sel);
            selectLine(b.i); focusPv();
            let dragged = false;
            document.addEventListener("mouseup", () => { if (!dragged && wasSel) selectLine(null); }, { once: true });
            const t = texts()[b.i]; if (!t) return;
            const ox = t.x, oy = t.y;
            beginDrag(ev, { threshold: 3, cursor: "grabbing",
                onStart: () => { dragged = true; },
                onMove: (e) => {
                    beginEdit(b.i);
                    setText(b.i, "x", ox + toUnit((e.clientX - ev.clientX) / sx, nw()));
                    setText(b.i, "y", oy + toUnit((e.clientY - ev.clientY) / sy, nh()));
                    rafPaint();                              // local overlay only — no server render
                },
                onSettle: () => { syncGeomInputs(); touchEdit(b.i); } });
        });
        // RESIZE: 8 edge/corner handles, each a beginDrag adjusting width/height (+ x/y for top/left).
        for (const [k, hx, hy] of _TN_HANDLES) {
            const g = h("div", { class: `tn-box-h tn-box-${k}`, dataset: { d: k } });
            g.addEventListener("mousedown", (ev) => {
                if (ev.button !== 0) return;
                ev.preventDefault(); ev.stopPropagation(); selectLine(b.i); focusPv();
                const t = texts()[b.i]; if (!t) return;
                // seed from the stored size, or the auto (measured) box when width/height is 0
                const seedW = t.width || toUnit(b.w, nw()), seedH = t.height || toUnit(b.h, nh());
                const o = { x: t.x, y: t.y, w: seedW, h: seedH };
                beginDrag(ev, { threshold: 0, cursor: getComputedStyle(g).cursor,
                    onMove: (e) => {
                        beginEdit(b.i);
                        const ux = toUnit((e.clientX - ev.clientX) / sx, nw()), uy = toUnit((e.clientY - ev.clientY) / sy, nh());
                        const mn = unitMin();
                        let nx = o.x, ny = o.y, nwd = o.w, nhd = o.h;
                        if (hx > 0) nwd = Math.max(mn, o.w + ux);
                        if (hx < 0) { nx = o.x + ux; nwd = Math.max(mn, o.w - ux); }
                        if (hy > 0) nhd = Math.max(mn, o.h + uy);
                        if (hy < 0) { ny = o.y + uy; nhd = Math.max(mn, o.h - uy); }
                        // a matched axis is locked to the match target — dragging it must NOT write a
                        // (dead, then persisted) width/height. Skip both x and size on a matched axis.
                        if (hx && !t.match_w) { setText(b.i, "x", nx); setText(b.i, "width", nwd); }
                        if (hy && !t.match_h) { setText(b.i, "y", ny); setText(b.i, "height", nhd); }
                        rafPaint();                          // local overlay only — no server render
                    },
                    onSettle: () => { syncGeomInputs(); touchEdit(b.i); } });
            });
            d.appendChild(g);
        }
        return d;
    };
    // Lay the draggable boxes over the preview, scaling image-space px -> the displayed img size.
    const layoutBoxes = () => {
        const el = q(".tn-img-preview"); const ov = q(".tn-img-boxes");
        if (!el || !ov) return;
        const iw = el.naturalWidth, ih = el.naturalHeight;
        if (!iw || !ih) { ov.replaceChildren(); return; }
        // the img is width:100% + height:auto -> UNIFORMLY scaled (aspect preserved), so sy == sx.
        // Derive the displayed height from clientWidth; DON'T read clientHeight — after a canvas-size
        // change it can still hold the old value in the load handler, leaving boxes mis-scaled.
        const cw = el.clientWidth, s = cw / iw, ch = ih * s;
        scale = { sx: s, sy: s };
        ov.style.width = `${cw}px`; ov.style.height = `${ch}px`;
        const gv = q(".tn-guides"); if (gv) { gv.setAttribute("width", cw); gv.setAttribute("height", ch); }
        ov.replaceChildren(...curBoxes.map((b) => makeBox(b)));
        drawGuides(sel);
        // A server frame carries the box positions AS OF the request it answered — stale if the
        // user kept nudging (WASD/drag) while it rendered. Re-snap the selected box to the CURRENT
        // model so a late frame never yanks it back to where it was when the request left.
        if (sel != null) paintSel();
    };
    const refreshPreview = () => {
        clearTimeout(pvTimer);
        pvTimer = setTimeout(async () => {
            const spec = im();
            const el = q(".tn-img-preview");
            if (!el || !spec) return;   // render even when placement=none: the design stays visible
            // Reserve the slot's height up front from the canvas size (img is width:100% + height:auto,
            // so aspect-ratio fixes the height before/while the frame loads) — the box never collapses
            // during the fetch or a swap, so nothing below it jumps. Matches the server's render aspect.
            if (spec.width && spec.height) el.style.aspectRatio = `${spec.width} / ${spec.height}`;
            // Debounce collapses a burst into one request, but a render slower than the debounce
            // window lets several overlap. Tag each with a sequence id and, when a response lands,
            // drop it if a newer request has since started — the stale frame never overwrites the
            // latest, and its object URL is revoked so it doesn't leak.
            const seq = ++pvSeq;
            const res = await api.toasts.previewImage(model.profile.name, spec);
            if (seq !== pvSeq) { if (res && res.url) URL.revokeObjectURL(res.url); return; }
            if (res && res.url) {
                // Decode the new frame OFF-DOM first, then swap. Assigning el.src straight away blanks
                // the on-screen <img> until the new blob decodes — a blank img collapses to height:0,
                // so the whole node jerks down and back (layout shift). Pre-decoding warms the blob so
                // the visible swap is instant, and we keep the OLD url alive until after the swap.
                const pre = new Image();
                pre.src = res.url;
                try { await pre.decode(); } catch { /* superseded/aborted decode — swap anyway, load fires */ }
                if (seq !== pvSeq) { URL.revokeObjectURL(res.url); return; }
                const old = el._u;
                curBoxes = res.boxes || [];
                el._u = res.url; el.src = res.url;
                if (old) URL.revokeObjectURL(old);   // revoke the previous frame only after it's replaced
                if (el.complete && el.naturalWidth) layoutBoxes();   // warmed decode: lay out now
            }
        }, 250);
    };
    // the new frame's true dimensions are known on load -> (re)lay the boxes then
    q(".tn-img-preview")?.addEventListener("load", layoutBoxes);
    // select element `j`: persist the (transient) selection, re-point the inspector + highlights in
    // place (no preview refetch — the image is unchanged, only which element is active).
    const selectLine = (j) => {
        commitFocusedField();   // apply any pending edit to the current element before switching away
        model.setToastImageSel(x.id, idx, j); sel = j;
        sec.querySelectorAll(".tn-img-boxes .tn-box").forEach((b) => b.classList.toggle("sel", j != null && +b.dataset.i === j));
        const pk = sec.querySelector(".tn-il-pick"); if (pk) pk.value = j == null ? "" : String(j);
        if (syncInspector) syncInspector(j);   // reconcile the existing inspector, don't rebuild it
        drawGuides(j);
    };
    // click on the empty preview (not on a box) deselects the element. Inspector clicks never reach
    // here, so editing an element never deselects it. Left-button only (right-click never deselects).
    q(".tn-img-preview")?.addEventListener("mousedown", (ev) => { if (ev.button === 0) selectLine(null); });
    // Overlay visibility (boxes + guides) rides an explicit `.tn-active` class, NOT :focus-within —
    // this is the whole point of the rewrite. The section is ACTIVE while the user works inside it and
    // goes inactive when a mousedown lands genuinely OUTSIDE it (another node, the canvas). A click
    // INSIDE (even a non-focusable inspector gap, or a right-click) keeps it active and the selection
    // untouched — that's what fixes the "editing deselects" bug. Leaving the section DESELECTS so the
    // box overlay and the picker stay in lockstep: no lingering "element N" in the picker once its rect
    // is gone. Selection otherwise changes only on explicit acts — a box, the empty preview, the picker.
    // One document-capture mousedown drives both; it self-removes once `sec` leaves the DOM on a rebuild.
    let offActive = null;
    offActive = onGlobal(document, "mousedown", (ev) => {
        if (!document.contains(sec)) { offActive?.(); offActive = null; return; }
        const inside = sec.contains(ev.target);
        setActive(inside);
        if (!inside && sel != null) selectLine(null);   // overlay hidden -> nothing selected -> picker resets to (none)
    }, true, "toast:activeTrack");
    // keep the inspector's x/y/w/h number inputs in step with a model change from mouse/keyboard.
    const syncGeomInputs = () => {
        const t = texts()[sel]; if (!t) return;
        const set = (cls, v) => { const el = q(cls); if (el && document.activeElement !== el) el.value = v; };
        set(".tn-il-x", t.x ?? 0); set(".tn-il-y", t.y ?? 0);
        set(".tn-il-w", t.width || ""); set(".tn-il-h", t.height || "");
    };
    // Changing the anchor (to / corner / target) must keep the element visually PUT: back-solve a new
    // x/y offset so the resolved box top-left stays where it is now, then apply the anchor change.
    const reanchor = (i, key, val) => {
        rectTxn.commitIfDirty();   // back-solving x/y off the CURRENT box: land any pending nudge first
        const t = texts()[i]; const b = boxByI(i);
        if (!t || !b) { model.setToastImageAnchor(x.id, idx, i, key, val); autosave(null); refreshPreview(); return; }
        const a = { to: "", corner: "tl", target: "tl", ...(t.anchor || {}), [key]: val };
        let tb = { x: 0, y: 0, w: nw(), h: nh() };
        if (a.to !== "" && a.to != null) { const sb = boxByI(+a.to); if (sb) tb = sb; }
        const [tfx, tfy] = _frac9(a.target); const [cfx, cfy] = _frac9(a.corner);
        const offX = b.x - (tb.x + tfx * tb.w) + cfx * b.w;   // offset that lands the box back at (b.x,b.y)
        const offY = b.y - (tb.y + tfy * tb.h) + cfy * b.h;
        model.setToastImageAnchor(x.id, idx, i, key, val);
        setText(i, "x", toUnit(offX, nw())); setText(i, "y", toUnit(offY, nh()));
        syncGeomInputs(); autosave(null); refreshPreview();
    };
    // WASD nudges the selected element; Shift+WASD resizes it (A/D width, W/S height) — the SAME
    // convention every other box in the editor uses (shared NUDGE map), no per-editor modifier.
    // Scoped to the focused preview so it never fights the page or other images. Held keys only paint
    // the local overlay; the (expensive) save + server re-render waits for the rect transaction to
    // commit (Enter / ✓ / clicking outside the node), so a held key is one render, never one per repeat.
    q(".tn-img-pv")?.addEventListener("keydown", (e) => {
        if (sel == null) return;
        const dir = NUDGE[e.key.toLowerCase()]; if (!dir) return;
        e.preventDefault(); e.stopPropagation();   // don't let the graph's WASD also move the node
        const t = texts()[sel]; if (!t) return;
        beginEdit(sel);
        const [ux, uy] = dir;
        if (e.shiftKey) {                           // resize — matches every box overlay's Shift+WASD
            // a matched axis is locked to its match target — don't write a dead width/height on it.
            if (ux && !t.match_w) setText(sel, "width", Math.max(1, (t.width || 0) + ux));
            if (uy && !t.match_h) setText(sel, "height", Math.max(1, (t.height || 0) + uy));
        } else {                                    // move
            if (ux) setText(sel, "x", (t.x || 0) + ux);
            if (uy) setText(sel, "y", (t.y || 0) + uy);
        }
        syncGeomInputs(); rafPaint(); touchEdit(sel);   // local overlay now; the batch commits on Enter/✓/click-out
    });
    // wire the mini-inspector's controls (exactly one set exists in `sec`); rebound after each
    // selection replaces the inspector node.
    const wireInspector = () => {
        // Target the CURRENTLY selected element (`sel`), not the control's build-time data-i: the
        // inspector DOM is reconciled in place on a selection change (syncInspector), so a control's
        // own data-i goes stale — writing x/y/w/h/etc. to the previously selected element. Every other
        // handler below already keys off `sel`; these must too.
        // The four GEOMETRY fields are just another way to move the box, so they join the same rect
        // transaction the drag/nudge opens (paint now, one save + one server render at commit) instead
        // of re-rendering per keystroke. Everything else (content, size, z) still applies immediately.
        const GEOM = new Set(["x", "y", "width", "height"]);
        const line = (cls, key) => sec.querySelectorAll(cls).forEach((el) => el.addEventListener("input", () => {
            if (GEOM.has(key)) { beginEdit(sel); setText(sel, key, el.value); rafPaint(); touchEdit(sel); return; }
            setText(sel, key, el.value); autosave(null); refreshPreview();
        }));
        line(".tn-il-content", "content"); line(".tn-il-x", "x"); line(".tn-il-y", "y");
        line(".tn-il-size", "size"); line(".tn-il-w", "width"); line(".tn-il-h", "height");
        line(".tn-il-z", "z_index");   // stacking order — only affects paint order, so repreview (no box repaint)
        // per-row reset: restore that row's field(s) to the element defaults, then reconcile the
        // inspector + overlay in place (syncInspector repaints every control incl. border/anchor).
        sec.querySelectorAll(".tn-il-rst").forEach((b) => b.addEventListener("click", () => {
            if (sel == null) return;
            model.resetToastImageTextRow(x.id, idx, sel, b.dataset.row);
            syncInspector(sel); paintSel(); autosave(null); refreshPreview();
        }));
        sec.querySelectorAll(".tn-il-wrap").forEach((el) => el.addEventListener("change", () => { setText(sel, "wrap", el.checked); autosave(null); refreshPreview(); }));
        sec.querySelectorAll(".tn-il-over").forEach((el) => el.addEventListener("change", () => { setText(sel, "overflow", el.checked); autosave(null); refreshPreview(); }));
        sec.querySelectorAll(".tn-il-cond").forEach((el) => el.addEventListener("change", () => { setText(sel, "disable_if_empty", el.checked); autosave(null); refreshPreview(); }));
        sec.querySelectorAll(".tn-il-condanchor").forEach((el) => el.addEventListener("change", () => { setText(sel, "disable_if_anchor_disabled", el.checked); autosave(null); refreshPreview(); }));
        // match this element's width / height to a sibling's resolved size ("" = own size), scaled by
        // the adjacent percent input (100 = full, 50 = half).
        // paintSel() gives the box overlay its new matched size instantly; the server re-render (text
        // re-fit) follows debounced. syncGeomInputs keeps the w/h number fields honest.
        const matchEdit = (key, v) => {
            setText(sel, key, v); syncGeomInputs(); paintSel(); autosave(null); refreshPreview();
            // picking/clearing a match flips whether that axis's dimension input + percent are read —
            // toggle their disabled state live (syncInspector does the same on the next reconcile).
            if (key === "match_w") { const w = q(".tn-il-w"); if (w) w.disabled = !!v; const p = q(".tn-il-mwp"); if (p) p.disabled = !v; }
            if (key === "match_h") { const hh = q(".tn-il-h"); if (hh) hh.disabled = !!v; const p = q(".tn-il-mhp"); if (p) p.disabled = !v; }
        };
        sec.querySelector(".tn-il-mw")?.addEventListener("change", (e) => matchEdit("match_w", e.target.value));
        sec.querySelector(".tn-il-mh")?.addEventListener("change", (e) => matchEdit("match_h", e.target.value));
        sec.querySelector(".tn-il-mwp")?.addEventListener("input", (e) => matchEdit("match_w_pct", e.target.value));
        sec.querySelector(".tn-il-mhp")?.addEventListener("input", (e) => matchEdit("match_h_pct", e.target.value));
        // colour = native picker + linked hex text, kept in sync (edit either). Returns a bound
        // hex-setter so a caller (e.g. the border side-picker) can push a new value into both.
        const cpair = (cls, apply) => bindColorPair(sec, cls, apply);
        const setTextColor = cpair(".tn-il-color", (v) => { setText(sel, "color", v); autosave(null); refreshPreview(); });
        const setBgColor = cpair(".tn-il-bg", (v) => { setText(sel, "bg_color", v); autosave(null); refreshPreview(); });
        // font family
        sec.querySelector(".tn-il-font")?.addEventListener("change", (e) => { setText(sel, "font_family", e.target.value); autosave(null); refreshPreview(); });
        // bold / italic / underline toggles
        sec.querySelectorAll(".tn-il-biu .tn-biu-b").forEach((b) => b.addEventListener("click", () => {
            const k = b.dataset.k, on = !(texts()[sel] || {})[k];
            b.classList.toggle("on", on); setText(sel, k, on); autosave(null); refreshPreview();
        }));
        // 9-point align grid
        sec.querySelectorAll(".tn-il-align .tn-nine-b").forEach((b) => b.addEventListener("click", () => {
            sec.querySelectorAll(".tn-il-align .tn-nine-b").forEach((o) => o.classList.remove("on"));
            b.classList.add("on"); setText(sel, "align", b.dataset.code); autosave(null); refreshPreview();
        }));
        // per-side border editor: a side picker retargets the w/color/style controls (bdSide is
        // hoisted to the section scope so the reconcile can reset it when the selection changes).
        const syncBorder = () => {
            const t = texts()[sel] || {};
            const src = bdSide ? ((t.border_sides || {})[bdSide] || t.border || {}) : (t.border || {});
            const w = q(".tn-bd-w"), s = q(".tn-bd-s");
            if (w) w.value = src.w ?? 0; if (s) s.value = src.style || "solid";
            setBdColor(src.color || "#ffffff");   // push into the picker + its hex text
        };
        // accent each side button whose border is set (w>0); "all" reflects the base border
        const refreshSetFlags = () => {
            const t = texts()[sel] || {};
            sec.querySelectorAll(".tn-bd-side").forEach((o) => {
                const sv = o.dataset.side;
                const set = sv ? ((t.border_sides || {})[sv]?.w > 0) : ((t.border || {}).w > 0);
                o.classList.toggle("set", !!set);
            });
        };
        sec.querySelectorAll(".tn-bd-side").forEach((b) => b.addEventListener("click", () => {
            bdSide = b.dataset.side;
            sec.querySelectorAll(".tn-bd-side").forEach((o) => o.classList.toggle("on", o === b));
            syncBorder();
        }));
        const bd = (cls, key, ev) => q(cls)?.addEventListener(ev, (e) => { model.setToastImageBorder(x.id, idx, sel, bdSide, key, e.target.value); refreshSetFlags(); autosave(null); refreshPreview(); });
        bd(".tn-bd-w", "w", "input"); bd(".tn-bd-s", "style", "change");
        const setBdColor = cpair(".tn-bd-c", (v) => { model.setToastImageBorder(x.id, idx, sel, bdSide, "color", v); refreshSetFlags(); autosave(null); refreshPreview(); });
        // anchor: target select + this/target 9-point grids. reanchor() keeps the element visually put.
        sec.querySelector(".tn-anch-to")?.addEventListener("change", (e) => {
            reanchor(sel, "to", e.target.value);   // grids stay enabled for the image (pins to the canvas)
        });
        const anchGrid = (cls, key) => sec.querySelectorAll(`${cls} .tn-nine-b`).forEach((b) => b.addEventListener("click", () => {
            sec.querySelectorAll(`${cls} .tn-nine-b`).forEach((o) => o.classList.remove("on"));
            b.classList.add("on"); reanchor(sel, key, b.dataset.code);
        }));
        anchGrid(".tn-anch-corner", "corner"); anchGrid(".tn-anch-target", "target");
        // delete the selected element (the inspector's one trash button) -> shift selection + rebuild
        armConfirm(sec.querySelector(".tn-il-del"), () => {
            const j = model.toastImageSel(x.id, idx); if (j == null) return;
            model.removeToastImageText(x.id, idx, j);
            model.setToastImageSel(x.id, idx, texts().length ? Math.max(0, Math.min(texts().length - 1, j)) : null);
            rebuildNode(n.id); autosave(null);
        }, { silent: true, resetOnOutside: true });
        // reconcile the EXISTING inspector DOM to element j (or off = null) — reuse elements, never
        // rebuild from scratch on a selection change (rule 1). Captures the wired helpers above.
        syncInspector = (j) => {
            const insp = sec.querySelector(".tn-il-insp"); if (!insp) return;
            const offNow = j == null, e = offNow ? {} : (texts()[j] || {});
            insp.classList.toggle("tn-il-off", offNow);
            insp.dataset.i = offNow ? 0 : j;
            const head = insp.querySelector(".tn-il-insp-h .muted"); if (head) head.textContent = offNow ? "no element selected" : `element ${j + 1}`;
            const setV = (cls, v) => { const el = insp.querySelector(cls); if (el && document.activeElement !== el) el.value = v; };
            setV(".tn-il-content", e.content || ""); setV(".tn-il-size", e.size ?? 20);
            setV(".tn-il-x", e.x ?? 0); setV(".tn-il-y", e.y ?? 0);
            setV(".tn-il-w", e.width || ""); setV(".tn-il-h", e.height || ""); setV(".tn-il-font", e.font_family || "");
            setV(".tn-il-z", e.z_index ?? 0);
            const wr = insp.querySelector(".tn-il-wrap"); if (wr) wr.checked = e.wrap !== false;
            const ov = insp.querySelector(".tn-il-over"); if (ov) ov.checked = !!e.overflow;
            const cd = insp.querySelector(".tn-il-cond"); if (cd) cd.checked = !!e.disable_if_empty;
            const cda = insp.querySelector(".tn-il-condanchor"); if (cda) cda.checked = !!e.disable_if_anchor_disabled;
            // rebuild each match select's sibling <option>s (self excluded), then set the current value
            const matchOpts = (cls, cur) => {
                const s = insp.querySelector(cls); if (!s) return;
                const opts = [h("option", { value: "" }, "—"), h("option", { value: "image" }, "image")];
                for (let k = 0; k < texts().length; k++) if (k !== j)
                    opts.push(h("option", { value: String(k) }, `${k + 1}: ${(texts()[k].content || "").trim() || "(empty)"}`));
                s.replaceChildren(...opts); s.value = cur || "";
            };
            matchOpts(".tn-il-mw", e.match_w); matchOpts(".tn-il-mh", e.match_h);
            setV(".tn-il-mwp", e.match_w_pct ?? 100); setV(".tn-il-mhp", e.match_h_pct ?? 100);
            // a match on an axis WINS over its own width/height (dimension input dead); a match-percent
            // is inert with no match. Disable the inputs that aren't read, so nothing edits a dead value.
            const dis = (cls, on) => { const el = insp.querySelector(cls); if (el) el.disabled = on; };
            dis(".tn-il-w", !!e.match_w); dis(".tn-il-h", !!e.match_h);
            dis(".tn-il-mwp", !e.match_w); dis(".tn-il-mhp", !e.match_h);
            insp.querySelectorAll(".tn-il-biu .tn-biu-b").forEach((b) => b.classList.toggle("on", !!e[b.dataset.k]));
            setTextColor(e.color || "#ffffff"); setBgColor(e.bg_color || "#000000");
            const acode = { left: "tl", center: "tc", right: "tr" }[e.align] || e.align || "tl";
            insp.querySelectorAll(".tn-il-align .tn-nine-b").forEach((b) => b.classList.toggle("on", b.dataset.code === acode));
            bdSide = "";   // reset the border side-picker to the base for the new element
            insp.querySelectorAll(".tn-bd-side").forEach((o) => o.classList.toggle("on", o.dataset.side === ""));
            refreshSetFlags(); syncBorder();
            const a = e.anchor || { to: "", corner: "tl", target: "tl" };
            const toSel = insp.querySelector(".tn-anch-to");
            if (toSel) {   // rebuild only the sibling <option>s (self excluded), not the whole inspector
                const opts = [h("option", { value: "" }, "image")];
                for (let k = 0; k < texts().length; k++) if (k !== j) opts.push(h("option", { value: String(k) }, `element ${k + 1}`));
                toSel.replaceChildren(...opts); toSel.value = a.to || "";
            }
            insp.querySelectorAll(".tn-anch-corner .tn-nine-b").forEach((b) => b.classList.toggle("on", b.dataset.code === (a.corner || "tl")));
            insp.querySelectorAll(".tn-anch-target .tn-nine-b").forEach((b) => b.classList.toggle("on", b.dataset.code === (a.target || "tl")));
        };
    };
    q(".tn-img-addtext")?.addEventListener("click", () => {
        model.addToastImageText(x.id, idx);
        model.setToastImageSel(x.id, idx, texts().length - 1);   // open the new element in the inspector
        rebuildNode(n.id); autosave(null);
    });
    q(".tn-img-clone")?.addEventListener("click", () => {
        const j = model.toastImageSel(x.id, idx); if (j == null) return;
        const nj = model.cloneToastImageText(x.id, idx, j);
        if (nj != null) model.setToastImageSel(x.id, idx, nj);   // open the clone
        rebuildNode(n.id); autosave(null);
    });
    // element picker dropdown — jump to an element, or "(none)" to deselect
    q(".tn-il-pick")?.addEventListener("change", (e) => selectLine(e.target.value === "" ? null : +e.target.value));
    // placement (hero/inline/none) — no layout change, just persist + (nothing to repreview)
    q(".tn-img-place")?.addEventListener("change", (e) => { model.setToastImageProp(x.id, idx, "placement", e.target.value); autosave(null); });
    // unit toggle (px / % of image) — convert stored coords so the on-screen design is preserved
    q(".tn-img-unit")?.addEventListener("change", (e) => { model.convertToastImageUnit(x.id, idx, e.target.value); rebuildNode(n.id); autosave(null); });
    armConfirm(q(".tn-img-del"), () => { model.removeToastImage(x.id, idx); rebuildNode(n.id); autosave(null); }, { silent: true, resetOnOutside: true });
    // scalar props (size + gradient colours/angle) — persist + repreview on input
    const scalar = (s, key) => q(s)?.addEventListener("input", (e) => { model.setToastImageProp(x.id, idx, key, e.target.value); autosave(null); refreshPreview(); });
    scalar(".tn-img-w", "width"); scalar(".tn-img-h2", "height"); scalar(".tn-img-angle", "angle");
    // bg colours are colorPairs (picker + linked hex text) — edit either, kept in sync
    const imgColor = (key) => (v) => { model.setToastImageProp(x.id, idx, key, v); autosave(null); refreshPreview(); };
    bindColorPair(sec, ".tn-img-c1", imgColor("color1")); bindColorPair(sec, ".tn-img-c2", imgColor("color2"));
    // bg type flips which controls show (color2/angle) -> rebuild the node body, then repreview
    q(".tn-img-bgtype")?.addEventListener("change", (e) => { model.setToastImageProp(x.id, idx, "bg_type", e.target.value); rebuildNode(n.id); autosave(null); });
    wireInspector();
    if (sel != null) setActive(true);   // a rebuild that kept a selection (add/clone element) shows its overlay
    afterBoot(refreshPreview);   // initial paint (also runs after a rebuild re-wires the section)
}
export { wireToast };
