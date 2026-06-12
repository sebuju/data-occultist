// Node groups: a titled, outlined, faint-filled box drawn BEHIND the nodes it owns.
// A group is pure arrangement (it means nothing to the backend), so it lives in
// profile.layout alongside node positions and travels with the game.
//
// This module owns the group records + their DOM layer (#ggroups). It never reaches
// into main.js state directly — main hands it a small `ctx` of callbacks:
//   • nodeRect(id)   -> {x,y,w,h} world rect of a node (pos + element size), or null
//   • nodeType(id)   -> node type prefix ("window"/"dataset"/…) for the default title
//   • moveMembers(ids, ev) -> begin a multi-node drag (reuses main's move logic)
//   • persist()      -> schedule a layout save
//   • afterChange()  -> main re-renders detach icons / toolbar after membership edits
//
// Geometry recomputes from live member rects every render, so a group box always hugs
// its nodes — dragging a member (or the whole group) just re-renders.

const PAD = 16;          // gap between member bounding box and the group outline
const TITLE_H = 24;      // title bar height (world px)
const DRAG_THRESH = 4;   // px before a title press becomes a move (else it's a click)

let ctx = null;
let groups = [];         // [{ id, title, members[], outline{color,style,width}, bg, titlePos }]
let seq = 0;             // group_N counter (per load)
let openPopover = null;  // {groupId, el} of the currently open options popover

export function initGroups(c) { ctx = c; }

const byId = (id) => groups.find((g) => g.id === id);
export function groupOf(nodeId) { return groups.find((g) => g.members.includes(nodeId)) || null; }
export function allGroups() { return groups; }

// ---- persistence ----------------------------------------------------------

export function collect() {
  return groups.map((g) => ({
    id: g.id, title: g.title, members: [...g.members],
    outline: { ...g.outline }, bg: g.bg, titlePos: g.titlePos,
  }));
}
// Default group look — a MUTED grey, distinct from the accent blue used for the live
// multi-selection (an accent outline made every group look perpetually selected).
const DEF_OUTLINE = "#8a93a3";
const DEF_BG = "#8a93a31f";

export function hydrate(arr) {
  closePopover();
  groups = (arr || []).map((g) => ({
    id: g.id,
    title: g.title || g.id,
    members: Array.isArray(g.members) ? [...g.members] : [],
    outline: { color: g.outline?.color || DEF_OUTLINE, style: g.outline?.style || "solid", width: g.outline?.width || 2 },
    bg: g.bg || DEF_BG,
    titlePos: g.titlePos || "tl",
  })).filter((g) => g.members.length);
  // keep group_N counter past any already-used numbers
  seq = groups.reduce((m, g) => { const n = /^group_(\d+)$/.exec(g.id); return n ? Math.max(m, +n[1]) : m; }, 0);
}
export function clear() { closePopover(); groups = []; seq = 0; renderGroups(); }

// ---- membership edits -----------------------------------------------------

// Default title = the trait the members share: all one type -> that type pluralised,
// else "group_N".
function defaultTitle(memberIds) {
  const types = new Set(memberIds.map((id) => ctx.nodeType(id)).filter(Boolean));
  if (types.size === 1) { const t = [...types][0]; return t.endsWith("s") ? t : `${t}s`; }
  return null;
}

export function createGroup(memberIds) {
  const ids = [...new Set(memberIds)].filter((id) => ctx.nodeRect(id));
  if (ids.length < 1) return null;
  // a node belongs to at most one group — pull each member out of any prior group first
  for (const id of ids) { const g = groupOf(id); if (g) g.members = g.members.filter((m) => m !== id); }
  const gid = `group_${++seq}`;
  const g = {
    id: gid, title: defaultTitle(ids) || gid, members: ids,
    outline: { color: DEF_OUTLINE, style: "solid", width: 2 }, bg: DEF_BG, titlePos: "tl",
  };
  groups.push(g);
  pruneEmpty();
  renderGroups(); ctx.persist(); ctx.afterChange();
  return g;
}

export function disband(groupId) {
  groups = groups.filter((g) => g.id !== groupId);
  closePopover();
  renderGroups(); ctx.persist(); ctx.afterChange();
}

export function detachNode(nodeId) {
  const g = groupOf(nodeId);
  if (!g) return;
  g.members = g.members.filter((m) => m !== nodeId);
  pruneEmpty();
  renderGroups(); ctx.persist(); ctx.afterChange();
}

