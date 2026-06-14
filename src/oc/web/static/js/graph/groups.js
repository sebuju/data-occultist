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

import { beginDrag } from "./dragresize.js";   // shared drag-loop primitive

const PAD = 20;          // uniform gap between members and the group outline (all 4 sides,
                         // incl. between the title band's bottom and the first node) — one GRID
                         // step, so the outline lands on the canvas grid like the nodes do
const TITLE_H = 24;      // fallback title height until the real one is measured (world px)
const DRAG_THRESH = 4;   // px before a title press becomes a move (else it's a click)

let ctx = null;
let groups = [];         // [{ id, title, members[], outline{color,style,width}, bg, titleAlign }]
let seq = 0;             // group_N counter (per load)
let openPopover = null;  // {groupId, el} of the currently open options popover

export function initGroups(c) { ctx = c; }

const byId = (id) => groups.find((g) => g.id === id);
export function groupOf(nodeId) { return groups.find((g) => g.members.includes(nodeId)) || null; }
export function allGroups() { return groups; }

// World-space box of every group (members hugged the same way the live layer does), for
// external renderers like the node map. Skips groups whose members aren't laid out yet.
export function groupBoxes() {
  return groups
    .map((g) => ({ id: g.id, title: g.title, outline: { ...g.outline }, bg: g.bg, box: groupBox(g) }))
    .filter((x) => x.box);
}

// World rects of each group's TITLE band, fed to the router as (soft) obstacles so node
// lines prefer not to run across a group title. Skips groups not yet laid out.
export function titleRects() {
  const out = [];
  for (const g of groups) {
    const th = g._titleH || TITLE_H;
    const box = groupBox(g, th);
    if (box) out.push({ x: box.x, y: box.y, w: box.w, h: th });
  }
  return out;
}

// ---- persistence ----------------------------------------------------------

export function collect() {
  return groups.map((g) => ({
    id: g.id, title: g.title, members: [...g.members],
    outline: { ...g.outline }, bg: g.bg, titleAlign: g.titleAlign,
    titleBg: g.titleBg, titleColor: g.titleColor,
  }));
}
// Premade colour schemes that fit the app theme. titleBg/titleColor "" = fall back to the
// CSS defaults (panel / text). Colored schemes pair a saturated band with dark on-accent text.
// `bg` is OPAQUE (no alpha): each is its old translucent tint pre-blended over the global
// canvas bg (#15171c), so overlapping groups never double-darken.
export const SCHEMES = [
  { name: "slate", bg: "#181b20", style: "none", outline: "#2c313c", titleBg: "", titleColor: "" },
  { name: "blue", bg: "#1b252f", style: "none", outline: "#5aa9e6", titleBg: "#5aa9e6", titleColor: "#08121d" },
  { name: "cyan", bg: "#1b292f", style: "none", outline: "#5ad7e6", titleBg: "#5ad7e6", titleColor: "#08121d" },
  { name: "teal", bg: "#1b2a2c", style: "none", outline: "#5ae6c2", titleBg: "#5ae6c2", titleColor: "#08121d" },
  { name: "green", bg: "#1f2a25", style: "none", outline: "#7ddc7d", titleBg: "#7ddc7d", titleColor: "#08121d" },
  { name: "lime", bg: "#242a22", style: "none", outline: "#b6e65a", titleBg: "#b6e65a", titleColor: "#0e1408" },
  { name: "amber", bg: "#292722", style: "none", outline: "#e6c25a", titleBg: "#e6c25a", titleColor: "#08121d" },
  { name: "orange", bg: "#292322", style: "none", outline: "#e69a5a", titleBg: "#e69a5a", titleColor: "#1a0e08" },
  { name: "red", bg: "#291f22", style: "none", outline: "#e6685a", titleBg: "#e6685a", titleColor: "#1a0a08" },
  { name: "pink", bg: "#281d23", style: "none", outline: "#e0556b", titleBg: "#e0556b", titleColor: "#1a0a0e" },
  { name: "magenta", bg: "#291d2c", style: "none", outline: "#e65ac2", titleBg: "#e65ac2", titleColor: "#1a081a" },
  { name: "purple", bg: "#26222f", style: "none", outline: "#c98ae6", titleBg: "#c98ae6", titleColor: "#08121d" },
  { name: "indigo", bg: "#20232f", style: "none", outline: "#8a9ae6", titleBg: "#8a9ae6", titleColor: "#08121d" },
];
// Default group look — a MUTED grey, distinct from the accent blue used for the live
// multi-selection (an accent outline made every group look perpetually selected).
const DEF_OUTLINE = "#333333";
const DEF_BG = "#191c21";   // opaque (was #191c21ff)

