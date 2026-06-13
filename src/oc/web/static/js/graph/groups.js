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
export const SCHEMES = [
  { name: "slate", bg: "#191c21cc", style: "none", outline: "#2c313c", titleBg: "", titleColor: "" },
  { name: "blue", bg: "#5aa9e618", style: "solid", outline: "#5aa9e6", titleBg: "#5aa9e6", titleColor: "#08121d" },
  { name: "cyan", bg: "#5ad7e618", style: "solid", outline: "#5ad7e6", titleBg: "#5ad7e6", titleColor: "#08121d" },
  { name: "teal", bg: "#5ae6c218", style: "solid", outline: "#5ae6c2", titleBg: "#5ae6c2", titleColor: "#08121d" },
  { name: "green", bg: "#7ddc7d18", style: "solid", outline: "#7ddc7d", titleBg: "#7ddc7d", titleColor: "#08121d" },
  { name: "lime", bg: "#b6e65a18", style: "solid", outline: "#b6e65a", titleBg: "#b6e65a", titleColor: "#0e1408" },
  { name: "amber", bg: "#e6c25a18", style: "solid", outline: "#e6c25a", titleBg: "#e6c25a", titleColor: "#08121d" },
  { name: "orange", bg: "#e69a5a18", style: "solid", outline: "#e69a5a", titleBg: "#e69a5a", titleColor: "#1a0e08" },
  { name: "red", bg: "#e6685a18", style: "solid", outline: "#e6685a", titleBg: "#e6685a", titleColor: "#1a0a08" },
  { name: "pink", bg: "#e0556b18", style: "solid", outline: "#e0556b", titleBg: "#e0556b", titleColor: "#1a0a0e" },
  { name: "magenta", bg: "#e65ac218", style: "solid", outline: "#e65ac2", titleBg: "#e65ac2", titleColor: "#1a081a" },
  { name: "purple", bg: "#c98ae618", style: "solid", outline: "#c98ae6", titleBg: "#c98ae6", titleColor: "#08121d" },
  { name: "indigo", bg: "#8a9ae618", style: "solid", outline: "#8a9ae6", titleBg: "#8a9ae6", titleColor: "#08121d" },
];
// Default group look — a MUTED grey, distinct from the accent blue used for the live
// multi-selection (an accent outline made every group look perpetually selected).
const DEF_OUTLINE = "#333333";
const DEF_BG = "#191c21ff";

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
    placeTitle(tel, g.titleAlign);
  }
}

function buildBoxEl(g) {
  const el = document.createElement("div");
  el.className = "ggroup";
  el.dataset.gid = g.id;
  // double-click the group title → pan/zoom to frame it (the box itself is pointer-events:none
  // so canvas interactions pass through; the title is the group's handle and bubbles here)
  el.addEventListener("dblclick", (ev) => { ev.stopPropagation(); closePopover(); ctx.zoomToGroup?.(g.id); });
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
  const start = { x: ev.clientX, y: ev.clientY };
  let moved = false;
  const onMove = (e) => {
    if (moved) return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < DRAG_THRESH) return;
    moved = true;
    cleanup();
    ctx.moveMembers(g.members, ev);   // hand the drag to main's multi-move
  };
  const onUp = () => { cleanup(); };   // plain click does nothing — settings open via the cog only
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

// ---- color helpers (store as #rrggbb + 2-hex alpha so <input type=color> round-trips) ----

function escAttr(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function hex6(c) { const m = /^#([0-9a-f]{6})/i.exec(c || ""); return m ? `#${m[1]}` : "#5aa9e6"; }
function alphaPct(c) { const m = /^#[0-9a-f]{6}([0-9a-f]{2})$/i.exec(c || ""); return m ? Math.round((parseInt(m[1], 16) / 255) * 100) : 7; }
function withAlpha(hex, pct) { const a = Math.round((pct / 100) * 255).toString(16).padStart(2, "0"); return `${hex6(hex)}${a}`; }
