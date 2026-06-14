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