export function hydrate(arr) {
  closePopover();
  groups = (arr || []).map((g) => ({
    id: g.id,
    title: g.title || g.id,
    members: Array.isArray(g.members) ? [...g.members] : [],
    outline: { color: g.outline?.color || DEF_OUTLINE, style: g.outline?.style || "solid", width: g.outline?.width || 2 },
    bg: g.bg || DEF_BG,
    titleBg: g.titleBg || "",      // "" = CSS default (var(--panel))
    titleColor: g.titleColor || "",// "" = CSS default (var(--text))
    // title is always a full-width band now; titleAlign just sets its text alignment.
    // Back-compat: map the old titlePos positions onto an alignment.
    titleAlign: g.titleAlign || ({ tl: "left", tc: "center", tr: "right", in: "left" }[g.titlePos]) || "left",
  })).filter((g) => g.members.length);
  // keep group_N counter past any already-used numbers
  seq = groups.reduce((m, g) => { const n = /^group_(\d+)$/.exec(g.id); return n ? Math.max(m, +n[1]) : m; }, 0);
}
export function clear() {
  closePopover(); closeSuperPopover();
  groups = []; seq = 0; superGroups = []; sseq = 0; selectedGroups.clear();
  renderGroups();   // renders the (now empty) super layer too
}

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
    outline: { color: DEF_OUTLINE, style: "none", width: 2 }, bg: DEF_BG, titleAlign: "left",
    titleBg: "", titleColor: "",
  };
  groups.push(g);
  pruneEmpty();
  renderGroups(); ctx.persist(); ctx.afterChange();
  return g;
}

export function disband(groupId) {
  groups = groups.filter((g) => g.id !== groupId);
  forgetGroups(new Set([groupId]));   // drop it from any super group too
  closePopover();
  renderGroups(); ctx.persist(); ctx.afterChange();
}

export function detachNode(nodeId) { detachNodes([nodeId]); }

// Pull every given node out of whatever group holds it. Backs the per-node detach
// icon (one id) and the group hotkey's "ungroup everything" (the whole selection).
export function detachNodes(nodeIds) {
  let changed = false;
  for (const id of nodeIds) {
    const g = groupOf(id);
    if (g) { g.members = g.members.filter((m) => m !== id); changed = true; }
  }
  if (changed) { pruneEmpty(); renderGroups(); ctx.persist(); ctx.afterChange(); }
}

// Add nodes to an existing group, pulling each out of any prior group first (a node
// belongs to at most one group).
export function addToGroup(groupId, nodeIds) {
  const g = byId(groupId);
  if (!g) return;
  const add = [...new Set(nodeIds)].filter((id) => ctx.nodeRect(id) && !g.members.includes(id));
  if (!add.length) return;
  for (const id of add) { const p = groupOf(id); if (p) p.members = p.members.filter((m) => m !== id); }
  g.members.push(...add);
  pruneEmpty(); renderGroups(); ctx.persist(); ctx.afterChange();
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

// Drop groups left empty (all members removed/deleted), forgetting them from super groups.
function pruneEmpty() {
  const gone = groups.filter((g) => !g.members.length).map((g) => g.id);
  groups = groups.filter((g) => g.members.length);
  if (gone.length) forgetGroups(new Set(gone));
}

// Called by main when nodes are removed, so a deleted node never lingers in a group.
export function forgetNodes(idsGone) {
  let changed = false;
  for (const g of groups) { const n = g.members.length; g.members = g.members.filter((m) => !idsGone.has(m)); if (g.members.length !== n) changed = true; }
  if (changed) { pruneEmpty(); renderGroups(); ctx.persist(); }
}

// ---- geometry -------------------------------------------------------------

// World bounding box that hugs a group's member nodes, plus a uniform pad and room
// for the title bar above it. Returns null if no member has a live rect yet.
function groupBox(g, titleH = g._titleH || TITLE_H) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const id of g.members) {
    const r = ctx.nodeRect(id);
    if (!r) continue;
    minX = Math.min(minX, r.x); minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w); maxY = Math.max(maxY, r.y + r.h);
  }
  if (!Number.isFinite(minX)) return null;
  // top reserves the real title height PLUS one PAD, so the band's bottom sits exactly PAD
  // above the first node — the same PAD used on the other three sides.
  return { x: minX - PAD, y: minY - PAD - titleH, w: (maxX - minX) + PAD * 2, h: (maxY - minY) + PAD * 2 + titleH };
}

