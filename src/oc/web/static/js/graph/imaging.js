// Window image / region drawing, item cutouts, OCR read pipeline (preview + detect + grid).
// Extracted from main.js verbatim.
import * as api from "../api.js";
import { h, frag, TRASH, subhead, kv } from "../dom.js";
import { openCaptureModal } from "./panels/precap.js";
import { timed, log } from "../log.js";
import { Overlay, MIN_FRAC } from "../overlay.js";
import { persist } from "./persist.js";
import * as groups from "./groups.js";
import { singleFlight, pendingCount } from "../singleflight.js";
import { confClass } from "./conf.js";
import {
    setStatus, model, nodeEls, openImages, winPage, imageCanvases, itemCanvases, overlays,
    gridPreviews, gridReads, gridCellBoxes, gridGuards, gridOccluded, gridDetections, itemReads, clearGrid, view, boot,
    readoutPreview,
} from "./state.js";
import * as rectTxn from "./edit_txn.js";
import * as nodeTxn from "./node_txn.js";
import { drawEdges } from "./routing.js";
import { renderLiveWindow, liveDetCount, liveRecog } from "./panels/livewin.js";
import {
    render, autosave, nodeEdit, rebuildNode, rebuildReadoutConsumers, setNodeBusy, withBusy,
    registerOverlay, unregisterOverlay, overlaySelected, selectedNodeId, setSelectedNodeId,
    placeNewNode, refreshLive, syncCellSize, itemChanged,
    addFieldToItemGroup, addTellToItemGroup, inheritGroupFrom, showSatellite,
    refreshItemTemplateRefs,
} from "./main.js";
import { panZoomTo } from "./camera.js";
import { wireTools, toolKind } from "./drawtool.js";
import { keyPrevNode } from "./node_parts.js";
import { refreshDataNode, loadBatchesNode } from "./panels/datanodes.js";
import { verdictBadge } from "./collisions.js";

// ---- window image / region drawing (in-graph) -----------------------------

// Window draw tools: [kind, label, icon, tooltip]. The tooltip explains what dragging that
// box does (shown on the window canvas draw buttons), same shape as ITEM_KINDS below.
const KINDS = [
    ["region", "region", "▤", "Draw a region — a fixed text area OCR'd every read and stored as one field/column of the record."],
    ["data_area", "data area", "▭", "Draw the data area — the region item rows tile across. Item location + grid OCR are bounded to this box; drag items inside it."],
    ["item", "item", "▣", "Draw an item — freeze this cell as a template cutout and spawn an item node to teach its fields/tells."],
    ["detect", "detect", "◎", "Draw a detector — a landmark box (text/color/template) that recognises this window or one of its states."],
    ["scrollbar", "scrollbar", "↕", "Draw the scrollbar — the scroll track; its thumb position drives scroll-invariant row indexing."],
    ["readout", "readout", "▮", "Draw a readout — a live single value (health, a counter) read off this box for triggers/toasts; never stored."],
];
// kinds drawn INSIDE an item node (on its frozen cutout): the cell + fields + tells
// [kind, label, icon, tooltip]. The tooltip explains what drawing that box does (shown on
// the item node's draw buttons). Extra 4th element is ignored by the index destructures.
const ITEM_KINDS = [
    ["bbox", "cell", "▣", "Draw the cell box — the repeating tile. Its size sets the grid pitch; every field and tell is positioned relative to it."],
    ["field", "field", "▦", "Draw a field box — text to OCR and store as a column of the record."],
    ["filled", "filled", "▩", "Draw a 'filled' tell — the cell counts as an item only if this box has visual content (edges/variance above the floor)."],
    ["text", "text", "T", "Draw a 'text' tell — the cell counts only if OCR reads here: bind a field (or leave blank for any column), and optionally require the read to match a literal."],
    ["color", "color", "◐", "Draw a 'color' tell — the cell counts only if a taught color is present in this box."],
    ["border", "border", "▭", "Draw a 'border' tell — like color, but the taught color must ride the box's PERIMETER band (a rarity frame / selection outline), not its fill."],
    ["template", "template", "⧉", "Draw a 'template' tell — the cell counts only if a saved sub-image matches in this box."],
    ["diamonds", "diamonds", "◆", "Draw a 'diamonds' tell — the cell counts only if a rank-diamond strip (◇/◆) is present (e.g. a rank-pip row)."],
];
// the tell KINDS a single "tell" tool can become — every ITEM_KINDS entry that isn't the
// cell or a field. One source for the tell-node kind dropdown (rule 7), so a new tell kind is
// just another ITEM_KINDS row. `tid` default kind when the tell tool draws one is "filled".
const TELL_KINDS = ITEM_KINDS.filter(([v]) => v !== "bbox" && v !== "field");

// Graph node id for an image owner: a window is `win:<id>`, the standalone cutout atlas is the
// bare `atlas` node (it reuses the image stack, rule 7). Every `win:${winId}` node-id lookup
// goes through this so those special ids resolve to their own node.
export function nodeIdOf(winId) {
    if (winId === "atlas") return "atlas";   // the cutout-atlas node reuses the image stack
    return `win:${winId}`;
}

// A window's bound image pages + which one the canvas currently shows.
function winPageOf(winId) { return winPage.get(winId) || 0; }
function capListOf(winId) { return api.bindingList(model.profile.name, winId); }
async function curCapOf(winId) {
    const list = await capListOf(winId);
    if (!list.length) return null;
    let p = winPageOf(winId);
    if (p >= list.length) { p = 0; winPage.set(winId, 0); }   // a removed page clamps to the first
    return list[p];
}

// Show how many images the window holds on the selector button + refresh the page nav.
async function updateImageLabel(winId, btn) {
    btn = btn || nodeEls.get(nodeIdOf(winId))?.querySelector(".imgbtn");
    try {
        const list = await capListOf(winId);
        const lbl = btn && btn.querySelector(".imgbtn-lbl");
        if (lbl) lbl.textContent = list.length > 1 ? `${list.length} images` : "images";
        if (btn) btn.title = list.length ? list.join("\n") : "choose stashed images for this window";
        updatePageNav(winId, list);
    } catch { /* ignore */ }
}

// Page buttons + "p/N" indicator for the bound pages. A single (or no) image hides the
// nav; the page index is clamped into range here so a removed page can't strand it.
function updatePageNav(winId, list) {
    const pages = nodeEls.get(nodeIdOf(winId))?.querySelector(".img-pages");
    if (!pages) return;
    const n = list.length;
    if (winPageOf(winId) >= n) winPage.set(winId, 0);
    const p = winPageOf(winId);
    pages.hidden = n <= 1;
    const ind = pages.querySelector(".img-pageind");
    if (ind) ind.textContent = n > 1 ? `${p + 1}/${n}` : "";
    pages.querySelectorAll(".imgpg").forEach((b) => {
        const d = +b.dataset.d;
        b.disabled = (d < 0 && p <= 0) || (d > 0 && p >= n - 1);
    });
}

// Flip the canvas to another bound page (bounded) and re-read that image. Page is UI-only
// (not persisted) — "page does not need to persist". The read is DEFERRED onto the shared
// settle clock: the image swaps on the click, and paging through several pages costs ONE
// OCR pass (at the end), not one per page — the old immediate read made every click wait
// on the previous page's OCR (which locks the node while it runs).
async function stepWinPage(winId, d) {
    const list = await capListOf(winId);
    if (list.length <= 1) return;
    const p = Math.min(list.length - 1, Math.max(0, winPageOf(winId) + d));
    if (p === winPageOf(winId)) return;
    winPage.set(winId, p);
    loadImage(winId, false, { deferRead: true });   // shows the page now, reads once it settles
}

function closeImage(winId) {
    const e = imageCanvases.get(winId);
    if (e && e.overlay) e.overlay.destroy();   // dispose the overlay's ResizeObserver (created per open)
    if (e && e.host) e.host.replaceChildren();
    imageCanvases.delete(winId);
    unregisterOverlay(nodeIdOf(winId));
    openImages.delete(winId);
    drawEdges();
    persist.layout();
}

// THE single writer for a window overlay box, by role. Both the mouse (overlay onChange) and the
// keyboard (WASD/shift+WASD via the registry persist) route here, so a box moves/resizes to the
// same model field whichever drives it — no role handled by one path and dropped by the other.
// Callers own the generic aftermath (refreshImageBoxes/drawEdges/autosave); this does the model
// write + the role-specific side effects (item cell redraw, stale-grid clear) only.
function persistWinBox(winId, box) {
    const r = box.role;
    const b = { x: box.x, y: box.y, w: box.w, h: box.h };
    if (r === "detect") model.setDetectBox(winId, box.id, b);
    else if (r === "scrollbar") model.setScrollbar(winId, b);
    else if (r === "data_area") model.setDataArea(winId, b);
    else if (r === "item") { model.setItemBox(winId, box.id, b); refreshItemBoxes(winId, box.id); }
    else if (r === "readout") model.setReadoutBox(winId, box.id, b);
    else model.setRegionBox(winId, box.id, b);
    clearGrid(winId);   // layout changed → detected grid is stale
}

// The drawing surface behind an overlay-registry key (`win:<id>` / `item:<w>:<i>` / `atlas`) — the
// entry that owns its host element + canvas. One lookup so the rect transaction doesn't re-derive
// which map a key lives in.
function surfaceOf(key) {
    if (key.startsWith("item:")) return itemCanvases.get(key.slice(5));
    return imageCanvases.get(key === "atlas" ? "atlas" : key.slice(4));
}

// The rect transaction's view of a box surface (edit_txn.js). Commit writes every dirty box through
// the registry's single writer, then runs the surface's aftermath ONCE — the same epilogue a single
// mouse/WASD edit used to run, hoisted out of the loop, so N moved boxes cost one refresh + one
// autosave (and therefore one read settle, one history entry). Revert just rebuilds the boxes from
// the model, which was never written.
function boxSpec(key) {
    const rec = overlays.get(key);
    return {
        host: surfaceOf(key)?.host.querySelector(".canvas-wrap"),
        // "you left" = a press outside the node carrying the canvas AND outside the node whose typed
        // rect panel drives this same surface (the box is edited from there, on a different node).
        isOutside: (t) => {
            if (nodeEls.get(key)?.contains(t)) return false;
            const panel = activeRectEdit?.desc.canvasKey === key ? activeRectEdit.nodeEl : null;
            return !panel?.contains(t);
        },
        commit: (boxes) => {
            for (const b of boxes.values()) rec.persist(b);
            rec.refresh(); drawEdges(); autosave(rec.winId); rectEditCanvasSync(key);
        },
        // the model was never written, so the clean geometry is simply what a rebuild yields
        restore: () => { rec.refresh(); rec.overlay.render(); rectEditCanvasSync(key); },
    };
}

// THE entry point every box mover calls instead of persisting: mouse (overlay onChange, below),
// keyboard (the shared WASD nudge in main.js) and the typed rect panel. Opens/extends the batch on
// that surface; nothing is written until it commits.
export function editBox(key, box) {
    rectTxn.begin(key, () => boxSpec(key));
    // hand in an explicit geometry copy: the batch stores whatever it's given, and the model
    // writers (persistWinBox / persistItem) dispatch on `role` and read only x/y/w/h — a live
    // overlay box carries extra paint state that must not reach them.
    rectTxn.touch(box.id, { role: box.role, x: box.x, y: box.y, w: box.w, h: box.h });
    rectEditCanvasSync(key);   // a typed panel bound to this box tracks the drag/nudge live
}

// ---- rect-edit panel: typed x/y/w/h for a leaf node's box (region/readout/detect/scrollbar/
// itemfield/itemtell), synced with the SAME canvas + writers the mouse/WASD already use ----
// One descriptor per open editor instead of six near-identical branches (rule 7): `get()` reads
// the live box straight off the model (so it never goes stale across re-renders), `write()`
// commits through the existing single writer for that node's surface and re-fires the existing
// OCR-read trigger. `canvasKey` matches the overlay registry key (registerOverlay) so the editor
// can select/sync against the box's canvas even though that canvas lives on a DIFFERENT node
// (window or item) than the one carrying the rect-edit button. `toCanvas`/`fromCanvas` map the
// model's coordinate space to the canvas's: identity for window boxes (both window fractions),
// item-relative → cutout fractions for an item's fields/tells.
const RECT_TYPES = new Set(["region", "readout", "detect", "scrollbar", "itemfield", "itemtell"]);

const _ident = (b) => ({ ...b });

function rectDescriptor(n) {
    const winId = n.win.id;
    if (n.type === "itemfield" || n.type === "itemtell") {
        const itemId = n.item.id, boxId = n.ref.id, isField = n.type === "itemfield";
        const ent = () => itemCanvases.get(`${winId}:${itemId}`);
        return {
            winId, itemId, boxId, canvasKey: `item:${winId}:${itemId}`, locked: false,
            role: isField ? "field" : "tell",   // persistItem dispatches bbox / field / (anything else = tell)
            get: () => (isField ? model.itemField(winId, itemId, boxId) : model.itemTell(winId, itemId, boxId))?.box,
            toCanvas: (b) => { const e = ent(); return e ? e.win2cut(e.rel2win(b)) : _ident(b); },
            fromCanvas: (b) => { const e = ent(); return e ? e.win2rel(e.cut2win(b)) : _ident(b); },
            write: (box) => {
                if (isField) model.setItemFieldBox(winId, itemId, boxId, box);
                else model.setItemTellBox(winId, itemId, boxId, box);
                itemChanged(winId, itemId);   // re-reads the cutout + window preview, persists (main.js)
            },
        };
    }
    const role = n.type;   // region/readout/detect/scrollbar canvas roles match the node type 1:1
    const boxId = n.type === "scrollbar" ? "scrollbar" : n.ref.id;
    return {
        winId, boxId, role, canvasKey: `win:${winId}`,
        locked: n.type === "scrollbar" && model.scrollbarLocked(winId),
        get: () => (n.type === "detect" ? n.ref.search : n.type === "scrollbar" ? model.scrollbar(winId) : n.ref.box),
        toCanvas: _ident, fromCanvas: _ident,   // window fractions on both sides
        write: (box) => {
            persistWinBox(winId, { id: boxId, role, ...box });
            refreshImageBoxes(winId); drawEdges(); autosave(winId);
        },
    };
}

// Clamp a typed draft the same way the canvas itself clamps a drag (overlay.js's _clampBox / the
// WASD nudge, main.js) — keeps a typed box inside [0,1] and above MIN_FRAC, so Apply can never
// write a box the mouse/keyboard paths would have rejected.
function clampRect(draft) {
    const w = Math.min(Math.max(+draft.w || 0, MIN_FRAC), 1);
    const h = Math.min(Math.max(+draft.h || 0, MIN_FRAC), 1);
    const x = Math.min(Math.max(+draft.x || 0, 0), 1 - w);
    const y = Math.min(Math.max(+draft.y || 0, 0), 1 - h);
    return { x, y, w, h };
}

let activeRectEdit = null;   // { nodeId, nodeEl, desc, draft, panel, outside } — one editor open at a time

// A typed digit is just another way to move the box: it previews on the canvas and joins whatever
// rect batch that surface already has open (so a drag then a typed tweak commit together). The
// panel itself never writes the model — Enter / ✓ / clicking out does, through edit_txn.
// With the box's canvas CLOSED there is nothing to preview on, so the panel becomes its own
// transaction surface (`panel:<node>`) and commits through the descriptor's writer.
function rectEditPush() {
    const st = activeRectEdit;
    if (!st || st.desc.locked) return;
    const cb = { id: st.desc.boxId, role: st.desc.role, ...st.desc.toCanvas(clampRect(st.draft)) };
    const ov = overlays.get(st.desc.canvasKey)?.overlay;
    if (!ov) {
        rectTxn.begin(`panel:${st.nodeId}`, () => panelSpec(st));
        rectTxn.touch(cb.id, cb);
        return;
    }
    const live = ov.boxes.find((b) => b.id === cb.id);
    if (live) { live.x = cb.x; live.y = cb.y; live.w = cb.w; live.h = cb.h; ov.render(); }
    editBox(st.desc.canvasKey, cb);
}

