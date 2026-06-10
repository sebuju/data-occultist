// Tiny modal manager: stackable overlays with a title bar, close button,
// backdrop-click and Esc to dismiss. Returns a handle with close().
//
// openModal({ title, size, node, html, onClose, canClose }) — provide either `node`
// (an element) or `html` for the body. size: "large" | "data" | "medium".
// `canClose` is an optional guard: when it returns false, USER dismissal (Esc /
// backdrop / ×) is blocked. handle.close() always closes (programmatic).

const stack = [];

function dismissTop() {
  const top = stack[stack.length - 1];
  if (top) top.dismiss();
}

document.addEventListener("keydown", (e) => { if (e.key === "Escape") dismissTop(); });

export function openModal({ title = "", size = "medium", node = null, html = "", onClose = null, canClose = null } = {}) {
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
    dismiss() {                                  // user-triggered close, honours the guard
      if (canClose && canClose() === false) {
        modal.classList.remove("shake"); void modal.offsetWidth; modal.classList.add("shake");
        return;
      }
      handle.close();
    },
  };

  backdrop.addEventListener("mousedown", (e) => { if (e.target === backdrop) handle.dismiss(); });
  modal.querySelector(".modal-x").addEventListener("click", () => handle.dismiss());
  stack.push(handle);
  return handle;
}
