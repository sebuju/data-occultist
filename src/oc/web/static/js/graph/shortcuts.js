// Keyboard shortcuts: the discrete grid-glide helper, arrow-key node/group navigation (hold to
// preview, release to pan), the Tab-trap inside a focus-selected node, and the ONE big GRAPH-scope
// handler (Escape/PageUp-Down/Enter/Delete/Shift+R/WASD move-resize/box-nudge). Split out of
// main.js; the cross-cutting mutable state (selectedNodeId/activeOverlayKey/wire) and the
// functions below stay in main and are imported back.
import * as groups from "./groups.js";
import {
    $, model, pos, nodeEls, view, selected, nodeSizes, collapsed, busy, overlays,
} from "./state.js";
import { GRID, snap } from "./dragresize.js";
import { drawEdges, flushEdges } from "./routing.js";
import { flashGuides } from "./guides.js";
import {
    viewportCenterWorld, panZoomTo, panZoomToRect, zoomStep, fitAllZoom,
} from "./camera.js";
import { centreMost, nearestInDir } from "./keynav.js";
import { drawLive, lockLive, clearNavArrow } from "./navarrow.js";
import { registerKey, SCOPE } from "../inputbus.js";
import { clearTools } from "./drawtool.js";
import { undo, redo } from "./history.js";
import { persist } from "./persist.js";
import { nodeIdOf, editBox, rectEditCanvasSync } from "./imaging.js";
import { WIDTH_ONLY_NODES, resetNodeAxis, nudgeAxisToGrid, markNodeSized, quantizeWidthOnlyHeight } from "./node_resize.js";
import {
    activeOverlayKey, selectedNodeId, nodeTypeOf, NUDGE,
    deselectAll, focusNode, selectionIds, deleteSelection, positionNode, autosave,
} from "./main.js";

// Briefly arm the grid-glide transition for a DISCRETE (keyboard) step. A grip drag holds
// `.snapping` across the whole drag (down..up); a WASD step has no down/up, so add the class and
// drop it once the ~90ms ease has run — re-pressing restarts the timer so a burst keeps gliding.
// Same class + transition as the drag path (rule 7). Timeout slightly > the transition duration.
const _snapTimers = new WeakMap();
function glideStep(el) {
    if (!el) return;
    el.classList.add("snapping");
    clearTimeout(_snapTimers.get(el));
    _snapTimers.set(el, setTimeout(() => el.classList.remove("snapping"), 140));
}

// ---- keyboard node-navigation (arrows pan, Enter selects, Tab traps inside a node) ----------
// Arrow keys walk the graph WITHOUT selecting: plain arrows step node-to-node, Shift+arrows step
// between top-level GROUPS (never sub/super groups). While one or more arrows are HELD a big arrow
// is drawn from the current anchor to the candidate target (the neighbour in the held direction);
// two arrows aim diagonally. The camera pans there once EVERY arrow is released. Pressing arrows
// again mid-pan does NOT stop it — it redirects to the next hop and STACKS another arrow (the prior
// hop's arrow stays, screen-fixed, as a breadcrumb) until the whole run settles and all clear.
// `navAnchor` is the nav cursor (node OR group id), distinct from the actual selection.
let navAnchor = null, navAnchorMode = false;   // cursor id + which mode it belongs to (false=node, true=group)
let navGroupMode = false;                       // the current chain's mode (fixed on its first held arrow)
let _lastEsc = 0;                 // performance.now() of the previous Escape (double-tap = fit-all)
const heldArrows = new Set();     // arrow keys currently down
let navTarget = null;             // the id the held arrows point at (panned to on release)
const ARROW = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };

// {id, centre} of every navigable item for the mode, and the world rect of one — node bodies for
// node-mode, top-level group boxes (groups.groupBoxes() excludes sub/super) for group-mode.
function navCentres(groupMode) {
    const out = [];
    if (groupMode) {
        for (const g of groups.groupBoxes()) out.push({ id: g.id, x: g.box.x + g.box.w / 2, y: g.box.y + g.box.h / 2 });
    } else {
        for (const [id, p] of pos) {
            const el = nodeEls.get(id);
            if (el) out.push({ id, x: p.x + el.offsetWidth / 2, y: p.y + el.offsetHeight / 2 });
        }
    }
    return out;
}
function nodeCentres() { return navCentres(false); }
function navRectOf(id, groupMode) {
    if (groupMode) { const g = groups.groupBoxes().find((b) => b.id === id); return g ? g.box : null; }
    const p = pos.get(id), el = nodeEls.get(id);
    return p && el ? { x: p.x, y: p.y, w: el.offsetWidth, h: el.offsetHeight } : null;
}
// The summed direction of the currently held arrows.
function heldDir() {
    let dx = 0, dy = 0;
    for (const k of heldArrows) { const v = ARROW[k]; dx += v[0]; dy += v[1]; }
    return [dx, dy];
}