function panelSpec(st) {
    return {
        host: st.panel,
        isOutside: (t) => !st.nodeEl.contains(t),
        commit: (boxes) => { const b = boxes.get(st.desc.boxId); if (b) st.desc.write(st.desc.fromCanvas(b)); },
        restore: () => { Object.assign(st.draft, st.desc.get()); rectEditSyncInputs(st, true); },
    };
}

function rectEditRow(label, k, draft, locked) {
    const inp = h("input", { type: "number", class: "redit", dataset: { k }, step: "0.001",
        min: (k === "x" || k === "y") ? "0" : String(MIN_FRAC), max: "1",
        value: (+draft[k]).toFixed(4), disabled: locked,
        oninput: (e) => { draft[k] = +e.target.value; rectEditPush(); } });
    return kv(label, inp);
}

// Toggled by the node header's .gn-rectbtn (main.js). Opening a SECOND node's editor closes the
// first — closing is NOT a commit any more: an uncommitted edit lives on in its rect batch (with
// the ✓/✕ bar on the canvas it draws on) until Enter / Escape / a click outside resolves it.
function toggleRectEditor(nodeEl, n) {
    if (activeRectEdit) {
        const wasSameNode = activeRectEdit.nodeId === n.id;
        closeRectEditor();
        if (wasSameNode) return;   // plain toggle-off
    }
    const desc = rectDescriptor(n);
    const box = desc.get();
    if (!box) return;   // nothing to edit yet (e.g. a scrollbar box never drawn)
    const draft = { ...box };
    const body = nodeEl.querySelector(".gn-body");
    if (!body) return;
    const panel = h("div", { class: "gn-rectedit", title: desc.locked ? "locked — remove the scrollbar's calibration cutouts to move it" : null },
        h("div", { class: "gn-grid" },
            rectEditRow("x", "x", draft, desc.locked), rectEditRow("y", "y", draft, desc.locked),
            rectEditRow("width", "w", draft, desc.locked), rectEditRow("height", "h", draft, desc.locked)));
    body.appendChild(panel);
    nodeEl.querySelector(".gn-rectbtn")?.classList.add("on");
    // Outside click closes the panel. The box being edited draws on a DIFFERENT node's canvas, so
    // dragging it there must not count as "outside" — only close when the click lands outside
    // both this node AND the bound overlay's canvas host.
    const outside = (ev) => {
        if (nodeEl.contains(ev.target)) return;
        const hostEntry = desc.itemId
            ? itemCanvases.get(`${desc.winId}:${desc.itemId}`)
            : imageCanvases.get(desc.winId);
        if (hostEntry?.host.contains(ev.target)) return;
        closeRectEditor();
    };
    document.addEventListener("pointerdown", outside, true);
    activeRectEdit = { nodeId: n.id, nodeEl, desc, draft, panel, outside };
    overlaySelected(desc.canvasKey, desc.boxId);   // the box becomes the canvas's active selection (targets WASD too)
}

function closeRectEditor() {
    const st = activeRectEdit;
    if (!st) return;
    document.removeEventListener("pointerdown", st.outside, true);
    // A panel-hosted batch dies with its host (the ✓/✕ bar lives INSIDE the panel), so land it here.
    // A canvas-hosted batch outlives the panel — its bar is on the canvas, still resolvable.
    if (rectTxn.dirty(`panel:${st.nodeId}`)) rectTxn.commitIfDirty();
    st.panel.remove();
    st.nodeEl.querySelector(".gn-rectbtn")?.classList.remove("on");
    activeRectEdit = null;
}

// Mirrors a canvas-driven box change (mouse drag, WASD, or a batch commit) into an OPEN rect-edit
// panel's inputs. `overlayKey` is the registry key ("win:<id>" or "item:<winId>:<itemId>") of the
// overlay that just changed; a no-op unless that's the overlay the open editor is bound to. Prefers
// the box's UNCOMMITTED draft over the model — while a rect batch is open the model still holds the
// clean value, and the inputs must show what's on screen.
function rectEditCanvasSync(overlayKey) {
    const st = activeRectEdit;
    if (!st || st.desc.canvasKey !== overlayKey) return;
    const draft = rectTxn.pendingFor(overlayKey)?.get(st.desc.boxId);
    const box = draft ? st.desc.fromCanvas(draft) : st.desc.get();
    if (!box) return;
    Object.assign(st.draft, box);
    rectEditSyncInputs(st, false);
}

// Push `st.draft` into the four number inputs. `force` overwrites even the focused one (a revert
// must reset the field you were typing in); otherwise the input under the cursor is left alone.
function rectEditSyncInputs(st, force) {
    for (const k of ["x", "y", "w", "h"]) {
        const inp = st.panel.querySelector(`.redit[data-k="${k}"]`);
        if (inp && (force || document.activeElement !== inp)) inp.value = (+st.draft[k]).toFixed(4);
    }
}

// The image surface lives INSIDE the window node's `.win-img` host — one per window node,
// built once and always present. Draw tools sit above the canvas; the page nav, image
// selector, recapture and "preview all" sit BELOW it. There is no clear/close button.
// `nodeEl` is the window node element when known by the caller (wireNode passes it): the surface
// is built during buildNode(), BEFORE render() registers the node in nodeEls, so a nodeEls lookup
// would miss it and the node would render with an empty .win-img (no canvas, no capture buttons).
// Other callers (load-time pendingOpenImages, precapture) omit it and resolve via nodeEls.
async function openImage(winId, nodeEl = null) {
    // TEMP diagnostic: pin down exactly when/how openImage is invoked during boot (ms-resolution,
    // since the log bar's own timestamp is 1s granularity) — remove once the boot freeze is found.
    log(`[diag] openImage(${winId}) boot=${boot.phase} nodeEl=${!!nodeEl} t=${performance.now().toFixed(1)}`, "dim");
    const node = nodeEl || nodeEls.get(`win:${winId}`);
    const host = node && node.querySelector(".win-img");
    if (!host) return;
    // Idempotent only against the LIVE node's host: a stale entry (e.g. a measurement probe or a
    // removed/recreated same-id window registered against a now-detached host) must NOT short-
    // circuit — else the real node's .win-img renders empty (no canvas, no capture buttons).
    const prev = imageCanvases.get(winId);
    if (prev && prev.host === host) return;   // surface already built on THIS host — leave it
    if (prev) { unregisterOverlay(`win:${winId}`); imageCanvases.delete(winId); openImages.delete(winId); }
    host.replaceChildren(
        h("div", { class: "imgtools" },
            h("span", { class: "tools" },
                KINDS.map(([v, label, icon, tip]) =>
                    h("button", { class: "tool", dataset: { kind: v }, title: tip || `draw ${label}` }, `${icon} ${label}`)))),
        h("div", { class: "canvas-wrap" }, h("canvas")),
        h("div", { class: "img-foot" },
            h("span", { class: "img-pages", hidden: true },
                h("button", { class: "imgpg", dataset: { d: "-1" }, title: "previous image" }, "‹"),
                h("span", { class: "img-pageind" }),
                h("button", { class: "imgpg", dataset: { d: "1" }, title: "next image" }, "›")),
            h("button", { class: "imgbtn", title: "choose which stashed images this window uses" },
                h("span", { class: "imgbtn-lbl" }, "images")),
            h("button", { class: "imgcap", title: "capture the live window as a new image for this window" }, "capture"),
            h("button", { class: "imgall", title: "preview data read from ALL of this window's images" }, "preview all")),
        imgLayers());
    const canvas = host.querySelector("canvas");
    const { kindOf, canCreate } = wireTools(host);   // one shared tool group; no draw until a tool is armed
    const overlay = new Overlay(canvas, {
        onCreate: async (geom) => {
            const k = kindOf();
            if (!k) return;   // no draw tool armed → drawing is a no-op (canCreate also blocks it upstream)
            rectTxn.commitIfDirty();   // a new box persists+autosaves immediately; land any pending edit first
            if (k === "item") { await createItemFromGeom(winId, geom); return; }   // freeze + spawn item node
            let newDetect = null, newNode = null;   // the node this draw spawned → inherit the window's group
            if (k === "detect") { newDetect = model.addDetect(winId, geom); newNode = `det:${winId}:${newDetect}`; }
            else if (k === "scrollbar") { model.setScrollbar(winId, geom); newNode = `sb:${winId}:scrollbar`; }
            else if (k === "data_area") model.setDataArea(winId, geom);   // a window box, not its own node
            else if (k === "readout") newNode = `ro:${winId}:${model.addReadout(winId, geom)}`;
            else newNode = `reg:${winId}:${model.addRegion(winId, geom)}`;
            clearGrid(winId);   // layout changed → detected grid is stale
            // park the new node right BESIDE its window (srcId) before render() so ensurePositions
            // leaves it alone — no autoplacement into a far column.
            if (newNode) await placeNewNode(newNode, k, `win:${winId}`);
            render(); refreshImageBoxes(winId); autosave(winId);   // re-OCR only this window
            if (k === "readout") rebuildReadoutConsumers();   // toast/watch dropdowns
            if (newDetect) rebuildNode(`win:${winId}`);   // add the new detector to the window's detects section
            if (newNode) inheritGroupFrom(newNode, `win:${winId}`);   // box drawn on a grouped window → join its group
            if (newDetect) prefillDetectText(winId, newDetect);
            drawEdges();   // edge to the window drawn immediately
        },
        // mouse move/resize AND keyboard (WASD/shift+WASD) both open the SAME rect transaction, which
        // commits through persistWinBox — so every role a box can have is honoured identically by both
        // (rule 7 — the two writers used to diverge and readout/item boxes silently wrote as regions
        // under WASD). Nothing is persisted or re-read until the batch commits.
        onChange: (box) => editBox(`win:${winId}`, box),
        onSelect: (id) => overlaySelected(`win:${winId}`, id),
        canCreate,   // no crosshair / no new box until a draw tool is armed
    });
    imageCanvases.set(winId, { host, canvas, overlay });
    registerOverlay(`win:${winId}`, { overlay, kind: "window", winId,
        persist: (b) => persistWinBox(winId, b), refresh: () => refreshImageBoxes(winId) });
    overlay.setWorldZoom(view.zoom);
    openImages.add(winId);
    persist.layout();
    host.querySelector(".imgbtn").addEventListener("click", () => openCaptureModal(winId));   // pick image(s)
    host.querySelector(".imgcap").addEventListener("click", () => loadImage(winId, true));   // recapture re-reads
    host.querySelector(".imgall").addEventListener("click", (e) => previewAll(winId, e.currentTarget));
    host.querySelectorAll(".imgpg").forEach((b) => b.addEventListener("click", () => stepWinPage(winId, +b.dataset.d)));
    host.querySelectorAll(".imglayer").forEach((c) => c.addEventListener("change", (e) =>
        overlay.setVisible({ [e.target.dataset.k]: e.target.checked })));   // toggle a draw layer on the canvas
    await loadImage(winId, false);   // its onload now refreshes detect once the pixels are in
    drawEdges();
}

// ---- colour eyedropper (detector colour + preprocess text-colour picks) ----
// Shared sample flow for a window's detect-node colour and its preprocess ("text appearance")
// colour list — armed by a node button, the next canvas click feeds the picked hex to the right
// sink (see applyPickedColor).
let _pickTarget = null;   // {winId, detId} armed by a detect node's eyedropper button

// You arm the eyedropper on a node but complete the sample by clicking the window's image canvas —
// a DIFFERENT node. Without this guard that pointerdown reads as "you left the card" and silently
// commits the node's pending config edit out from under the pick (node_txn.js). Scoped to the
// canvas click that actually FEEDS the pick: an armed-but-unused eyedropper must not swallow every
// other outside-click and strand the edit uncommittable.
nodeTxn.addOutsideGuard((t) => !!_pickTarget && !!t?.closest?.(".canvas-wrap"));

export function armColorPick(winId, detId) {
    _pickTarget = { winId, detId };
    const ov = imageCanvases.get(winId)?.overlay;
    if (ov) { ov.setPick(true); setStatus("click the image to sample a color"); }
    else setStatus("open the image first");
}

// Arm the eyedropper to feed the window's preprocess (Text appearance) colour list
// instead of a detector's colour. Same sample flow, different sink (see applyPickedColor).
export function armPreprocessPick(winId) {
    _pickTarget = { winId, pp: true };
    const ov = imageCanvases.get(winId)?.overlay;
    if (ov) { ov.setPick(true); setStatus("click the image to sample the text color"); }
    else setStatus("open the image first");
}

// A picked colour is just another edit to the node that armed the eyedropper, so it JOINS that
// node's pending transaction rather than saving on its own: the sample paints immediately, the
// re-read waits for ✓/Enter, and Escape drops the colour along with the rest of the edit.
function applyPickedColor(winId, hex) {
    const t = _pickTarget; _pickTarget = null;
    if (!t || t.winId !== winId) return;
    if (t.pp) {                                   // eyedropper armed for window preprocess
        nodeEdit(`win:${winId}`, "read",
            () => { model.addPreprocessColor(winId, hex); rebuildNode(`win:${winId}`); },   // refresh the colour chips
            () => autosave(winId));               // preprocess changes OCR input -> re-read this window
        return;
    }
    const d = model.detect(winId, t.detId);
    if (!d) return;
    nodeEdit(`det:${winId}:${t.detId}`, "read", () => {
        d.color = hex;
        rebuildNode(`det:${winId}:${t.detId}`);   // refresh swatch + hex input
        refreshImageBoxes(winId);
    }, () => { autosave(null); refreshDetect(winId); });
}

// ---- cutout atlas node -----------------------------------------------------
// Standalone node (its OWN image surface, keyed winId "atlas"; the image/box stack is shared
// via nodeIdOf, rule 7). Separate from the game node because that canvas already hosts gate
// detectors. Teaches TWO kinds of cutout in one shared list (CLAUDE.md rule 7 — one atlas, not
// a second copy for symbols): GLYPH (a single OCR character, refines text reads) and SYMBOL (a
// whole icon, e.g. a mod school glyph, classified for a `type: symbol` field). Teaching model:
// pick the "glyph" or "symbol" draw tool, drag a box round the cutout (it's selected immediately
// so WASD can nudge it without an extra click), type its label, confirm -> the crop is frozen
// into the atlas and the box is cleared. Boxes are dragged/resized with the mouse (the app-wide
// dragresize, precise), same as every other overlay box. The auto-glypher (glyph kind only — a
// whole icon isn't a segmentable word) segments a labelled word into per-character proposals the
// user edits + confirms (its boxes are editable the same way).

const CUT_RECT_ID = "__cutrect";
const GLYPH_PROP_PREFIX = "__glyphprop:";   // per-proposal editable box id -> `${prefix}${index}` (auto-glypher, glyph-only)
let cutRect = null;          // pending manual cutout box on the atlas surface (fractions); null = hidden
let composeKind = "glyph";   // which pool the compose row currently teaches: "glyph" | "symbol"
let glyphPending = [];       // auto-glypher proposals awaiting edit+confirm: [{char, box:{x,y,w,h}}]

// Redraw the pending cutout box (refreshImageBoxes folds cutRect in for the "atlas" surface).
// Auto only applies to glyph-kind (word segmentation), so its button is shown only while a box
// is armed AND the compose row is teaching a glyph.
function drawCutRect() {
    refreshImageBoxes("atlas");
    const auto = nodeEls.get("atlas")?.querySelector(".gc-auto");
    if (auto) auto.hidden = !cutRect || composeKind !== "glyph";
    refreshCutPreview();
}

// Live cutout of the currently-drawn box, on the SAME row as its label/save/cancel controls
// (.glyph-preview — a static row built once in openAtlasImage, so typing/focus survive every
// box move/nudge instead of being rebuilt from scratch). Repoints the thumb's `src` in place;
// visibility is driven entirely by showCompose (thumb/char/confirm/cancel show/hide together).
function refreshCutPreview() {
    const { thumb } = composeEls();
    if (thumb && !thumb.hidden && cutRect) thumb.src = cutThumbSrc(cutRect);
}

