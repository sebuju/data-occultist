// Window image / region drawing, item cutouts, OCR read pipeline (preview + detect + grid).
// Extracted from main.js verbatim.
import * as api from "../api.js";
import { h, frag, CAMERA, TRASH } from "../dom.js";
import { openCaptureModal } from "./panels/precap.js";
import { timed } from "../log.js";
import { Overlay } from "../overlay.js";
import { persist } from "./persist.js";
import * as groups from "./groups.js";
import {
    setStatus, model, nodeEls, openImages, winPage, imageCanvases, itemCanvases,
    gridPreviews, gridReads, gridCellBoxes, gridGuards, gridOccluded, gridDetections, itemReads, clearGrid, view, boot,
} from "./state.js";
import { drawEdges } from "./routing.js";
import { renderLiveWindow, liveDetCount, liveRecog } from "./panels/livewin.js";
import {
    render, autosave, rebuildNode, setNodeBusy, withBusy,
    registerOverlay, unregisterOverlay, overlaySelected, selectedNodeId, setSelectedNodeId,
    placeNewNode, refreshLive, persistBox, syncCellSize, itemChanged,
    addFieldToItemGroup, addTellToItemGroup, inheritGroupFrom, showSatellite,
    refreshItemTemplateRefs,
} from "./main.js";
import { panZoomTo } from "./camera.js";
import { keyPrevNode } from "./node_parts.js";
import { refreshDataNode, loadBatchesNode } from "./panels/datanodes.js";
import { verdictBadge } from "./collisions.js";

// ---- window image / region drawing (in-graph) -----------------------------

const KINDS = [["data_area", "data area", "▭"], ["item", "item", "▣"], ["detect", "detect", "◎"], ["scrollbar", "scrollbar", "↕"]];
// kinds drawn INSIDE an item node (on its frozen cutout): the cell + fields + tells
// [kind, label, icon, tooltip]. The tooltip explains what drawing that box does (shown on
// the item node's draw buttons). Extra 4th element is ignored by the index destructures.
const ITEM_KINDS = [
    ["bbox", "cell", "▣", "Draw the cell box — the repeating tile. Its size sets the grid pitch; every field and tell is positioned relative to it."],
    ["field", "field", "▦", "Draw a field box — text to OCR and store as a column of the record."],
    ["filled", "filled", "▩", "Draw a 'filled' tell — the cell counts as an item only if this box has visual content (edges/variance above the floor)."],
    ["text", "text", "T", "Draw a 'text' tell — the cell counts only if OCR reads here: bind a field (or leave blank for any column), and optionally require the read to match a literal."],
    ["color", "color", "◐", "Draw a 'colour' tell — the cell counts only if a taught colour is present in this box."],
    ["border", "border", "▭", "Draw a 'border' tell — like colour, but the taught colour must ride the box's PERIMETER band (a rarity frame / selection outline), not its fill."],
    ["template", "template", "⧉", "Draw a 'template' tell — the cell counts only if a saved sub-image matches in this box."],
    ["diamonds", "diamonds", "◆", "Draw a 'diamonds' tell — the cell counts only if a rank-diamond strip (◇/◆) is present (e.g. a rank-pip row)."],
];

// Graph node id for an image owner: a window is `win:<id>`, the game gate is the bare
// `game` node. The image/box/detect machinery is shared between them (rule 7), so every
// `win:${winId}` node-id lookup goes through this so "game" resolves to the game node.
export function nodeIdOf(winId) {
    if (winId === "game") return "game";
    if (winId === "glyphs") return "glyphs";   // the glyph-atlas node reuses the image stack
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
// (not persisted) — "page does not need to persist".
async function stepWinPage(winId, d) {
    const list = await capListOf(winId);
    if (list.length <= 1) return;
    const p = Math.min(list.length - 1, Math.max(0, winPageOf(winId) + d));
    if (p === winPageOf(winId)) return;
    winPage.set(winId, p);
    loadImage(winId, false);   // reloads the now-visible page + re-previews/-detects it
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

// The image surface lives INSIDE the window node's `.win-img` host — one per window node,
// built once and always present. Draw tools sit above the canvas; the page nav, image
// selector, recapture and "preview all" sit BELOW it. There is no clear/close button.
// `nodeEl` is the window node element when known by the caller (wireNode passes it): the surface
// is built during buildNode(), BEFORE render() registers the node in nodeEls, so a nodeEls lookup
// would miss it and the node would render with an empty .win-img (no canvas, no capture buttons).
// Other callers (load-time pendingOpenImages, precapture) omit it and resolve via nodeEls.
async function openImage(winId, nodeEl = null) {
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
                KINDS.map(([v, label, icon]) =>
                    h("button", { class: "tool", dataset: { kind: v }, title: `draw ${label}` }, `${icon} ${label}`)))),
        h("div", { class: "canvas-wrap" }, h("canvas")),
        h("div", { class: "img-foot" },
            h("span", { class: "img-pages", hidden: true },
                h("button", { class: "imgpg", dataset: { d: "-1" }, title: "previous image" }, "‹"),
                h("span", { class: "img-pageind" }),
                h("button", { class: "imgpg", dataset: { d: "1" }, title: "next image" }, "›")),
            h("button", { class: "imgbtn", title: "choose which stashed images this window uses" },
                CAMERA(), h("span", { class: "imgbtn-lbl" }, "images")),
            h("button", { class: "imgcap", title: "capture the live window into the current page" }, "recapture"),
            h("button", { class: "imgall", title: "preview data read from ALL of this window's images" }, "preview all")),
        imgLayers());
    const canvas = host.querySelector("canvas");
    const kindOf = () => host.querySelector(".tool.active")?.dataset.kind || "region";
    const overlay = new Overlay(canvas, {
        onCreate: async (geom) => {
            const k = kindOf();
            if (k === "item") { await createItemFromGeom(winId, geom); return; }   // freeze + spawn item node
            let newDetect = null, newNode = null;   // the node this draw spawned → inherit the window's group
            if (k === "detect") { newDetect = model.addDetect(winId, geom); newNode = `det:${winId}:${newDetect}`; }
            else if (k === "scrollbar") { model.setScrollbar(winId, geom); newNode = `sb:${winId}:scrollbar`; }
            else if (k === "data_area") model.setDataArea(winId, geom);   // a window box, not its own node
            else newNode = `reg:${winId}:${model.addRegion(winId, geom)}`;
            clearGrid(winId);   // layout changed → detected grid is stale
            // park the new node right BESIDE its window (srcId) before render() so ensurePositions
            // leaves it alone — no autoplacement into a far column.
            if (newNode) await placeNewNode(newNode, k, `win:${winId}`);
            render(); refreshImageBoxes(winId); autosave(winId);   // re-OCR only this window
            if (newDetect) rebuildNode(`win:${winId}`);   // add the new detector to the window's detects section
            if (newNode) inheritGroupFrom(newNode, `win:${winId}`);   // box drawn on a grouped window → join its group
            if (newDetect) prefillDetectText(winId, newDetect);
            drawEdges();   // edge to the window drawn immediately
        },
        onChange: (box) => {
            const r = box.role;
            if (r === "detect") model.setDetectBox(winId, box.id, box);
            else if (r === "scrollbar") model.setScrollbar(winId, box);
            else if (r === "data_area") model.setDataArea(winId, box);
            else if (r === "item") { model.setItemBox(winId, box.id, box); refreshItemBoxes(winId, box.id); }
            else model.setRegionBox(winId, box.id, box);
            clearGrid(winId);   // layout changed → detected grid is stale
            refreshImageBoxes(winId); drawEdges(); autosave(winId);   // re-OCR only this window
        },
        onSelect: (id) => overlaySelected(`win:${winId}`, id),
    });
    imageCanvases.set(winId, { host, canvas, overlay });
    registerOverlay(`win:${winId}`, { overlay, kind: "window", winId,
        persist: (b) => persistBox(winId, b), refresh: () => refreshImageBoxes(winId) });
    overlay.setWorldZoom(view.zoom);
    openImages.add(winId);
    persist.layout();
    host.querySelectorAll(".tool").forEach((btn) => btn.addEventListener("click", () => {
        host.querySelectorAll(".tool").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
    }));
    host.querySelector(".imgbtn").addEventListener("click", () => openCaptureModal(winId));   // pick image(s)
    host.querySelector(".imgcap").addEventListener("click", () => loadImage(winId, true));   // recapture re-reads
    host.querySelector(".imgall").addEventListener("click", (e) => previewAll(winId, e.currentTarget));
    host.querySelectorAll(".imgpg").forEach((b) => b.addEventListener("click", () => stepWinPage(winId, +b.dataset.d)));
    host.querySelectorAll(".imglayer").forEach((c) => c.addEventListener("change", (e) =>
        overlay.setVisible({ [e.target.dataset.k]: e.target.checked })));   // toggle a draw layer on the canvas
    await loadImage(winId, false);   // its onload now refreshes detect once the pixels are in
    drawEdges();
}

