// Node sizing: the grid-snap resize primitives (soft-grow / hard-shrink per axis), the shared
// resize-grip opts builder, the reset-to-natural-box helpers, and the ResizeObserver wrapper that
// keeps edges glued to a node without ever snapping/settling itself. Split out of main.js;
// `positionNode` and `nodeTypeOf` stay in main and are imported back.
import { pos, nodeEls, nodeSizes, collapsed, view, boot } from "./state.js";
import { observeResize } from "../dom.js";
import { snap, snapUp, addResizeGrips, showSizeHud, hideSizeHud } from "./dragresize.js";
import { drawEdges, requestEdges, flushEdges, setDraggingNodes } from "./routing.js";
import * as groups from "./groups.js";
import { persist } from "./persist.js";
import { cancelPan } from "./camera.js";
import { positionNode, nodeTypeOf } from "./main.js";
import { showGuides, flashGuides } from "./guides.js";

// Host node types that resize at the NODE level (their body fills them) — one consistent
// behaviour. Used by the initial build AND by rebuildNode to re-attach grips.
// Every node is freely resizable (width + height) EXCEPT item/window/atlas, which resize
// width-only (their height follows a fixed-aspect canvas). `game`'s body is plain text/list
// content with no canvas — it resizes both axes like any other content node.
export const WIDTH_ONLY_NODES = new Set(["item", "window", "atlas"]);

// Width-only nodes wrap a fixed-aspect canvas: their box height is canvas-aspect-driven
// (bodyWidth / imageAspect + chrome) and lands off the 20px grid, floating the bottom edge out
// of alignment with every other node. The canvas aspect is locked to the image's true pixels
// (never pad it — that distorts the image), so instead floor the BOX up to the next grid line
// with a min-height: extra space falls below the content, the canvas keeps its aspect. Clear-
// then-measure exposes the natural (unfloored) box; only raise (target > nat), never shrink, so
// this is idempotent — once floored, offsetHeight is already a grid multiple and snapUp(nat) ===
// nat, so a later pass writes nothing (no observer feedback loop).
export function quantizeWidthOnlyHeight(el, id) {
    if (!el) return;
    if (collapsed.has(id)) { el.style.minHeight = ""; return; }   // header-only CSS owns collapsed height
    el.style.minHeight = "";                                      // expose the natural (aspect-driven) box
    const nat = el.offsetHeight;
    const target = snapUp(nat);
    if (target > nat) el.style.minHeight = `${target}px`;
}

