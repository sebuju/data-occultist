// One constructor for every floating panel — node map, activity, precapture. Built on the
// shared drag/resize primitives (dragresize.js), so a panel drags and resizes exactly the
// way a graph node does. Per-panel behaviour (extra header buttons, body rendering, size
// quirks) comes in as callbacks; this owns the shell, header drag, resize, clamping, and
// the bookkeeping that lets layout persistence collect/hydrate panels generically.

import { makeDraggable, addResizeGrips } from "./dragresize.js";

// Registry of live panels by id. Panels are SESSION-ONLY (not persisted): hydrateLayout resets
// them all to their hidden defaults on load; nothing writes their state back to the profile.
const _wins = new Map();
export function floatWins() { return _wins; }

const SNAP = 9;   // px proximity at which an edge snaps
const GAP = 8;    // padding between abutting panels — ALSO the screen-edge + topbar margin,
                  // so a panel docked to the edge sits the same distance in as a docked child.
const RESET_W = 300;   // every panel resets to this width (uniform), whatever its default

// Gap below the topbar = the same GAP, so the top margin matches the docking margin.
const _topGap = () => (document.querySelector(".topbar")?.offsetHeight || 48) + GAP;

// Every visible, UNDOCKED panel is anchored TOP-RIGHT: on a window resize it keeps its
// distance from the top (y unchanged) and from the right edge (x shifts by the width
// delta), so panels ride the right side instead of drifting away from it. Docked children
// follow their parent through reflowDock, so they're skipped. ONE shared listener drives
// every panel — not a per-panel copy.
let _prevW = window.innerWidth;
window.addEventListener("resize", () => {
  const dw = window.innerWidth - _prevW;
  _prevW = window.innerWidth;
  for (const [, w] of _wins) {
    if (w.el.hidden || w.state.dock) continue;
    w.place(w.el.offsetLeft + dw, w.el.offsetTop);   // x+dw = right-anchor; same y = top-anchor
    w.onResize && w.onResize();
    w.fitHeight && w.fitHeight();   // viewport changed -> re-fit (the max-height cap may have moved)
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

// Every visible panel docked (directly or transitively) below `id`, ordered top→bottom by
// on-screen position. Used to drive the whole docked chain at once (shift-collapse, fit).
function dockDescendants(id) {
  const out = [];
  const visit = (pid) => {
    for (const [k, w] of _wins) if (!w.el.hidden && w.state.dock && w.state.dock.to === pid) { out.push(k); visit(k); }
  };
  visit(id);
  out.sort((a, b) => _wins.get(a).el.offsetTop - _wins.get(b).el.offsetTop);
  return out;
}

// Walk up the dock links to the topmost panel of `id`'s chain (the one nothing carries it under).
function chainRoot(id) {
  let cur = id, guard = 0;
  while (guard++ < 64) {
    const w = _wins.get(cur);
    const to = w && w.state.dock ? w.state.dock.to : null;
    if (!to || !_wins.get(to) || _wins.get(to).el.hidden) return cur;
    cur = to;
  }
  return cur;
}

// Lowest pixel any visible member of `chain` reaches.
function _chainBottom(chain) {
  let b = 0;
  for (const id of chain) { const w = _wins.get(id); if (w && !w.el.hidden) b = Math.max(b, w.el.offsetTop + w.el.offsetHeight); }
  return b;
}

// After a panel expands, its docked chain can overrun the screen bottom. Collapse trailing
// (bottom-most) members one at a time — re-measuring after each — until the chain fits.
function fitChainToScreen(id) {
  const root = chainRoot(id);
  const chain = [root, ...dockDescendants(root)];
  reflowDock(root);
  const limit = window.innerHeight - GAP;
  for (let i = chain.length - 1; i >= 1 && _chainBottom(chain) > limit; i--) {
    const w = _wins.get(chain[i]);
    if (w && !w.el.hidden && !w.state.collapsed) { w.collapse(true); reflowDock(root); }
  }
}

// First free spot for a w×h panel: start at the top-right column and slide DOWN past any
// panel it would overlap. If the column fills to the screen bottom, step LEFT one panel-width
// and try that column from the top — so panels that can't fit on the right find room further
// left instead of stacking on top of each other. Falls back to top-right (clamped) only when
// no column has room. Used when a hidden panel is reopened with no saved position.
function findFreeSlot(id, w, h) {
  const W = window.innerWidth, H = window.innerHeight, top = _topGap();
  const rects = _otherRects(id);
  const bottom = H - GAP;
  for (let x = Math.max(GAP, W - w - GAP); x >= GAP; x -= w + GAP) {
    let y = top, guard = 0;
    while (guard++ < 200) {
      const hit = rects.find((o) => x < o.right && x + w > o.left && y < o.bottom && y + h > o.top);
      if (!hit) break;
      y = hit.bottom + GAP;
    }
    if (y + h <= bottom) return [x, y];   // fits in this column -> done
  }
  return [Math.max(GAP, W - w - GAP), top];   // every column full -> top-right (clamp keeps it on-screen)
}

// Raise the just-touched panel above the others: only one carries `fw-focused` (z above
// every other panel) at a time, so the panel you last interacted with always sits on top.
function _focus(el) {
  for (const [, w] of _wins) w.el.classList.toggle("fw-focused", w.el === el);
}

// Reflect dock state visually: a docked panel carries `fw-docked` (a small accent cue, see
// floatwin.css). Synced after any dock mutation (settle / hide-reparent / load / reset).
function _syncDockMarks() {
  for (const [, w] of _wins) w.el.classList.toggle("fw-docked", !!w.state.dock);
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
  autoFit = true,   // height auto-fits the content; width is the only preset/user-sized axis.
                    // Panels with their own height logic (the node map's aspect fit) pass false.
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
  // height only for auto-fit / user-sized panels; content-driven panels stay CSS-sized even if
  // a stale state.h was carried in (else they spawn pinned at min-height — "resets to nothing").
  if (Number.isFinite(state.h) && (autoFit || state.userSized)) el.style.height = `${state.h}px`;

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
    // Height is the CSS/content-driven axis for non-autoFit panels until the user manually
    // resizes it (userSized). Stashing the TRANSIENT height of an empty/mid-render body (a
    // re-render briefly empties it -> ResizeObserver fires at min-height) would pin that value
    // via applySize and collapse the panel to min-height — the inspector "resets to nothing"
    // bug. Only persist height once it's genuinely owned: auto-fit or a manual resize.
    if (autoFit || state.userSized) state.h = el.offsetHeight;
  }

  // Auto-fit the panel HEIGHT to its content — the ONE shared height-fit for every panel
  // (replaces the old per-panel copies). Width is the only preset/user-sized axis; height
  // always tracks what the body holds. Measured by briefly going height:auto (so flex-fill
  // panes collapse to their natural content), clamped to the viewport, written only on a real
  // >1px change so a steady poll-tick mutates nothing. No-op while collapsed/hidden or off.
  function fitHeight() {
    if (!autoFit || el.hidden || state.collapsed || state.userSized || !el.offsetWidth) return;
    const cur = el.offsetHeight;
    el.style.height = "auto";
    const natural = el.offsetHeight;
    const maxH = Math.max(90, window.innerHeight - _topGap() - GAP);
    const target = Math.round(Math.min(maxH, natural));
    if (Math.abs(cur - target) > 1) { el.style.height = `${target}px`; state.h = target; }
    else el.style.height = `${cur}px`;   // restore a definite height (we were briefly auto)
  }

  // never restore a box bigger than the viewport (the window may have shrunk since saving)
  function applySize() {
    const maxW = Math.max(180, window.innerWidth - 8);
    const maxH = Math.max(90, window.innerHeight - _topGap() - 8);
    if (Number.isFinite(state.w)) { const w = Math.min(state.w, maxW); el.style.width = `${w}px`; state.w = w; }
    // CSS-preset width (state.w null) wider than the viewport -> cap it so it never spawns off-screen.
    // Inline-only (don't write state.w), so a reset still falls back to the per-panel CSS preset.
    else if (!el.hidden && el.offsetWidth > maxW) el.style.width = `${maxW}px`;
    // height only when expanded — collapsed height is owned by applyCollapsed (auto = header).
    // Never pin height on a content-driven panel that the user hasn't resized: leave it CSS/
    // content-sized (a stale state.h would otherwise collapse it — the "resets to nothing" bug).
    if (!state.collapsed && Number.isFinite(state.h) && (autoFit || state.userSized)) { const h = Math.min(state.h, maxH); el.style.height = `${h}px`; state.h = h; }
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
      reflowDock(id); _syncDockMarks(); save(); },
  });

  // resize grips on both bottom corners — the SAME grips nodes use (smooth, no grid-snap).
  // The live `onResize` refit comes from the ResizeObserver below (the grip just writes the
  // style; the observer fires), so grips only need to persist on settle.
  addResizeGrips(el, {
    both: bothAxes,   // height IS manually resizable; a manual resize sets userSized -> stops the auto-fit
    screenClamp: true, margin: GAP,   // never let a resize push the panel off-screen
    left: (v) => { if (v === undefined) return el.offsetLeft; const x = Math.max(4, v); el.style.left = `${x}px`; state.x = x; },
    snapEdge: (axis, v) => snapEdgeVal(id, axis, v),   // align resize edges to other panels
    onSettle: () => { state.userSized = true; markSized(); stashSize(); save(); },   // manual size -> stop auto-fitting
    // reset dot: drop the user's WIDTH back to the panel's preset (CSS default); height re-fits
    onReset: () => {
      state.userSized = false;
      state.w = RESET_W; state.h = null;   // width -> uniform preset (300); height -> auto-fit
      el.style.width = ""; el.style.height = "";
      applySize(); markSized();
      onResize && onResize(); fitHeight();
      save();
    },
  });
  // reset dot is shown only once the panel carries a user-set size (CSS gates on .fw-sized)
  function markSized() { el.classList.toggle("fw-sized", !!state.userSized); }
  markSized();

  // CSS-resize / programmatic size changes: re-fit + persist (debounced)
  let rt = null, _obsW = el.offsetWidth;
  new ResizeObserver(() => {
    if (el.hidden || state.collapsed || !el.offsetWidth) return;
    const widthChanged = Math.abs(el.offsetWidth - _obsW) > 0.5;
    _obsW = el.offsetWidth;
    stashSize();
    reflowDock(id, null, prevL, prevR);   // height/width changed -> slide docked panels (using my pre-resize edges)
    prevL = el.offsetLeft; prevR = prevL + el.offsetWidth;
    onResize && onResize();
    if (widthChanged) fitHeight();   // a width change rewraps the content -> re-fit the height to it
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
  // Fold/unfold to an explicit state (no-op if already there). Re-anchors by the right edge so
  // the collapse button stays put and any right-aligned docked child stays aligned.
  function setCollapsed(val) {
    if (state.collapsed === val) return;
    const oldL = el.offsetLeft, oldR = oldL + el.offsetWidth;   // edges before folding (pin the right one)
    if (val) stashSize();   // capture the expanded box before folding
    state.collapsed = val;
    applyCollapsed();
    place(oldR - el.offsetWidth, el.offsetTop, null, oldL, oldR);
    if (!val) { onResize && onResize(); fitHeight(); }   // re-render the freshly shown body + re-fit
  }
  // Toolbar/header toggle. Shift+click applies the SAME resulting state to every panel docked
  // below this one (drive the whole chain, not a per-panel toggle). Expanding may overrun the
  // screen, so fit the chain afterwards (collapses trailing members back if needed).
  function toggleCollapsed(ev) {
    const target = !state.collapsed;
    setCollapsed(target);
    if (ev && ev.shiftKey) for (const cid of dockDescendants(id)) _wins.get(cid)?.collapse(target);
    if (!target) fitChainToScreen(id);
    save();
  }
  el.querySelector(".fw-collapse").addEventListener("click", toggleCollapsed);

  // `reset` (topbar open): start from a fresh default box (authored preset width, auto-fit
  // height, expanded, not user-sized) rather than whatever size it carried when last hidden.
  function setVisible(on, reset = false) {
    state.visible = on;
    el.hidden = !on;
    if (on) {
      if (_embedHost) unembed();   // opening in the graph reclaims the body from any pretty embed
      if (reset) {
        state.collapsed = !!_default.collapsed; state.userSized = false;
        state.w = RESET_W; state.h = null;   // width -> uniform preset (300); height -> auto-fit
        el.style.width = ""; el.style.height = "";
      }
      applySize(); applyCollapsed(); markSized();
      _focus(el);   // a freshly opened panel rides above the others (same as clicking it)
      // Render the body FIRST, then find a position. onShow builds/sizes the content (fit-to-
      // content panels set their real height in here), so findFreeSlot + clamp below operate on
      // the panel's TRUE dimensions instead of its pre-render size. onShow can re-hide a panel
      // that can't open (e.g. precap with no game), so guard the placement on still being visible.
      onShow && onShow();
      if (state.visible) {
        fitHeight();   // size to content (now rendered) BEFORE positioning, so placement uses the real height
        // reopened with no saved spot (cleared on hide) -> find a free one instead of reusing
        // wherever it last sat (which may now be occupied / off a resized screen). If that spot
        // landed directly below another panel, DOCK under it so it joins the chain.
        if (!Number.isFinite(state.x) || !Number.isFinite(state.y)) {
          const [x, y] = findFreeSlot(id, el.offsetWidth || state.w || RESET_W, el.offsetHeight || 120);
          place(x, y);
          const dp = findDockParent(id);
          if (dp) { state.dock = dp; reflowDock(dp.to); }
        }
        if (state.dock) reflowDock(state.dock.to);
        reflowDock(id);   // drag any children that are still docked under me into place
      }
    } else {
      // hiding via the topbar: pull my docked chain UP to fill the gap I leave. My direct
      // child re-docks to my parent (slides up under it); if I was the chain root, my child
      // takes my old top slot and becomes the new root. Its own descendants follow via place/
      // reflow. (el is already display:none here, so its offsetTop reads 0 — use the saved y.)
      const parent = state.dock && _wins.get(state.dock.to) && !_wins.get(state.dock.to).el.hidden ? state.dock.to : null;
      const myTop = Number.isFinite(state.y) ? state.y : el.offsetTop;
      for (const [, w] of _wins) {
        if (w.el.hidden || !w.state.dock || w.state.dock.to !== id) continue;
        if (parent) w.state.dock = { ...w.state.dock, to: parent };   // re-anchor under my parent
        else { w.state.dock = null; w.place(w.el.offsetLeft, myTop); }   // I was the root -> child takes my slot
      }
      if (parent) reflowDock(parent);   // slide the re-anchored child (+ its chain) up under the parent
      // hiding drops the saved position + dock so the next open re-places it cleanly
      state.x = null; state.y = null; state.dock = null;
      onHide && onHide();
    }
    _syncDockMarks();
    save();
  }
  // reflect state (just loaded from YAML) onto the panel
  function applyState() {
    applySize();
    applyCollapsed();
    markSized();   // reflect the loaded user-sized flag onto the reset-dot gate
    el.hidden = !state.visible;
    if (state.dock && state.visible) reflowDock(state.dock.to);   // snap under my parent
    _syncDockMarks();
    if (state.visible) { onShow && onShow(); fitHeight(); } else onHide && onHide();
  }
  function collect() { stashSize(); return { ...state }; }
  // Restore to defaults, then overlay the saved blob — so switching to a profile that never
  // saved this panel resets it (e.g. back to hidden) instead of leaking the last profile's box.
  const _default = JSON.parse(JSON.stringify(state));
  function hydrate(blob) {
    Object.assign(state, JSON.parse(JSON.stringify(_default)), blob || {});
    applyState();
  }
  // Reset the panel's BOX (size + collapsed + dock) to defaults and re-place it at its
  // default top-right slot — keeps visibility. Bound to shift-clicking the panel's toggle.
  function resetBox() {
    state.w = RESET_W; state.h = null;   // width -> uniform preset (300); height -> auto-fit
    state.collapsed = !!_default.collapsed; state.dock = _default.dock || null;
    state.userSized = false;
    el.style.width = ""; el.style.height = "";
    applySize(); applyCollapsed(); markSized();
    onResize && onResize(); fitHeight();
    place(window.innerWidth - (el.offsetWidth || 288) - GAP, _topGap());
    _syncDockMarks();
    save();
  }

  // ---- embedding (pretty "Embed" widget) -------------------------------------
  // Borrow this panel's body into an external host (a pretty-view widget) so its live content
  // shows there without duplicating it. The body element is MOVED into `host` and the panel is
  // driven as if shown (onShow runs its poll/render) while its own floating frame stays hidden.
  // ONE primitive every panel embeds through (rule 7); unembed()/reclaim() restore it.
  // Caveat: a panel can be embedded in one place at a time — opening it in the graph view
  // (setVisible) reclaims the body back into the floatwin.
  let _embedHost = null, _embedForced = false;
  function embed(host) {
    if (_embedHost === host) { reclaim(); return inst; }
    if (!state.visible) { state.visible = true; _embedForced = true; }
    _embedHost = host;
    onShow && onShow();
    host.appendChild(body);
    return inst;
  }
  function unembed() {
    if (!_embedHost) return;
    _embedHost = null;
    if (el.querySelector(":scope > .fw-body") !== body) el.appendChild(body);   // body back under the frame
    if (_embedForced) { state.visible = false; _embedForced = false; onHide && onHide(); }
  }
  function reclaim() { if (_embedHost && body.parentElement !== _embedHost) _embedHost.appendChild(body); }

  const inst = { el, body, head, state, setVisible, applyState, place, stashSize, applySize, collect, hydrate, onResize, resetBox, fitHeight, collapse: setCollapsed, embed, unembed, reclaim };
  _wins.set(id, inst);
  return inst;
}
