// Node-view home: edit a game's structure as a graph (Game → Windows → Fields →
// Datasets), drag to arrange, drag-wire a window to a dataset, edit inline, and
// watch live dataset counts. Box drawing stays on the canvas (teach.html link).
import * as api from "../api.js";
import { esc } from "../dom.js";
import { openModal } from "../modal.js";
import { Overlay } from "../overlay.js";
import { log, timed, fmtDur } from "../log.js";
import { GraphModel } from "./model.js";
import { EdgeRouter, polylinePath } from "./route.js";

const $ = (id) => document.getElementById(id);
const setStatus = (m) => log(m);   // #status is gone — the log bar shows messages now
const model = new GraphModel();
const pos = new Map();            // node id -> {x,y}
const nodeEls = new Map();        // node id -> DOM element (built once, reused)
const collapsed = new Set();      // collapsed node ids
const view = { panX: 0, panY: 0, zoom: 1 };  // canvas pan/zoom
const COLX = { game: 20, window: 300, preview: 1580, region: 600, anchor: 600, state: 600, scrollbar: 600, dataset: 900, batches: 1180 };
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
const openImages = new Set();     // winIds whose image is loaded into the window node (persisted)
const nodeSizes = new Map();      // node id -> {w,h} for resizable nodes (persisted)
let pendingOpenImages = [];
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

// ---- background worker registry -------------------------------------------
// Anything doing real background work — the backend precapture worker, the live
// re-read loop, future long jobs — registers here. The log bar then shows a live
// count on its far right plus a per-worker emergency kill button.
const workers = new Map();   // id -> { label, kill }
function registerWorker(id, label, kill) {
  const w = workers.get(id);
  if (w) { w.kill = kill; if (w.label === label) return; w.label = label; }   // same label -> nothing visible changed
  else workers.set(id, { label, kill });
  renderWorkers();
}
function unregisterWorker(id) { if (workers.delete(id)) renderWorkers(); }

// Reconcile the indicator IN PLACE — never rebuild innerHTML (the precapture poll
// re-registers every 700ms; rebuilding would restart the spinner animation and churn
// the buttons every tick). Fixed spinner + count are made once; buttons are reused.
let wkSpin = null, wkCount = null;
const workerBtns = new Map();   // id -> <button>
function renderWorkers() {
  const el = $("logWorkers");
  if (!el) return;
  el.hidden = workers.size === 0;
  if (!wkSpin) {
    wkSpin = document.createElement("span"); wkSpin.className = "lw-spin";
    wkCount = document.createElement("span"); wkCount.className = "lw-count";
    el.append(wkSpin, wkCount);
  }
  wkCount.textContent = `${workers.size} worker${workers.size === 1 ? "" : "s"}`;
  for (const [id, btn] of workerBtns) if (!workers.has(id)) { btn.remove(); workerBtns.delete(id); }
  for (const [id, w] of workers) {
    let btn = workerBtns.get(id);
    if (!btn) {
      btn = document.createElement("button");
      btn.className = "lw-kill"; btn.dataset.kill = id; btn.title = "emergency stop";
      el.appendChild(btn); workerBtns.set(id, btn);
    }
    if (btn._label !== w.label) { btn.textContent = `⨯ ${w.label}`; btn._label = w.label; }
  }
}

// Kill a worker from the log bar (don't let the click toggle the log open).
$("logWorkers").addEventListener("click", (ev) => {
  ev.stopPropagation();
  const b = ev.target.closest("button[data-kill]");
  if (!b) return;
  const w = workers.get(b.dataset.kill);
  if (!w) return;
  setStatus(`killing ${w.label}…`);
  try { w.kill(); } catch (e) { setStatus(String(e.message || e)); }
  unregisterWorker(b.dataset.kill);
});

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
    for (const k in (raw.nodeSizes || {})) nodeSizes.set(k, raw.nodeSizes[k]);
    if (raw.view && Number.isFinite(raw.view.zoom)) Object.assign(view, raw.view);
  } catch { /* ignore */ }
}
function savePositions() {
  try {
    localStorage.setItem(posKey(), JSON.stringify({
      positions: Object.fromEntries(pos), collapsed: [...collapsed],
      openImages: [...openImages], nodeSizes: Object.fromEntries(nodeSizes), view,
    }));
  } catch { /* ignore */ }
}

const TYPES = [["text", "text"], ["number", "number"], ["pips", "pips"], ["diamonds", "diamonds (rank)"]];
const EXTRACTS = ["whole", "number", "number_before", "number_after", "text_before", "text_after"];
const NEEDS_SEP = new Set(["number_before", "number_after", "text_before", "text_after"]);

// ---- layout ---------------------------------------------------------------