// ---- game-node worthiness gate image (detect-only sibling of openImage) -----
// The game node binds its own capture (a frame of the whole game window) and draws ONLY
// gate detectors on it. Reuses the SAME Overlay primitive + loadImage + model.detects/
// addDetect("game") as windows (rule 7); it just omits the grid/item/scrollbar tools and
// the preview pipeline a window has. The detect tool + colour eyedropper are wired here.
let _pickTarget = null;   // {winId, detId} armed by a detect node's eyedropper button

export function armColorPick(winId, detId) {
    _pickTarget = { winId, detId };
    const ov = imageCanvases.get(winId)?.overlay;
    if (ov) { ov.setPick(true); setStatus("click the image to sample a colour"); }
    else setStatus("open the image first");
}

// Arm the eyedropper to feed the window's preprocess (Text appearance) colour list
// instead of a detector's colour. Same sample flow, different sink (see applyPickedColor).
export function armPreprocessPick(winId) {
    _pickTarget = { winId, pp: true };
    const ov = imageCanvases.get(winId)?.overlay;
    if (ov) { ov.setPick(true); setStatus("click the image to sample the text colour"); }
    else setStatus("open the image first");
}

function applyPickedColor(winId, hex) {
    const t = _pickTarget; _pickTarget = null;
    if (!t || t.winId !== winId) return;
    if (t.pp) {                                   // eyedropper armed for window preprocess
        model.addPreprocessColor(winId, hex);
        rebuildNode(`win:${winId}`);              // refresh the colour chips
        autosave(winId);                          // preprocess changes OCR input -> re-read this window
        return;
    }
    const d = model.detect(winId, t.detId);
    if (!d) return;
    d.color = hex;
    rebuildNode(`det:${winId}:${t.detId}`);   // refresh swatch + hex input
    refreshImageBoxes(winId); autosave(null); refreshDetect(winId);
}

export async function openGameImage(nodeEl = null) {
    const winId = "game";
    const node = nodeEl || nodeEls.get("game");
    const host = node && node.querySelector(".win-img");
    if (!host) return;
    const prev = imageCanvases.get(winId);
    if (prev && prev.host === host) return;
    if (prev) { unregisterOverlay("game"); imageCanvases.delete(winId); openImages.delete(winId); }
    host.replaceChildren(
        h("div", { class: "imgtools" },
            h("span", { class: "tools" },
                h("button", { class: "tool", dataset: { kind: "detect" }, title: "draw a gate detector" }, "◎ detect"))),
        h("div", { class: "canvas-wrap" }, h("canvas")),
        h("div", { class: "img-foot" },
            h("span", { class: "img-pages", hidden: true },
                h("button", { class: "imgpg", dataset: { d: "-1" }, title: "previous image" }, "‹"),
                h("span", { class: "img-pageind" }),
                h("button", { class: "imgpg", dataset: { d: "1" }, title: "next image" }, "›")),
            h("button", { class: "imgbtn", title: "choose which stashed images the gate is taught on" },
                CAMERA(), h("span", { class: "imgbtn-lbl" }, "images")),
            h("button", { class: "imgcap", title: "capture the live game window into the current page" }, "recapture")));
    const canvas = host.querySelector("canvas");
    const kindOf = () => host.querySelector(".tool.active")?.dataset.kind || null;   // no tool => no draw
    const overlay = new Overlay(canvas, {
        onCreate: async (geom) => {
            if (kindOf() !== "detect") return;   // drawing is a no-op until the detect tool is picked
            const id = model.addDetect("game", geom);
            const newNode = `det:game:${id}`;
            await placeNewNode(newNode, "detect", "game");
            render(); refreshImageBoxes("game"); autosave(null);
            inheritGroupFrom(newNode, "game");   // box drawn on a grouped/subgrouped game node → join it
            rebuildNode("game"); drawEdges(); refreshDetect("game");
        },
        onChange: (box) => {
            if (box.role === "detect") model.setDetectBox("game", box.id, box);
            refreshImageBoxes("game"); drawEdges(); autosave(null);
            refreshDetect("game");   // a moved/resized box reads different pixels -> re-evaluate
        },
        onSelect: (id) => overlaySelected("game", id),
        onPick: (hex) => applyPickedColor("game", hex),
        canCreate: () => kindOf() === "detect",   // no draw without the detect tool (no crosshair, no box)
    });
    imageCanvases.set(winId, { host, canvas, overlay });
    registerOverlay("game", { overlay, kind: "game", winId,
        persist: (b) => model.setDetectBox("game", b.id, b), refresh: () => refreshImageBoxes("game") });
    overlay.setWorldZoom(view.zoom);
    openImages.add(winId);
    persist.layout();
    host.querySelectorAll(".tool").forEach((btn) => btn.addEventListener("click", () => {
        host.querySelectorAll(".tool").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
    }));
    host.querySelector(".imgbtn").addEventListener("click", () => openCaptureModal("game"));
    host.querySelector(".imgcap").addEventListener("click", () => loadImage("game", true));
    host.querySelectorAll(".imgpg").forEach((b) => b.addEventListener("click", () => stepWinPage("game", +b.dataset.d)));
    await loadImage("game", false);
    drawEdges();
}