// Write a moved/resized/nudged box back to its source (the armed rect or an auto-glypher
// proposal). The overlay's onChange (mouse) and the shared WASD nudge (registry persist) both
// route here — one writer, so a 1-pixel WASD step and a drag land in the same place (rule 7).
function persistCutBox(b) {
    if (b.id === CUT_RECT_ID) { cutRect = { x: b.x, y: b.y, w: b.w, h: b.h }; refreshCutPreview(); return; }
    if (b.id.startsWith(GLYPH_PROP_PREFIX)) {
        const i = +b.id.slice(GLYPH_PROP_PREFIX.length);
        if (glyphPending[i]) { glyphPending[i].box = { x: b.x, y: b.y, w: b.w, h: b.h }; refreshGlyphThumb(i); }
    }
}

// Crop a box (window fractions) out of the atlas surface's LOADED image into a small data URL —
// the preview thumbnail beside a cutout's label, so the user can see what they're labelling.
// Client-side (no server round-trip / no saved PNG); the real crop is frozen on save.
function cutThumbSrc(box) {
    const img = imageCanvases.get("atlas")?.overlay?.img;
    if (!img || !img.naturalWidth) return "";
    const sx = box.x * img.naturalWidth, sy = box.y * img.naturalHeight;
    const sw = Math.max(1, box.w * img.naturalWidth), sh = Math.max(1, box.h * img.naturalHeight);
    const dh = 96, dw = Math.max(1, Math.round(sw * dh / sh));   // render tall enough to stay sharp when blown up
    const c = document.createElement("canvas");
    c.width = dw; c.height = dh;
    c.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, dw, dh);
    return c.toDataURL();
}

// Repoint one proposal's thumbnail after its box moved/resized (no DOM rebuild -> no focus loss).
function refreshGlyphThumb(i) {
    const img = nodeEls.get("atlas")?.querySelector(`.gp-thumb[data-i="${i}"]`);
    if (img && glyphPending[i]) img.src = cutThumbSrc(glyphPending[i].box);
}

// proposal box id <-> list index, and the two-way selection mirror between canvas box and row.
function propIndexFromId(id) {
    return (id && id.startsWith(GLYPH_PROP_PREFIX)) ? +id.slice(GLYPH_PROP_PREFIX.length) : null;
}
function markGlyphPropSelected(i) {
    nodeEls.get("atlas")?.querySelectorAll(".gp-cell")
        .forEach((c) => c.classList.toggle("selected", +c.dataset.i === i));
}
function selectGlyphProp(i) {   // clicking a suggestion image selects its box on the canvas
    const id = `${GLYPH_PROP_PREFIX}${i}`;
    imageCanvases.get("atlas")?.overlay.setActive(id);
    overlaySelected("atlas", id);
    markGlyphPropSelected(i);
}
function discardGlyphProp(node, i) {   // drop ONE suggestion (+ its box); ids reindex on rebuild
    glyphPending.splice(i, 1);
    imageCanvases.get("atlas")?.overlay.setActive(null);   // stale selection after reindex
    refreshGlyphPending(node);
    drawCutRect();
}

// "auto after draw" toggle state (atlas node checkbox): drawing a box runs auto immediately
// (glyph kind only).
function glyphAutoOn() { return !!nodeEls.get("atlas")?.querySelector(".gc-autochk")?.checked; }

function composeEls() {
    const node = nodeEls.get("atlas");
    const toolHost = node && node.querySelector(".glyph-img");
    const previewHost = node && node.querySelector(".glyph-preview");
    return {
        thumb: previewHost?.querySelector(".glyph-thumb"),
        char: previewHost?.querySelector(".gc-char"), confirm: previewHost?.querySelector(".gc-confirm"),
        cancel: previewHost?.querySelector(".gc-cancel"),
        auto: toolHost?.querySelector(".gc-auto"), autotoggle: toolHost?.querySelector(".gc-autotoggle"), div: toolHost?.querySelector(".gc-div"),
    };
}

// Sync the compose row to whichever draw tool is ARMED right now (null = none): GLYPH (single
// OCR char, word auto-segmenter available) or SYMBOL (a whole icon/label, e.g. a mod school
// glyph — no segmentation). The tool buttons themselves show which is armed (wireTools' own
// .active class) — this only adjusts the label input + auto-glypher visibility to match. The
// auto-glypher row is visible ONLY while the glyph tool is the one currently armed (`kind`, not
// the remembered `composeKind` — disarming must hide it even though a box may still be pending).
function applyComposeKind(kind) {
    if (kind) composeKind = kind;   // remember for the pending box's label/save; null keeps it
    const { char, auto, autotoggle, div } = composeEls();
    if (char && kind) {
        char.maxLength = kind === "glyph" ? 1 : 40;
        char.placeholder = kind === "glyph" ? "char" : "label";
        char.classList.toggle("wide", kind === "symbol");   // widen for a multi-char label
        char.title = kind === "glyph" ? "the single character inside the box (Enter to save, Esc to cancel)"
            : "the school/category this icon stands for, e.g. Madurai (Enter to save, Esc to cancel)";
    }
    const showAuto = kind === "glyph";   // only while GLYPH is the armed tool
    if (auto) auto.hidden = showAuto ? !cutRect : true;
    if (autotoggle) autotoggle.hidden = !showAuto;
    if (div) div.hidden = !showAuto;
}

function showCompose(on) {
    const { thumb, char, confirm, cancel } = composeEls();
    for (const el of [thumb, char, confirm, cancel]) if (el) el.hidden = !on;
    if (on && char) char.value = "";   // no auto-focus — typing shouldn't be forced on the user
    if (on) refreshCutPreview();       // thumb just became visible -> give it its crop now
}

function cancelCompose() {
    cutRect = null;
    showCompose(false);
    drawCutRect();
}

async function saveCutout() {
    const { char } = composeEls();
    const label = (char?.value || "").trim();
    if (!cutRect) return;
    if (!label) { setStatus(`type the ${composeKind === "glyph" ? "character" : "label"} under the box first`); char?.focus(); return; }
    const game = model.profile.name;
    const cap = await curCapOf("atlas");
    if (!cap) { setStatus("pick an image (or capture) to teach the atlas from first"); return; }
    let cut;
    try { cut = await api.atlasCutout(game, cap, cutRect); }   // freeze the crop NOW (independent of the canvas image after)
    catch (e) { setStatus(String(e.message || e)); return; }
    model.addCutout({ label, image: cut.name, kind: composeKind });
    cancelCompose();          // permanent now: clear the rect + compose row
    refreshAtlasList();
    autosave(null);
}

async function runAutoGlypher() {
    if (!cutRect || composeKind !== "glyph") return;   // word segmentation is glyph-kind only
    const game = model.profile.name;
    const cap = await curCapOf("atlas");
    if (!cap) { setStatus("pick an image (or capture) first"); return; }
    let props;
    try { props = await api.glyphAuto(game, cap, cutRect); }
    catch (e) { setStatus(String(e.message || e)); return; }
    glyphPending = props || [];
    if (glyphPending.length) {
        cutRect = null; showCompose(false); drawCutRect();   // hand off to the editable boxes
        refreshGlyphPending();
        setStatus(`auto: ${glyphPending.length} glyphs — drag/resize the boxes, fix labels, then save all`);
    } else {
        // nothing recognised: keep the box and fall back to manual — its cutout preview stays up
        showCompose(true); drawCutRect();
        refreshGlyphPending();
        setStatus("auto found no text — label the box by hand, or adjust it and try auto again");
    }
}

export async function openAtlasImage(nodeEl = null) {
    const winId = "atlas";
    const node = nodeEl || nodeEls.get("atlas");
    const host = node && node.querySelector(".glyph-img");
    if (!host) return;
    const prev = imageCanvases.get(winId);
    if (prev && prev.host === host) { refreshAtlasList(false, node); return; }
    if (prev) { unregisterOverlay("atlas"); imageCanvases.delete(winId); openImages.delete(winId); }
    host.replaceChildren(
        h("div", { class: "imgtools glyph-compose" },
            h("span", { class: "tools" },
                h("button", { class: "tool", dataset: { kind: "glyph" }, title: "draw tool: GLYPH — drag a box round ONE character (drag/resize to fine-tune), label it, then Save. Refines text reads (e.g. Q↔G) on glyph-check fields." }, "◻ glyph"),
                h("button", { class: "tool", dataset: { kind: "symbol" }, title: "draw tool: SYMBOL — drag a box round a whole icon (e.g. a mod school glyph), label it, then Save. Classified for a `symbol` field, colour-agnostically." }, "◈ symbol")),
            h("span", { class: "gc-div", hidden: true }),
            h("button", { class: "gc-auto", hidden: true, title: "auto: OCR the drawn box and split it into one glyph per character (labels prefilled) for you to correct + confirm" }, "auto"),
            h("label", { class: "gc-autotoggle", hidden: true, title: "auto after draw: drawing a box immediately runs OCR instead of asking for a single char" },
                h("input", { type: "checkbox", class: "gc-autochk" }), "auto after draw")),
        h("div", { class: "canvas-wrap" }, h("canvas")),
        h("div", { class: "img-foot" },
            h("span", { class: "img-pages", hidden: true },
                h("button", { class: "imgpg", dataset: { d: "-1" }, title: "previous image" }, "‹"),
                h("span", { class: "img-pageind" }),
                h("button", { class: "imgpg", dataset: { d: "1" }, title: "next image" }, "›")),
            h("button", { class: "imgbtn", title: "choose which stashed images to teach the atlas from" },
                h("span", { class: "imgbtn-lbl" }, "images")),
            h("button", { class: "imgcap", title: "capture the live game window as a new image" }, "capture")));
    // label/save/cancel sit on the SAME ROW as the live cutout preview (.glyph-preview, a sibling
    // node-template div) — built once, statically, so typing/focus survive every box move/nudge
    // instead of being rebuilt (refreshCutPreview only repoints the thumb's `src` in place).
    const previewHost = node.querySelector(".glyph-preview");
    if (previewHost) previewHost.replaceChildren(
        h("img", { class: "glyph-thumb", hidden: true, alt: "cutout", title: "the box's cutout — this is what gets saved" }),
        h("input", { class: "gc-char", maxlength: "1", size: "6", placeholder: "char", hidden: true, title: "the single character inside the box (Enter to save, Esc to cancel)" }),
        h("button", { class: "gc-confirm", hidden: true, title: "save this cutout permanently" }, "save"),
        h("button", { class: "gc-cancel", hidden: true, title: "cancel" }, "✕"));
    const canvas = host.querySelector("canvas");
    // two draw tools (glyph/symbol) in one radio group: arming one shows the compose row primed
    // for that kind. Disarming (incl. a central clearTools from Escape/right-click/click-outside)
    // only stops a NEW box being drawn — it must NOT discard an already-drawn, unsaved cutout
    // (e.g. a right-click to pan the reference image mid-edit shouldn't wipe pending work).
    // Abandoning it is an explicit act: the ✕ cancel button, or Escape while the label is focused.
    const { kindOf, canCreate } = wireTools(host, { onChange: (kind) => {
        applyComposeKind(kind);   // null on disarm -> hides the auto-glypher row regardless of the last-drawn kind
        if (kind) setStatus(`draw a box round the ${kind === "glyph" ? "character" : "icon"}, then label it`);
    } });
    const overlay = new Overlay(canvas, {
        // The armed tool creates the box for one manual cutout, tagged with its kind; the
        // auto-glypher's arm rect and each proposal box are created programmatically. All boxes
        // are then drag/resizable with the mouse (the app-wide dragresize), same as every other
        // overlay box.
        onCreate: (geom) => {
            const k = kindOf();
            if (!k) return;   // drawing is a no-op until a draw tool is picked
            cutRect = { x: geom.x, y: geom.y, w: geom.w, h: geom.h };
            composeKind = k;
            // select the just-drawn box immediately so WASD can nudge it without an extra click
            overlay.setActive(CUT_RECT_ID);
            overlaySelected("atlas", CUT_RECT_ID);
            if (k === "glyph" && glyphAutoOn()) { drawCutRect(); runAutoGlypher(); }   // "auto after draw": OCR the box immediately
            else { showCompose(true); drawCutRect(); }           // else the manual label flow
        },
        onChange: (box) => persistCutBox(box),
        // make atlas the active box overlay (WASD targets its box) AND mirror the selection into
        // the proposal list, so selecting a box on the canvas highlights its suggestion row
        onSelect: (id) => { overlaySelected("atlas", id); markGlyphPropSelected(propIndexFromId(id)); },
        canCreate,   // no crosshair/draw without a draw tool armed
        minFrac: 0.0005,   // a single glyph/icon is tiny vs the whole window — allow a much smaller box
    });
    imageCanvases.set(winId, { host, canvas, overlay });
    registerOverlay("atlas", { overlay, kind: "atlas", winId,
        persist: (b) => persistCutBox(b), refresh: () => refreshImageBoxes("atlas") });
    overlay.setWorldZoom(view.zoom);
    openImages.add(winId);
    persist.layout();
    previewHost?.querySelector(".gc-confirm").addEventListener("click", saveCutout);
    previewHost?.querySelector(".gc-cancel").addEventListener("click", cancelCompose);
    previewHost?.querySelector(".gc-char").addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); saveCutout(); }
        else if (e.key === "Escape") { e.preventDefault(); cancelCompose(); }
    });
    host.querySelector(".gc-auto").addEventListener("click", runAutoGlypher);
    host.querySelector(".imgbtn").addEventListener("click", () => openCaptureModal("atlas"));
    host.querySelector(".imgcap").addEventListener("click", () => loadImage("atlas", true));
    host.querySelectorAll(".imgpg").forEach((b) => b.addEventListener("click", () => stepWinPage("atlas", +b.dataset.d)));
    applyComposeKind(null);   // nothing armed yet -> auto-glypher row starts hidden
    refreshAtlasList(false, node);
    refreshGlyphPending(node);
    await loadImage("atlas", false);
    drawEdges();
}

// Auto-glypher proposals: one editable char per proposal box (the boxes themselves live on the
// canvas — drag/resize to adjust), plus save-all / discard. Nothing is cropped or saved until
// "save all": each box is frozen into a glyph-kind cutout THEN, so box edits are honoured. A
// blanked char is skipped. Editing a char here relabels its box live (refreshImageBoxes).
export async function commitGlyphProposals(node) {
    const game = model.profile.name;
    const cap = await curCapOf("atlas");
    if (!cap) { setStatus("pick an image (or capture) to teach glyphs from first"); return; }
    const wanted = glyphPending.filter((p) => p.char);   // skip any the user blanked out
    const added = [];
    for (const p of wanted) {
        try { const cut = await api.atlasCutout(game, cap, p.box); added.push({ char: p.char, image: cut.name }); }
        catch (e) { setStatus(String(e.message || e)); return; }   // stop on first failure, keep the rest editable
    }
    if (added.length) model.addCutouts(added, "glyph");
    glyphPending = [];
    refreshGlyphPending(node); refreshAtlasList(); drawCutRect(); autosave(null);
    setStatus(`saved ${added.length} glyph${added.length === 1 ? "" : "s"}`);
}

