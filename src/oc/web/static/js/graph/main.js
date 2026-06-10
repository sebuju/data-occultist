// Node-view home: edit a game's structure as a graph (Game → Windows → Fields →
// Datasets), drag to arrange, drag-wire a window to a dataset, edit inline, and
// watch live dataset counts. Box drawing stays on the canvas (teach.html link).
import * as api from "../api.js";
import { esc } from "../dom.js";
import { openModal } from "../modal.js";
import { Overlay } from "../overlay.js";
import { GraphModel } from "./model.js";

const $ = (id) => document.getElementById(id);
const setStatus = (m) => { $("status").textContent = m; };
const model = new GraphModel();
const pos = new Map();            // node id -> {x,y}
const nodeEls = new Map();        // node id -> DOM element (built once, reused)
const collapsed = new Set();      // collapsed node ids
const view = { panX: 0, panY: 0, zoom: 1 };  // canvas pan/zoom
const COLX = { game: 20, window: 300, region: 600, anchor: 600, state: 600, scrollbar: 600, dataset: 900 };
let live = {};                    // dataset -> {present,total,last_op,last_ts}
const prevPresent = {};
let timer = null;
let wire = null;                  // active drag-wire {winId, x1,y1}
let selectedNodeId = null;        // node whose line(s) are highlighted
const imageCanvases = new Map();  // winId -> { wrap, overlay, canvas } (drawing surface)
const itemCanvases = new Map();   // `winId:itemId` -> { host, canvas, overlay, + coord maps }

// Central registry of EVERY drawing overlay, so selection, deselection, and box
// hotkeys are handled in ONE place — any new overlay just registers here and gets
// cross-deselect + WASD for free. rec = { overlay, kind, winId, itemId?, persist(box), refresh() }.
const overlays = new Map();
let activeOverlayKey = null;        // which overlay holds the live box selection

function registerOverlay(key, rec) { overlays.set(key, { key, ...rec }); }
function unregisterOverlay(key) { overlays.delete(key); if (activeOverlayKey === key) activeOverlayKey = null; }

// THE selection chokepoint: an overlay reports it selected `id` (or null). Deselect
// every other overlay so only one box is ever active across the whole editor.
function overlaySelected(key, id) {
  activeOverlayKey = id ? key : (activeOverlayKey === key ? null : activeOverlayKey);
  for (const [k, rec] of overlays) if (k !== key) rec.overlay.setActive(null);
  const rec = overlays.get(key);
  if (rec && rec.kind === "window" && id) selectRegionNode(rec.winId, id);   // highlight its node
  else { selectedNodeId = null; for (const [, el] of nodeEls) el.classList.remove("selected"); drawEdges(); }
}

// Select a window box from its NODE (routes through the chokepoint so other
// overlays deselect and WASD targets it).
function selectWindowBox(winId, boxId) {
  const e = imageCanvases.get(winId);
  if (e) e.overlay.setActive(boxId);
  overlaySelected(`win:${winId}`, boxId);
}
const previewPanels = new Map();  // winId -> { wrap, body } (live OCR preview)
// Panels are positioned like nodes: pos has `img:<win>` / `prev:<win>` entries.
const openImages = new Set();     // winIds whose image panel is open (persisted)
const openPreviews = new Set();   // winIds whose preview panel is open (persisted)
const panelSizes = new Map();     // `img:<win>` / `prev:<win>` -> {w,h} (persisted)
let pendingOpenImages = [];
let pendingOpenPreviews = [];
const busy = new Map();            // node id -> active-work count (drives the spinner)
const gridPreviews = new Map();    // winId -> live-detected field boxes (dashed grid)
const gridReads = new Map();        // winId -> per-cell read values {x,y,w,h,text,confidence}

// Show/hide a node's spinner via a ref count, so overlapping async tasks behave.
function setNodeBusy(nodeId, on) {
  const n = (busy.get(nodeId) || 0) + (on ? 1 : -1);
  if (n <= 0) busy.delete(nodeId); else busy.set(nodeId, n);
  nodeEls.get(nodeId)?.classList.toggle("busy", (busy.get(nodeId) || 0) > 0);
}
// Run an async task while showing spinners on the given node ids.
async function withBusy(ids, fn) {
  ids.forEach((id) => setNodeBusy(id, true));
  try { return await fn(); }
  finally { ids.forEach((id) => setNodeBusy(id, false)); }
}

// ---- autosave + position persistence --------------------------------------

let saveT = null;
function autosave() {
  if (!model.profile.name) return;
  clearTimeout(saveT);
  saveT = setTimeout(async () => {
    try { await api.saveProfile(model.profile, false); setStatus("saved ✓"); }  // full replace (graph is complete)
    catch (e) { setStatus(String(e.message || e)); }
  }, 400);
  refreshOpenPreviews();   // update any open preview nodes after edits
  refreshOpenDetect();     // update detector/state true-false after edits
  pushHistory();           // record this change for undo/redo
}

// ---- undo / redo (full history of the profile) -----------------------------

let history = [];
let hIndex = -1;
let restoring = false;
function snapState() { return JSON.stringify(model.profile); }
function pushHistory() {
  if (restoring) return;
  const s = snapState();
  if (hIndex >= 0 && history[hIndex] === s) return;   // no change
  history = history.slice(0, hIndex + 1);
  history.push(s);
  if (history.length > 200) history.shift();
  hIndex = history.length - 1;
}
function resetHistory() { history = [snapState()]; hIndex = 0; }
function applyHistory() {
  restoring = true;
  model.load(JSON.parse(history[hIndex]));
  render();
  for (const winId of imageCanvases.keys()) { refreshImageBoxes(winId); refreshDetect(winId); }
  api.saveProfile(model.profile, false).catch(() => {});
  restoring = false;
}
function undo() { if (hIndex > 0) { hIndex--; applyHistory(); setStatus("undo"); } }
function redo() { if (hIndex < history.length - 1) { hIndex++; applyHistory(); setStatus("redo"); } }
// Carry a node's position (and collapse state) to its new id after a rename, so
// it doesn't jump to a fresh slot.
function movePos(oldId, newId) {
  if (oldId === newId) return;
  if (pos.has(oldId)) { pos.set(newId, pos.get(oldId)); pos.delete(oldId); }
  if (collapsed.has(oldId)) { collapsed.delete(oldId); collapsed.add(newId); }
}

function posKey() { return `oc.graph.${model.profile.name}`; }
function loadPositions() {
  try {
    const raw = JSON.parse(localStorage.getItem(posKey()) || "{}");
    for (const k in (raw.positions || {})) {
      const p = raw.positions[k];
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) pos.set(k, p);  // skip NaN/null
    }
    (raw.collapsed || []).forEach((id) => collapsed.add(id));
    pendingOpenImages = raw.openImages || [];
    pendingOpenPreviews = raw.openPreviews || [];
    for (const k in (raw.panelSizes || {})) panelSizes.set(k, raw.panelSizes[k]);
    if (raw.view && Number.isFinite(raw.view.zoom)) Object.assign(view, raw.view);
  } catch { /* ignore */ }
}
function savePositions() {
  try {
    localStorage.setItem(posKey(), JSON.stringify({
      positions: Object.fromEntries(pos), collapsed: [...collapsed],
      openImages: [...openImages], openPreviews: [...openPreviews],
      panelSizes: Object.fromEntries(panelSizes), view,
    }));
  } catch { /* ignore */ }
}

const TYPES = [["text", "text"], ["number", "number"], ["pips", "pips"], ["diamonds", "diamonds (rank)"]];
const EXTRACTS = ["whole", "number", "number_before", "number_after", "text_before", "text_after"];
const NEEDS_SEP = new Set(["number_before", "number_after", "text_before", "text_after"]);

// ---- layout ---------------------------------------------------------------

function elForPos(id) {
  if (id.startsWith("prev:")) return previewPanels.get(id.slice(5))?.wrap;
  return nodeEls.get(id);   // image canvas lives inside its window node now
}

function ensurePositions() {
  // stack new nodes below the actual bottom of existing nodes AND panels in the same
  // column (panels are tall), so a new node never lands behind one.
  const colBottom = {};
  for (const [id, p] of pos) {
    if (!Number.isFinite(p.x)) continue;
    const k = Math.round(p.x);
    const h = (elForPos(id)?.offsetHeight) || 140;
    colBottom[k] = Math.max(colBottom[k] || 20, p.y + h + 18);
  }
  for (const n of model.nodes()) {
    if (pos.has(n.id)) continue;
    const x = COLX[n.type] ?? 300;
    const y = colBottom[x] || 20;
    pos.set(n.id, { x, y });
    colBottom[x] = y + 150 + 18;   // estimate height for the next one (not in DOM yet)
  }
}

// ---- render ---------------------------------------------------------------

function windowControls(w, keyOpts) {
  // rows/cols/strides are gone — item templates locate cells by content now, not a
  // fixed grid. Only dedup config + the image/delete actions remain.
  return `<div class="muted">→ ${esc(model.datasetOf(w))}</div>
    <label class="flab">key field <select class="wset" data-k="dedup">${keyOpts}</select></label>
    <div class="gn-foot"><button class="imgbtn">📷 image</button><button class="delwin danger">×</button></div>`;
}