// The title is a child of the box (CSS pins it to the top + the box clips it), so all that's
// left here is its TEXT alignment: left/center/right per g.titleAlign.
function placeTitle(tel, align) {
  tel.style.justifyContent = align === "center" ? "center" : align === "right" ? "flex-end" : "flex-start";
}

// ---- rendering ------------------------------------------------------------
// Boxes live in #ggroups (behind nodes); each box owns its title band as a CHILD, so the box
// clips the band flush and it stays hit-testable for drag + the options popover.

export function renderGroups() {
  const boxLayer = ctx.world();
  if (!boxLayer) return;
  const live = new Set(groups.map((g) => g.id));
  for (const el of [...boxLayer.children]) if (!live.has(el.dataset.gid)) el.remove();   // box removal takes its title child with it
  for (const g of groups) {
    let bel = boxLayer.querySelector(`.ggroup[data-gid="${g.id}"]`);
    if (!bel) { bel = buildBoxEl(g); boxLayer.appendChild(bel); }
    let tel = bel.querySelector(".ggroup-title");
    if (!tel) { tel = buildTitleEl(g); bel.appendChild(tel); }   // title lives INSIDE the box so the box clips it flush
    // Label + measure the title BEFORE sizing the box, so the box reserves the band's REAL
    // height (offsetHeight is single-line — white-space:nowrap — so it's stable before layout).
    tel.querySelector(".ggt-label").textContent = g.title;
    const th = g._titleH = tel.offsetHeight || TITLE_H;
    const box = groupBox(g, th);
    if (!box) { bel.remove(); continue; }
    bel.style.left = `${box.x}px`; bel.style.top = `${box.y}px`;
    bel.style.width = `${box.w}px`; bel.style.height = `${box.h}px`;
    const bw = g.outline.style === "none" ? 0 : 1;
    bel.style.background = g.bg;
    bel.style.borderColor = g.outline.color;
    bel.style.borderStyle = g.outline.style;
    bel.style.borderWidth = `${bw}px`;
    tel.style.background = g.titleBg || "";    // "" -> CSS default (var(--panel))
    tel.style.color = g.titleColor || "";      // "" -> CSS default (var(--text))
    bel.classList.toggle("gsel", selectedGroups.has(g.id));   // ctrl-click selection highlight
    placeTitle(tel, g.titleAlign);
  }
  renderSuperGroups();   // super-group boxes hug these group boxes — keep them in lockstep
}

function buildBoxEl(g) {
  const el = document.createElement("div");
  el.className = "ggroup";
  el.dataset.gid = g.id;
  // (double-click to frame a group is hit-tested at the canvas level — main.js — so it works
  // on the pointer-events:none background too, not only the title)
  // bottom-right grip: drag to resize the group — scales its members, keeping gaps intact
  const grip = document.createElement("div");
  grip.className = "ggroup-grip";
  grip.title = "resize group";
  grip.addEventListener("mousedown", (ev) => { if (ev.button === 0) ctx.startGroupResize?.(g.id, ev); });
  el.appendChild(grip);
  return el;
}

function buildTitleEl(g) {
  const tel = document.createElement("div");
  tel.className = "ggroup-title";
  tel.dataset.gid = g.id;
  tel.innerHTML = `<span class="ggt-label"></span>
    <button class="ggt-cog" title="group settings" aria-label="group settings">
      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M9.405 1.05c-.413-1.4-2.397-1.4-2.81 0l-.1.34a1.464 1.464 0 0 1-2.105.872l-.31-.17c-1.283-.698-2.686.705-1.987 1.987l.169.311c.446.82.023 1.841-.872 2.105l-.34.1c-1.4.413-1.4 2.397 0 2.81l.34.1a1.464 1.464 0 0 1 .872 2.105l-.17.31c-.698 1.283.705 2.686 1.987 1.987l.311-.169a1.464 1.464 0 0 1 2.105.872l.1.34c.413 1.4 2.397 1.4 2.81 0l.1-.34a1.464 1.464 0 0 1 2.105-.872l.31.17c1.283.698 2.686-.705 1.987-1.987l-.169-.311a1.464 1.464 0 0 1 .872-2.105l.34-.1c1.4-.413 1.4-2.397 0-2.81l-.34-.1a1.464 1.464 0 0 1-.872-2.105l.17-.31c.698-1.283-.705-2.686-1.987-1.987l-.311.169a1.464 1.464 0 0 1-2.105-.872l-.1-.34zM8 10.93a2.929 2.929 0 1 1 0-5.86 2.929 2.929 0 0 1 0 5.858z"/></svg>
    </button>`;
  // press the title: a real drag moves the whole group (click alone does nothing now —
  // settings live behind the cog so a stray click can't pop the options panel)
  tel.addEventListener("mousedown", (ev) => onTitlePress(g.id, ev));
  const cog = tel.querySelector(".ggt-cog");
  cog.addEventListener("mousedown", (ev) => ev.stopPropagation());           // don't start a group drag
  cog.addEventListener("click", (ev) => { ev.stopPropagation(); togglePopover(g.id, ev); });
  return tel;
}

