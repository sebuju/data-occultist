// Window image / region drawing, item cutouts, OCR read pipeline (preview + detect + grid).
// Extracted from main.js verbatim.
import * as api from "../api.js";
import { esc, CAMERA } from "../dom.js";
import { openModal } from "../modal.js";
import { openCaptureModal } from "./panels/precap.js";
import { log, timed } from "../log.js";
import { openDictionaryPicker } from "./dict_picker.js";
import { enhanceTable } from "./table.js";
import { Overlay } from "../overlay.js";
import { persist } from "./persist.js";
import * as groups from "./groups.js";
import {
  $, setStatus, model, nodeEls, openImages, winPage, imageCanvases, itemCanvases, overlays,
  gridPreviews, gridReads, gridCellBoxes, itemReads, clearGrid, view,
} from "./state.js";
import { drawEdges, freezeRouting, requestEdges } from "./routing.js";
import { registerWorker, unregisterWorker } from "./workers.js";
import { renderLiveWindow, liveDetCount, liveRecog } from "./panels/livewin.js";
import {
  render, autosave, rebuildNode, focusNode, setNodeBusy, withBusy,
  registerOverlay, unregisterOverlay, overlaySelected, selectWindowBox, selectedNodeId,
  panZoomTo, placeNewNode, refreshLive, persistBox, syncCellSize, itemChanged,
  keyPrevHTML, addFieldToItemGroup, addTellToItemGroup, inheritGroupFrom,
} from "./main.js";
import { refreshDataNode, loadBatchesNode } from "./panels/datanodes.js";

// ---- window image / region drawing (in-graph) -----------------------------

const KINDS = [["data_area", "data area", "▭"], ["item", "item", "▣"], ["detect", "detect", "◎"], ["scrollbar", "scrollbar", "↕"]];
// kinds drawn INSIDE an item node (on its frozen cutout): the cell + fields + tells
// [kind, label, icon, tooltip]. The tooltip explains what drawing that box does (shown on
// the item node's draw buttons). Extra 4th element is ignored by the index destructures.
const ITEM_KINDS = [
  ["bbox", "cell", "▣", "Draw the cell box — the repeating tile. Its size sets the grid pitch; every field and tell is positioned relative to it."],
  ["field", "field", "▦", "Draw a field box — text to OCR and store as a column of the record."],
  ["filled", "filled", "▩", "Draw a 'filled' tell — the cell counts as an item only if this box has visual content (edges/variance above the floor)."],
  ["text", "text", "T", "Draw a 'text' tell — the cell counts only if OCR reads non-empty text here (bind it to a field)."],
  ["color", "color", "◐", "Draw a 'colour' tell — the cell counts only if a taught colour is present in this box."],
  ["template", "template", "⧉", "Draw a 'template' tell — the cell counts only if a saved sub-image matches in this box."],
  ["diamonds", "diamonds", "◆", "Draw a 'diamonds' tell — the cell counts only if a rank-diamond strip (◇/◆) is present (e.g. arcanes)."],
];

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
  btn = btn || nodeEls.get(`win:${winId}`)?.querySelector(".imgbtn");
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
  const pages = nodeEls.get(`win:${winId}`)?.querySelector(".img-pages");
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
  if (e && e.host) e.host.innerHTML = "";
  imageCanvases.delete(winId);
  unregisterOverlay(`win:${winId}`);
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
  host.innerHTML = `<div class="imgtools">
      <span class="tools">${KINDS.map(([v, label, icon]) => `<button class="tool" data-kind="${v}" title="draw ${label}">${icon} ${label}</button>`).join("")}</span></div>
    <div class="canvas-wrap"><canvas></canvas></div>
    <div class="img-foot">
      <span class="img-pages" hidden><button class="imgpg" data-d="-1" title="previous image">‹</button><span class="img-pageind"></span><button class="imgpg" data-d="1" title="next image">›</button></span>
      <button class="imgbtn" title="choose which stashed images this window uses">${CAMERA}<span class="imgbtn-lbl">images</span></button>
      <button class="imgcap" title="capture the live window into the current page">recapture</button>
      <button class="imgall" title="preview data read from ALL of this window's images">preview all</button>
    </div>`;
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
      render(); refreshImageBoxes(winId); autosave(true, winId);   // re-OCR only this window
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
      refreshImageBoxes(winId); drawEdges(); autosave(true, winId);   // re-OCR only this window
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
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => drawEdges()).observe(canvas.parentElement);
  await loadImage(winId, false);   // its onload now refreshes detect once the pixels are in
  drawEdges();
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
  render(); refreshImageBoxes(winId); autosave(true, winId);   // re-OCR only this window
  inheritGroupFrom(`item:${winId}:${itemId}`, `win:${winId}`);   // box drawn on a grouped window → join its group
  drawEdges();   // edge to the window drawn immediately
  openItemImage(winId, itemId);
}

