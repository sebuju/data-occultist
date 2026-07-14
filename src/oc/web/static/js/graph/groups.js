// Node groups, sub-groups and super-groups: titled, outlined, faint-filled boxes drawn BEHIND
// the nodes/groups they own. All three are pure arrangement (they mean nothing to the backend),
// so they live in profile.layout alongside node positions and travel with the game.
//
// ONE ENGINE, THREE TIERS (CLAUDE.md rule 7). The three tiers used to be three near-identical
// copies of the same membership/geometry/render code; that divergence caused real drift. They now
// share ONE parameterised engine driven by a `tier` descriptor:
//   • GROUP — a box around NODES.                     members = node ids.  layer #ggroups.
//   • SUB   — a box around a SUBSET of one group.     members = node ids.  layer #subgroups.
//   • SUPER — a box around GROUPS.                     members = group ids. layer #sgroups.
// Every record shares one shape ({id, title, members[], outline, bg, titleBg, titleColor,
// titleAlign, shadow, schemeId, w?, h?, parent?}); a tier descriptor supplies only what genuinely
// differs (member rects, padding, whether the title reserves height / the box is sizable, the DOM
// scaffold, and the render extras). The colour-scheme spine (applySchemeTo, SCHEMES) and the
// options popover (openOptionsPopover) are already shared and used by all three tiers.
//
// This module owns the records + their DOM layers. It never reaches into main.js state directly —
// main hands it a small `ctx` of callbacks:
//   • nodeRect(id)   -> {x,y,w,h} world rect of a node (pos + element size), or null
//   • nodeType(id)   -> node type prefix ("window"/"dataset"/…) for the default title
//   • moveMembers(ids, ev) -> begin a multi-node drag (reuses main's move logic)
//   • world/superWorld/subWorld() -> the three DOM layers
//   • bonds()        -> {leader, follower} pairs (a preview follows its window in/out of a group)
//   • startGroupResize(gid, ev), persist(), afterChange()
//
// Geometry recomputes from live member rects every render, so a box always hugs its members.

import { beginDrag } from "./dragresize.js";   // shared drag-loop primitive
import { h, svg, TRASH } from "../dom.js";
import { setGroups } from "./edgecanvas.js";
import { resolveColor } from "./colors.js";

// ---- constants ------------------------------------------------------------
const PAD = 40;          // group: uniform gap between members and the outline (two GRID steps)
const TITLE_H = 24;      // fallback title height until measured (world px)
const DRAG_THRESH = 4;   // px before a title press becomes a move (else it's a click)

const SUPER_PAD = 44;          // super: gap between member groups and the outline (3 sides)
// Master kill-switch for sub-group + super-group chrome (S-A sub corner label, P-A super watermark).
// Flip false to blank both tiers' labels while iterating on the group look.
const STYLE_SUBSUPER = true;
const SUPER_LABEL_BAND = 112;  // super: taller bottom pad so the huge label clears the groups

const SUB_PAD = 10;            // sub: half a GRID step (lands the outline between grid snaps)

// Default tier look — retuned to the blueprint surfaces (base.css `--bg/--line/--line-soft`):
// a MUTED cool outline (= `--line`), distinct from the accent blue of the live multi-selection
// (an accent outline made every group look perpetually selected), over a faint region fill that
// sits BETWEEN the near-black board and a node's `--panel` card so the nodes still pop above it.
const DEF_OUTLINE = "#262c37";   // = --line
const DEF_BG = "#10141c";        // opaque region fill (above --bg, below a node card)
const SUPER_DEF_OUTLINE = "#2b323f";  // = --float-line
const SUPER_DEF_BG = "#0d1017";  // barely-there fill just above --bg, opaque
const SUB_DEF_OUTLINE = "#2b323f";

// The ONE cogwheel glyph (group / super / sub settings buttons all use it). A node can live in
// only one place, so this is a FACTORY returning a fresh svg each call; `size` is the square px.
const COG = (size) =>
    svg("svg", { viewBox: "0 0 16 16", width: size, height: size, "aria-hidden": "true" },
        svg("path", { fill: "currentColor", d: "M9.405 1.05c-.413-1.4-2.397-1.4-2.81 0l-.1.34a1.464 1.464 0 0 1-2.105.872l-.31-.17c-1.283-.698-2.686.705-1.987 1.987l.169.311c.446.82.023 1.841-.872 2.105l-.34.1c-1.4.413-1.4 2.397 0 2.81l.34.1a1.464 1.464 0 0 1 .872 2.105l-.17.31c-.698 1.283.705 2.686 1.987 1.987l.311-.169a1.464 1.464 0 0 1 2.105.872l.1.34c.413 1.4 2.397 1.4 2.81 0l.1-.34a1.464 1.464 0 0 1 2.105-.872l.31.17c1.283.698 2.686-.705 1.987-1.987l-.169-.311a1.464 1.464 0 0 1 .872-2.105l.34-.1c1.4-.413 1.4-2.397 0-2.81l-.34-.1a1.464 1.464 0 0 1-.872-2.105l.17-.31c.698-1.283-.705-2.686-1.987-1.987l-.311.169a1.464 1.464 0 0 1-2.105-.872l-.1-.34zM8 10.93a2.929 2.929 0 1 1 0-5.86 2.929 2.929 0 0 1 0 5.858z" }));

// ---- module state ---------------------------------------------------------
let ctx = null;
let groups = [];         // GROUP records
let superGroups = [];    // SUPER records
let subGroups = [];      // SUB records
let seq = 0, sseq = 0, subseq = 0;   // per-tier id counters (per load)
let openPopover = null;  // {id, el, ownerSel} of the currently open options popover
let selectedGroups = new Set();   // groups ctrl-clicked for super-grouping
let copyArm = null;      // { tier, dst, hasTitleBg, hasAlign, sync, commit, btn } while "copy style" armed

export function initGroups(c) { ctx = c; }

