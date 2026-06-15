// One constructor for every floating panel — node map, activity, precapture. Built on the
// shared drag/resize primitives (dragresize.js), so a panel drags and resizes exactly the
// way a graph node does. Per-panel behaviour (extra header buttons, body rendering, size
// quirks) comes in as callbacks; this owns the shell, header drag, resize, clamping, and
// the bookkeeping that lets layout persistence collect/hydrate panels generically.

import { makeDraggable, addResizeGrips } from "./dragresize.js";

// Registry of live panels by id, so collectLayout/hydrateLayout can round-trip them all
// to profile.layout.float_windows without knowing which panels exist.
const _wins = new Map();
export function floatWins() { return _wins; }

const SNAP = 9;   // px proximity at which an edge snaps
const GAP = 8;    // padding between abutting panels — ALSO the screen-edge + topbar margin,
                  // so a panel docked to the edge sits the same distance in as a docked child.

// Gap below the topbar = the same GAP, so the top margin matches the docking margin.
const _topGap = () => (document.querySelector(".topbar")?.offsetHeight || 48) + GAP;

// Every visible, UNDOCKED panel is anchored TOP-RIGHT: on a window resize it keeps its
// distance from the top (y unchanged) and from the right edge (x shifts by the width
// delta), so panels ride the right side instead of drifting away from it. Docked children
// follow their parent through reflowDock, so they're skipped. ONE shared listener drives
// every panel — not a per-panel copy (see CLAUDE.md hard rule 7).
let _prevW = window.innerWidth;
window.addEventListener("resize", () => {
  const dw = window.innerWidth - _prevW;
  _prevW = window.innerWidth;
  for (const [, w] of _wins) {
    if (w.el.hidden || w.state.dock) continue;
    w.place(w.el.offsetLeft + dw, w.el.offsetTop);   // x+dw = right-anchor; same y = top-anchor
    w.onResize && w.onResize();
  }
});

// Rects of the OTHER visible panels (the things to snap against).
function _otherRects(id) {
  const out = [];
  for (const [k, w] of _wins) {
    if (k === id || w.el.hidden) continue;
    const l = w.el.offsetLeft, t = w.el.offsetTop, ww = w.el.offsetWidth, hh = w.el.offsetHeight;
    out.push({ left: l, top: t, w: ww, h: hh, right: l + ww, bottom: t + hh });
  }
  return out;
}

// Snap a proposed top-left (x,y) for a w×h box so it lines up with nearby panels and the
// screen. Each axis snaps independently to the closest candidate within SNAP px:
//   • EDGE-ALIGN — share a left/right/top/bottom edge or centre with another panel (same line)
//   • ABUT — sit exactly GAP px from another panel's facing edge (clean padding)
//   • SCREEN — hug the viewport edges (below the topbar)
function snapBox(id, x, y, w, h) {
  const W = window.innerWidth, H = window.innerHeight, top = _topGap();
  const xc = [GAP, W - GAP - w];             // screen left / right (GAP margin)
  const yc = [top, H - GAP - h];             // screen top / bottom (GAP margin)
  for (const o of _otherRects(id)) {
    xc.push(o.left, o.right - w, o.left + o.w / 2 - w / 2,   // left / right / centre align
            o.right + GAP, o.left - GAP - w);                // abut to its right / left
    yc.push(o.top, o.bottom - h, o.top + o.h / 2 - h / 2,    // top / bottom / centre align
            o.bottom + GAP, o.top - GAP - h);                // abut below / above
  }
  const nearest = (v, cands) => {
    let best = v, bd = SNAP;
    for (const c of cands) { const d = Math.abs(c - v); if (d < bd) { bd = d; best = c; } }
    return best;
  };
  return [nearest(x, xc), nearest(y, yc)];
}

// Snap a single moving edge (resize) to a nearby panel edge (align) / GAP-offset (abut) /
// screen edge. axis "x" → a left|right edge value; "y" → a top|bottom edge value.
function snapEdgeVal(id, axis, v) {
  const W = window.innerWidth, H = window.innerHeight, top = _topGap();
  const cands = axis === "x" ? [GAP, W - GAP] : [top, H - GAP];
  for (const o of _otherRects(id)) {
    if (axis === "x") cands.push(o.left, o.right, o.left - GAP, o.right + GAP);
    else cands.push(o.top, o.bottom, o.top - GAP, o.bottom + GAP);
  }
  let best = v, bd = SNAP;
  for (const c of cands) { const d = Math.abs(c - v); if (d < bd) { bd = d; best = c; } }
  return best;
}