// ---- title press: drag group vs open options ------------------------------

function onTitlePress(gid, ev) {
  if (ev.button !== 0) return;
  ev.stopPropagation();   // don't start a marquee / deselect on the canvas
  const g = byId(gid);
  if (!g) return;
  // ctrl/cmd-click a group title selects it (for super-grouping) instead of dragging
  if (ev.ctrlKey || ev.metaKey) { ev.preventDefault(); toggleGroupSelected(gid); return; }
  // shared drag loop with a threshold gate; once crossed, hand the drag to main's
  // multi-move (which runs its own beginDrag loop). A plain click does nothing — group
  // settings open via the cog only.
  const stop = beginDrag(ev, {
    threshold: DRAG_THRESH,
    onStart: () => { stop(); ctx.moveMembers(g.members, ev); },
  });
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
    <label class="flab"><span class="gp-lab">title</span><input class="gp-title" value="${escAttr(g.title)}" /></label>
    <div class="flab"><span class="gp-lab">scheme</span>
      <div class="gp-schemes">${SCHEMES.map((s, i) => `<button class="gp-scheme" data-i="${i}" title="${s.name}" style="background:${s.titleBg || s.bg};border-color:${s.outline === "#2c313c" ? "#4a515f" : s.outline}"></button>`).join("")}</div>
    </div>
    <label class="flab"><span class="gp-lab">outline</span>
      <select class="gp-style">
        ${["solid", "dashed", "dotted", "none"].map((s) => `<option value="${s}" ${g.outline.style === s ? "selected" : ""}>${s}</option>`).join("")}
      </select>
      <input type="color" class="gp-ocolor" value="${hex6(g.outline.color)}" title="outline color" />
    </label>
    <label class="flab"><span class="gp-lab">background</span>
      <input type="range" class="gp-bga" min="0" max="100" value="${alphaPct(g.bg)}" title="fill opacity" />
      <input type="color" class="gp-bg" value="${hex6(g.bg)}" title="fill color" /></label>
    <label class="flab"><span class="gp-lab">title bg</span>
      <input type="color" class="gp-tbg" value="${hex6(g.titleBg || "#1d2027")}" title="title background" /></label>
    <label class="flab"><span class="gp-lab">title text</span>
      <input type="color" class="gp-tcolor" value="${hex6(g.titleColor || "#d7dbe2")}" title="title text color" /></label>
    <label class="flab"><span class="gp-lab">align</span>
      <select class="gp-pos">
        ${["left", "center", "right"].map((v) => `<option value="${v}" ${g.titleAlign === v ? "selected" : ""}>${v}</option>`).join("")}
      </select>
    </label>
    <button class="gp-disband danger">disband group</button>`;
  // anchor near the click (screen space — it's fixed-position), then clamp fully on-screen so
  // no part spills out of bounds (measured after it's in the DOM).
  pop.style.left = `${ev.clientX}px`; pop.style.top = `${ev.clientY + 8}px`;
  document.body.appendChild(pop);
  const M = 8, r = pop.getBoundingClientRect();
  pop.style.left = `${Math.max(M, Math.min(ev.clientX, window.innerWidth - r.width - M))}px`;
  pop.style.top = `${Math.max(M, Math.min(ev.clientY + 8, window.innerHeight - r.height - M))}px`;
  openPopover = { groupId: gid, el: pop };

  const commit = () => { renderGroups(); ctx.persist(); };
  pop.querySelector(".gp-title").addEventListener("input", (e) => { g.title = e.target.value; commit(); });
  pop.querySelector(".gp-style").addEventListener("change", (e) => { g.outline.style = e.target.value; commit(); });
  pop.querySelector(".gp-ocolor").addEventListener("input", (e) => { g.outline.color = e.target.value; commit(); });
  const applyBg = () => { g.bg = withAlpha(pop.querySelector(".gp-bg").value, +pop.querySelector(".gp-bga").value); commit(); };
  pop.querySelector(".gp-bg").addEventListener("input", applyBg);
  pop.querySelector(".gp-bga").addEventListener("input", applyBg);
  pop.querySelector(".gp-tbg").addEventListener("input", (e) => { g.titleBg = e.target.value; commit(); });
  pop.querySelector(".gp-tcolor").addEventListener("input", (e) => { g.titleColor = e.target.value; commit(); });
  pop.querySelector(".gp-pos").addEventListener("change", (e) => { g.titleAlign = e.target.value; commit(); });
  // a premade scheme sets fill + outline + title colours at once, and syncs the pickers
  pop.querySelectorAll(".gp-scheme").forEach((b) => b.addEventListener("click", () => {
    const s = SCHEMES[+b.dataset.i];
    g.bg = s.bg; g.outline.color = s.outline; g.outline.style = s.style; g.titleBg = s.titleBg; g.titleColor = s.titleColor;
    pop.querySelector(".gp-bg").value = hex6(s.bg); pop.querySelector(".gp-bga").value = alphaPct(s.bg);
    pop.querySelector(".gp-ocolor").value = hex6(s.outline); pop.querySelector(".gp-style").value = s.style;
    pop.querySelector(".gp-tbg").value = hex6(s.titleBg || "#1d2027"); pop.querySelector(".gp-tcolor").value = hex6(s.titleColor || "#d7dbe2");
    commit();
  }));
  pop.querySelector(".gp-disband").addEventListener("click", () => disband(gid));

  setTimeout(() => document.addEventListener("mousedown", onOutside, true), 0);
}

// ---- super groups: a group OF groups -------------------------------------
// A super group owns group ids (not nodes). Its box hugs its member groups' boxes (which
// in turn hug their nodes), so it re-fits whenever anything inside moves. Pure layout, like
// groups — it travels in profile.layout.super_groups. Rendered in its own #sgroups layer
// BEHIND the group layer: an extremely faint rectangle with a huge label pinned bottom-left.

const SUPER_PAD = 44;          // gap between member groups and the super outline (3 sides)
const SUPER_LABEL_BAND = 112;  // taller bottom pad so the huge bottom-left label always clears the groups
const SUPER_DEF_OUTLINE = "#3a4154";
const SUPER_DEF_BG = "#1b1d23";   // barely-there fill, opaque (was #aab4d8 @ 4% over #15171c)
const COG_SVG = `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M9.405 1.05c-.413-1.4-2.397-1.4-2.81 0l-.1.34a1.464 1.464 0 0 1-2.105.872l-.31-.17c-1.283-.698-2.686.705-1.987 1.987l.169.311c.446.82.023 1.841-.872 2.105l-.34.1c-1.4.413-1.4 2.397 0 2.81l.34.1a1.464 1.464 0 0 1 .872 2.105l-.17.31c-.698 1.283.705 2.686 1.987 1.987l.311-.169a1.464 1.464 0 0 1 2.105.872l.1.34c.413 1.4 2.397 1.4 2.81 0l.1-.34a1.464 1.464 0 0 1 2.105-.872l.31.17c1.283.698 2.686-.705 1.987-1.987l-.169-.311a1.464 1.464 0 0 1 .872-2.105l.34-.1c1.4-.413 1.4-2.397 0-2.81l-.34-.1a1.464 1.464 0 0 1-.872-2.105l.17-.31c.698-1.283-.705-2.686-1.987-1.987l-.311.169a1.464 1.464 0 0 1-2.105-.872l-.1-.34zM8 10.93a2.929 2.929 0 1 1 0-5.86 2.929 2.929 0 0 1 0 5.858z"/></svg>`;

let superGroups = [];          // [{ id, title, groups[], outline{color,style,width}, bg, titleColor }]
let sseq = 0;
let selectedGroups = new Set();   // groups ctrl-clicked for super-grouping
let openSuperPopover = null;

const sById = (id) => superGroups.find((s) => s.id === id);
export function allSuperGroups() { return superGroups; }
export function superGroupOf(groupId) { return superGroups.find((s) => s.groups.includes(groupId)) || null; }

// ---- group selection (ctrl-click) for super-grouping ----------------------
export function toggleGroupSelected(gid) {
  if (selectedGroups.has(gid)) selectedGroups.delete(gid); else selectedGroups.add(gid);
  renderGroups(); ctx.afterChange?.();   // refresh the selection toolbar
}
export function selectedGroupIds() { return [...selectedGroups].filter((id) => byId(id)); }
export function clearGroupSelection() { if (selectedGroups.size) { selectedGroups.clear(); renderGroups(); ctx.afterChange?.(); } }

// ---- membership edits -----------------------------------------------------
export function createSuperGroup(groupIds) {
  const ids = [...new Set(groupIds)].filter((id) => byId(id));
  if (ids.length < 1) return null;
  for (const id of ids) { const s = superGroupOf(id); if (s) s.groups = s.groups.filter((g) => g !== id); }
  const sid = `sgroup_${++sseq}`;
  const sg = { id: sid, title: sid, groups: ids,
    outline: { color: SUPER_DEF_OUTLINE, style: "none", width: 2 }, bg: SUPER_DEF_BG, titleColor: "" };
  superGroups.push(sg);
  pruneEmptySuper(); renderSuperGroups(); ctx.persist(); ctx.afterChange?.();
  return sg;
}
export function disbandSuper(sid) {
  superGroups = superGroups.filter((s) => s.id !== sid);
  closeSuperPopover(); renderSuperGroups(); ctx.persist(); ctx.afterChange?.();
}
export function addToSuper(sid, groupIds) {
  const sg = sById(sid);
  if (!sg) return;
  const add = [...new Set(groupIds)].filter((id) => byId(id) && !sg.groups.includes(id));
  if (!add.length) return;
  for (const id of add) { const p = superGroupOf(id); if (p) p.groups = p.groups.filter((g) => g !== id); }
  sg.groups.push(...add);
  pruneEmptySuper(); renderSuperGroups(); ctx.persist(); ctx.afterChange?.();
}
export function detachGroups(groupIds) {
  let changed = false;
  for (const id of groupIds) { const s = superGroupOf(id); if (s) { s.groups = s.groups.filter((g) => g !== id); changed = true; } }
  if (changed) { pruneEmptySuper(); renderSuperGroups(); ctx.persist(); ctx.afterChange?.(); }
}
// drop disbanded/removed groups out of every super group (called from pruneEmpty/disband)
function forgetGroups(idsGone) {
  let changed = false;
  for (const s of superGroups) { const n = s.groups.length; s.groups = s.groups.filter((g) => !idsGone.has(g)); if (s.groups.length !== n) changed = true; }
  if (changed) { pruneEmptySuper(); renderSuperGroups(); ctx.persist?.(); }
}
function pruneEmptySuper() { superGroups = superGroups.filter((s) => s.groups.length); }

// ---- persistence ----------------------------------------------------------
export function collectSuper() {
  return superGroups.map((sg) => ({ id: sg.id, title: sg.title, groups: [...sg.groups],
    outline: { ...sg.outline }, bg: sg.bg, titleColor: sg.titleColor }));
}
export function hydrateSuper(arr) {
  closeSuperPopover();
  superGroups = (arr || []).map((sg) => ({
    id: sg.id, title: sg.title || sg.id, groups: Array.isArray(sg.groups) ? [...sg.groups] : [],
    outline: { color: sg.outline?.color || SUPER_DEF_OUTLINE, style: sg.outline?.style || "none", width: sg.outline?.width || 2 },
    bg: sg.bg || SUPER_DEF_BG, titleColor: sg.titleColor || "",
  })).filter((sg) => sg.groups.length);
  sseq = superGroups.reduce((m, sg) => { const n = /^sgroup_(\d+)$/.exec(sg.id); return n ? Math.max(m, +n[1]) : m; }, 0);
  selectedGroups.clear();
}

// ---- geometry -------------------------------------------------------------
function superBox(sg) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const gid of sg.groups) {
    const g = byId(gid); if (!g) continue;
    const b = groupBox(g); if (!b) continue;
    minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h);
  }
  if (!Number.isFinite(minX)) return null;
  // top/left/right = SUPER_PAD; bottom = SUPER_LABEL_BAND so the watermark label sits BELOW
  // the member groups (always visible) instead of overlapping them.
  return { x: minX - SUPER_PAD, y: minY - SUPER_PAD, w: (maxX - minX) + SUPER_PAD * 2, h: (maxY - minY) + SUPER_PAD + SUPER_LABEL_BAND };
}
function superMemberNodeIds(sg) {
  const ids = [];
  for (const gid of sg.groups) { const g = byId(gid); if (g) ids.push(...g.members); }
  return ids;
}
// world boxes for external renderers (node map, canvas dblclick hit-test)
export function superGroupBoxes() {
  return superGroups.map((sg) => ({ id: sg.id, title: sg.title, outline: { ...sg.outline }, bg: sg.bg, box: superBox(sg) }))
    .filter((x) => x.box);
}