function closeItemImage(winId, itemId) {
  const key = `${winId}:${itemId}`;
  const e = itemCanvases.get(key);
  if (e && e.host) e.host.innerHTML = "";
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
  host.innerHTML = `<div class="item-readout muted" title="what the current setup reads + the key it stores under"></div>
    <div class="canvas-wrap"><canvas></canvas></div>`;
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
        groups.renderGroups();
        refreshItemBoxes(winId, itemId); refreshImageBoxes(winId);
        clearGrid(winId); scheduleItemRead(winId, itemId); autosave(true, winId);
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
      groups.renderGroups();
      refreshItemBoxes(winId, itemId); refreshImageBoxes(winId);
      clearGrid(winId); scheduleItemRead(winId, itemId); autosave(true, winId);
      panZoomTo(`tell:${winId}:${itemId}:${tid}`);
    },
    onChange: (box) => {                        // box in cutout fractions + role/id
      const w = cut2win(box);
      if (box.role === "bbox") setItemCellKeepingChildren(winId, itemId, w);
      else if (box.role === "field") model.setItemFieldBox(winId, itemId, box.id, win2rel(w));
      else model.setItemTellBox(winId, itemId, box.id, win2rel(w));
      itemChanged(winId, itemId);              // box moved/resized — no DOM rebuild
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
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => drawEdges()).observe(canvas.parentElement);

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
  // flagged tell shows "⊙tell" + its align; a locating tell shows "loc" + align. After a
  // read, a tell/field-tell box also shows ✓/✗ for whether it passed.
  for (const f of it.fields || []) {
    const al = f.align || it.align || "center";
    const label = `${f.id}${f.tell ? ` ⊙tell·${al}${mark(f.id)}` : ""}`;
    boxes.push({ id: f.id, label, role: "field", field: f.field, ...ent.win2cut(ent.rel2win(f.box)) });
  }
  // static grid tiles rows from the cell — OCR row-location is unused, so don't advertise "loc"
  const staticOn = model.window(winId)?.static_grid !== false;
  for (const t of it.tells || []) {
    const al = t.align || it.align || "center";
    const label = `${t.id}${(t.locate && !staticOn) ? ` loc·${al}` : ""}${mark(t.id)}`;
    boxes.push({ id: t.id, label, role: t.kind === "text" ? "detect" : "scrollbar", ...ent.win2cut(ent.rel2win(t.box)) });
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
  if (out && !out.innerHTML) out.innerHTML = "reading…";
  const done = timed(`item read ${key}`);
  try {
    const res = await api.itemRead(previewProfileFor(winId), model.profile.name, winId, itemId);
    itemReads.set(key, res);
    refreshItemBoxes(winId, itemId);
    if (out) out.innerHTML = itemReadout(res, winId, itemId);
    done(`· ${res.device || "?"} · ${res.valid ? "valid" : "rejected"}`, "ok", res.ms);
  } catch (e) {
    done(String(e.message || e), "err");
    if (out) out.innerHTML = `<span class="tc-bad">${esc(String(e.message || e))}</span>`;
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
  const status = res.valid ? '<span class="tc-ok">✓ valid</span>' : '<span class="tc-bad">✗ rejected</span>';
  const row = (label, valueHtml) => `<span class="ir-k">${label}</span><span class="ir-c">:</span><span class="ir-v">${valueHtml}</span>`;
  const fields = Object.entries(res.fields || {}).map(([k, v]) => {
    const cls = v.substituted ? "conf-sub" : v.confidence >= 0.8 ? "conf-ok" : v.confidence >= 0.5 ? "conf-warn" : "conf-bad";
    return row(esc(k), `<b class="${cls}">${esc(String(v.value ?? "∅"))}</b>`);
  }).join("");
  const kv = keyPrevHTML(winId, itemId);   // the record key this read would store under
  const key = kv ? row("key", kv) : "";
  // each tell is its OWN readout row (id : ✓/✗ score) so it aligns in the same columns as the
  // fields, instead of a separate full-width chip band.
  const tells = (res.tells || []).map((t) => {
    const thr = t.threshold == null ? "" : `<span class="muted">/${esc(String(t.threshold))}</span>`;
    const title = t.detail ? ` title="${esc(t.detail)}"` : "";
    return row(`<span${title}>${esc(t.id)}</span>`, `<span class="${t.pass ? "tc-ok" : "tc-bad"}">${t.pass ? "✓" : "✗"} ${esc(String(t.score))}${thr}</span>`);
  }).join("");
  return `<div class="ir-row">${status}</div>${fields}${key}${tells}`;
}

function selectRegionNode(winId, boxId) {
  const ids = [`reg:${winId}:${boxId}`, `det:${winId}:${boxId}`, `st:${winId}:${boxId}`, `sb:${winId}:${boxId}`];
  selectedNodeId = ids.find((id) => nodeEls.has(id)) || null;
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
  if (!live) host.innerHTML = `<p class="muted" style="padding:8px">reading…</p>`;
  const done = timed(`OCR preview ${winId}`);
  try {
    const cap = live ? null : await curCapOf(winId);   // the page on screen (live grabs fresh)
    const res = await api.preview(previewProfileFor(winId), model.profile.name, cap);
    host.innerHTML = previewTable(res.cells);
    setGridFromPreview(winId, res);   // same OCR pass drives the dashed grid
    done(`· ${res.device || "?"} · ${(res.cells || []).length} cells`, "ok", res.ms);
  } catch (e) {
    done(String(e.message || e), "err");
    host.innerHTML = `<p class="muted" style="padding:8px">${esc(String(e.message || e))}</p>`;
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
  const host = prevHost(winId);
  const list = await capListOf(winId);
  if (!list.length) { setStatus("no images bound to this window"); return; }
  if (btn) { btn.disabled = true; btn.classList.add("reading"); }
  if (host) host.innerHTML = `<p class="muted" style="padding:8px">reading ${list.length} image${list.length === 1 ? "" : "s"}…</p>`;
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
    if (host) host.innerHTML = previewTable(cells);
    done(`· ${list.length} images · ${cells.length} cells`, "ok", srvMs);
  } catch (e) {
    done(String(e.message || e), "err");
    if (host) host.innerHTML = `<p class="muted" style="padding:8px">${esc(String(e.message || e))}</p>`;
  } finally {
    if (btn) { btn.disabled = false; btn.classList.remove("reading"); }
  }
}

function tellChip(t) {
  // one tell's outcome: "id score/threshold" tinted by pass/fail
  const thr = t.threshold == null ? "" : `<span class="muted">/${t.threshold}</span>`;
  const title = t.detail ? ` title="${esc(t.detail)}"` : "";
  return `<span class="tell-chip ${t.pass ? "tc-ok" : "tc-bad"}"${title}>${esc(t.id)} ${t.score}${thr}</span>`;
}

// "empty" -> "if empty", "if_number" -> "if number" — the badge shown instead of a
// confidence % when a configured fallback produced the value (config, not a read)
const subLabel = (r) => `if ${String(r).replace(/^if_/, "").replace(/_/g, " ")}`;

function previewCell(v) {
  if (!v) return "<td>—</td>";
  if (v.substituted) {
    return `<td class="conf-sub" title="${esc(v.raw || "(empty)")} → ${subLabel(v.substituted)}">${esc(v.value ?? "∅")}</td>`;
  }
  const cls = v.confidence >= 0.8 ? "conf-ok" : v.confidence >= 0.5 ? "conf-warn" : "conf-bad";
  return `<td class="${cls}" title="${esc(v.raw || "")}">${esc(v.value ?? "∅")}</td>`;
}

// Render rows, inserting a separator <tr> whenever the source image (`_img`, set by
// previewAll) changes — never before the first group. Rows without `_img` (the normal
// single-image preview) all share one group, so no separators appear.
function sepRows(cells, cols, rowHtml) {
  let prev;
  return cells.map((c) => {
    const sep = c._img !== undefined && prev !== undefined && c._img !== prev
      ? `<tr class="prev-sep"><td colspan="${cols}"></td></tr>` : "";
    prev = c._img;
    return sep + rowHtml(c);
  }).join("");
}

function previewTable(cells) {
  const all = cells || [];
  const hasItems = all.some((c) => Array.isArray(c.tells));
  if (!hasItems) {
    const kept = all.filter(cellKept);
    if (!kept.length) return `<p class="muted" style="padding:8px">0 rows</p>`;
    const fieldIds = [...new Set(kept.flatMap((c) => Object.keys(c.fields)))];
    const head = fieldIds.map((f) => `<th>${esc(f)}</th>`).join("");
    const rows = sepRows(kept.slice(0, 200), fieldIds.length,
      (c) => `<tr>${fieldIds.map((f) => previewCell(c.fields[f])).join("")}</tr>`);
    return `<div class="prev-count muted">${kept.length} row${kept.length === 1 ? "" : "s"}</div>
      <table class="grid-table"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
  }

  // item-template diagnostics: show EVERY cell that read something (so rejected arcanes
  // are visible), with its template, status, reject reason, and per-tell scores.
  const read = all.filter((c) => Object.values(c.fields).some((f) => f && f.value !== null && f.value !== "" && f.value !== undefined));
  if (!read.length) return `<p class="muted" style="padding:8px">0 cells read any data</p>`;
  // group by source image first (so preview-all keeps each image's rows together + ruled),
  // then valid-first within each image; single-image previews have one group → unchanged.
  read.sort((a, b) => ((a._img || 0) - (b._img || 0)) || (b.valid === true) - (a.valid === true));
  const fieldIds = [...new Set(read.flatMap((c) => Object.keys(c.fields)))];
  const head = `<th></th><th>item</th>${fieldIds.map((f) => `<th>${esc(f)}</th>`).join("")}<th>tells</th><th>reason</th>`;
  const rows = sepRows(read.slice(0, 300), fieldIds.length + 4, (c) => {
    const status = c.valid ? '<span class="tc-ok">✓</span>'
      : c.tells_pass ? '<span class="tc-warn">◌</span>' : '<span class="tc-bad">✗</span>';
    const fcols = fieldIds.map((f) => previewCell(c.fields[f])).join("");
    const tells = (c.tells || []).map(tellChip).join(" ");
    return `<tr class="${c.valid ? "" : "prev-rej"}"><td>${status}</td><td>${esc(c.item || "")}</td>${fcols}<td>${tells}</td><td class="muted">${esc(c.reason || "")}</td></tr>`;
  });
  const nValid = read.filter((c) => c.valid).length;
  return `<div class="prev-count muted">${nValid} kept · ${read.length} read · ✓ kept, ◌ tells pass but lost overlap, ✗ tell failed</div>
    <table class="grid-table"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
}

async function prefillDetectText(winId, detectId) {
  try {
    const cap = await curCapOf(winId);
    const res = await api.detect(previewProfileFor(winId), model.profile.name, cap);
    const info = res.detect?.[detectId];
    const a = model.detect(winId, detectId);
    if (a && !a.text && info && info.read && info.read !== "(template)") {
      a.text = info.read;
      render(); autosave(true, winId);   // re-detect only this window
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
  // spinner on every node whose value this detect refreshes
  const ids = [`win:${winId}`, ...model.detects(winId).map((a) => `det:${winId}:${a.id}`)];
  if (model.scrollbar(winId)) ids.push(`sb:${winId}:scrollbar`);
  const done = timed(`detect ${winId}`);
  try {
    await withBusy(ids, async () => {
      try {
        const cap = live ? null : await curCapOf(winId);   // the page on screen (live grabs fresh)
        const res = await api.detect(previewProfileFor(winId), model.profile.name, cap);
        const dstatus = {};   // mirror onto the window canvas: colour/tint each detect box by its verdict
        for (const [aid, info] of Object.entries(res.detect || {})) { setDetectStatus(`det:${winId}:${aid}`, info); dstatus[aid] = info; }
        for (const [sid, info] of Object.entries(res.states || {})) setDetectStatus(`st:${winId}:${sid}`, info);
        setWindowDetectStatus(winId, res);   // window node's detects section: per-row + overall verdict
        const dent = imageCanvases.get(winId);
        if (dent) dent.overlay.setDetectStatus(dstatus);
        if (live) {   // is this window currently recognised on screen? (drives the live panel dot)
          const svals = Object.values(res.states || {});
          // mode/negate-aware window verdict comes from the server; states (when present) still win
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
        done(`· ${res.device || "?"}`, "ok", res.ms);
      } catch (e) { done(String(e.message || e), "err"); }
    });
  } finally {
    detectBusy.delete(winId);
    if (detectAgain.has(winId)) { const lv = detectAgain.get(winId); detectAgain.delete(winId); refreshDetect(winId, lv); }
  }
}
function setDetectStatus(nodeId, info) {
  const el = nodeEls.get(nodeId);
  const span = el && el.querySelector(".detect-status");
  if (!span) return;
  const conf = info.score != null
    ? ` (${Math.round(info.score * 100)}%${info.threshold != null ? `/${Math.round(info.threshold * 100)}%` : ""})`
    : "";
  span.textContent = (info.matched ? "✓ true" : "✗ false") + conf + (info.read ? ` — "${info.read}"` : "");
  span.className = "detect-status " + (info.matched ? "conf-ok" : "conf-bad");
}

// Fill the window node's detects section live, reconciling in place (the rows are built once
// in windowDetects; this only updates textContent/class/title, never rebuilds — see hard rule 1).
// Each `.wd-status` is coloured by PASS (negate-aware), with the raw landmark match in its title;
// `.wd-verdict` shows whether the whole window would match under its combine mode.
function setWindowDetectStatus(winId, res) {
  const el = nodeEls.get(`win:${winId}`);
  if (!el) return;
  const det = res.detect || {};
  // skip the header row's "live" label (no data-id) — only the per-detector status spans
  for (const span of el.querySelectorAll(".wd-row:not(.wd-head) .wd-status")) {
    const info = det[span.dataset.id];
    if (!info) { span.textContent = ""; span.className = "wd-status muted"; continue; }
    const pass = info.passes != null ? info.passes : info.matched;
    span.textContent = pass ? "✓" : "✗";   // bare verdict; score/read live on the detect node
    span.className = "wd-status " + (pass ? "conf-ok" : "conf-bad");
    span.title = `landmark ${info.matched ? "found" : "absent"}, ${info.negate ? "must be absent" : "must be present"} → ${pass ? "passes" : "fails"}`;
  }
  const verdict = el.querySelector(".wd-verdict");
  if (verdict) {
    const w = res.window;
    if (!w) { verdict.textContent = ""; verdict.className = "wd-verdict muted"; return; }
    verdict.textContent = w.pass ? "✓ would match this window" : "✗ would not match";
    verdict.className = "wd-verdict " + (w.pass ? "conf-ok" : "conf-bad");
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
  setNodeBusy(`win:${winId}`, true);   // capturing/fetching the image
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
  } catch (e) { done(String(e.message || e), "err"); setStatus(String(e.message || e)); setNodeBusy(`win:${winId}`, false); return; }
  if (!url) {   // this page has no bound image — show a blank canvas (no live grab) + the empty nav
    done();
    setNodeBusy(`win:${winId}`, false);
    entry.overlay.setImage(null);
    refreshImageBoxes(winId);
    updateImageLabel(winId);
    drawEdges();
    return;
  }
  const img = new Image();
  img.onload = () => {
    done();
    setNodeBusy(`win:${winId}`, false);
    // keep the canvas area at the image aspect ratio so resizing always fits
    entry.canvas.parentElement.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
    entry.overlay.setImage(img);
    refreshImageBoxes(winId);
    drawEdges();
    updateImageLabel(winId);     // button shows the (possibly new) filename
    // the image changed (recapture / picked a capture / first open) → READ it: full preview
    // when the node exists, else just the grid overlay. No first-manual-read gate.
    if (prevHost(winId)) refreshPreview(winId, false);
    else refreshGridPreview(winId);
    refreshDetect(winId);   // re-evaluate detectors against the new image
  };
  img.onerror = () => setNodeBusy(`win:${winId}`, false);
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
  for (const r of model.regions(winId)) boxes.push({ id: r.id, role: "region", field: r.field, ...r.box });
  for (const a of model.detects(winId)) boxes.push({ id: a.id, role: "detect", ...a.search });
  // item template box is NOT drawn here — it's the authored cell at one spot, which
  // isn't where detection actually reads; the live grid (below) shows the real cells
  const sb = model.scrollbar(winId);
  if (sb) boxes.push({ id: "scrollbar", role: "scrollbar", ...sb });
  entry.overlay.setBoxes(boxes);
  entry.overlay.setGridGuides(buildGridGuides(winId));   // columns + locator scan strips
  // prefer the live-detected grid (rows found in the actual capture); fall back to
  // the live-detected grid (where items were actually located this capture)
  entry.overlay.setCellBoxes(gridCellBoxes.get(winId) || []);   // detected cell tiling (solid)
  entry.overlay.setGridPreview(gridPreviews.get(winId) || staticFieldPreview(winId) || []);
  entry.overlay.setPreview(gridReads.get(winId) || []);   // value + confidence per cell
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
    for (const it of items) {
      const iw = it.box.w;
      const ncols = Math.max(1, Math.round(da.w / iw)), pitch = da.w / ncols;
      for (let c = 0; c <= ncols; c++) cols.add(da.x + c * pitch);
      const loc = itemLocatorBox(it);   // located: show where the locator scans
      if (loc) for (let c = 0; c < ncols; c++)
        strips.push({ x: da.x + c * pitch + loc.x * iw, y: da.y, w: loc.w * iw, h: da.h });
    }
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
function setGridFromPreview(winId, res) {
  if (!res || !res.cells) return;
  const kept = res.cells.filter(cellKept);
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
  // the detected CELL outlines — the tiling the reader actually found
  const cells = kept.map((c) => c.box).filter(Boolean);
  if (boxes.length) gridPreviews.set(winId, boxes); else gridPreviews.delete(winId);
  if (reads.length) gridReads.set(winId, reads); else gridReads.delete(winId);
  if (cells.length) gridCellBoxes.set(winId, cells); else gridCellBoxes.delete(winId);
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