// ---- light docking ---------------------------------------------------------
// A panel may be "docked" below another (state.dock = { to, dx }): it sits GAP px under the
// parent's bottom edge, offset dx px from the parent's left. When the parent moves/resizes/
// collapses, reflowDock re-places every descendant so the stack stays glued. Chains work —
// each docked child reflows its own children in turn. Dragging a panel out of snap range at
// settle clears its dock (dismantles that link).

// would docking `selfId` under `parentId` form a cycle? (parentId already below selfId)
function _wouldCycle(selfId, parentId) {
  let cur = parentId, guard = 0;
  while (cur && guard++ < 64) {
    if (cur === selfId) return true;
    const w = _wins.get(cur);
    cur = w && w.state.dock ? w.state.dock.to : null;
  }
  return false;
}

// re-place every panel docked (directly or transitively) below `id`. `seen` guards cycles
// and stops the place()→reflow→place() recursion from looping.
//
// A docked child is anchored TOP-RIGHT to the parent's BOTTOM-RIGHT: its right edge lines up
// with the parent's right edge and it sits GAP px under the parent's bottom. The child keeps
// its OWN width — docks never resize each other to match. Chains work (each placed child
// reflows its own children via place()). (`oldL`/`oldR` accepted for call-site compat, unused.)
function reflowDock(id, seen, oldL, oldR) {   // eslint-disable-line no-unused-vars
  seen = seen || new Set();
  if (seen.has(id)) return;
  seen.add(id);
  const p = _wins.get(id);
  if (!p || p.el.hidden) return;
  const pr = p.el.offsetLeft + p.el.offsetWidth;    // parent right edge
  const pb = p.el.offsetTop + p.el.offsetHeight;    // parent bottom edge
  for (const [, w] of _wins) {
    const d = w.state.dock;
    if (!d || d.to !== id || w.el.hidden) continue;
    d.ar = true; d.dx = 0;
    // child's right edge = parent's right edge; child's top = parent's bottom + GAP
    w.place(pr - w.el.offsetWidth, pb + GAP, seen);   // place() recurses into reflowDock
  }
}

// find a panel whose bottom edge `id` is currently resting on (for dock-on-settle)
function findDockParent(id) {
  const self = _wins.get(id);
  if (!self) return null;
  const sl = self.el.offsetLeft, st = self.el.offsetTop, sr = sl + self.el.offsetWidth;
  for (const [k, w] of _wins) {
    if (k === id || w.el.hidden) continue;
    const al = w.el.offsetLeft, pr = al + w.el.offsetWidth, ab = w.el.offsetTop + w.el.offsetHeight;
    const horiz = sl < pr && sr > al;                 // overlap horizontally
    const vert = Math.abs(st - (ab + GAP)) <= SNAP;   // resting just below its bottom
    if (horiz && vert && !_wouldCycle(id, k)) return { to: k, dx: sl - al, ar: Math.abs(sr - pr) <= SNAP };
  }
  return null;
}

// find an UNDOCKED panel now resting directly below `id` (it was dropped above one) so the
// upper one adopts it. Won't steal a panel already in a chain.
function findDockChild(id) {
  const self = _wins.get(id);
  if (!self) return null;
  const sl = self.el.offsetLeft, sr = sl + self.el.offsetWidth, sb = self.el.offsetTop + self.el.offsetHeight;
  for (const [k, w] of _wins) {
    if (k === id || w.el.hidden || w.state.dock) continue;
    const al = w.el.offsetLeft, cr = al + w.el.offsetWidth, at = w.el.offsetTop;
    const horiz = sl < cr && sr > al;
    const vert = Math.abs(at - (sb + GAP)) <= SNAP;
    if (horiz && vert && !_wouldCycle(k, id)) { w.state.dock = { to: id, dx: al - sl, ar: Math.abs(cr - sr) <= SNAP }; return w; }
  }
  return null;
}

// Raise the just-touched panel above the others: only one carries `fw-focused` (z above
// every other panel) at a time, so the panel you last interacted with always sits on top.
function _focus(el) {
  for (const [, w] of _wins) w.el.classList.toggle("fw-focused", w.el === el);
}