// The tells + fields list shown under an item node's cutout canvas. Item fields
// carry the SAME per-field config as the old region nodes (type/extract/sep/learn/
// fuzzy/empty/pips) — edited here against the window's FieldDef.
function itemLists(it, w) {
  const fieldDef = (fid) => (w.fields || []).find((x) => x.id === fid) || { type: "text", extract: "whole", learn: false, fuzzy: 0.82 };
  const tells = (it.tells || []).map((t) => `<div class="ti-row" data-tid="${t.id}">
      <span class="ti-kind">${esc(t.kind)}</span>
      <label class="ti-loc" title="use to locate rows"><input type="radio" name="loc-${esc(it.id)}" class="iset" data-k="locate" data-tid="${t.id}" ${t.locate ? "checked" : ""}/>loc</label>
      ${t.kind === "text" ? `<select class="iset" data-k="field" data-tid="${t.id}">${(it.fields || []).map((f) => `<option ${t.field === f.field ? "selected" : ""}>${esc(f.field)}</option>`).join("")}</select>` : ""}
      ${t.kind === "color" ? `<input type="color" class="iset" data-k="color" data-tid="${t.id}" value="${t.color || "#ffcc00"}"/>` : ""}
      ${t.locate ? `<select class="iset" data-k="align" data-tid="${t.id}" title="anchor on this line of a wrapped name">${["none", "top", "center", "bottom"].map((v) => `<option ${(t.align || it.align || "center") === v ? "selected" : ""}>${v}</option>`).join("")}</select>` : ""}
      <input type="number" class="iset" data-k="threshold" data-tid="${t.id}" step="0.05" min="0" max="1" value="${t.threshold ?? 0.5}" title="threshold"/>
      <button class="ti-del danger" data-tid="${t.id}">×</button></div>`).join("");
  const fields = (it.fields || []).map((f) => {
    const fd = fieldDef(f.field);
    const types = TYPES.map(([v, t]) => `<option value="${v}" ${fd.type === v ? "selected" : ""}>${t}</option>`).join("");
    const exs = EXTRACTS.map((v) => `<option ${(fd.extract || "whole") === v ? "selected" : ""}>${v}</option>`).join("");
    const pips = fd.type === "pips" || fd.type === "diamonds";
    return `<div class="if-row" data-fid="${f.id}">
      <div class="if-head"><input class="iset-fid" data-fid="${f.id}" value="${esc(f.id)}"/><button class="if-del danger" data-fid="${f.id}">×</button></div>
      <label class="flab">type <select class="ffset" data-fid="${f.id}" data-k="type">${types}</select></label>
      ${pips ? "" : `<label class="flab">extract <select class="ffset" data-fid="${f.id}" data-k="extract">${exs}</select></label>`}
      ${(!pips && NEEDS_SEP.has(fd.extract)) ? `<label class="flab">separator <input class="ffset" type="text" data-fid="${f.id}" data-k="sep" value="${esc(fd.separator || "/")}"/></label>` : ""}
      <label class="flab">learn <input type="checkbox" class="ffset" data-fid="${f.id}" data-k="learn" ${fd.learn ? "checked" : ""}/></label>
      <label class="flab" title="require this field to read something — it doubles as a tell">tell <input type="checkbox" class="itell" data-fid="${f.id}" ${f.tell ? "checked" : ""}/></label>
      ${f.tell ? `<label class="flab" title="minimum OCR confidence the read must reach (0 = any)">tell conf <input type="number" class="itellconf" data-fid="${f.id}" step="0.05" min="0" max="1" value="${f.tell_conf ?? 0}"/></label>` : ""}
      ${f.tell ? `<label class="flab" title="if this field locates rows: which line of a wrapped name to anchor on">align <select class="itellalign" data-fid="${f.id}">${["none", "top", "center", "bottom"].map((v) => `<option ${(f.align || it.align || "center") === v ? "selected" : ""}>${v}</option>`).join("")}</select></label>` : ""}
      <label class="flab">fuzzy <input type="number" class="ffset" data-fid="${f.id}" data-k="fuzzy" step="0.05" min="0" max="1" value="${fd.fuzzy ?? 0.82}"/></label>
      <label class="flab">if empty <input class="ffset" data-fid="${f.id}" data-k="empty" value="${esc(fd.empty || "")}" placeholder="(blank)"/></label>
    </div>`;
  }).join("");
  return `<label class="flab" title="when templates overlap the same tile, higher priority wins">priority <input type="number" class="iprio" step="1" value="${it.priority || 0}"></label>
    <div class="muted il-h">tells</div>${tells || '<div class="muted">draw a tell on the cutout</div>'}
    <div class="muted il-h">fields</div>${fields || '<div class="muted">draw a field on the cutout</div>'}
    <div class="gn-foot"><button class="delitem danger">remove item</button></div>`;
}

// Wire an item node's id + tells/fields lists (rebuildNode re-binds these,
// preserving the live cutout canvas).
function wireItemControls(div, n) {
  const winId = n.win.id, itemId = n.ref.id;
  div.querySelector(".gi-id").addEventListener("change", (e) => { model.renameItem(winId, itemId, e.target.value.trim()); render(); autosave(); });
  div.querySelectorAll(".iset").forEach((inp) => inp.addEventListener("change", (e) => {
    const tid = e.target.dataset.tid, k = e.target.dataset.k;
    let v = e.target.value;
    if (k === "locate") { for (const t of n.ref.tells) t.locate = false; v = e.target.checked; }
    else if (k === "threshold") v = +e.target.value || 0;
    model.setItemTellProp(winId, itemId, tid, k, v);
    if (k === "locate") rebuildNode(n.id);   // show/hide the per-tell align dropdown
    gridPreviews.delete(winId); gridReads.delete(winId); refreshImageBoxes(winId); autosave();
  }));
  // persist the field a text tell's dropdown is SHOWING (the default option never
  // fires a change, so it'd otherwise stay unset and reject every row)
  div.querySelectorAll('.iset[data-k="field"]').forEach((sel) => {
    const t = model.itemTell(winId, itemId, sel.dataset.tid);
    if (t && !t.field && sel.value) { t.field = sel.value; autosave(); }
  });
  div.querySelectorAll(".ti-del").forEach((b) => b.addEventListener("click", () => {
    model.removeItemTell(winId, itemId, b.dataset.tid);
    refreshItemBoxes(winId, itemId); rebuildNode(n.id); gridPreviews.delete(winId); gridReads.delete(winId); autosave();
  }));
  div.querySelectorAll(".iset-fid").forEach((inp) => inp.addEventListener("change", (e) => {
    model.renameItemField(winId, itemId, e.target.dataset.fid, e.target.value.trim());
    refreshItemBoxes(winId, itemId); rebuildNode(n.id); gridPreviews.delete(winId); gridReads.delete(winId); autosave();
  }));
  // per-field config (same as the old region node): edits the window FieldDef
  div.querySelectorAll(".ffset").forEach((inp) => inp.addEventListener("change", (e) => {
    const f = model.itemField(winId, itemId, e.target.dataset.fid);
    const fd = f && (n.win.fields || []).find((x) => x.id === f.field);
    if (!fd) return;
    const k = e.target.dataset.k;
    if (k === "type") { fd.type = e.target.value; rebuildNode(n.id); }       // toggles extract/sep/pips
    else if (k === "extract") { fd.extract = e.target.value; rebuildNode(n.id); }  // toggles separator
    else if (k === "sep") fd.separator = e.target.value || "/";
    else if (k === "learn") fd.learn = e.target.checked;
    else if (k === "fuzzy") fd.fuzzy = +e.target.value;
    else if (k === "empty") fd.empty = e.target.value || null;
    gridPreviews.delete(winId); gridReads.delete(winId); autosave();
  }));
  div.querySelectorAll(".if-del").forEach((b) => b.addEventListener("click", () => {
    model.removeItemField(winId, itemId, b.dataset.fid);
    refreshItemBoxes(winId, itemId); rebuildNode(n.id); gridPreviews.delete(winId); gridReads.delete(winId); autosave();
  }));
  div.querySelectorAll(".itell").forEach((inp) => inp.addEventListener("change", (e) => {
    model.setItemFieldTell(winId, itemId, e.target.dataset.fid, e.target.checked);
    rebuildNode(n.id);   // show/hide the tell-conf input
    gridPreviews.delete(winId); gridReads.delete(winId); autosave();
  }));
  div.querySelectorAll(".itellconf").forEach((inp) => inp.addEventListener("change", (e) => {
    model.setItemFieldTellConf(winId, itemId, e.target.dataset.fid, +e.target.value || 0);
    gridPreviews.delete(winId); gridReads.delete(winId); autosave();
  }));
  div.querySelectorAll(".itellalign").forEach((sel) => sel.addEventListener("change", (e) => {
    model.setItemFieldAlign(winId, itemId, e.target.dataset.fid, e.target.value);
    gridPreviews.delete(winId); gridReads.delete(winId); refreshImageBoxes(winId); autosave();
  }));
  const prio = div.querySelector(".iprio");
  if (prio) prio.addEventListener("change", (e) => {
    model.setItemPriority(winId, itemId, parseInt(e.target.value, 10) || 0);
    gridPreviews.delete(winId); gridReads.delete(winId); refreshImageBoxes(winId); autosave();
  });
  div.querySelector(".delitem").addEventListener("click", () => {
    closeItemImage(winId, itemId); model.removeItem(winId, itemId); pos.delete(n.id);
    gridPreviews.delete(winId); gridReads.delete(winId); render(); refreshImageBoxes(winId); autosave();
  });
  // Click a tell/field row to SELECT its box on the cutout — the only way to reach a
  // box that's drawn under another. Routes through the chokepoint (highlights it,
  // deselects others, enables WASD).
  const selectItemBox = (boxId, row) => {
    const ent = itemCanvases.get(`${winId}:${itemId}`);
    if (ent) ent.overlay.setActive(boxId);
    overlaySelected(`item:${winId}:${itemId}`, boxId);
    div.querySelectorAll(".ti-row,.if-row").forEach((r) => r.classList.remove("il-sel"));
    row.classList.add("il-sel");
  };
  div.querySelectorAll(".ti-row").forEach((row) => row.addEventListener("mousedown", (ev) => {
    if (ev.target.closest("input,select,button,label")) return;
    selectItemBox(row.dataset.tid, row);
  }));
  div.querySelectorAll(".if-row").forEach((row) => row.addEventListener("mousedown", (ev) => {
    if (ev.target.closest("input,select,button")) return;
    selectItemBox(row.dataset.fid, row);
  }));
}

// Wire the window node's controls (extracted so rebuildNode can re-bind them
// without recreating the node — which would destroy the embedded image canvas).
function wireWindowControls(div, n) {
  div.querySelector(".gi-id").addEventListener("change", (e) => { model.renameWindow(n.ref.id, e.target.value.trim()); render(); autosave(); });
  div.querySelector(".imgbtn").addEventListener("click", () => openCaptureModal(n.ref.id));
  updateImageLabel(n.ref.id, div.querySelector(".imgbtn"));   // show the bound filename
  div.querySelectorAll(".wset").forEach((inp) => inp.addEventListener("change", (e) => {
    const k = e.target.dataset.k;
    if (k === "dedup") n.ref.dedup_field = e.target.value;
    autosave();
    gridPreviews.delete(n.ref.id); gridReads.delete(n.ref.id);
    refreshImageBoxes(n.ref.id);
  }));
  div.querySelector(".delwin").addEventListener("click", () => { closeImage(n.ref.id); model.removeWindow(n.ref.id); pos.delete(n.id); render(); autosave(); });
}

function nodeParts(n) {
  if (n.type === "game") {
    const g = n.ref;
    return { title: "🎮 game", body: `
      <label class="glab">name <input class="gi" data-k="name" value="${esc(g.name)}" /></label>
      <label class="glab">process names <input class="gi" data-k="proc" value="${esc((g.process_names || []).join(", "))}" placeholder="Warframe.x64.exe" /></label>
      <label class="glab">window title hint <input class="gi" data-k="title" value="${esc(g.window_title_hint || "")}" placeholder="Warframe" /></label>
      <div class="gn-row"><input class="newwin" placeholder="new window id" /><button class="addwin">+ window</button></div>` };
  }
  if (n.type === "window") {
    const w = n.ref;
    const fids = [...new Set([...(w.fields || []).map((f) => f.id), ...(w.regions || []).map((r) => r.field)])].filter(Boolean);
    const key = w.dedup_field || "name";
    const keyOpts = (fids.length ? fids : [key]).map((f) => `<option ${f === key ? "selected" : ""}>${esc(f)}</option>`).join("");
    return {
      title: `<input class="gi gi-id" data-k="winid" value="${esc(w.id)}" />`,
      body: `<div class="win-controls">${windowControls(w, keyOpts)}</div><div class="win-img"></div>`,
      ports: `<span class="port out" title="drag to a dataset"></span>`,
    };
  }
  if (n.type === "region") {
    const f = n.field || { type: "text", extract: "whole", learn: false, fuzzy: 0.82 };
    const types = TYPES.map(([v, t]) => `<option value="${v}" ${f.type === v ? "selected" : ""}>${t}</option>`).join("");
    const exs = EXTRACTS.map((v) => `<option ${(f.extract || "whole") === v ? "selected" : ""}>${v}</option>`).join("");
    const pips = f.type === "pips" || f.type === "diamonds";
    return {
      title: `<input class="gi gi-id" data-k="regid" value="${esc(n.ref.id)}" title="region / field id" />`,
      body: `<label class="flab">type <select class="fset" data-k="type">${types}</select></label>
        ${pips ? "" : `<label class="flab">extract <select class="fset" data-k="extract">${exs}</select></label>`}
        ${(!pips && NEEDS_SEP.has(f.extract)) ? `<label class="flab">separator <input class="fset" type="text" data-k="sep" value="${esc(f.separator || "/")}" /></label>` : ""}
        <label class="flab">learn <input type="checkbox" class="fset" data-k="learn" ${f.learn ? "checked" : ""}/></label>
        <label class="flab">fuzzy <input type="number" class="fset" data-k="fuzzy" step="0.05" min="0" max="1" value="${f.fuzzy ?? 0.82}"/></label>
        <label class="flab">if empty <input class="fset" data-k="empty" value="${esc(f.empty || "")}" placeholder="(blank)" /></label>
        <div class="gn-foot"><button class="delregion danger">remove region</button></div>`,
    };
  }
  if (n.type === "anchor") {
    const a = n.ref;
    return {
      title: `<input class="gi gi-id" data-k="ancid" value="${esc(a.id)}" title="condition: all must match to capture" />`,
      body: `<label class="flab">text <input class="aset" data-k="text" value="${esc(a.text || "")}" placeholder="EQUIPMENT" /></label>
        <label class="flab">read ⊆ text <input type="checkbox" class="aset" data-k="incl" ${a.included ? "checked" : ""} title="match if the read word is included in this text" /></label>
        <label class="flab">threshold <input type="number" class="aset" data-k="thr" step="0.05" min="0" max="1" value="${a.threshold ?? 0.8}" /></label>
        <div class="detect-status muted">◯ —</div>
        <div class="gn-foot"><button class="delanchor danger">remove condition</button></div>`,
    };
  }
  if (n.type === "item") {
    return { title: `<input class="gi gi-id" data-k="itemid" value="${esc(n.ref.id)}" title="item template" />`,
      body: `<div class="item-img"></div><div class="item-lists">${itemLists(n.ref, n.win)}</div>` };
  }
  if (n.type === "scrollbar") {
    const o = n.ref.scrollbar_orientation || "vertical";
    return {
      title: "↕ scrollbar",
      body: `<label class="flab">orientation <select class="sbset" data-k="orient">
          <option ${o === "vertical" ? "selected" : ""}>vertical</option>
          <option ${o === "horizontal" ? "selected" : ""}>horizontal</option></select></label>
        <div class="detect-status muted">position: —</div>
        <div class="gn-foot"><button class="delsb danger">remove scrollbar</button></div>`,
    };
  }
  // dataset
  const ds = n.ref;
  const d = live[ds] || { present: 0, total: 0, last_op: null, last_ts: null };
  const pulse = prevPresent[ds] !== undefined && prevPresent[ds] !== d.present ? "pulse" : "";
  return {
    title: `🗄 ${esc(ds)}`, pulse,
    body: `<div class="big">${d.present}<span class="muted"> / ${d.total}</span></div>
      <div class="muted">${d.last_op ? esc(d.last_op) : "—"} ${d.last_ts ? esc(d.last_ts.slice(11)) : ""}</div>`,
    ports: `<span class="port in"></span>`,
  };
}

const CAN_DISABLE = new Set(["window", "item", "region", "anchor", "scrollbar"]);

function fillNode(div, n) {
  const isCollapsed = collapsed.has(n.id);
  const canToggle = CAN_DISABLE.has(n.type);
  const enabled = !(canToggle && n.ref && n.ref.enabled === false);
  div.className = `gnode ${n.type}${isCollapsed ? " collapsed" : ""}${enabled ? "" : " node-disabled"}`;
  if (n.type === "dataset") div.dataset.ds = n.ref;
  const parts = nodeParts(n);
  const toggle = canToggle
    ? `<input type="checkbox" class="gn-enable" ${enabled ? "checked" : ""} title="enabled — uncheck to skip this node during detection" />`
    : "";
  div.innerHTML = `<div class="gn-h ${parts.pulse || ""}">
      <button class="collapse" title="collapse/expand">${isCollapsed ? "▸" : "▾"}</button>${toggle}${parts.title}<span class="gn-spin" title="working…"></span></div>
    <div class="gn-body">${parts.body}</div>${parts.ports || ""}`;
  div.querySelector(".collapse").addEventListener("click", () => toggleCollapse(n.id));
  div.querySelector(".gn-enable")?.addEventListener("change", (e) => {
    n.ref.enabled = e.target.checked;
    div.classList.toggle("node-disabled", !e.target.checked);
    const winId = n.type === "window" ? n.ref.id : n.win?.id;
    if (winId) { gridPreviews.delete(winId); gridReads.delete(winId); refreshImageBoxes(winId); }
    autosave();
  });
  if (busy.get(n.id)) div.classList.add("busy");   // preserve spinner across rebuilds
  wireNode(div, n);
}

function buildNode(n) {
  const div = document.createElement("div");
  div.id = `node-${n.id}`;
  div.dataset.id = n.id;
  fillNode(div, n);
  if (n.type === "item") snapResize(div, { onResize: drawEdges });   // width-resizable → snap on release
  return div;
}

// Rebuild ONE node's DOM in place (used when its own layout changes, e.g. type).
function rebuildNode(id) {
  const el = nodeEls.get(id);
  const n = model.nodes().find((x) => x.id === id);
  if (!el || !n) return;
  // window nodes hold a live image canvas — rebuild only the controls, never the
  // whole node, so the canvas survives.
  if (n.type === "window") {
    const ctl = el.querySelector(".win-controls");
    const w = n.ref;
    const fids = [...new Set([...(w.fields || []).map((f) => f.id), ...(w.regions || []).map((r) => r.field)])].filter(Boolean);
    const key = w.dedup_field || "name";
    const keyOpts = (fids.length ? fids : [key]).map((f) => `<option ${f === key ? "selected" : ""}>${esc(f)}</option>`).join("");
    if (ctl) { ctl.innerHTML = windowControls(w, keyOpts); wireWindowControls(el, n); }
    return;
  }
  // item nodes hold a live cutout canvas — rebuild only the lists.
  if (n.type === "item") {
    const lists = el.querySelector(".item-lists");
    if (lists) { lists.innerHTML = itemLists(n.ref, n.win); wireItemControls(el, n); }
    return;
  }
  fillNode(el, n);
}

function toggleCollapse(id) {
  if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
  const el = nodeEls.get(id);
  if (el) { el.classList.toggle("collapsed"); const b = el.querySelector(".collapse"); if (b) b.textContent = collapsed.has(id) ? "▸" : "▾"; }
  savePositions();
}

// Reconcile the node DOM with the model: add new, remove gone, reposition. Existing
// nodes keep their DOM (and input focus/values) — no wholesale rebuild.
function render() {
  ensurePositions();
  const layer = $("gnodes");
  const want = model.nodes();
  const wantIds = new Set(want.map((n) => n.id));
  for (const [id, el] of nodeEls) if (!wantIds.has(id)) { el.remove(); nodeEls.delete(id); }
  for (const n of want) {
    let el = nodeEls.get(n.id);
    if (!el) { el = buildNode(n); nodeEls.set(n.id, el); layer.appendChild(el); }
    positionNode(n.id);
  }
  drawEdges();
  resizeCanvas();
  applyView();
  positionPanels();
  openMissingItemCanvases();
}

// Item nodes always show their frozen cutout canvas; open any that aren't yet.
function openMissingItemCanvases() {
  for (const w of model.profile.windows || [])
    for (const it of w.items || [])
      if (it.cutout && !itemCanvases.has(`${w.id}:${it.id}`) && nodeEls.has(`item:${w.id}:${it.id}`))
        openItemImage(w.id, it.id);
}

function applyView() {
  $("gworld").style.transform = `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom})`;
}

function resizeCanvas() {
  let maxX = 0, maxY = 0;
  for (const p of pos.values()) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  const w = maxX + 280, h = maxY + 200;
  for (const id of ["gworld", "gnodes"]) { const el = $(id); el.style.width = `${w}px`; el.style.height = `${h}px`; }
  for (const id of ["gedges", "gedges-top"]) { const svg = $(id); svg.setAttribute("width", w); svg.setAttribute("height", h); }
}

// ---- pan + zoom -----------------------------------------------------------

function deselectAll() {
  for (const [, rec] of overlays) rec.overlay.setActive(null);   // every overlay, centrally
  for (const [, el] of nodeEls) el.classList.remove("selected");
  selectedNodeId = null;
  activeOverlayKey = null;
  drawEdges();
}

let suppressNextMenu = false;   // set when a right-drag pan actually moved
function startPan(ev) {
  const s = { x: ev.clientX, y: ev.clientY, px: view.panX, py: view.panY };
  let moved = false;
  const mv = (e) => {
    if (!moved && Math.hypot(e.clientX - s.x, e.clientY - s.y) < 4) return;  // ignore micro-jitter
    if (!moved) { moved = true; $("graph").classList.add("panning"); }
    view.panX = s.px + (e.clientX - s.x); view.panY = s.py + (e.clientY - s.y); applyView();
  };
  const up = () => {
    document.removeEventListener("mousemove", mv); document.removeEventListener("mouseup", up);
    $("graph").classList.remove("panning");
    suppressNextMenu = moved;   // only a real drag eats the context menu; a plain click keeps it
    if (moved) savePositions();
  };
  document.addEventListener("mousemove", mv);
  document.addEventListener("mouseup", up);
}

function updateOverlayZoom() {
  for (const [, rec] of overlays) rec.overlay.setWorldZoom(view.zoom);   // every overlay (window + item)
}

function onWheel(ev) {
  // a SELECTED preview scrolls its content on wheel; everywhere else the wheel zooms
  if (ev.target.closest(".prevpanel.selected")) return;
  ev.preventDefault();
  const rect = $("graph").getBoundingClientRect();
  const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
  const old = view.zoom;
  const z = Math.min(8, Math.max(0.15, old * (ev.deltaY < 0 ? 1.1 : 1 / 1.1)));
  // keep the world point under the cursor fixed
  view.panX = mx - (mx - view.panX) * (z / old);
  view.panY = my - (my - view.panY) * (z / old);
  view.zoom = z;
  applyView(); updateOverlayZoom(); savePositions();
}

const nw = (id) => nodeEls.get(id)?.offsetWidth || 220;   // node width (right edge)
const nh = (id) => nodeEls.get(id)?.offsetHeight || 80;   // node height

// Double-click a node: fit it to the viewport and centre it.
function zoomToNode(id) {
  const el = nodeEls.get(id), p = pos.get(id);
  if (!el || !p) return;
  const rect = $("graph").getBoundingClientRect();
  const w = el.offsetWidth || 220, h = el.offsetHeight || 80;
  const z = Math.min(8, Math.max(0.15, Math.min(2, (rect.width * 0.85) / w, (rect.height * 0.85) / h)));
  view.zoom = z;
  view.panX = rect.width / 2 - (p.x + w / 2) * z;
  view.panY = rect.height / 2 - (p.y + h / 2) * z;
  applyView(); updateOverlayZoom(); savePositions();
}

function addEdge(svg, x1, y1, x2, y2, cls) {
  if (![x1, y1, x2, y2].every(Number.isFinite)) return;
  const dx = Math.max(30, (x2 - x1) / 2);
  const d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;   // curved
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", d);
  path.setAttribute("class", cls);
  svg.appendChild(path);
}

// Bezier whose tangents leave each endpoint along an outward direction
// (L/R/T/B) so the line starts the right way and doesn't bend immediately.
function addDirEdge(svg, x1, y1, d1, x2, y2, d2, cls) {
  if (![x1, y1, x2, y2].every(Number.isFinite)) return;
  const k = Math.max(30, Math.hypot(x2 - x1, y2 - y1) * 0.4);
  const OFF = { L: [-k, 0], R: [k, 0], T: [0, -k], B: [0, k] };
  const [ax, ay] = OFF[d1] || [0, 0], [bx, by] = OFF[d2] || [0, 0];
  const d = `M ${x1} ${y1} C ${x1 + ax} ${y1 + ay}, ${x2 + bx} ${y2 + by}, ${x2} ${y2}`;
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", d);
  path.setAttribute("class", cls);
  svg.appendChild(path);
}

// Connect two rectangles on their closest-facing sides (shortest centre axis),
// tangents pointing outward from each side. For non-editable edges.
function connectRects(svg, ra, rb, cls) {
  const acx = ra.x + ra.w / 2, acy = ra.y + ra.h / 2, bcx = rb.x + rb.w / 2, bcy = rb.y + rb.h / 2;
  const dx = bcx - acx, dy = bcy - acy;
  let p1, d1, p2, d2;
  if (Math.abs(dx) >= Math.abs(dy)) {
    if (dx >= 0) { p1 = [ra.x + ra.w, acy]; d1 = "R"; p2 = [rb.x, bcy]; d2 = "L"; }
    else { p1 = [ra.x, acy]; d1 = "L"; p2 = [rb.x + rb.w, bcy]; d2 = "R"; }
  } else {
    if (dy >= 0) { p1 = [acx, ra.y + ra.h]; d1 = "B"; p2 = [bcx, rb.y]; d2 = "T"; }
    else { p1 = [acx, ra.y]; d1 = "T"; p2 = [bcx, rb.y + rb.h]; d2 = "B"; }
  }
  addDirEdge(svg, p1[0], p1[1], d1, p2[0], p2[1], d2, cls);
}
const nodeRect = (id) => { const p = pos.get(id); return p && { x: p.x, y: p.y, w: nw(id), h: nh(id) }; };
function connectNodes(svg, fromId, toId, cls) {
  const ra = nodeRect(fromId), rb = nodeRect(toId);
  if (ra && rb) connectRects(svg, ra, rb, cls);
}

function boxFracForNode(id) {
  if (id.startsWith("reg:")) { const [, win, rid] = id.split(":"); const r = model.region(win, rid); return r && r.box; }
  if (id.startsWith("anc:")) { const [, win, aid] = id.split(":"); const a = model.anchor(win, aid); return a && a.search; }
  if (id.startsWith("sb:")) { const [, win] = id.split(":"); return model.scrollbar(win); }
  return null;
}

// World-space centre of a fraction box inside an open image panel.
// The image canvas lives inside the window node; its world rect is the node
// position plus the canvas's offset within the node.
function boxWorldRect(winId, frac) {
  const entry = imageCanvases.get(winId);
  const wp = pos.get(`win:${winId}`);
  if (!entry || !wp || !entry.canvas) return null;
  const cv = entry.canvas;
  const cw = cv.offsetWidth, ch = cv.offsetHeight;
  return { x: wp.x + cv.offsetLeft + frac.x * cw, y: wp.y + cv.offsetTop + frac.y * ch, w: frac.w * cw, h: frac.h * ch };
}

function drawEdges() {
  const svg = $("gedges");        // structural edges (behind nodes)
  const top = $("gedges-top");    // attach/panel lines (over the image)
  svg.innerHTML = ""; top.innerHTML = "";
  const selCls = (e) => (selectedNodeId && (e.from === selectedNodeId || e.to === selectedNodeId)) ? " sel" : "";
  for (const e of model.edges()) {
    const a = pos.get(e.from), b = pos.get(e.to);
    // field/anchor: if the window's image is open, run the line from the REGION/
    // ANCHOR node itself to its rectangle on the image — drawn on the TOP layer.
    if ((e.kind === "field" || e.kind === "anchor" || e.kind === "scrollbar") && imageCanvases.has(e.from.slice(4))) {
      const winId = e.from.slice(4);
      const nrect = nodeRect(e.to);
      const frac = boxFracForNode(e.to);
      const rect = frac && boxWorldRect(winId, frac);
      // closest-facing sides between the node and its rectangle on the image
      if (nrect && rect) connectRects(top, nrect, rect, `gedge ${e.kind}${selCls(e)}`);   // colour matches the box
      continue;
    }
    if (!a || !b) continue;
    const sel = selCls(e);
    // non-editable structural edge: closest-facing sides, correct start direction
    connectNodes(sel ? top : svg, e.from, e.to, `gedge ${e.kind}${sel}`);  // sel -> top layer
  }
  // image is part of the window node. window node -> its open preview panel
  for (const [winId, prev] of previewPanels) {
    const wp = pos.get(`win:${winId}`), pp = pos.get(`prev:${winId}`);
    const node = nodeEls.get(`win:${winId}`);
    if (!wp || !pp || !node) continue;
    const wr = { x: wp.x, y: wp.y, w: node.offsetWidth, h: node.offsetHeight };
    const pr = { x: pp.x, y: pp.y, w: prev.wrap.offsetWidth || 340, h: prev.wrap.offsetHeight || 320 };
    connectRects(top, wr, pr, "gedge img");
  }
  if (wire) addEdge(svg, wire.x1, wire.y1, wire.x2, wire.y2, "gedge wire");
}

// ---- per-node interaction -------------------------------------------------

function wireNode(div, n) {
  // drag-move from anywhere on the node except interactive controls (so all
  // edges/padding/labels work, not just the header)
  div.addEventListener("mousedown", (ev) => {
    if (ev.button !== 0) return;   // only left-drag moves; right-drag pans the canvas
    if (ev.target.closest("input,select,button,a,.port,.collapse,.canvas-wrap")) return;  // .canvas-wrap: let its resize handle work without moving the node
    const r = div.getBoundingClientRect();   // skip the CSS resize-handle corner (resizable nodes)
    if (ev.clientX > r.right - 18 && ev.clientY > r.bottom - 18) return;
    startMove(n.id, ev);
  });

  // double-click anywhere non-interactive on the node: fit + centre it
  div.addEventListener("dblclick", (ev) => {
    if (ev.target.closest("input,select,button,textarea,a,.port,.collapse")) return;
    ev.preventDefault();
    zoomToNode(n.id);
  });

  if (n.type === "game") {
    div.querySelectorAll(".gi").forEach((inp) => inp.addEventListener("change", (e) => {
      const k = e.target.dataset.k, v = e.target.value;
      if (k === "name") model.profile.name = v.trim();
      else if (k === "proc") model.profile.process_names = v.split(",").map((s) => s.trim()).filter(Boolean);
      else if (k === "title") model.profile.window_title_hint = v.trim() || null;
      autosave();
    }));
    div.querySelector(".addwin").addEventListener("click", () => {
      const id = div.querySelector(".newwin").value.trim();
      if (id && model.addWindow(id)) { render(); autosave(); }
    });
  } else if (n.type === "window") {
    wireWindowControls(div, n);
    div.querySelector(".port.out").addEventListener("mousedown", (ev) => startWire(n.ref.id, ev));
  } else if (n.type === "dataset") {
    div.addEventListener("click", (ev) => { if (!ev.target.closest(".gn-h,.port")) openDataModal(n.ref); });
  } else if (n.type === "region") {
    const fld = n.field;
    div.addEventListener("click", (ev) => {
      if (ev.target.closest("input,select,button")) return;
      selectWindowBox(n.win.id, n.ref.id);   // highlight this region's box on the image
    });
    div.querySelector(".gi-id").addEventListener("change", (e) => {
      const oldId = n.ref.id, newId = e.target.value.trim();
      model.renameRegion(n.win.id, oldId, newId);
      movePos(`reg:${n.win.id}:${oldId}`, `reg:${n.win.id}:${n.ref.id}`);
      render(); autosave(); refreshImageBoxes(n.win.id);
    });
    div.querySelectorAll(".fset").forEach((inp) => inp.addEventListener("change", (e) => {
      if (!fld) return;
      const k = e.target.dataset.k;
      if (k === "type") { fld.type = e.target.value; rebuildNode(n.id); }  // toggles extract/sep
      else if (k === "extract") { fld.extract = e.target.value; rebuildNode(n.id); }  // toggles sep
      else if (k === "sep") fld.separator = e.target.value || "/";
      else if (k === "learn") fld.learn = e.target.checked;
      else if (k === "fuzzy") fld.fuzzy = +e.target.value;
      else if (k === "empty") fld.empty = e.target.value || null;
      autosave();   // plain value edits: no DOM rebuild
    }));
    div.querySelector(".delregion").addEventListener("click", () => { model.removeRegion(n.win.id, n.ref.id); render(); autosave(); refreshImageBoxes(n.win.id); });
  } else if (n.type === "anchor") {
    div.addEventListener("click", (ev) => {
      if (ev.target.closest("input,select,button")) return;
      selectWindowBox(n.win.id, n.ref.id);
    });
    div.querySelector(".gi-id").addEventListener("change", (e) => {
      const oldId = n.ref.id; n.ref.id = e.target.value.trim();
      movePos(`anc:${n.win.id}:${oldId}`, `anc:${n.win.id}:${n.ref.id}`);
      render(); autosave(); refreshImageBoxes(n.win.id);
    });
    div.querySelectorAll(".aset").forEach((inp) => inp.addEventListener("change", (e) => {
      const k = e.target.dataset.k;
      if (k === "text") n.ref.text = e.target.value;
      else if (k === "thr") n.ref.threshold = +e.target.value;
      else if (k === "incl") n.ref.included = e.target.checked;
      autosave(); refreshOpenDetect();
    }));
    div.querySelector(".delanchor").addEventListener("click", () => { model.removeAnchor(n.win.id, n.ref.id); render(); autosave(); refreshImageBoxes(n.win.id); });
  } else if (n.type === "scrollbar") {
    div.addEventListener("click", (ev) => {
      if (ev.target.closest("input,select,button")) return;
      selectWindowBox(n.win.id, "scrollbar");
    });
    div.querySelector(".sbset").addEventListener("change", (e) => { model.setScrollbarOrientation(n.win.id, e.target.value); autosave(); });
    div.querySelector(".delsb").addEventListener("click", () => { model.removeScrollbar(n.win.id); render(); autosave(); refreshImageBoxes(n.win.id); });
  } else if (n.type === "item") {
    wireItemControls(div, n);
  }
}

// ---- modals ---------------------------------------------------------------

const OP_COLOR = { add: "#7ddc7d", update: "#e6c25a", remove: "#e6685a" };

async function openDataModal(ds) {
  const node = document.createElement("div");
  node.innerHTML = `<p class="muted" style="padding:12px">loading…</p>`;
  openModal({ title: `dataset: ${ds}`, size: "data", node });
  try {
    const r = await fetch(`/api/flow/${encodeURIComponent(model.profile.name)}/dataset/${encodeURIComponent(ds)}`);
    const d = await r.json();
    node.innerHTML = dataHTML(d);
  } catch (e) {
    node.innerHTML = `<p class="muted" style="padding:12px">${esc(String(e))}</p>`;
  }
}

function dataHTML(d) {
  const hist = (d.history || []).map((h) => {
    const changed = h.changed ? " " + Object.entries(h.changed).map(([k, v]) => `${esc(k)}:${esc(v[0])}→${esc(v[1])}`).join(", ") : "";
    return `<li><span style="color:${OP_COLOR[h.op] || "#fff"};font-weight:600">${esc(h.op)}</span>
      <span class="muted">${esc((h.ts || "").slice(11))}</span> ${esc(h.key)}${changed}</li>`;
  }).join("") || '<li class="muted">no history yet</li>';

  const recs = d.records || [];
  let table = '<p class="muted">no records</p>';
  if (recs.length) {
    const cols = [...new Set(recs.flatMap((r) => Object.keys(r)))].filter((c) => !["present", "first_seen", "last_seen"].includes(c));
    const head = cols.map((c) => `<th>${esc(c)}</th>`).join("");
    const body = recs.map((r) => `<tr class="${r.present ? "" : "gone"}">${cols.map((c) => `<td>${esc(r[c] ?? "")}</td>`).join("")}</tr>`).join("");
    table = `<table class="grid-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  }
  return `<div class="detail-cols">
    <div><h4>Recent changes</h4><ul class="history">${hist}</ul></div>
    <div><h4>Records (${recs.length})</h4><div class="records">${table}</div></div>
  </div>`;
}

