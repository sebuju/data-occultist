// Minimal DOM helpers to keep panel modules terse.
// Panels are collapsible <details>; open/closed state persists across re-renders
// (keyed by a stable string) so refreshing doesn't reset what you collapsed.

const collapsed = new Set();

export function collapse(key, on = true) { on ? collapsed.add(key) : collapsed.delete(key); }

export function fieldset(legend, innerHTML, key) {
  key = key || legend.replace(/<[^>]+>/g, "").trim();
  const d = document.createElement("details");
  d.className = "panel-fs";
  d.open = !collapsed.has(key);
  d.innerHTML = `<summary>${legend}</summary><div class="fs-body">${innerHTML}</div>`;
  d.querySelector("summary").addEventListener("click", () => {
    // d.open reflects the *previous* state during the click; flip it.
    setTimeout(() => collapse(key, !d.open), 0);
  });
  return d;
}

export function mount(container, el) { container.replaceChildren(el); }

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// The ONE delete/remove glyph. Every "remove this row / chip / source / session" button
// drops this in instead of an ad-hoc ×/✕ so they never drift apart again. `currentColor`
// fill = it takes the button's own colour (danger red, chip grey, …); `.ic-trash` (style.css)
// sizes it to 1em so it scales with the button's font. Swap the path here and all change.
export const TRASH =
  '<svg class="ic-trash" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
  '<path fill="currentColor" d="M16 9v10H8V9h8m-1.5-6h-5l-1 1H5v2h14V4h-3.5l-1-1zM18 7H6v12c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7z"/>' +
  "</svg>";

// One labelled control row inside a `.lab-grid` (graph.css): a label cell that sizes to its
// own text (grid col 1) followed by whatever control the caller emits next (col 2, fills the
// rest). The ONE label-grid primitive — triggers, the price node, and view config all build
// their first config rows from it so labels line up and inputs share one width (don't hand-roll
// a 1fr/1fr `.flab` per panel). `top` pins the label to the top for control cells that wrap to
// several lines (e.g. a chip list). The control HTML is the caller's immediate next sibling.
export const labCell = (label, title = "", top = false) =>
  `<span class="lab${top ? " lab-top" : ""}"${title ? ` title="${esc(title)}"` : ""}>${label}</span>`;

// Monochrome inline icons (fill = currentColor, sized to 1em) — used instead of colour
// emoji so icons match the surrounding text colour. `.ic` aligns them with the baseline.
const _ic = (d) => `<svg class="ic" viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true"><path fill="currentColor" d="${d}"/></svg>`;
export const CAMERA = _ic("M20 5h-3.2l-1.4-1.8c-.2-.2-.5-.2-.8-.2H9.4c-.3 0-.6 0-.8.2L7.2 5H4c-1.1 0-2 .9-2 2v11c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm-8 12c-2.8 0-5-2.2-5-5s2.2-5 5-5 5 2.2 5 5-2.2 5-5 5zm0-8c-1.7 0-3 1.3-3 3s1.3 3 3 3 3-1.3 3-3-1.3-3-3-3z");
export const WARN = _ic("M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z");
export const PAUSE = _ic("M6 5h4v14H6zM14 5h4v14h-4z");
