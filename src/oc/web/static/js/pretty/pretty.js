// Pretty Studio controller: mounts the page surface + studio panels into #pretty, owns the
// view/edit mode and current page, and wires everything (data layer, model, overrides,
// widgets, inspector, sources, palette, theme) through one `ctx`. main.js lazily imports this
// the first time the user switches to pretty view.

import * as data from "./data.js";
import * as overrides from "./overrides.js";
import * as constraints from "./constraints.js";
import { PrettyModel } from "./model.js";
import { renderPage } from "./canvas.js";
import { newWidget, WIDGET_LIST } from "./widgets/index.js";
import { applyStyle, mergeStyle, computedToStyle } from "./style.js";
import { GRID } from "../graph/dragresize.js";
import { buildPalette } from "./panels/palette.js";
import { buildInspector } from "./panels/inspector.js";
import { buildSources } from "./panels/sources.js";
import { buildTheme } from "./panels/theme.js";
import { buildPrettyTools } from "./topbar.js";
import { el } from "./widgets/util.js";
import { openContextMenu } from "../ctxmenu.js";
import * as papi from "./api.js";
import { model } from "../graph/state.js";

const pretty = new PrettyModel();
let surface = null, toolsEl = null, panels = null, tools = null, canvasCtrl = null;
let game = null, mode = "edit", pageId = null, selectedId = null, mounted = false;
let cueScope = "all";   // edit-mode cue layer: "all" widgets, "selected" only, or "none"
const selection = new Set();   // every selected widget id; selectedId is the primary (inspector) one

const ctx = {
  get mode() { return mode; },
  get cueScope() { return cueScope; },
  setCueScope: (s) => { cueScope = ["all", "selected", "none"].includes(s) ? s : "all"; if (canvasCtrl) canvasCtrl.showAnchorCue(); },
  get game() { return game; },
  model, pretty, data, overrides, constraints,
  currentPageId: () => pageId,
  currentWidgets: () => pretty.widgets(pageId),
  selectedWidget: () => (selectedId ? pretty.widget(pageId, selectedId) : null),
  selectionIds: () => selection,
  requestSave: () => pretty.save(),
  refresh: () => renderCurrent(),
  restyle: (id) => restyleWidget(id),
  effectiveStyle: (id) => { const f = surface && surface.querySelector(`.pw[data-id="${id}"]`); return f ? computedToStyle(getComputedStyle(f)) : {}; },
  selectWidget: (id, additive) => selectWidget(id, additive),
  setAnchor: (id, anchor) => { if (canvasCtrl) canvasCtrl.reanchor(id, anchor); },
  geomOf: (id) => (canvasCtrl ? canvasCtrl.geom(id) : null),
  applyGeom: (id, patch) => { if (canvasCtrl) canvasCtrl.setGeom(id, patch); pretty.save(); },
  setUnit: (id, k, unit) => { if (canvasCtrl) canvasCtrl.setUnit(id, k, unit); pretty.save(); },
  setMatch: (id, key, to) => { if (canvasCtrl) canvasCtrl.setMatch(id, key, to); pretty.save(); },
  setMatchPct: (id, key, pct) => { if (canvasCtrl) canvasCtrl.setMatchPct(id, key, pct); pretty.save(); },
  geomChanged: (id) => { if (id === selectedId && panels) panels.inspector.syncGeom(id); },
  addWidget: (type) => addWidget(type),
  removeWidget: (id) => removeWidget(id),
  switchPage: (id) => switchPage(id),
  addPage: () => { switchPage(pretty.addPage()); tools && tools.refresh(); },
  setMode: (m) => setMode(m),
  bindDataToSelected: (src, id) => bindData(src, id),
  bindPathToSelected: (path) => bindPath(path),
};

export function isMounted() { return mounted; }