// ---- glyph-atlas node -----------------------------------------------------
// Standalone node (its OWN image surface, keyed winId "glyphs"; the image/box stack is shared
// via nodeIdOf, rule 7). Separate from the game node because that canvas already hosts gate
// detectors. Teaching model: arm ONE positioning rectangle, nudge it with WASD (shift+WASD to
// resize) over a character, type the character, confirm -> the crop is frozen into the atlas
// and the rect is cleared. The auto-glypher segments a labelled word into per-character
// proposals the user corrects + confirms.

const GLYPH_RECT_ID = "__glyphrect";
let glyphRect = null;        // pending positioning rect on the glyph surface (fractions); null = hidden
let glyphPending = [];       // auto-glypher proposals awaiting correct+confirm: [{char, image}]
let _glyphKeyBound = false;

function defaultGlyphRect(wide = false) { return { x: 0.44, y: 0.45, w: wide ? 0.16 : 0.05, h: 0.06 }; }

// Redraw the positioning rect (refreshImageBoxes folds glyphRect in for the "glyphs" surface).
function drawGlyphRect() { refreshImageBoxes("glyphs"); }

// WASD nudges / shift+WASD resizes the armed rect. Ignored while a text input is focused (so
// typing the character isn't hijacked) and when no rect is armed.
function glyphKeydown(ev) {
    if (!glyphRect) return;
    const ae = document.activeElement;
    if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable)) return;
    const k = ev.key.toLowerCase();
    if (k === "escape") { cancelGlyphCompose(); ev.preventDefault(); return; }
    if (!"wasd".includes(k)) return;
    ev.preventDefault();
    const step = ev.shiftKey ? 0.004 : 0.005, r = glyphRect;
    if (ev.shiftKey) {   // resize (a/d width, w/s height)
        if (k === "d") r.w = Math.min(1 - r.x, r.w + step);
        if (k === "a") r.w = Math.max(0.008, r.w - step);
        if (k === "s") r.h = Math.min(1 - r.y, r.h + step);
        if (k === "w") r.h = Math.max(0.008, r.h - step);
    } else {             // move
        if (k === "d") r.x = Math.min(1 - r.w, r.x + step);
        if (k === "a") r.x = Math.max(0, r.x - step);
        if (k === "s") r.y = Math.min(1 - r.h, r.y + step);
        if (k === "w") r.y = Math.max(0, r.y - step);
    }
    drawGlyphRect();
}

function glyphComposeEls() {
    const node = nodeEls.get("glyphs");
    const host = node && node.querySelector(".glyph-img");
    return host ? {
        char: host.querySelector(".gc-char"), confirm: host.querySelector(".gc-confirm"),
        cancel: host.querySelector(".gc-cancel"), add: host.querySelector(".gc-add"),
    } : {};
}

function showGlyphCompose(on) {
    const { char, confirm, cancel } = glyphComposeEls();
    for (const el of [char, confirm, cancel]) if (el) el.hidden = !on;
    if (on && char) { char.value = ""; setTimeout(() => char.focus(), 0); }
}

function cancelGlyphCompose() {
    glyphRect = null;
    showGlyphCompose(false);
    drawGlyphRect();
}

async function saveGlyph() {
    const { char } = glyphComposeEls();
    const ch = (char?.value || "").trim();
    if (!glyphRect) return;
    if (!ch) { setStatus("type the character under the box first"); char?.focus(); return; }
    const game = model.profile.name;
    const cap = await curCapOf("glyphs");
    if (!cap) { setStatus("pick an image (or recapture) to teach glyphs from first"); return; }
    let cut;
    try { cut = await api.glyphCutout(game, cap, glyphRect); }   // freeze the crop NOW (independent of the canvas image after)
    catch (e) { setStatus(String(e.message || e)); return; }
    model.addGlyph({ char: ch, image: cut.name });
    cancelGlyphCompose();          // permanent now: clear the rect + compose row
    refreshGlyphAtlas();
    autosave(null);
}

async function runAutoGlypher() {
    const node = nodeEls.get("glyphs");
    const word = node?.querySelector(".gc-word")?.value.trim();
    if (!word) { setStatus("type the text the box covers, then Auto"); return; }
    if (!glyphRect) {   // first Auto arms a wide rect to position over the whole word
        glyphRect = defaultGlyphRect(true);
        drawGlyphRect();
        setStatus("position the box over the whole word (WASD / shift+WASD), then press Auto again");
        return;
    }
    const game = model.profile.name;
    const cap = await curCapOf("glyphs");
    if (!cap) { setStatus("pick an image (or recapture) first"); return; }
    let props;
    try { props = await api.glyphAuto(game, cap, glyphRect, word); }
    catch (e) { setStatus(String(e.message || e)); return; }
    glyphPending = props || [];
    glyphRect = null; showGlyphCompose(false); drawGlyphRect();   // hand off to the review strip
    refreshGlyphPending();
    if (!glyphPending.length) setStatus("auto-glypher found nothing — adjust the box");
}

