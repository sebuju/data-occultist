// Tiny modal manager: stackable overlays with a title bar, close button,
// backdrop-click and Esc to dismiss. Returns a handle with close().
//
// openModal({ title, size, node, html, onClose, canClose }) — provide either `node`
// (an element) or `html` for the body. size: "large" | "data" | "medium".
// `canClose` is an optional guard: when it returns false, USER dismissal (Esc /
// backdrop / ×) is blocked. handle.close() always closes (programmatic).
//
// ABORT-ON-CLOSE (generalized): every modal owns an AbortController. `handle.signal`
// is aborted the instant the modal closes — by ANY path (×, Esc, backdrop, or a
// programmatic close()). Wire every long-running thing the modal starts to it:
//   - fetches: pass `{ signal: handle.signal }` → in-flight requests cancel on close.
//   - intervals/timers/backend jobs: tear them down in `onClose` (e.g. clearInterval,
//     or POST a /cancel for a server-side worker). `onClose` runs AFTER the abort.
// This stops a closed modal from leaving work running in the background.

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

  const aborter = new AbortController();   // cancels everything the modal started

  const handle = {
    el: modal,
    body,
    signal: aborter.signal,
    close() {
      const i = stack.indexOf(handle);
      if (i >= 0) stack.splice(i, 1);
      aborter.abort();        // kill in-flight fetches wired to handle.signal …
      backdrop.remove();
      onClose?.();            // … then run the modal's own teardown (intervals, backend cancel)
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