export function refreshGlyphPending(nodeEl = null) {
    const node = nodeEl || nodeEls.get("atlas");
    const host = node && node.querySelector(".glyph-pending");
    if (!host) return;
    if (!glyphPending.length) { host.replaceChildren(); return; }
    const rows = glyphPending.map((p, i) => h("div", { class: "glyph-cell gp-cell", dataset: { i } },
        h("img", { class: "glyph-thumb gp-thumb", src: cutThumbSrc(p.box), alt: p.char || "?",
            title: "the glyph this box covers — click to select its box, then drag/resize or WASD-nudge it", dataset: { i } }),
        h("input", { class: "gp-char", maxlength: "1", size: "1", value: p.char || "", placeholder: "?",
            title: "which character this box is; the box is on the image — click the image to select it", dataset: { i } }),
        h("button", { class: "gp-rm danger", dataset: { i }, title: "discard this suggestion" }, TRASH())));
    host.replaceChildren(
        h("div", { class: "glyph-head" },
            h("span", { class: "flab" }, `auto — adjust boxes + labels, then save all [${glyphPending.length}]`),
            h("button", { class: "gp-confirm" }, "save all"),
            h("button", { class: "gp-discard danger" }, "discard")),
        h("div", { class: "glyph-grid" }, ...rows));
    host.querySelectorAll(".gp-char").forEach((inp) =>
        inp.addEventListener("input", (e) => {
            glyphPending[+e.target.dataset.i].char = e.target.value.trim();
            drawCutRect();   // relabel the box on the canvas live
        }));
    // clicking anywhere in a cell selects its box (so it drags/WASD-nudges); the trash button keeps
    // its own action. WASD never moves the box while the char input is focused — the global key
    // handler bails on a focused INPUT (main.js), so typing a label stays safe.
    host.querySelectorAll(".gp-cell").forEach((cell) =>
        cell.addEventListener("click", (e) => {
            if (e.target.closest(".gp-rm")) return;   // trash handles its own click
            selectGlyphProp(+cell.dataset.i);
        }));
    host.querySelectorAll(".gp-rm").forEach((btn) =>
        btn.addEventListener("click", (e) => discardGlyphProp(node, +e.currentTarget.dataset.i)));
    host.querySelector(".gp-confirm").addEventListener("click", () => commitGlyphProposals(node));
    host.querySelector(".gp-discard").addEventListener("click", () => { glyphPending = []; refreshGlyphPending(node); drawCutRect(); });
    markGlyphPropSelected(propIndexFromId(imageCanvases.get("atlas")?.overlay.activeId));   // keep highlight across rebuilds
}

// The taught cutout atlas list: a thumbnail + editable label + kind chip + delete per cutout,
// kept grouped by kind then alphabetical (model.sortAtlas). Event-driven (rebuilt on
// add/edit/delete, not a poll), so a full rebuild of this small list is fine (rule 1 is about
// steady-state poll redraws).
export function refreshAtlasList(focusLast = false, nodeEl = null) {
    const node = nodeEl || nodeEls.get("atlas");
    const host = node && node.querySelector(".glyph-atlas");
    if (!host) return;
    const game = model.profile.name;
    const cutouts = model.atlas();
    const rows = cutouts.map((c, i) => {
        const on = c.enabled !== false;
        const kind = c.kind || "glyph";
        return h("div", { class: on ? "glyph-cell" : "glyph-cell disabled", dataset: { i } },
            h("input", { type: "checkbox", class: "glyph-en", checked: on, dataset: { i },
                title: on ? "cutout enabled — click to mute it (kept, but ignored by matching)" : "cutout muted — click to enable" }),
            h("img", { class: "glyph-thumb", src: api.atlasUrl(game, c.image), alt: c.label || "?", title: "taught cutout (crop is frozen)" }),
            h("button", { class: `glyph-kind-chip glyph-kind-${kind}`, dataset: { i },
                title: kind === "glyph" ? "glyph — click to switch to symbol" : "symbol — click to switch to glyph" }, kind),
            h("input", { class: kind === "symbol" ? "glyph-char wide" : "glyph-char", maxlength: kind === "symbol" ? 40 : 1,
                size: kind === "symbol" ? 10 : 1, value: c.label || "", placeholder: kind === "symbol" ? "label" : "?",
                title: kind === "glyph" ? "which character this glyph is" : "the school/category this icon stands for", dataset: { i } }),
            h("button", { class: "glyph-rm danger", dataset: { i }, title: "remove cutout" }, TRASH()));
    });
    host.replaceChildren(...[
        cutouts.length ? subhead("cutout atlas") : null,   // subheading only when non-empty (rule 7 — shared primitive)
        cutouts.length ? h("div", { class: "glyph-grid" }, ...rows) : null,
    ].filter(Boolean));   // never pass null to replaceChildren -> it stringifies to a "null" text node
    host.querySelectorAll(".glyph-char").forEach((inp) => {
        inp.addEventListener("change", (e) => { model.setCutoutLabel(+e.target.dataset.i, e.target.value.trim()); refreshAtlasList(); autosave(null); });
        inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); e.target.blur(); } });
    });
    host.querySelectorAll(".glyph-en").forEach((chk) => chk.addEventListener("change", (e) => {
        model.setCutoutEnabled(+e.target.dataset.i, e.target.checked); refreshAtlasList(); autosave(null);
    }));
    host.querySelectorAll(".glyph-kind-chip").forEach((chip) => chip.addEventListener("click", (e) => {
        const i = +e.currentTarget.dataset.i;
        const cur = cutouts[i]?.kind || "glyph";
        model.setCutoutKind(i, cur === "glyph" ? "symbol" : "glyph");
        refreshAtlasList(); autosave(null);
    }));
    host.querySelectorAll(".glyph-rm").forEach((btn) => btn.addEventListener("click", () => {
        model.removeCutout(+btn.dataset.i); refreshAtlasList(); autosave(null);
    }));
    if (focusLast && cutouts.length) host.querySelector(`.glyph-char[data-i="${cutouts.length - 1}"]`)?.focus();
}

// ---- item template nodes (frozen cutout + cell-relative fields/tells) ------

// Drawing an "item" box on the fullscreen image freezes that crop and spawns a node.
async function createItemFromGeom(winId, geom) {
    const game = model.profile.name;
    const cap = await curCapOf(winId);   // freeze the crop from the page on screen
    if (!cap) { setStatus("capture the window first"); return; }
    let cut;
    try { cut = await api.itemCutout(game, cap, geom); }
    catch (e) { setStatus(String(e.message || e)); return; }
    const itemId = model.addItem(winId, { cutout: cut.name, cutout_box: geom, box: geom });
    clearGrid(winId);
    // park beside its window before render() so ensurePositions skips it — no autoplacement.
    await placeNewNode(`item:${winId}:${itemId}`, "item", `win:${winId}`);
    render(); refreshImageBoxes(winId); autosave(winId);   // re-OCR only this window
    rebuildNode(`win:${winId}`);   // new template into the window's items list (render() keeps existing bodies)
    inheritGroupFrom(`item:${winId}:${itemId}`, `win:${winId}`);   // box drawn on a grouped window → join its group
    drawEdges();   // edge to the window drawn immediately
    openItemImage(winId, itemId);
}

function closeItemImage(winId, itemId) {
    const key = `${winId}:${itemId}`;
    const e = itemCanvases.get(key);
    if (e && e.overlay) e.overlay.destroy();   // dispose the overlay's ResizeObserver (created per open)
    if (e && e.host) e.host.replaceChildren();
    itemCanvases.delete(key);
    itemReads.delete(key);
    _readItems.delete(key);   // drop a still-pending scheduled read (runItemRead no-ops anyway once itemCanvases loses the key)
    unregisterOverlay(`item:${winId}:${itemId}`);
    drawEdges();
}

// Build the cutout canvas inside an item node and wire drawing of cell/fields/tells.
// Resize the item's CELL box WITHOUT dragging its fields/tells along. Children are stored
// RELATIVE to the cell, so changing the cell naively rescales them; re-anchor each child so
// its absolute (window-fraction) box is preserved across the cell change.
function setItemCellKeepingChildren(winId, itemId, newWinBox) {
    const it = model.item(winId, itemId);
    const old = it && it.box;
    if (!old || !old.w || !old.h) { model.setItemBox(winId, itemId, newWinBox); return; }
    const toAbs = (b, c) => ({ x: c.x + b.x * c.w, y: c.y + b.y * c.h, w: b.w * c.w, h: b.h * c.h });
    const toRel = (b, c) => ({ x: (b.x - c.x) / c.w, y: (b.y - c.y) / c.h, w: b.w / c.w, h: b.h / c.h });
    const fAbs = (it.fields || []).map((f) => toAbs(f.box, old));
    const tAbs = (it.tells || []).map((t) => toAbs(t.box, old));
    model.setItemBox(winId, itemId, newWinBox);
    (it.fields || []).forEach((f, i) => { f.box = toRel(fAbs[i], newWinBox); });
    (it.tells || []).forEach((t, i) => { t.box = toRel(tAbs[i], newWinBox); });
}

function openItemImage(winId, itemId) {
    const node = nodeEls.get(`item:${winId}:${itemId}`);
    const host = node && node.querySelector(".item-img");
    if (!host) return;
    const it = model.item(winId, itemId);
    if (!it || !it.cutout_box) return;
    // draw-mode buttons + the merged fields/tells readout table live in the node body now
    // (itemLists); this host is just the cutout canvas.
    host.replaceChildren(h("div", { class: "canvas-wrap" }, h("canvas")));
    const canvas = host.querySelector("canvas");
    const cb = it.cutout_box;
    // Give the cutout box its true aspect up front (it's a crop of the window image) so it
    // doesn't snap from the blank 300x150 canvas default to the image ratio once the cutout
    // loads / the first read returns. img.onload below still sets the exact value.
    const winImg = imageCanvases.get(winId)?.overlay?.img;
    if (winImg?.naturalWidth && cb.w && cb.h)
        canvas.parentElement.style.aspectRatio = `${cb.w * winImg.naturalWidth} / ${cb.h * winImg.naturalHeight}`;
    const cut2win = (b) => ({ x: cb.x + b.x * cb.w, y: cb.y + b.y * cb.h, w: b.w * cb.w, h: b.h * cb.h });
    const win2cut = (b) => ({ x: (b.x - cb.x) / cb.w, y: (b.y - cb.y) / cb.h, w: b.w / cb.w, h: b.h / cb.h });
    const ibox = () => model.item(winId, itemId).box;
    const win2rel = (b) => { const ib = ibox(); return { x: (b.x - ib.x) / ib.w, y: (b.y - ib.y) / ib.h, w: b.w / ib.w, h: b.h / ib.h }; };
    const rel2win = (b) => { const ib = ibox(); return { x: ib.x + b.x * ib.w, y: ib.y + b.y * ib.h, w: b.w * ib.w, h: b.h * ib.h }; };
    const kindOf = () => toolKind(node);   // armed tool on the item node (wired in main.js), or null

    // THE single writer for an item overlay box, by role — a PURE model write (mirrors
    // persistWinBox), no aftermath. Both the mouse (overlay onChange, below) and the keyboard
    // (WASD/shift+WASD via the registry `persist`, main.js) route here, so every role writes the
    // same way whichever drives it (rule 7); each caller then runs its OWN aftermath exactly once
    // — folding the aftermath in here too (as it used to) meant the shared WASD handler's generic
    // refresh+autosave ran a SECOND time on top of it, double-firing the cutout re-read + autosave
    // on every WASD nudge.
    const persistItem = (b) => {
        const w = cut2win(b);
        if (b.role === "bbox") setItemCellKeepingChildren(winId, itemId, w);
        else if (b.role === "field") model.setItemFieldBox(winId, itemId, b.id, win2rel(w));
        else model.setItemTellBox(winId, itemId, b.id, win2rel(w));
        // a moved cell (remaps every tell) or a moved template tell shifts the crop region —
        // redraw the live reference preview on each affected template tell node
        if (b.role === "bbox" || model.itemTell(winId, itemId, b.id)?.kind === "template")
            refreshItemTemplateRefs(winId, itemId);
        if (b.role === "bbox") syncCellSize(winId, itemId);   // reflect new cell size in the inputs
        clearGrid(winId);   // layout changed → detected grid is stale (mirrors persistWinBox)
    };
    // The repaint + re-read a box write needs (mirrors what persistWinBox's callers add): redraw
    // the cutout + window boxes, re-read the cutout (coalesced with any other pending read for
    // this window/item — see scheduleWindowRead). Deliberately excludes autosave/rectEditCanvasSync
    // — those are each CALLER's own job (mouse onChange below; the shared WASD handler in main.js),
    // so a WASD nudge doesn't fire them via BOTH this and the outer handler (the old bug: itemChanged
    // was embedded in persistItem itself, so the WASD path's generic epilogue ran everything twice).
    const afterItemBoxWrite = () => {
        refreshItemBoxes(winId, itemId); refreshImageBoxes(winId);
        scheduleItemRead(winId, itemId);
    };

    const overlay = new Overlay(canvas, {
        canCreate: () => kindOf() !== null,          // no crosshair / no draw until a tool is armed
        onCreate: async (geom) => {                  // geom in cutout fractions
            const w = cut2win(geom);
            const k = kindOf();
            if (!k) return;                            // no draw tool picked → drawing is a no-op
            rectTxn.commitIfDirty();   // a new box persists+autosaves immediately; land any pending edit first
            if (k === "field") {
                // drawing a field SPAWNS its own node, grouped with the item. Position + render FIRST
                // (addToGroup needs the node to have a rect), then attach to the item's group.
                const fid = model.addItemField(winId, itemId, win2rel(w));
                await placeNewNode(`fld:${winId}:${itemId}:${fid}`, "itemfield", `item:${winId}:${itemId}`);
                render();
                addFieldToItemGroup(winId, itemId, fid);
                rebuildNode(`item:${winId}:${itemId}`);   // refresh the item node's fields summary (render keeps existing bodies)
                groups.renderGroups();
                refreshItemBoxes(winId, itemId); refreshImageBoxes(winId);
                clearGrid(winId); scheduleItemRead(winId, itemId); autosave(winId);
                panZoomTo(`fld:${winId}:${itemId}:${fid}`);
                return;
            }
            if (k === "bbox") {
                setItemCellKeepingChildren(winId, itemId, w);
                itemChanged(winId, itemId, { rebuild: true });
                return;
            }
            // a tell SPAWNS its own node too, grouped with the item (mirror the field path above).
            // The one "tell" tool draws a neutral 'filled' tell; the user picks the kind on the node.
            const tid = model.addItemTell(winId, itemId, k === "tell" ? "filled" : k, win2rel(w));
            await placeNewNode(`tell:${winId}:${itemId}:${tid}`, "itemtell", `item:${winId}:${itemId}`);
            render();
            addTellToItemGroup(winId, itemId, tid);
            rebuildNode(`item:${winId}:${itemId}`);   // refresh the item node's tells summary (render keeps existing bodies)
            groups.renderGroups();
            refreshItemBoxes(winId, itemId); refreshImageBoxes(winId);
            clearGrid(winId); scheduleItemRead(winId, itemId); autosave(winId);
            panZoomTo(`tell:${winId}:${itemId}:${tid}`);
        },
        // mouse and WASD open the SAME rect transaction (rule 7), which commits through persistItem +
        // afterItemBoxWrite + autosave exactly once for the whole batch — no cutout re-read per drag.
        onChange: (box) => editBox(`item:${winId}:${itemId}`, box),
        onSelect: (id) => overlaySelected(`item:${winId}:${itemId}`, id),
    });
    itemCanvases.set(`${winId}:${itemId}`, { host, canvas, overlay, cut2win, win2cut, win2rel, rel2win });
    // central registry: cross-deselect + WASD for the item's boxes (same persistItem writer,
    // same afterItemBoxWrite repaint — the shared WASD handler in main.js follows this with its
    // own autosave/rectEditCanvasSync, exactly once, same as every other overlay kind).
    registerOverlay(`item:${winId}:${itemId}`, { overlay, kind: "item", winId, itemId,
        persist: persistItem, refresh: afterItemBoxWrite });
    overlay.setWorldZoom(view.zoom);

    const img = new Image();
    img.onload = () => {
        canvas.parentElement.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
        overlay.setImage(img); refreshItemBoxes(winId, itemId); drawEdges();
        scheduleItemRead(winId, itemId);   // show what current settings extract, right away
    };
    img.src = api.cutoutUrl(model.profile.name, it.cutout);
    drawEdges();
}