// Capture filenames are "YYYYMMDD-HHMMSS-ffffff.jpg" — pull the time out for display.
function fmtCaptureTime(name) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(name);
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : name;
}

// Pick which stashed capture a window opens with — a thumbnail grid of every stash.
async function openCaptureModal(winId) {
  const game = model.profile.name;
  const node = document.createElement("div");
  node.innerHTML = `<p class="muted" style="padding:12px">loading…</p>`;
  const modal = openModal({ title: `${winId} — choose capture`, size: "data", node });
  try {
    const [caps, binds] = await Promise.all([api.listCaptures(game), api.getBindings(game)]);
    const current = binds[winId];
    const grid = caps.map((name) => `
      <button class="cap-cell ${name === current ? "sel" : ""}" data-name="${esc(name)}" title="${esc(name)}">
        <img loading="lazy" src="${api.captureUrl(game, name)}" alt="" />
        <span class="cap-time">${esc(fmtCaptureTime(name))}</span>
      </button>`).join("");
    node.innerHTML = `<div class="cap-head"><button class="cap-new">📷 capture new</button>
        <span class="muted">${caps.length} stashed</span></div>
      ${caps.length ? `<div class="cap-grid">${grid}</div>` : '<p class="cap-empty">no stashed captures yet</p>'}`;
    node.querySelectorAll(".cap-cell").forEach((b) =>
      b.addEventListener("click", async () => { await chooseCapture(winId, b.dataset.name); modal.close(); }));
    node.querySelector(".cap-new").addEventListener("click", async () => {
      modal.close();
      if (!imageCanvases.has(winId)) await openImage(winId);
      await loadImage(winId, true);   // grab a fresh window capture + bind it
    });
  } catch (e) {
    node.innerHTML = `<p class="muted" style="padding:12px">${esc(String(e))}</p>`;
  }
}