export async function openGlyphImage(nodeEl = null) {
    const winId = "glyphs";
    const node = nodeEl || nodeEls.get("glyphs");
    const host = node && node.querySelector(".glyph-img");
    if (!host) return;
    const prev = imageCanvases.get(winId);
    if (prev && prev.host === host) { refreshGlyphAtlas(false, node); return; }
    if (prev) { unregisterOverlay("glyphs"); imageCanvases.delete(winId); openImages.delete(winId); }
    host.replaceChildren(
        h("div", { class: "glyph-compose" },
            h("button", { class: "gc-add", title: "add one glyph: show the box, position it with WASD (shift+WASD to resize) over a character, type the character, then Save" }, "＋ glyph"),
            h("input", { class: "gc-char", maxlength: "2", placeholder: "char", hidden: true, title: "the character under the box (Enter to save, Esc to cancel)" }),
            h("button", { class: "gc-confirm", hidden: true, title: "save this glyph permanently" }, "save"),
            h("button", { class: "gc-cancel", hidden: true, title: "cancel" }, "✕"),
            h("span", { class: "gc-div" }),
            h("input", { class: "gc-word", size: "10", placeholder: "known text", title: "auto-glypher: position the box over a whole word, type what it reads, then Auto" }),
            h("button", { class: "gc-auto", title: "segment the box into one glyph per character for you to correct + confirm" }, "auto")),
        h("div", { class: "canvas-wrap" }, h("canvas")),
        h("div", { class: "img-foot" },
            h("span", { class: "img-pages", hidden: true },
                h("button", { class: "imgpg", dataset: { d: "-1" }, title: "previous image" }, "‹"),
                h("span", { class: "img-pageind" }),
                h("button", { class: "imgpg", dataset: { d: "1" }, title: "next image" }, "›")),
            h("button", { class: "imgbtn", title: "choose which stashed images to teach glyphs from" },
                CAMERA(), h("span", { class: "imgbtn-lbl" }, "images")),
            h("button", { class: "imgcap", title: "capture the live game window into the current page" }, "recapture")));
    const canvas = host.querySelector("canvas");
    const overlay = new Overlay(canvas, {
        // dragging/resizing the rect with the mouse updates the pending rect too (WASD is the
        // keyboard equivalent). No draw-to-create — the ONE rect is the capture mechanism.
        onChange: (box) => { if (box.id === GLYPH_RECT_ID) glyphRect = { x: box.x, y: box.y, w: box.w, h: box.h }; },
        onSelect: () => {},
        canCreate: () => false,
    });
    imageCanvases.set(winId, { host, canvas, overlay });
    registerOverlay("glyphs", { overlay, kind: "glyphs", winId, refresh: () => refreshImageBoxes("glyphs") });
    overlay.setWorldZoom(view.zoom);
    openImages.add(winId);
    persist.layout();
    host.querySelector(".gc-add").addEventListener("click", () => {
        glyphRect = glyphRect || defaultGlyphRect();
        showGlyphCompose(true);
        drawGlyphRect();
    });
    host.querySelector(".gc-confirm").addEventListener("click", saveGlyph);
    host.querySelector(".gc-cancel").addEventListener("click", cancelGlyphCompose);
    host.querySelector(".gc-char").addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); saveGlyph(); }
        else if (e.key === "Escape") { e.preventDefault(); cancelGlyphCompose(); }
    });
    host.querySelector(".gc-auto").addEventListener("click", runAutoGlypher);
    host.querySelector(".imgbtn").addEventListener("click", () => openCaptureModal("glyphs"));
    host.querySelector(".imgcap").addEventListener("click", () => loadImage("glyphs", true));
    host.querySelectorAll(".imgpg").forEach((b) => b.addEventListener("click", () => stepWinPage("glyphs", +b.dataset.d)));
    if (!_glyphKeyBound) { document.addEventListener("keydown", glyphKeydown); _glyphKeyBound = true; }
    refreshGlyphAtlas(false, node);
    refreshGlyphPending(node);
    await loadImage("glyphs", false);
    drawEdges();
}

// Auto-glypher proposals: thumbnail + editable char each, plus confirm-all / discard. Nothing
// is saved until "confirm all" — the user corrects mis-read characters first.
export function refreshGlyphPending(nodeEl = null) {
    const node = nodeEl || nodeEls.get("glyphs");
    const host = node && node.querySelector(".glyph-pending");
    if (!host) return;
    if (!glyphPending.length) { host.replaceChildren(); return; }
    const game = model.profile.name;
    const rows = glyphPending.map((p, i) => h("div", { class: "glyph-cell" },
        h("img", { class: "glyph-thumb", src: api.glyphUrl(game, p.image), alt: p.char || "?", title: "proposed glyph" }),
        h("input", { class: "gp-char", maxlength: "2", value: p.char || "", placeholder: "?", dataset: { i } })));
    host.replaceChildren(
        h("div", { class: "glyph-head" },
            h("span", { class: "flab" }, `auto — fix chars, then save all [${glyphPending.length}]`),
            h("button", { class: "gp-confirm" }, "save all"),
            h("button", { class: "gp-discard danger" }, "discard")),
        h("div", { class: "glyph-grid" }, ...rows));
    host.querySelectorAll(".gp-char").forEach((inp) =>
        inp.addEventListener("input", (e) => { glyphPending[+e.target.dataset.i].char = e.target.value.trim(); }));
    host.querySelector(".gp-confirm").addEventListener("click", () => {
        model.addGlyphs(glyphPending.filter((p) => p.char));   // skip any the user blanked out
        glyphPending = [];
        refreshGlyphPending(node); refreshGlyphAtlas(); autosave(null);
    });
    host.querySelector(".gp-discard").addEventListener("click", () => { glyphPending = []; refreshGlyphPending(node); });
}

