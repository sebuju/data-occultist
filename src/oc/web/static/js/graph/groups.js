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
import { h, svg } from "../dom.js";

const PAD = 40;          // uniform gap between members and the group outline (all 4 sides,
                                                  // incl. between the title band's bottom and the first node) — two GRID
                                                  // steps, so the outline lands on the canvas grid like the nodes do AND
                                                  // routed connectors have room to run inside the group edge without crowding
const TITLE_H = 24;      // fallback title height until the real one is measured (world px)
const DRAG_THRESH = 4;   // px before a title press becomes a move (else it's a click)

// The ONE cogwheel glyph (group / super-group / sub-group settings buttons all use it). A node
// can live in only one place, so this is a FACTORY returning a fresh svg each call; `size` is the
// square px the path renders at (groups 13, super/sub 15).
const COG = (size) =>
    svg("svg", { viewBox: "0 0 16 16", width: size, height: size, "aria-hidden": "true" },
        svg("path", { fill: "currentColor", d: "M9.405 1.05c-.413-1.4-2.397-1.4-2.81 0l-.1.34a1.464 1.464 0 0 1-2.105.872l-.31-.17c-1.283-.698-2.686.705-1.987 1.987l.169.311c.446.82.023 1.841-.872 2.105l-.34.1c-1.4.413-1.4 2.397 0 2.81l.34.1a1.464 1.464 0 0 1 .872 2.105l-.17.31c-.698 1.283.705 2.686 1.987 1.987l.311-.169a1.464 1.464 0 0 1 2.105.872l.1.34c.413 1.4 2.397 1.4 2.81 0l.1-.34a1.464 1.464 0 0 1 2.105-.872l.31.17c1.283.698 2.686-.705 1.987-1.987l-.169-.311a1.464 1.464 0 0 1 .872-2.105l.34-.1c1.4-.413 1.4-2.397 0-2.81l-.34-.1a1.464 1.464 0 0 1-.872-2.105l.17-.31c.698-1.283-.705-2.686-1.987-1.987l-.311.169a1.464 1.464 0 0 1-2.105-.872l-.1-.34zM8 10.93a2.929 2.929 0 1 1 0-5.86 2.929 2.929 0 0 1 0 5.858z" }));

let ctx = null;
let groups = [];         // [{ id, title, members[], outline{color,style,width}, bg, titleAlign }]
let seq = 0;             // group_N counter (per load)
let openPopover = null;  // {groupId, el} of the currently open options popover

export function initGroups(c) { ctx = c; }

const byId = (id) => groups.find((g) => g.id === id);
export function groupOf(nodeId) { return groups.find((g) => g.members.includes(nodeId)) || null; }
export function allGroups() { return groups; }

// Id of the (innermost, by area) group whose box contains world point (x,y), or null. Used by
// the add-node context menu so a node created over a group joins it.
export function groupAt(x, y) {
    let best = null, bestArea = Infinity;
    for (const g of groups) {
        const box = groupBox(g);
        if (!box || x < box.x || x > box.x + box.w || y < box.y || y > box.y + box.h) continue;
        const area = box.w * box.h;
        if (area < bestArea) { bestArea = area; best = g.id; }
    }
    return best;
}

// World-space box of every group (members hugged the same way the live layer does), for
// external renderers like the node map. Skips groups whose members aren't laid out yet.
export function groupBoxes() {
    return groups
        .map((g) => ({ id: g.id, title: g.title, outline: { ...g.outline }, bg: g.bg, titleAlign: g.titleAlign, bandH: g._titleH || TITLE_H, box: groupBox(g) }))
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
    reconcileFollowers();   // a saved layout may predate preview-follows-window — fix membership on load
}
export function clear() {
    closePopover(); closeSuperPopover();
    groups = []; seq = 0; superGroups = []; sseq = 0; selectedGroups.clear();
    subGroups = []; subseq = 0;
    renderGroups();   // renders the (now empty) super + sub layers too
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
    reconcileFollowers();   // pull each member window's preview into the new group
    pruneEmpty();
    renderGroups(); ctx.persist(); ctx.afterChange();
    return g;
}

export function disband(groupId) {
    groups = groups.filter((g) => g.id !== groupId);
    forgetGroups(new Set([groupId]));   // drop it from any super group too
    subGroups = subGroups.filter((sg) => sg.parent !== groupId);   // its subgroups go with it
    closePopover();
    renderGroups(); ctx.persist(); ctx.afterChange();
}