async function chooseCapture(winId, name) {
  await api.bindCapture(model.profile.name, winId, name);
  if (!imageCanvases.has(winId)) await openImage(winId);   // openImage -> loadImage uses the binding
  else await loadImage(winId, false);
  updateImageLabel(winId);
}

// ---- window image / region drawing (in-graph) -----------------------------

const KINDS = [["item", "item", "▣"], ["data_area", "data area", "▭"], ["anchor", "condition", "◎"], ["scrollbar", "scrollbar", "↕"]];
// kinds drawn INSIDE an item node (on its frozen cutout): the cell + fields + tells
const ITEM_KINDS = [["bbox", "cell", "▣"], ["field", "field", "▦"], ["filled", "filled", "▩"], ["text", "text", "T"], ["color", "color", "◐"], ["template", "template", "⧉"], ["diamonds", "diamonds", "◆"]];

// Show the bound capture's filename on the image button, so the user can tell
// which picture this window is looking at.
async function updateImageLabel(winId, btn) {
  btn = btn || nodeEls.get(`win:${winId}`)?.querySelector(".imgbtn");
  if (!btn) return;
  try {
    const name = (await api.getBindings(model.profile.name))[winId];
    btn.textContent = name ? `📷 ${name}` : "📷 image";
    btn.title = name || "capture image";
  } catch { /* ignore */ }
}