// Size a freely-resizable node to a grid target (w×h) WITHOUT a hard width/height where it can be
// avoided. GROW (target ≥ natural box): a soft `min-width`/`min-height` opens the box out to the
// grid line — the content keeps its natural size and the flex body fills the extra room (breathing
// space), so nothing is locked to a stamped pixel box. SHRINK (target < natural): the content can't
// be squeezed, so set a hard width/height and the flex body SCROLLS (never clips). Clears any prior
// inline size first so the natural box (CSS min-width respected) is what's measured. After it runs,
// offsetWidth/Height land on the grid, so snapResize's live-snap sees no gap and doesn't fight it.
// Soft-grow / hard-shrink for ONE axis. Caller must have already cleared THIS axis's inline
// size + min so `el.offset*` reads the natural box. GROW (target ≥ natural) -> soft min (content
// fills the extra room); SHRINK -> hard size (body scrolls). Returns true=soft, false=hard.
// The single primitive both the drag-settle (settleAxis) and keyboard nudge build on (rule 7).
function sizeAxisToGrid(el, axis, target) {
    const nat = axis === "w" ? el.offsetWidth : el.offsetHeight;   // natural (this axis already cleared)
    if (target >= nat) { el.style[axis === "w" ? "minWidth" : "minHeight"] = `${target}px`; return true; }
    el.style[axis === "w" ? "width" : "height"] = `${target}px`; return false;
}
// Settle ONE axis on grip release: clear the axis to expose its natural (grid-fit) size, then only
// STAMP a size when the target DIFFERS from it, reusing sizeAxisToGrid for the grow(min)/shrink(hard)
// decision. Landing exactly on natural leaves the axis UNSTAMPED: nothing to record, nothing to
// reset, so a drag back to the fit size is as if the axis was never sized. Returns { size, soft, cust }.
function settleAxis(el, axis, target) {
    el.style[axis === "w" ? "width" : "height"] = ""; el.style[axis === "w" ? "minWidth" : "minHeight"] = "";
    const nat = snapUp(axis === "w" ? el.offsetWidth : el.offsetHeight);   // grid-fit size at content
    if (target === nat) return { size: nat, soft: true, cust: false };     // exactly natural -> leave cleared
    return { size: target, soft: sizeAxisToGrid(el, axis, target), cust: true };
}
// Settle both axes (targets captured BEFORE any clear — clearing width reflows height).
function settleGridSize(el, wTarget, hTarget) {
    return { w: settleAxis(el, "w", wTarget), h: settleAxis(el, "h", hTarget) };
}
// One-axis keyboard nudge: clear THIS axis (so the natural box is re-measured) WITHOUT touching
// the other axis, then re-apply through the same soft/hard rule. A naive style.width set silently
// no-ops when a prior grow left a min-width ≥ the target — clearing it first is the whole fix.
export function nudgeAxisToGrid(el, axis, target) {
    if (axis === "w") { el.style.width = ""; el.style.minWidth = ""; }
    else { el.style.height = ""; el.style.minHeight = ""; }
    return sizeAxisToGrid(el, axis, target);
}
// Re-apply a size decision recorded by settleAxis/resetNodeAxis WITHOUT re-measuring the natural box.
// Restore must be deterministic: re-measuring (as the settle path does) can drift a hair (scrollbar /
// font reflow) and flip a soft-grow dim into the hard-shrink branch — which is exactly what left a
// reset source node hard-sized + scrollable after a later full render() / page reload. `soft*` !==
// false means a min (grow, content always fits); false means a hard size (shrink, body scrolls).
export function applySavedSize(el, s) {
    clearGridSize(el);
    // only re-stamp an axis the user actually customized — a natural axis (custW/H === false) stays
    // unstamped so it flows to content, matching what onSettle stored. Legacy entries lack the flags
    // (undefined) -> stamp, preserving old behaviour.
    if (s.w && s.custW !== false) { if (s.softW !== false) el.style.minWidth = `${s.w}px`; else el.style.width = `${s.w}px`; }
    if (s.h && s.custH !== false) { if (s.softH !== false) el.style.minHeight = `${s.h}px`; else el.style.height = `${s.h}px`; }
}
// drop all inline grid sizing (back to the natural box: CSS width + content height)
function clearGridSize(el) { el.style.width = ""; el.style.height = ""; el.style.minWidth = ""; el.style.minHeight = ""; }
// A trigger's history satellite (`hist:<id>`) shows session-only data (trigger_history.py's ring
// is wiped on restart) — its height is otherwise content-driven (custH:false), so a just-reloaded,
// still-empty panel collapses to the .hist-host CSS floor (120px) even though it was resized taller
// last session. Dataset/subset vt-table satellites persist their rows, so their content-driven
// height is trustworthy and must NOT get this floor.
const isTransientSatellite = (id) => id.startsWith("hist:") || id.startsWith("rohist:") || id.startsWith("prodhist:");
// Stamp a min-height floor from the LAST saved height on a transient satellite whose height was
// never explicitly customized (custH:false) — applySavedSize leaves that axis unstamped (by
// design, for content-driven nodes), so without this the node shows its true saved size only until
// content empties it out. custH:true nodes are already handled by applySavedSize; left alone here.
function applySatelliteHeightFloor(el, id, s) {
    if (s?.h && s.custH === false && isTransientSatellite(id)) el.style.minHeight = `${s.h}px`;
}
// The box size that fits the node's content with NO scroll in EITHER axis. offsetWidth/Height alone
// isn't enough: the body clips wide content into a HORIZONTAL scroll (the node's CSS width is fixed,
// so content wider than it overflows rather than widening the box). Add back whatever the body can't
// currently show, so a reset can size the node to actually contain its content.
function naturalBox(el) {
    const body = el.querySelector(".gn-body");
    const hOver = body ? Math.max(0, body.scrollWidth - body.clientWidth) : 0;
    const vOver = body ? Math.max(0, body.scrollHeight - body.clientHeight) : 0;
    return { w: el.offsetWidth + hOver, h: el.offsetHeight + vOver };
}