// Recompute the candidate target for the held direction and (re)draw the LIVE preview arrow to it
// (leaving any locked breadcrumb arrows in place).
function updateNavPreview() {
    const [dx, dy] = heldDir();
    const gm = navGroupMode;
    const centres = navCentres(gm);
    if ((!dx && !dy) || !centres.length) { navTarget = null; drawLive(null); return; }
    // reuse the anchor only if it still exists in THIS mode's set; else seed from the centre-most item
    let anchorId = (navAnchor && navAnchorMode === gm && centres.some((c) => c.id === navAnchor)) ? navAnchor : null;
    if (!anchorId) { const c = viewportCenterWorld(); anchorId = centreMost(centres, c.x, c.y); }
    const from = centres.find((c) => c.id === anchorId);
    const next = from && nearestInDir(centres, from, dx, dy);
    navTarget = next || null;
    const to = next && centres.find((c) => c.id === next);
    if (from && to) drawLive({ x: from.x, y: from.y }, { x: to.x, y: to.y }, navColor(from.id, gm), navColor(to.id, gm));
    else drawLive(null);
}

// The colour to tint a nav arrow's end at a given item: a node's own tint (--nt, resolved), a
// group's outline/fill colour, or the accent as a fallback.
function navColor(id, groupMode) {
    if (groupMode) {
        const g = groups.allGroups().find((x) => x.id === id);   // raw record: outline/bg are colour strings
        return (g && (typeof g.outline === "string" && g.outline || g.bg)) || cssVarColor("--accent");
    }
    const el = nodeEls.get(id);
    const c = el && getComputedStyle(el).getPropertyValue("--nt").trim();
    return c || cssVarColor("--accent");
}
function cssVarColor(name) { return getComputedStyle(document.body).getPropertyValue(name).trim() || "#4da3ff"; }

// All arrows released: pan to the candidate (no selection). The live arrow LOCKS in place (so a
// mid-pan re-press stacks a new one over it); each locked arrow then dies on its OWN timer.
function commitNav() {
    const target = navTarget, gm = navGroupMode; navTarget = null;
    const rect = target && navRectOf(target, gm);
    if (rect) {
        navAnchor = target; navAnchorMode = gm;
        lockLive();                                            // this hop's arrow -> its own death timer
        panZoomToRect(rect, { fit: false });                   // redirects a pan already in flight (no stop)
    } else drawLive(null);
}

// Tab is trapped INSIDE the selected node: while a node is focus-selected (and no box overlay owns
// the keys), Tab / Shift+Tab cycle only its own focusable controls, wrapping at the ends, instead
// of walking out into the rest of the page. Own listener (capture) because the main keydown handler
// bails on focused inputs — Tab must keep working while a field inside the node has focus.
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
function nodeFocusables(el) {
    return [...el.querySelectorAll(FOCUSABLE)].filter((c) => c.offsetParent !== null && !c.closest("[inert]"));
}
// allowInField: Tab must keep cycling even while a field INSIDE the node has focus (the whole point of
// the trap), so it opts out of the registry's input-field bail. Consuming via return (preventDefault
// blocks native tabbing); GRAPH scope replaces the prettyActive bail.
registerKey({
    match: (ev) => ev.key === "Tab", scope: SCOPE.GRAPH, priority: 65, allowInField: true,
    when: () => !overlays.get(activeOverlayKey) && !!(selectedNodeId && nodeEls.get(selectedNodeId)),
    run: (ev) => {
        const el = nodeEls.get(selectedNodeId);
        const items = nodeFocusables(el);
        if (!items.length) { ev.preventDefault(); return true; }  // trap even with nothing to land on
        let i = items.indexOf(document.activeElement);
        if (i === -1) i = ev.shiftKey ? 0 : -1;              // focus outside the node -> enter at an end
        const next = (i + (ev.shiftKey ? -1 : 1) + items.length) % items.length;
        items[next].focus();
        ev.preventDefault(); return true;
    },
});

