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