// ---- rendering ------------------------------------------------------------
export function renderSuperGroups() {
  const layer = ctx.superWorld && ctx.superWorld();
  if (!layer) return;
  const live = new Set(superGroups.map((s) => s.id));
  for (const el of [...layer.children]) if (!live.has(el.dataset.sgid)) el.remove();
  for (const sg of superGroups) {
    let el = layer.querySelector(`.sgroup[data-sgid="${sg.id}"]`);
    if (!el) { el = buildSuperEl(sg); layer.appendChild(el); }
    const box = superBox(sg);
    if (!box) { el.remove(); continue; }
    el.style.left = `${box.x}px`; el.style.top = `${box.y}px`;
    el.style.width = `${box.w}px`; el.style.height = `${box.h}px`;
    el.style.background = sg.bg;
    el.style.borderColor = sg.outline.color;
    el.style.borderStyle = sg.outline.style;
    el.style.borderWidth = `${sg.outline.style === "none" ? 0 : 2}px`;
    const lab = el.querySelector(".sgroup-label");
    lab.textContent = sg.title;
    lab.style.color = sg.titleColor || "";
  }
}

function buildSuperEl(sg) {
  const el = document.createElement("div");
  el.className = "sgroup";
  el.dataset.sgid = sg.id;
  // cog + huge label, both pinned bottom-left (each ABSOLUTE so the giant label never shifts
  // the cog). The box is pointer-events:none so the canvas shows through; only the cog + label
  // are interactive (drag the super group, open settings).
  el.innerHTML = `<button class="sgroup-cog" title="super group settings" aria-label="super group settings">${COG_SVG}</button>
      <span class="sgroup-label"></span>`;
  const label = el.querySelector(".sgroup-label");
  const cog = el.querySelector(".sgroup-cog");
  label.addEventListener("mousedown", (ev) => onSuperPress(sg.id, ev));
  // the cog drags too (press + move) but a plain click opens settings
  cog.addEventListener("mousedown", (ev) => {
    if (ev.button !== 0) return;
    ev.stopPropagation();
    const stop = beginDrag(ev, { threshold: DRAG_THRESH, onStart: () => { stop(); startSuperDrag(sg.id, ev); } });
  });
  cog.addEventListener("click", (ev) => { ev.stopPropagation(); toggleSuperPopover(sg.id, ev); });
  return el;
}