// Resize-handle opts shared by the initial build and every in-place rebuild. The grips live
// inside the node's DOM, so a rebuildNode() (which replaces the node's children via fillNode)
// WIPES them — they must be re-added with these same opts or the node stops resizing.
// `widthOnly`: item + window nodes wrap a FIXED-ASPECT canvas (cutout / captured image), so
// they resize by WIDTH only — height follows the image aspect. Same primitive, one flag; never
// a separate resize path (their size persists through nodeSizes like every other node).
export function nodeResizeOpts(div, id, { widthOnly = false } = {}) {
    return {
        both: !widthOnly,
        zoom: () => view.zoom,
        // left-edge accessor: the node's world x lives in `pos` (canvas-zoomed) — lets the
        // shared bottom-left grip resize this node leftward with its right edge anchored
        left: (v) => { const p = pos.get(id); if (v === undefined) return p ? p.x : 0; if (p) { p.x = v; positionNode(id); } },
        // A resize moves a node's geometry exactly like a drag does, so it MUST get the SAME line
        // treatment — freeze the routed paths (greying any whose endpoint floats off the resized
        // edge) and re-route ONCE on settle — not a live A* reroute every frame (the forked path
        // that made resize wiggle differently from a drag). These callbacks fire ONLY from the grip
        // loop (a real user drag); a programmatic resize (reset/refit) never enters this path, and the
        // node-level ResizeObserver (snapResize) only repaints edges — it never freezes or snaps.
        // resize START: freeze the CURRENT rendered size (which may be held by a soft min) into a
        // hard px box, THEN drop the mins. Capturing the size before clearing the mins is the whole
        // point — clear-then-measure would already have collapsed the node to content. This makes the
        // drag start exactly where the node sits, so it no longer jumps + desyncs from the cursor.
        onResizeStart: () => {
            const w = div.offsetWidth, h = div.offsetHeight;
            div.style.minWidth = ""; div.style.minHeight = "";
            div.style.width = `${w}px`;
            if (!widthOnly) div.style.height = `${h}px`;
            // freeze line routing for THIS node up front — exactly like a node drag does at its start
            // (moveNodes -> setDraggingNodes). Doing it here, not lazily in onResize, means the very
            // first redraw greys this node's out-edges before the pointer has moved (rule 7: same as drag).
            setDraggingNodes(true, [id]); requestEdges();
            // The live drag is SMOOTH (no grid step, no glide) — easing width/height while the pointer
            // drags the grip makes the dragged edge lag the cursor (felt like the resize "resisted").
            // Grid snap happens exactly once, on release (onSettle). WASD/move keep their glide.
        },
        // Fires only from the grip loop (a live user drag). Keep the soft grid mins cleared so a
        // prior grow's min-width/height can't block a shrink, and freeze routing like a node drag.
        // Runs INSIDE the grip loop's coalesced frame (one per animation frame), so this body does
        // not defer again — it would only push the group/guide pass a frame further behind the size.
        // The min-clears are guarded: re-writing "" every frame would re-dirty layout for nothing.
        onResize: () => {
            if (div.style.minWidth) div.style.minWidth = "";
            if (div.style.minHeight) div.style.minHeight = "";
            setDraggingNodes(true, [id]); requestEdges(); groups.renderGroups(); showGuides([id]);
        },
        // Settle to the grid, but only KEEP a size on an axis that ends up different from its natural
        // (grid-fit) box — an axis dragged back to natural is left unstamped and un-customized, so it
        // has nothing to reset; a node natural on BOTH axes drops its entry entirely (as if never sized).
        // widthOnly nodes (item/window) wrap a fixed-aspect canvas — width only, height aspect-driven.
        // The grip loop fires this ONCE on release (passing {w,h} moved flags we don't need — it
        // settles both axes idempotently regardless).
        onSettle: () => {   // addResizeGrips has already flushed the pending drag frame
            if (widthOnly) {
                const wTarget = snapUp(div.offsetWidth);   // quantize to the grid once, on release
                div.style.width = ""; div.style.minWidth = "";
                const natW = div.offsetWidth;
                if (Math.abs(wTarget - natW) < 1) { nodeSizes.delete(id); quantizeWidthOnlyHeight(div, id); }   // back at natural -> unstamped
                else {
                    div.style.width = `${wTarget}px`;
                    quantizeWidthOnlyHeight(div, id);   // width just settled -> floor the aspect-driven height to the grid
                    nodeSizes.set(id, { w: wTarget, h: div.offsetHeight, softW: false, softH: false, custW: true, custH: false });
                }
            } else {
                const { w, h } = settleGridSize(div, snapUp(div.offsetWidth), snapUp(div.offsetHeight));
                if (w.cust || h.cust) nodeSizes.set(id, { w: w.size, h: h.size, softW: w.soft, softH: h.soft, custW: w.cust, custH: h.cust });
                else nodeSizes.delete(id);   // natural on both axes -> as if never sized
            }
            setDraggingNodes(false); flushEdges(); groups.renderGroups(); persist.layout();
            flashGuides([id]);   // keep the resting alignment/spacing shown briefly, then fade
        },
        // Resetting a size is no longer a grip concern — the corner carets are gone. The seltoolbar's
        // "reset size" button drives resetSelectionSize() below instead.
    };
}

