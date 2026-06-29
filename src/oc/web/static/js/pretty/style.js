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

// Border is resolved per side so a style can frame any subset of edges. These pair each logical
// side with its CSS longhand; the per-side override keys are `border_{w,color,style}_<side>`.
export const BORDER_SIDES = ["top", "right", "bottom", "left"];
const CSS_SIDE = { top: "borderTop", right: "borderRight", bottom: "borderBottom", left: "borderLeft" };

// Merge a theme's defaults under a widget/page style (style wins per key).
export function mergeStyle(theme, style) {
    return { ...(theme || {}), ...(style || {}) };
}

// ---- style profiles ------------------------------------------------------------------------
// A widget carries ONE base style (`w.style`, the "Default" profile) plus any number of extra
// named profiles (`w.styleProfiles = [{id, name, style}]`). Each profile is a FULL, independent
// style object (a new one is created by copying the active one). Which profile renders is chosen
// at draw time: a condition rule with effect "style" activates its profile while true; otherwise
// the default. The editor shows the profiles as tabs and edits one at a time.

// Ordered profiles of a widget: the default first (id "default", backed by w.style), then extras.
// Each entry's `style` is a live reference into the widget, so the editor mutates it in place.
export function widgetProfiles(w) {
    const base = { id: "default", name: "Default", style: (w.style = w.style || {}) };
    const extra = (w.styleProfiles || []).map((p) => ({ id: p.id, name: p.name || p.id, style: (p.style = p.style || {}) }));
    return [base, ...extra];
}

// The style object of one profile by id ("default" / missing -> the base w.style).
export function profileStyle(w, id) {
    if (!id || id === "default") return w.style || {};
    const p = (w.styleProfiles || []).find((x) => x.id === id);
    return p ? (p.style || {}) : (w.style || {});
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
    // border: each side resolves width/style/colour from a per-side override (border_w_top, …),
    // falling back to the shared base (border_w / border_style / border_color). A side draws ONLY
    // when its resolved width is truthy (a bare colour never draws a 0-width line); a per-side width
    // of 0 explicitly suppresses that one side even while the base draws the others. Always longhand
    // (never the `border` shorthand) so the four sides stay independently set/cleared each apply.
    let anyBorder = false;
    for (const side of BORDER_SIDES) {
        const w = s[`border_w_${side}`] ?? s.border_w;
        if (w) {
            const st = (s[`border_style_${side}`] ?? s.border_style) || "solid";
            const col = (s[`border_color_${side}`] ?? s.border_color) || "currentColor";
            el.style[CSS_SIDE[side]] = `${px(w)} ${st} ${col}`;
            anyBorder = true;
        } else {
            el.style[CSS_SIDE[side]] = "";
        }
    }
    set("borderRadius", px(s.radius));
    set("padding", px(s.padding));
    set("margin", px(s.margin));
    set("boxShadow", s.shadow);
    set("opacity", s.opacity == null || s.opacity === "" ? null : String(s.opacity));
    // mark whether ANY border side is drawn, so edit-mode selection/hover can outline ONLY the
    // borderless elements (a bordered one already reads as framed — see pretty.css).
    el.classList.toggle("pw-bordered", anyBorder);
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
