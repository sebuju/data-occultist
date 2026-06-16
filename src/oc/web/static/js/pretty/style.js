// The ONE style model for Pretty Studio. Every element — page, widget, and (where it makes
// sense) sub-parts like a table column or chart series — carries a plain `Style` object, and
// `applyStyle` is the single place that turns it into inline CSS. A theme provides document
// defaults; a widget's own style overrides the theme key-by-key. There is exactly one style
// editor UI (style_editor.js) built on the field list below — never a second copy (rule 7).

// Field descriptors drive BOTH applyStyle and the style editor, so adding a styleable
// property is one entry here. `kind` tells the editor which control to render.
export const STYLE_FIELDS = [
  { key: "color", label: "text", kind: "color" },
  { key: "bg", label: "fill", kind: "color" },
  { key: "font_family", label: "font", kind: "font" },
  { key: "font_size", label: "size", kind: "px", min: 6, max: 200 },
  { key: "bold", label: "B", kind: "toggle" },
  { key: "italic", label: "I", kind: "toggle" },
  { key: "underline", label: "U", kind: "toggle" },
  { key: "align", label: "align", kind: "align" },
  { key: "border_w", label: "border", kind: "px", min: 0, max: 40 },
  { key: "border_color", label: "border ▦", kind: "color" },
  { key: "border_style", label: "border —", kind: "select", options: ["solid", "dashed", "dotted", "double"] },
  { key: "radius", label: "round", kind: "px", min: 0, max: 200 },
  { key: "padding", label: "pad", kind: "px", min: 0, max: 200 },
  { key: "shadow", label: "shadow", kind: "text" },
  { key: "opacity", label: "opacity", kind: "range01" },
];

const px = (v) => (v == null || v === "" ? null : (typeof v === "number" ? `${v}px` : String(v)));

// Merge a theme's defaults under a widget/page style (style wins per key).
export function mergeStyle(theme, style) {
  return { ...(theme || {}), ...(style || {}) };
}

// Apply a (theme-merged) style object to a DOM element as inline CSS. Keys left unset clear
// to "" so re-applying after an edit removes a property rather than leaving a stale value.
export function applyStyle(el, style) {
  const s = style || {};
  const set = (prop, val) => { el.style[prop] = val == null ? "" : val; };
  set("color", s.color);
  set("background", s.bg);
  set("fontFamily", s.font_family);
  set("fontSize", px(s.font_size));
  set("fontWeight", s.bold ? "700" : (s.bold === false ? "400" : ""));
  set("fontStyle", s.italic ? "italic" : (s.italic === false ? "normal" : ""));
  set("textDecoration", s.underline ? "underline" : (s.underline === false ? "none" : ""));
  set("textAlign", s.align);
  // border: only when a width is set, so a bare colour doesn't draw a 0-width line
  if (s.border_w) el.style.border = `${px(s.border_w)} ${s.border_style || "solid"} ${s.border_color || "currentColor"}`;
  else set("border", null);
  set("borderRadius", px(s.radius));
  set("padding", px(s.padding));
  set("margin", px(s.margin));
  set("boxShadow", s.shadow);
  set("opacity", s.opacity == null || s.opacity === "" ? null : String(s.opacity));
}

// The EFFECTIVE style of a rendered element (getComputedStyle -> our Style shape), used to
// prefill the style editor so a field shows the value actually in force even when the widget
// hasn't overridden it.
export function computedToStyle(cs) {
  if (!cs) return {};
  const i = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : ""; };
  return {
    color: cs.color, bg: cs.backgroundColor,
    font_family: cs.fontFamily, font_size: i(cs.fontSize),
    bold: parseInt(cs.fontWeight, 10) >= 600, italic: cs.fontStyle === "italic",
    underline: (cs.textDecorationLine || cs.textDecoration || "").includes("underline"),
    align: cs.textAlign,
    border_w: i(cs.borderTopWidth), border_color: cs.borderTopColor, border_style: cs.borderTopStyle,
    radius: i(cs.borderTopLeftRadius), padding: i(cs.paddingTop), opacity: cs.opacity,
  };
}

// Common web-safe + UI fonts offered by the font picker (plus "custom…" via a text input).
export const FONT_CHOICES = [
  "", "Inter", "system-ui", "Arial", "Helvetica", "Georgia", "Times New Roman",
  "Courier New", "Consolas", "monospace", "Verdana", "Trebuchet MS", "Tahoma",
];