// opts:
//   id, title           — element id + header text
//   headerExtra         — extra header HTML (e.g. a mode-toggle button), wired by the caller
//   state               — the persistent {visible,x,y,w,h,…} object (the panel owns it)
//   bothAxes            — resize height too? boolean or () => boolean (false = width only)
//   onResize            — called live during resize and on relevant size changes
//   onShow / onHide     — visibility transitions (e.g. start/stop polling, render)
//   onPersist           — schedule a save of state (main passes () => persist.layout())
export function createFloatWin({
  id, title = "", headerExtra = "", state,
  bothAxes = false, onResize = null, onShow = null, onHide = null, onPersist = null,
}) {
  state.collapsed = !!state.collapsed;   // ensure the key exists so it round-trips + resets
  if (state.dock === undefined) state.dock = null;   // { to, dx } when docked below another panel
  const el = document.createElement("div");
  el.id = id; el.className = "floatwin"; el.hidden = !state.visible;
  el.innerHTML = `<div class="fw-head">
      <span class="fw-title">${title}</span>
      ${headerExtra}
      <button class="fw-collapse" title="collapse / expand">▴</button>
    </div>
    <div class="fw-body"></div>`;
  document.body.appendChild(el);
  // any interaction with this panel raises it above the others (capture, so it fires even
  // when an inner handler stops propagation).
  el.addEventListener("pointerdown", () => _focus(el), true);
  const head = el.querySelector(".fw-head");
  const body = el.querySelector(".fw-body");

  if (Number.isFinite(state.w)) el.style.width = `${state.w}px`;
  if (Number.isFinite(state.h)) el.style.height = `${state.h}px`;

  const save = () => onPersist && onPersist();

  // Keep the panel fully on-screen and below the topbar (never off-screen / over the bar).
  function clamp(x, y, w, h) {
    const top = _topGap();
    const maxX = Math.max(GAP, window.innerWidth - w - GAP);
    const maxY = Math.max(top, window.innerHeight - h - GAP);
    return [Math.max(GAP, Math.min(maxX, x)), Math.max(top, Math.min(maxY, y))];
  }
  // prevL/prevR = my left/right edge as of the last placement — fed to reflowDock as the
  // "before" edges so docked children can tell if they were right-aligned to me.
  let prevL = null, prevR = null;
  function place(x, y, seen, oldL, oldR) {
    if (oldL == null) { oldL = prevL != null ? prevL : el.offsetLeft; oldR = prevR != null ? prevR : oldL + el.offsetWidth; }
    const [cx, cy] = clamp(x, y, el.offsetWidth, el.offsetHeight);
    el.style.left = `${cx}px`; el.style.top = `${cy}px`;
    state.x = cx; state.y = cy;
    prevL = cx; prevR = cx + el.offsetWidth;
    reflowDock(id, seen, oldL, oldR);   // drag anything docked below me along (chains too)
  }
  // initial placement: saved, else top-right under the topbar
  place(Number.isFinite(state.x) ? state.x : window.innerWidth - (state.w || 288) - 8,
        Number.isFinite(state.y) ? state.y : 56);

  // record the panel's current box into state (skip the 0×0 hidden size + the short
  // collapsed height, which would otherwise overwrite the real expanded box)
  function stashSize() {
    if (el.hidden || state.collapsed || !el.offsetWidth) return;
    state.w = el.offsetWidth;   // every panel (docked or not) owns its width now
    state.h = el.offsetHeight;
  }

  // never restore a box bigger than the viewport (the window may have shrunk since saving)
  function applySize() {
    const maxW = Math.max(180, window.innerWidth - 8);
    const maxH = Math.max(90, window.innerHeight - _topGap() - 8);
    if (Number.isFinite(state.w)) { const w = Math.min(state.w, maxW); el.style.width = `${w}px`; state.w = w; }
    // height only when expanded — collapsed height is owned by applyCollapsed (auto = header)
    if (!state.collapsed && Number.isFinite(state.h)) { const h = Math.min(state.h, maxH); el.style.height = `${h}px`; state.h = h; }
    if (Number.isFinite(state.x) && Number.isFinite(state.y)) place(state.x, state.y);
  }

  // header drag — the SAME loop graph nodes use; clicks on header buttons aren't drags
  let gdx = 0, gdy = 0;
  makeDraggable(el, {
    handle: head, cursor: "grabbing", ignore: "button",
    // user grabbed it -> detach from its own parent (re-evaluated on settle); children stay
    onStart: (ev) => { state.dock = null; const r = el.getBoundingClientRect(); gdx = ev.clientX - r.left; gdy = ev.clientY - r.top; },
    onMove: (e) => {
      let x = e.clientX - gdx, y = e.clientY - gdy;
      // snap to nearby panels (shared edge / centre line) + screen edges — hold Alt to bypass
      if (!e.altKey) [x, y] = snapBox(id, x, y, el.offsetWidth, el.offsetHeight);
      place(x, y);
    },
    // dock under whatever panel we came to rest on (null if dragged clear -> dismantled);
    // also adopt a panel we were dropped directly on top of, then reflow the stack. Widths
    // are never touched by docking now, so there's nothing to restore on undock.
    onSettle: () => { state.dock = findDockParent(id); findDockChild(id);
      if (state.dock) reflowDock(state.dock.to);   // parent re-anchors me top-right under it
      reflowDock(id); save(); },
  });

  // resize grips on both bottom corners — the SAME grips nodes use (smooth, no grid-snap).
  // The live `onResize` refit comes from the ResizeObserver below (the grip just writes the
  // style; the observer fires), so grips only need to persist on settle.
  addResizeGrips(el, {
    both: bothAxes,
    left: (v) => { if (v === undefined) return el.offsetLeft; const x = Math.max(4, v); el.style.left = `${x}px`; state.x = x; },
    snapEdge: (axis, v) => snapEdgeVal(id, axis, v),   // align resize edges to other panels
    onSettle: () => { state.userSized = true; markSized(); stashSize(); save(); },   // manual resize -> stop auto-fitting
    // reset dot: drop the user's size back to the panel's default box
    onReset: () => {
      state.userSized = false;   // resume any auto-fit
      state.w = _default.w; state.h = _default.h;
      el.style.width = ""; el.style.height = "";   // undefined default → natural CSS size
      applySize(); markSized();
      onResize && onResize();
      save();
    },
  });
  // reset dot is shown only once the panel carries a user-set size (CSS gates on .fw-sized)
  function markSized() { el.classList.toggle("fw-sized", !!state.userSized); }
  markSized();

  // CSS-resize / programmatic size changes: re-fit + persist (debounced)
  let rt = null;
  new ResizeObserver(() => {
    if (el.hidden || state.collapsed || !el.offsetWidth) return;
    stashSize();
    reflowDock(id, null, prevL, prevR);   // height/width changed -> slide docked panels (using my pre-resize edges)
    prevL = el.offsetLeft; prevR = prevL + el.offsetWidth;
    onResize && onResize();
    clearTimeout(rt); rt = setTimeout(save, 300);
  }).observe(el);

  // collapse/expand: shrink to just the header buttons (visibility is the topbar button's
  // job; this is a shade roll-up in BOTH axes). Collapsed state persists with the panel.
  function applyCollapsed() {
    el.classList.toggle("collapsed", state.collapsed);
    const btn = el.querySelector(".fw-collapse");
    if (btn) btn.textContent = state.collapsed ? "▾" : "▴";   // collapsed → roll down; expanded → roll up
    if (state.collapsed) {
      el.style.height = "";
      el.style.width = "";   // shrink to the header (docks never match widths)
    } else {                                                                // restore the box
      el.style.removeProperty("width");
      if (Number.isFinite(state.w)) el.style.width = `${state.w}px`;   // my own saved width
      if (Number.isFinite(state.h)) el.style.height = `${state.h}px`;
    }
  }
  function toggleCollapsed() {
    const oldL = el.offsetLeft, oldR = oldL + el.offsetWidth;   // edges before folding (pin the right one)
    if (!state.collapsed) stashSize();   // capture the expanded box before folding
    state.collapsed = !state.collapsed;
    applyCollapsed();
    // re-anchor by the right edge (expand → restores left); pass the OLD edges so a docked
    // child that was right-aligned to me stays right-aligned after the width change
    place(oldR - el.offsetWidth, el.offsetTop, null, oldL, oldR);
    if (!state.collapsed) onResize && onResize();   // re-render the freshly shown body
    save();
  }
  el.querySelector(".fw-collapse").addEventListener("click", toggleCollapsed);

  function setVisible(on) {
    state.visible = on;
    el.hidden = !on;
    if (on) { applySize(); applyCollapsed(); if (state.dock) reflowDock(state.dock.to); onShow && onShow(); } else onHide && onHide();
    save();
  }
  // reflect state (just loaded from YAML) onto the panel
  function applyState() {
    applySize();
    applyCollapsed();
    markSized();   // reflect the loaded user-sized flag onto the reset-dot gate
    el.hidden = !state.visible;
    if (state.dock && state.visible) reflowDock(state.dock.to);   // snap under my parent
    if (state.visible) onShow && onShow(); else onHide && onHide();
  }
  function collect() { stashSize(); return { ...state }; }
  // Restore to defaults, then overlay the saved blob — so switching to a profile that never
  // saved this panel resets it (e.g. back to hidden) instead of leaking the last profile's box.
  const _default = JSON.parse(JSON.stringify(state));
  function hydrate(blob) {
    Object.assign(state, JSON.parse(JSON.stringify(_default)), blob || {});
    applyState();
  }

  const inst = { el, body, head, state, setVisible, applyState, place, stashSize, applySize, collect, hydrate, onResize };
  _wins.set(id, inst);
  return inst;
}