// Reset ONE axis of a node back to its content-fitting, grid-snapped soft min (see resetSelectionSize).
// Clears only that axis's inline sizing so the other axis keeps the user's size, then merges the new
// dim into the recorded nodeSizes so a later render()/reload restores it deterministically.
function resetNodeAxis(div, id, axis, widthOnly) {
    // A register's body is a square-slot memory bank — resetting it means "make the grid as square
    // as possible", not "fit the content column". Both dots (and the shift-both) resize BOTH axes to
    // the square box; the per-axis branch below never runs for it.
    if (nodeTypeOf(id) === "register") { resetRegisterSquare(div, id); return; }
    if (axis === "w") { div.style.width = ""; div.style.minWidth = ""; }
    else { div.style.height = ""; div.style.minHeight = ""; }
    const nb = naturalBox(div);   // size to CONTENT (incl. overflow), not the clipped box
    const s = nodeSizes.get(id) || {};
    if (axis === "w") {
        const w = snapUp(nb.w);
        div.style.minWidth = `${w}px`;
        if (widthOnly) { div.style.width = `${w}px`; quantizeWidthOnlyHeight(div, id); }   // item/window keep a hard inline width; floor height to the grid
        s.w = w; s.softW = true; s.custW = false;   // back at natural -> nothing left to reset (hide the dot)
    } else {
        const h = snapUp(nb.h);
        div.style.minHeight = `${h}px`;
        s.h = h; s.softH = true; s.custH = false;   // soft min (grow to grid) -> restore re-applies as min, never hard
    }
    nodeSizes.set(id, s);
    drawEdges(); groups.renderGroups(); persist.layout();
}

// Reset a register node to the size where its square-slot bank tiles as close to a SQUARE as its
// slot count allows: cols = ceil(sqrt(N)) so the grid is a touch wider than tall and any leftover
// (N not a perfect rectangle) falls to the bottom row as empty space (never a ragged right edge).
// The membank's layout() then reflows to exactly `cols` columns for this box. Cell size = the slots'
// current rendered size, so a reset re-tiles them without rescaling. Sets BOTH axes hard so it
// persists across render/reload (register width is otherwise CSS-fixed at 220px).
function resetRegisterSquare(div, id) {
    const host = div.querySelector(".data-host");
    const grid = host?.querySelector(".membank");
    const N = grid ? grid.children.length : 0;
    if (!host || !N) { div.style.width = ""; div.style.height = ""; div.style.minWidth = ""; div.style.minHeight = ""; return; }
    const gap = 4;
    const cell = grid.children[0].offsetWidth || 4.6 * 16;   // slots are square (aspect-ratio 1/1)
    const cols = Math.max(1, Math.ceil(Math.sqrt(N)));
    const rows = Math.ceil(N / cols);
    const chromeW = div.offsetWidth - host.clientWidth;      // header/ports/footer + paddings + border
    const chromeH = div.offsetHeight - host.clientHeight;
    const w = snapUp(cols * cell + (cols - 1) * gap + chromeW);
    const h = snapUp(rows * cell + (rows - 1) * gap + chromeH);
    div.style.minWidth = ""; div.style.minHeight = "";
    div.style.width = `${w}px`; div.style.height = `${h}px`;
    nodeSizes.set(id, { w, h, softW: false, softH: false, custW: true, custH: true });
    drawEdges(); groups.renderGroups(); persist.layout();
}