// The taught glyph atlas list: a thumbnail + editable character + delete per glyph, kept
// alphabetical (model.sortGlyphs). Event-driven (rebuilt on add/edit/delete, not a poll), so a
// full rebuild of this small list is fine (rule 1 is about steady-state poll redraws).
export function refreshGlyphAtlas(focusLast = false, nodeEl = null) {
    const node = nodeEl || nodeEls.get("glyphs");
    const host = node && node.querySelector(".glyph-atlas");
    if (!host) return;
    const game = model.profile.name;
    const glyphs = model.glyphs();
    const rows = glyphs.map((g, i) => h("div", { class: "glyph-cell" },
        h("img", { class: "glyph-thumb", src: api.glyphUrl(game, g.image), alt: g.char || "?", title: "taught glyph (cutout is frozen)" }),
        h("input", { class: "glyph-char", maxlength: "2", value: g.char || "", placeholder: "?",
            title: "which character this glyph is", dataset: { i } }),
        h("button", { class: "glyph-rm danger", dataset: { i }, title: "remove glyph" }, TRASH())));
    host.replaceChildren(...[
        h("div", { class: "glyph-head" },
            h("span", { class: "flab" }, "glyph atlas"),
            h("span", { class: "muted" }, glyphs.length ? `${glyphs.length} taught` : "＋ glyph or Auto to teach")),
        glyphs.length ? h("div", { class: "glyph-grid" }, ...rows) : null,
    ].filter(Boolean));   // never pass null to replaceChildren -> it stringifies to a "null" text node
    host.querySelectorAll(".glyph-char").forEach((inp) => {
        inp.addEventListener("change", (e) => { model.setGlyphChar(+e.target.dataset.i, e.target.value.trim()); refreshGlyphAtlas(); autosave(null); });
        inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); e.target.blur(); } });
    });
    host.querySelectorAll(".glyph-rm").forEach((btn) => btn.addEventListener("click", () => {
        model.removeGlyph(+btn.dataset.i); refreshGlyphAtlas(); autosave(null);
    }));
    if (focusLast && glyphs.length) host.querySelector(`.glyph-char[data-i="${glyphs.length - 1}"]`)?.focus();
}

// ---- item template nodes (frozen cutout + cell-relative fields/tells) ------

// Drawing an "item" box on the fullscreen image freezes that crop and spawns a node.
async function createItemFromGeom(winId, geom) {
    const game = model.profile.name;
    const cap = await curCapOf(winId);   // freeze the crop from the page on screen
    if (!cap) { setStatus("recapture the window first"); return; }
    let cut;
    try { cut = await api.itemCutout(game, cap, geom); }
    catch (e) { setStatus(String(e.message || e)); return; }
    const itemId = model.addItem(winId, { cutout: cut.name, cutout_box: geom, box: geom });
    clearGrid(winId);
    // park beside its window before render() so ensurePositions skips it — no autoplacement.
    await placeNewNode(`item:${winId}:${itemId}`, "item", `win:${winId}`);
    render(); refreshImageBoxes(winId); autosave(winId);   // re-OCR only this window
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
    clearTimeout(itemReadTimers.get(key)); itemReadTimers.delete(key); itemReadAgain.delete(key);
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
    // draw-mode buttons live in the node body now (itemLists: cell/field + tell sections);
    // this host is just the readout + cutout canvas.
    host.replaceChildren(
        h("div", { class: "item-readout muted", title: "what the current setup reads + the key it stores under" }),
        h("div", { class: "canvas-wrap" }, h("canvas")));
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
    const kindOf = () => node.querySelector(".tool.active")?.dataset.kind || null;

    const overlay = new Overlay(canvas, {
        onCreate: async (geom) => {                  // geom in cutout fractions
            const w = cut2win(geom);
            const k = kindOf();
            if (!k) return;                            // no draw tool picked → drawing is a no-op
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
            // a tell SPAWNS its own node too, grouped with the item (mirror the field path above)
            const tid = model.addItemTell(winId, itemId, k, win2rel(w));   // filled/text/color/template/diamonds
            await placeNewNode(`tell:${winId}:${itemId}:${tid}`, "itemtell", `item:${winId}:${itemId}`);
            render();
            addTellToItemGroup(winId, itemId, tid);
            rebuildNode(`item:${winId}:${itemId}`);   // refresh the item node's tells summary (render keeps existing bodies)
            groups.renderGroups();
            refreshItemBoxes(winId, itemId); refreshImageBoxes(winId);
            clearGrid(winId); scheduleItemRead(winId, itemId); autosave(winId);
            panZoomTo(`tell:${winId}:${itemId}:${tid}`);
        },
        onChange: (box) => {                        // box in cutout fractions + role/id
            const w = cut2win(box);
            if (box.role === "bbox") setItemCellKeepingChildren(winId, itemId, w);
            else if (box.role === "field") model.setItemFieldBox(winId, itemId, box.id, win2rel(w));
            else model.setItemTellBox(winId, itemId, box.id, win2rel(w));
            itemChanged(winId, itemId);              // box moved/resized — no DOM rebuild
            // a moved cell (remaps every tell) or a moved template tell shifts the crop region —
            // redraw the live reference preview on each affected template tell node
            if (box.role === "bbox" || model.itemTell(winId, itemId, box.id)?.kind === "template")
                refreshItemTemplateRefs(winId, itemId);
            if (box.role === "bbox") syncCellSize(winId, itemId);   // reflect new cell size in the inputs
        },
        onSelect: (id) => overlaySelected(`item:${winId}:${itemId}`, id),
    });
    itemCanvases.set(`${winId}:${itemId}`, { host, canvas, overlay, cut2win, win2cut, win2rel, rel2win });
    // central registry: cross-deselect + WASD for the item's boxes
    const persistItem = (b) => {
        const w = cut2win(b);
        if (b.role === "bbox") setItemCellKeepingChildren(winId, itemId, w);
        else if (b.role === "field") model.setItemFieldBox(winId, itemId, b.id, win2rel(w));
        else model.setItemTellBox(winId, itemId, b.id, win2rel(w));
        itemChanged(winId, itemId);
        if (b.role === "bbox") syncCellSize(winId, itemId);   // reflect new cell size in the inputs
    };
    registerOverlay(`item:${winId}:${itemId}`, { overlay, kind: "item", winId, itemId,
        persist: persistItem, refresh: () => { refreshItemBoxes(winId, itemId); refreshImageBoxes(winId); } });
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
    ent.overlay.setBoxes(boxes);
    // the extracted field values, drawn over their boxes tinted by confidence (same as the
    // window preview). The read returns boxes already in cutout fractions.
    const reads = rd ? Object.values(rd.fields).filter((f) => f.box)
        .map((f) => ({ ...f.box, text: f.value, confidence: f.confidence, substituted: f.substituted })) : [];
    ent.overlay.setPreview(reads);
}