// Draw the cell + fields + tells on the item's cutout canvas (in cutout fractions).
function refreshItemBoxes(winId, itemId) {
    const ent = itemCanvases.get(`${winId}:${itemId}`);
    const it = model.item(winId, itemId);
    if (!ent || !it) return;
    // last read of this cutout, if any: pass/fail + confidence per tell, and the field values
    const rd = itemReads.get(`${winId}:${itemId}`);
    const tellRd = {};
    for (const t of rd?.tells || []) tellRd[t.id] = t;
    // after a read, a tell box shows ✓/✗ plus its confidence score (rounded for the canvas)
    const mark = (id) => {
        const t = tellRd[id];
        if (!t) return "";
        const sc = typeof t.score === "number" ? ` ${t.score.toFixed(2)}` : (t.score != null ? ` ${t.score}` : "");
        return `${t.pass ? " ✓" : " ✗"}${sc}`;
    };
    const boxes = [{ id: "__bbox", role: "bbox", ...ent.win2cut(it.box) }];   // the tiling cell
    // label fields/tells with their role so the cutout shows what each box does: a field
    // flagged tell shows "⊙tell"; a locating tell shows "loc". Their anchor (align x/y) is
    // drawn as an arrow on the box (see Overlay._alignArrow), not written in the label. After
    // a read, a tell/field-tell box also shows ✓/✗ for whether it passed.
    for (const f of it.fields || []) {
        if (f.enabled === false) continue;   // disabled fields aren't read -> don't draw them
        const label = `${f.id}${f.tell ? ` ⊙tell${mark(f.id)}` : ""}`;
        const box = { id: f.id, label, role: "field", field: f.field, ...ent.win2cut(ent.rel2win(f.box)) };
        if (f.tell) {   // a field-tell anchors the located cell -> draw its snap point (align x/y)
            box.align = f.align || it.align || "center";
            box.alignX = f.align_x || it.align_x || "center";
        }
        boxes.push(box);
    }
    // static grid tiles rows from the cell — OCR row-location is unused, so don't advertise "loc"
    const staticOn = model.window(winId)?.static_grid !== false;
    for (const t of it.tells || []) {
        const loc = t.locate && !staticOn;
        const label = `${t.id}${loc ? " loc" : ""}${mark(t.id)}`;
        const box = { id: t.id, label, role: t.kind === "text" ? "detect" : "scrollbar", ...ent.win2cut(ent.rel2win(t.box)) };
        if (t.kind === "border") {   // draw the sampled perimeter band (semi-transparent) in the taught colour
            box.border = { width: t.width ?? 0.2, color: t.color || "#ffcc00" };
        }
        if (t.kind === "template" && (t.margin ?? 0) > 0) box.searchMargin = t.margin;   // dashed slide region
        if (loc) {   // a locating tell anchors the cell -> draw its snap point (align x/y) as an arrow
            box.align = t.align || it.align || "center";
            box.alignX = t.align_x || it.align_x || "center";
        }
        boxes.push(box);
    }
    // an uncommitted rect edit outranks the model: this list was just rebuilt from the CLEAN model,
    // so a read landing mid-edit would otherwise snap every dirty box back (edit_txn.js)
    ent.overlay.setBoxes(rectTxn.applyPending(`item:${winId}:${itemId}`, boxes));
    // the extracted field values, drawn over their boxes tinted by confidence (same as the
    // window preview). The read returns boxes already in cutout fractions.
    const reads = rd ? Object.values(rd.fields).filter((f) => f.box)
        .map((f) => ({ ...f.box, text: f.value, raw: f.raw, confidence: f.confidence, substituted: f.substituted, verified: f.verified || null })) : [];
    ent.overlay.setPreview(reads);
    refreshItemReadout(winId, itemId);   // keep the merged fields/tells table in sync with this read
}

// Re-read the cutout whenever its settings change — coalesced onto the SAME shared clock as
// scheduleWindowRead (below): an edit touching both an item AND its window (e.g. WASD-nudging a
// field's rect, which also autosaves the window) settles at ONE moment instead of two staggered
// ones (the old separate 500ms item timer vs 700ms window timer). `runItemRead`'s own singleFlight
// then owns "never run two reads for the same item at once, queue a single trailing re-run
// instead" (same pattern as refreshPreview/refreshDetect).
function scheduleItemRead(winId, itemId) {
    _readItems.set(`${winId}:${itemId}`, { winId, itemId });
    armReadTimer();
}

// Read the item's frozen cutout with the current settings and show what it extracts:
// field values tinted on the canvas + the merged fields/tells table in the item node body.
function runItemRead(winId, itemId) {
    const key = `${winId}:${itemId}`;
    if (!itemCanvases.has(key)) return Promise.resolve();
    return singleFlight(`item:${key}`, (ctx) => doItemRead(winId, itemId, key, ctx));
}

async function doItemRead(winId, itemId, key, { superseded } = {}) {
    if (!itemCanvases.has(key)) return;   // closed while a debounced/coalesced rerun was queued
    const done = timed(`item read ${key}`);
    setNodeBusy(`item:${winId}:${itemId}`, true);
    try {
        const res = await api.itemRead(previewProfileFor(winId), model.profile.name, winId, itemId, boot.phase);
        done(`· ${res.device || "?"} · ${res.valid ? "valid" : "rejected"}`, "ok", res.ms);
        if (superseded?.()) return;   // a newer read is already queued — let it paint instead
        itemReads.set(key, res);
        refreshItemBoxes(winId, itemId);   // draws the cutout boxes AND refreshes the merged table
    } catch (e) {
        done(String(e.message || e), "err");
        if (superseded?.()) return;
        const st = nodeEls.get(`item:${winId}:${itemId}`)?.querySelector(".mr-status");
        if (st) { st.textContent = String(e.message || e); st.className = "mr-status tc-bad"; }
    } finally {
        setNodeBusy(`item:${winId}:${itemId}`, false);
    }
}

// Fill the item node's merged fields/tells table from the last cutout read (`itemReads`) — the
// validity status, each field's value+conf, each tell's pass/score, and the record key. Updates
// the existing `.mr-*` spans IN PLACE (rule 1: no rebuild), so it's cheap to call on every read
// or config edit; the scaffold is built once by node_parts.itemLists. Blank ("—") when no read.
function refreshItemReadout(winId, itemId) {
    const node = nodeEls.get(`item:${winId}:${itemId}`);
    if (!node) return;
    const rd = itemReads.get(`${winId}:${itemId}`);
    const status = node.querySelector(".mr-status");
    if (status) {
        status.textContent = !rd ? "—" : rd.valid ? "✓ valid" : "✗ rejected";
        status.className = `mr-status ${!rd ? "muted" : rd.valid ? "tc-ok" : "tc-bad"}`;
    }
    const fvals = rd?.fields || {};
    node.querySelectorAll(".mr-val[data-fid]").forEach((el) => {
        const v = fvals[el.dataset.fid];
        if (!v) { el.textContent = "—"; el.className = "mr-val muted"; return; }
        const cls = confClass(v.confidence, v.substituted);
        el.textContent = String(v.value ?? "∅");
        el.className = `mr-val ${cls}`;
    });
    const tmark = {};
    for (const t of rd?.tells || []) tmark[t.id] = t;
    node.querySelectorAll(".mr-mark[data-tid]").forEach((el) => {
        const t = tmark[el.dataset.tid];
        if (!t) { el.textContent = ""; el.className = "mr-mark muted"; return; }
        el.textContent = `${t.pass ? "✓" : "✗"} ${String(t.score)}${t.threshold == null ? "" : `/${String(t.threshold)}`}`;
        el.className = `mr-mark ${t.pass ? "tc-ok" : "tc-bad"}`;
        el.title = t.detail || "";
    });
    const keyEl = node.querySelector(".mr-key-v");
    if (keyEl) keyEl.replaceChildren(keyPrevNode(winId, itemId) || h("span", { class: "muted" }, "—"));
}

function selectRegionNode(winId, boxId) {
    const ids = [`reg:${winId}:${boxId}`, `det:${winId}:${boxId}`, `st:${winId}:${boxId}`, `sb:${winId}:${boxId}`, `ro:${winId}:${boxId}`];
    setSelectedNodeId(ids.find((id) => nodeEls.has(id)) || null);
    for (const [id, el] of nodeEls) el.classList.toggle("selected", id === selectedNodeId);
    drawEdges();   // restyle the selected node's line
}

// ---- live preview node (what the current setup would read) ------------------

function prevHost(winId) {
    const el = nodeEls.get(`prev:${winId}`);
    return el && el.querySelector(".prev-host");
}

function previewProfileFor(winId) {
    const w = model.window(winId);
    return { ...model.profile, windows: w ? [w] : [] };
}

// One rule-trace read per WINDOW, shared by every field node on it. At boot the whole field
// fleet asks for its trace at once; without this each call re-OCR'd the entire window (N reads),
// which stalled the renderer under load. Singleflighted per window: a burst of rule edits (or the
// initial node-build fleet) collapses into ONE `/api/rule_trace` request, and a call that lands
// while one is in flight is remembered and ALWAYS re-run once it settles, with the latest profile.
// (The old design returned the in-flight promise itself, snapshotted at first-call time, with no
// re-run — a rule edit landing mid-flight silently got served the pre-edit reads, and only a LATER
// edit — landing when nothing was in flight — ever refreshed the label. That's the "wrong values
// until you nudge another input" bug this replaces.) Debouncing a rule edit's trace refresh is now
// the shared clock's job (scheduleWindowRead, below) — this fires immediately when called.
const _lastTrace = new Map();    // winId -> last successful batch {fields}

function fetchWindowTrace(winId) {
    return singleFlight(`trace:${winId}`, (ctx) => doWindowTrace(winId, ctx));
}

async function doWindowTrace(winId, { superseded } = {}) {
    const cap = await curCapOf(winId);
    const batch = await api.ruleTrace(previewProfileFor(winId), model.profile.name, cap);
    if (superseded?.()) return;   // a newer trace is already queued — let it paint instead
    _lastTrace.set(winId, batch);
    repaintTracedNodes(winId);   // a fresh batch landed -> repaint EVERY traced node on this window
}

// Stash what a window's readout boxes read off a preview result into readoutPreview (the NON-LIVE
// source for each readout node's value). Scope to THIS window's ids: set the ones that read, drop
// the ones that didn't (occluded), leave other windows' entries alone; then repaint the .ro-live
// rows via the shared event (livewin listens).
function storeReadoutPreview(winId, res) {
    const rw = model.window(winId);
    if (!rw || !(rw.readouts || []).length) return;
    const rv = res.readouts || {}, rc = res.readout_confs || {};
    const rva = res.readouts_all || {}, rca = res.readout_confs_all || {};
    for (const v of rw.readouts) {
        if (Object.prototype.hasOwnProperty.call(rv, v.id)) {
            readoutPreview.vals[v.id] = rv[v.id];
            readoutPreview.confs[v.id] = rc[v.id];
        } else {
            delete readoutPreview.vals[v.id];
            delete readoutPreview.confs[v.id];
        }
        // full map: present (incl. "") for every ENABLED readout the server evaluated this pass;
        // absent only when the readout itself is disabled (server never returns it).
        if (Object.prototype.hasOwnProperty.call(rva, v.id)) {
            readoutPreview.all[v.id] = rva[v.id];
            readoutPreview.allConfs[v.id] = rca[v.id];
        } else {
            delete readoutPreview.all[v.id];
            delete readoutPreview.allConfs[v.id];
        }
    }
    window.dispatchEvent(new CustomEvent("readout-preview"));
}

// One readouts read per WINDOW for its readout nodes, used when live mode is OFF (no collector
// feeding values). Coalesced (singleFlight) the same way as the rule trace above, so a config edit
// landing mid-flight always gets a trailing re-run instead of being served a stale in-flight
// result. Reads the current bound image and stores each readout's value (+conf) into readoutPreview.
// Callers driven by an EDIT (not the initial fetch on node-open) should go through
// scheduleWindowRead(winId, {readouts:true}) instead of calling this directly — it shares the
// window's read settle clock, so a readout edit doesn't fire its own separate un-debounced fetch
// alongside the coalesced preview/detect/trace one.
export function refreshReadoutValues(winId) {
    const w = model.window(winId);
    if (!w || !(w.readouts || []).length) return Promise.resolve();
    return singleFlight(`ro:${winId}`, (ctx) => doRefreshReadoutValues(winId, ctx));
}

async function doRefreshReadoutValues(winId, { superseded } = {}) {
    const roIds = (model.window(winId)?.readouts || []).map((v) => `ro:${winId}:${v.id}`);
    roIds.forEach((id) => setNodeBusy(id, true));
    try {
        const cap = await curCapOf(winId);
        const res = await api.preview(previewProfileFor(winId), model.profile.name, cap, boot.phase);
        if (superseded?.()) return;   // a newer read is already queued — let it paint instead
        storeReadoutPreview(winId, res);
    } finally {
        roIds.forEach((id) => setNodeBusy(id, false));
    }
}

// Every field node that has painted a trace, so an image swap (or a fresh batch landing) can
// repaint them all (the trace is on-demand, not polled — nothing re-reads it when the bound image
// changes underneath). Keyed by nodeId; carries the winId + fieldId needed to repaint. Auto-pruned
// when its node is gone.
const _tracedNodes = new Map();   // nodeId -> { winId, fieldId }

// Paint one field node's `.frule-trace` slots from the last stashed batch for its window — pure,
// no fetch. `host` is the live node body.
function paintRuleTrace(winId, fieldId, host) {
    const slots = [...host.querySelectorAll(".frule-trace")];
    if (!slots.length) return;
    const steps = _lastTrace.get(winId)?.fields?.[fieldId]?.trace || [];
    for (const slot of slots) {
        const s = steps[+slot.dataset.ri];
        slot.classList.remove("frule-drop");
        if (!s) { slot.textContent = ""; continue; }
        const q = (v) => (v == null ? "∅" : `"${v}"`);
        if (!s.fired) { slot.textContent = `${q(s.in)}  (skipped)`; continue; }
        if (s.out == null) { slot.textContent = `${q(s.in)}  →  dropped`; slot.classList.add("frule-drop"); continue; }
        slot.textContent = `${q(s.in)}  →  ${q(s.out)}`;
    }
}

// Repaint every already-traced field node on a window from the last stashed batch (no fetch) —
// called once a fresh batch lands (doWindowTrace).
function repaintTracedNodes(winId) {
    for (const [nodeId, t] of _tracedNodes) {
        if (t.winId !== winId) continue;
        const host = nodeEls.get(nodeId);
        if (!host) { _tracedNodes.delete(nodeId); continue; }
        paintRuleTrace(winId, t.fieldId, host);
    }
}

// Re-run the rule trace for every already-traced field node on a window — call after its bound
// image changes so each `.frule-trace` reflects the NEW image, not the old read. The stashed batch
// is for the PREVIOUS image, so this drops it and forces an immediate fresh fetch rather than
// repainting stale data.
function retraceWindow(winId) {
    _lastTrace.delete(winId);
    fetchWindowTrace(winId);
}

// Fill a field node's `.frule-trace` slots: paint immediately from the last cached batch (no blank
// flash), then queue a fresh read on the shared settle clock (scheduleWindowRead) so a rule/input
// edit is reflected without needing to "nudge" another input afterwards — coalesced with any other
// pending read for this window (preview/detect/item), so a rule edit settles in the SAME beat as
// the rest of that edit's fallout instead of its own separately-timed debounce.
function refreshRuleTrace(winId, fieldId, nodeId, el) {
    _tracedNodes.set(nodeId, { winId, fieldId });   // remember it so an image swap / fresh batch can repaint it
    // prefer the live node body the caller hands us: on the FIRST build the node isn't in
    // `nodeEls` yet (wiring runs before registration), so a lookup would miss and the trace
    // would only appear after an edit. `el` is always the current body.
    const host = el || nodeEls.get(nodeId);
    if (!host || !host.querySelectorAll(".frule-trace").length) return;
    paintRuleTrace(winId, fieldId, host);
    // While this node is being edited, ask for the TRACE ONLY: the preview+detect pass would
    // setNodeBusy this very node and blur the input being typed in (edit_txn.js). Gate on ARMED,
    // not dirty — a value momentarily typed back to its original is still mid-edit, and the caret
    // must survive it.
    scheduleWindowRead(winId, { trace: true, preview: !nodeTxn.armed(nodeId) });
}