function elForPos(id) {
  return nodeEls.get(id);   // everything is a node now (image/preview/data/batches all in-node)
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

function windowControls(w) {
  // The dataset (not the window) owns dedup now — the key field lives on the dataset
  // node. The window just shows where its records flow + the image/delete actions.
  return `<div class="muted">→ ${esc(model.datasetOf(w))}</div>
    <div class="gn-foot"><button class="imgbtn">📷 image</button><button class="delwin danger">remove</button></div>`;
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
    <div class="gn-foot"><button class="delitem danger">remove</button></div>`;
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
  div.querySelector(".delwin").addEventListener("click", () => { closeImage(n.ref.id); model.removeWindow(n.ref.id); pos.delete(n.id); render(); autosave(); });
}

function nodeParts(n) {
  if (n.type === "game") {
    const g = n.ref;
    return {
      title: `<input class="gi gi-id" data-k="name" value="${esc(g.name)}" title="game name" />`,
      body: `
        <label class="flab">process <input class="gi" data-k="proc" value="${esc((g.process_names || []).join(", "))}" placeholder="Warframe.x64.exe" /></label>
        <label class="flab">title hint <input class="gi" data-k="title" value="${esc(g.window_title_hint || "")}" placeholder="Warframe" /></label>
        <div class="gn-foot"><button class="addwin">+ window</button></div>`,
    };
  }
  if (n.type === "window") {
    const w = n.ref;
    return {
      title: `<input class="gi gi-id" data-k="winid" value="${esc(w.id)}" />`,
      body: `<div class="win-controls">${windowControls(w)}</div><div class="win-img"></div>`,
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
        <div class="gn-foot"><button class="delregion danger">remove</button></div>`,
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
        <div class="gn-foot"><button class="delanchor danger">remove</button></div>`,
    };
  }
  if (n.type === "item") {
    return { title: `<input class="gi gi-id" data-k="itemid" value="${esc(n.ref.id)}" title="item template" />`,
      body: `<div class="item-img"></div><div class="item-lists">${itemLists(n.ref, n.win)}</div>` };
  }
  if (n.type === "scrollbar") {
    const o = n.ref.scrollbar_orientation || "vertical";
    return {
      title: "scrollbar",
      body: `<label class="flab">orientation <select class="sbset" data-k="orient">
          <option ${o === "vertical" ? "selected" : ""}>vertical</option>
          <option ${o === "horizontal" ? "selected" : ""}>horizontal</option></select></label>
        <div class="detect-status muted">position: —</div>
        <div class="gn-foot"><button class="delsb danger">remove</button></div>`,
    };
  }
  if (n.type === "preview") {
    // live-read node — what the current layout would read from this window. Runs OCR
    // on demand (its own button, or the image's 👁), rendered inline.
    return {
      title: `<span class="gi-id">${esc(n.ref.id)} preview</span>`,
      body: `<div class="gn-foot"><button class="prevrun">↻ read</button></div>
      <div class="nodehost scrollhost prev-host"><p class="muted" style="padding:8px">↻ read to preview what this window reads</p></div>`,
    };
  }
  if (n.type === "batches") {
    // ledger node — shows the dataset's collection/save runs inline; pick one to see
    // its events + a preview of what applying it changes.
    return {
      title: `<span class="gi-id">${esc(n.ref)} batches</span>`,
      body: `<div class="nodehost scrollhost bat-host">
        <ul class="history bat-list"><li class="muted">loading…</li></ul>
        <div class="bat-detail muted">select a batch to see its contents and what applying it changes</div>
      </div>`,
    };
  }
  // dataset — owns the dedup key. Key options = the fields of every window feeding it.
  const ds = n.ref;
  const d = live[ds] || { present: 0, total: 0, last_op: null, last_ts: null };
  const pulse = prevPresent[ds] !== undefined && prevPresent[ds] !== d.present ? "pulse" : "";
  const key = model.datasetKey(ds);
  const fids = model.datasetFields(ds);
  const keyOpts = (fids.includes(key) ? fids : [key, ...fids]).map((f) => `<option ${f === key ? "selected" : ""}>${esc(f)}</option>`).join("");
  return {
    title: `<input class="gi gi-id dsrename" value="${esc(ds)}" title="dataset name" />`,
    body: `<div class="big">${d.present}<span class="muted"> / ${d.total}</span></div>
      <div class="muted">${d.last_op ? esc(d.last_op) : "—"} ${d.last_ts ? esc(d.last_ts.slice(11)) : ""}</div>
      <label class="flab" title="field whose value identifies a row — reads with the same value merge">key <select class="dskey">${keyOpts}</select></label>
      <label class="flab" title="ignore spaces/punctuation when matching keys">strip non-alnum <input type="checkbox" class="dsstrip" ${model.datasetStrip(ds) ? "checked" : ""}></label>
      <label class="flab" title="treat keys differing only in case as distinct">case sensitive <input type="checkbox" class="dscase" ${model.datasetCase(ds) ? "checked" : ""}></label>
      <div class="gn-foot"><button class="dsclone">clone</button><button class="dsclear danger">clear data</button></div>
      <div class="nodehost scrollhost data-host"><p class="muted" style="padding:8px">loading…</p></div>`,
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

// Make a node's content host (`.nodehost`) user-resizable; the node itself stays a
// normal node (header/body identical to every other node — only the scroll box
// resizes). Restores + persists the host size, grid-snapped on release.
function makeHostResizable(div, id) {
  const host = div.querySelector(".nodehost");
  if (!host) return;
  const s = nodeSizes.get(id);
  if (s) { if (s.w) host.style.width = `${s.w}px`; if (s.h) host.style.height = `${s.h}px`; }
  snapResize(host, {
    both: true,
    onResize: drawEdges,
    onSettle: () => { nodeSizes.set(id, { w: host.offsetWidth, h: host.offsetHeight }); drawEdges(); savePositions(); },
  });
}

function buildNode(n) {
  const div = document.createElement("div");
  div.id = `node-${n.id}`;
  div.dataset.id = n.id;
  fillNode(div, n);
  if (n.type === "item") snapResize(div, { onResize: drawEdges });   // item node resizes by width (its cutout)
  if (n.type === "dataset" || n.type === "preview" || n.type === "batches") makeHostResizable(div, n.id);
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
    if (ctl) { ctl.innerHTML = windowControls(n.ref); wireWindowControls(el, n); }
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
  // a SELECTED preview, or the batches ledger, scrolls its content; everywhere else zoom
  if (ev.target.closest(".scrollhost")) return;
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

// Bezier whose tangents leave each endpoint along an outward direction (L/R/T/B) so
// the line starts the right way. This is the LIVE line: shown while a node is being
// dragged (follows the cursor), and the shape a routed line morphs out of on settle.
const _OFFK = (x1, y1, x2, y2) => Math.max(30, Math.hypot(x2 - x1, y2 - y1) * 0.4);
const _DIROFF = { L: [-1, 0], R: [1, 0], T: [0, -1], B: [0, 1] };
function dirBezierCtrls(x1, y1, d1, x2, y2, d2) {
  const k = _OFFK(x1, y1, x2, y2);
  const a = _DIROFF[d1] || [0, 0], b = _DIROFF[d2] || [0, 0];
  return [[x1 + a[0] * k, y1 + a[1] * k], [x2 + b[0] * k, y2 + b[1] * k]];
}
function dirBezierD(x1, y1, d1, x2, y2, d2) {
  const [c1, c2] = dirBezierCtrls(x1, y1, d1, x2, y2, d2);
  return `M ${x1} ${y1} C ${c1[0]} ${c1[1]}, ${c2[0]} ${c2[1]}, ${x2} ${y2}`;
}
function sampleDirBezier(x1, y1, d1, x2, y2, d2, n) {
  const [c1, c2] = dirBezierCtrls(x1, y1, d1, x2, y2, d2);
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push([u * u * u * x1 + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * x2,
              u * u * u * y1 + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * y2]);
  }
  return out;
}

// Resample a polyline to n+1 points spread evenly by arc length — so two shapes with
// different vertex counts can be lerped point-for-point during a morph.
function resamplePoly(pts, n) {
  if (pts.length < 2) return Array.from({ length: n + 1 }, () => (pts[0] || [0, 0]).slice());
  const seg = []; let total = 0;
  for (let i = 0; i < pts.length - 1; i++) { const l = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]); seg.push(l); total += l; }
  if (total === 0) return Array.from({ length: n + 1 }, () => pts[0].slice());
  const out = []; let si = 0, acc = 0;
  for (let i = 0; i <= n; i++) {
    const target = (total * i) / n;
    while (si < seg.length - 1 && acc + seg[si] < target) { acc += seg[si]; si++; }
    const t = seg[si] ? (target - acc) / seg[si] : 0;
    out.push([pts[si][0] + (pts[si + 1][0] - pts[si][0]) * t, pts[si][1] + (pts[si + 1][1] - pts[si][1]) * t]);
  }
  return out;
}
const straightD = (pts) => "M " + pts.map((p) => `${Math.round(p[0] * 10) / 10} ${Math.round(p[1] * 10) / 10}`).join(" L ");

// Closest-facing sides of two rects (shortest centre axis): the port point and
// outward direction (L/R/T/B) on each. Shared by the bezier draw and the router.
function facingSides(ra, rb) {
  const acx = ra.x + ra.w / 2, acy = ra.y + ra.h / 2, bcx = rb.x + rb.w / 2, bcy = rb.y + rb.h / 2;
  const dx = bcx - acx, dy = bcy - acy;
  if (Math.abs(dx) >= Math.abs(dy)) {
    if (dx >= 0) return { p1: [ra.x + ra.w, acy], d1: "R", p2: [rb.x, bcy], d2: "L" };
    return { p1: [ra.x, acy], d1: "L", p2: [rb.x + rb.w, bcy], d2: "R" };
  }
  if (dy >= 0) return { p1: [acx, ra.y + ra.h], d1: "B", p2: [bcx, rb.y], d2: "T" };
  return { p1: [acx, ra.y], d1: "T", p2: [bcx, rb.y + rb.h], d2: "B" };
}

const nodeRect = (id) => { const p = pos.get(id); return p && { x: p.x, y: p.y, w: nw(id), h: nh(id) }; };

// ---- one unified link list -------------------------------------------------
// EVERY connection in the view is the same thing: a line between two NODES — always to
// the node rect, never to a box on the image. They all flow through buildLinks →
// routing → drawn on a persistent per-link <path>. No bespoke per-kind drawing.
function selClsFor(aId, bId) {
  return selectedNodeId && (aId === selectedNodeId || bId === selectedNodeId) ? " sel" : "";
}

// Build the descriptor for every line. `aId`/`bId` name each rect's owner (used to
// fan endpoints that share a node side); `ra`/`rb` are the world rects.
function buildLinks() {
  const links = [];
  const add = (key, aId, bId, top, kind, ra, rb) => {
    if (ra && rb) links.push({ key, aId, bId, top, cls: `gedge ${kind}${selClsFor(aId, bId)}`, ra, rb });
  };
  for (const e of model.edges())
    add(`${e.from} ${e.to}`, e.from, e.to, !!selClsFor(e.from, e.to), e.kind, nodeRect(e.from), nodeRect(e.to));
  computePorts(links);
  return links;
}

// Pick each line's port + side, then fan endpoints that share a node side so they sit
// one GAP apart instead of all stacking on the side's midpoint.
const GAP = () => ROUTE.cell * 2;   // preferred spacing: fanned endpoints AND parallel bundles (a line can still squeeze to 1 cell between two)
function computePorts(links) {
  for (const l of links) { const f = facingSides(l.ra, l.rb); l.p1 = f.p1; l.d1 = f.d1; l.p2 = f.p2; l.d2 = f.d2; }
  const buckets = new Map();   // `${owner}|${dir}` -> endpoints on that rect side
  const put = (owner, dir, l, end, other) => {
    const horiz = dir === "L" || dir === "R";
    const perp = horiz ? other.y + other.h / 2 : other.x + other.w / 2;
    const k = `${owner}|${dir}`;
    (buckets.get(k) || buckets.set(k, []).get(k)).push({ l, end, perp, horiz });
  };
  for (const l of links) { put(l.aId, l.d1, l, "a", l.rb); put(l.bId, l.d2, l, "b", l.ra); }
  const gap = GAP();
  for (const arr of buckets.values()) {
    if (arr.length < 2) continue;
    arr.sort((u, v) => u.perp - v.perp);   // order by where each other end sits → no crossing
    const n = arr.length;
    arr.forEach((it, i) => {
      const rect = it.end === "a" ? it.l.ra : it.l.rb;
      const lo = it.horiz ? rect.y : rect.x, span = it.horiz ? rect.h : rect.w;
      const spread = Math.max(0, Math.min(span - gap, (n - 1) * gap));   // keep ports on the edge
      const coord = lo + span / 2 - spread / 2 + (i * spread) / (n - 1);
      const port = it.end === "a" ? it.l.p1 : it.l.p2;
      if (it.horiz) port[1] = coord; else port[0] = coord;
    });
  }
}

// Persistent <path> per link (NOT rebuilt each draw) — lets a line keep its identity
// so it can follow the cursor live, then morph into its routed shape on settle.
const edgeEls = new Map();   // link key -> <path>
let wireEl = null;
let tweenRoutes = false;     // set by runRouting so the NEXT draw morphs the lines that changed

function edgeEl(key, layer) {
  let el = edgeEls.get(key);
  if (!el) { el = document.createElementNS(SVGNS, "path"); edgeEls.set(key, el); }
  if (el.parentNode !== layer) layer.appendChild(el);
  return el;
}
function cancelMorph(el) { if (el && el._raf) { cancelAnimationFrame(el._raf); el._raf = null; } }
function setRouted(el, pts) {
  cancelMorph(el);
  el._geo = pts; el._routed = true;
  el.setAttribute("d", polylinePath(pts, ROUTE.corners, ROUTE.radius));
}
function setBezier(el, l) {
  cancelMorph(el);
  el._geo = sampleDirBezier(l.p1[0], l.p1[1], l.d1, l.p2[0], l.p2[1], l.d2, 24);
  el._routed = false;
  el.setAttribute("d", dirBezierD(l.p1[0], l.p1[1], l.d1, l.p2[0], l.p2[1], l.d2));
}

const MORPH_MS = 150, MORPH_N = 32;
function startMorph(el, toPts) {
  const from = resamplePoly(el._geo && el._geo.length ? el._geo : toPts, MORPH_N);
  const to = resamplePoly(toPts, MORPH_N);
  cancelMorph(el);
  const t0 = performance.now();
  const tick = (now) => {
    let t = (now - t0) / MORPH_MS; if (t < 0) t = 0; if (t > 1) t = 1;
    const e = t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;   // easeInOutQuad
    el.setAttribute("d", straightD(from.map((p, i) => [p[0] + (to[i][0] - p[0]) * e, p[1] + (to[i][1] - p[1]) * e])));
    if (t < 1) el._raf = requestAnimationFrame(tick);
    else { el._raf = null; setRouted(el, toPts); }   // land on the crisp rounded route
  };
  el._raf = requestAnimationFrame(tick);
}
// cache route still matches the link's live ports? (node not moved since it was routed)
function routeFresh(c, l) { return c.k === `${rnd(l.p1)}${l.d1}${rnd(l.p2)}${l.d2}`; }
function geoChanged(el, pts) {
  if (!el._routed || !el._geo || el._geo.length !== pts.length) return true;
  for (let i = 0; i < pts.length; i++)
    if (Math.abs(el._geo[i][0] - pts[i][0]) > 0.5 || Math.abs(el._geo[i][1] - pts[i][1]) > 0.5) return true;
  return false;
}

let drawSig = "";   // link signature for THIS draw (compared against the route cache's)
function drawEdges() {
  const svg = $("gedges"), top = $("gedges-top");
  const links = buildLinks();
  drawSig = ROUTE.enabled ? linksSig(links) : "";
  const used = new Set();
  for (const l of links) {
    used.add(l.key);
    const el = edgeEl(l.key, l.top ? top : svg);
    el.setAttribute("class", l.cls);
    const c = routeCache.get(l.key);
    if (c && c.pts.length >= 2 && routeFresh(c, l)) {        // have a current route for this line
      if (tweenRoutes && geoChanged(el, c.pts)) startMorph(el, c.pts);
      else if (!el._raf && geoChanged(el, c.pts)) setRouted(el, c.pts);   // only redraw if it changed; leave morphs alone
    } else {
      setBezier(el, l);                                     // no/stale route → live bezier follows the drag
    }
  }
  for (const [k, el] of edgeEls) if (!used.has(k)) { cancelMorph(el); el.remove(); edgeEls.delete(k); }
  if (wire) {
    if (!wireEl) wireEl = document.createElementNS(SVGNS, "path");
    if (wireEl.parentNode !== svg) svg.appendChild(wireEl);
    wireEl.setAttribute("class", "gedge wire");
    const dx = Math.max(30, (wire.x2 - wire.x1) / 2);
    wireEl.setAttribute("d", `M ${wire.x1} ${wire.y1} C ${wire.x1 + dx} ${wire.y1}, ${wire.x2 - dx} ${wire.y2}, ${wire.x2} ${wire.y2}`);
  } else if (wireEl) { wireEl.remove(); wireEl = null; }
  tweenRoutes = false;
  scheduleRouting();
}

// ---- deferred line routing ------------------------------------------------
// Pathfinding runs OFF the drag loop: drawEdges() paints direct beziers instantly
// and asks for a route; the actual A* fires once movement settles (debounced), then
// repaints with neat routed paths. Routes are cached by layout signature, so a pass
// where nothing moved is a no-op.
const ROUTE = {
  enabled: true,
  corners: "curve",   // "curve" | "square" — internal toggle (window.__route.corners)
  cell: 10,           // grid resolution (world px) — fine enough to squeeze a line between two others
  clearWanted: 5,     // cells of breathing room a line prefers around nodes
  radius: 14,         // corner rounding for "curve"
  debounce: 90,       // ms of stillness before routing
};
// internal handles: tweak ROUTE in the console, __reroute() to force a recompute
// (e.g. after flipping __route.corners to "square").
if (typeof window !== "undefined") {
  window.__route = ROUTE;
  window.__reroute = () => { routeCache = new Map(); routeHash = ""; drawEdges(); };   // force a full recompute
}

const SVGNS = "http://www.w3.org/2000/svg";
let routeCache = new Map();     // link key -> { pts:[[x,y]…], sig } (sig = its own deps)
let routeHash = "";             // global layout signature of the last pass (cheap change gate)
let routeTimer = null;

// Everything physical is an obstacle: nodes AND panels. Lines weave around all of
// them, not just the two rects they connect.
function obstacleRects() {
  const out = [];
  for (const n of model.nodes()) { const r = nodeRect(n.id); if (r) out.push(r); }
  return out;
}

// Signature that invalidates the route cache: the ports of every link plus every
// obstacle rect. Any move/resize/open/close changes it (a moved node can reshape a
// route it isn't even an endpoint of, so obstacles must be in here too).
const rnd = (p) => `${Math.round(p[0])},${Math.round(p[1])}`;
function linksSig(links) {
  let s = `${ROUTE.cell}:${ROUTE.clearWanted}:`;
  for (const l of links) s += `${l.key}@${rnd(l.p1)}${l.d1}${rnd(l.p2)}${l.d2};`;
  for (const o of obstacleRects()) s += `${o.x},${o.y},${o.w},${o.h}|`;
  return s;
}

function scheduleRouting() {
  if (!ROUTE.enabled) return;
  if (drawSig === routeHash) return;   // routes already current (drawSig set in drawEdges)
  clearTimeout(routeTimer);
  routeTimer = setTimeout(runRouting, ROUTE.debounce);
}

// A link's OWN dependency signature: its endpoints + only the obstacles whose rect
// touches the region its route can occupy (endpoints + last path, padded by the
// clearance margin). So a node moving on the far side of the graph leaves this
// unchanged — that link is NOT rerouted.
function linkDeps(link, obs) {
  const M = ROUTE.cell * (ROUTE.clearWanted + 2);
  let minx = Math.min(link.p1[0], link.p2[0]), maxx = Math.max(link.p1[0], link.p2[0]);
  let miny = Math.min(link.p1[1], link.p2[1]), maxy = Math.max(link.p1[1], link.p2[1]);
  const prev = routeCache.get(link.key);
  if (prev) for (const p of prev.pts) {
    if (p[0] < minx) minx = p[0]; else if (p[0] > maxx) maxx = p[0];
    if (p[1] < miny) miny = p[1]; else if (p[1] > maxy) maxy = p[1];
  }
  minx -= M; miny -= M; maxx += M; maxy += M;
  let s = `${rnd(link.p1)}${link.d1}${rnd(link.p2)}${link.d2}|`;
  for (const o of obs)
    if (o.x < maxx && o.x + o.w > minx && o.y < maxy && o.y + o.h > miny) s += `${o.x},${o.y},${o.w},${o.h};`;
  return s;
}

function runRouting() {
  const links = buildLinks();          // route the layout as it stands NOW
  const sig = linksSig(links);
  if (sig === routeHash) return;
  const obs = obstacleRects();
  const t0 = performance.now();
  try {
    // split into links whose deps are unchanged (keep their cached path) and the rest
    const fresh = new Map(), dirty = [];
    for (const l of links) {
      const lsig = linkDeps(l, obs);
      const c = routeCache.get(l.key);
      if (c && c.sig === lsig) fresh.set(l.key, c);
      else { l._sig = lsig; dirty.push(l); }
    }
    const router = new EdgeRouter(obs, { cell: ROUTE.cell, clearWanted: ROUTE.clearWanted });
    for (const c of fresh.values()) router.stampPath(c.pts);   // reserve the kept corridors so dirty links avoid them
    dirty.sort((a, b) => spanOf(a) - spanOf(b));               // shortest first: short links lock in straight
    for (const l of dirty)
      fresh.set(l.key, { pts: router.route(l.p1, l.d1, l.p2, l.d2), sig: l._sig, k: `${rnd(l.p1)}${l.d1}${rnd(l.p2)}${l.d2}` });
    routeCache = fresh;                                        // also drops keys for links that vanished
    routeHash = sig;
    setStatus(`routed ${dirty.length}/${links.length} line${links.length === 1 ? "" : "s"} in ${fmtDur(performance.now() - t0)}`);
  } catch (err) {
    setStatus(`route failed: ${err.message}`);   // surface instead of silently using beziers
    return;
  }
  tweenRoutes = true;   // the freshly-routed lines morph from their live bezier into the route
  drawEdges();
}

function spanOf(l) {
  return Math.abs(l.p2[0] - l.p1[0]) + Math.abs(l.p2[1] - l.p1[1]);
}

// ---- per-node interaction -------------------------------------------------

function wireNode(div, n) {
  // drag-move from anywhere on the node except interactive controls (so all
  // edges/padding/labels work, not just the header)
  div.addEventListener("mousedown", (ev) => {
    if (ev.button !== 0) return;   // only left-drag moves; right-drag pans the canvas
    if (ev.target.closest("input,select,button,a,.collapse,.canvas-wrap,[contenteditable],.scrollhost")) return;  // .canvas-wrap: resize handle; .scrollhost: scroll/edit node content
    const r = div.getBoundingClientRect();   // skip the CSS resize-handle corner (resizable nodes)
    if (ev.clientX > r.right - 18 && ev.clientY > r.bottom - 18) return;
    focusNode(n.id);   // select on click / drag start (every node is focusable)
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
      if (model.addWindow()) { render(); autosave(); }   // default id; renamed in the window node
    });
  } else if (n.type === "window") {
    wireWindowControls(div, n);
  } else if (n.type === "preview") {
    div.querySelector(".prevrun")?.addEventListener("click", () => refreshPreview(n.ref.id));
  } else if (n.type === "dataset") {
    div.querySelector(".dsrename")?.addEventListener("change", (e) => {
      if (model.renameDataset(n.ref, e.target.value)) { render(); autosave(); } else e.target.value = n.ref;
    });
    div.querySelector(".dskey")?.addEventListener("change", (e) => { model.setDatasetKey(n.ref, e.target.value); autosave(); });
    div.querySelector(".dsstrip")?.addEventListener("change", (e) => { model.setDatasetStrip(n.ref, e.target.checked); autosave(); });
    div.querySelector(".dscase")?.addEventListener("change", (e) => { model.setDatasetCase(n.ref, e.target.checked); autosave(); });
    div.querySelector(".dsclone")?.addEventListener("click", () => { model.cloneDataset(n.ref); render(); autosave(); });
    const clearBtn = div.querySelector(".dsclear");
    clearBtn?.addEventListener("click", async () => {
      if (clearBtn.dataset.armed !== "1") {   // inline confirm (no blocking dialogs)
        clearBtn.dataset.armed = "1"; clearBtn.textContent = "confirm?";
        setTimeout(() => { clearBtn.dataset.armed = "0"; clearBtn.textContent = "clear data"; }, 2500);
        return;
      }
      try { await api.clearDataset(model.profile.name, n.ref); refreshLive(); refreshDataNode(n.ref); refreshAllBatchesNodes(); setStatus(`cleared ${n.ref}`); }
      catch (e) { setStatus(String(e.message || e)); }
    });
    queueMicrotask(() => refreshDataNode(n.ref));   // load records into the node body
  } else if (n.type === "batches") {
    queueMicrotask(() => loadBatchesNode(n.ref));   // nodeEls is set after buildNode returns
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

// ---- dataset records (rendered inline in the dataset node body) ----

function dataHost(ds) {
  const el = nodeEls.get(`ds:${ds}`);
  return el && el.querySelector(".data-host");
}
// refresh every dataset node that currently exists (after save / clear / live change)
function refreshAllDataNodes() {
  for (const ds of model.datasets()) if (nodeEls.has(`ds:${ds}`)) refreshDataNode(ds);
}
async function refreshDataNode(ds) {
  const host = dataHost(ds);
  if (!host) return;
  try {
    const r = await fetch(`/api/flow/${encodeURIComponent(model.profile.name)}/dataset/${encodeURIComponent(ds)}`);
    host.innerHTML = datasetDetailHTML(await r.json());
  } catch (e) { host.innerHTML = `<p class="muted" style="padding:8px">${esc(String(e))}</p>`; }
}

function datasetDetailHTML(d) {
  const recs = d.records || [];
  let table = '<p class="muted" style="padding:8px">no records</p>';
  if (recs.length) {
    const cols = [...new Set(recs.flatMap((r) => Object.keys(r)))].filter((c) => !["present", "first_seen", "last_seen"].includes(c));
    const head = cols.map((c) => `<th>${esc(c)}</th>`).join("");
    const rows = recs.map((r) => `<tr class="${r.present ? "" : "gone"}">${cols.map((c) => `<td>${esc(r[c] ?? "")}</td>`).join("")}</tr>`).join("");
    table = `<table class="grid-table zebra"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
  }
  return `<div class="ds-detail">
    <div class="prev-count muted">${recs.length} records</div>
    ${table}
  </div>`;
}

