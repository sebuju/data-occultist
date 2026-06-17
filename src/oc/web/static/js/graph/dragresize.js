// Shared drag + resize primitives for everything the user can move or size — graph
// nodes AND the floating panels (node map, activity, precapture). Resize was already
// one primitive (addResizeGrips); drag used to be reimplemented per place (node move,
// panel header). Both live here now, so a node and a panel are built the same way.

// ---- grid ------------------------------------------------------------------

export const GRID = 20;
export const snap = (v) => Math.round(v / GRID) * GRID;

// ---- floating W×H readout shown while resizing -----------------------------

let _sizeHud = null;
// Closest integer aspect ratio "(N:1)" / "(1:N)". Exactness is an INTEGER divisibility test
// (a % b === 0) — no float compare, so a true ratio never reads as "~" from precision noise.
function aspectLabel(w, h) {
  if (!w || !h) return "";
  const a = Math.max(w, h), b = Math.min(w, h);
  const n = Math.max(1, Math.round(a / b));
  const tilde = a % b === 0 ? "" : "~";
  return ` (${tilde}${w >= h ? `${n}:1` : `1:${n}`})`;
}
export function showSizeHud(w, h, clientX, clientY) {
  if (!_sizeHud) { _sizeHud = document.createElement("div"); _sizeHud.className = "size-hud"; document.body.appendChild(_sizeHud); }
  const rw = Math.round(w), rh = Math.round(h);
  _sizeHud.textContent = `${rw} × ${rh}${aspectLabel(rw, rh)}`;
  _sizeHud.style.left = `${clientX + 16}px`; _sizeHud.style.top = `${clientY + 16}px`;
  _sizeHud.style.display = "";
}
export function hideSizeHud() { if (_sizeHud) _sizeHud.style.display = "none"; }

// ---- resize grips ----------------------------------------------------------

// Custom resize grips on BOTH bottom corners. Native CSS resize is disabled on these
// elements (its OS-drawn bottom-right handle can't be matched by CSS), so both corners are
// our own identical, mirrored grips. The LEFT grip anchors the right edge (it moves the
// element left via `opts.left`); the RIGHT grip anchors the left edge. `both` also resizes
// height; `zoom` accounts for canvas zoom; `left` reads/writes the left edge (pos.x for
// graph nodes, style.left for floating panels).
// `snapEdge(axis, value)` (optional) snaps a moving edge to nearby alignment lines — floating
// panels pass it so resize lines up with other panels; graph nodes leave it null.
// `onReset` (optional) adds a small dot centred between the two grips that restores the
// element's default size on click — revealed, like the grips, only while hovering the element.
// `screenClamp` (panels only) caps the new size so the element never grows past the viewport
// edges — its anchored top + fixed corner stay put, so only the moving edge/bottom is limited,
// leaving `margin` px clear. Graph nodes leave it off (they live in zoomed/panned canvas space,
// not viewport space, so a viewport clamp would be meaningless there).
export function addResizeGrips(el, { both = false, zoom = () => 1, left = null, snap: snapGrid = false, onResize = null, onSettle = null, snapEdge = null, onReset = null, screenClamp = false, margin = 0 } = {}) {
  if (el.querySelector(":scope > .rz-grip")) return;   // once only
  const q = (v) => (snapGrid ? snap(v) : v);   // grid-step nodes; panels resize smoothly
  for (const side of ["left", "right"]) {
    if (side === "left" && !left) continue;            // left grip needs a left-edge accessor
    const g = document.createElement("div");
    g.className = `rz-grip rz-${side[0]}grip`; g.title = "resize";
    el.appendChild(g);
    g.addEventListener("mousedown", (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      const allowH = typeof both === "function" ? both() : both;   // may depend on live state
      const z = zoom() || 1, sx = ev.clientX, sy = ev.clientY;
      const startW = el.offsetWidth, startH = el.offsetHeight, startL = left ? left() : 0;
      const startT = el.offsetTop;
      const rect = screenClamp ? el.getBoundingClientRect() : null;   // fixed-edge anchor in viewport px
      let lastW = startW, lastH = startH;
      document.body.style.cursor = side === "left" ? "nesw-resize" : "nwse-resize";
      const mv = (e) => {
        let w = Math.max(1, q(side === "left" ? startW - (e.clientX - sx) / z : startW + (e.clientX - sx) / z));
        let h = Math.max(1, q(startH + (e.clientY - sy) / z));
        // snap the moving edge(s) to nearby panel/screen lines (panels only; Alt bypasses)
        if (snapEdge && !e.altKey) {
          if (side === "left") w = Math.max(1, (startL + startW) - snapEdge("x", startL + startW - w));
          else w = Math.max(1, snapEdge("x", startL + w) - startL);   // right edge
          if (allowH) h = Math.max(1, snapEdge("y", startT + h) - startT);   // bottom edge
        }
        // hard screen-bounds clamp (final authority, after snapping): the right/left grip's
        // fixed edge (rect.right / rect.left) + the fixed top stay put, so cap the growing
        // dimensions to keep `margin` px clear of the viewport edges.
        if (rect) {
          const maxW = side === "left" ? rect.right - margin : (window.innerWidth - margin) - rect.left;
          w = Math.min(w, Math.max(1, maxW));
          if (allowH) h = Math.min(h, Math.max(1, (window.innerHeight - margin) - rect.top));
        }
        // only act on a REAL size step (else snapped sub-grid moves churn resize+reroute)
        if (w === lastW && (!allowH || h === lastH)) return;
        lastW = w; lastH = h;
        el.style.width = `${w}px`;
        if (allowH) el.style.height = `${h}px`;
        if (side === "left") left(startL - (el.offsetWidth - startW));   // anchor right edge
        showSizeHud(el.offsetWidth, el.offsetHeight, e.clientX, e.clientY);   // live W×H readout
        onResize && onResize();
      };
      const up = () => {
        document.removeEventListener("mousemove", mv); document.removeEventListener("mouseup", up);
        document.body.style.cursor = ""; hideSizeHud(); onSettle && onSettle();
      };
      document.addEventListener("mousemove", mv); document.addEventListener("mouseup", up);
    });
  }
  // reset-size dot, centred between the grips (hover-revealed via CSS like the grips)
  if (onReset) {
    const r = document.createElement("div");
    r.className = "rz-reset"; r.title = "reset size";
    el.appendChild(r);
    r.addEventListener("mousedown", (ev) => { ev.preventDefault(); ev.stopPropagation(); });   // don't start a drag/resize
    r.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); onReset(); });
  }
}