// Which of `ids` actually carry a user-set size a reset would undo. The ONE rule behind both the
// seltoolbar's reset-size button (whether to show it) and what a reset then acts on — so the button
// can never appear with nothing to do, and never hide while something is resettable.
// The custW/custH test is what the old per-axis reset carets gated on (.rz-has-w / .rz-has-h): a
// nodeSizes ENTRY is not the same as a custom SIZE — resetNodeAxis leaves the entry behind with its
// flags cleared, and a merely-present entry would otherwise show a button that resets nothing and
// never goes away. Legacy entries predate the flags (undefined) -> treated as set, as they were then.
export function resettableSizeIds(ids) {
    return ids.filter((id) => {
        if (!nodeEls.has(id) || collapsed.has(id)) return false;
        const s = nodeSizes.get(id);
        return !!s && (s.custW !== false || s.custH !== false);
    });
}
// Reset every sized node in `ids` back to its content-fitting, grid-snapped box. The ONE
// implementation behind the seltoolbar button AND the keyboard shortcut (rule 7) — they used to
// carry their own copy of this loop. widthOnly nodes (item/window) have an aspect-driven height
// that is never stamped inline, so only their width resets. Returns the ids it actually touched.
export function resetSelectionSize(ids) {
    const hit = resettableSizeIds(ids);
    for (const id of hit) {
        const div = nodeEls.get(id);
        const widthOnly = WIDTH_ONLY_NODES.has(nodeTypeOf(id));
        resetNodeAxis(div, id, "w", widthOnly);
        if (!widthOnly) resetNodeAxis(div, id, "h", false);
    }
    return hit;
}

// Make a node user-resizable: restore its saved size, then attach the grips (NODE itself, its
// body fills it). Restores + persists through nodeSizes — grid-snapped on release — so a
// rebuild, RENAME (render() destroys + rebuilds; movePos carries nodeSizes to the new id), or
// reload all keep the user's size. `widthOnly` (item/window) restores width only; height is
// aspect-driven, so it's never stamped inline.
export function makeNodeResizable(div, id, { widthOnly = false } = {}) {
    const s = nodeSizes.get(id);
    // a collapsed node is header-only (CSS) — never stamp its saved w/h, or it beats the collapsed
    // CSS and renders full-height while "collapsed". widthOnly nodes (item/window) keep a hard inline
    // width (their height is aspect-driven); every other node restores its saved size via the RECORDED
    // soft/hard decision (applySavedSize), NOT by re-measuring — re-measuring can drift a soft-grow
    // dim into a hard-shrink one, which scrolled a reset node after a render/reload (the repeat bug).
    if (s && !collapsed.has(id)) {
        if (widthOnly) { if (s.w && s.custW !== false) div.style.width = `${s.w}px`; }
        else { applySavedSize(div, s); applySatelliteHeightFloor(div, id, s); }
    }
    snapResize(div, nodeResizeOpts(div, id, { widthOnly }));
}

