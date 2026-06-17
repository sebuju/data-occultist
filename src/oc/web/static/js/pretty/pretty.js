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

const ctx = {
  get mode() { return mode; },
  get game() { return game; },
  model, pretty, data, overrides, constraints,
  currentPageId: () => pageId,
  currentWidgets: () => pretty.widgets(pageId),
  selectedWidget: () => (selectedId ? pretty.widget(pageId, selectedId) : null),
  requestSave: () => pretty.save(),
  refresh: () => renderCurrent(),
  restyle: (id) => restyleWidget(id),
  effectiveStyle: (id) => { const f = surface && surface.querySelector(`.pw[data-id="${id}"]`); return f ? computedToStyle(getComputedStyle(f)) : {}; },
  selectWidget: (id) => selectWidget(id),
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
      if (!mounted || mode !== "edit" || !document.body.classList.contains("pretty-mode") || !selectedId) return;
      if (ev.target && ev.target.closest && ev.target.closest("input, select, textarea, [contenteditable=true]")) return;
      const map = { w: [0, -1], a: [-1, 0], s: [0, 1], d: [1, 0] };
      const m = map[ev.key.toLowerCase()];
      if (!m) return;
      ev.preventDefault();
      const step = ev.shiftKey ? 1 : GRID;
      nudge(m[0] * step, m[1] * step);
    });
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
  selectedId = null;
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
  for (const name of _hiddenPretty) panels[name] && panels[name].win.setVisible(true);
  _hiddenPretty = [];
  if (canvasCtrl) canvasCtrl.updateAll();
  if (tools) tools.refresh();
}
export function deactivatePretty() {
  data.stopData();
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
  if (canvasCtrl && selectedId) canvasCtrl.select(selectedId);
}

function restyleWidget(id) {
  const w = pretty.widget(pageId, id);
  const frame = surface.querySelector(`.pw[data-id="${id}"]`);
  if (w && frame) applyStyle(frame, mergeStyle(pretty.theme(), w.style));
}

function selectWidget(id) {
  selectedId = id;
  if (canvasCtrl) canvasCtrl.select(id);
  const w = pretty.widget(pageId, id);
  if (w && panels) { panels.inspector.show(w); tools.refresh(); }
}

function deselect() {
  if (!selectedId) return;
  selectedId = null;
  if (canvasCtrl) canvasCtrl.select(null);
  if (panels) panels.inspector.clear();
}

function nudge(dx, dy) {
  const w = pretty.widget(pageId, selectedId);
  if (!w) return;
  w.x = Math.max(0, (w.x || 0) + dx); w.y = Math.max(0, (w.y || 0) + dy);
  const f = surface.querySelector(`.pw[data-id="${selectedId}"]`);
  if (f) { f.style.left = `${w.x}px`; f.style.top = `${w.y}px`; }
  pretty.save();
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
  selectedId = null;
  if (panels) panels.inspector.clear();   // always drop the inspector to the deleted widget
  renderCurrent();
}

function switchPage(id) {
  pageId = id; selectedId = null;
  if (panels) panels.inspector.clear();
  renderCurrent();
  if (tools) tools.refresh();
}

function setMode(m) {
  mode = m === "view" ? "view" : "edit";
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