function closeImage(winId) {
  const e = imageCanvases.get(winId);
  if (e && e.host) e.host.innerHTML = "";
  imageCanvases.delete(winId);
  unregisterOverlay(`win:${winId}`);
  closePreview(winId);
  openImages.delete(winId);
  drawEdges();
  savePositions();
}

// The image surface lives INSIDE the window node's `.win-img` host — one node.
async function openImage(winId) {
  const node = nodeEls.get(`win:${winId}`);
  const host = node && node.querySelector(".win-img");
  if (!host) return;
  host.innerHTML = `<div class="imgtools">
      <span class="tools">${KINDS.map(([v, label, icon], i) => `<button class="tool ${i === 0 ? "active" : ""}" data-kind="${v}" title="draw ${label}">${icon} ${label}</button>`).join("")}</span>
      <span class="spacer"></span><button class="imgprev">👁</button><button class="imgcap">recapture</button><button class="imgclose">×</button></div>
    <div class="canvas-wrap"><canvas></canvas></div>`;
  const canvas = host.querySelector("canvas");
  const kindOf = () => host.querySelector(".tool.active")?.dataset.kind || "region";
  const overlay = new Overlay(canvas, {
    onCreate: (geom) => {
      const k = kindOf();
      if (k === "item") { createItemFromGeom(winId, geom); return; }   // freeze + spawn item node
      let newAnchor = null;
      if (k === "anchor") newAnchor = model.addAnchor(winId, geom);
      else if (k === "scrollbar") model.setScrollbar(winId, geom);
      else if (k === "data_area") model.setDataArea(winId, geom);
      else model.addRegion(winId, geom);
      gridPreviews.delete(winId); gridReads.delete(winId);   // layout changed → detected grid is stale
      render(); refreshImageBoxes(winId); autosave();
      if (newAnchor) prefillAnchorText(winId, newAnchor);
    },
    onChange: (box) => {
      const r = box.role;
      if (r === "anchor") model.setAnchorBox(winId, box.id, box);
      else if (r === "scrollbar") model.setScrollbar(winId, box);
      else if (r === "data_area") model.setDataArea(winId, box);
      else if (r === "item") { model.setItemBox(winId, box.id, box); refreshItemBoxes(winId, box.id); }
      else model.setRegionBox(winId, box.id, box);
      gridPreviews.delete(winId); gridReads.delete(winId);   // layout changed → detected grid is stale
      refreshImageBoxes(winId); drawEdges(); autosave();
    },
    onSelect: (id) => overlaySelected(`win:${winId}`, id),
  });
  imageCanvases.set(winId, { host, canvas, overlay });
  registerOverlay(`win:${winId}`, { overlay, kind: "window", winId,
    persist: (b) => persistBox(winId, b), refresh: () => refreshImageBoxes(winId) });
  overlay.setWorldZoom(view.zoom);
  openImages.add(winId);
  savePositions();
  host.querySelectorAll(".tool").forEach((btn) => btn.addEventListener("click", () => {
    host.querySelectorAll(".tool").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
  }));
  host.querySelector(".imgclose").addEventListener("click", () => closeImage(winId));
  host.querySelector(".imgcap").addEventListener("click", () => loadImage(winId, true));
  host.querySelector(".imgprev").addEventListener("click", () => togglePreview(winId));
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => drawEdges()).observe(canvas.parentElement);
  await loadImage(winId, false);
  refreshDetect(winId);
  drawEdges();
}

// ---- item template nodes (frozen cutout + cell-relative fields/tells) ------

// Drawing an "item" box on the fullscreen image freezes that crop and spawns a node.
async function createItemFromGeom(winId, geom) {
  const game = model.profile.name;
  const cap = (await api.getBindings(game))[winId];
  if (!cap) { setStatus("recapture the window first"); return; }
  let cut;
  try { cut = await api.itemCutout(game, cap, geom); }
  catch (e) { setStatus(String(e.message || e)); return; }
  const itemId = model.addItem(winId, { cutout: cut.name, cutout_box: geom, box: geom });
  gridPreviews.delete(winId); gridReads.delete(winId);
  render(); refreshImageBoxes(winId); autosave();
  openItemImage(winId, itemId);
}

function closeItemImage(winId, itemId) {
  const key = `${winId}:${itemId}`;
  const e = itemCanvases.get(key);
  if (e && e.host) e.host.innerHTML = "";
  itemCanvases.delete(key);
  unregisterOverlay(`item:${winId}:${itemId}`);
  drawEdges();
}