export function detachNode(nodeId) { detachNodes([nodeId]); }

// Pull every given node out of whatever group holds it. Backs the toolbar detach button
// and the group hotkey's "ungroup everything" (the whole selection).
export function detachNodes(nodeIds) {
    let changed = false;
    for (const id of nodeIds) {
        const g = groupOf(id);
        if (g) { g.members = g.members.filter((m) => m !== id); changed = true; }
    }
    if (reconcileFollowers()) changed = true;
    if (changed) { pruneEmpty(); renderGroups(); ctx.persist(); ctx.afterChange(); }
}

// A bonded follower (a window's PREVIEW node) has no group of its own — it always sits
// in exactly its leader's group, following the leader in and out. ctx.bonds() lists every
// {leader, follower} pair. Force each follower onto its leader's group (or out, if the
// leader is ungrouped); never group a follower independently. Returns true if anything moved.
function reconcileFollowers() {
    if (!ctx.bonds) return false;
    let changed = false;
    for (const { leader, follower } of ctx.bonds()) {
        const lg = groupOf(leader), fg = groupOf(follower);
        if (lg === fg) continue;
        if (fg) { fg.members = fg.members.filter((m) => m !== follower); changed = true; }
        if (lg && !lg.members.includes(follower)) { lg.members.push(follower); changed = true; }
    }
    return changed;
}

// Re-seat every bonded follower onto its leader's group (used after a satellite is toggled on,
// so a newly-shown follower joins its parent's group immediately instead of on the next edit).
export function reflowFollowers() {
    if (reconcileFollowers()) { reconcileSubFollowers(); pruneEmpty(); renderGroups(); ctx.persist(); ctx.afterChange(); }
    else if (reconcileSubFollowers()) { renderSubGroups(); ctx.persist(); }
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
    reconcileFollowers();
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
    if (reconcileFollowers()) changed = true;   // a window that joined drags its preview along; a preview dropped alone snaps back to its window
    // subgroup inheritance: a node dropped inside a subgroup's rectangle (within its own group)
    // joins that subgroup — the drag-drop counterpart of the toolbar action.
    if (absorbSub(ids)) changed = true;
    if (changed) { pruneEmpty(); renderGroups(); ctx.persist(); ctx.afterChange(); }
    return changed;
}

function boxContains(g, x, y) {
    const box = groupBox(g);
    return !!box && x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h;
}

// After a drop, attach a dragged node whose centre landed inside a subgroup box to that subgroup —
// but only if the node is in that subgroup's PARENT group (a subgroup never reaches outside it).
function absorbSub(ids) {
    let changed = false;
    for (const id of ids) {
        const r = ctx.nodeRect(id);
        if (!r) continue;
        const g = groupOf(id);
        if (!g) continue;
        const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
        const target = subGroups.find((sg) => sg.parent === g.id && !sg.members.includes(id) && subBoxContains(sg, cx, cy));
        if (!target) continue;
        const prev = subgroupOf(id);
        if (prev) prev.members = prev.members.filter((m) => m !== id);
        target.members.push(id);
        changed = true;
    }
    if (reconcileSubFollowers()) changed = true;
    return changed;
}
function subBoxContains(sg, x, y) {
    const box = subBox(sg, sg._titleH || 0);
    return !!box && x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h;
}

// Drop groups left empty (all members removed/deleted), forgetting them from super groups.
function pruneEmpty() {
    const gone = groups.filter((g) => !g.members.length).map((g) => g.id);
    groups = groups.filter((g) => g.members.length);
    if (gone.length) forgetGroups(new Set(gone));
    reconcileSub();           // a subgroup's members ⊆ its parent group — re-clamp after any membership edit
    reconcileSubFollowers();  // a satellite follows its parent into/out of a subgroup
}

// Called by main when nodes are removed, so a deleted node never lingers in a group.
export function forgetNodes(idsGone) {
    let changed = false;
    for (const g of groups) { const n = g.members.length; g.members = g.members.filter((m) => !idsGone.has(m)); if (g.members.length !== n) changed = true; }
    for (const sg of subGroups) { const n = sg.members.length; sg.members = sg.members.filter((m) => !idsGone.has(m)); if (sg.members.length !== n) changed = true; }
    if (changed) { pruneEmpty(); renderGroups(); ctx.persist(); }
}