// After a node drag, attach any dragged node whose centre landed inside a group's box
// to that group (a node belongs to at most one group). Never auto-detaches — dropping
// a node OUTSIDE every box leaves its membership alone. Returns true if anything moved.
export function absorb(ids) {
  let changed = false;
  for (const id of ids) {
    const r = ctx.nodeRect(id);
    if (!r) continue;
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    const target = groups.find((g) => !g.members.includes(id) && boxContains(g, cx, cy));
    if (!target) continue;
    const prev = groupOf(id);
    if (prev) prev.members = prev.members.filter((m) => m !== id);
    target.members.push(id);
    changed = true;
  }
  if (changed) { pruneEmpty(); renderGroups(); ctx.persist(); ctx.afterChange(); }
  return changed;
}

function boxContains(g, x, y) {
  const box = groupBox(g);
  return !!box && x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h;
}

// Drop groups left empty (all members removed/deleted).
function pruneEmpty() { groups = groups.filter((g) => g.members.length); }

// Called by main when nodes are removed, so a deleted node never lingers in a group.
export function forgetNodes(idsGone) {
  let changed = false;
  for (const g of groups) { const n = g.members.length; g.members = g.members.filter((m) => !idsGone.has(m)); if (g.members.length !== n) changed = true; }
  if (changed) { pruneEmpty(); renderGroups(); ctx.persist(); }
}

// ---- geometry -------------------------------------------------------------

// World bounding box that hugs a group's member nodes, plus a uniform pad and room
// for the title bar above it. Returns null if no member has a live rect yet.
function groupBox(g) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const id of g.members) {
    const r = ctx.nodeRect(id);
    if (!r) continue;
    minX = Math.min(minX, r.x); minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w); maxY = Math.max(maxY, r.y + r.h);
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX - PAD, y: minY - PAD - TITLE_H, w: (maxX - minX) + PAD * 2, h: (maxY - minY) + PAD * 2 + TITLE_H };
}

// Place the title (a separate top-layer element) in WORLD coords from the box, per
// g.titlePos. tl is a full-width band across the group; the rest are pills.
function placeTitle(tel, box, pos) {
  tel.style.position = "absolute";
  tel.style.right = "auto";
  tel.classList.toggle("band", pos === "tl");
  if (pos === "tc") { tel.style.left = `${box.x + box.w / 2}px`; tel.style.top = `${box.y}px`; tel.style.width = ""; tel.style.transform = "translateX(-50%)"; }
  else if (pos === "tr") { tel.style.left = `${box.x + box.w}px`; tel.style.top = `${box.y}px`; tel.style.width = ""; tel.style.transform = "translateX(-100%)"; }
  else if (pos === "in") { tel.style.left = `${box.x + 8}px`; tel.style.top = `${box.y + TITLE_H + 8}px`; tel.style.width = ""; tel.style.transform = "none"; }
  else { tel.style.left = `${box.x}px`; tel.style.top = `${box.y}px`; tel.style.width = `${box.w}px`; tel.style.transform = "none"; }   // tl band
}

// ---- rendering ------------------------------------------------------------
// Boxes live in #ggroups (behind nodes); titles live in a top layer (#ggrouptitles,
// above nodes) so they stay hit-testable for drag + the options popover.

export function renderGroups() {
  const boxLayer = ctx.world();
  const titleLayer = ctx.titleLayer ? ctx.titleLayer() : boxLayer;
  if (!boxLayer || !titleLayer) return;
  const live = new Set(groups.map((g) => g.id));
  for (const el of [...boxLayer.children]) if (!live.has(el.dataset.gid)) el.remove();
  for (const el of [...titleLayer.children]) if (el.dataset.gid && !live.has(el.dataset.gid)) el.remove();
  for (const g of groups) {
    const box = groupBox(g);
    let bel = boxLayer.querySelector(`.ggroup[data-gid="${g.id}"]`);
    let tel = titleLayer.querySelector(`.ggroup-title[data-gid="${g.id}"]`);
    if (!box) { bel?.remove(); tel?.remove(); continue; }
    if (!bel) { bel = buildBoxEl(g); boxLayer.appendChild(bel); }
    if (!tel) { tel = buildTitleEl(g); titleLayer.appendChild(tel); }
    bel.style.left = `${box.x}px`; bel.style.top = `${box.y}px`;
    bel.style.width = `${box.w}px`; bel.style.height = `${box.h}px`;
    bel.style.background = g.bg;
    bel.style.borderColor = g.outline.color;
    bel.style.borderStyle = g.outline.style;
    bel.style.borderWidth = `${g.outline.width}px`;
    placeTitle(tel, box, g.titlePos);
    tel.querySelector(".ggt-label").textContent = g.title;
  }
}

function buildBoxEl(g) {
  const el = document.createElement("div");
  el.className = "ggroup";
  el.dataset.gid = g.id;
  return el;
}