// ---- batches node (ledger + per-batch contents/preview, embedded in the node) ----

const batchesState = new Map();   // ds -> { sel, events } (selection + event cache per node)

function batEls(ds) {
  const el = nodeEls.get(`bat:${ds}`);
  return el && { list: el.querySelector(".bat-list"), detail: el.querySelector(".bat-detail") };
}
function batState(ds) {
  if (!batchesState.has(ds)) batchesState.set(ds, { sel: null, events: {} });
  return batchesState.get(ds);
}

// (re)fetch the ledger and paint it into the node body — called on build and whenever
// the dataset's batches change (save / revert / edit / remove). No refresh button.
async function loadBatchesNode(ds) {
  const els = batEls(ds);
  if (!els) return;
  try {
    const r = await fetch(`/api/flow/${encodeURIComponent(model.profile.name)}/dataset/${encodeURIComponent(ds)}`);
    renderBatchesList(ds, (await r.json()).batches || []);
  } catch (e) { els.list.innerHTML = `<li class="muted">${esc(String(e))}</li>`; }
}

// refresh every batches node that currently exists
function refreshAllBatchesNodes() {
  for (const ds of model.datasets()) if (nodeEls.has(`bat:${ds}`)) loadBatchesNode(ds);
}

function renderBatchesList(ds, batches) {
  const els = batEls(ds);
  if (!els) return;
  const st = batState(ds);
  if (!batches.length) { els.list.innerHTML = '<li class="muted">no batches yet</li>'; els.detail.innerHTML = ""; st.sel = null; return; }
  els.list.innerHTML = batches.map((b) => {
    const parts = [b.adds ? `+${b.adds}` : "", b.updates ? `~${b.updates}` : "", b.removes ? `−${b.removes}` : ""].filter(Boolean).join(" ");
    const keys = (b.keys || []).slice(0, 4).join(", ") + (b.count > 4 ? " …" : "");
    const app = `<label class="led-apply" title="apply this batch to the dataset (uncheck to revert it)"><input type="checkbox" class="led-toggle" data-batch="${b.batch}"${b.reverted ? "" : " checked"}> applied</label>`;
    const rm = `<button class="led-remove danger" data-batch="${b.batch}" title="permanently delete this batch from the ledger">remove</button>`;
    return `<li class="batrow ${b.reverted ? "reverted" : ""}${st.sel === b.batch ? " sel" : ""}" data-batch="${b.batch}">
      <span class="muted">${esc((b.ts || "").slice(11))}</span> <b>#${b.batch}</b>
      <span class="muted batmeta" title="${parts} · ${b.count} · ${esc(keys)}">${parts} · ${b.count} · ${esc(keys)}</span> ${app} ${rm}</li>`;
  }).join("");
  // select on row click (but not when hitting the checkbox/remove)
  els.list.querySelectorAll(".batrow").forEach((li) => li.addEventListener("click", (ev) => {
    if (ev.target.closest(".led-apply,.led-remove")) return;
    selectBatch(ds, +li.dataset.batch);
  }));
  els.list.querySelectorAll(".led-toggle").forEach((cb) => cb.addEventListener("change", async () => {
    cb.disabled = true;
    try {
      await api.revertDatasetBatch(model.profile.name, ds, +cb.dataset.batch, !cb.checked);
      refreshLive(); refreshDataNode(ds); loadBatchesNode(ds);
    } catch (e) { cb.disabled = false; cb.checked = !cb.checked; setStatus(String(e.message || e)); }
  }));
  els.list.querySelectorAll(".led-remove").forEach((b) => b.addEventListener("click", async () => {
    if (b.dataset.armed !== "1") { b.dataset.armed = "1"; b.textContent = "sure?"; setTimeout(() => { b.dataset.armed = "0"; b.textContent = "remove"; }, 2500); return; }
    try {
      if (st.sel === +b.dataset.batch) { st.sel = null; els.detail.innerHTML = ""; }
      await api.removeDatasetBatch(model.profile.name, ds, +b.dataset.batch);
      refreshLive(); refreshDataNode(ds); loadBatchesNode(ds);
    } catch (e) { setStatus(String(e.message || e)); }
  }));
  if (st.sel != null && batches.some((b) => b.batch === st.sel)) selectBatch(ds, st.sel);
  else if (st.sel != null) { st.sel = null; els.detail.innerHTML = ""; }
}