// ---- drag loop -------------------------------------------------------------

// The one mousedown→track-mousemove→mouseup loop. Begin it imperatively from a pointer
// event already in hand (node move, group-title handoff) — the caller's `onMove(e)` does
// the space-specific work (world delta + snap for nodes, screen clamp for panels). With a
// `threshold` it waits until the cursor moves that far before activating, so a control that
// is BOTH clickable and draggable (collapse caret, title input) can tell a click from a
// drag. Returns a `stop()` that tears the loop down (used to hand off to another drag).
export function beginDrag(ev, { threshold = 0, cursor = "", onStart = null, onMove = null, onSettle = null } = {}) {
  const sx = ev.clientX, sy = ev.clientY;
  let active = false;
  const activate = () => {
    active = true;
    if (cursor) document.body.style.cursor = cursor;
    onStart && onStart(ev);
  };
  const mv = (e) => {
    if (!active) {
      if (Math.hypot(e.clientX - sx, e.clientY - sy) < threshold) return;
      activate();
    }
    onMove && onMove(e);
  };
  const stop = () => {
    document.removeEventListener("mousemove", mv); document.removeEventListener("mouseup", up);
    if (cursor) document.body.style.cursor = "";
  };
  const up = (e) => { const wasActive = active; stop(); if (wasActive) onSettle && onSettle(e); };
  document.addEventListener("mousemove", mv); document.addEventListener("mouseup", up);
  if (threshold <= 0) activate();   // no gate -> drag from the first pixel
  return stop;
}

// Make `el` draggable by a `handle` (default the element itself). Attaches the mousedown;
// clicks on `ignore` selectors (buttons/inputs in the handle) don't start a drag. Thin
// wrapper over beginDrag so panels and any future draggable use the exact same loop.
export function makeDraggable(el, { handle = null, cursor = "grabbing", ignore = "button, input, select, textarea, a", threshold = 0, onStart = null, onMove = null, onSettle = null } = {}) {
  const h = handle || el;
  h.addEventListener("mousedown", (ev) => {
    if (ev.button !== 0) return;
    if (ignore && ev.target.closest(ignore)) return;
    ev.preventDefault();
    beginDrag(ev, { threshold, cursor, onStart, onMove, onSettle });
  });
}