// Build the cutout canvas inside an item node and wire drawing of cell/fields/tells.
function openItemImage(winId, itemId) {
  const node = nodeEls.get(`item:${winId}:${itemId}`);
  const host = node && node.querySelector(".item-img");
  if (!host) return;
  const it = model.item(winId, itemId);
  if (!it || !it.cutout_box) return;
  host.innerHTML = `<div class="imgtools">
      <span class="tools">${ITEM_KINDS.map(([v, label, icon]) => `${v === "filled" ? '<span class="tool-div" title="tells"></span>' : ""}<button class="tool ${v === "field" ? "active" : ""}" data-kind="${v}" title="draw ${label}">${icon} ${label}</button>`).join("")}</span>
      <span class="spacer"></span></div>
    <div class="canvas-wrap"><canvas></canvas></div>`;
  const canvas = host.querySelector("canvas");
  const cb = it.cutout_box;
  const cut2win = (b) => ({ x: cb.x + b.x * cb.w, y: cb.y + b.y * cb.h, w: b.w * cb.w, h: b.h * cb.h });
  const win2cut = (b) => ({ x: (b.x - cb.x) / cb.w, y: (b.y - cb.y) / cb.h, w: b.w / cb.w, h: b.h / cb.h });
  const ibox = () => model.item(winId, itemId).box;
  const win2rel = (b) => { const ib = ibox(); return { x: (b.x - ib.x) / ib.w, y: (b.y - ib.y) / ib.h, w: b.w / ib.w, h: b.h / ib.h }; };
  const rel2win = (b) => { const ib = ibox(); return { x: ib.x + b.x * ib.w, y: ib.y + b.y * ib.h, w: b.w * ib.w, h: b.h * ib.h }; };
  const kindOf = () => host.querySelector(".tool.active")?.dataset.kind || "field";

  const overlay = new Overlay(canvas, {
    onCreate: (geom) => {                       // geom in cutout fractions
      const w = cut2win(geom);
      const k = kindOf();
      if (k === "bbox") model.setItemBox(winId, itemId, w);
      else if (k === "field") model.addItemField(winId, itemId, win2rel(w));
      else model.addItemTell(winId, itemId, k, win2rel(w));   // filled/text/color/template
      gridPreviews.delete(winId); gridReads.delete(winId);
      refreshItemBoxes(winId, itemId); refreshImageBoxes(winId); rebuildNode(`item:${winId}:${itemId}`); autosave();
    },
    onChange: (box) => {                        // box in cutout fractions + role/id
      const w = cut2win(box);
      if (box.role === "bbox") model.setItemBox(winId, itemId, w);
      else if (box.role === "field") model.setItemFieldBox(winId, itemId, box.id, win2rel(w));
      else model.setItemTellBox(winId, itemId, box.id, win2rel(w));
      gridPreviews.delete(winId); gridReads.delete(winId);
      refreshItemBoxes(winId, itemId); refreshImageBoxes(winId); autosave();
    },
    onSelect: (id) => overlaySelected(`item:${winId}:${itemId}`, id),
  });
  itemCanvases.set(`${winId}:${itemId}`, { host, canvas, overlay, cut2win, win2cut, win2rel, rel2win });
  // central registry: cross-deselect + WASD for the item's boxes
  const persistItem = (b) => {
    const w = cut2win(b);
    if (b.role === "bbox") model.setItemBox(winId, itemId, w);
    else if (b.role === "field") model.setItemFieldBox(winId, itemId, b.id, win2rel(w));
    else model.setItemTellBox(winId, itemId, b.id, win2rel(w));
    gridPreviews.delete(winId); gridReads.delete(winId);
  };
  registerOverlay(`item:${winId}:${itemId}`, { overlay, kind: "item", winId, itemId,
    persist: persistItem, refresh: () => { refreshItemBoxes(winId, itemId); refreshImageBoxes(winId); } });
  overlay.setWorldZoom(view.zoom);
  host.querySelectorAll(".tool").forEach((b) => b.addEventListener("click", () => {
    host.querySelectorAll(".tool").forEach((x) => x.classList.remove("active")); b.classList.add("active");
  }));
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => drawEdges()).observe(canvas.parentElement);

  const img = new Image();
  img.onload = () => {
    canvas.parentElement.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
    overlay.setImage(img); refreshItemBoxes(winId, itemId); drawEdges();
  };
  img.src = api.cutoutUrl(model.profile.name, it.cutout);
  drawEdges();
}

// Draw the cell + fields + tells on the item's cutout canvas (in cutout fractions).
function refreshItemBoxes(winId, itemId) {
  const ent = itemCanvases.get(`${winId}:${itemId}`);
  const it = model.item(winId, itemId);
  if (!ent || !it) return;
  const boxes = [{ id: "__bbox", role: "bbox", ...ent.win2cut(it.box) }];   // the tiling cell
  // label fields/tells with their role so the cutout shows what each box does: a field
  // flagged tell shows "⊙tell" + its align; a locating tell shows "loc" + align.
  for (const f of it.fields || []) {
    const al = f.align || it.align || "center";
    const label = `${f.id}${f.tell ? ` ⊙tell·${al}` : ""}`;
    boxes.push({ id: f.id, label, role: "field", field: f.field, ...ent.win2cut(ent.rel2win(f.box)) });
  }
  for (const t of it.tells || []) {
    const al = t.align || it.align || "center";
    const label = `${t.id}${t.locate ? ` loc·${al}` : ""}`;
    boxes.push({ id: t.id, label, role: t.kind === "text" ? "anchor" : "scrollbar", ...ent.win2cut(ent.rel2win(t.box)) });
  }
  ent.overlay.setBoxes(boxes);
}

function applyPanelSize(id, wrap) {
  const s = panelSizes.get(id);
  if (!s) return;
  if (s.w) wrap.style.width = `${s.w}px`;
  if (s.h && id.startsWith("prev:")) wrap.style.height = `${s.h}px`;   // image height follows aspect
}
let sizeT = null;
function observePanelSize(id, wrap) {
  // resize smoothly; snap to the grid on release (see snapResize)
  snapResize(wrap, {
    both: true,
    onResize: () => {
      panelSizes.set(id, { w: wrap.offsetWidth, h: wrap.offsetHeight });
      drawEdges();
      clearTimeout(sizeT); sizeT = setTimeout(savePositions, 400);
    },
    onSettle: () => {
      panelSizes.set(id, { w: wrap.offsetWidth, h: wrap.offsetHeight });
      drawEdges(); savePositions();
    },
  });
}

// Drag a panel (image/preview) like a node: snapped to the grid, pos-based.
function startPanelDrag(kind, winId, ev) {
  if (ev.target.closest("button, select, input")) return;
  ev.stopPropagation();
  const p = panelPos(kind, winId);
  const s = { x: ev.clientX, y: ev.clientY, px: p.x, py: p.y };
  const mv = (e) => {
    p.x = snap(s.px + (e.clientX - s.x) / view.zoom);
    p.y = snap(s.py + (e.clientY - s.y) / view.zoom);
    positionPanels(); drawEdges();
  };
  const up = () => { document.removeEventListener("mousemove", mv); document.removeEventListener("mouseup", up); savePositions(); };
  document.addEventListener("mousemove", mv);
  document.addEventListener("mouseup", up);
}

function selectRegionNode(winId, boxId) {
  const ids = [`reg:${winId}:${boxId}`, `anc:${winId}:${boxId}`, `st:${winId}:${boxId}`, `sb:${winId}:${boxId}`];
  selectedNodeId = ids.find((id) => nodeEls.has(id)) || null;
  for (const [id, el] of nodeEls) el.classList.toggle("selected", id === selectedNodeId);
  drawEdges();   // restyle the selected node's line
}

// ---- live preview node (what the current setup would read) ------------------

function togglePreview(winId) {
  if (previewPanels.has(winId)) closePreview(winId);
  else createPreviewPanel(winId);
}
function closePreview(winId) {
  const e = previewPanels.get(winId);
  if (e) { e.wrap.remove(); previewPanels.delete(winId); }
  openPreviews.delete(winId);
  savePositions();
}

// Mark a preview as selected (others deselected) — a selected preview scrolls on wheel.
function selectPreview(winId) {
  for (const [, e] of previewPanels) e.wrap.classList.toggle("selected", false);
  previewPanels.get(winId)?.wrap.classList.add("selected");
}

function createPreviewPanel(winId) {
  const wrap = document.createElement("div");
  wrap.className = "imgpanel prevpanel";
  wrap.id = `prev-${winId}`;
  wrap.innerHTML = `<div class="imgpanel-h">👁 ${esc(winId)} preview
      <span class="spacer"></span><button class="prevrefresh">refresh</button><button class="prevclose">×</button></div>
    <div class="prev-body"><p class="muted" style="padding:8px">—</p></div>`;
  $("gcanvases").appendChild(wrap);
  const body = wrap.querySelector(".prev-body");
  previewPanels.set(winId, { wrap, body });
  openPreviews.add(winId);
  savePositions();
  wrap.addEventListener("mousedown", () => selectPreview(winId));   // click to select (then wheel scrolls it)
  wrap.querySelector(".prevclose").addEventListener("click", () => closePreview(winId));
  wrap.querySelector(".prevrefresh").addEventListener("click", () => refreshPreview(winId));
  wrap.querySelector(".imgpanel-h").addEventListener("mousedown", (ev) => startPanelDrag("prev", winId, ev));
  applyPanelSize(`prev:${winId}`, wrap);
  observePanelSize(`prev:${winId}`, wrap);
  positionPanels();
  refreshPreview(winId);
}

function previewProfileFor(winId) {
  const w = model.window(winId);
  return { ...model.profile, windows: w ? [w] : [] };
}

async function refreshPreview(winId, live = false) {
  const panel = previewPanels.get(winId);
  if (!panel) return;
  if (!live) panel.body.innerHTML = `<p class="muted" style="padding:8px">reading…</p>`;
  try {
    const cap = live ? null : (await api.getBindings(model.profile.name))[winId];
    const res = await api.preview(previewProfileFor(winId), model.profile.name, cap);
    panel.body.innerHTML = previewTable(res.cells);
    setGridFromPreview(winId, res);   // same OCR pass drives the dashed grid
  } catch (e) {
    panel.body.innerHTML = `<p class="muted" style="padding:8px">${esc(String(e.message || e))}</p>`;
  }
}

function tellChip(t) {
  // one tell's outcome: "id score/threshold" tinted by pass/fail
  const thr = t.threshold == null ? "" : `<span class="muted">/${t.threshold}</span>`;
  const title = t.detail ? ` title="${esc(t.detail)}"` : "";
  return `<span class="tell-chip ${t.pass ? "tc-ok" : "tc-bad"}"${title}>${esc(t.id)} ${t.score}${thr}</span>`;
}

