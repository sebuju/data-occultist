// Teach page: edit ONE window of a game. The game (process/title/fields/windows)
// is managed on the games page; here we draw boxes, suggest, preview, and save.
// Loaded as teach.html?game=<name>&window=<id>.
import * as api from "./api.js";
import { Overlay } from "./overlay.js";
import { EditorModel } from "./model.js";
import { collapse } from "./dom.js";
import { renderWindow } from "./panels/window.js";
import { renderStates } from "./panels/states.js";
import { renderBox } from "./panels/box.js";
import { renderBoxList } from "./panels/boxlist.js";
import { renderPreview } from "./panels/preview.js";
import { renderAppearance } from "./panels/appearance.js";
import { renderFields } from "./panels/fields.js";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const game = params.get("game") || "";
const model = new EditorModel();
let profile = null;                       // full profile (kept so save merges cleanly)
let lastPreview = { items: [], detections: [], cells: [] };   // cells feed the live key preview
const setStatus = (m) => { $("status").textContent = m; };

$("gameLabel").textContent = game || "(no game)";

const overlay = new Overlay($("canvas"), {
  onCreate: (geom) => { model.addBox(geom, "region"); refresh(); },
  onSelect: (id) => { model.selectedId = id; refresh(); },
  onChange: () => refresh(),
  onZoom: (s) => { $("zoomLabel").textContent = `${Math.round(s * 100)}%`; },
  onPick: (hex) => {
    model.preprocess.colors.push(hex);
    if (model.preprocess.mode === "none") model.preprocess.mode = "color";
    refresh();
    setStatus(`added text colour ${hex}`);
  },
});

// ---- grid preview ---------------------------------------------------------

function gridCells() {
  if (!$("gridPreview").checked || !model.grid.enabled) return [];
  const { rows, cols, rowStride, colStride } = model.grid;
  const cells = [];
  for (const b of model.regionBoxes())
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++)
        cells.push({ x: b.x + c * colStride, y: b.y + r * rowStride, w: b.w, h: b.h });
  return cells;
}

// ---- render ---------------------------------------------------------------

const ctx = {
  refresh,
  refreshOverlay: () => { overlay.setBoxes(model.boxes); overlay.setGridPreview(gridCells()); },
  refreshList: () => renderBoxList($("panel-boxlist"), model, ctx),
  pickColor: () => { overlay.setPick(true); setStatus("click the text colour in the image"); },
  previewCells: () => lastPreview.cells || [],   // last preview's per-cell reads (key preview)
};

function refresh() {
  overlay.setActive(model.selectedId);
  overlay.setBoxes(model.boxes);
  overlay.setGridPreview(gridCells());
  renderBox($("panel-box"), model, ctx);
  renderWindow($("panel-window"), model, ctx);
  renderFields($("panel-fields"), model, ctx);
  renderAppearance($("panel-appearance"), model, ctx);
  renderStates($("panel-states"), model, ctx);
  renderBoxList($("panel-boxlist"), model, ctx);
  autosave();
}

// ---- zoom + layer toggles -------------------------------------------------

$("zoomInBtn").addEventListener("click", () => overlay.zoom(1.25));
$("zoomOutBtn").addEventListener("click", () => overlay.zoom(0.8));
$("fitBtn").addEventListener("click", () => overlay.fit());
$("oneToOneBtn").addEventListener("click", () => overlay.setScale(1));
$("gridPreview").addEventListener("change", () => overlay.setGridPreview(gridCells()));

function applyPreviewLayers() {
  overlay.setPreview($("previewToggle").checked ? lastPreview.items : []);
  overlay.setDetections($("detectToggle").checked ? lastPreview.detections : []);
}
$("previewToggle").addEventListener("change", applyPreviewLayers);
$("detectToggle").addEventListener("change", applyPreviewLayers);

// ---- capture + stash ------------------------------------------------------

function showImage(url, status) {
  const img = new Image();
  img.onload = () => {
    overlay.setImage(img); overlay.setGridPreview(gridCells());
    lastPreview = { items: [], detections: [], cells: [] };
    overlay.setPreview([]); overlay.setDetections([]);
    $("panel-preview").replaceChildren();
    setStatus(status);
  };
  img.src = url;
}

async function refreshCaptures(select) {
  const names = await api.listCaptures(game);
  $("captureSelect").innerHTML = `<option value="">— stashed —</option>` +
    names.map((n) => `<option value="${n}">${n.replace(/\.jpg$/, "")}</option>`).join("");
  if (select) $("captureSelect").value = select;
}

$("captureBtn").addEventListener("click", async () => {
  setStatus("capturing…");
  try {
    const { url, name } = await api.capture(game);
    showImage(url, "captured");
    await refreshCaptures(name);
    await api.bindCapture(game, model.windowId, name);  // newest becomes this window's image
  } catch (e) { setStatus(String(e.message || e)); }
});

