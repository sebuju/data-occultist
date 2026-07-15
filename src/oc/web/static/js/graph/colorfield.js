// The ONE synced color-picker + hex-text pair (CLAUDE.md rule 7). Used by the pretty style
// editor (widget/document colors) and the graph theme panel (CSS-var/scheme colors) --
// previously two near-identical inline copies; this is the single shared primitive both build on.
import { frag, h, UNDO } from "../dom.js";

const HEX6_RE = /^#[0-9a-f]{6}$/i;
const HEX3_RE = /^#[0-9a-f]{3}$/i;

// "#abc" | "#aabbcc" (any case) -> lowercase "#aabbcc", or null if not a valid hex color.
export function normHex(v) {
    if (typeof v !== "string") return null;
    const s = v.trim();
    if (HEX6_RE.test(s)) return s.toLowerCase();
    if (HEX3_RE.test(s)) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`.toLowerCase();
    return null;
}

// A `type=color` input + a hex text input, kept in sync both directions. `value` is the
// initial shown value ("" = no color / placeholder text). `onChange(hex)` fires on every
// valid edit -- a color-picker drag (always valid) OR the text field becoming a fully-typed
// valid hex as you type -- and NEVER with an invalid value, so a caller never has to validate.
// An in-progress invalid text edit is left alone (not reverted) until blur, when it snaps back
// to the last valid value. `onCommit(hex)` (optional) fires once when an edit is DONE -- the
// text field blurs/Enters, or the native color-picker popup closes -- for callers that want a
// cheap "settled" signal (e.g. notifying another panel to refresh) without firing on every drag
// tick. `onClear` (optional) adds an icon-only clear button (the shared UNDO glyph, dom.js) that
// resets to "" and fires both onChange and onCommit. `clearTitle` labels that button --
// callers with a REAL fallback value (a CSS var's base.css default, a widget's inherited style)
// should pass "reset to default"; a custom scheme's optional color has no such default (clearing
// it means "no override", not "back to some default"), so the base default is the neutral "clear".
// Returns { row, set(v) }: `set` re-syncs the DISPLAY only (no onChange/onCommit) -- for an
// external update (a scheme swatch click, another tab's edit, undo) to repaint this field in place.
export function colorField({ value = "", onChange, onCommit, onClear, title, clearTitle = "clear",
        placeholder = "—", colorClass = "cf-color", textClass = "cf-text", clearClass = "cf-clear" } = {}) {
    let shown = value || "";
    const c = h("input", { type: "color", class: colorClass, value: normHex(shown) || "#000000", title: title || null });
    const t = h("input", { type: "text", class: textClass, placeholder, value: shown, title: title || null });
    const sync = (v) => { shown = v || ""; c.value = normHex(shown) || "#000000"; t.value = shown; };
    c.addEventListener("input", () => { shown = c.value; t.value = shown; onChange && onChange(shown); });
    c.addEventListener("change", () => onCommit && onCommit(shown));
    t.addEventListener("input", () => {
        const n = normHex(t.value);
        if (n) { shown = n; c.value = n; onChange && onChange(n); }
    });
    t.addEventListener("change", () => { t.value = shown; onCommit && onCommit(shown); });
    const kids = [c, t];
    if (onClear) {
        const clr = h("button", { type: "button", class: clearClass, title: clearTitle }, UNDO());
        clr.addEventListener("click", () => { shown = ""; sync(""); onClear(); onCommit && onCommit(""); });
        kids.push(clr);
    }
    return { row: frag(...kids), set: sync };
}
