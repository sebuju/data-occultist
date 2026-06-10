// Tiny modal manager: stackable overlays with a title bar, close button,
// backdrop-click and Esc to dismiss. Returns a handle with close().
//
// openModal({ title, size, node, html, onClose }) — provide either `node`
// (an element) or `html` for the body. size: "large" | "data" | "medium".

const stack = [];

function closeTop() {
  const top = stack[stack.length - 1];
  if (top) top.close();
}

document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeTop(); });

export function openModal({ title = "", size = "medium", node = null, html = "", onClose = null } = {}) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";

  const modal = document.createElement("div");
  modal.className = `modal ${size}`;
  modal.innerHTML = `
    <div class="modal-h">
      <span class="modal-title">${title}</span>
      <button class="modal-x" title="close (Esc)">×</button>
    </div>
    <div class="modal-body"></div>`;
  const body = modal.querySelector(".modal-body");
  if (node) body.appendChild(node); else body.innerHTML = html;

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  const handle = {
    el: modal,
    body,
    close() {
      const i = stack.indexOf(handle);
      if (i >= 0) stack.splice(i, 1);
      backdrop.remove();
      onClose?.();
    },
  };

  backdrop.addEventListener("mousedown", (e) => { if (e.target === backdrop) handle.close(); });
  modal.querySelector(".modal-x").addEventListener("click", () => handle.close());
  stack.push(handle);
  return handle;
}