async function selectBatch(ds, batch) {
  const els = batEls(ds);
  if (!els) return;
  const st = batState(ds);
  st.sel = batch;
  els.list.querySelectorAll(".batrow").forEach((li) => li.classList.toggle("sel", +li.dataset.batch === batch));
  els.detail.innerHTML = '<p class="muted">loading…</p>';
  try {
    const bd = await api.batchDetail(model.profile.name, ds, batch);
    st.events = Object.fromEntries((bd.events || []).map((e) => [e.id, e]));
    renderBatchDetail(ds, bd);
  } catch (e) { els.detail.innerHTML = `<p class="muted">${esc(String(e))}</p>`; }
}

function renderBatchDetail(ds, bd) {
  const els = batEls(ds);
  if (!els) return;
  const st = batState(ds);
  const events = bd.events || [];
  const preview = bd.preview || [];
  // event contents — editable value cells; per-event applied + remove
  const cols = [...new Set(events.flatMap((e) => Object.keys(e.values || {})))];
  const evHead = `<th>id</th><th>op</th>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}<th></th><th></th>`;
  const evRows = events.map((e) => {
    const cells = cols.map((c) => `<td contenteditable="true" class="ev-cell" data-id="${e.id}" data-field="${esc(c)}">${esc(e.values?.[c] ?? "")}</td>`).join("");
    const app = `<input type="checkbox" class="ev-apply" data-id="${e.id}"${e.reverted ? "" : " checked"} title="apply this event">`;
    const rm = `<button class="ev-remove danger" data-id="${e.id}" title="permanently delete this event">✕</button>`;
    return `<tr class="${e.reverted ? "reverted" : ""}"><td class="muted">${e.id}</td><td>${esc(e.op)}</td>${cells}<td>${app}</td><td>${rm}</td></tr>`;
  }).join("");
  const evTable = events.length
    ? `<table class="grid-table zebra ev-table"><thead><tr>${evHead}</tr></thead><tbody>${evRows}</tbody></table>`
    : '<p class="muted">no events</p>';

  // preview — what applying this batch changes in the dataset
  const pvRows = preview.map((p) => {
    if (p.kind === "add") return `<tr class="pv-add"><td>add</td><td>${esc(p.key)}</td><td>${esc(fmtVals(p.after))}</td></tr>`;
    if (p.kind === "remove") return `<tr class="pv-remove"><td>remove</td><td>${esc(p.key)}</td><td>${esc(fmtVals(p.before))}</td></tr>`;
    const diff = Object.entries(p.changed || {}).map(([f, [o, nv]]) => `${esc(f)}: ${esc(o ?? "∅")} → ${esc(nv ?? "∅")}`).join("; ");
    return `<tr class="pv-update"><td>update</td><td>${esc(p.key)}</td><td>${diff}</td></tr>`;
  }).join("");
  const pvTable = preview.length
    ? `<table class="grid-table zebra pv-table"><thead><tr><th>change</th><th>key</th><th>detail</th></tr></thead><tbody>${pvRows}</tbody></table>`
    : '<p class="muted">applying this batch changes nothing</p>';

  els.detail.innerHTML = `<h4 class="ds-h">Batch #${bd.batch} · ${events.length} events</h4>${evTable}
    <h4 class="ds-h">Applying this batch would…</h4>${pvTable}`;

  // all event mutations reload the node (which re-selects + refetches the detail)
  els.detail.querySelectorAll(".ev-cell").forEach((td) => td.addEventListener("blur", async () => {
    const id = +td.dataset.id, field = td.dataset.field, ev = st.events[id];
    if (!ev) return;
    const val = td.textContent;
    if (String(ev.values?.[field] ?? "") === val) return;     // unchanged
    try {
      await api.editDatasetEvent(model.profile.name, ds, bd.batch, id, { ...ev.values, [field]: val });
      refreshLive(); refreshDataNode(ds); loadBatchesNode(ds);
    } catch (e) { setStatus(String(e.message || e)); }
  }));
  els.detail.querySelectorAll(".ev-apply").forEach((cb) => cb.addEventListener("change", async () => {
    cb.disabled = true;
    try {
      await api.revertDatasetEvent(model.profile.name, ds, bd.batch, +cb.dataset.id, !cb.checked);
      refreshLive(); refreshDataNode(ds); loadBatchesNode(ds);
    } catch (e) { cb.disabled = false; cb.checked = !cb.checked; setStatus(String(e.message || e)); }
  }));
  els.detail.querySelectorAll(".ev-remove").forEach((b) => b.addEventListener("click", async () => {
    if (b.dataset.armed !== "1") { b.dataset.armed = "1"; b.textContent = "?"; setTimeout(() => { b.dataset.armed = "0"; b.textContent = "✕"; }, 2500); return; }
    try {
      await api.removeDatasetEvent(model.profile.name, ds, bd.batch, +b.dataset.id);
      refreshLive(); refreshDataNode(ds); loadBatchesNode(ds);
    } catch (e) { setStatus(String(e.message || e)); }
  }));
}