// ---- colour + shadow helpers (store as #rrggbb + 2-hex alpha so <input type=color> round-trips) ----
function cloneShadow(sh) { return sh ? { x: sh.x || 0, y: sh.y || 0, blur: sh.blur || 0, spread: sh.spread || 0, color: sh.color || "#000000" } : null; }
function shadowCss(sh) {
    if (!sh) return "";
    const x = sh.x || 0, y = sh.y || 0, b = sh.blur || 0, sp = sh.spread || 0;
    if (!x && !y && !b && !sp) return "";   // all-zero geometry -> no visible shadow
    return `${x}px ${y}px ${b}px ${sp}px ${sh.color || "#000000"}`;
}
function hex6(c) { const m = /^#([0-9a-f]{6})/i.exec(c || ""); return m ? `#${m[1]}` : "#5aa9e6"; }
// opacity % for the slider: an 8-digit colour carries it in its alpha byte; a 6-digit (opaque)
// colour — every scheme/default is opaque now — is full opacity (100).
function alphaPct(c) { const m = /^#[0-9a-f]{6}([0-9a-f]{2})$/i.exec(c || ""); return m ? Math.round((parseInt(m[1], 16) / 255) * 100) : 100; }
function withAlpha(hex, pct) { const a = Math.round((pct / 100) * 255).toString(16).padStart(2, "0"); return `${hex6(hex)}${a}`; }
// Blend `hex` at `pct` opacity over the global canvas bg (#15171c) into an OPAQUE #rrggbb —
// the same look as an alpha fill, but without alpha (so overlapping fills don't compound).
const GLOBAL_BG = [0x0b, 0x0d, 0x12];   // = base.css --bg (blueprint near-black board)
function blendOnBg(hex, pct) {
    const h = hex6(hex), a = Math.round((pct / 100) * 255) / 255;
    const ch = (i) => Math.round(parseInt(h.slice(1 + i * 2, 3 + i * 2), 16) * a + GLOBAL_BG[i] * (1 - a));
    return `#${[0, 1, 2].map((i) => ch(i).toString(16).padStart(2, "0")).join("")}`;
}
const SUB_DEF_BG = blendOnBg(SUB_DEF_OUTLINE, 12);   // faint OPAQUE tint so the region pops off the canvas

// ---- colour schemes (shared by all three tier popovers — rule 7) ----------
// Premade colour schemes that fit the app theme. titleBg/titleColor "" = fall back to the CSS
// defaults. `bg` is OPAQUE: each old translucent tint pre-blended over the canvas bg so overlapping
// groups never double-darken. Built-ins ship with the app; the user can ADD their own from the "+"
// swatch (customs travel WITH the game profile in layout.schemes).
const BUILTIN_SCHEMES = [
    { name: "slate", bg: "#181b20", style: "none", outline: "#2c313c", titleBg: "", titleColor: "" },
    { name: "onyx", bg: "#08090c", style: "none", outline: "#171a22", titleBg: "#20242e", titleColor: "#c7ccd6" },
    { name: "stone", bg: "#23272e", style: "none", outline: "#3a4150", titleBg: "#3a4150", titleColor: "#dfe3ea" },
    { name: "silver", bg: "#d3d8e0", style: "none", outline: "#8a91a0", titleBg: "#aeb4c0", titleColor: "#1a1d24" },
    { name: "blue", bg: "#1b252f", style: "none", outline: "#5aa9e6", titleBg: "#5aa9e6", titleColor: "#08121d" },
    { name: "cyan", bg: "#1b292f", style: "none", outline: "#5ad7e6", titleBg: "#5ad7e6", titleColor: "#08121d" },
    { name: "teal", bg: "#1b2a2c", style: "none", outline: "#5ae6c2", titleBg: "#5ae6c2", titleColor: "#08121d" },
    { name: "green", bg: "#1f2a25", style: "none", outline: "#7ddc7d", titleBg: "#7ddc7d", titleColor: "#08121d" },
    { name: "lime", bg: "#242a22", style: "none", outline: "#b6e65a", titleBg: "#b6e65a", titleColor: "#0e1408" },
    { name: "chartreuse", bg: "#232a20", style: "none", outline: "#8fe65a", titleBg: "#8fe65a", titleColor: "#0c1408" },
    { name: "yellow", bg: "#292820", style: "none", outline: "#e6e05a", titleBg: "#e6e05a", titleColor: "#14120a" },
    { name: "amber", bg: "#292722", style: "none", outline: "#e6c25a", titleBg: "#e6c25a", titleColor: "#08121d" },
    { name: "orange", bg: "#292322", style: "none", outline: "#e69a5a", titleBg: "#e69a5a", titleColor: "#1a0e08" },
    { name: "red", bg: "#291f22", style: "none", outline: "#e6685a", titleBg: "#e6685a", titleColor: "#1a0a08" },
    { name: "pink", bg: "#281d23", style: "none", outline: "#e0556b", titleBg: "#e0556b", titleColor: "#1a0a0e" },
    { name: "magenta", bg: "#291d2c", style: "none", outline: "#e65ac2", titleBg: "#e65ac2", titleColor: "#1a081a" },
    { name: "purple", bg: "#26222f", style: "none", outline: "#c98ae6", titleBg: "#c98ae6", titleColor: "#08121d" },
    { name: "indigo", bg: "#20232f", style: "none", outline: "#8a9ae6", titleBg: "#8a9ae6", titleColor: "#08121d" },
];
for (const s of BUILTIN_SCHEMES) s.id = s.name;   // built-ins use their (unique) name as id
// Blueprint group fill: a FAINT tint of the scheme's OWN outline over the board. The old built-in
// bgs were heavier pre-blends tuned to the pre-restyle (lighter) board, so they read loud against
// the darker blueprint surfaces — a group shouted while the flat cards whispered. Deriving the fill
// keeps the accent on the title band + outline and lets the big region stay subtle, the way the
// SUB/SUPER tiers already derive theirs. `silver` keeps its deliberately light (bright-region) fill.
for (const s of BUILTIN_SCHEMES) if (s.name !== "silver") s.bg = blendOnBg(s.outline, 13);
export const SCHEMES = [...BUILTIN_SCHEMES];       // built-ins; customs spliced in by hydrateSchemes()
const isBuiltinScheme = (s) => !!s && BUILTIN_SCHEMES.includes(s);
const schemeById = (id) => (id == null ? null : SCHEMES.find((s) => s.id === id) || null);
function newSchemeId() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return `s_${crypto.randomUUID()}`;
    return `s_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;
}
const _isCustomScheme = (s) => s && typeof s === "object" && s.outline;
export function hydrateSchemes(arr) {
    SCHEMES.length = BUILTIN_SCHEMES.length;   // drop the previous profile's customs
    for (const s of (Array.isArray(arr) ? arr : []).filter(_isCustomScheme))
        SCHEMES.push({ id: s.id || newSchemeId(), name: s.name || "custom", bg: s.bg || DEF_BG, style: s.style || "none",
            outline: s.outline, titleBg: s.titleBg || "", titleColor: s.titleColor || "",
            width: s.width ?? 2, offset: s.offset ?? 0, shadow: cloneShadow(s.shadow) });
}
export function collectSchemes() { return SCHEMES.slice(BUILTIN_SCHEMES.length); }

// A scheme carries EVERY style input (outline colour/style/width/offset, fill, title colours,
// shadow); align + size are the only props NOT part of a scheme. Three tiers wear a scheme
// differently (GROUP fills + bands, SUB tints the border + legend, SUPER is a faint outline), but
// width, offset and shadow apply the same everywhere. Applying links the record to the scheme.
function applySchemeTo(t, s, tier) {
    t.schemeId = s.id;
    t.outline.width = s.width ?? 2;
    t.outline.offset = s.offset ?? 0;
    t.shadow = cloneShadow(s.shadow);
    if (tier === "subgroup") {
        // honour the scheme's own outline style like every other tier — built-in schemes are all
        // style:"none", so applying one tints the fill + legend, never a border
        t.bg = blendOnBg(s.outline, 12); t.outline.style = s.style;
        t.outline.color = s.outline; t.titleBg = ""; t.titleColor = s.titleBg || s.outline;
    } else if (tier === "super") {
        t.outline.color = s.outline; t.outline.style = s.style; t.titleColor = s.titleBg || "";
        t.bg = blendOnBg(s.outline === "#2c313c" ? "#aab4d8" : s.outline, 4);
    } else {
        t.bg = s.bg; t.outline.style = s.style; t.outline.color = s.outline;
        t.titleBg = s.titleBg; t.titleColor = s.titleColor;
    }
}
// Capture `t`'s CURRENT look as a (group-canonical) scheme record — EVERY style input.
function currentToScheme(t, tier, name) {
    const common = { name, width: t.outline.width ?? 2, offset: t.outline.offset ?? 0, shadow: cloneShadow(t.shadow) };
    if (tier === "group")
        return { ...common, bg: t.bg, style: t.outline.style, outline: t.outline.color, titleBg: t.titleBg, titleColor: t.titleColor };
    return { ...common, bg: t.bg, style: t.outline.style === "none" ? "none" : "solid",
        outline: t.outline.color, titleBg: t.titleColor || t.titleBg || "", titleColor: t.titleColor || "" };
}
// An edited custom scheme repaints EVERY OTHER record that wears it (each via its own tier mapping).
function repaintLinked(s, except) {
    for (const g of groups) if (g !== except && g.schemeId === s.id) applySchemeTo(g, s, "group");
    for (const sg of subGroups) if (sg !== except && sg.schemeId === s.id) applySchemeTo(sg, s, "subgroup");
    for (const sg of superGroups) if (sg !== except && sg.schemeId === s.id) applySchemeTo(sg, s, "super");
    renderGroups();
}
// remove a custom scheme + untether every record that wore it (they keep their current look)
function removeScheme(id) {
    const i = SCHEMES.findIndex((s) => s.id === id);
    if (i < BUILTIN_SCHEMES.length) return;   // not found, or a built-in (immutable)
    SCHEMES.splice(i, 1);
    for (const list of [groups, subGroups, superGroups]) for (const r of list) if (r.schemeId === id) r.schemeId = null;
}
const swBorder = (s) => (s.outline === "#2c313c" ? "#4a515f" : s.outline);
const swRingCss = (s) => (s.style === "none" ? `border-color:var(--line)` : `border-color:${swBorder(s)};border-style:${s.style}`);
const swTopCss = (s) => `background:${s.titleBg || "#1d2027"};color:${s.titleColor || "#d7dbe2"}`;
const swBotCss = (s) => `background:${s.bg}`;
const PLUS_IC = () => svg("svg", { class: "gp-ic", viewBox: "0 0 24 24", "aria-hidden": "true" },
    svg("path", { fill: "none", stroke: "currentColor", "stroke-width": "2.6", "stroke-linecap": "round", d: "M12 6v12M6 12h12" }));
const COPY_IC = () => svg("svg", { class: "gp-ic", viewBox: "0 0 24 24", "aria-hidden": "true" },
    svg("rect", { x: "9", y: "9", width: "11", height: "11", rx: "2", fill: "none", stroke: "currentColor", "stroke-width": "2" }),
    svg("path", { d: "M5 15V5a2 2 0 0 1 2-2h8", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round" }));
function schemeSwatch(s, sel) {
    return h("button", { class: `gp-scheme${sel ? " sel" : ""}`, dataset: { sid: s.id }, title: s.name, style: swRingCss(s) },
        h("span", { class: "gp-sw-top", style: swTopCss(s) }, "Aa"),
        h("span", { class: "gp-sw-bot", style: swBotCss(s) }),
        isBuiltinScheme(s) ? null : h("span", { class: "gp-sw-rm", title: "remove scheme" }, TRASH()));
}
function restyleSwatch(pop, id) {
    const b = pop.querySelector(`.gp-scheme[data-sid="${id}"]`);
    const s = schemeById(id);
    if (!b || !s) return;
    b.setAttribute("style", swRingCss(s)); b.title = s.name;
    const top = b.querySelector(".gp-sw-top"), bot = b.querySelector(".gp-sw-bot");
    if (top) top.setAttribute("style", swTopCss(s));
    if (bot) bot.setAttribute("style", swBotCss(s));
}
function renderSchemeGrid(grid, t, tier, syncPickers, commit, markFn, hasTitleBg, hasAlign) {
    const rebuild = () => { renderSchemeGrid(grid, t, tier, syncPickers, commit, markFn, hasTitleBg, hasAlign); markFn(); ctx.persist(); };
    const kids = SCHEMES.map((s) => {
        const b = schemeSwatch(s, s.id === t.schemeId);
        b.addEventListener("click", () => { applySchemeTo(t, s, tier); syncPickers(); commit(); });
        const rm = b.querySelector(".gp-sw-rm");
        if (rm) rm.addEventListener("click", (e) => { e.stopPropagation(); removeScheme(s.id); renderGroups(); rebuild(); });
        return b;
    });
    const add = h("button", { class: "gp-scheme gp-scheme-add", title: "add the current style as a new scheme" }, PLUS_IC());
    add.addEventListener("click", () => {
        const s = currentToScheme(t, tier, `custom ${SCHEMES.length - BUILTIN_SCHEMES.length + 1}`);
        s.id = newSchemeId();
        SCHEMES.push(s); t.schemeId = s.id;
        rebuild();
    });
    const copy = h("button", { class: "gp-scheme gp-scheme-copy", title: "arm, then click another group of this kind to copy its style" }, COPY_IC());
    if (copyArm?.dst === t) copy.classList.add("armed");   // survive the rebuild while armed
    copy.addEventListener("click", () => {
        if (copyArm?.dst === t) { disarmCopy(); return; }   // toggle off
        disarmCopy();
        copyArm = { tier, dst: t, hasTitleBg, hasAlign, sync: syncPickers, commit, btn: copy };
        copy.classList.add("armed");
    });
    grid.replaceChildren(...kids, add, copy);
}
function markSchemeSel(pop, t) {
    pop.querySelectorAll(".gp-scheme[data-sid]").forEach((b) => {
        b.classList.toggle("sel", t.schemeId != null && b.dataset.sid === t.schemeId);
    });
}

// ---- tier descriptors -----------------------------------------------------
// Each tier supplies ONLY what differs; the generic engine below does everything else.
const GROUP = {
    key: "group", tierKey: "group",
    get: () => groups, set: (v) => { groups = v; }, nextId: () => `group_${++seq}`,
    layer: () => ctx.world && ctx.world(),
    sel: ".ggroup", idAttr: "gid",
    nodeTier: true, sizable: true, titleTop: true,
    padL: PAD, padR: PAD, padT: PAD, padB: PAD,
    memberValid: (id) => !!ctx.nodeRect(id),
    memberRect: (id) => ctx.nodeRect(id),
    makeRecord: (id, ids) => ({
        id, title: defaultTitle(ids) || id, members: ids,
        outline: { color: DEF_OUTLINE, style: "none", width: 2, offset: 0 }, bg: DEF_BG, titleAlign: "left",
        titleBg: "", titleColor: "", w: null, h: null, shadow: null, schemeId: null,
    }),
    buildEl: (rec) => buildBoxEl(rec),
    beforeSize: (rec, el) => groupBeforeSize(rec, el),
    afterSize: (rec, el) => groupAfterSize(rec, el),
    paint: () => renderGroups(),   // a group edit shifts super + sub boxes -> repaint all three
    onDisband: (id) => { forgetGroups(new Set([id])); subGroups = subGroups.filter((sg) => sg.parent !== id); },
    onPruneGone: (gone) => { if (gone.length) forgetGroups(new Set(gone)); reconcileSub(); reconcileFollowers(SUB); },
};
const SUPER = {
    key: "super", tierKey: "super",
    get: () => superGroups, set: (v) => { superGroups = v; }, nextId: () => `sgroup_${++sseq}`,
    layer: () => ctx.superWorld && ctx.superWorld(),
    sel: ".sgroup", idAttr: "sgid",
    nodeTier: false, sizable: false, titleTop: false,
    padL: SUPER_PAD, padR: SUPER_PAD, padT: SUPER_PAD, padB: SUPER_LABEL_BAND,
    memberValid: (id) => !!recById(GROUP, id),
    memberRect: (id) => { const g = recById(GROUP, id); return g ? boxOf(GROUP, g) : null; },
    makeRecord: (id, ids) => ({
        id, title: id, members: ids,
        outline: { color: SUPER_DEF_OUTLINE, style: "none", width: 2, offset: 0 }, bg: SUPER_DEF_BG,
        titleColor: "", shadow: null, schemeId: null,
    }),
    buildEl: (rec) => buildSuperEl(rec),
    afterSize: (rec, el) => superAfterSize(rec, el),
    paint: () => renderSuperGroups(),
};
const SUB = {
    key: "sub", tierKey: "subgroup",
    get: () => subGroups, set: (v) => { subGroups = v; }, nextId: () => `subgroup_${++subseq}`,
    layer: () => ctx.subWorld && ctx.subWorld(),
    sel: ".subgroup", idAttr: "subid",
    nodeTier: true, sizable: false, titleTop: false,   // uniform half-grid pad all sides; title straddles the top line (CSS), reserves no band
    padL: SUB_PAD, padR: SUB_PAD, padT: SUB_PAD, padB: SUB_PAD,
    memberValid: (id) => !!ctx.nodeRect(id),
    memberRect: (id) => ctx.nodeRect(id),
    // a subgroup is scoped to ONE parent group: every member must already share that group
    validate: (ids) => {
        const gset = new Set(ids.map((id) => memberOf(GROUP, id)).filter(Boolean));
        if (gset.size !== 1) return null;
        const parent = [...gset][0];
        if (!ids.every((id) => parent.members.includes(id))) return null;
        return { parent: parent.id };
    },
    parentOk: (rec, id) => { const p = recById(GROUP, rec.parent); return !!p && p.members.includes(id); },
    makeRecord: (id, ids, extra) => ({
        id, parent: extra.parent, title: "", members: ids,
        outline: { color: SUB_DEF_OUTLINE, style: "none", width: 1, offset: 0 }, bg: SUB_DEF_BG,
        titleBg: "", titleColor: "", titleAlign: "left", shadow: null, schemeId: null,
    }),
    buildEl: (rec) => buildSubEl(rec),
    beforeSize: (rec, el) => subBeforeSize(rec, el),
    afterSize: (rec, el) => subAfterSize(rec, el),
    paint: () => renderSubGroups(),
};
const TIERS = [GROUP, SUPER, SUB];

const recById = (tier, id) => tier.get().find((r) => r.id === id) || null;
const byId = (id) => recById(GROUP, id);
const sById = (id) => recById(SUPER, id);
const subById = (id) => recById(SUB, id);

// ---- generic membership edits ---------------------------------------------
function memberOf(tier, id) { return tier.get().find((r) => r.members.includes(id)) || null; }

// A record with a member removed elsewhere is pruned; a group's removal cascades (see onPruneGone).
function pruneEmpty(tier) {
    const gone = tier.get().filter((r) => !r.members.length).map((r) => r.id);
    tier.set(tier.get().filter((r) => r.members.length));
    tier.onPruneGone?.(gone);
}
// Re-render + persist + notify main after any membership edit.
function afterEdit(tier) { pruneEmpty(tier); tier.paint(); ctx.persist(); ctx.afterChange?.(); }

// Form a new tier record out of `memberIds`. A member belongs to at most one record of its tier,
// so each is pulled out of any prior one first. Returns the record, or null (invalid / empty).
function createIn(tier, memberIds) {
    const ids = [...new Set(memberIds)].filter(tier.memberValid);
    if (ids.length < 1) return null;
    let extra = {};
    if (tier.validate) { const v = tier.validate(ids); if (!v) return null; extra = v; }
    for (const id of ids) { const p = memberOf(tier, id); if (p) p.members = p.members.filter((m) => m !== id); }
    const rec = tier.makeRecord(tier.nextId(), ids, extra);
    tier.get().push(rec);
    if (tier.nodeTier) reconcileFollowers(tier);
    afterEdit(tier);
    return rec;
}
// Add members to an existing record (pulling each out of any prior record of the tier first).
function addIn(tier, recId, memberIds) {
    const rec = recById(tier, recId);
    if (!rec) return;
    let add = [...new Set(memberIds)].filter((id) => tier.memberValid(id) && !rec.members.includes(id));
    if (tier.parentOk) add = add.filter((id) => tier.parentOk(rec, id));
    if (!add.length) return;
    for (const id of add) { const p = memberOf(tier, id); if (p) p.members = p.members.filter((m) => m !== id); }
    rec.members.push(...add);
    if (tier.nodeTier) reconcileFollowers(tier);
    afterEdit(tier);
}
// Pull every given member out of whatever record of the tier holds it.
function detachIn(tier, memberIds) {
    let changed = false;
    for (const id of memberIds) { const r = memberOf(tier, id); if (r) { r.members = r.members.filter((m) => m !== id); changed = true; } }
    if (tier.nodeTier && reconcileFollowers(tier)) changed = true;
    if (changed) afterEdit(tier);
}
function disbandIn(tier, id) {
    tier.set(tier.get().filter((r) => r.id !== id));
    tier.onDisband?.(id);
    closePopover();
    tier.paint(); ctx.persist(); ctx.afterChange?.();
}

// Default group title = the trait the members share: all one type -> that type pluralised, else null.
function defaultTitle(memberIds) {
    const types = new Set(memberIds.map((id) => ctx.nodeType(id)).filter(Boolean));
    if (types.size === 1) { const t = [...types][0]; return t.endsWith("s") ? t : `${t}s`; }
    return null;
}

// Drop disbanded/removed groups out of every super group.
function forgetGroups(idsGone) {
    let changed = false;
    for (const s of superGroups) { const n = s.members.length; s.members = s.members.filter((g) => !idsGone.has(g)); if (s.members.length !== n) changed = true; }
    if (changed) { pruneEmpty(SUPER); renderSuperGroups(); ctx.persist?.(); }
}

// A subgroup's members must stay ⊆ its parent group's members, and its parent must still exist.
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

// A bonded follower (a window's PREVIEW node) has no record of its own — it sits in exactly its
// leader's record, following it in and out. Works for GROUP and SUB (super has no bonds).
function reconcileFollowers(tier) {
    if (!ctx.bonds || !tier.nodeTier) return false;
    let changed = false;
    for (const { leader, follower } of ctx.bonds()) {
        const lg = memberOf(tier, leader), fg = memberOf(tier, follower);
        if (lg === fg) continue;
        if (fg) { fg.members = fg.members.filter((m) => m !== follower); changed = true; }
        if (lg && !lg.members.includes(follower)) { lg.members.push(follower); changed = true; }
    }
    return changed;
}

// ---- public membership wrappers (stable names main.js imports) -------------
export function groupOf(id) { return memberOf(GROUP, id); }
export function subgroupOf(id) { return memberOf(SUB, id); }
export function superGroupOf(id) { return memberOf(SUPER, id); }
export function createGroup(ids) { return createIn(GROUP, ids); }
export function createSubgroup(ids) { return createIn(SUB, ids); }
export function createSuperGroup(ids) { return createIn(SUPER, ids); }
export function addToGroup(gid, ids) { addIn(GROUP, gid, ids); }
export function addToSubgroup(sid, ids) { addIn(SUB, sid, ids); }
export function addToSuper(sid, ids) { addIn(SUPER, sid, ids); }
export function detachNode(id) { detachIn(GROUP, [id]); }
export function detachNodes(ids) { detachIn(GROUP, ids); }
export function detachFromSub(ids) { detachIn(SUB, ids); }
export function detachGroups(ids) { detachIn(SUPER, ids); }
export function disband(id) { disbandIn(GROUP, id); }
export function disbandSub(id) { disbandIn(SUB, id); }
export function disbandSuper(id) { disbandIn(SUPER, id); }
export const allGroups = () => groups;
export const allSubGroups = () => subGroups;
export const allSuperGroups = () => superGroups;

// Re-seat every bonded follower onto its leader's record (used after a satellite is toggled on).
export function reflowFollowers() {
    if (reconcileFollowers(GROUP)) { reconcileFollowers(SUB); pruneEmpty(GROUP); renderGroups(); ctx.persist(); ctx.afterChange?.(); }
    else if (reconcileFollowers(SUB)) { renderSubGroups(); ctx.persist(); }
}

// Called by main when nodes are removed, so a deleted node never lingers in a group or subgroup.
export function forgetNodes(idsGone) {
    let changed = false;
    for (const list of [groups, subGroups]) for (const r of list) { const n = r.members.length; r.members = r.members.filter((m) => !idsGone.has(m)); if (r.members.length !== n) changed = true; }
    if (changed) { pruneEmpty(GROUP); renderGroups(); ctx.persist(); }
}
// Rewrite member ids through `mapId` so a node rename carries its membership. Caller re-renders.
export function remapNodes(mapId) {
    for (const list of [groups, subGroups]) for (const r of list) r.members = r.members.map((id) => mapId(id) || id);
}

// ---- drag-drop absorb -----------------------------------------------------
// After a node drag, attach a dragged node whose centre landed inside a box to that box. A node
// that is ALREADY grouped (or subgrouped) is left alone — moving it must not auto-join another
// group/subgroup (only loose nodes are absorbed). Never auto-detaches. Returns true if anything moved.
export function absorb(ids) {
    let changed = false;
    for (const id of ids) {
        if (memberOf(GROUP, id)) continue;   // already grouped -> never auto-join another group
        const r = ctx.nodeRect(id);
        if (!r) continue;
        const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
        const target = groups.find((g) => boxContains(g, cx, cy));
        if (!target) continue;
        target.members.push(id);
        changed = true;
    }
    if (reconcileFollowers(GROUP)) changed = true;   // a window that joined drags its preview along
    if (absorbSub(ids)) changed = true;              // subgroup inheritance, same rule
    if (changed) { pruneEmpty(GROUP); renderGroups(); ctx.persist(); ctx.afterChange?.(); }
    return changed;
}
function absorbSub(ids) {
    let changed = false;
    for (const id of ids) {
        if (memberOf(SUB, id)) continue;   // already in a subgroup -> don't auto-move it
        const r = ctx.nodeRect(id);
        if (!r) continue;
        const g = memberOf(GROUP, id);
        if (!g) continue;
        const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
        const target = subGroups.find((sg) => sg.parent === g.id && subBoxContains(sg, cx, cy));
        if (!target) continue;
        target.members.push(id);
        changed = true;
    }
    if (reconcileFollowers(SUB)) changed = true;
    return changed;
}
function boxContains(g, x, y) { const box = boxOf(GROUP, g); return !!box && x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h; }
function subBoxContains(sg, x, y) { const box = boxOf(SUB, sg, 0); return !!box && x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h; }

// ---- geometry -------------------------------------------------------------
// ONE bounding-box for every tier: hug the member rects, add per-tier padding, reserve the title
// height at the top (group only), grow/shrink by the outline offset, and honour an explicit
// container size (group only). Returns null until at least one member has a live rect.
function boxOf(tier, rec, titleH) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const id of rec.members) {
        const r = tier.memberRect(id);
        if (!r) continue;
        minX = Math.min(minX, r.x); minY = Math.min(minY, r.y);
        maxX = Math.max(maxX, r.x + r.w); maxY = Math.max(maxY, r.y + r.h);
    }
    if (!Number.isFinite(minX)) return null;
    const tt = tier.titleTop ? (titleH ?? (rec._titleH || TITLE_H)) : 0;
    const off = rec.outline?.offset || 0;
    const autoW = (maxX - minX) + tier.padL + tier.padR + off * 2;
    const autoH = (maxY - minY) + tier.padT + tier.padB + tt + off * 2;
    const w = (tier.sizable && rec.w > 0) ? rec.w + off * 2 : autoW;
    const h = (tier.sizable && rec.h > 0) ? rec.h + off * 2 : autoH;
    return { x: minX - tier.padL - off, y: minY - tier.padT - tt - off, w, h };
}

// The title is a child of the box (CSS pins it to the top-left); this only sets its TEXT alignment.
// Shared by group + sub corner labels.
function placeTitle(tel, align) { tel.style.justifyContent = align === "center" ? "center" : align === "right" ? "flex-end" : "flex-start"; }

// ---- rendering ------------------------------------------------------------
// ONE render pass per tier: reconcile the layer's children by id, size + style each box the same
// way, then let the tier add its own bits (group title band, sub legend, super watermark).
export function renderGroups() { renderTier(GROUP); renderTier(SUPER); renderTier(SUB); pushCanvasGroups(); }
function renderSuperGroups() { renderTier(SUPER); pushCanvasGroups(); }
function renderSubGroups() { renderTier(SUB); pushCanvasGroups(); }

// Feed the under-canvas the resolved box fill+border for every tier. Draw order = paint order:
// super (bottom) < group < sub (top), matching the #sgroups/#ggroups/#subgroups DOM z-order.
// resolveColor turns the color-mix expressions into concrete rgb so the canvas matches the DOM.
function pushCanvasGroups() {
    const recs = [];
    for (const b of superGroupBoxes()) {
        const c = superBoxColors(b);
        recs.push({ ...b.box, tier: "super", outline: resolveColor(c.outline), fill: resolveColor(b.bg) });
    }
    for (const b of groupBoxes()) {
        const c = groupBoxColors(b);
        recs.push({ ...b.box, tier: "group", outline: resolveColor(c.outline), fill: resolveColor(c.fill), dashed: true });
    }
    for (const b of subGroupBoxes()) {
        const c = subBoxColors(b);
        recs.push({ ...b.box, tier: "sub", outline: resolveColor(c.ring), fill: resolveColor(c.themed ? c.wash : b.bg) });
    }
    setGroups(recs);
}

function renderTier(tier) {
    const layer = tier.layer();
    if (!layer) return;
    const live = new Set(tier.get().map((r) => r.id));
    for (const el of [...layer.children]) if (!live.has(el.dataset[tier.idAttr])) el.remove();
    for (const rec of tier.get()) {
        let el = layer.querySelector(`${tier.sel}[data-${tier.idAttr}="${rec.id}"]`);
        if (!el) { el = tier.buildEl(rec); layer.appendChild(el); }
        // measure the title band BEFORE sizing (group), so the box reserves its real height
        const titleH = tier.beforeSize ? tier.beforeSize(rec, el) : 0;
        const box = boxOf(tier, rec, titleH);
        if (!box) { el.remove(); continue; }
        el.style.left = `${box.x}px`; el.style.top = `${box.y}px`;
        el.style.width = `${box.w}px`; el.style.height = `${box.h}px`;
        const bw = rec.outline.style === "none" ? 0 : (rec.outline.width ?? 2);
        el.style.background = rec.bg || "";
        el.style.borderColor = rec.outline.color;
        el.style.borderStyle = rec.outline.style;
        el.style.borderWidth = `${bw}px`;
        el.style.boxShadow = shadowCss(rec.shadow);
        tier.afterSize?.(rec, el, box);
    }
}

// Group outline width scales with zoom, bounded to [1px, 3px]: 3px when zoomed far out (a thin line
// would get lost), tapering to 1px up close for the thin blueprint look. Returns the width in world
// px as a NUMBER; the canvas group renderer (edgecanvas drawGroups) strokes it directly on every
// redraw, so the width tracks zoom without any DOM border to rewrite.
export function groupBorderCss(zoom) {
    const z = zoom || 1;
    return Math.max(1, Math.min(3, 3 - (z - 0.3) * (2 / 0.7)));   // z<=0.3 -> 3px, z>=1.0 -> 1px
}

// GROUP render extras: a title band CHILD (clipped flush by the box) + selection highlight.
function groupBeforeSize(rec, el) {
    let tel = el.querySelector(".ggroup-title");
    if (!tel) { tel = buildTitleEl(rec); el.appendChild(tel); }
    tel.querySelector(".ggt-label").textContent = rec.title;
    return (rec._titleH = tel.offsetHeight || TITLE_H);
}
// The box FILL + BORDER colour expressions per tier — the identity hue ("themed" = any scheme
// whose outline differs from the neutral default). Shared by the DOM afterSize styling and the
// canvas group renderer (pushCanvasGroups) so the two look identical and never drift (rule 7).
function groupBoxColors(rec) {
    const tint = rec.outline?.color || DEF_OUTLINE;
    const themed = tint.toLowerCase() !== DEF_OUTLINE.toLowerCase();
    return { themed,
        outline: themed ? `color-mix(in oklab, ${tint} 50%, var(--line))` : "var(--line)",
        fill: themed ? `color-mix(in oklab, ${tint} 5%, transparent)` : "transparent",
        label: themed ? `color-mix(in oklab, ${tint} 72%, var(--muted))` : "" };
}
function subBoxColors(rec) {
    const tint = rec.outline?.color || SUB_DEF_OUTLINE;
    const themed = tint.toLowerCase() !== SUB_DEF_OUTLINE.toLowerCase();
    return { themed,
        ring: themed ? `color-mix(in oklab, ${tint} 20%, transparent)` : "var(--line)",
        shade: themed ? `color-mix(in oklab, ${tint} 16%, transparent)` : "color-mix(in oklab, var(--line) 60%, transparent)",
        wash: themed ? `color-mix(in oklab, ${tint} 6%, transparent)` : "",
        label: themed ? `color-mix(in oklab, ${tint} 60%, var(--dim))` : "" };
}
function superBoxColors(rec) {
    const tint = rec.outline?.color || SUPER_DEF_OUTLINE;
    const themed = tint.toLowerCase() !== SUPER_DEF_OUTLINE.toLowerCase();
    return { outline: themed ? `color-mix(in oklab, ${tint} 35%, var(--line-soft))` : "var(--line-soft)" };
}

function groupAfterSize(rec, el) {
    // Option A: the scheme's outline colour IS the group's identity hue — a themed group tints the
    // corner label + a faint box wash + the dashed outline; a default one falls back to --dim / --line.
    const c = groupBoxColors(rec);
    const tel = el.querySelector(".ggroup-title");
    if (tel) {
        tel.style.background = "";
        tel.style.color = c.label;   // "" -> CSS --dim
        placeTitle(tel, rec.titleAlign);
    }
    // Canvas renderer draws the box fill + dashed border itself (under-canvas); blank the DOM box so
    // it doesn't double-render. The title band + selection highlight stay DOM.
    el.style.background = "transparent"; el.style.borderWidth = "0";
    el.classList.toggle("gsel", selectedGroups.has(rec.id));   // ctrl-click selection highlight
}

// SUB render extras (S-A): a small caps label pinned INSIDE the box's top-left corner — a smaller,
// dimmer sibling of the group label. Mirrors groupBeforeSize: measure the label first so the box
// reserves its height (titleTop:true) and it never overlaps the first node. subAfterSize tints it.
function subBeforeSize(rec, el) {
    let tel = el.querySelector(".subgroup-title");
    if (STYLE_SUBSUPER && rec.title) {
        if (!tel) { tel = buildSubTitleEl(rec); el.insertBefore(tel, el.firstChild); }
        tel.querySelector(".ggt-label").textContent = rec.title;
    } else if (tel) { tel.remove(); tel = null; }
    return (rec._titleH = tel ? (tel.offsetHeight || 0) : 0);
}
function subAfterSize(rec, el) {
    // dimmer, denser echo of the group Option-A look: soft-tinted inset well + faint wash + a mint/
    // scheme-tinted micro-label. "Themed" = any scheme whose outline differs from the neutral sub default.
    const c = subBoxColors(rec);
    const tel = el.querySelector(".subgroup-title");
    if (tel) {
        tel.style.background = "";
        tel.style.color = c.label;   // "" -> CSS --dim
        placeTitle(tel, rec.titleAlign);
    }
    // "Sunken": an inset tinted ring + inner shade make the subset look recessed. The canvas draws the
    // well itself (under-canvas); blank the DOM box, keep the corner label.
    el.style.background = "transparent"; el.style.borderWidth = "0"; el.style.boxShadow = "none";
}

// SUPER render extras: the huge watermark label (colour only; text set here).
function superAfterSize(rec, el) {
    const lab = el.querySelector(".sgroup-label");
    if (lab) { lab.textContent = STYLE_SUBSUPER ? rec.title : ""; lab.style.color = rec.titleColor || ""; }
    // P-A: solid, faint rim (the huge dim watermark is the label; the box just recedes as a backdrop).
    // Force it here because the shared render pass leaves the default super outline style "none" (no rim).
    // Canvas strokes the rim + fill itself (under-canvas); blank the DOM box, keep the label.
    el.style.borderWidth = "0"; el.style.background = "transparent";
}

// ---- DOM scaffolds (one per tier) -----------------------------------------
function buildBoxEl(g) {
    const el = document.createElement("div");
    el.className = "ggroup";
    el.dataset.gid = g.id;
    // bottom-right grip: drag to resize the group's CONTAINER box (sets explicit w/h)
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
    // press the title: a real drag moves the whole group; settings live behind the cog
    tel.addEventListener("mousedown", (ev) => onTitlePress(g.id, ev));
    cog.addEventListener("mousedown", (ev) => ev.stopPropagation());
    cog.addEventListener("click", (ev) => { ev.stopPropagation(); togglePopover(g.id, ev); });
    return tel;
}
function onTitlePress(gid, ev) {
    if (ev.button !== 0) return;
    ev.stopPropagation();   // don't start a marquee / deselect on the canvas
    const g = byId(gid);
    if (!g) return;
    if (tryCopyFrom(g, "group")) { ev.preventDefault(); return; }   // copy-style armed
    if (ev.ctrlKey || ev.metaKey) { ev.preventDefault(); toggleGroupSelected(gid); return; }   // ctrl selects for super-grouping
    const stop = beginDrag(ev, { threshold: DRAG_THRESH, onStart: () => { stop(); ctx.moveMembers(g.members, ev); } });
}

function buildSuperEl(sg) {
    const el = document.createElement("div");
    el.className = "sgroup";
    el.dataset.sgid = sg.id;
    // cog + huge label, both pinned bottom-left (each absolute so the label never shifts the cog).
    const cog = h("button", { class: "sgroup-cog", title: "super group settings", "aria-label": "super group settings" }, COG(15));
    const label = h("span", { class: "sgroup-label" });
    el.append(cog, label);
    label.addEventListener("mousedown", (ev) => onSuperPress(sg.id, ev));
    cog.addEventListener("mousedown", (ev) => {
        if (ev.button !== 0) return;
        ev.stopPropagation();
        if (ev.ctrlKey || ev.metaKey) return;   // ctrl is for selection, never drags
        const stop = beginDrag(ev, { threshold: DRAG_THRESH, onStart: () => { stop(); startSuperDrag(sg.id, ev); } });
    });
    cog.addEventListener("click", (ev) => { ev.stopPropagation(); toggleSuperPopover(sg.id, ev); });
    return el;
}
function onSuperPress(sid, ev) {
    if (ev.button !== 0) return;
    ev.stopPropagation();
    if (ev.ctrlKey || ev.metaKey) return;
    const stop = beginDrag(ev, { threshold: DRAG_THRESH, onStart: () => { stop(); startSuperDrag(sid, ev); } });
}
function superMemberNodeIds(sg) {
    const ids = [];
    for (const gid of sg.members) { const g = byId(gid); if (g) ids.push(...g.members); }
    return ids;
}
function startSuperDrag(sid, ev) {
    const sg = sById(sid); if (!sg) return;
    const ids = superMemberNodeIds(sg);
    if (ids.length) ctx.moveMembers(ids, ev);
}

function buildSubEl(sg) {
    const el = document.createElement("div");
    el.className = "subgroup";
    el.dataset.subid = sg.id;
    // four border strips make the rim draggable WITHOUT covering the interior (nodes stay clickable);
    // hovering any strip reveals the cog. The cog opens the shared options panel.
    for (const side of ["t", "r", "b", "l"]) {
        const rim = document.createElement("div");
        rim.className = `sgr-rim sgr-${side}`;
        rim.addEventListener("mousedown", (ev) => onSubPress(sg.id, ev));
        el.appendChild(rim);
    }
    const cog = document.createElement("button");
    cog.className = "subgroup-cog";
    cog.title = "subgroup settings"; cog.setAttribute("aria-label", "subgroup settings");
    cog.append(COG(9));
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
    if (ev.ctrlKey || ev.metaKey) return;
    const sg = subById(sid);
    if (!sg) return;
    const stop = beginDrag(ev, { threshold: DRAG_THRESH, onStart: () => { stop(); ctx.moveMembers(sg.members, ev); } });
}

// ---- external geometry readers (node map, router, canvas hit-tests) -------
export function groupBoxes() {
    return groups
        .map((g) => ({ id: g.id, title: g.title, outline: { ...g.outline }, bg: g.bg, titleAlign: g.titleAlign, bandH: g._titleH || TITLE_H, box: boxOf(GROUP, g) }))
        .filter((x) => x.box);
}
export function subGroupBoxes() {
    return subGroups.map((sg) => ({ id: sg.id, title: sg.title, outline: { ...sg.outline }, bg: sg.bg, bandH: 0, box: boxOf(SUB, sg) }))
        .filter((x) => x.box);
}
export function superGroupBoxes() {
    const layer = ctx.superWorld && ctx.superWorld();
    return superGroups.map((sg) => {
        const box = boxOf(SUPER, sg);
        if (!box) return null;
        let labelRect = null;
        const lab = layer && layer.querySelector(`.sgroup[data-sgid="${sg.id}"] .sgroup-label`);
        if (lab && lab.offsetWidth) labelRect = { x: box.x + lab.offsetLeft, y: box.y + lab.offsetTop, w: lab.offsetWidth, h: lab.offsetHeight };
        return { id: sg.id, title: sg.title, outline: { ...sg.outline }, bg: sg.bg, bandH: SUPER_LABEL_BAND, box, labelRect };
    }).filter(Boolean);
}
// World rects of each group's TITLE band, fed to the router as (soft) obstacles.
export function titleRects() {
    const out = [];
    for (const g of groups) {
        const th = g._titleH || TITLE_H;
        const box = boxOf(GROUP, g, th);
        if (box) out.push({ x: box.x, y: box.y, w: box.w, h: th });
    }
    return out;
}
// Id of the innermost (by area) group / subgroup whose box contains world point (x,y), or null.
export function groupAt(x, y) { return innermostAt(GROUP, x, y); }
export function subGroupAt(x, y) { return innermostAt(SUB, x, y); }
function innermostAt(tier, x, y) {
    let best = null, bestArea = Infinity;
    for (const r of tier.get()) {
        const box = boxOf(tier, r);
        if (!box || x < box.x || x > box.x + box.w || y < box.y || y > box.y + box.h) continue;
        const area = box.w * box.h;
        if (area < bestArea) { bestArea = area; best = r.id; }
    }
    return best;
}

// ---- group selection (ctrl-click) for super-grouping ----------------------
export function toggleGroupSelected(gid) {
    if (selectedGroups.has(gid)) selectedGroups.delete(gid); else selectedGroups.add(gid);
    renderGroups(); ctx.afterChange?.();
}
export function selectedGroupIds() { return [...selectedGroups].filter((id) => byId(id)); }
export function clearGroupSelection() { if (selectedGroups.size) { selectedGroups.clear(); renderGroups(); ctx.afterChange?.(); } }

// ---- options popover (shared by all three tiers — rule 7) ------------------
// `target` is the record (mutated live). One builder for all tiers — the options differ only in
// which rows show, the disband label, the render fn, and how the fill stores.
function closePopover() {
    disarmCopy();
    if (openPopover) { openPopover.el.remove(); openPopover = null; document.removeEventListener("mousedown", onOutside, true); }
}
function onOutside(e) { if (openPopover && !e.target.closest(".ggroup-pop") && !e.target.closest(openPopover.ownerSel)) closePopover(); }

// While "copy style" is armed, clicking another SAME-TIER record copies its styling into the open one.
function disarmCopy() { if (copyArm) { copyArm.btn?.classList.remove("armed"); copyArm = null; } }
function copyStyleInto(dst, src, hasTitleBg, hasAlign) {
    dst.outline = { ...src.outline };
    dst.bg = src.bg;
    dst.shadow = cloneShadow(src.shadow);
    dst.schemeId = src.schemeId ?? null;
    if (hasTitleBg) dst.titleBg = src.titleBg;
    dst.titleColor = src.titleColor;
    if (hasAlign) dst.titleAlign = src.titleAlign;
}
function tryCopyFrom(src, tier) {
    if (!copyArm || copyArm.tier !== tier || copyArm.dst === src) return false;
    copyStyleInto(copyArm.dst, src, copyArm.hasTitleBg, copyArm.hasAlign);
    const { sync, commit } = copyArm;
    disarmCopy(); sync(); commit();
    return true;
}
// A small "×" that clears a colour input to "" (fall back to CSS default / no colour). Shared by
// every clearable colour field (rule 7) — a new one is a CALL, not another inline handler.
function clearX(title, onClear) {
    const b = h("button", { class: "gp-clear", title, "aria-label": title }, "×");
    b.addEventListener("click", (e) => { e.preventDefault(); onClear(); });
    return b;
}

// Per-tier flags gate which rows show. The restyle (groupAfterSize / subAfterSize / superAfterSize)
// now HARDCODES rim style+width, and per-tier fill/shadow/title-colour, so those controls are pruned
// where they'd be no-ops: only OUTLINE COLOUR + OFFSET, title text, align, size, scheme + disband are
// universally live. hasFill/hasTitleColor/hasShadow re-expose the few a given tier still honours.
function openOptionsPopover(id, target, ev, { ownerSel, disbandLabel, onDisband, opaqueBg, defaults, sizable,
        tier = "group", render = renderGroups, hasTitleBg = true, hasAlign = true, titleTextLabel = "title text",
        hasFill = false, hasTitleColor = false, hasShadow = true }) {
    if (openPopover?.id === id) { closePopover(); return; }
    closePopover();
    const t = target;
    const pop = document.createElement("div");
    pop.className = "ggroup-pop";
    const schemeGrid = h("div", { class: "gp-schemes" });
    const sub = (txt) => h("div", { class: "gp-sub" }, txt);
    const autoBox = sizable ? boxOf(GROUP, t) : null;
    const autoPh = (axis) => (autoBox ? `${Math.round(autoBox[axis])} px (auto)` : "auto");
    pop.append(...[
        h("label", { class: "flab" }, h("span", { class: "gp-lab" }, "title"),
            h("input", { class: "gp-title", value: t.title })),
        (hasAlign || sizable) ? sub("layout") : null,
        hasAlign ? h("label", { class: "flab" }, h("span", { class: "gp-lab" }, "align"),
            h("select", { class: "gp-pos" },
                ["left", "center", "right"].map((v) =>
                    h("option", { value: v, selected: t.titleAlign === v }, v)))) : null,
        sizable ? h("label", { class: "flab" }, h("span", { class: "gp-lab" }, "width"),
            h("div", { class: "gp-size" },
                h("input", { type: "number", class: "gp-w", min: "1", step: "1", placeholder: autoPh("w"),
                    value: t.w > 0 ? Math.round(t.w) : "", title: "container width (blank = auto)" }),
                h("button", { class: "gp-auto", dataset: { axis: "w" }, title: "auto width" }, "auto"))) : null,
        sizable ? h("label", { class: "flab" }, h("span", { class: "gp-lab" }, "height"),
            h("div", { class: "gp-size" },
                h("input", { type: "number", class: "gp-h", min: "1", step: "1", placeholder: autoPh("h"),
                    value: t.h > 0 ? Math.round(t.h) : "", title: "container height (blank = auto)" }),
                h("button", { class: "gp-auto", dataset: { axis: "h" }, title: "auto height" }, "auto"))) : null,
        sub("style"),
        h("div", { class: "flab gp-scheme-row" }, h("span", { class: "gp-lab gp-lab-top" }, "scheme"), schemeGrid),
        // title bg + title text colours share one row, each behind a "bg:" / "text:" mini-label +
        // a "×" clear (super has no title bg, so it shows only the text colour)
        hasTitleColor ? h("label", { class: "flab" }, h("span", { class: "gp-lab" }, "title"),
            h("span", { class: "gp-mini" }, "text:"),
            h("input", { type: "color", class: "gp-tcolor", value: hex6(t.titleColor || "#d7dbe2"), title: "title text color" }),
            clearX("clear title text color", () => { t.titleColor = ""; syncAndCommit(); })) : null,
        // outline COLOUR tints the tier's rim/label; OFFSET grows/shrinks the box. Style + width are
        // driven by the restyle now, so they're no longer editable here.
        h("label", { class: "flab" }, h("span", { class: "gp-lab" }, "outline"),
            h("input", { type: "number", class: "gp-ooffset", step: "1", value: t.outline.offset ?? 0, title: "outline offset (px, +out/-in)" }),
            h("input", { type: "color", class: "gp-ocolor", value: hex6(t.outline.color), title: "outline color" })),
        hasShadow ? h("label", { class: "flab" }, h("span", { class: "gp-lab" }, "shadow"),
            h("div", { class: "gp-shadow" },
                h("input", { type: "number", class: "gp-shx", step: "1", value: t.shadow?.x ?? 0, title: "shadow offset-x (px)" }),
                h("input", { type: "number", class: "gp-shy", step: "1", value: t.shadow?.y ?? 0, title: "shadow offset-y (px)" }),
                h("input", { type: "number", class: "gp-shblur", min: "0", step: "1", value: t.shadow?.blur ?? 0, title: "shadow blur (px)" }),
                h("input", { type: "number", class: "gp-shspread", step: "1", value: t.shadow?.spread ?? 0, title: "shadow spread (px)" }),
                h("input", { type: "color", class: "gp-shcolor", value: hex6(t.shadow?.color || "#000000"), title: "shadow color" })),
            clearX("clear shadow (none)", () => { t.shadow = null; syncAndCommit(); })) : null,
        hasFill ? h("label", { class: "flab" }, h("span", { class: "gp-lab" }, "background"),
            h("input", { type: "range", class: "gp-bga", min: "0", max: "100", value: alphaPct(t.bg), title: "fill opacity" }),
            h("input", { type: "color", class: "gp-bg", value: hex6(t.bg), title: "fill color" }),
            clearX("clear fill (no background)", () => { t.bg = ""; syncAndCommit(); })) : null,
        h("div", { class: "gp-btns" },
            h("button", { class: "gp-reset" }, "reset"),
            h("button", { class: "gp-disband danger" }, disbandLabel)),
    ].filter(Boolean));
    pop.style.left = `${ev.clientX}px`; pop.style.top = `${ev.clientY + 8}px`;
    document.body.appendChild(pop);
    const M = 8, r = pop.getBoundingClientRect();
    pop.style.left = `${Math.max(M, Math.min(ev.clientX, window.innerWidth - r.width - M))}px`;
    pop.style.top = `${Math.max(M, Math.min(ev.clientY + 8, window.innerHeight - r.height - M))}px`;
    openPopover = { id, el: pop, ownerSel };

    const mkBg = (hex, pct) => (opaqueBg ? blendOnBg(hex, pct) : withAlpha(hex, pct));
    const sync = () => {
        const set = (sel, v) => { const el = pop.querySelector(sel); if (el) el.value = v; };
        set(".gp-bg", hex6(t.bg || "#1d2027")); set(".gp-bga", alphaPct(t.bg));
        set(".gp-ooffset", t.outline.offset ?? 0); set(".gp-ocolor", hex6(t.outline.color));
        set(".gp-tcolor", hex6(t.titleColor || "#d7dbe2"));
        set(".gp-shx", t.shadow?.x ?? 0); set(".gp-shy", t.shadow?.y ?? 0); set(".gp-shblur", t.shadow?.blur ?? 0);
        set(".gp-shspread", t.shadow?.spread ?? 0); set(".gp-shcolor", hex6(t.shadow?.color || "#000000"));
        if (hasAlign) set(".gp-pos", t.titleAlign);
        if (sizable) { set(".gp-w", t.w > 0 ? Math.round(t.w) : ""); set(".gp-h", t.h > 0 ? Math.round(t.h) : ""); }
    };
    const commit = () => { render(); ctx.persist(); mark(); };
    function mark() { markSchemeSel(pop, t); }
    // a clear-"×" resets a field to "" then resyncs the pickers + commits (like a scheme apply)
    function syncAndCommit() { sync(); commit(); }
    const editCommit = () => {
        const sch = schemeById(t.schemeId);
        if (sch && !isBuiltinScheme(sch)) {
            Object.assign(sch, currentToScheme(t, tier, sch.name));
            repaintLinked(sch, t);
            restyleSwatch(pop, sch.id);
        } else if (sch) {
            t.schemeId = null;   // edited away from a built-in -> no longer wears it
        }
        commit();
    };
    pop.querySelector(".gp-title").addEventListener("input", (e) => { t.title = e.target.value; commit(); });
    pop.querySelector(".gp-ooffset").addEventListener("input", (e) => { t.outline.offset = Math.round(+e.target.value || 0); editCommit(); });
    pop.querySelector(".gp-ocolor").addEventListener("input", (e) => { t.outline.color = e.target.value; editCommit(); });
    if (hasShadow) {
        const setShadow = (k, v) => { t.shadow = cloneShadow(t.shadow) || { x: 0, y: 0, blur: 0, spread: 0, color: "#000000" }; t.shadow[k] = v; editCommit(); };
        pop.querySelector(".gp-shx").addEventListener("input", (e) => setShadow("x", Math.round(+e.target.value || 0)));
        pop.querySelector(".gp-shy").addEventListener("input", (e) => setShadow("y", Math.round(+e.target.value || 0)));
        pop.querySelector(".gp-shblur").addEventListener("input", (e) => setShadow("blur", Math.max(0, Math.round(+e.target.value || 0))));
        pop.querySelector(".gp-shspread").addEventListener("input", (e) => setShadow("spread", Math.round(+e.target.value || 0)));
        pop.querySelector(".gp-shcolor").addEventListener("input", (e) => setShadow("color", e.target.value));
    }
    if (hasFill) {
        const applyBg = () => { t.bg = mkBg(pop.querySelector(".gp-bg").value, +pop.querySelector(".gp-bga").value); editCommit(); };
        pop.querySelector(".gp-bg").addEventListener("input", applyBg);
        pop.querySelector(".gp-bga").addEventListener("input", applyBg);
    }
    if (hasTitleColor) pop.querySelector(".gp-tcolor").addEventListener("input", (e) => { t.titleColor = e.target.value; editCommit(); });
    if (hasAlign) pop.querySelector(".gp-pos").addEventListener("change", (e) => { t.titleAlign = e.target.value; commit(); });
    if (sizable) {
        const wireSize = (inpSel, axis) => {
            const inp = pop.querySelector(inpSel);
            inp.addEventListener("change", () => { const v = +inp.value; t[axis] = v > 0 ? v : null; if (!(v > 0)) inp.value = ""; commit(); });
        };
        wireSize(".gp-w", "w");
        wireSize(".gp-h", "h");
        pop.querySelectorAll(".gp-auto").forEach((b) => b.addEventListener("click", () => {
            t[b.dataset.axis] = null;
            pop.querySelector(b.dataset.axis === "w" ? ".gp-w" : ".gp-h").value = "";
            commit();
        }));
    }
    renderSchemeGrid(schemeGrid, t, tier, sync, commit, mark, hasTitleBg, hasAlign);
    mark();
    pop.querySelector(".gp-reset").addEventListener("click", () => {
        t.outline = { offset: 0, ...defaults.outline };
        t.bg = defaults.bg;
        t.shadow = null;
        t.schemeId = null;
        if (hasTitleBg) t.titleBg = defaults.titleBg;
        t.titleColor = defaults.titleColor;
        if (hasAlign) t.titleAlign = defaults.titleAlign;
        sync(); commit();
    });
    pop.querySelector(".gp-disband").addEventListener("click", () => onDisband());
    setTimeout(() => document.addEventListener("mousedown", onOutside, true), 0);
}

function togglePopover(gid, ev) {
    const g = byId(gid);
    if (!g) return;
    openOptionsPopover(`group:${gid}`, g, ev, {
        ownerSel: ".ggroup-title", disbandLabel: "disband", opaqueBg: false, sizable: true, tier: "group",
        defaults: { outline: { color: DEF_OUTLINE, style: "none", width: 2 }, bg: DEF_BG, titleBg: "", titleColor: "", titleAlign: "left" },
        onDisband: () => disbandIn(GROUP, gid),
    });
}
function toggleSuperPopover(sid, ev) {
    const sg = sById(sid);
    if (!sg) return;
    if (tryCopyFrom(sg, "super")) { ev.preventDefault(); return; }
    openOptionsPopover(`super:${sid}`, sg, ev, {
        ownerSel: ".sgroup-cog", disbandLabel: "disband", opaqueBg: false, sizable: false, tier: "super",
        hasTitleBg: false, hasAlign: false, titleTextLabel: "label", render: renderSuperGroups,
        hasFill: true, hasTitleColor: true,   // P-A: fill (backdrop) + watermark colour still drive the look
        defaults: { outline: { color: SUPER_DEF_OUTLINE, style: "none", width: 2 }, bg: SUPER_DEF_BG, titleColor: "" },
        onDisband: () => disbandIn(SUPER, sid),
    });
}
function toggleSubPopover(sid, ev) {
    const sg = subById(sid);
    if (!sg) return;
    if (tryCopyFrom(sg, "subgroup")) { ev.preventDefault(); return; }
    openOptionsPopover(`subgroup:${sid}`, sg, ev, {
        ownerSel: ".subgroup-cog", disbandLabel: "disband", opaqueBg: true, tier: "subgroup",
        hasShadow: false,   // sub "sunken" look forces its own inset ring — user shadow would be clobbered
        defaults: { outline: { color: SUB_DEF_OUTLINE, style: "none", width: 1 }, bg: SUB_DEF_BG, titleBg: "", titleColor: "", titleAlign: "left" },
        onDisband: () => disbandIn(SUB, sid),
    });
}

// ---- persistence ----------------------------------------------------------
export function collect() {
    return groups.map((g) => {
        const o = {
            id: g.id, title: g.title, members: [...g.members],
            outline: { ...g.outline }, bg: g.bg, titleAlign: g.titleAlign,
            titleBg: g.titleBg, titleColor: g.titleColor,
        };
        if (g.w > 0) o.w = g.w;
        if (g.h > 0) o.h = g.h;
        if (g.shadow) o.shadow = cloneShadow(g.shadow);
        if (g.schemeId) o.schemeId = g.schemeId;
        return o;
    });
}
export function collectSuper() {
    return superGroups.map((sg) => ({ id: sg.id, title: sg.title, members: [...sg.members],
        outline: { ...sg.outline }, bg: sg.bg, titleColor: sg.titleColor,
        ...(sg.shadow ? { shadow: cloneShadow(sg.shadow) } : {}), ...(sg.schemeId ? { schemeId: sg.schemeId } : {}) }));
}
export function collectSub() {
    return subGroups.map((sg) => ({
        id: sg.id, parent: sg.parent, title: sg.title, members: [...sg.members],
        outline: { ...sg.outline }, bg: sg.bg, titleBg: sg.titleBg, titleColor: sg.titleColor, titleAlign: sg.titleAlign,
        ...(sg.shadow ? { shadow: cloneShadow(sg.shadow) } : {}), ...(sg.schemeId ? { schemeId: sg.schemeId } : {}),
    }));
}

// Records saved before the blueprint restyle wear the OLD tier defaults (greys tuned to the old,
// lighter board). Map those exact hexes onto the new defaults on load, so a pre-restyle profile picks
// up the new look; anything else (a colour the user actually chose) is left untouched. Scheme-linked
// records are re-resolved from their scheme (reapplyScheme) regardless, so this only bites the
// hand-coloured/default ones. Compared as #rrggbb so an old 8-digit (alpha) fill still matches.
const OLD_DEF = { gOutline: "#333333", gBg: "#191c21", sOutline: "#3a4154", sBg: "#1b1d23", subOutline: "#3a4154", subBg: "#191c23" };
const migColor = (v, oldHex, neu) => (!v || hex6(v) === oldHex) ? neu : v;
// The scheme is the source of truth: a record keeps its schemeId only while it faithfully wears that
// scheme (any manual edit detaches it — see editCommit), so re-deriving a still-linked record from
// its (possibly retuned) scheme on load never clobbers a deliberate tweak, and propagates retunes.
function reapplyScheme(rec, tierKey) { const s = schemeById(rec.schemeId); if (s) applySchemeTo(rec, s, tierKey); }

export function hydrate(arr) {
    closePopover();
    groups = (arr || []).map((g) => ({
        id: g.id,
        title: g.title || g.id,
        members: Array.isArray(g.members) ? [...g.members] : [],
        outline: { color: migColor(g.outline?.color, OLD_DEF.gOutline, DEF_OUTLINE), style: g.outline?.style || "solid", width: g.outline?.width || 2, offset: g.outline?.offset || 0 },
        bg: migColor(g.bg, OLD_DEF.gBg, DEF_BG),
        titleBg: g.titleBg || "",
        titleColor: g.titleColor || "",
        // Back-compat: map the old titlePos positions onto an alignment.
        titleAlign: g.titleAlign || ({ tl: "left", tc: "center", tr: "right", in: "left" }[g.titlePos]) || "left",
        w: g.w > 0 ? g.w : null,
        h: g.h > 0 ? g.h : null,
        shadow: cloneShadow(g.shadow),
        schemeId: g.schemeId || null,
    })).filter((g) => g.members.length);
    for (const g of groups) reapplyScheme(g, "group");   // scheme = source of truth (retunes propagate)
    seq = groups.reduce((m, g) => { const n = /^group_(\d+)$/.exec(g.id); return n ? Math.max(m, +n[1]) : m; }, 0);
    reconcileFollowers(GROUP);   // a saved layout may predate preview-follows-window — fix membership on load
}
export function hydrateSuper(arr) {
    closePopover();
    superGroups = (arr || []).map((sg) => ({
        id: sg.id, title: sg.title || sg.id,
        // back-compat: older saves stored the member group ids under `groups`
        members: Array.isArray(sg.members) ? [...sg.members] : (Array.isArray(sg.groups) ? [...sg.groups] : []),
        outline: { color: migColor(sg.outline?.color, OLD_DEF.sOutline, SUPER_DEF_OUTLINE), style: sg.outline?.style || "none", width: sg.outline?.width || 2, offset: sg.outline?.offset || 0 },
        bg: migColor(sg.bg, OLD_DEF.sBg, SUPER_DEF_BG), titleColor: sg.titleColor || "", shadow: cloneShadow(sg.shadow), schemeId: sg.schemeId || null,
    })).filter((sg) => sg.members.length);
    for (const sg of superGroups) reapplyScheme(sg, "super");
    sseq = superGroups.reduce((m, sg) => { const n = /^sgroup_(\d+)$/.exec(sg.id); return n ? Math.max(m, +n[1]) : m; }, 0);
    selectedGroups.clear();
}
export function hydrateSub(arr) {
    closePopover();
    subGroups = (arr || []).map((sg) => ({
        id: sg.id, parent: sg.parent, title: sg.title || "",
        members: Array.isArray(sg.members) ? [...sg.members] : [],
        outline: { color: migColor(sg.outline?.color, OLD_DEF.subOutline, SUB_DEF_OUTLINE), style: sg.outline?.style || "none", width: sg.outline?.width || 1, offset: sg.outline?.offset || 0 },
        bg: migColor(sg.bg, OLD_DEF.subBg, SUB_DEF_BG), titleBg: sg.titleBg || "", titleColor: sg.titleColor || "", titleAlign: sg.titleAlign || "left", shadow: cloneShadow(sg.shadow), schemeId: sg.schemeId || null,
    })).filter((sg) => sg.parent && sg.members.length);
    for (const sg of subGroups) reapplyScheme(sg, "subgroup");
    subseq = subGroups.reduce((m, sg) => { const n = /^subgroup_(\d+)$/.exec(sg.id); return n ? Math.max(m, +n[1]) : m; }, 0);
    reconcileSub();
}

export function clear() {
    closePopover();
    groups = []; superGroups = []; subGroups = [];
    seq = 0; sseq = 0; subseq = 0;
    selectedGroups.clear();
    renderGroups();
}