export async function mountPretty(container, toolsHost, g) {
  if (!mounted) {
    surface = el("div", "pw-surface");
    container.appendChild(surface);
    toolsEl = toolsHost;
    panels = {
      palette: buildPalette(ctx),
      inspector: buildInspector(ctx),
      sources: buildSources(ctx),
      theme: buildTheme(ctx),
    };
    tools = buildPrettyTools(toolsEl, ctx, panels);
    // Click anywhere that is NOT a widget, a floating panel, or the edit-tools deselects.
    document.addEventListener("mousedown", (ev) => {
      if (!mounted || mode !== "edit" || !document.body.classList.contains("pretty-mode")) return;
      if (ev.target.closest(".pw, .floatwin, .pw-edittools, .ctxmenu")) return;
      deselect();
    });
    // WASD nudges the selected widget (edit mode, not while typing). Shift = 1px, else grid step.
    document.addEventListener("keydown", (ev) => {
      if (!mounted || mode !== "edit" || !document.body.classList.contains("pretty-mode") || !selection.size) return;
      if (ev.target && ev.target.closest && ev.target.closest("input, select, textarea, [contenteditable=true]")) return;
      const map = { w: [0, -1], a: [-1, 0], s: [0, 1], d: [1, 0] };
      const m = map[ev.key.toLowerCase()];
      if (!m) return;
      ev.preventDefault();
      const step = ev.shiftKey ? 1 : GRID;
      nudge(m[0] * step, m[1] * step);
    });
    // Drag a rectangle on empty canvas -> rubber-band multi-select (shift adds to the current
    // selection). A click that doesn't move clears the selection.
    surface.addEventListener("mousedown", startMarquee);
    // Right-click empty canvas -> add-widget menu, dropping the new widget at the click spot.
    surface.addEventListener("contextmenu", (ev) => {
      if (ev.shiftKey) return;   // shift+right-click reserved -> no add-widget menu
      if (mode !== "edit" || ev.target.closest(".pw")) return;
      ev.preventDefault();
      const rect = surface.getBoundingClientRect();
      const sx = ev.clientX - rect.left + surface.scrollLeft, sy = ev.clientY - rect.top + surface.scrollTop;
      openContextMenu(ev.clientX, ev.clientY, WIDGET_LIST.map((def) => ({
        icon: def.icon, title: def.title, onClick: () => addWidgetAt(def.type, sx, sy),
      })));
    });
    mounted = true;
  }
  await setPrettyGame(g);
}

export async function setPrettyGame(g) {
  if (!mounted) return;
  game = g;
  selection.clear(); selectedId = null;
  data.initData(g);
  try { pretty.load(g, await papi.getPretty(g)); } catch { pretty.load(g, null); }
  pageId = pretty.firstPageId();
  renderCurrent();
  tools.refresh();
}

// Toggle data polling + panel visibility when entering/leaving pretty view. The studio
// panels belong to pretty, so they hide when we leave for the node view and come back exactly
// as they were on return (open state remembered, not reset).
let _hiddenPretty = [];
export function activatePretty() {
  data.startData();
  document.body.classList.toggle("pretty-view", mode === "view");   // restore chrome-hiding for the current mode
  for (const name of _hiddenPretty) panels[name] && panels[name].win.setVisible(true);
  _hiddenPretty = [];
  if (canvasCtrl) canvasCtrl.updateAll();
  if (tools) tools.refresh();
}
export function deactivatePretty() {
  data.stopData();
  // leaving pretty: drop view-mode chrome hiding so node view never inherits hidden topbar/logbar.
  document.body.classList.remove("pretty-view");
  _hiddenPretty = [];
  if (panels) for (const [name, p] of Object.entries(panels)) if (p.win.state.visible) { _hiddenPretty.push(name); p.win.setVisible(false); }
  if (tools) tools.refresh();
}

function renderCurrent() {
  if (!mounted) return;
  if (canvasCtrl) canvasCtrl.destroy();
  surface.classList.toggle("edit", mode === "edit");
  surface.classList.toggle("view", mode === "view");
  const page = pretty.page(pageId) || pretty.pages()[0];
  pageId = page ? page.id : null;
  canvasCtrl = page ? renderPage(surface, page, ctx) : null;
  if (canvasCtrl && selection.size) { canvasCtrl.select(selection); canvasCtrl.showAnchorCue(selectedId); }
}

function restyleWidget(id) {
  const w = pretty.widget(pageId, id);
  const frame = surface.querySelector(`.pw[data-id="${id}"]`);
  if (w && frame) applyStyle(frame, mergeStyle(pretty.theme(), w.style));
}

// Select a widget. `additive` (shift-click / shift-marquee) toggles it in/out of the current
// group instead of replacing it; the primary (inspector) widget follows the last touched id.
function selectWidget(id, additive) {
  if (additive) {
    if (selection.has(id)) { selection.delete(id); if (selectedId === id) selectedId = [...selection].pop() || null; }
    else { selection.add(id); selectedId = id; }
  } else {
    selection.clear(); selection.add(id); selectedId = id;
  }
  syncSelection();
}

// Replace the whole selection at once (marquee). `primary` becomes the inspector widget.
function setSelection(ids, primary) {
  selection.clear();
  for (const id of ids) selection.add(id);
  selectedId = primary != null && selection.has(primary) ? primary : [...selection][0] || null;
  syncSelection();
}

function syncSelection() {
  if (canvasCtrl) { canvasCtrl.select(selection); canvasCtrl.showAnchorCue(selectedId); }
  const w = selectedId ? pretty.widget(pageId, selectedId) : null;
  if (panels) { if (w) panels.inspector.show(w); else panels.inspector.clear(); }
  if (tools) tools.refresh();
}