function fmtVals(v) {
  if (!v) return "";
  return Object.entries(v).map(([k, val]) => `${k}=${val}`).join(", ");
}

// ---- precapture modal -----------------------------------------------------

let precapPoll = null;
let precapBusy = false;   // recording/processing/paused -> modal can't be dismissed
let precapStopping = false;   // a stop/cancel was clicked, awaiting the worker to wind down
let precapLastPhase = null;

async function openPrecaptureModal() {
  const game = model.profile.name;
  if (!game) { setStatus("load a game first"); return; }
  setLiveMode(false);                         // mutually exclusive with live
  precapOpen = true;
  $("precapBtn").classList.add("active");
  const node = document.createElement("div");
  node.className = "precap";
  node.innerHTML = `<p class="muted" style="padding:12px">loading…</p>`;
  const modal = openModal({
    title: `precapture: ${game}`, size: "data", node,
    // Closing ABORTS: stop polling, and tell the backend worker to cancel so it stops
    // hammering the game in the background (the cancel POST must NOT use the now-aborted
    // modal signal, or it'd cancel itself). No canClose guard — close always means stop.
    onClose: () => {
      if (precapPoll) { clearInterval(precapPoll); precapPoll = null; }
      if (precapBusy) api.precapture.cancel(game).catch(() => {});
      unregisterWorker("precap");
      precapOpen = false; precapBusy = false; precapStopping = false; $("precapBtn").classList.remove("active");
    },
  });

  const sig = modal.signal;   // wire every fetch to it → cancelled the moment the modal closes
  const draw = (st) => renderPrecap(node, st);
  const run = async (fn) => {
    try { draw(await fn()); }
    catch (e) { if (e.name !== "AbortError") setStatus(String(e.message || e)); }   // ignore close-aborts
  };

  // one delegated handler for every control button
  node.addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-act]");
    if (!b) return;
    const a = b.dataset.act;
    const mf = +node.querySelector(".pc-frames")?.value || 300;
    const iv = +node.querySelector(".pc-interval")?.value || 0;
    if (a === "recstop" || a === "cancel") { precapStopping = true; b.disabled = true; b.textContent = "stopping…"; }
    if (a === "record") run(() => api.precapture.recordStart(game, mf, iv, sig));
    else if (a === "recstop") run(() => api.precapture.recordStop(game, sig));
    else if (a === "process") run(() => api.precapture.processStart(game, sig));
    else if (a === "pause") run(() => api.precapture.pause(game, true, sig));
    else if (a === "resume") run(() => api.precapture.pause(game, false, sig));
    else if (a === "cancel") run(() => api.precapture.cancel(game, sig));
    else if (a === "reset") run(() => api.precapture.reset(game, sig));
    else if (a === "save") run(async () => { const r = await api.precapture.save(game, sig); refreshLive(); refreshAllDataNodes(); refreshAllBatchesNodes(); setStatus(`saved ${JSON.stringify(r.written)}`); return r.status; });
  });

  await run(() => api.precapture.status(game, sig));
  // poll while the modal is open so progress + staged data stay live
  precapPoll = setInterval(async () => {
    try { draw(await api.precapture.status(game, sig)); } catch { /* ignore (incl. close-abort) */ }
  }, 700);
}