function previewTable(cells) {
  const all = cells || [];
  const hasItems = all.some((c) => Array.isArray(c.tells));
  if (!hasItems) {
    const kept = all.filter(cellKept);
    if (!kept.length) return `<p class="muted" style="padding:8px">0 rows</p>`;
    const fieldIds = [...new Set(kept.flatMap((c) => Object.keys(c.fields)))];
    const head = fieldIds.map((f) => `<th>${esc(f)}</th>`).join("");
    const rows = kept.slice(0, 200).map((c) => `<tr>${fieldIds.map((f) => {
      const v = c.fields[f];
      if (!v) return "<td>—</td>";
      const cls = v.confidence >= 0.8 ? "conf-ok" : v.confidence >= 0.5 ? "conf-warn" : "conf-bad";
      return `<td class="${cls}" title="${esc(v.raw || "")}">${esc(v.value ?? "∅")}</td>`;
    }).join("")}</tr>`).join("");
    return `<div class="prev-count muted">${kept.length} row${kept.length === 1 ? "" : "s"}</div>
      <table class="grid-table"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
  }

  // item-template diagnostics: show EVERY cell that read something (so rejected arcanes
  // are visible), with its template, status, reject reason, and per-tell scores.
  const read = all.filter((c) => Object.values(c.fields).some((f) => f && f.value !== null && f.value !== "" && f.value !== undefined));
  if (!read.length) return `<p class="muted" style="padding:8px">0 cells read any data</p>`;
  read.sort((a, b) => (b.valid === true) - (a.valid === true));
  const fieldIds = [...new Set(read.flatMap((c) => Object.keys(c.fields)))];
  const head = `<th></th><th>item</th>${fieldIds.map((f) => `<th>${esc(f)}</th>`).join("")}<th>tells</th><th>reason</th>`;
  const rows = read.slice(0, 300).map((c) => {
    const status = c.valid ? '<span class="tc-ok">✓</span>'
      : c.tells_pass ? '<span class="tc-warn">◌</span>' : '<span class="tc-bad">✗</span>';
    const fcols = fieldIds.map((f) => {
      const v = c.fields[f];
      if (!v) return "<td>—</td>";
      const cls = v.confidence >= 0.8 ? "conf-ok" : v.confidence >= 0.5 ? "conf-warn" : "conf-bad";
      return `<td class="${cls}" title="${esc(v.raw || "")}">${esc(v.value ?? "∅")}</td>`;
    }).join("");
    const tells = (c.tells || []).map(tellChip).join(" ");
    return `<tr class="${c.valid ? "" : "prev-rej"}"><td>${status}</td><td>${esc(c.item || "")}</td>${fcols}<td>${tells}</td><td class="muted">${esc(c.reason || "")}</td></tr>`;
  }).join("");
  const nValid = read.filter((c) => c.valid).length;
  return `<div class="prev-count muted">${nValid} kept · ${read.length} read · ✓ kept, ◌ tells pass but lost overlap, ✗ tell failed</div>
    <table class="grid-table"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
}

async function prefillAnchorText(winId, anchorId) {
  try {
    const b = await api.getBindings(model.profile.name);
    const res = await api.detect(previewProfileFor(winId), model.profile.name, b[winId]);
    const info = res.anchors?.[anchorId];
    const a = model.anchor(winId, anchorId);
    if (a && !a.text && info && info.read && info.read !== "(template)") {
      a.text = info.read;
      render(); autosave();
    }
  } catch { /* ignore */ }
}

async function refreshDetect(winId, live = false) {
  // spinner on every node whose value this detect refreshes
  const ids = [`win:${winId}`, ...model.anchors(winId).map((a) => `anc:${winId}:${a.id}`)];
  if (model.scrollbar(winId)) ids.push(`sb:${winId}:scrollbar`);
  await withBusy(ids, async () => {
    try {
      const cap = live ? null : (await api.getBindings(model.profile.name))[winId];
      const res = await api.detect(previewProfileFor(winId), model.profile.name, cap);
      for (const [aid, info] of Object.entries(res.anchors || {})) setDetectStatus(`anc:${winId}:${aid}`, info);
      for (const [sid, info] of Object.entries(res.states || {})) setDetectStatus(`st:${winId}:${sid}`, info);
      const sbEl = nodeEls.get(`sb:${winId}:scrollbar`);
      const sbSpan = sbEl && sbEl.querySelector(".detect-status");
      if (sbSpan) sbSpan.textContent = res.scrollbar == null ? "position: —" : `position: ${Math.round(res.scrollbar * 100)}%`;
    } catch { /* ignore */ }
  });
}
function setDetectStatus(nodeId, info) {
  const el = nodeEls.get(nodeId);
  const span = el && el.querySelector(".detect-status");
  if (!span) return;
  span.textContent = (info.matched ? "✓ true" : "✗ false") + (info.read ? ` — "${info.read}"` : "");
  span.className = "detect-status " + (info.matched ? "conf-ok" : "conf-bad");
}
let detectT = null;
function refreshOpenDetect() {
  clearTimeout(detectT);
  detectT = setTimeout(() => { for (const winId of imageCanvases.keys()) refreshDetect(winId); }, 700);
}

let previewT = null;
function refreshOpenPreviews() {
  if (!previewPanels.size) return;
  clearTimeout(previewT);
  previewT = setTimeout(() => { for (const id of previewPanels.keys()) refreshPreview(id); }, 700);
}


async function loadImage(winId, recapture) {
  const entry = imageCanvases.get(winId);
  if (!entry) return;
  const game = model.profile.name;
  let url = null;
  setNodeBusy(`win:${winId}`, true);   // capturing/fetching the image
  try {
    if (!recapture) {
      const b = await api.getBindings(game);
      if (b[winId]) url = api.captureUrl(game, b[winId]);
    }
    if (!url) {
      const c = await api.capture(game);          // capture + bind newest
      await api.bindCapture(game, winId, c.name);
      url = c.url;
    }
  } catch (e) { setStatus(String(e.message || e)); setNodeBusy(`win:${winId}`, false); return; }
  const img = new Image();
  img.onload = () => {
    setNodeBusy(`win:${winId}`, false);
    // keep the canvas area at the image aspect ratio so resizing always fits
    entry.canvas.parentElement.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
    entry.overlay.setImage(img);
    refreshImageBoxes(winId);
    drawEdges();
    refreshGridPreview(winId);   // draw the grid where rows actually are in this capture
    updateImageLabel(winId);     // button shows the (possibly new) filename
    // the image changed → an OPEN data preview must re-read it (only if open, to avoid
    // OCR work for a panel nobody's looking at)
    if (previewPanels.has(winId)) refreshPreview(winId);
    if (recapture) refreshDetect(winId);   // fresh pixels → re-evaluate detectors too
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
  for (const a of model.anchors(winId)) boxes.push({ id: a.id, role: "anchor", ...a.search });
  // item template box is NOT drawn here — it's the authored cell at one spot, which
  // isn't where detection actually reads; the live grid (below) shows the real cells
  const sb = model.scrollbar(winId);
  if (sb) boxes.push({ id: "scrollbar", role: "scrollbar", ...sb });
  entry.overlay.setBoxes(boxes);
  // prefer the live-detected grid (rows found in the actual capture); fall back to
  // the live-detected grid (where items were actually located this capture)
  entry.overlay.setGridPreview(gridPreviews.get(winId) || []);
  entry.overlay.setPreview(gridReads.get(winId) || []);   // value + confidence per cell
}

// Fetch where the rows ACTUALLY are by OCR-ing the capture, and draw that grid.
// This is what makes the dashed grid follow a scrolled list instead of guessing.
async function refreshGridPreview(winId, live = false) {
  const entry = imageCanvases.get(winId);
  if (!entry) return;
  try {
    const cap = live ? null : (await api.getBindings(model.profile.name))[winId];
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
  // when several item templates feed this window, label the cell with which one
  // matched (the first field carries the tag), so diagnostics show the item type
  const multi = new Set(kept.map((c) => c.item)).size > 1;
  // what each cell actually read (value + confidence) — shown on the window canvas
  const reads = kept.flatMap((c) => Object.values(c.fields)
    .filter((f) => f.box)
    .map((f, i) => ({
      ...f.box,
      text: multi && i === 0 && c.item ? `[${c.item}] ${f.value}` : f.value,
      confidence: f.confidence,
    })));
  if (boxes.length) gridPreviews.set(winId, boxes); else gridPreviews.delete(winId);
  if (reads.length) gridReads.set(winId, reads); else gridReads.delete(winId);
  refreshImageBoxes(winId);
}


// Panels are positioned from their own pos entries (`img:<win>` / `prev:<win>`),
// just like nodes — so they snap and persist the same way.
// Preview panel keeps its own position (default: right of the window node).
function panelPos(kind, winId) {
  const id = `${kind}:${winId}`;
  if (!pos.has(id)) {
    const wp = pos.get(`win:${winId}`) || { x: 300, y: 20 };
    const node = nodeEls.get(`win:${winId}`);
    pos.set(id, { x: snap(wp.x + (node?.offsetWidth || 240) + 40), y: snap(wp.y) });
  }
  return pos.get(id);
}

function positionPanels() {
  for (const [winId, panel] of previewPanels) { const p = panelPos("prev", winId); panel.wrap.style.left = `${p.x}px`; panel.wrap.style.top = `${p.y}px`; }
}

// ---- dragging -------------------------------------------------------------

const GRID = 20;
const snap = (v) => Math.round(v / GRID) * GRID;

// Snap a resizable element to the grid — but only when the drag is RELEASED, not while
// resizing (snapping mid-drag fights the smooth native resize). The observer just flags
// that a resize happened and runs ``onResize`` live (e.g. redraw edges); the snap fires
// on mouseup. Idempotent, so it never loops.
function snapResize(el, { both = false, onResize = null, onSettle = null } = {}) {
  if (typeof ResizeObserver === "undefined") return;
  let dirty = false;
  new ResizeObserver(() => { dirty = true; onResize && onResize(); }).observe(el);
  const finish = () => {
    if (!dirty) return;
    dirty = false;
    const w = snap(el.offsetWidth);
    if (Math.abs(w - el.offsetWidth) >= 1) el.style.width = `${w}px`;
    if (both) { const h = snap(el.offsetHeight); if (Math.abs(h - el.offsetHeight) >= 1) el.style.height = `${h}px`; }
    onSettle && onSettle();
  };
  el.addEventListener("mouseup", finish);     // release on the element's resize handle
  window.addEventListener("mouseup", finish);  // …or release after the cursor left it
}

// Every node reachable by following edges OUT of `id` (its downstream subtree),
// plus the preview panels of any window in that set. Used for shift-drag.
function descendantsOf(id) {
  const out = new Set();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop();
    for (const e of model.edges()) {
      if (e.from === cur && !out.has(e.to)) { out.add(e.to); stack.push(e.to); }
    }
  }
  for (const winId of previewPanels.keys()) if (out.has(`win:${winId}`)) out.add(`prev:${winId}`);
  out.delete(id);
  return [...out];
}

function startMove(id, ev) {
  const p = pos.get(id);
  // Shift: drag the whole subtree that flows out of this node.
  const group = ev.shiftKey ? descendantsOf(id).map((gid) => ({ gid, gp: pos.get(gid) })).filter((g) => g.gp) : [];
  const starts = group.map((g) => ({ ...g, sx: g.gp.x, sy: g.gp.y }));
  const start = { x: ev.clientX, y: ev.clientY, px: p.x, py: p.y };
  const onMove = (e) => {
    const dx = (e.clientX - start.x) / view.zoom, dy = (e.clientY - start.y) / view.zoom;
    p.x = snap(start.px + dx);
    p.y = snap(start.py + dy);
    positionNode(id);
    for (const g of starts) { g.gp.x = snap(g.sx + dx); g.gp.y = snap(g.sy + dy); positionNode(g.gid); }
    drawEdges(); positionPanels();
  };
  const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); resizeCanvas(); savePositions(); };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}