// Rewrite member ids through `mapId` (returns a new id, or null/undefined to keep) so a
// node rename carries its group membership instead of detaching it. Caller re-renders.
export function remapNodes(mapId) {
    for (const g of groups) g.members = g.members.map((id) => mapId(id) || id);
    for (const sg of subGroups) sg.members = sg.members.map((id) => mapId(id) || id);
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
    renderSubGroups();     // sub-group boxes hug a subset of a group's nodes — same render pass
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
    const cog = h("button", { class: "ggt-cog", title: "group settings", "aria-label": "group settings" }, COG(13));
    tel.append(h("span", { class: "ggt-label" }), cog);
    // press the title: a real drag moves the whole group (click alone does nothing now —
    // settings live behind the cog so a stray click can't pop the options panel)
    tel.addEventListener("mousedown", (ev) => onTitlePress(g.id, ev));
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

// ---- options popover (shared by groups AND subgroups — rule 7) -------------
// A group and a subgroup have the SAME styling shape ({title, outline, bg, titleBg, titleColor,
// titleAlign}) and the SAME option panel, so ONE builder serves both. The only differences are
// the disband label, the owner element clicks may stay open over, and whether the fill is stored
// with alpha (groups, legacy) or pre-blended opaque (subgroups — no transparent colours).

function closePopover() { if (openPopover) { openPopover.el.remove(); openPopover = null; document.removeEventListener("mousedown", onOutside, true); } }
function onOutside(e) { if (openPopover && !e.target.closest(".ggroup-pop") && !e.target.closest(openPopover.ownerSel)) closePopover(); }

// `target` is the group/subgroup record (mutated live). `commitFn` re-renders the right layer.
function openOptionsPopover(id, target, ev, { ownerSel, disbandLabel, onDisband, opaqueBg }) {
    if (openPopover?.id === id) { closePopover(); return; }
    closePopover();
    const t = target;
    const pop = document.createElement("div");
    pop.className = "ggroup-pop";
    pop.append(
        h("label", { class: "flab" }, h("span", { class: "gp-lab" }, "title"),
            h("input", { class: "gp-title", value: t.title })),
        h("div", { class: "flab" }, h("span", { class: "gp-lab" }, "scheme"),
            h("div", { class: "gp-schemes" },
                SCHEMES.map((s, i) => h("button", { class: "gp-scheme", dataset: { i }, title: s.name,
                    style: `background:${s.titleBg || s.bg};border-color:${s.outline === "#2c313c" ? "#4a515f" : s.outline}` })))),
        h("label", { class: "flab" }, h("span", { class: "gp-lab" }, "outline"),
            h("select", { class: "gp-style" },
                ["solid", "dashed", "dotted", "none"].map((s) =>
                    h("option", { value: s, selected: t.outline.style === s }, s))),
            h("input", { type: "color", class: "gp-ocolor", value: hex6(t.outline.color), title: "outline color" })),
        h("label", { class: "flab" }, h("span", { class: "gp-lab" }, "background"),
            h("input", { type: "range", class: "gp-bga", min: "0", max: "100", value: alphaPct(t.bg), title: "fill opacity" }),
            h("input", { type: "color", class: "gp-bg", value: hex6(t.bg), title: "fill color" })),
        h("label", { class: "flab" }, h("span", { class: "gp-lab" }, "title bg"),
            h("input", { type: "color", class: "gp-tbg", value: hex6(t.titleBg || "#1d2027"), title: "title background" })),
        h("label", { class: "flab" }, h("span", { class: "gp-lab" }, "title text"),
            h("input", { type: "color", class: "gp-tcolor", value: hex6(t.titleColor || "#d7dbe2"), title: "title text color" })),
        h("label", { class: "flab" }, h("span", { class: "gp-lab" }, "align"),
            h("select", { class: "gp-pos" },
                ["left", "center", "right"].map((v) =>
                    h("option", { value: v, selected: t.titleAlign === v }, v)))),
        h("button", { class: "gp-disband danger" }, disbandLabel));
    // anchor near the click (screen space — it's fixed-position), then clamp fully on-screen so
    // no part spills out of bounds (measured after it's in the DOM).
    pop.style.left = `${ev.clientX}px`; pop.style.top = `${ev.clientY + 8}px`;
    document.body.appendChild(pop);
    const M = 8, r = pop.getBoundingClientRect();
    pop.style.left = `${Math.max(M, Math.min(ev.clientX, window.innerWidth - r.width - M))}px`;
    pop.style.top = `${Math.max(M, Math.min(ev.clientY + 8, window.innerHeight - r.height - M))}px`;
    openPopover = { id, el: pop, ownerSel };

    // a fill chosen here is stored opaque (pre-blended) for subgroups so nothing ever goes
    // translucent; groups keep their legacy alpha fill.
    const mkBg = (hex, pct) => (opaqueBg ? blendOnBg(hex, pct) : withAlpha(hex, pct));
    const commit = () => { renderGroups(); ctx.persist(); };   // renderGroups paints the sub + super layers too
    pop.querySelector(".gp-title").addEventListener("input", (e) => { t.title = e.target.value; commit(); });
    pop.querySelector(".gp-style").addEventListener("change", (e) => { t.outline.style = e.target.value; commit(); });
    pop.querySelector(".gp-ocolor").addEventListener("input", (e) => { t.outline.color = e.target.value; commit(); });
    const applyBg = () => { t.bg = mkBg(pop.querySelector(".gp-bg").value, +pop.querySelector(".gp-bga").value); commit(); };
    pop.querySelector(".gp-bg").addEventListener("input", applyBg);
    pop.querySelector(".gp-bga").addEventListener("input", applyBg);
    pop.querySelector(".gp-tbg").addEventListener("input", (e) => { t.titleBg = e.target.value; commit(); });
    pop.querySelector(".gp-tcolor").addEventListener("input", (e) => { t.titleColor = e.target.value; commit(); });
    pop.querySelector(".gp-pos").addEventListener("change", (e) => { t.titleAlign = e.target.value; commit(); });
    // a premade scheme sets fill + outline + title colours at once, and syncs the pickers
    pop.querySelectorAll(".gp-scheme").forEach((b) => b.addEventListener("click", () => {
        const s = SCHEMES[+b.dataset.i];
        t.bg = opaqueBg ? blendOnBg(s.titleBg || s.outline, 16) : s.bg;
        t.outline.color = s.outline; t.outline.style = s.style; t.titleBg = s.titleBg; t.titleColor = s.titleColor;
        pop.querySelector(".gp-bg").value = hex6(t.bg); pop.querySelector(".gp-bga").value = alphaPct(t.bg);
        pop.querySelector(".gp-ocolor").value = hex6(s.outline); pop.querySelector(".gp-style").value = s.style;
        pop.querySelector(".gp-tbg").value = hex6(s.titleBg || "#1d2027"); pop.querySelector(".gp-tcolor").value = hex6(s.titleColor || "#d7dbe2");
        commit();
    }));
    pop.querySelector(".gp-disband").addEventListener("click", () => onDisband());
    setTimeout(() => document.addEventListener("mousedown", onOutside, true), 0);
}

function togglePopover(gid, ev) {
    const g = byId(gid);
    if (!g) return;
    openOptionsPopover(`group:${gid}`, g, ev, {
        ownerSel: ".ggroup-title", disbandLabel: "disband group", opaqueBg: false,
        onDisband: () => disband(gid),
    });
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
    return superGroups.map((sg) => ({ id: sg.id, title: sg.title, outline: { ...sg.outline }, bg: sg.bg, bandH: SUPER_LABEL_BAND, box: superBox(sg) }))
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
    const cog = h("button", { class: "sgroup-cog", title: "super group settings", "aria-label": "super group settings" }, COG(15));
    const label = h("span", { class: "sgroup-label" });
    el.append(cog, label);
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
    pop.append(
        h("label", { class: "flab" }, h("span", { class: "gp-lab" }, "title"),
            h("input", { class: "gp-title", value: sg.title })),
        h("div", { class: "flab" }, h("span", { class: "gp-lab" }, "scheme"),
            h("div", { class: "gp-schemes" },
                SCHEMES.map((s, i) => h("button", { class: "gp-scheme", dataset: { i }, title: s.name,
                    style: `background:${s.titleBg || s.bg};border-color:${s.outline === "#2c313c" ? "#4a515f" : s.outline}` })))),
        h("label", { class: "flab" }, h("span", { class: "gp-lab" }, "outline"),
            h("select", { class: "gp-style" },
                ["solid", "dashed", "dotted", "none"].map((s) =>
                    h("option", { value: s, selected: sg.outline.style === s }, s))),
            h("input", { type: "color", class: "gp-ocolor", value: hex6(sg.outline.color), title: "outline color" })),
        h("label", { class: "flab" }, h("span", { class: "gp-lab" }, "background"),
            h("input", { type: "range", class: "gp-bga", min: "0", max: "100", value: alphaPct(sg.bg), title: "fill opacity" }),
            h("input", { type: "color", class: "gp-bg", value: hex6(sg.bg), title: "fill color" })),
        h("label", { class: "flab" }, h("span", { class: "gp-lab" }, "label"),
            h("input", { type: "color", class: "gp-tcolor", value: hex6(sg.titleColor || "#aab4d8"), title: "label color" })),
        h("button", { class: "gp-disband danger" }, "disband super group"));
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

// ---- sub groups: a group WITHIN a group -----------------------------------
// A subgroup owns a SUBSET of one group's nodes (its `parent`). It nests DOWN (vs a super group,
// which nests up). Default look: a faint outline rectangle, NO title and NO fill — configurable
// from a cogwheel (full group options; any chosen fill is stored OPAQUE, never translucent).
// Formed only from the toolbar over nodes that all already share ONE group. Pure layout, like
// groups — travels in profile.layout.sub_groups. Rendered in its own #subgroups layer, painted
// ABOVE the group fill but behind the nodes. Dragged from its border (rim) or its title band.

const SUB_PAD = 16;            // tight gap between members and the subgroup outline (nested -> smaller than PAD)
const SUB_DEF_OUTLINE = "#3a4154";
const SUB_DEF_BG = "";         // "" = no fill painted (default has no background)

let subGroups = [];            // [{ id, parent, title, members[], outline{color,style,width}, bg, titleBg, titleColor, titleAlign }]
let subseq = 0;

const subById = (id) => subGroups.find((sg) => sg.id === id);
export function allSubGroups() { return subGroups; }
export function subgroupOf(nodeId) { return subGroups.find((sg) => sg.members.includes(nodeId)) || null; }

// Id of the innermost subgroup whose box contains world point (x,y) — used so a node created
// inside a subgroup joins it (mirrors groupAt for groups).
export function subGroupAt(x, y) {
    let best = null, bestArea = Infinity;
    for (const sg of subGroups) {
        const box = subBox(sg);
        if (!box || x < box.x || x > box.x + box.w || y < box.y || y > box.y + box.h) continue;
        const area = box.w * box.h;
        if (area < bestArea) { bestArea = area; best = sg.id; }
    }
    return best;
}

// ---- membership edits -----------------------------------------------------

export function createSubgroup(memberIds) {
    const ids = [...new Set(memberIds)].filter((id) => ctx.nodeRect(id));
    if (!ids.length) return null;
    // every member must already share ONE group — the subgroup is scoped to that group
    const gset = new Set(ids.map((id) => groupOf(id)).filter(Boolean));
    if (gset.size !== 1) return null;
    const parent = [...gset][0];
    if (!ids.every((id) => parent.members.includes(id))) return null;
    for (const id of ids) { const sg = subgroupOf(id); if (sg) sg.members = sg.members.filter((m) => m !== id); }
    const sid = `subgroup_${++subseq}`;
    const sg = {
        id: sid, parent: parent.id, title: "", members: ids,
        outline: { color: SUB_DEF_OUTLINE, style: "solid", width: 1 }, bg: SUB_DEF_BG,
        titleBg: "", titleColor: "", titleAlign: "left",
    };
    subGroups.push(sg);
    reconcileSubFollowers();   // a member window's preview / a dataset's vt-table joins the subgroup too
    pruneEmptySub();
    renderSubGroups(); ctx.persist(); ctx.afterChange();
    return sg;
}

export function disbandSub(sid) {
    subGroups = subGroups.filter((sg) => sg.id !== sid);
    closeSubPopover();
    renderSubGroups(); ctx.persist(); ctx.afterChange();
}

// Pull nodes out of whatever subgroup holds them (toolbar "ungroup" when a subgroup is the target).
export function detachFromSub(nodeIds) {
    let changed = false;
    for (const id of nodeIds) { const sg = subgroupOf(id); if (sg) { sg.members = sg.members.filter((m) => m !== id); changed = true; } }
    if (reconcileSubFollowers()) changed = true;
    if (changed) { pruneEmptySub(); renderSubGroups(); ctx.persist(); ctx.afterChange(); }
}

export function addToSubgroup(sid, nodeIds) {
    const sg = subById(sid);
    if (!sg) return;
    const parent = byId(sg.parent);
    const add = [...new Set(nodeIds)].filter((id) => ctx.nodeRect(id) && !sg.members.includes(id) && parent && parent.members.includes(id));
    if (!add.length) return;
    for (const id of add) { const p = subgroupOf(id); if (p) p.members = p.members.filter((m) => m !== id); }
    sg.members.push(...add);
    reconcileSubFollowers();
    pruneEmptySub(); renderSubGroups(); ctx.persist(); ctx.afterChange();
}

function pruneEmptySub() { subGroups = subGroups.filter((sg) => sg.members.length); }

// A subgroup's members must stay ⊆ its parent group's members, and its parent must still exist.
// Drop orphaned members (a node that left the parent group ungroups from the subgroup too) and
// any subgroup whose parent vanished or that emptied out. Returns true if anything changed.
function reconcileSub() {
    let changed = false;
    for (const sg of subGroups) {
        const parent = byId(sg.parent);
        const keep = parent ? sg.members.filter((m) => parent.members.includes(m)) : [];
        if (keep.length !== sg.members.length) { sg.members = keep; changed = true; }
    }
    const before = subGroups.length;
    subGroups = subGroups.filter((sg) => byId(sg.parent) && sg.members.length);
    if (subGroups.length !== before) changed = true;
    return changed;
}

// A bonded follower (preview / vt-table) has no subgroup of its own — it sits in exactly its
// leader's subgroup, following it in and out. Mirrors reconcileFollowers for the group tier.
function reconcileSubFollowers() {
    if (!ctx.bonds) return false;
    let changed = false;
    for (const { leader, follower } of ctx.bonds()) {
        const ls = subgroupOf(leader), fs = subgroupOf(follower);
        if (ls === fs) continue;
        if (fs) { fs.members = fs.members.filter((m) => m !== follower); changed = true; }
        if (ls && !ls.members.includes(follower)) { ls.members.push(follower); changed = true; }
    }
    return changed;
}

// ---- persistence ----------------------------------------------------------
export function collectSub() {
    return subGroups.map((sg) => ({
        id: sg.id, parent: sg.parent, title: sg.title, members: [...sg.members],
        outline: { ...sg.outline }, bg: sg.bg, titleBg: sg.titleBg, titleColor: sg.titleColor, titleAlign: sg.titleAlign,
    }));
}
export function hydrateSub(arr) {
    closeSubPopover();
    subGroups = (arr || []).map((sg) => ({
        id: sg.id, parent: sg.parent, title: sg.title || "",
        members: Array.isArray(sg.members) ? [...sg.members] : [],
        outline: { color: sg.outline?.color || SUB_DEF_OUTLINE, style: sg.outline?.style || "solid", width: sg.outline?.width || 1 },
        bg: sg.bg || SUB_DEF_BG, titleBg: sg.titleBg || "", titleColor: sg.titleColor || "", titleAlign: sg.titleAlign || "left",
    })).filter((sg) => sg.parent && sg.members.length);
    subseq = subGroups.reduce((m, sg) => { const n = /^subgroup_(\d+)$/.exec(sg.id); return n ? Math.max(m, +n[1]) : m; }, 0);
    reconcileSub();
}

// ---- geometry -------------------------------------------------------------
function subBox(sg, titleH = sg._titleH || 0) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const id of sg.members) {
        const r = ctx.nodeRect(id);
        if (!r) continue;
        minX = Math.min(minX, r.x); minY = Math.min(minY, r.y);
        maxX = Math.max(maxX, r.x + r.w); maxY = Math.max(maxY, r.y + r.h);
    }
    if (!Number.isFinite(minX)) return null;
    return { x: minX - SUB_PAD, y: minY - SUB_PAD - titleH, w: (maxX - minX) + SUB_PAD * 2, h: (maxY - minY) + SUB_PAD * 2 + titleH };
}