function precapTable(d) {
  const rows = d.sample || [];
  const meta = `<span class="muted">${d.count} rows · key ${esc(d.key_field)}${rows.length ? ` · last ${rows.length}` : ""}</span>`;
  if (!rows.length) return `<div class="pc-ds"><b>${esc(d.dataset)}</b> ${meta}</div>`;
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const head = cols.map((c) => `<th>${esc(c)}</th>`).join("");
  const body = rows.map((r) => `<tr>${cols.map((c) => `<td>${esc(r[c] ?? "")}</td>`).join("")}</tr>`).join("");
  return `<div class="pc-ds"><b>${esc(d.dataset)}</b> ${meta}
    <table class="grid-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderPrecap(node, st) {
  const phase = st.phase || "idle";
  const recording = phase === "recording";
  const processing = phase === "processing";
  const paused = phase === "paused";
  precapBusy = recording || processing || paused;   // gate modal dismissal
  // surface the backend worker in the log bar with an emergency kill
  if (precapBusy) registerWorker("precap", `precapture ${phase}`, () => api.precapture.cancel(model.profile.name).catch(() => {}));
  else unregisterWorker("precap");
  if (phase !== precapLastPhase) {                   // log phase transitions
    if (phase === "recording") log("precapture: recording…", "run");
    else if (phase === "recorded") log(`precapture: recorded ${st.frames} frames`, "ok");
    else if (phase === "processing") log("precapture: processing…", "run");
    else if (phase === "done") { const t = st.timing || {}; log(`precapture done: ${st.processed} frames · ${t.ms_per_frame || 0} ms/frame on ${t.device || "cpu"} (decode ${t.decode_ms || 0} · classify ${t.classify_ms || 0} · read ${t.read_ms || 0}) · ${st.fps}/s · ${st.read || 0} rows read`, "ok"); }
    else if (phase === "cancelled") log("precapture: cancelled", "warn");
    else if (phase === "saved") log("precapture: saved", "ok");
    precapLastPhase = phase;
  }
  // closing always works now and cancels the run — say so on the button
  const x = node.closest(".modal")?.querySelector(".modal-x");
  if (x) x.title = precapBusy ? "close & cancel the run (Esc)" : "close (Esc)";
  const canProcess = st.frames > 0 && !recording && !processing && !paused;
  const pct = st.frames ? Math.round((100 * st.processed) / st.frames) : 0;
  const staged = (st.datasets || []).reduce((n, d) => n + d.count, 0);

  // Build the static skeleton ONCE — re-setting innerHTML each 700ms poll would
  // destroy the option inputs and steal focus while the user is typing in them.
  if (!node.querySelector(".pc-opts")) {
    node.innerHTML = `
      <div class="pc-bar"></div>
      <div class="pc-opts">
        <label class="flab">max frames <input type="number" class="pc-frames" value="300" min="1"></label>
        <label class="flab">interval ms <input type="number" class="pc-interval" value="0" min="0"></label>
      </div>
      <div class="pc-ctl"></div>
      <div class="pc-progress"><div class="pc-fill"></div></div>
      <div class="pc-data"></div>`;
  }

  const tm = st.timing || {};
  node.querySelector(".pc-bar").innerHTML = `
    <span class="pc-phase pc-${phase}">${esc(phase)}</span>
    <span class="muted">${st.frames} frames · ${st.processed} processed · ${st.read || 0} read · ${st.fps} /s</span>
    ${st.processed ? `<span class="muted">· ${tm.ms_per_frame || 0} ms/frame (${esc(tm.device || "cpu")})</span>` : ""}
    ${st.warning ? `<span class="conf-warn">⚠ ${esc(st.warning)}</span>` : ""}
    ${st.error ? `<span class="conf-bad">${esc(st.error)}</span>` : ""}`;
  if (!precapBusy) precapStopping = false;   // worker wound down -> clear the stopping state
  // while processing, ONLY pause/resume + cancel are interactable
  const busyRun = processing || paused;
  node.querySelectorAll(".pc-opts input").forEach((i) => { i.disabled = recording || busyRun; });
  const ctl = precapStopping
    ? `<button disabled>stopping…</button>`
    : `${recording ? `<button data-act="recstop"><span class="ic ic-rec">■</span> stop recording</button>`
                   : `<button data-act="record" ${busyRun ? "disabled" : ""}><span class="ic ic-rec">●</span> record</button>`}
       ${processing ? `<button data-act="pause">‖ pause</button>`
         : paused ? `<button data-act="resume">► resume</button>`
         : `<button data-act="process" ${canProcess ? "" : "disabled"}>▸ process${st.frames ? ` ${st.frames}` : ""}</button>`}
       ${busyRun ? `<button data-act="cancel" class="danger">cancel</button>` : ""}`;
  node.querySelector(".pc-ctl").innerHTML = `${ctl}
    <span class="spacer"></span>
    <button data-act="save" ${(staged && !precapStopping && !busyRun) ? "" : "disabled"}><span class="ic ic-ok">⤓</span> save${staged ? ` ${staged}` : ""}</button>
    <button data-act="reset" ${busyRun ? "disabled" : ""}>reset</button>`;
  node.querySelector(".pc-fill").style.width = `${pct}%`;
  node.querySelector(".pc-data").innerHTML = (st.datasets || []).map(precapTable).join("")
    || '<p class="muted" style="padding:8px">no data staged yet — record some frames, then process</p>';
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
  host.querySelector(".imgprev").addEventListener("click", () => refreshPreview(winId));
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

function selectRegionNode(winId, boxId) {
  const ids = [`reg:${winId}:${boxId}`, `anc:${winId}:${boxId}`, `st:${winId}:${boxId}`, `sb:${winId}:${boxId}`];
  selectedNodeId = ids.find((id) => nodeEls.has(id)) || null;
  for (const [id, el] of nodeEls) el.classList.toggle("selected", id === selectedNodeId);
  drawEdges();   // restyle the selected node's line
}

// Focus ANY node (click or drag). Drops box selection so WASD targets the node,
// highlights it + its lines. Box-backed nodes (region/anchor/scrollbar) then re-select
// their box on the trailing click, so WASD keeps nudging the box for those.
function focusNode(id) {
  for (const [, rec] of overlays) rec.overlay.setActive(null);
  activeOverlayKey = null;
  selectedNodeId = id;
  for (const [nid, el] of nodeEls) el.classList.toggle("selected", nid === id);
  drawEdges();
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
    const cap = live ? null : (await api.getBindings(model.profile.name))[winId];
    const res = await api.preview(previewProfileFor(winId), model.profile.name, cap);
    host.innerHTML = previewTable(res.cells);
    setGridFromPreview(winId, res);   // same OCR pass drives the dashed grid
    done(`· ${(res.cells || []).length} cells`);
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
  const done = timed(`detect ${winId}`);
  await withBusy(ids, async () => {
    try {
      const cap = live ? null : (await api.getBindings(model.profile.name))[winId];
      const res = await api.detect(previewProfileFor(winId), model.profile.name, cap);
      for (const [aid, info] of Object.entries(res.anchors || {})) setDetectStatus(`anc:${winId}:${aid}`, info);
      for (const [sid, info] of Object.entries(res.states || {})) setDetectStatus(`st:${winId}:${sid}`, info);
      const sbEl = nodeEls.get(`sb:${winId}:scrollbar`);
      const sbSpan = sbEl && sbEl.querySelector(".detect-status");
      if (sbSpan) {
        const sb = res.scrollbar;
        sbSpan.textContent = sb == null ? "position: —"
          : `position: ${Math.round(sb.pos * 100)}% · ${sb.px}px · ${Math.round(sb.conf * 100)}%`;
      }
      done();
    } catch (e) { done(String(e.message || e), "err"); }
  });
}
function setDetectStatus(nodeId, info) {
  const el = nodeEls.get(nodeId);
  const span = el && el.querySelector(".detect-status");
  if (!span) return;
  const conf = info.score != null ? ` (${Math.round(info.score * 100)}%)` : "";
  span.textContent = (info.matched ? "✓ true" : "✗ false") + conf + (info.read ? ` — "${info.read}"` : "");
  span.className = "detect-status " + (info.matched ? "conf-ok" : "conf-bad");
}
let detectT = null;
function refreshOpenDetect() {
  clearTimeout(detectT);
  detectT = setTimeout(() => { for (const winId of imageCanvases.keys()) refreshDetect(winId); }, 700);
}

let previewT = null;
function refreshOpenPreviews() {
  clearTimeout(previewT);
  previewT = setTimeout(() => {
    for (const w of model.profile.windows || []) {
      const host = prevHost(w.id);
      if (host && host.dataset.ran === "1") refreshPreview(w.id, true);
    }
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
    if (!recapture) {
      const b = await api.getBindings(game);
      if (b[winId]) url = api.captureUrl(game, b[winId]);
    }
    if (!url) {
      const c = await api.capture(game);          // capture + bind newest
      await api.bindCapture(game, winId, c.name);
      url = c.url;
    }
  } catch (e) { done(String(e.message || e), "err"); setStatus(String(e.message || e)); setNodeBusy(`win:${winId}`, false); return; }
  const img = new Image();
  img.onload = () => {
    done();
    setNodeBusy(`win:${winId}`, false);
    // keep the canvas area at the image aspect ratio so resizing always fits
    entry.canvas.parentElement.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
    entry.overlay.setImage(img);
    refreshImageBoxes(winId);
    drawEdges();
    refreshGridPreview(winId);   // draw the grid where rows actually are in this capture
    updateImageLabel(winId);     // button shows the (possibly new) filename
    // the image changed → re-read it only if the preview node was already run (avoid
    // OCR work nobody asked for)
    if (prevHost(winId)?.dataset.ran === "1") refreshPreview(winId);
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

// Every node reachable by following edges OUT of `id` (its downstream subtree).
// Used for shift-drag. preview/data/batches are real nodes on edges, so they're
// included automatically.
function descendantsOf(id) {
  const out = new Set();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop();
    for (const e of model.edges()) {
      if (e.from === cur && !out.has(e.to)) { out.add(e.to); stack.push(e.to); }
    }
  }
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
    drawEdges();
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
    // the data + batches nodes re-read when their dataset's count changed
    for (const ds in map) {
      if (prevPresent[ds] === undefined || prevPresent[ds] === map[ds].present) continue;
      if (nodeEls.has(`ds:${ds}`)) refreshDataNode(ds);
      if (nodeEls.has(`bat:${ds}`)) loadBatchesNode(ds);
    }
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
  const done = timed(`load game ${name}`);
  const profile = await api.getProfile(name);
  done();
  model.load(profile);
  pos.clear();
  nodeEls.clear();
  $("gnodes").innerHTML = "";
  for (const winId of [...imageCanvases.keys()]) closeImage(winId);
  batchesState.clear();   // batches render inline per node; drop stale selection state
  loadPositions();   // restore saved node positions for this game
  render();
  for (const winId of pendingOpenImages) if (model.window(winId)) openImage(winId);  // reopen saved images (canvas lives in node)
  pendingOpenImages = [];
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
$("liveBtn").addEventListener("click", () => setLiveMode(!liveOn));
$("precapBtn").addEventListener("click", () => openPrecaptureModal());
$("graph").addEventListener("mousedown", (ev) => {
  // right-drag pans ANYWHERE (even over nodes/canvas), except form controls so
  // their native menus still work. Don't preventDefault — a plain right click
  // must still open the context menu; only an actual drag suppresses it.
  if (ev.button === 2) { if (!ev.target.closest("input,select,textarea")) startPan(ev); return; }
  if (ev.button === 0 && !ev.target.closest(".gnode")) deselectAll();   // left-click clears selection
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
  // No active box but a node is selected → WASD moves the NODE, one grid step.
  const rec = overlays.get(activeOverlayKey);
  if (!rec) {
    if (selectedNodeId && pos.has(selectedNodeId)) {
      const p = pos.get(selectedNodeId);
      p.x = snap(p.x + dir[0] * GRID); p.y = snap(p.y + dir[1] * GRID);
      positionNode(selectedNodeId); drawEdges(); savePositions();
      ev.preventDefault();
    }
    return;
  }
  // Otherwise operate on whichever overlay holds the live box selection (window OR item).
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
// Live = re-read open windows continuously (view only, no saving). Saving is a
// deliberate precapture step now. live and precapture are mutually exclusive.
// ---- live processing stats (top bar) --------------------------------------
let liveOn = false, precapOpen = false;
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
  refreshLive();   // dataset counts
  const game = model.profile.name;
  if (!game || !liveOn) { renderLiveStats(); return; }
  liveProcessing = true; renderLiveStats();
  for (const [winId, entry] of imageCanvases) {
    try {
      const { url } = await api.capture(game, false);   // live frame, not stashed
      const img = new Image();
      img.onload = () => { entry.overlay.setImage(img); refreshImageBoxes(winId); };
      img.src = url;
      liveFrames++;                                      // count captured frames for img/s
    } catch { /* window gone */ }
    refreshDetect(winId, true);
    if (prevHost(winId)?.dataset.ran === "1") refreshPreview(winId, true);
  }
  liveProcessing = false; renderLiveStats();
}

function setLiveMode(on) {
  if (on && precapOpen) return;          // mutually exclusive with precapture
  liveOn = on;
  $("liveBtn").classList.toggle("active", on);
  if (timer) { clearInterval(timer); timer = null; }
  showLiveStats(on);
  if (on) { timer = setInterval(liveTick, 1200); registerWorker("live", "live view", () => setLiveMode(false)); }
  else unregisterWorker("live");
}

// ---- init -----------------------------------------------------------------

async function initOcrDevice() {
  const sel = $("ocrDevice");
  if (!sel) return;
  try {
    const st = await api.ocr.getDevice();
    const gpuOpt = sel.querySelector('option[value="gpu"]');
    gpuOpt.disabled = !st.gpu_available;
    if (!st.gpu_available) gpuOpt.textContent = "GPU (n/a)";
    sel.value = st.device;
    sel.addEventListener("change", async () => {
      const done = timed(`OCR device → ${sel.value}`);
      try { const r = await api.ocr.setDevice(sel.value); sel.value = r.device; done(); }
      catch (e) { done(String(e.message || e), "err"); }
    });
  } catch { /* ignore */ }
}

// Block the whole UI with an unmissable message and refuse to continue.
function haltStartup(msg) {
  log(msg, "err");
  const o = document.createElement("div");
  o.className = "startup-halt";
  o.innerHTML = `<div class="startup-halt-box"><h3>Background OCR still running</h3>
    <p>${esc(msg)}</p>
    <p class="muted">Nothing was loaded. Kill the stray worker (or the python process), then retry.</p>
    <button class="startup-halt-retry">retry</button></div>`;
  document.body.appendChild(o);
  o.querySelector(".startup-halt-retry").addEventListener("click", () => location.reload());
}

// On page load, kill any background OCR worker from a prior session and WAIT for it to
// die. Do NOT load the graph until it's confirmed gone — a stray worker keeps hammering
// the GPU/game and is the thing you'd otherwise have to hunt down in Task Manager.
async function killStrayOcrThenBoot() {
  try {
    const r = await api.precapture.killAll();
    if (r.alive && r.alive.length) {
      haltStartup(`OCR worker for ${r.alive.join(", ")} would not stop within the timeout.`);
      return;   // refuse to proceed
    }
    if (r.killed && r.killed.length) setStatus(`stopped stray OCR: ${r.killed.join(", ")}`);
  } catch (e) {
    haltStartup(`Could not confirm background OCR was stopped: ${e.message || e}`);
    return;   // can't verify -> don't proceed
  }
  await refreshGames();
  if ($("gameSelect").value) loadGame($("gameSelect").value);
  initOcrDevice();
}
killStrayOcrThenBoot();