// Coalesce reads: at most ONE OCR request per window is ever in flight (shared singleFlight
// primitive — see singleflight.js). Clicking "read" again while one runs doesn't stack another
// (which would serialize on the OCR lock and starve the server threadpool) — it re-runs once with
// the latest inputs once the current one returns.
// disable + spin the read buttons for this window (preview node + image toolbar) while
// an OCR read runs, so it's obvious it's working and the button can't be re-fired.
function setReadBusy(winId, on) {
    const pnode = nodeEls.get(`prev:${winId}`), wnode = nodeEls.get(`win:${winId}`);
    const btns = [...(pnode?.querySelectorAll(".prevrun") || []), ...(wnode?.querySelectorAll(".imgprev") || [])];
    for (const b of btns) { b.disabled = on; b.classList.toggle("reading", on); }
}
function refreshPreview(winId, live = false) {
    const host = prevHost(winId);
    if (!host) return Promise.resolve();
    host.dataset.ran = "1";   // marks it for live re-reads
    return singleFlight(`prev:${winId}`, (ctx) => doPreview(winId, live, ctx));
}

async function doPreview(winId, live, { superseded } = {}) {
    const host = prevHost(winId);
    if (!host) return;
    // spin the preview node's OWN header too (not just its read-button, setReadBusy below) — and
    // every readout node, since they show whatever THIS read feeds them (storeReadoutPreview).
    const roIds = (model.window(winId)?.readouts || []).map((v) => `ro:${winId}:${v.id}`);
    setNodeBusy(`prev:${winId}`, true);
    roIds.forEach((id) => setNodeBusy(id, true));
    setReadBusy(winId, true);
    if (!live) host.replaceChildren(h("p", { class: "muted", style: "padding:8px" }, "reading…"));
    const done = timed(`OCR preview ${winId}`);
    try {
        const cap = live ? null : await curCapOf(winId);   // the page on screen (live grabs fresh)
        // On boot, serve the unchanged stashed image from the server OCR cache (no engine touch);
        // a live read or a post-boot edit always re-OCRs fresh.
        const res = await api.preview(previewProfileFor(winId), model.profile.name, cap, boot.phase && !live);
        done(`· ${res.device || "?"} · ${(res.cells || []).length} cells`, "ok", res.ms);
        // a newer request is already queued behind us — its result supersedes ours; skip the paint
        // and let the trailing rerun (singleflight.js) write the fresh one instead of this stale one.
        if (superseded?.()) return;
        host.replaceChildren(previewTable(res.cells));
        setGridFromPreview(winId, res);   // same OCR pass drives the dashed grid
        storeReadoutPreview(winId, res);   // feed the readout nodes' value (+conf) off this same read
    } catch (e) {
        done(String(e.message || e), "err");
        if (superseded?.()) return;
        host.replaceChildren(h("p", { class: "muted", style: "padding:8px" }, String(e.message || e)));
    } finally {
        setReadBusy(winId, false);
        setNodeBusy(`prev:${winId}`, false);
        roIds.forEach((id) => setNodeBusy(id, false));
    }
}

// Commit what the preview node currently reads into the window's dataset store — re-reads
// server-side (never trusts the rendered table) against the SAME image the preview shows
// (the window's bound capture), as one revertable batch. Refreshes the dataset node after.
async function commitPreviewNode(winId, btn) {
    if (btn) { btn.disabled = true; btn.classList.add("reading"); }
    const done = timed(`commit ${winId}`);
    try {
        const cap = await curCapOf(winId);   // commit the page currently on screen
        const r = await api.previewCommit(previewProfileFor(winId), model.profile.name, cap);
        const lc = r.low_conf ? `, ${r.low_conf} low-conf` : "";
        done(`· ${r.written} → ${r.dataset} (${r.skipped} skipped${lc} of ${r.cells})`);
        setStatus(`committed ${r.written} to ${r.dataset} · ${r.skipped} skipped${lc} of ${r.cells}`);
        await refreshLive();   // record counts / new dataset edges — may render a brand-new dataset node
        if (nodeEls.has(`ds:${r.dataset}`)) { refreshDataNode(r.dataset); loadBatchesNode(r.dataset); }
    } catch (e) {
        done(String(e.message || e), "err");
        setStatus(String(e.message || e));
    } finally {
        if (btn) { btn.disabled = false; btn.classList.remove("reading"); }
    }
}

// Preview data read from EVERY bound image at once: OCR each page in turn, concatenate the
// cells, and render the combined table in the preview node. The default preview reads only
// the page on screen; this is the explicit "all pages" view — one-shot, page state untouched.
async function previewAll(winId, btn) {
    const list = await capListOf(winId);
    if (!list.length) { setStatus("no images bound to this window"); return; }
    showSatellite(`prev:${winId}`);   // the preview node is opt-in — reveal it so the read has somewhere to render
    const host = prevHost(winId);
    if (btn) { btn.disabled = true; btn.classList.add("reading"); }
    if (host) host.replaceChildren(h("p", { class: "muted", style: "padding:8px" }, `reading ${list.length} image${list.length === 1 ? "" : "s"}…`));
    const done = timed(`OCR preview-all ${winId}`);
    try {
        const game = model.profile.name, cells = [];
        let img = 0, srvMs = 0;
        for (const cap of list) {
            const res = await api.preview(previewProfileFor(winId), game, cap);
            srvMs += res.ms || 0;   // sum each page's real compute, not wall-since-issue
            for (const c of res.cells || []) { c._img = img; cells.push(c); }   // tag rows by source image so the table can rule between images
            img++;
        }
        if (host) host.replaceChildren(previewTable(cells));
        done(`· ${list.length} images · ${cells.length} cells`, "ok", srvMs);
    } catch (e) {
        done(String(e.message || e), "err");
        if (host) host.replaceChildren(h("p", { class: "muted", style: "padding:8px" }, String(e.message || e)));
    } finally {
        if (btn) { btn.disabled = false; btn.classList.remove("reading"); }
    }
}

function tellChip(t) {
    // one tell's outcome: "id score/threshold" tinted by pass/fail
    return h("span", { class: `tell-chip ${t.pass ? "tc-ok" : "tc-bad"}`, title: t.detail || null },
        `${t.id} ${t.score}`,
        t.threshold == null ? null : h("span", { class: "muted" }, `/${t.threshold}`));
}

// "empty" -> "if empty", "if_number" -> "if number" — the badge shown instead of a
// confidence % when a configured fallback produced the value (config, not a read)
const subLabel = (r) => `if ${String(r).replace(/^if_/, "").replace(/_/g, " ")}`;

function previewCell(v) {
    if (!v) return h("td", "—");
    if (v.substituted) {
        return h("td", { class: "conf-sub", title: `${v.raw || "(empty)"} → ${subLabel(v.substituted)}` }, String(v.value ?? "∅"));
    }
    const cls = confClass(v.confidence);
    return h("td", { class: cls, title: v.raw || "" }, String(v.value ?? "∅"));
}

// Render rows, inserting a separator <tr> whenever the source image (`_img`, set by
// previewAll) changes — never before the first group. Rows without `_img` (the normal
// single-image preview) all share one group, so no separators appear.
function sepRows(cells, cols, rowFn) {
    let prev;
    // each entry is [separator-or-null, row]; h() flattens the nested arrays and skips the nulls.
    return cells.map((c) => {
        const sep = c._img !== undefined && prev !== undefined && c._img !== prev
            ? h("tr", { class: "prev-sep" }, h("td", { colspan: cols })) : null;
        prev = c._img;
        return [sep, rowFn(c)];
    });
}

function previewTable(cells) {
    const all = cells || [];
    const hasItems = all.some((c) => Array.isArray(c.tells));
    if (!hasItems) {
        const kept = all.filter(cellKept);
        if (!kept.length) return h("p", { class: "muted", style: "padding:8px" }, "0 rows");
        const fieldIds = [...new Set(kept.flatMap((c) => Object.keys(c.fields)))];
        const head = fieldIds.map((f) => h("th", f));
        const rows = sepRows(kept.slice(0, 200), fieldIds.length,
            (c) => h("tr", fieldIds.map((f) => previewCell(c.fields[f]))));
        return frag(
            h("div", { class: "prev-count muted" }, `${kept.length} row${kept.length === 1 ? "" : "s"}`),
            h("table", { class: "grid-table" },
                h("thead", h("tr", head)),
                h("tbody", rows)));
    }

    // item-template diagnostics: show EVERY cell that read something (so rejected arcanes
    // are visible), with its template, status, reject reason, and per-tell scores.
    const read = all.filter((c) => Object.values(c.fields).some((f) => f && f.value !== null && f.value !== "" && f.value !== undefined));
    if (!read.length) return h("p", { class: "muted", style: "padding:8px" }, "0 cells read any data");
    // group by source image first (so preview-all keeps each image's rows together + ruled),
    // then valid-first within each image; single-image previews have one group → unchanged.
    read.sort((a, b) => ((a._img || 0) - (b._img || 0)) || (b.valid === true) - (a.valid === true));
    const fieldIds = [...new Set(read.flatMap((c) => Object.keys(c.fields)))];
    const head = [h("th"), h("th", "item"), ...fieldIds.map((f) => h("th", f)), h("th", "tells"), h("th", "reason")];
    const rows = sepRows(read.slice(0, 300), fieldIds.length + 4, (c) => {
        const status = c.valid ? h("span", { class: "tc-ok" }, "✓")
            : c.tells_pass ? h("span", { class: "tc-warn" }, "◌") : h("span", { class: "tc-bad" }, "✗");
        // join tell chips with a literal space text node between each (was " " in the old string)
        const tells = (c.tells || []).flatMap((t, i) => i ? [" ", tellChip(t)] : [tellChip(t)]);
        return h("tr", { class: c.valid ? null : "prev-rej" },
            h("td", status),
            h("td", c.item || ""),
            fieldIds.map((f) => previewCell(c.fields[f])),
            h("td", tells),
            h("td", { class: "muted" }, c.reason || ""));
    });
    const nValid = read.filter((c) => c.valid).length;
    return frag(
        h("div", { class: "prev-count muted" }, `${nValid} kept · ${read.length} read · ✓ kept, ◌ tells pass but lost overlap, ✗ tell failed`),
        h("table", { class: "grid-table" },
            h("thead", h("tr", head)),
            h("tbody", rows)));
}

async function prefillDetectText(winId, detectId) {
    try {
        const cap = await curCapOf(winId);
        const res = await api.detect(previewProfileFor(winId), model.profile.name, cap);
        const info = res.detect?.[detectId];
        const a = model.detect(winId, detectId);
        if (a && !a.text && info && info.read && info.read !== "(template)" && info.read !== "(color)") {
            a.text = info.read;
            // render() reuses the already-built detect node element (it only reconciles the node
            // SET), so it never repaints the input value — rebuild THIS node's body to show the read.
            rebuildNode(`det:${winId}:${detectId}`); autosave(winId);   // re-detect only this window
        }
    } catch { /* ignore */ }
}

// Coalesce detect the same way as preview (shared singleFlight primitive): at most one in flight
// per window, with a single trailing re-run using the latest inputs. Without this, live mode would
// enqueue a detect every round and they'd stack on the OCR queue until each takes tens of seconds.
function refreshDetect(winId, live = false) {
    return singleFlight(`det:${winId}`, (ctx) => doDetect(winId, live, ctx));
}

async function doDetect(winId, live, { superseded } = {}) {
    // spinner on every node whose value this detect refreshes
    const ids = [nodeIdOf(winId), ...model.detects(winId).map((a) => `det:${winId}:${a.id}`)];
    if (model.scrollbar(winId)) ids.push(`sb:${winId}:scrollbar`);
    const done = timed(`detect ${winId}`);
    await withBusy(ids, async () => {
        try {
            const cap = live ? null : await curCapOf(winId);   // the page on screen (live grabs fresh)
            const res = await api.detect(previewProfileFor(winId), model.profile.name, cap, boot.phase && !live);
            done(`· ${res.device || "?"}`, "ok", res.ms);
            // a newer request is already queued behind us — its result supersedes ours; skip the
            // paint and let the trailing rerun (singleflight.js) apply the fresh one instead.
            if (superseded?.()) return;
            const dstatus = {};   // mirror onto the window canvas: colour/tint each detect box by its verdict
            for (const [aid, info] of Object.entries(res.detect || {})) { setDetectStatus(`det:${winId}:${aid}`, info); dstatus[aid] = info; }
            for (const [sid, info] of Object.entries(res.states || {})) setDetectStatus(`st:${winId}:${sid}`, info);
            setWindowDetectStatus(winId, res);   // detects section: per-row + overall verdict
            const dent = imageCanvases.get(winId);
            if (dent) dent.overlay.setDetectStatus(dstatus);
            if (live) {   // is this window currently recognised on screen? (drives the live panel dot)
                const svals = Object.values(res.states || {});
                // mode/negate-aware verdict (matching states win over the bare window pass)
                const recognized = svals.length ? svals.some((s) => s.matched) : (res.window?.pass ?? false);
                liveRecog.set(winId, recognized);
                if (recognized) liveDetCount.set(winId, (liveDetCount.get(winId) || 0) + 1);
                renderLiveWindow();
            }
            const sbEl = nodeEls.get(`sb:${winId}:scrollbar`);
            const sbSpan = sbEl && sbEl.querySelector(".detect-status");
            if (sbSpan) {
                const sb = res.scrollbar;
                sbSpan.textContent = sb == null ? "position: —"
                    : `position: ${Math.round(sb.pos * 100)}% · ${sb.px}px · ${Math.round(sb.conf * 100)}%`;
            }
        } catch (e) { done(String(e.message || e), "err"); }
    });
}

// How many detect/preview reads (incl. a queued trailing rerun) are still outstanding across
// every window — the boot veil polls this to know when the boot OCR fan-out has fully drained,
// not just momentarily empty between two reads (bootSettle, main.js).
export function ocrBusyCount() { return pendingCount("det:") + pendingCount("prev:"); }
// Wrap the [s,e) slice of `text` in a hit marker so the matched characters stand out;
// everything outside stays plain. `span` is null when nothing aligned (no highlight).
function hlSpan(text, span) {
    const t = String(text ?? "");
    if (!span || span[0] == null || span[1] == null) return t;
    const s = Math.max(0, span[0]), e = Math.min(t.length, span[1]);
    if (e <= s) return t;
    return frag(t.slice(0, s), h("mark", { class: "ds-hit" }, t.slice(s, e)), t.slice(e));
}

// Two consumers share `.detect-status`: the DETECT node (rich, multi-row scaffold built in
// node_parts) and state/scrollbar nodes (a plain div). Detect node => fill the rows; the
// others => the legacy single line. Either way reconciles in place (no rebuild per tick).
function setDetectStatus(nodeId, info) {
    const el = nodeEls.get(nodeId);
    const box = el && el.querySelector(".detect-status");
    if (!box) return;
    const conf = info.score != null
        ? ` (${Math.round(info.score * 100)}%${info.threshold != null ? `/${Math.round(info.threshold * 100)}%` : ""})`
        : "";
    const verdict = box.querySelector(".ds-verdict");
    if (!verdict) {   // simple consumer (state / scrollbar node): one line, as before
        box.textContent = (info.matched ? "✓ true" : "✗ false") + conf + (info.read ? ` — "${info.read}"` : "");
        box.className = "detect-status " + (info.matched ? "conf-ok" : "conf-bad");
        return;
    }
    // rich detect node — verdict row, then before/after-strip rows + a min-chars row.
    box.className = "detect-status";
    verdict.textContent = (info.matched ? "✓ true" : "✗ false") + conf;
    verdict.className = "ds-verdict " + (info.matched ? "conf-ok" : "conf-bad");
    const before = box.querySelector(".ds-before");
    const after = box.querySelector(".ds-after");
    const chars = box.querySelector(".ds-chars");
    const raw = info.got_raw, norm = info.got_norm;
    if (norm == null) {            // colour/border/template detector: no normalised text, echo the read
        before.hidden = true; chars.hidden = true;
        if (info.read) {
            // colour/border also carry `dist` — the closest-pixel BGR distance to the target,
            // shown beside "(color)" so the user can set tolerance just above it.
            const txt = info.dist != null ? `${info.read} · nearest ${info.dist} BGR` : info.read;
            after.hidden = false; after.replaceChildren("read: ", h("span", { class: "ds-txt" }, txt));
        } else after.hidden = true;
        return;
    }
    // highlight the matched characters in the AFTER (normalised) text — only on a real match
    const afterNode = hlSpan(norm, info.matched ? info.span : null) || "∅";
    if (raw !== norm) {            // stripping/case folding changed the read -> show both
        before.hidden = false; before.replaceChildren("before: ", h("span", { class: "ds-txt" }, raw || "∅"));
        after.hidden = false; after.replaceChildren("after: ", h("span", { class: "ds-txt" }, afterNode));
    } else {                       // no change -> one row, highlight on the read itself
        before.hidden = true;
        after.hidden = false; after.replaceChildren("read: ", h("span", { class: "ds-txt" }, afterNode));
    }
    if (info.min_chars > 0) {      // show how many chars were found vs the floor
        chars.hidden = false;
        const ok = info.got_len >= info.min_chars;
        chars.replaceChildren("chars: ", h("span", { class: ok ? "conf-ok" : "conf-bad" }, String(info.got_len)), ` / ${info.min_chars} min`);
    } else chars.hidden = true;
}

