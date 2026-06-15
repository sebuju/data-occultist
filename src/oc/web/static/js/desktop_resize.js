// Edge + corner resize grips for the frameless desktop window.
//
// The OS draws no sizing border (frameless) and the WebView2 child fills the window, so
// native edge-resize can't work — but the PAGE sees the edge mouse. So we resize here and
// push the new geometry to the native window through pywebview's js_api (`set_bounds`).
//
// Desktop-only: titlebar.js calls initWindowResize() when window.pywebview exists, so a
// browser never builds these. Geometry comes from web standards that, in a frameless
// window, line up with the native window: window.screenX/screenY = window origin,
// innerWidth/innerHeight = window size, pointer.screenX/Y = cursor in screen space.

const MIN_W = 360, MIN_H = 240;   // never resize the window smaller than this

// dir letters: n/s/e/w (which edges this grip drags) + the cursor to show.
const GRIPS = [
  ["n", "ns-resize"], ["s", "ns-resize"], ["e", "ew-resize"], ["w", "ew-resize"],
  ["ne", "nesw-resize"], ["sw", "nesw-resize"], ["nw", "nwse-resize"], ["se", "nwse-resize"],
];

export function initWindowResize() {
  for (const [dir, cursor] of GRIPS) {
    const g = document.createElement("div");
    g.className = `winsize-grip winsize-${dir}`;
    g.style.cursor = cursor;
    g.addEventListener("pointerdown", (e) => beginResize(e, dir));
    document.body.appendChild(g);
  }
}

function beginResize(e, dir) {
  const api = window.pywebview && window.pywebview.api;
  if (e.button !== 0 || !api) return;
  e.preventDefault();
  const grip = e.currentTarget;
  grip.setPointerCapture(e.pointerId);

  const sx = e.screenX, sy = e.screenY;             // pointer at grab, screen space
  const ox = window.screenX, oy = window.screenY;   // window origin at grab
  const ow = window.innerWidth, oh = window.innerHeight;   // window size at grab
  const west = dir.includes("w"), east = dir.includes("e");
  const north = dir.includes("n"), south = dir.includes("s");

  // Coalesce many pointermoves into one bridge call per frame (set_bounds crosses JS->Python).
  let pending = null, raf = 0;
  const flush = () => {
    raf = 0;
    if (!pending) return;
    const b = pending; pending = null;
    api.set_bounds(b.x, b.y, b.w, b.h);
  };

  const onMove = (ev) => {
    const dx = ev.screenX - sx, dy = ev.screenY - sy;
    let w = ow + (east ? dx : west ? -dx : 0);
    let h = oh + (south ? dy : north ? -dy : 0);
    w = Math.max(MIN_W, w);
    h = Math.max(MIN_H, h);
    // dragging a W/N edge moves the origin so the OPPOSITE edge stays put; min-size clamp
    // above caps how far the origin can travel.
    const x = west ? ox + (ow - w) : ox;
    const y = north ? oy + (oh - h) : oy;
    pending = { x, y, w, h };
    if (!raf) raf = requestAnimationFrame(flush);
  };
  const onUp = () => {
    grip.removeEventListener("pointermove", onMove);
    grip.removeEventListener("pointerup", onUp);
    if (raf) cancelAnimationFrame(raf);
    flush();
  };
  grip.addEventListener("pointermove", onMove);
  grip.addEventListener("pointerup", onUp);
}