// Re-read the cutout whenever its settings change, debounced and coalesced: config
// edits fire a burst of change events and OCR is heavy, so wait for the dust to settle
// and never run two reads for the same item at once (queue a single re-run instead).
const itemReadTimers = new Map();   // "winId:itemId" -> debounce timer
const itemReadBusy = new Set();     // items with a read in flight
const itemReadAgain = new Set();    // items whose settings changed mid-read
function scheduleItemRead(winId, itemId, delay = 500) {
    const key = `${winId}:${itemId}`;
    clearTimeout(itemReadTimers.get(key));
    itemReadTimers.set(key, setTimeout(() => { itemReadTimers.delete(key); runItemRead(winId, itemId); }, delay));
}

// Read the item's frozen cutout with the current settings and show what it extracts:
// field values tinted on the canvas + a compact tell/validity read-out under the toolbar.
async function runItemRead(winId, itemId) {
    const key = `${winId}:${itemId}`;
    if (!itemCanvases.has(key)) return;
    if (itemReadBusy.has(key)) { itemReadAgain.add(key); return; }   // re-run once after
    itemReadBusy.add(key);
    const node = nodeEls.get(`item:${winId}:${itemId}`);
    const out = node?.querySelector(".item-readout");
    if (out && !out.childElementCount && !out.textContent) out.replaceChildren("reading…");
    const done = timed(`item read ${key}`);
    try {
        const res = await api.itemRead(previewProfileFor(winId), model.profile.name, winId, itemId, boot.phase);
        itemReads.set(key, res);
        refreshItemBoxes(winId, itemId);
        if (out) out.replaceChildren(itemReadout(res, winId, itemId));
        done(`· ${res.device || "?"} · ${res.valid ? "valid" : "rejected"}`, "ok", res.ms);
    } catch (e) {
        done(String(e.message || e), "err");
        if (out) out.replaceChildren(h("span", { class: "tc-bad" }, String(e.message || e)));
    } finally {
        itemReadBusy.delete(key);
        if (itemReadAgain.has(key)) { itemReadAgain.delete(key); runItemRead(winId, itemId); }
    }
}

// Compact readout of a cutout read: validity, each field's value, the record key it stores
// under, and each tell — a 3-col grid (label · ":" · value) so the colon sits in its OWN
// column and every label/value lines up. One `row()` builds a grid line for fields, key, AND
// tells alike, so they all share the columns.
function itemReadout(res, winId, itemId) {
    const status = res.valid
        ? h("span", { class: "tc-ok" }, "✓ valid")
        : h("span", { class: "tc-bad" }, "✗ rejected");
    // one 3-col grid line: label · ":" · value. `label`/`value` are nodes (or strings).
    const row = (label, value) => frag(
        h("span", { class: "ir-k" }, label),
        h("span", { class: "ir-c" }, ":"),
        h("span", { class: "ir-v" }, value));
    const fields = Object.entries(res.fields || {}).map(([k, v]) => {
        const cls = v.substituted ? "conf-sub" : v.confidence >= 0.8 ? "conf-ok" : v.confidence >= 0.5 ? "conf-warn" : "conf-bad";
        return row(k, h("b", { class: cls }, String(v.value ?? "∅")));
    });
    const kv = keyPrevNode(winId, itemId);   // the record key this read would store under (a node, or null)
    const key = kv ? row("key", kv) : null;
    // each tell is its OWN readout row (id : ✓/✗ score) so it aligns in the same columns as the
    // fields, instead of a separate full-width chip band.
    const tells = (res.tells || []).map((t) =>
        row(
            h("span", { title: t.detail || null }, t.id),
            h("span", { class: t.pass ? "tc-ok" : "tc-bad" },
                `${t.pass ? "✓" : "✗"} ${String(t.score)}`,
                t.threshold == null ? null : h("span", { class: "muted" }, `/${String(t.threshold)}`))));
    return frag(h("div", { class: "ir-row" }, status), fields, key, tells);
}