// Fill the window node's detects section live, reconciling in place (the rows are built once
// in windowDetects; this only updates textContent/class/title, never rebuilds).
// Each `.wd-status` is coloured by PASS (negate-aware), with the raw landmark match in its title;
// `.wd-verdict` shows whether the whole window would match under its combine mode.
function setWindowDetectStatus(winId, res) {
    const el = nodeEls.get(nodeIdOf(winId));
    if (!el) return;
    const det = res.detect || {};
    // skip the header row's "pass" label (no data-id) — only the per-detector status spans
    for (const span of el.querySelectorAll(".wd-row:not(.wd-head) .wd-status")) {
        if (span.closest(".wd-row").classList.contains("wd-disabled")) continue;   // keep "disabled"
        const info = det[span.dataset.id];
        if (!info) { span.textContent = ""; span.className = "wd-status muted"; continue; }
        const pass = info.passes != null ? info.passes : info.matched;
        span.textContent = pass ? "✓" : "✗";   // bare verdict; score/read live on the detect node
        span.className = "wd-status " + (pass ? "conf-ok" : "conf-bad");
        span.title = `landmark ${info.matched ? "found" : "absent"}, ${info.negate ? "must be absent" : "must be present"} → ${pass ? "passes" : "fails"}`;
    }
    const verdict = el.querySelector(".wd-verdict");
    if (verdict) {
        {
            const w = res.window;
            if (!w) { verdict.textContent = ""; verdict.className = "wd-verdict muted"; }
            else {
                verdict.textContent = w.pass ? "✓ would match this window" : "✗ would not match";
                verdict.className = "wd-verdict " + (w.pass ? "conf-ok" : "conf-bad");
            }
        }
    }
    setWindowCollideStatus(winId);   // cross-window outcome
}

// Detection is a cross-window contest: classify() runs EVERY window's detectors against
// the frame and keeps one winner, so a window can match its own image yet lose to a
// sibling. The self-match line (.wd-verdict) can't see that — this fills the .wd-collide
// line from the whole-profile collision check so a misclassified window is obvious at
// author time. Cached in collisionByWin, refreshed on the same trigger as detect.
const collisionByWin = new Map();   // winId -> {window, verdict, winner, collides_with, matches}

function setWindowCollideStatus(winId) {
    const el = nodeEls.get(`win:${winId}`);
    if (!el) return;
    const span = el.querySelector(".wd-collide");
    if (!span) return;
    const entry = collisionByWin.get(winId);
    // only rebuild the badge when the verdict actually changes (poll/detect repaints a lot)
    const sig = entry ? `${entry.verdict}|${entry.winner || ""}|${(entry.collides_with || []).join(",")}` : "";
    if (span.dataset.sig === sig) return;
    span.dataset.sig = sig;
    // nothing to add: no collision data yet, no bound image, or the window doesn't match
    // its OWN page (the .wd-verdict line already reports that self-miss).
    if (!entry || entry.verdict === "no_image" || entry.verdict === "self_no_match") {
        span.replaceChildren(); span.className = "wd-collide"; span.title = ""; return;
    }
    const { label, cls, tip, winner } = verdictBadge(entry);   // shared verdict vocabulary
    const others = entry.collides_with || [];
    const parts = [label()];
    if (winner) parts.push(` → classifies as ${winner}`);            // misclassified: a sibling wins
    else if (entry.verdict === "collision" && others.length) parts.push(` (${others.join(", ")})`);
    span.replaceChildren(...parts.flat());
    span.className = "wd-collide " + cls;
    span.title = tip;
}

// Whole-profile cross-check. OCR-heavy, so coalesce like refreshDetect: at most one in
// flight, a single queued re-run. Repaints every open window node's collide badge.
let collisionBusy = false;
let collisionAgain = false;
async function refreshCollisions() {
    if (!model.profile.name) return;
    if (collisionBusy) { collisionAgain = true; return; }
    collisionBusy = true;
    try {
        const data = await api.detectCollisions(model.profile.name);
        collisionByWin.clear();
        for (const w of data.windows || []) collisionByWin.set(w.window, w);
        for (const id of imageCanvases.keys()) setWindowCollideStatus(id);
    } catch { /* ignore — badge just stays stale */ }
    finally {
        collisionBusy = false;
        if (collisionAgain) { collisionAgain = false; refreshCollisions(); }
    }
}
// ---- ONE coalesced read scheduler: preview + detect (+ rule-trace, + item cutout reads) all
// settle on a SINGLE shared clock, instead of the old three/four independently-timed debounces
// (detect 700ms / preview 700ms / trace 350ms / item 500ms) that fired at staggered moments for
// ONE edit — several separate spinner flashes + OCR passes per settle, and the reason a burst of
// quick edits (or a held WASD move/resize) never really "debounced" together. Window-level ids
// accumulate across the debounce window so edits spanning windows don't drop each other; a null
// winId means "every open window" (a global edit, e.g. a preprocess/global setting change). Item
// reads (scheduleItemRead, above) are a SEPARATE pending set that rides the SAME clock without
// implying a window-wide preview/detect of their own (e.g. merely opening an item's cutout view).
const READ_DEBOUNCE_MS = 700;
let _readTimer = null;
const _readWins = new Set();      // winIds queued for preview+detect this settle
const _readTrace = new Set();     // subset of _readWins that ALSO needs a rule-trace refresh
const _readReadouts = new Set();  // subset of _readWins that ALSO needs a readout-values refetch
const _readItems = new Map();     // "winId:itemId" -> {winId,itemId} queued for a cutout re-read

let _readAll = false;

function armReadTimer() {
    clearTimeout(_readTimer);
    _readTimer = setTimeout(fireWindowRead, READ_DEBOUNCE_MS);
}

// Window-level: preview + detect, scoped to `winId` (or every open window when null). Pass
// `trace: true` to also refresh the rule-trace for that window, or `readouts: true` to also
// refetch its readout values (refreshReadoutValues — the live-mode-off, satellite-independent
// path), once this settle fires. Replaces the old separate refreshOpenPreviews/refreshOpenDetect
// debounces + fetchWindowTrace's own + wireReadout's immediate, un-coalesced refetch().
// `preview: false` queues the trace/readout refresh WITHOUT the window's preview+detect pass. That
// pass is what calls setNodeBusy -> `inert` -> blurs the input being typed in, so a node with an
// uncommitted config edit asks for its rule trace alone: you see rule output update as you type,
// and nothing locks. The full pass runs once, on commit, via the deferred autosave.
function scheduleWindowRead(winId = null, { trace = false, readouts = false, preview = true } = {}) {
    if (winId) {
        if (preview) _readWins.add(winId);
        if (trace) _readTrace.add(winId);
        if (readouts) _readReadouts.add(winId);
    } else _readAll = true;
    armReadTimer();
}

// Fire the queued reads NOW instead of waiting out the settle clock. The debounce exists to
// coalesce a burst of edits; an explicit commit (✓ / Enter / click outside) already marks the end
// of the burst, so waiting another 700ms just reads as lag. Returns a promise of the work it
// started, so a commit can hold its node's loader up for exactly as long as the work runs.
export function flushWindowRead() {
    const queued = _readAll || _readWins.size || _readTrace.size || _readReadouts.size || _readItems.size;
    if (!queued) return Promise.resolve();
    clearTimeout(_readTimer);
    return fireWindowRead();   // sets _readTimer = null and drains every pending set
}

// Returns a promise settling when everything it kicked off has finished. The settle-clock caller
// ignores it; `flushWindowRead` awaits it.
function fireWindowRead() {
    const work = [];
    _readTimer = null;
    const all = _readAll; _readAll = false;
    const traceWins = [..._readTrace]; _readTrace.clear();
    const roWins = [..._readReadouts]; _readReadouts.clear();
    const items = [..._readItems.values()]; _readItems.clear();
    // preview: every window with an open preview satellite (or a bare image canvas), scoped
    // unless this is a global settle — mirrors the old refreshOpenPreviews exactly.
    for (const w of model.profile.windows || []) {
        if (w.enabled === false) continue;   // a disabled window reads nothing — don't re-run it
        if (!all && !_readWins.has(w.id)) continue;   // scoped: only the edited window(s)
        const host = prevHost(w.id);
        // Read on ANY update — the preview should always reflect the current setup, not wait
        // for a first manual "read". Reads the window's OWN bound image (live=false), not a
        // fresh game grab, so it doesn't need the game running (a live grab 404s when it isn't).
        if (host) work.push(refreshPreview(w.id, false));   // refreshes the preview table + grid
        else if (imageCanvases.has(w.id)) refreshGridPreview(w.id);   // image open, no preview node
    }
    // detect: every window with an OPEN image canvas (doDetect needs pixels) — mirrors the old
    // refreshOpenDetect exactly.
    for (const id of imageCanvases.keys()) {
        if (!all && !_readWins.has(id)) continue;
        if (model.window(id)?.enabled !== false) work.push(refreshDetect(id));   // skip disabled windows
    }
    _readWins.clear();
    for (const id of traceWins) work.push(fetchWindowTrace(id));
    for (const id of roWins) work.push(refreshReadoutValues(id));
    for (const { winId, itemId } of items) work.push(runItemRead(winId, itemId));
    refreshCollisions();   // cross-window verdict tracks the same edits (coalesced)
    return Promise.all(work);
}


// Blank one detect/scrollbar node's `.detect-status` back to its "not run" look — the inverse
// of setDetectStatus's two consumers (rich detect node / plain scrollbar line).
function blankDetectStatus(nodeId) {
    const box = nodeEls.get(nodeId)?.querySelector(".detect-status");
    if (!box) return;
    const verdict = box.querySelector(".ds-verdict");
    if (!verdict) { box.textContent = "position: —"; box.className = "detect-status muted"; return; }
    box.className = "detect-status muted";
    verdict.textContent = "◯ —";
    verdict.className = "ds-verdict";
    for (const sel of [".ds-before", ".ds-after", ".ds-chars"]) {
        const row = box.querySelector(sel);
        if (row) row.hidden = true;
    }
}

// Un-paint EVERYTHING the last read produced for a window — its bound image is about to change,
// so every read-derived surface is stale the moment the swap starts (the read that refills them
// lands hundreds of ms later, debounced). One place, called from loadImage, so no call site can
// swap an image and leave the previous one's data on screen.
function clearWindowReads(winId) {
    clearGrid(winId);              // grid boxes, per-cell reads, cell outlines, guards, occluded, raw detections
    refreshImageBoxes(winId);      // repaint the overlay with the AUTHORED boxes only
    imageCanvases.get(winId)?.overlay.setDetectStatus({});   // drop the per-box detect tint
    _lastTrace.delete(winId);      // the stashed rule-trace batch read the OLD image
    repaintTracedNodes(winId);     // → every field node's `.frule-trace` slot blanks
    prevHost(winId)?.replaceChildren(h("p", { class: "muted", style: "padding:8px" }, "reading…"));
    setWindowDetectStatus(winId, {});   // window node's per-detector ticks + overall verdict
    for (const a of model.detects(winId)) blankDetectStatus(`det:${winId}:${a.id}`);
    if (model.scrollbar(winId)) blankDetectStatus(`sb:${winId}:scrollbar`);
    // readout nodes fall back to the preview read when live mode is off — drop THIS window's ids
    // (mirrors storeReadoutPreview's drop branch) so they show "—" until the new read lands.
    for (const v of model.window(winId)?.readouts || []) {
        delete readoutPreview.vals[v.id]; delete readoutPreview.confs[v.id];
        delete readoutPreview.all[v.id]; delete readoutPreview.allConfs[v.id];
    }
    window.dispatchEvent(new CustomEvent("readout-preview"));
}

// `deferRead`: settle the post-load read on the shared clock (scheduleWindowRead) instead of
// firing it from onload. Only the page-step uses it — boot/open and recapture must read
// immediately, since bootSettle (main.js) waits on `ocrBusyCount()` going quiet for 600ms and
// would drop the veil (and clear boot.phase, losing the server OCR cache) before a 700ms-deferred
// read ever started.
async function loadImage(winId, recapture, { deferRead = false } = {}) {
    const entry = imageCanvases.get(winId);
    if (!entry) return;
    const game = model.profile.name;
    let url = null;
    // the image on screen is about to change → nothing read off the old one may survive the swap
    if (winId !== "atlas") clearWindowReads(winId);
    const want = winPageOf(winId);   // the page this call is loading; a faster click supersedes it
    const done = timed(`${recapture ? "recapture" : "load image"} ${winId}`);
    setNodeBusy(nodeIdOf(winId), true);   // capturing/fetching the image
    try {
        if (recapture) {
            // grab the live window and ADD it as a new bound image (never overwrite a page);
            // the freshly captured image becomes the shown page (mirrors precap's onCapNew).
            const c = await api.capture(game);
            const list = await capListOf(winId);
            list.push(c.name);
            winPage.set(winId, list.length - 1);   // newly added image = shown page
            await api.setBindings(game, winId, list);
            url = c.url;
        } else {
            const cap = await curCapOf(winId);   // the bound capture for the page on screen
            if (cap) url = api.captureUrl(game, cap);
        }
    } catch (e) { done(String(e.message || e), "err"); setStatus(String(e.message || e)); setNodeBusy(nodeIdOf(winId), false); return; }
    // a later page-step already superseded this load — its own call owns the canvas now
    const stale = () => !recapture && winPageOf(winId) !== want;
    if (!url) {   // this page has no bound image — show a blank canvas (no live grab) + the empty nav
        done();
        setNodeBusy(nodeIdOf(winId), false);
        if (stale()) return;
        entry.overlay.setImage(null);
        refreshImageBoxes(winId);
        updateImageLabel(winId);
        drawEdges();
        return;
    }
    const img = new Image();
    img.onload = () => {
        done();
        setNodeBusy(nodeIdOf(winId), false);
        if (stale()) return;
        // keep the canvas area at the image aspect ratio so resizing always fits
        entry.canvas.parentElement.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
        entry.overlay.setImage(img);
        refreshImageBoxes(winId);
        drawEdges();
        updateImageLabel(winId);     // button shows the (possibly new) filename
        // the image changed (recapture / picked a capture / first open) → READ it: full preview
        // when the node exists, else just the grid overlay. The cutout atlas is image-only (no
        // grid/preview) — only its cheap detectors need re-evaluating.
        if (winId === "atlas") return;
        if (deferRead) { scheduleWindowRead(winId, { trace: true, readouts: true }); return; }
        if (prevHost(winId)) refreshPreview(winId, false);
        else refreshGridPreview(winId);
        retraceWindow(winId);   // the image changed → the field nodes' rule traces are stale, re-read them
        refreshDetect(winId);
    };
    img.onerror = () => setNodeBusy(nodeIdOf(winId), false);
    img.src = url;
}