// Re-apply saved node SIZES to already-rendered nodes — render() re-applies position every pass
// but size is stamped only at buildNode, so an undo/redo (which rewrites `nodeSizes` via
// hydrateNodeLayout) wouldn't otherwise resize a REUSED node. Clears the inline size first so a
// node that's now natural (no saved size in the restored snapshot) resets to content size. Mirrors
// makeNodeResizable's restore branch exactly (widthOnly nodes stamp width only).
export function reapplyNodeSizes() {
    for (const [id, el] of nodeEls) {
        el.style.width = ""; el.style.height = ""; el.style.minWidth = ""; el.style.minHeight = "";
        const s = nodeSizes.get(id);
        if (s && !collapsed.has(id)) {
            if (WIDTH_ONLY_NODES.has(nodeTypeOf(id))) { if (s.w && s.custW !== false) el.style.width = `${s.w}px`; }
            else { applySavedSize(el, s); applySatelliteHeightFloor(el, id, s); }
        }
    }
}

// Make a node resizable. The grip loop (dragresize.js) is the SOLE resize authority: it resizes
// SMOOTHLY during the drag and quantizes to the grid exactly ONCE, on release, via `opts.onSettle`
// — which also fires when the cursor is released off the grip (its mouseup is document-level). The
// ResizeObserver here does NOT snap or settle; its only job is to keep edges glued to the node when
// its box changes for reasons OTHER than a grip drag (image load, content reflow, an input losing
// focus). Snapping from an observer was the old jump-on-unfocus bug — a ResizeObserver can't tell a
// user grip-drag from an incidental reflow, so it must never write size or settle.
export function snapResize(el, opts = {}) {
    // reflow (image load / content) -> edges follow AND boxes re-hug the node's new size; never snaps.
    // Skipped during boot: every window's image load + content mount fires this on all N nodes behind
    // the veil, and renderGroups reads each member's rect -> N * (30 forced layouts) of pure thrash for
    // a screen nobody sees. finishBoot() runs the ONE real edge+group pass when the veil drops.
    // NEVER quantize/write a size from in here: writing min-height in response to a resize the write
    // itself just caused is a self-triggering ResizeObserver loop (clear -> shrinks the box -> observer
    // fires -> set -> grows the box back -> observer fires -> ad infinitum). Width-only nodes get their
    // height floored to the grid only from deliberate, one-shot call sites (grip onSettle, axis reset,
    // WASD nudge, and the img.onload aspect stamp in imaging.js) — never from this passive observer.
    observeResize(el, () => { if (boot.phase) return; requestEdges(); groups.renderGroups(); }, { gate: true });
    addResizeGrips(el, opts);   // custom grips on BOTH bottom corners; they own snap-on-release
}

// ---- group resize: resize the group's CONTAINER box (sets explicit w/h) -----
// Dragging the bottom-right grip resizes the group box itself, NOT its members: it writes an
// explicit g.w / g.h (grid-stepped) that groupBox() honours instead of auto-hugging the members.
// The box's top-left stays pinned to the members, so the grip grows the box down + right from
// there. Both axes can later be cleared back to "auto" via Shift+R / stepped via Shift+WASD
// (shortcuts.js) or the settings panel — GROUP_MIN + the explicit-size fields are owned by
// groups.js (one size concept, several input paths — rule 7).
export function startGroupResize(gid, ev) {
    ev.preventDefault(); ev.stopPropagation();
    const g = groups.allGroups().find((x) => x.id === gid);
    if (!g) return;
    const gb = groups.groupBoxes().find((b) => b.id === gid);
    if (!gb) return;
    const w0 = gb.box.w, h0 = gb.box.h, z = view.zoom, start = { x: ev.clientX, y: ev.clientY };
    cancelPan();
    let lw = w0, lh = h0;
    const onMove = (e) => {
        const dx = (e.clientX - start.x) / z, dy = (e.clientY - start.y) / z;   // drag the bottom-right outward
        lw = Math.max(groups.GROUP_MIN, snap(w0 + dx));
        lh = Math.max(groups.GROUP_MIN, snap(h0 + dy));
        g.w = lw; g.h = lh;
        groups.renderGroups();
        requestEdges();   // box changed -> gates + the group's hard obstacle moved: re-path (coalesced 1/frame)
        showSizeHud(lw, lh, e.clientX, e.clientY);
    };
    const onUp = () => {
        document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp);
        hideSizeHud(); flushEdges(); persist.layout();   // final clean re-path on settle (persist.layout records the undo snapshot)
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
}