// world boxes for external renderers (node map)
export function subGroupBoxes() {
    return subGroups.map((sg) => ({ id: sg.id, title: sg.title, outline: { ...sg.outline }, bg: sg.bg, bandH: sg._titleH || 0, box: subBox(sg) }))
        .filter((x) => x.box);
}

// ---- rendering ------------------------------------------------------------
export function renderSubGroups() {
    const layer = ctx.subWorld && ctx.subWorld();
    if (!layer) return;
    const live = new Set(subGroups.map((sg) => sg.id));
    for (const el of [...layer.children]) if (!live.has(el.dataset.subid)) el.remove();
    for (const sg of subGroups) {
        let el = layer.querySelector(`.subgroup[data-subid="${sg.id}"]`);
        if (!el) { el = buildSubEl(sg); layer.appendChild(el); }
        // optional title band: rendered only when a title is set (default has none -> no band)
        let tel = el.querySelector(".subgroup-title");
        if (sg.title) {
            if (!tel) { tel = buildSubTitleEl(sg); el.insertBefore(tel, el.firstChild); }
            tel.querySelector(".ggt-label").textContent = sg.title;
            tel.style.background = sg.titleBg || "";
            tel.style.color = sg.titleColor || "";
            placeTitle(tel, sg.titleAlign);
            sg._titleH = tel.offsetHeight || TITLE_H;
        } else { if (tel) tel.remove(); sg._titleH = 0; }
        const box = subBox(sg, sg._titleH || 0);
        if (!box) { el.remove(); continue; }
        el.style.left = `${box.x}px`; el.style.top = `${box.y}px`;
        el.style.width = `${box.w}px`; el.style.height = `${box.h}px`;
        el.style.background = sg.bg || "";              // "" -> no fill (transparent box, default)
        el.style.borderColor = sg.outline.color;
        el.style.borderStyle = sg.outline.style;
        el.style.borderWidth = `${sg.outline.style === "none" ? 0 : sg.outline.width}px`;
    }
}

