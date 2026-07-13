// CSS-variable → concrete-colour resolver + dim helper for the canvas edge/group renderer.
// The SVG renderer let the browser resolve `var(--nt-<type>)` and `filter: grayscale()` for
// free; a <canvas> needs real rgb strings and a precomputed grey, so this is the one place
// that reads the computed custom properties and turns the CSS dim states into {stroke, alpha}.
//
// Values are cached (getComputedStyle is not free); call clearColorCache() if the theme ever
// changes at runtime (there is only one theme today, so nothing calls it yet — but the hook
// exists so a future theme toggle repaints correct colours, see rule 7 / one source of truth).

const _cache = new Map();   // "--name" -> resolved colour string (e.g. "#ff9d4d")

export function clearColorCache() { _cache.clear(); }

// Resolve a CSS custom property off :root to its concrete value. Returns "" when unset so the
// caller can fall back (matching the CSS `var(--x, fallback)` chain).
export function cssVar(name) {
    if (_cache.has(name)) return _cache.get(name);
    let v = "";
    if (typeof document !== "undefined" && document.documentElement)
        v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    _cache.set(name, v);
    return v;
}

// A node type's identity hue (base.css --nt-<type>), the colour every line takes from the node
// it leaves. Falls back to --line for an unknown/satellite source — the same fallback the SVG
// `var(--nt-${srcType}, var(--line))` used.
export function typeColor(srcType) {
    return (srcType && cssVar(`--nt-${srcType}`)) || cssVar("--line") || "#262c37";
}

// Parse #rgb / #rrggbb to [r,g,b] (0-255). Returns null for anything else (rgb()/named) — the
// palette is all hex, so that's all we need; a non-hex value just skips the grey conversion.
function hexRgb(s) {
    if (typeof s !== "string") return null;
    let h = s.trim();
    if (h[0] !== "#") return null;
    h = h.slice(1);
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (h.length !== 6) return null;
    const n = parseInt(h, 16);
    if (Number.isNaN(n)) return null;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Resolve ANY CSS colour expression (var(), color-mix(), hex, named) to a concrete rgb/rgba
// string, by parking it on a hidden probe's `color` and reading the computed value — the browser
// does the color-mix/oklab math for us, so the canvas group boxes match the DOM ones exactly.
// Returns null for a fully-transparent result (so callers skip an invisible fill). One probe reused.
let _probe = null;
export function resolveColor(expr) {
    if (!expr || typeof document === "undefined" || !document.body) return null;
    if (!_probe) {
        _probe = document.createElement("span");
        _probe.style.cssText = "position:absolute;left:-99999px;top:0;width:0;height:0;visibility:hidden;pointer-events:none;";
        document.body.appendChild(_probe);
    }
    _probe.style.color = "";
    _probe.style.color = expr;
    const v = getComputedStyle(_probe).color;   // -> "rgb(r,g,b)" | "rgba(r,g,b,a)"
    if (!v || v === "rgba(0, 0, 0, 0)" || /,\s*0\)$/.test(v)) return null;
    return v;
}

// CSS `filter: grayscale(1)` — the luminance-preserving desaturation the dim edges use. The
// spec matrix on gamma-encoded sRGB: 0.2126 R + 0.7152 G + 0.0722 B. Non-hex input passes
// through unchanged (best effort).
export function grayscale(color) {
    const rgb = hexRgb(color);
    if (!rgb) return color;
    const g = Math.round(0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]);
    return `rgb(${g},${g},${g})`;
}

// The three CSS dim states, as a {stroke, alpha} the canvas applies directly (globalAlpha for
// the opacity, grey stroke for the grayscale). Mirrors graph.css:
//   .sel-active .gedge:not(.sel)  -> grayscale(1) opacity(.1)
//   .gedge.dis-edge               -> grayscale(1) opacity(.4)
//   .gedge.stale-edge             -> grayscale(1) opacity(.3)   (beats .sel)
// mode: "sel-inactive" | "dis" | "stale" | null (full colour, alpha 1).
const DIM_ALPHA = { "sel-inactive": 0.1, dis: 0.4, stale: 0.3 };
export function dimmed(color, mode) {
    if (!mode) return { stroke: color, alpha: 1 };
    return { stroke: grayscale(color), alpha: DIM_ALPHA[mode] ?? 1 };
}
