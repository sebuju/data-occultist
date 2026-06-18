// Widget registry: type -> module. Adding a widget = a new file here + one line (mirrors the
// node-side node_icons / panel pattern). Each module exports { type, title, icon, defaults(),
// create(host, widget, ctx) -> { update(), destroy() } }.

import label from "./label.js";
import table from "./table.js";
import chart from "./chart.js";
import control from "./control.js";
import container from "./container.js";
import form from "./form.js";
import button from "./button.js";
import panel from "./panel.js";

export const WIDGETS = { label, table, chart, control, container, form, button, panel };
export const WIDGET_LIST = Object.values(WIDGETS);

export function widgetDef(type) { return WIDGETS[type] || null; }

// Build a fresh widget data object for a type (defaults merged onto the common frame).
export function newWidget(type) {
  const def = widgetDef(type);
  if (!def) return null;
  const d = def.defaults ? def.defaults() : {};
  return { type, style: {}, conditions: {}, config: {}, ...d };
}