function selectRegionNode(winId, boxId) {
    const ids = [`reg:${winId}:${boxId}`, `det:${winId}:${boxId}`, `st:${winId}:${boxId}`, `sb:${winId}:${boxId}`];
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

// Coalesce reads: at most ONE OCR request per window is ever in flight. Clicking
// "read" again while one runs doesn't stack another (which would serialize on the OCR
// lock and starve the server threadpool) — it just flags a single re-run with the
// latest inputs once the current one returns. The button stays live.
const previewBusy = new Set();        // winId -> a read is in flight
const previewAgain = new Map();       // winId -> live flag of a queued re-run
// disable + spin the read buttons for this window (preview node + image toolbar) while
// an OCR read runs, so it's obvious it's working and the button can't be re-fired.
function setReadBusy(winId, on) {
    const pnode = nodeEls.get(`prev:${winId}`), wnode = nodeEls.get(`win:${winId}`);
    const btns = [...(pnode?.querySelectorAll(".prevrun") || []), ...(wnode?.querySelectorAll(".imgprev") || [])];
    for (const b of btns) { b.disabled = on; b.classList.toggle("reading", on); }
}
async function refreshPreview(winId, live = false) {
    const host = prevHost(winId);
    if (!host) return;
    host.dataset.ran = "1";   // marks it for live re-reads
    if (previewBusy.has(winId)) { previewAgain.set(winId, live); return; }   // already reading → re-run once after
    previewBusy.add(winId);
    setReadBusy(winId, true);
    if (!live) host.replaceChildren(h("p", { class: "muted", style: "padding:8px" }, "reading…"));
    const done = timed(`OCR preview ${winId}`);
    try {
        const cap = live ? null : await curCapOf(winId);   // the page on screen (live grabs fresh)
        // On boot, serve the unchanged stashed image from the server OCR cache (no engine touch);
        // a live read or a post-boot edit always re-OCRs fresh.
        const res = await api.preview(previewProfileFor(winId), model.profile.name, cap, boot.phase && !live);
        host.replaceChildren(previewTable(res.cells));
        setGridFromPreview(winId, res);   // same OCR pass drives the dashed grid
        setWindowDrift(winId, res.drift);   // grid-fit score on the window node
        done(`· ${res.device || "?"} · ${(res.cells || []).length} cells`, "ok", res.ms);
    } catch (e) {
        done(String(e.message || e), "err");
        host.replaceChildren(h("p", { class: "muted", style: "padding:8px" }, String(e.message || e)));
    } finally {
        previewBusy.delete(winId);
        if (previewAgain.has(winId)) {   // a click landed mid-read → run once more (button stays busy, no flicker)
            const lv = previewAgain.get(winId); previewAgain.delete(winId); refreshPreview(winId, lv);
        } else {
            setReadBusy(winId, false);
        }
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
    const cls = v.confidence >= 0.8 ? "conf-ok" : v.confidence >= 0.5 ? "conf-warn" : "conf-bad";
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
        if (a && !a.text && info && info.read && info.read !== "(template)") {
            a.text = info.read;
            render(); autosave(winId);   // re-detect only this window
        }
    } catch { /* ignore */ }
}

// Coalesce detect the same way as preview: at most one in flight per window, with a
// single queued re-run. Without this, live mode would enqueue a detect every round and
// they'd stack on the OCR queue until each takes tens of seconds.
const detectBusy = new Set();
const detectAgain = new Map();
async function refreshDetect(winId, live = false) {
    if (detectBusy.has(winId)) { detectAgain.set(winId, live); return; }
    detectBusy.add(winId);
    const isGame = winId === "game";
    // spinner on every node whose value this detect refreshes
    const ids = [nodeIdOf(winId), ...model.detects(winId).map((a) => `det:${winId}:${a.id}`)];
    if (model.scrollbar(winId)) ids.push(`sb:${winId}:scrollbar`);
    const done = timed(`detect ${winId}`);
    try {
        await withBusy(ids, async () => {
            try {
                const cap = live ? null : await curCapOf(winId);   // the page on screen (live grabs fresh)
                const res = await api.detect(previewProfileFor(winId), model.profile.name, cap, boot.phase && !live);
                const dstatus = {};   // mirror onto the window canvas: colour/tint each detect box by its verdict
                // game gate verdicts live under res.gate (keyed like the window's res.detect)
                const detMap = isGame ? (res.gate || {}) : (res.detect || {});
                for (const [aid, info] of Object.entries(detMap)) { setDetectStatus(`det:${winId}:${aid}`, info); dstatus[aid] = info; }
                if (isGame) setGameGateBadge(res.gate_active);
                for (const [sid, info] of Object.entries(res.states || {})) setDetectStatus(`st:${winId}:${sid}`, info);
                setWindowDetectStatus(winId, res);   // detects section: per-row + overall verdict (window or gate)
                const dent = imageCanvases.get(winId);
                if (dent) dent.overlay.setDetectStatus(dstatus);
                if (live) {   // is this window currently recognised on screen? (drives the live panel dot)
                    const svals = Object.values(res.states || {});
                    // game: the worthiness gate's OR verdict; window: mode/negate-aware verdict (states win)
                    const recognized = isGame ? !!res.gate_active
                        : svals.length ? svals.some((s) => s.matched) : (res.window?.pass ?? false);
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
                done(`· ${res.device || "?"}`, "ok", res.ms);
            } catch (e) { done(String(e.message || e), "err"); }
        });
    } finally {
        detectBusy.delete(winId);
        if (detectAgain.has(winId)) { const lv = detectAgain.get(winId); detectAgain.delete(winId); refreshDetect(winId, lv); }
    }
}
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
// Window node grid-fit score: mean / max distance the located cells drift off the content
// they should bracket (from read_preview's `drift`). Reconciled in place — only the span's
// text/class change. Green <1%, amber <3%, red beyond — 0 = dead on the grid.
function setWindowDrift(winId, drift) {
    const el = nodeEls.get(`win:${winId}`);
    const span = el && el.querySelector(".wd-drift");
    if (!span) return;
    if (!drift || !drift.n) { span.textContent = "—"; span.className = "wd-drift muted"; return; }
    const pct = (v) => `${(v * 100).toFixed(0)}%`;   // % of a CELL (1.0 = a whole cell off)
    span.textContent = `x ${pct(drift.x.mean)}/${pct(drift.x.max)} · y ${pct(drift.y.mean)}/${pct(drift.y.max)} · ${drift.n} cells`;
    const worst = Math.max(drift.x.max, drift.y.max);
    span.className = "wd-drift " + (worst < 0.05 ? "conf-ok" : worst < 0.15 ? "conf-warn" : "conf-bad");
}

// The game node's worthiness badge: ● collecting (an OCR-worthy phase is up) vs ◯ waiting.
// Reconciled in place (text/class only) — no rebuild. `active` null => unknown (pre-read).
// nGate counts only ENABLED gate detectors (a disabled one isn't part of the gate).
export function setGameGateBadge(active) {
    const el = nodeEls.get("game");
    const badge = el && el.querySelector(".gate-badge");
    if (!badge) return;
    const nGate = (model.profile.detect || []).filter((d) => d.enabled !== false).length;
    if (!nGate) { badge.textContent = "no gate — always reads"; badge.className = "gate-badge muted"; return; }
    if (active == null) { badge.textContent = "◯ waiting for phase"; badge.className = "gate-badge muted"; return; }
    badge.textContent = active ? "● collecting" : "◯ waiting for phase";
    badge.className = "gate-badge " + (active ? "conf-ok" : "conf-warn");
}

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
    if (norm == null) {            // template detector: no normalised text, just echo the read
        before.hidden = true; chars.hidden = true;
        if (info.read) { after.hidden = false; after.replaceChildren("read: ", h("span", { class: "ds-txt" }, info.read)); }
        else after.hidden = true;
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
    const isGame = winId === "game";
    const det = (isGame ? res.gate : res.detect) || {};
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
        if (isGame) {   // gate verdict: OCR-worthy phase up (green ✓) vs idle (amber ◯ — not an error)
            const a = res.gate_active;
            verdict.textContent = a ? "✓ OCR-worthy phase" : "◯ idle — no OCR";
            verdict.className = "wd-verdict " + (a ? "conf-ok" : "conf-warn");
        } else {
            const w = res.window;
            if (!w) { verdict.textContent = ""; verdict.className = "wd-verdict muted"; }
            else {
                verdict.textContent = w.pass ? "✓ would match this window" : "✗ would not match";
                verdict.className = "wd-verdict " + (w.pass ? "conf-ok" : "conf-bad");
            }
        }
    }
    if (!isGame) setWindowCollideStatus(winId);   // cross-window outcome (windows only)
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
// Scoped re-OCR: an edit to ONE window (its items/boxes/detectors) should only re-read THAT
// window, not every open one. Callers pass the window id; a null id means "all" (a global edit).
// ids accumulate across the 700ms debounce so edits spanning windows don't drop each other.
let detectT = null;
const _detectPending = new Set();   // winIds queued; _detectAll overrides to all open windows
let _detectAll = false;
function refreshOpenDetect(winId = null) {
    if (winId) _detectPending.add(winId); else _detectAll = true;
    clearTimeout(detectT);
    detectT = setTimeout(() => {
        const all = _detectAll; _detectAll = false;
        for (const id of imageCanvases.keys()) {
            if (!all && !_detectPending.has(id)) continue;
            if (model.window(id)?.enabled !== false) refreshDetect(id);   // skip disabled windows
        }
        _detectPending.clear();
        refreshCollisions();   // cross-window verdict tracks the same edits (coalesced)
    }, 700);
}

let previewT = null;
const _previewPending = new Set();
let _previewAll = false;
function refreshOpenPreviews(winId = null) {
    if (winId) _previewPending.add(winId); else _previewAll = true;
    clearTimeout(previewT);
    previewT = setTimeout(() => {
        const all = _previewAll; _previewAll = false;
        for (const w of model.profile.windows || []) {
            if (w.enabled === false) continue;   // a disabled window reads nothing — don't re-run it
            if (!all && !_previewPending.has(w.id)) continue;   // scoped: only the edited window(s)
            const host = prevHost(w.id);
            // Read on ANY update — the preview should always reflect the current setup, not wait
            // for a first manual "read". Reads the window's OWN bound image (live=false), not a
            // fresh game grab, so it doesn't need the game running (a live grab 404s when it isn't).
            if (host) refreshPreview(w.id, false);              // refreshes the preview table + grid
            else if (imageCanvases.has(w.id)) refreshGridPreview(w.id);   // image open, no preview node
        }
        _previewPending.clear();
    }, 700);
}


async function loadImage(winId, recapture) {
    const entry = imageCanvases.get(winId);
    if (!entry) return;
    const game = model.profile.name;
    let url = null;
    const done = timed(`${recapture ? "recapture" : "load image"} ${winId}`);
    setNodeBusy(nodeIdOf(winId), true);   // capturing/fetching the image
    try {
        if (recapture) {
            // grab the live window and store it as the CURRENT page (append when there are none)
            const c = await api.capture(game);
            const list = await capListOf(winId);
            const p = winPageOf(winId);
            if (p < list.length) list[p] = c.name; else { list.push(c.name); winPage.set(winId, list.length - 1); }
            await api.setBindings(game, winId, list);
            url = c.url;
        } else {
            const cap = await curCapOf(winId);   // the bound capture for the page on screen
            if (cap) url = api.captureUrl(game, cap);
        }
    } catch (e) { done(String(e.message || e), "err"); setStatus(String(e.message || e)); setNodeBusy(nodeIdOf(winId), false); return; }
    if (!url) {   // this page has no bound image — show a blank canvas (no live grab) + the empty nav
        done();
        setNodeBusy(nodeIdOf(winId), false);
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
        // keep the canvas area at the image aspect ratio so resizing always fits
        entry.canvas.parentElement.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
        entry.overlay.setImage(img);
        refreshImageBoxes(winId);
        drawEdges();
        updateImageLabel(winId);     // button shows the (possibly new) filename
        // the image changed (recapture / picked a capture / first open) → READ it: full preview
        // when the node exists, else just the grid overlay. The game gate has no grid/preview —
        // only its cheap detectors need re-evaluating.
        // gate-like image-only nodes (game worthiness gate, glyph atlas) have no grid/preview
        if (winId !== "game" && winId !== "glyphs") {
            if (prevHost(winId)) refreshPreview(winId, false);
            else refreshGridPreview(winId);
        }
        if (winId !== "glyphs") refreshDetect(winId);   // glyph node has no detectors to evaluate
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
    for (const a of model.detects(winId)) if (a.enabled !== false) boxes.push({ id: a.id, role: "detect", ...a.search });
    // item template box is NOT drawn here — it's the authored cell at one spot, which
    // isn't where detection actually reads; the live grid (below) shows the real cells
    const sb = model.scrollbar(winId);
    if (sb) boxes.push({ id: "scrollbar", role: "scrollbar", ...sb });
    // the glyph surface has no model boxes — its only box is the armed positioning rect
    if (winId === "glyphs" && glyphRect) boxes.push({ id: GLYPH_RECT_ID, role: "glyphrect", label: "glyph", ...glyphRect });
    entry.overlay.setBoxes(boxes);
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
        const res = await api.preview(previewProfileFor(winId), model.profile.name, cap);
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
            confidence: f.confidence,
            substituted: f.substituted || null,
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
    KINDS, ITEM_KINDS, updateImageLabel, closeImage, openImage, createItemFromGeom,
    closeItemImage, setItemCellKeepingChildren, openItemImage, refreshItemBoxes,
    itemReadTimers, itemReadBusy, itemReadAgain, scheduleItemRead, runItemRead, itemReadout,
    prevHost, previewProfileFor, previewBusy, previewAgain, setReadBusy, refreshPreview,
    commitPreviewNode, tellChip, subLabel, previewCell, previewTable, prefillDetectText,
    detectBusy, detectAgain, refreshDetect, setDetectStatus, detectT, _detectPending,
    _detectAll, refreshOpenDetect, previewT, _previewPending, _previewAll, refreshOpenPreviews,
    loadImage, refreshImageBoxes, itemLocatorBox, staticGridOrigins, buildGridGuides,
    staticFieldPreview, refreshGridPreview, cellKept, setGridFromPreview, selectRegionNode,
};