// Releasing arrows drives the node-nav pan. Commit on the FIRST release using the direction held up
// to that instant, then drop every remaining held key: a diagonal is two keys, and the user can't
// release both on the exact same tick — waiting for the last release would re-preview the lone
// still-held key and snap to its orthogonal neighbour instead of the diagonal target. Dropping the
// leftover keys also stops their auto-repeat from restarting a stray move (keydown guards on repeat).
document.addEventListener("keyup", (ev) => {
    if (!heldArrows.has(ev.key)) return;
    heldArrows.clear();
    commitNav();
});
window.addEventListener("blur", () => { if (heldArrows.size) { heldArrows.clear(); navTarget = null; clearNavArrow(); } });

// The graph view's global shortcut handler — Escape (3-stage), PageUp/Down zoom, Enter/Arrow node-nav,
// undo/redo, Delete, Shift+R, WASD move / Shift+WASD resize (node OR the live box overlay). Registered
// as ONE GRAPH-scope entry on the central input bus (inputbus.js) rather than its own document keydown:
// the three shared guards move OUT — scope=GRAPH replaces the `prettyActive` bail, the registry's
// input-field bail replaces the INPUT/SELECT/TEXTAREA check (now a superset: also contenteditable),
// and a focused `.tn-img-pv` preview (which owns WASD for its own element) yields via `when`. The branch
// logic below is otherwise unchanged. NUDGE (the shared dir map) is declared at module scope in main.
const MINB = 0.004;
registerKey({
    scope: SCOPE.GRAPH, priority: 20,
    when: () => !document.activeElement?.closest?.(".tn-img-pv"),
    run: (ev) => {
    // Escape: disarm a drawing tool first (a tool-input's own Escape is handled above — INPUT bails
    // first); else a single Esc clears the selection, and a double Esc (within 400ms) frames every
    // node (fit-all). navAnchor resets on fit-all so arrow-nav restarts from the centre.
    if (ev.key === "Escape") {
        if (clearTools()) { ev.preventDefault(); return; }
        const now = performance.now();
        if (now - _lastEsc < 400) { _lastEsc = 0; navAnchor = null; fitAllZoom(); ev.preventDefault(); return; }
        _lastEsc = now;
        if (selected.size || selectedNodeId || overlays.get(activeOverlayKey)) { deselectAll(); ev.preventDefault(); return; }
        return;
    }
    const plain = !ev.ctrlKey && !ev.metaKey && !ev.altKey;   // leave modified combos to the browser
    // PageUp/PageDown step the discrete zoom ladder around the viewport centre — active whenever
    // not typing (the INPUT bail above already guards that), regardless of selection.
    if (plain && (ev.key === "PageUp" || ev.key === "PageDown")) {
        zoomStep(ev.key === "PageUp" ? 1 : -1);
        ev.preventDefault(); return;
    }
    // Arrow keys + Enter navigate the node cloud, but ONLY when nothing is selected — a selected
    // node hands the keyboard to WASD-nudge + Tab. Arrows pan to the neighbouring node WITHOUT
    // selecting; Enter selects whichever node is centre-most to the camera.
    const navIdle = plain && !overlays.get(activeOverlayKey) && !selected.size && !selectedNodeId;
    if (navIdle && ev.key === "Enter") {
        const c = viewportCenterWorld();
        const anchor = centreMost(nodeCentres(), c.x, c.y);
        if (anchor) { navAnchor = anchor; navAnchorMode = false; focusNode(anchor); panZoomTo(anchor, { fit: true }); }
        ev.preventDefault(); return;
    }
    if (navIdle && ARROW[ev.key]) {
        if (!ev.repeat && !heldArrows.has(ev.key)) {
            if (heldArrows.size === 0) navGroupMode = ev.shiftKey;   // Shift held at chain start -> group nav
            heldArrows.add(ev.key); updateNavPreview();
        }
        ev.preventDefault(); return;
    }
    if (ev.ctrlKey || ev.metaKey) {
        const k = ev.key.toLowerCase();
        if (k === "z" && !ev.shiftKey) { ev.preventDefault(); undo(); return; }
        if (k === "y" || (k === "z" && ev.shiftKey)) { ev.preventDefault(); redo(); return; }
    }
    // (no group hotkey: the group/subgroup/super actions live only on the toolbar buttons — the
    // single-key semantics couldn't be pinned down across the three tiers.)
    // Delete: delete the selection (same path as the toolbar button; undo restores).
    // No arm needed — Ctrl+Z brings it back, and a key takes intent the way a stray click doesn't.
    if (ev.key === "Delete" && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
        if (!selectionIds().length) return;
        deleteSelection(); ev.preventDefault(); return;
    }
    // Shift+R: reset the manual size of the selection — wherever Shift+WASD can resize something,
    // Shift+R resets it back to its natural/auto box. Group-mode resets every ctrl-selected group's
    // explicit w/h back to auto-hugging its members (groups.js resetGroupSize, mirrors stepGroupSize
    // below); otherwise it resets every selected node's saved size (same as pressing its reset dots).
    if (ev.shiftKey && ev.key.toLowerCase() === "r" && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
        if (overlays.get(activeOverlayKey)) return;   // a live box overlay owns the keys
        const gids = groups.selectedGroupIds();
        if (gids.length) {
            let any = false;
            for (const gid of gids) if (groups.resetGroupSize(gid)) any = true;
            if (any) { groups.renderGroups(); flushEdges(); persist.layout(); }
            ev.preventDefault();
            return;
        }
        const selIds = selectionIds().filter((id) => nodeSizes.has(id) && !collapsed.has(id) && nodeEls.has(id));
        for (const id of selIds) {
            const div = nodeEls.get(id);
            const widthOnly = WIDTH_ONLY_NODES.has(nodeTypeOf(id));
            resetNodeAxis(div, id, "w", widthOnly);
            if (!widthOnly) resetNodeAxis(div, id, "h", false);
        }
        if (selIds.length) ev.preventDefault();
        return;
    }
    const dir = NUDGE[ev.key.toLowerCase()];
    if (!dir) return;
    // No active box but a node is selected → WASD moves the NODE one grid step;
    // Shift+WASD resizes it one grid step (A/D width, W/S height) — same grip the drag
    // handle drives, so it persists + redraws edges identically.
    const rec = overlays.get(activeOverlayKey);
    if (!rec) {
        if (ev.shiftKey && groups.selectedGroupIds().length) {
            // Shift+WASD RESIZES every ctrl-selected group's box one grid step (A/D width, W/S
            // height) — same explicit w/h + GROUP_MIN floor the resize GRIP drag writes
            // (groups.js stepGroupSize / node_resize.js startGroupResize).
            const gids = groups.selectedGroupIds();
            let any = false;
            for (const gid of gids) if (groups.stepGroupSize(gid, dir[0] * GRID, dir[1] * GRID)) any = true;
            if (any) { groups.renderGroups(); flushEdges(); persist.layout(); }
            ev.preventDefault();
        } else if (ev.shiftKey) {
            // Shift+WASD RESIZES every selected node one grid step (A/D width, W/S height) — same
            // grip the drag handle drives, so each persists + redraws edges identically. Collapsed
            // nodes (header-only) are skipped; widthOnly nodes (item/window) take width only.
            const stepResize = (id) => {
                const el = nodeEls.get(id);
                if (!el || collapsed.has(id)) return false;
                const prev = nodeSizes.get(id) || {};
                if (WIDTH_ONLY_NODES.has(nodeTypeOf(id))) {
                    // item/window wrap a fixed-aspect canvas -> HARD width only, height aspect-driven,
                    // so there's no height axis for W/S to drive — they used to just no-op (dead keys).
                    // Route them onto width by FUNCTION instead: W (shrink-height, dir=[0,-1]) acts
                    // like A (shrink-width), S (grow-height, dir=[0,1]) acts like D (grow-width) — dir[0]
                    // and dir[1] are never both nonzero for one key, and their signs already agree
                    // (-1=shrink, +1=grow) with A/D, so `dir[0] || dir[1]` is the width delta for all 4 keys.
                    const wd = dir[0] || dir[1];
                    if (wd) { el.style.minWidth = ""; el.style.width = `${Math.max(GRID, snap(el.offsetWidth + wd * GRID))}px`; quantizeWidthOnlyHeight(el, id); }
                    nodeSizes.set(id, { w: el.offsetWidth, h: el.offsetHeight, softW: false, softH: false, custW: !!wd || !!prev.custW, custH: false });
                } else {
                    // re-apply through the SAME soft-grow/hard-shrink primitive the drag uses — a raw
                    // style.width set is blocked by a prior grow's min-width and silently no-ops.
                    let softW = prev.softW, softH = prev.softH;
                    if (dir[0]) softW = nudgeAxisToGrid(el, "w", Math.max(GRID, snap(el.offsetWidth + dir[0] * GRID)));
                    if (dir[1]) softH = nudgeAxisToGrid(el, "h", Math.max(GRID, snap(el.offsetHeight + dir[1] * GRID)));
                    // only the nudged axis becomes customized (reveals its reset per-axis)
                    nodeSizes.set(id, { w: el.offsetWidth, h: el.offsetHeight, softW, softH, custW: !!dir[0] || !!prev.custW, custH: !!dir[1] || !!prev.custH });
                }
                markNodeSized(el, id);
                return true;
            };
            const selIds = selectionIds().filter((id) => pos.has(id));
            if (selIds.length) {
                let any = false;
                for (const id of selIds) if (stepResize(id)) any = true;
                if (any) {
                    // resize is instant (no glide) → the box is already at its final size, so route +
                    // persist right away; no freeze/settle wait needed.
                    flushEdges();
                    groups.renderGroups();
                    persist.layout();
                    flashGuides(selIds);   // show what the resized node(s) now line up with, then fade
                }
                ev.preventDefault();
            }
        } else {
            // WASD MOVES the whole selection one grid step (every selected node, not just the focus),
            // mirroring how a multi-select drag moves the set. selectionIds() = the multi-select set
            // if any, else the single focused node. When one or more GROUPS are ctrl-selected instead
            // (group-mode — ctrl_select.js), move every member node of every selected group together,
            // same set a multi-group title drag moves (groups.js onTitlePress).
            const gids = groups.selectedGroupIds();
            const selIds = gids.length
                ? [...new Set(gids.flatMap((id) => groups.groupMembers(id)))].filter((id) => pos.has(id))
                : selectionIds().filter((id) => pos.has(id));
            if (selIds.length) {
                for (const id of selIds) {
                    const p = pos.get(id);
                    p.x = snap(p.x + dir[0] * GRID); p.y = snap(p.y + dir[1] * GRID);
                    const el = nodeEls.get(id); if (el) glideStep(el);
                    positionNode(id);
                }
                drawEdges(); groups.renderGroups(); persist.layout();
                flashGuides(selIds);   // show what the moved node(s) now line up with, then fade
                ev.preventDefault();
            }
        }
        return;
    }
    // Otherwise operate on whichever overlay holds the live box selection (window OR item).
    const ov = rec.overlay;
    const b = ov.boxes.find((x) => x.id === ov.activeId);
    if (!b || b.locked) return;   // a locked box (calibrated scrollbar) never nudges
    // Mouse-driven box edits are already blocked while the owning node is busy (the canvas lives
    // inside .gn-body, which CSS locks via pointer-events:none — see .gnode.busy). WASD bypasses
    // that entirely (it's a document keydown, no pointer event involved), so it needs its OWN
    // check here — otherwise a rect on a loading window/item could still be nudged by keyboard.
    const busyId = rec.kind === "window" ? nodeIdOf(rec.winId)
        : rec.kind === "item" ? `item:${rec.winId}:${rec.itemId}`
        : rec.kind === "atlas" ? "atlas" : null;
    if (busyId && busy.get(busyId)) return;
    // step exactly ONE image-native pixel. Use the IMAGE's natural size, NOT canvas.width — the
    // canvas backing is supersampled (up to 8× when zoomed in), so keying off it made a press move
    // a fraction of a pixel that shrank further the more you zoomed, reading as "WASD does nothing".
    const iw = ov.img?.naturalWidth || ov.canvas.width || 1000;
    const ih = ov.img?.naturalHeight || ov.canvas.height || 1000;
    const sx = 1 / iw, sy = 1 / ih;
    if (ev.shiftKey) {
        b.w = Math.min(Math.max(MINB, b.w + dir[0] * sx), 1 - b.x);
        b.h = Math.min(Math.max(MINB, b.h + dir[1] * sy), 1 - b.y);
    } else {
        b.x = Math.min(Math.max(0, b.x + dir[0] * sx), 1 - b.w);
        b.y = Math.min(Math.max(0, b.y + dir[1] * sy), 1 - b.h);
    }
    ov.render();        // reflect the nudge on the overlay immediately
    // A nudge only PAINTS: it joins this surface's rect batch and settles on Enter / ✓ / clicking
    // out (edit_txn.js). Holding W for a second is then one model write, one save, one re-OCR and
    // one undo step — not thirty. The atlas surface has no batch (nothing to re-read), so it keeps
    // writing straight through.
    if (rec.kind === "window" || rec.kind === "item") editBox(activeOverlayKey, b);
    else {
        rec.persist(b); rec.refresh();
        drawEdges(); autosave(rec.winId);
        rectEditCanvasSync(activeOverlayKey);
    }
    ev.preventDefault();
    },
});