function buildTitleEl(g) {
  const tel = document.createElement("div");
  tel.className = "ggroup-title";
  tel.dataset.gid = g.id;
  tel.innerHTML = `<span class="ggt-label"></span>`;
  // press the title: a real drag moves the whole group; a plain click opens options
  tel.addEventListener("mousedown", (ev) => onTitlePress(g.id, ev));
  return tel;
}

// ---- title press: drag group vs open options ------------------------------

function onTitlePress(gid, ev) {
  if (ev.button !== 0) return;
  ev.stopPropagation();   // don't start a marquee / deselect on the canvas
  const g = byId(gid);
  if (!g) return;
  const start = { x: ev.clientX, y: ev.clientY };
  let moved = false;
  const onMove = (e) => {
    if (moved) return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < DRAG_THRESH) return;
    moved = true;
    cleanup();
    ctx.moveMembers(g.members, ev);   // hand the drag to main's multi-move
  };
  const onUp = () => { cleanup(); if (!moved) togglePopover(gid, ev); };
  function cleanup() { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); }
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

// ---- options popover ------------------------------------------------------

function closePopover() { if (openPopover) { openPopover.el.remove(); openPopover = null; document.removeEventListener("mousedown", onOutside, true); } }

function onOutside(e) { if (openPopover && !e.target.closest(".ggroup-pop") && !e.target.closest(".ggroup-title")) closePopover(); }

function togglePopover(gid, ev) {
  if (openPopover?.groupId === gid) { closePopover(); return; }
  closePopover();
  const g = byId(gid);
  if (!g) return;
  const pop = document.createElement("div");
  pop.className = "ggroup-pop";
  pop.innerHTML = `
    <label class="flab">title <input class="gp-title" value="${escAttr(g.title)}" /></label>
    <label class="flab">outline
      <select class="gp-style">
        ${["solid", "dashed", "dotted"].map((s) => `<option value="${s}" ${g.outline.style === s ? "selected" : ""}>${s}</option>`).join("")}
      </select>
      <input type="color" class="gp-ocolor" value="${hex6(g.outline.color)}" title="outline color" />
    </label>
    <label class="flab">background <input type="color" class="gp-bg" value="${hex6(g.bg)}" title="fill color" />
      <input type="range" class="gp-bga" min="0" max="60" value="${alphaPct(g.bg)}" title="fill opacity" /></label>
    <label class="flab">title at
      <select class="gp-pos">
        ${[["tl", "top-left"], ["tc", "top-center"], ["tr", "top-right"], ["in", "inside"]].map(([v, t]) => `<option value="${v}" ${g.titlePos === v ? "selected" : ""}>${t}</option>`).join("")}
      </select>
    </label>
    <button class="gp-disband danger">disband group</button>`;
  // anchor near the click, in screen space (it's a fixed-position popover)
  pop.style.left = `${ev.clientX}px`; pop.style.top = `${ev.clientY + 8}px`;
  document.body.appendChild(pop);
  openPopover = { groupId: gid, el: pop };

  const commit = () => { renderGroups(); ctx.persist(); };
  pop.querySelector(".gp-title").addEventListener("input", (e) => { g.title = e.target.value; commit(); });
  pop.querySelector(".gp-style").addEventListener("change", (e) => { g.outline.style = e.target.value; commit(); });
  pop.querySelector(".gp-ocolor").addEventListener("input", (e) => { g.outline.color = e.target.value; commit(); });
  const applyBg = () => { g.bg = withAlpha(pop.querySelector(".gp-bg").value, +pop.querySelector(".gp-bga").value); commit(); };
  pop.querySelector(".gp-bg").addEventListener("input", applyBg);
  pop.querySelector(".gp-bga").addEventListener("input", applyBg);
  pop.querySelector(".gp-pos").addEventListener("change", (e) => { g.titlePos = e.target.value; commit(); });
  pop.querySelector(".gp-disband").addEventListener("click", () => disband(gid));

  setTimeout(() => document.addEventListener("mousedown", onOutside, true), 0);
}

// ---- color helpers (store as #rrggbb + 2-hex alpha so <input type=color> round-trips) ----

function escAttr(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function hex6(c) { const m = /^#([0-9a-f]{6})/i.exec(c || ""); return m ? `#${m[1]}` : "#5aa9e6"; }
function alphaPct(c) { const m = /^#[0-9a-f]{6}([0-9a-f]{2})$/i.exec(c || ""); return m ? Math.round((parseInt(m[1], 16) / 255) * 100) : 7; }
function withAlpha(hex, pct) { const a = Math.round((pct / 100) * 255).toString(16).padStart(2, "0"); return `${hex6(hex)}${a}`; }
