// Custom window chrome for the frameless pywebview desktop window.
//
// The desktop window (oc app / oc view) is opened frameless — no OS title bar —
// so this draws our own: app title + minimise / maximise / close. It is injected
// ONLY when running inside pywebview (detected via `window.pywebview`, which the
// runtime puts on every page it loads, so it survives navigations between the
// graph and teach pages). A plain browser has no such object, so nothing is built
// and the page keeps its normal tab chrome — the bar is invisible there.
//
// Shared by BOTH entry points (graph/main.js + main.js) so the chrome is authored
// once, never copied per page (see CLAUDE.md hard rule 7).
//
// The whole bar carries `pywebview-drag-region`, which pywebview moves the window
// by. The control buttons sit inside it and still receive clicks: pywebview only
// moves the window on mouse-MOVE after a press, so a static click never drags.

const ICON = {
  min: '<svg viewBox="0 0 12 12"><line x1="2" y1="6" x2="10" y2="6"/></svg>',
  max: '<svg viewBox="0 0 12 12"><rect x="2.5" y="2.5" width="7" height="7"/></svg>',
  close: '<svg viewBox="0 0 12 12"><line x1="3" y1="3" x2="9" y2="9"/><line x1="9" y1="3" x2="3" y2="9"/></svg>',
};

let built = false;

function build() {
  if (built) return;
  built = true;

  const bar = document.createElement("div");
  bar.className = "titlebar pywebview-drag-region";
  bar.innerHTML =
    `<span class="tb-title">${document.title}</span>` +
    `<span class="tb-spacer"></span>` +
    `<button class="tb-btn" data-act="min" title="minimize" aria-label="minimize">${ICON.min}</button>` +
    `<button class="tb-btn" data-act="max" title="maximize" aria-label="maximize">${ICON.max}</button>` +
    `<button class="tb-btn tb-close" data-act="close" title="close" aria-label="close">${ICON.close}</button>`;

  bar.addEventListener("click", (e) => {
    const btn = e.target.closest(".tb-btn");
    const api = window.pywebview && window.pywebview.api;
    if (!btn || !api) return;
    const fn = { min: api.minimize, max: api.toggle_maximize, close: api.close }[btn.dataset.act];
    if (fn) fn();
  });

  document.body.insertBefore(bar, document.body.firstChild);
  document.documentElement.classList.add("desktop");
}

// Build now if pywebview is already present; otherwise wait for it to announce
// itself. (`window.pywebview` exists in the desktop window even before the api
// bridge is ready — we only read `.api` at click time, by when it is ready.)
export function initTitlebar() {
  if (typeof window.pywebview !== "undefined") build();
  else window.addEventListener("pywebviewready", build, { once: true });
}