function positionNode(id) { const el = nodeEls.get(id); const p = pos.get(id); if (el && p) { el.style.left = `${p.x}px`; el.style.top = `${p.y}px`; } }

function startWire(winId, ev) {
  ev.preventDefault();
  ev.stopPropagation();
  const rect = $("graph").getBoundingClientRect();
  const p = pos.get(`win:${winId}`);
  wire = { winId, x1: p.x + 210, y1: p.y + 28, x2: p.x + 210, y2: p.y + 28 };
  const toWorld = (e) => ({ x: (e.clientX - rect.left - view.panX) / view.zoom, y: (e.clientY - rect.top - view.panY) / view.zoom });
  const onMove = (e) => { const w = toWorld(e); wire.x2 = w.x; wire.y2 = w.y; drawEdges(); };
  const onUp = (e) => {
    document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp);
    const target = document.elementFromPoint(e.clientX, e.clientY)?.closest(".gnode.dataset");
    if (target) { model.setDataset(winId, target.dataset.ds); autosave(); }
    wire = null; render();
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

// ---- live + toolbar -------------------------------------------------------

async function refreshLive() {
  if (!model.profile.name) return;
  try {
    const r = await fetch(`/api/flow/${encodeURIComponent(model.profile.name)}`);
    if (!r.ok) return;
    const data = await r.json();
    const map = {};
    for (const d of data.datasets) map[d.dataset] = d;
    for (const k in map) { if (live[k]) prevPresent[k] = live[k].present; }
    live = map;
    // Only re-render the whole graph if the set of datasets changed; otherwise
    // just update the existing dataset nodes' counts in place (no churn/flicker).
    const before = new Set(model.datasets());
    model.noteDatasets(data.datasets.map((d) => d.dataset));
    const after = model.datasets();
    if (after.length !== before.size || after.some((d) => !before.has(d))) render();
    else updateDatasetNodes();
  } catch { /* ignore */ }
}

function updateDatasetNodes() {
  for (const ds of model.datasets()) {
    const el = document.getElementById(`node-ds:${ds}`);
    if (!el) continue;
    const d = live[ds] || { present: 0, total: 0, last_op: null, last_ts: null };
    const big = el.querySelector(".big");
    if (big) big.innerHTML = `${d.present}<span class="muted"> / ${d.total}</span>`;
    const last = el.querySelectorAll(".gn-body .muted")[0];
    if (last) last.textContent = `${d.last_op || "—"} ${d.last_ts ? d.last_ts.slice(11) : ""}`;
    const header = el.querySelector(".gn-h");
    if (header && prevPresent[ds] !== undefined && prevPresent[ds] !== d.present) {
      header.classList.remove("pulse"); void header.offsetWidth; header.classList.add("pulse");
    }
  }
}

async function refreshGames(select) {
  const names = await api.listProfiles();
  $("gameSelect").innerHTML = names.map((n) => `<option>${n}</option>`).join("");
  if (select && names.includes(select)) $("gameSelect").value = select;
}

async function loadGame(name) {
  if (!name) return;
  const profile = await api.getProfile(name);
  model.load(profile);
  pos.clear();
  nodeEls.clear();
  $("gnodes").innerHTML = "";
  for (const winId of [...imageCanvases.keys()]) closeImage(winId);
  for (const winId of [...previewPanels.keys()]) closePreview(winId);
  loadPositions();   // restore saved node positions for this game
  render();
  for (const winId of pendingOpenImages) if (model.window(winId)) openImage(winId);  // reopen saved images (canvas lives in node)
  const reopenPreviews = pendingOpenPreviews;
  pendingOpenImages = []; pendingOpenPreviews = [];
  for (const winId of reopenPreviews) if (model.window(winId)) createPreviewPanel(winId);
  resetHistory();   // fresh undo/redo baseline for this game
  refreshLive();
  setStatus(`loaded ${name}`);
}

$("gameSelect").addEventListener("change", (e) => loadGame(e.target.value));
$("newGameBtn").addEventListener("click", () => {
  const name = $("newGameName").value.trim();
  if (!name) return setStatus("enter a name");
  model.load({ name, process_names: [], window_title_hint: null, fields: [], windows: [] });
  pos.clear(); nodeEls.clear(); $("gnodes").innerHTML = "";
  render(); autosave();
  refreshGames(name);
});
$("liveToggle").addEventListener("change", () => setLive());
$("saveToggle").addEventListener("change", (e) => {
  if (e.target.checked && model.profile.name) api.collect(model.profile.name, true).catch(() => {});  // start fresh
  setLive();
});
$("graph").addEventListener("mousedown", (ev) => {
  // right-drag pans ANYWHERE (even over nodes/canvas), except form controls so
  // their native menus still work. Don't preventDefault — a plain right click
  // must still open the context menu; only an actual drag suppresses it.
  if (ev.button === 2) { if (!ev.target.closest("input,select,textarea")) startPan(ev); return; }
  if (ev.button === 0 && !ev.target.closest(".prevpanel")) for (const [, e] of previewPanels) e.wrap.classList.remove("selected");
  if (ev.button === 0 && !ev.target.closest(".gnode, .imgpanel")) deselectAll();   // left-click clears selection
});
$("graph").addEventListener("contextmenu", (ev) => {
  if (suppressNextMenu) { ev.preventDefault(); suppressNextMenu = false; }   // a pan-drag just ended here
});
$("graph").addEventListener("wheel", onWheel, { passive: false });

// WASD moves the selected rectangle; Shift+WASD resizes it (A/D width, W/S height).
// Ignored while typing in a field.
const NUDGE = { w: [0, -1], a: [-1, 0], s: [0, 1], d: [1, 0] };
const MINB = 0.004;
document.addEventListener("keydown", (ev) => {
  if (["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
  if (ev.ctrlKey || ev.metaKey) {
    const k = ev.key.toLowerCase();
    if (k === "z" && !ev.shiftKey) { ev.preventDefault(); undo(); return; }
    if (k === "y" || (k === "z" && ev.shiftKey)) { ev.preventDefault(); redo(); return; }
  }
  const dir = NUDGE[ev.key.toLowerCase()];
  if (!dir) return;
  // Operate on whichever overlay holds the live selection (window OR item OR future).
  const rec = overlays.get(activeOverlayKey);
  if (!rec) return;
  const ov = rec.overlay;
  const b = ov.boxes.find((x) => x.id === ov.activeId);
  if (!b) return;
  // step exactly ONE image pixel, so it's the same feel on any canvas size
  const sx = 1 / (ov.canvas.width || 1000), sy = 1 / (ov.canvas.height || 1000);
  if (ev.shiftKey) {
    b.w = Math.min(Math.max(MINB, b.w + dir[0] * sx), 1 - b.x);
    b.h = Math.min(Math.max(MINB, b.h + dir[1] * sy), 1 - b.y);
  } else {
    b.x = Math.min(Math.max(0, b.x + dir[0] * sx), 1 - b.w);
    b.y = Math.min(Math.max(0, b.y + dir[1] * sy), 1 - b.h);
  }
  rec.persist(b);
  rec.refresh();
  ov.render();        // reflect the nudge on the overlay immediately
  drawEdges(); autosave();
  ev.preventDefault();
});

function persistBox(winId, b) {
  const box = { x: b.x, y: b.y, w: b.w, h: b.h };
  if (b.role === "anchor") model.setAnchorBox(winId, b.id, box);
  else if (b.role === "scrollbar") model.setScrollbar(winId, box);
  else if (b.role === "data_area") model.setDataArea(winId, box);
  else model.setRegionBox(winId, b.id, box);
}
// Live loop: continuously recapture open images + re-evaluate, and (if 'save' is on)
// run a collection tick. Default off.
// ---- live processing stats (top bar) --------------------------------------
let liveFrames = 0, liveT0 = 0, liveFps = 0, liveProcessing = false, liveLast = "";
function showLiveStats(on) {
  const el = $("livestats");
  if (!el) return;
  el.hidden = !on;
  liveFrames = 0; liveT0 = on ? performance.now() : 0; liveFps = 0;
  if (!on) el.textContent = "";
  else renderLiveStats();
}
function renderLiveStats() {
  const now = performance.now();
  if (liveT0 && now - liveT0 >= 1000) {            // recompute rate over a ~1s window
    liveFps = (liveFrames * 1000) / (now - liveT0);
    liveFrames = 0; liveT0 = now;
  }
  const el = $("livestats");
  if (!el || el.hidden) return;
  const state = liveProcessing ? "processing" : "idle";
  el.innerHTML = `<span class="live-dot ${liveProcessing ? "on" : ""}"></span>${state} · ${liveFps.toFixed(1)} img/s${liveLast ? ` · ${esc(liveLast)}` : ""}`;
}

async function liveTick() {
  refreshLive();   // dataset counts always
  const game = model.profile.name;
  if (!game) { renderLiveStats(); return; }
  liveProcessing = true; renderLiveStats();
  if ($("liveToggle").checked) {
    for (const [winId, entry] of imageCanvases) {
      try {
        const { url } = await api.capture(game, false);   // live frame, not stashed
        const img = new Image();
        img.onload = () => { entry.overlay.setImage(img); refreshImageBoxes(winId); };
        img.src = url;
        liveFrames++;                                      // count captured frames for img/s
      } catch { /* window gone */ }
      refreshDetect(winId, true);
      if (previewPanels.has(winId)) refreshPreview(winId, true);
    }
  }
  if ($("saveToggle").checked) {
    try { const r = await api.collect(game); liveFrames++; liveLast = `${r.status} new=${r.new} total=${r.total}`; setStatus(`collect: ${liveLast}`); }
    catch (e) { setStatus(String(e.message || e)); }
  }
  liveProcessing = false; renderLiveStats();
}

function setLive() {
  if (timer) { clearInterval(timer); timer = null; }
  const on = $("liveToggle").checked || $("saveToggle").checked;
  showLiveStats(on);
  if (on) timer = setInterval(liveTick, 1500);
}

// ---- init -----------------------------------------------------------------

refreshGames().then(() => {
  if ($("gameSelect").value) loadGame($("gameSelect").value);
  setLive();
});