$("captureSelect").addEventListener("change", async (e) => {
  const name = e.target.value;
  if (!name) return;
  showImage(api.captureUrl(game, name), `loaded ${name}`);
  await api.bindCapture(game, model.windowId, name);    // selecting binds it to the window
});

async function loadBound(windowId) {
  try {
    const b = await api.getBindings(game);
    const name = b[windowId];
    if (name) { $("captureSelect").value = name; showImage(api.captureUrl(game, name), `loaded ${name}`); }
  } catch { /* no binding yet */ }
}

// ---- suggest --------------------------------------------------------------

function previewItems(cells) {
  const { rowStride, colStride } = model.grid;
  const items = [];
  for (const c of cells)
    for (const rb of model.regionBoxes()) {
      const fv = c.fields[rb.field];
      if (fv) items.push({ x: rb.x + c.col * colStride, y: rb.y + c.row * rowStride, w: rb.w, h: rb.h, text: fv.value, confidence: fv.confidence });
    }
  return items;
}

function applySuggestion(s) {
  model.ensureField("name");
  const nf = model.fields.find((f) => f.id === "name");
  if (nf) nf.learn = true;
  model.key = { fields: ["name"], sep: "|", case_sensitive: false };
  model.boxes = model.boxes.filter((b) => b.role !== "region");
  const nameBox = model.addBox({ ...s.region }, "region");
  nameBox.field = "name";
  for (const part of s.parts || []) {
    const b = model.addBox({ ...part.box }, "region");
    b.field = part.field;
    model.ensureField(part.field);
    const f = model.fields.find((x) => x.id === part.field);
    if (f && part.type) f.type = part.type;
  }
  model.grid = { enabled: true, rows: s.grid.rows, cols: s.grid.cols, rowStride: s.grid.row_stride, colStride: s.grid.col_stride };
}

$("suggestBtn").addEventListener("click", async () => {
  setStatus("analysing…");
  try {
    const sb = model.boxes.find((b) => b.role === "search");
    const s = await api.suggest(game, sb ? { x: sb.x, y: sb.y, w: sb.w, h: sb.h } : null);
    if (!s.ok) { setStatus(`suggest: ${s.reason || "nothing found"}`); return; }
    applySuggestion(s);
    lastPreview = { items: [], detections: s.detections || [], cells: [] };
    $("detectToggle").checked = true;
    refresh();
    applyPreviewLayers();
    setStatus(`suggested ${s.grid.rows}×${s.grid.cols} · e.g. ${(s.samples || []).slice(0, 3).join(", ")}`);
  } catch (e) { setStatus(String(e.message || e)); }
});

// ---- preview --------------------------------------------------------------

$("previewBtn").addEventListener("click", async () => {
  setStatus("reading…");
  try {
    const res = await api.preview(model.toProfile());
    lastPreview = { items: previewItems(res.cells), detections: res.detections || [], cells: res.cells };
    applyPreviewLayers();
    const fieldIds = [...new Set(model.regionBoxes().map((b) => b.field).filter(Boolean))];
    renderPreview($("panel-preview"), res.cells, fieldIds);
    renderWindow($("panel-window"), model, ctx);   // refresh the live key preview
    const low = res.cells.reduce((n, c) => n + Object.values(c.fields).filter((f) => f.confidence < 0.5).length, 0);
    setStatus(`preview: ${res.cells.length} cells, ${low} low-conf`);
  } catch (e) { setStatus(String(e.message || e)); }
});

// ---- autosave (no save button; persists after every change) ----------------

let saveT = null;
let loaded = false;
function autosave() {
  if (!game || !loaded) return;
  clearTimeout(saveT);
  saveT = setTimeout(async () => {
    try { await api.saveProfile(model.toProfile()); setStatus(`saved ${game}/${model.windowId}`); }
    catch (e) { setStatus(String(e.message || e)); }
  }, 600);
}

// ---- window switching + init ----------------------------------------------

function loadWindow(windowId) {
  model.fromProfile(profile, windowId);
  refresh();
  loadBound(windowId);   // auto-load the stash bound to this window
}

$("windowSelect").addEventListener("change", (e) => loadWindow(e.target.value));

async function init() {
  if (!game) { setStatus("no game in URL"); return; }
  // declutter: collapse the secondary panels by default
  ["Text appearance", "States", "boxes", "preview"].forEach((k) => collapse(k, true));
  try {
    profile = await api.getProfile(game);
  } catch {
    setStatus(`no profile ${game}`); return;
  }
  const windows = (profile.windows || []).map((w) => w.id);
  const want = params.get("window") || windows[0] || "equipment";
  $("windowSelect").innerHTML = windows.map((w) => `<option ${w === want ? "selected" : ""}>${w}</option>`).join("")
    || `<option>${want}</option>`;
  await refreshCaptures();
  loadWindow(want);   // also auto-loads the window's bound stash
  loaded = true;      // enable autosave only after the initial load
  setStatus(`editing ${game} / ${want}`);
}

init();