function onSuperPress(sid, ev) {
  if (ev.button !== 0) return;
  ev.stopPropagation();
  const stop = beginDrag(ev, { threshold: DRAG_THRESH, onStart: () => { stop(); startSuperDrag(sid, ev); } });
}
// dragging a super group moves every node in every member group as one
function startSuperDrag(sid, ev) {
  const sg = sById(sid); if (!sg) return;
  const ids = superMemberNodeIds(sg);
  if (ids.length) ctx.moveMembers(ids, ev);
}

// ---- super-group options popover ------------------------------------------
function closeSuperPopover() { if (openSuperPopover) { openSuperPopover.el.remove(); openSuperPopover = null; document.removeEventListener("mousedown", onSuperOutside, true); } }
function onSuperOutside(e) { if (openSuperPopover && !e.target.closest(".ggroup-pop") && !e.target.closest(".sgroup-cog")) closeSuperPopover(); }
function toggleSuperPopover(sid, ev) {
  if (openSuperPopover?.sid === sid) { closeSuperPopover(); return; }
  closeSuperPopover();
  const sg = sById(sid);
  if (!sg) return;
  const pop = document.createElement("div");
  pop.className = "ggroup-pop";
  pop.innerHTML = `
    <label class="flab"><span class="gp-lab">title</span><input class="gp-title" value="${escAttr(sg.title)}" /></label>
    <div class="flab"><span class="gp-lab">scheme</span>
      <div class="gp-schemes">${SCHEMES.map((s, i) => `<button class="gp-scheme" data-i="${i}" title="${s.name}" style="background:${s.titleBg || s.bg};border-color:${s.outline === "#2c313c" ? "#4a515f" : s.outline}"></button>`).join("")}</div></div>
    <label class="flab"><span class="gp-lab">outline</span>
      <select class="gp-style">${["solid", "dashed", "dotted", "none"].map((s) => `<option value="${s}" ${sg.outline.style === s ? "selected" : ""}>${s}</option>`).join("")}</select>
      <input type="color" class="gp-ocolor" value="${hex6(sg.outline.color)}" title="outline color" /></label>
    <label class="flab"><span class="gp-lab">background</span>
      <input type="range" class="gp-bga" min="0" max="100" value="${alphaPct(sg.bg)}" title="fill opacity" />
      <input type="color" class="gp-bg" value="${hex6(sg.bg)}" title="fill color" /></label>
    <label class="flab"><span class="gp-lab">label</span>
      <input type="color" class="gp-tcolor" value="${hex6(sg.titleColor || "#aab4d8")}" title="label color" /></label>
    <button class="gp-disband danger">disband super group</button>`;
  pop.style.left = `${ev.clientX}px`; pop.style.top = `${ev.clientY + 8}px`;
  document.body.appendChild(pop);
  const M = 8, r = pop.getBoundingClientRect();
  pop.style.left = `${Math.max(M, Math.min(ev.clientX, window.innerWidth - r.width - M))}px`;
  pop.style.top = `${Math.max(M, Math.min(ev.clientY + 8, window.innerHeight - r.height - M))}px`;
  openSuperPopover = { sid, el: pop };

  const commit = () => { renderSuperGroups(); ctx.persist(); };
  pop.querySelector(".gp-title").addEventListener("input", (e) => { sg.title = e.target.value; commit(); });
  pop.querySelector(".gp-style").addEventListener("change", (e) => { sg.outline.style = e.target.value; commit(); });
  pop.querySelector(".gp-ocolor").addEventListener("input", (e) => { sg.outline.color = e.target.value; commit(); });
  const applyBg = () => { sg.bg = withAlpha(pop.querySelector(".gp-bg").value, +pop.querySelector(".gp-bga").value); commit(); };
  pop.querySelector(".gp-bg").addEventListener("input", applyBg);
  pop.querySelector(".gp-bga").addEventListener("input", applyBg);
  pop.querySelector(".gp-tcolor").addEventListener("input", (e) => { sg.titleColor = e.target.value; commit(); });
  // a scheme sets the outline + label colour and a faint tinted fill at once
  pop.querySelectorAll(".gp-scheme").forEach((b) => b.addEventListener("click", () => {
    const s = SCHEMES[+b.dataset.i];
    sg.outline.color = s.outline; sg.outline.style = s.style; sg.titleColor = s.titleBg || "";
    sg.bg = blendOnBg(s.outline === "#2c313c" ? "#aab4d8" : s.outline, 4);   // barely-there fill, OPAQUE
    pop.querySelector(".gp-bg").value = hex6(sg.bg); pop.querySelector(".gp-bga").value = alphaPct(sg.bg);
    pop.querySelector(".gp-ocolor").value = hex6(s.outline); pop.querySelector(".gp-style").value = s.style;
    pop.querySelector(".gp-tcolor").value = hex6(sg.titleColor || "#aab4d8");
    commit();
  }));
  pop.querySelector(".gp-disband").addEventListener("click", () => disbandSuper(sid));
  setTimeout(() => document.addEventListener("mousedown", onSuperOutside, true), 0);
}

// ---- color helpers (store as #rrggbb + 2-hex alpha so <input type=color> round-trips) ----

function escAttr(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function hex6(c) { const m = /^#([0-9a-f]{6})/i.exec(c || ""); return m ? `#${m[1]}` : "#5aa9e6"; }
// opacity % for the slider: an 8-digit colour carries it in its alpha byte; a 6-digit
// (opaque) colour — every scheme/default is opaque now — is full opacity (100).
function alphaPct(c) { const m = /^#[0-9a-f]{6}([0-9a-f]{2})$/i.exec(c || ""); return m ? Math.round((parseInt(m[1], 16) / 255) * 100) : 100; }
function withAlpha(hex, pct) { const a = Math.round((pct / 100) * 255).toString(16).padStart(2, "0"); return `${hex6(hex)}${a}`; }
// Blend `hex` at `pct` opacity over the global canvas bg (#15171c) into an OPAQUE #rrggbb —
// the same look as an alpha fill, but without alpha (so overlapping fills don't compound).
const GLOBAL_BG = [0x15, 0x17, 0x1c];
function blendOnBg(hex, pct) {
  // quantize alpha to a byte first (round(pct/100*255)/255), so the result is identical to
  // what the old `withAlpha` 8-digit fill rendered over the bg
  const h = hex6(hex), a = Math.round((pct / 100) * 255) / 255;
  const ch = (i) => Math.round(parseInt(h.slice(1 + i * 2, 3 + i * 2), 16) * a + GLOBAL_BG[i] * (1 - a));
  return `#${[0, 1, 2].map((i) => ch(i).toString(16).padStart(2, "0")).join("")}`;
}