function refreshImageBoxes(winId) {
    const entry = imageCanvases.get(winId);
    if (!entry) return;
    // data area first: drawn under everything and lowest hit priority, so the field
    // regions inside it stay selectable.
    const boxes = [];
    const da = model.dataArea(winId);
    if (da) boxes.push({ id: "__data_area", role: "data_area", ...da });
    // disabled regions/detectors aren't read, so don't clutter the canvas with them
    for (const r of model.regions(winId)) if (r.enabled !== false) boxes.push({ id: r.id, role: "region", field: r.field, ...r.box });
    for (const v of (model.window(winId)?.readouts || [])) if (v.enabled !== false) boxes.push({ id: v.id, role: "readout", label: v.id, ...v.box });
    for (const a of model.detects(winId)) if (a.enabled !== false) boxes.push({ id: a.id, role: "detect", ...a.search });
    // item template box is NOT drawn here — it's the authored cell at one spot, which
    // isn't where detection actually reads; the live grid (below) shows the real cells
    const sb = model.scrollbar(winId);
    // locked once calibration cutouts exist — their crops are tied to this exact origin
    if (sb) boxes.push({ id: "scrollbar", role: "scrollbar", locked: model.scrollbarLocked(winId), ...sb });
    // the atlas surface has no model boxes — its boxes are the armed positioning rect (labelled
    // by the current compose kind) and the auto-glypher's per-character proposals (editable
    // until confirmed, each labelled by its char)
    if (winId === "atlas") {
        if (cutRect) boxes.push({ id: CUT_RECT_ID, role: "glyphrect", label: composeKind, ...cutRect });
        glyphPending.forEach((p, i) =>
            boxes.push({ id: `${GLYPH_PROP_PREFIX}${i}`, role: "glyphprop", label: p.char || "?", ...p.box }));
    }
    // an uncommitted rect edit outranks the model (see refreshItemBoxes) — the atlas surface never
    // opens a batch, so its key simply never matches.
    entry.overlay.setBoxes(rectTxn.applyPending(`win:${winId}`, boxes));
    entry.overlay.setGridGuides(buildGridGuides(winId));   // columns + locator scan strips
    // prefer the live-detected grid (rows found in the actual capture); fall back to
    // the live-detected grid (where items were actually located this capture)
    entry.overlay.setCellBoxes(gridCellBoxes.get(winId) || []);   // detected cell tiling (solid)
    entry.overlay.setGuardCells(gridGuards.get(winId) || []);     // fieldless guard items (distinct colour)
    entry.overlay.setOccludedCells(gridOccluded.get(winId) || []); // scroll-occluded, dismissed cells
    entry.overlay.setGridPreview(gridPreviews.get(winId) || staticFieldPreview(winId) || []);
    entry.overlay.setPreview(gridReads.get(winId) || []);   // value + confidence per cell
    entry.overlay.setDetections(gridDetections.get(winId) || []);   // raw OCR lines (opt-in layer)
}

// Draw-layer toggles under the window canvas: one checkbox per row, each gating a draw layer
// in the overlay. raw OCR (every line the engine found, taught or not) is opt-in / default off.
const IMG_LAYERS = [
    ["regions", "regions", "taught OCR regions + data-area/scrollbar boxes"],
    ["detects", "detectors", "detector landmark boxes + their live pass/fail"],
    ["cells", "cells", "the cell tiling the reader actually found"],
    ["grid", "grid", "field grid preview + column/locator guides"],
    ["reads", "reads", "what OCR pulled from each cell, tinted by confidence"],
    ["raw", "raw OCR", "every raw line the engine found, independent of the taught boxes"],
];
function imgLayers() {
    return h("div", { class: "img-layers", title: "which overlays draw on the capture" },
        IMG_LAYERS.map(([k, label, tip]) =>
            h("label", { class: "flab", title: tip },
                `${label} `,
                h("input", { type: "checkbox", class: "imglayer", dataset: { k }, checked: k !== "raw" }))));
}

// The cell-relative box the reader scans for a row anchor — mirrors locator_of() server-side:
// a locate tell → a visual tell → the first tell → the first field flagged as a tell.
function itemLocatorBox(it) {
    for (const t of it.tells || []) if (t.locate) return t.box;
    for (const t of it.tells || []) if (t.kind && t.kind !== "text") return t.box;   // visual tell
    if ((it.tells || []).length) return it.tells[0].box;
    for (const f of it.fields || []) if (f.tell) return f.box;
    return null;
}

// Author-time guides for the window canvas: the columns the data area tiles into
// (ncols = round(da.w / cell.w), the same as the reader) and the locator scan strip in each
// column — so it's clear WHERE rows/columns are looked for, before anything is found.
// tile origins — mirrors static_grid_origins() in items.py so the drawn grid matches exactly
// what the reader tiles. The static grid anchors at the data-area corner (o0 = lo) and tiles
// by the cell SIZE (step); the cell sets the pitch, not the phase.
function staticGridOrigins(o0, step, lo, hi) {
    if (step <= 0) return [o0];
    const slack = step * 0.04, out = [];
    for (let o = o0; o >= lo - slack; o -= step) if (o + step <= hi + slack) out.push(o);
    for (let o = o0 + step; o + step <= hi + slack; o += step) if (o >= lo - slack) out.push(o);
    return out.sort((a, b) => a - b);
}

function buildGridGuides(winId) {
    const da = model.dataArea(winId), w = model.window(winId);
    if (!da || !w || !(w.items || []).length) return null;
    const isStatic = w.static_grid !== false;   // row-finding mode is per window
    const items = (w.items || []).filter((it) => it.enabled !== false && it.box && it.box.w && it.box.h);
    const cols = new Set(), rows = new Set(), strips = [];
    if (isStatic && items.length) {
        // ONE grid for the window: anchored at the data-area corner, tiled by the LOWEST-priority
        // cell SIZE (the cell sets the pitch, NOT the position) — matches the reader
        const base = items.reduce((a, b) => ((b.priority || 0) < (a.priority || 0) ? b : a));
        const iw = base.box.w, ih = base.box.h;
        for (const x of staticGridOrigins(da.x, iw, da.x, da.x + da.w)) { cols.add(x); cols.add(x + iw); }
        for (const y of staticGridOrigins(da.y, ih, da.y, da.y + da.h)) { rows.add(y); rows.add(y + ih); }
    } else {
        // LOCATED: both rows AND columns come from OCR content (align_x), not geometry — so
        // derive the guides from the DETECTED cells. Drawing columns as da.x + c*pitch (the old
        // way) ignores content + blank margins and puts the lines far off the real cells.
        const r4 = (v) => Math.round(v * 1e4) / 1e4;
        const cellsD = gridCellBoxes.get(winId) || [];
        for (const c of [...cellsD, ...(gridGuards.get(winId) || [])]) { rows.add(r4(c.y)); rows.add(r4(c.y + c.h)); }
        for (const c of cellsD) { cols.add(r4(c.x)); cols.add(r4(c.x + c.w)); }
        // locator scan marker per detected column (where the row anchor is read)
        const loc = items.map(itemLocatorBox).find(Boolean);
        if (loc) for (const c of cellsD) strips.push({ x: c.x + loc.x * c.w, w: loc.w * c.w });
    }
    return { cols: [...cols], rows: [...rows], strips, yTop: da.y, yBot: da.y + da.h, xLeft: da.x, xRight: da.x + da.w };
}

// Author-time field rectangles tiled across the STATIC grid, computed from geometry alone
// (no OCR) — mirrors _cells_for_item()'s static branch in items.py so what's drawn is exactly
// where the reader will read. Shown immediately on every item edit so a moved/resized box
// updates on the window canvas at once, without waiting for the OCR preview round-trip. The
// real OCR preview (gridPreviews) replaces this once it returns. Returns null in LOCATED mode
// (rows come from OCR there, so geometry can't predict them) or with no items.
function staticFieldPreview(winId) {
    const da = model.dataArea(winId), w = model.window(winId);
    if (!da || !w || w.static_grid === false) return null;
    const items = (w.items || []).filter((it) => it.enabled !== false && it.box && it.box.w && it.box.h);
    if (!items.length) return null;
    // ONE grid anchored at the data-area corner, tiled by the lowest-priority cell SIZE (pitch).
    const base = items.reduce((a, b) => ((b.priority || 0) < (a.priority || 0) ? b : a));
    const giw = base.box.w, gih = base.box.h;
    const xs = staticGridOrigins(da.x, giw, da.x, da.x + da.w);
    const ys = staticGridOrigins(da.y, gih, da.y, da.y + da.h);
    const out = [];
    for (const cy of ys) for (const cx of xs)
        for (const it of items) for (const f of it.fields || []) {
            if (!f.box) continue;
            out.push({ x: cx + f.box.x * giw, y: cy + f.box.y * gih, w: f.box.w * giw, h: f.box.h * gih });
        }
    return out.length ? out : null;
}

// Fetch where the rows ACTUALLY are by OCR-ing the capture, and draw that grid.
// This is what makes the dashed grid follow a scrolled list instead of guessing.
async function refreshGridPreview(winId, live = false) {
    const entry = imageCanvases.get(winId);
    if (!entry) return;
    try {
        const cap = live ? null : await curCapOf(winId);   // the page on screen (live grabs fresh)
        // On boot serve the unchanged stashed image from the server OCR cache (no engine touch);
        // a live read or a post-boot edit always re-OCRs fresh. Mirrors refreshPreview so the
        // grid-only path (image open, no preview node — e.g. the game gate's readouts) doesn't
        // re-OCR on every load.
        const res = await api.preview(previewProfileFor(winId), model.profile.name, cap, boot.phase && !live);
        setGridFromPreview(winId, res);
    } catch { /* ignore */ }
}

// A cell is a real, kept row: it passed its item tells (valid) AND read some data.
function cellKept(c) {
    if (c.valid === false) return false;
    return Object.values(c.fields).some((f) => f.value !== null && f.value !== undefined && f.value !== "");
}

// Pull the detected per-field boxes + their read values out of a preview response.
// Only kept cells, so blank/invalid slots don't scatter dashes across the image.
// A guard cell: a VALID located item with NO fields (a detector-only template, e.g. "no
// relic selected"). It carries no read, so cellKept rejects it — but we still want it ON the
// canvas (distinct colour). Only valid ones: a fieldless template's locator anchors on EVERY
// text row (it filters by char-class, not the literal), so it lands an invalid candidate on
// every tile; drawing those would paint the whole grid orange. Show only where its tell PASSED.
function isGuardCell(c) { return c.box && c.item && c.valid !== false && Object.keys(c.fields || {}).length === 0; }

function setGridFromPreview(winId, res) {
    if (!res || !res.cells) return;
    const kept = res.cells.filter(cellKept);
    const guards = res.cells.filter(isGuardCell);
    const boxes = kept.flatMap((c) => Object.values(c.fields).map((f) => f.box)).filter(Boolean);
    // what each cell actually read (value + confidence) — shown on the window canvas
    const reads = kept.flatMap((c) => Object.values(c.fields)
        .filter((f) => f.box)
        .map((f) => ({
            ...f.box,
            text: f.value,
            raw: f.raw,                     // genuine OCR read; shown as "orig -> value" when corrected
            confidence: f.confidence,
            substituted: f.substituted || null,
            verified: f.verified || null,   // dict/split/fuzzy/glyph — drawn as a validation pill
        })));
    // which item template matched: its id centred on each cell, white on black
    reads.push(...kept.filter((c) => c.box && c.item).map((c) => ({ ...c.box, cell: c.box, text: c.item })));
    // guard items get their id label too, so the orange box is identifiable
    reads.push(...guards.map((c) => ({ ...c.box, cell: c.box, text: c.item })));
    // Row-index overlay: when the scrollbar is calibrated, label each row with its computed
    // scroll-invariant index = pos*gain + ypos*rows_on_screen (rows_on_screen from the live row
    // pitch). Confirms the calibration visually right on the window canvas.
    const win = model.window(winId), da = win?.data_area, gain = win?.scroll?.calib_gain;
    const pos = res.scrollbar?.pos;
    if (gain != null && pos != null && da && da.h > 0) {
        const rowLeft = new Map();   // row-center y (window frac) -> leftmost cell/field box
        for (const c of kept) {
            // item cells may have no cell-level box — fall back to the first field box
            const box = c.box || Object.values(c.fields || {}).map((f) => f.box).find(Boolean);
            if (!box) continue;
            const cy = +(box.y + box.h / 2).toFixed(4);
            const cur = rowLeft.get(cy);
            if (!cur || box.x < cur.x) rowLeft.set(cy, box);
        }
        const ysorted = [...rowLeft.entries()].sort((a, b) => a[0] - b[0]);
        const yposes = ysorted.map(([cy]) => (cy - da.y) / da.h);
        const gaps = yposes.slice(1).map((y, i) => y - yposes[i]).filter((g) => g > 1e-3).sort((a, b) => a - b);
        // rows on screen = 1/pitch; fall back to one row's height when only a single row was found
        const pitch = gaps.length ? gaps[Math.floor(gaps.length / 2)]
            : (rowLeft.size ? ([...rowLeft.values()][0].h / da.h) : null);
        const visible = pitch ? 1 / pitch : null;
        if (visible) for (const [cy, box] of rowLeft) {
            const ypos = Math.min(1, Math.max(0, (cy - da.y) / da.h));
            // ypos is the row CENTER, so its coordinate is ~0.5 rows in; floor = rows fully above
            const idx = Math.floor(pos * gain + ypos * visible);
            const w = Math.min(0.045, box.x) || 0.03;
            reads.push({ cell: { x: Math.max(0, box.x - w), y: box.y, w, h: box.h }, text: `#${idx}` });
        }
    }
    // readouts: draw each readout box's read value right on the canvas (author-time preview of
    // what this image would produce for it), tinted like any other read.
    const roVals = res.readouts || {};
    for (const ro of (model.window(winId)?.readouts || [])) {
        if (ro.enabled === false || !(ro.id in roVals)) continue;
        reads.push({ ...ro.box, text: roVals[ro.id], confidence: 0.99 });
    }
    // the detected CELL outlines — the tiling the reader actually found
    const cells = kept.map((c) => c.box).filter(Boolean);
    // guard cells with their win/lose verdict so the overlay can colour them
    const guardCells = guards.map((c) => ({ ...c.box, valid: c.valid }));
    // cells DISMISSED because the scroll occluded them past the item's min coverage — drawn
    // distinctly on the canvas with the reason, so it's clear WHY the row wasn't stored
    const occluded = res.cells.filter((c) => c.occluded && c.box).map((c) => ({ ...c.box, occ: c.occ }));
    if (boxes.length) gridPreviews.set(winId, boxes); else gridPreviews.delete(winId);
    if (reads.length) gridReads.set(winId, reads); else gridReads.delete(winId);
    if (cells.length) gridCellBoxes.set(winId, cells); else gridCellBoxes.delete(winId);
    if (guardCells.length) gridGuards.set(winId, guardCells); else gridGuards.delete(winId);
    if (occluded.length) gridOccluded.set(winId, occluded); else gridOccluded.delete(winId);
    const dets = res.detections || [];   // raw OCR lines (the opt-in "raw OCR" layer)
    if (dets.length) gridDetections.set(winId, dets); else gridDetections.delete(winId);
    refreshImageBoxes(winId);
}

export {
    KINDS, ITEM_KINDS, TELL_KINDS, updateImageLabel, closeImage, openImage, createItemFromGeom,
    closeItemImage, setItemCellKeepingChildren, openItemImage, refreshItemBoxes,
    scheduleItemRead, runItemRead, refreshItemReadout,
    prevHost, previewProfileFor, refreshRuleTrace, setReadBusy, refreshPreview,
    commitPreviewNode, tellChip, subLabel, previewCell, previewTable, prefillDetectText,
    refreshDetect, setDetectStatus, scheduleWindowRead,
    loadImage, refreshImageBoxes, itemLocatorBox, staticGridOrigins, buildGridGuides,
    staticFieldPreview, refreshGridPreview, cellKept, setGridFromPreview, selectRegionNode,
    RECT_TYPES, toggleRectEditor, rectEditCanvasSync,
};