function deselect() {
  if (!selection.size) return;
  selection.clear(); selectedId = null;
  if (canvasCtrl) { canvasCtrl.select(null); canvasCtrl.showAnchorCue(null); }
  if (panels) panels.inspector.clear();
}

function nudge(dx, dy) {
  if (!selection.size || !canvasCtrl) return;
  canvasCtrl.nudge(dx, dy, selection);
  if (panels && selectedId) panels.inspector.syncGeom(selectedId);
  pretty.save();
}

// Rubber-band selection: draw a rectangle over the empty canvas and select every widget whose
// resolved box intersects it. Highlight tracks live during the drag; the inspector/selection
// is only committed on mouseup so it doesn't thrash. Shift keeps the existing selection.
function startMarquee(ev) {
  if (!mounted || mode !== "edit" || ev.button !== 0) return;
  if (ev.target.closest(".pw, .floatwin, .pw-edittools, .ctxmenu")) return;   // a widget/panel owns its own click
  ev.preventDefault(); ev.stopPropagation();   // take over selection for the empty canvas (no document-deselect)
  const additive = ev.shiftKey;
  const rect = surface.getBoundingClientRect();
  const x0 = ev.clientX - rect.left + surface.scrollLeft, y0 = ev.clientY - rect.top + surface.scrollTop;
  const box = el("div", "pw-marquee");
  surface.appendChild(box);
  const base = additive ? new Set(selection) : new Set();
  let moved = false, hit = new Set(base);
  const draw = (e) => {
    const x1 = e.clientX - rect.left + surface.scrollLeft, y1 = e.clientY - rect.top + surface.scrollTop;
    const L = Math.min(x0, x1), T = Math.min(y0, y1), W = Math.abs(x1 - x0), H = Math.abs(y1 - y0);
    if (W > 3 || H > 3) moved = true;
    box.style.left = `${L}px`; box.style.top = `${T}px`; box.style.width = `${W}px`; box.style.height = `${H}px`;
    if (!moved) return;
    hit = new Set(base);
    const boxes = canvasCtrl ? canvasCtrl.boxes() : new Map();
    for (const [id, b] of boxes) if (b.left < L + W && b.left + b.w > L && b.top < T + H && b.top + b.h > T) hit.add(id);
    if (canvasCtrl) canvasCtrl.select(hit);
  };
  const up = () => {
    document.removeEventListener("mousemove", draw); document.removeEventListener("mouseup", up);
    box.remove();
    if (moved) setSelection(hit, selectedId);
    else if (!additive) deselect();   // a plain empty click clears the selection
  };
  document.addEventListener("mousemove", draw); document.addEventListener("mouseup", up);
}

// ---- right-click add-widget menu (shared primitive, see ../ctxmenu.js) -------------
function addWidgetAt(type, x, y) {
  const w = pretty.addWidget(pageId, newWidget(type));
  if (!w) return;
  w.x = Math.max(0, Math.round(x)); w.y = Math.max(0, Math.round(y));
  pretty.save(); renderCurrent(); selectWidget(w.id);
}

function addWidget(type) {
  const w = pretty.addWidget(pageId, newWidget(type));
  if (!w) return;
  renderCurrent();
  selectWidget(w.id);
}

function removeWidget(id) {
  pretty.removeWidget(pageId, id);
  selection.delete(id); if (selectedId === id) selectedId = [...selection].pop() || null;
  if (panels && !selectedId) panels.inspector.clear();   // drop the inspector if nothing's left selected
  renderCurrent();
}

function switchPage(id) {
  pageId = id; selection.clear(); selectedId = null;
  if (panels) panels.inspector.clear();
  renderCurrent();
  if (tools) tools.refresh();
}

function setMode(m) {
  mode = m === "view" ? "view" : "edit";
  // view mode hides the app chrome (topbar/logbar) for a clean dashboard; CSS reveals them on
  // hovering the top/bottom edge triggers. Cleared automatically on leaving pretty (pretty-mode off).
  document.body.classList.toggle("pretty-view", mode === "view");
  if (mode === "view" && panels) for (const p of Object.values(panels)) p.win.setVisible(false);
  renderCurrent();
  if (tools) tools.refresh();
}

function bindData(src, id) {
  const w = ctx.selectedWidget();
  if (!w || !["table", "chart"].includes(w.type)) return;
  w.binding = { ...(w.binding || {}), src, id };
  pretty.save(); renderCurrent(); panels.inspector.refresh();
}
function bindPath(path) {
  const w = ctx.selectedWidget();
  if (!w || w.type !== "control") return;
  w.path = path;
  pretty.save(); renderCurrent(); panels.inspector.refresh();
}