function buildSubEl(sg) {
    const el = document.createElement("div");
    el.className = "subgroup";
    el.dataset.subid = sg.id;
    // four border strips make the rim draggable WITHOUT covering the interior (nodes stay clickable);
    // hovering any strip reveals the cog (CSS :hover bubbles to .subgroup even though the box is
    // pointer-events:none). The cog opens the shared options panel.
    for (const side of ["t", "r", "b", "l"]) {
        const rim = document.createElement("div");
        rim.className = `sgr-rim sgr-${side}`;
        rim.addEventListener("mousedown", (ev) => onSubPress(sg.id, ev));
        el.appendChild(rim);
    }
    const cog = document.createElement("button");
    cog.className = "subgroup-cog";
    cog.title = "subgroup settings"; cog.setAttribute("aria-label", "subgroup settings");
    cog.append(COG(15));
    cog.addEventListener("mousedown", (ev) => ev.stopPropagation());
    cog.addEventListener("click", (ev) => { ev.stopPropagation(); toggleSubPopover(sg.id, ev); });
    el.appendChild(cog);
    return el;
}

function buildSubTitleEl(sg) {
    const tel = document.createElement("div");
    tel.className = "ggroup-title subgroup-title";   // reuse the group title look
    tel.dataset.subid = sg.id;
    tel.append(h("span", { class: "ggt-label" }));
    tel.addEventListener("mousedown", (ev) => onSubPress(sg.id, ev));
    return tel;
}

function onSubPress(sid, ev) {
    if (ev.button !== 0) return;
    ev.stopPropagation();
    const sg = subById(sid);
    if (!sg) return;
    const stop = beginDrag(ev, { threshold: DRAG_THRESH, onStart: () => { stop(); ctx.moveMembers(sg.members, ev); } });
}

// ---- sub-group options popover (shared builder) ---------------------------
function closeSubPopover() { closePopover(); }   // group + subgroup share the one openPopover slot
function toggleSubPopover(sid, ev) {
    const sg = subById(sid);
    if (!sg) return;
    openOptionsPopover(`subgroup:${sid}`, sg, ev, {
        ownerSel: ".subgroup-cog", disbandLabel: "remove subgroup", opaqueBg: true,
        onDisband: () => disbandSub(sid),
    });
}
