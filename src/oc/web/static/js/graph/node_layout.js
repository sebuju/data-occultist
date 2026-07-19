// Node placement: where a freshly-created or newly-shown node lands (measure-then-place,
// group inheritance, satellite parking), the free-space bookkeeping render() uses to seat
// unpositioned nodes, and the node-drag loop (single/shift-subtree/multi-select). Split out of
// main.js; buildNode/positionNode/render/renderNodeViews stay in main and are imported back.
import { $, model, pos, nodeEls, selected, view } from "./state.js";
import { snap, beginDrag, suppressNextClick } from "./dragresize.js";
import { requestEdges, flushEdges, setDraggingNodes, nodeRect } from "./routing.js";
import { showGuides, flashGuides } from "./guides.js";
import { viewportCenterWorld, resizeCanvas } from "./camera.js";
import { persist } from "./persist.js";
import * as groups from "./groups.js";
import { setStatus, nh } from "./state.js";
import { renderNodeViews } from "./panels/nodemap.js";
import { buildNode, positionNode, render } from "./main.js";

function elForPos(id) {
    return nodeEls.get(id);   // everything is a node now (image/preview/data/batches all in-node)
}

export function ensurePositions() {
    // stack new nodes below the actual bottom of existing nodes AND panels in the same
    // column (panels are tall), so a new node never lands behind one.
    const colBottom = {};
    for (const [id, p] of pos) {
        if (!Number.isFinite(p.x)) continue;
        const k = Math.round(p.x);
        const h = (elForPos(id)?.offsetHeight) || 140;
        colBottom[k] = Math.max(colBottom[k] || 20, p.y + h + 18);
    }
    for (const n of model.nodes()) {
        if (pos.has(n.id)) continue;
        const x = COLX[n.type] ?? 300;
        const y = colBottom[x] || 20;
        pos.set(n.id, { x, y });
        colBottom[x] = y + 150 + 18;   // estimate height for the next one (not in DOM yet)
    }
}
// Nodes resized on the WIDTH axis only — height always fits content (never stamped/restored).
// item/window wrap a fixed-aspect canvas; dataset/subset/price are config-only, reworked often
// with visibility-toggleable inputs, so a frozen height would clip or leave dead space.
// Only the fixed-aspect canvas nodes are width-only (height follows their image aspect).
// Every other node — incl. the config nodes (dataset/subset/producer) — is freely resizable.
const COLX = { game: 20, window: 300, filesource: 460, trigger: 560, action: 620, register: 660, producer: 700, preview: 1580, region: 600, detect: 600, state: 600, scrollbar: 600, item: 600, itemfield: 850, itemtell: 1080, dataset: 900, subset: 1900, vttable: 2300, prod: 1080, dictionary: 20 };

// Build a brand-new node OFFSCREEN purely to read its real border-box size, then discard it.
// Built UNWIRED (wire=false): wireNode side-effects (window openImage() registering into
// imageCanvases, out-port drag wiring) must NOT fire for a throwaway probe — a wired window
// probe would register imageCanvases[winId] against this detached host, so the real node's
// openImage() then early-returns and renders an empty .win-img (no canvas, no capture buttons).
// A node whose size is driven by a <canvas>/<img> only settles its aspect a frame later, so for
// those we wait two rAFs and re-measure — hence async.
async function measureNode(n) {
    const probe = buildNode(n, false);
    probe.style.position = "absolute";
    probe.style.visibility = "hidden";
    probe.style.left = "-99999px";
    probe.style.top = "0";
    $("gnodes").appendChild(probe);
    let dims = { w: probe.offsetWidth || 240, h: probe.offsetHeight || 160 };
    if (probe.querySelector("canvas, img")) {
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        dims = { w: probe.offsetWidth || dims.w, h: probe.offsetHeight || dims.h };
    }
    probe.remove();
    return dims;
}

// Position a just-created node. Call BEFORE render() so ensurePositions() leaves it alone.
// `srcId` is the node that SPAWNED this one (a node adding a node): the new node is placed
// just beside it and — if that source sits in a group — allowed to land inside that group's
// box (it then JOINS the group via inheritGroupFrom() after render). With no `srcId` (a
// toolbox spawn) it lands at the viewport centre, clear of every group.
// The node is prerendered (measureNode) so its REAL size drives the free-spot search.
// `at` (world-coords {x,y}) drops the node centred on a specific point — the spot the canvas
// right-click add-node menu was opened at — taking precedence over the viewport-centre default.
export async function placeNewNode(id, type, srcId = null, at = null) {
    const n = model.nodes().find((x) => x.id === id);
    const dims = n ? await measureNode(n) : { w: 240, h: 160 };
    const sp = srcId && pos.get(srcId);
    // No free-spot search: a node lands exactly where it was asked for — directly BELOW its
    // spawning node (a bonded preview / subset), else centred on the click/drop point, else the
    // viewport centre. Overlaps are the user's to sort out; they asked for it placed HERE.
    let x, y;
    if (sp) { x = sp.x; y = sp.y + nh(srcId) + 24; }
    else if (at) { x = at.x - dims.w / 2; y = at.y - dims.h / 2; }
    else { const c = viewportCenterWorld(); x = c.x - dims.w / 2; y = c.y - dims.h / 2; }
    pos.set(id, { x: snap(x), y: snap(y) });
    setStatus(`created ${type} ${id.split(":").pop()}`);
}

// A node spawned by another inherits that node's group, so a "+ add" beside a grouped node
// keeps the result in the same box. Call AFTER render() — addToGroup needs the new node to
// have a live rect. Generalises the old item->field grouping; placeNewNode already parked
// the node inside the group's box, so the box just grows to hug it.
export function inheritGroupFrom(newId, srcId) {
    if (!srcId) return;
    const g = groups.groupOf(srcId);
    if (g) groups.addToGroup(g.id, [newId]);
    // inherit the source's SUBGROUP too, so a box drawn on a window inside a subgroup joins it
    const sg = groups.subgroupOf(srcId);
    if (sg) groups.addToSubgroup(sg.id, [newId]);
}

// place a (new) node at a world-space point, grid-snapped
export function placeAt(id, pt) { pos.set(id, { x: snap(pt.x), y: snap(pt.y) }); }

// Park a freshly-shown satellite (preview / vt-table) just to the right of its parent, unless it
// already has a saved slot. Only sets pos when the parent is laid out; otherwise ensurePositions
// falls back to the type's COLX column.
function placeSatelliteNear(satId) {
    if (pos.has(satId)) return;
    const r = nodeRect(model.satelliteParent(satId));
    if (r) placeAt(satId, { x: r.x + r.w + 60, y: r.y });
}

// Update a satellite-toggle button's look to match its on/off state (render() leaves the parent
// node's DOM in place, so the button is flipped by hand).
export function paintSatToggle(btn, on) {
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-pressed", on);
    const t = `${on ? "hide" : "show"} ${btn.dataset.sat.startsWith("prev:") ? "preview" : "data table"}`;
    btn.title = t; btn.setAttribute("aria-label", t);
}

// Apply a satellite's new visibility: (re)build the graph so the follower node + its dotted edge
// appear/disappear, seat it in its parent's group/subgroup, and persist (layout sidecar only).
export function applySatellite(satId, on) {
    if (on) placeSatelliteNear(satId);          // set pos BEFORE render so ensurePositions keeps it
    else groups.forgetNodes(new Set([satId]));  // hidden -> drop it from any group/subgroup (no stale member id)
    render();
    if (on) groups.reflowFollowers();           // shown -> seat it in its parent's group/subgroup
    persist.layout();   // satellite visibility rides the layout sidecar, never the yaml
}

// Ensure a satellite is shown (no-op if already), syncing its parent's toggle button. Used by
// flows that need the satellite present to render into it (e.g. the image's "preview all").
export function showSatellite(satId) {
    if (model.satelliteOn(satId)) return;
    model.toggleSatellite(satId);
    // pick THIS satellite's toggle by id — a node can carry several (file source: preview + dismissed)
    const btn = nodeEls.get(model.satelliteParent(satId))?.querySelector(`.gn-sat-tog[data-sat="${satId}"]`);
    if (btn) paintSatToggle(btn, true);
    applySatellite(satId, true);
}

// ---- dragging -------------------------------------------------------------
// GRID, snap, addResizeGrips, beginDrag and makeDraggable are imported from dragresize.js
// — the same primitives the floating panels use.

// Every node reachable by following edges OUT of `id` (its downstream subtree).
// Used for shift-drag. preview/data/batches are real nodes on edges, so they're
// included automatically.
function descendantsOf(id) {
    const out = new Set();
    const stack = [id];
    while (stack.length) {
        const cur = stack.pop();
        for (const e of model.edges()) {
            if (e.from === cur && !out.has(e.to)) { out.add(e.to); stack.push(e.to); }
        }
    }
    out.delete(id);
    return [...out];
}

export function startMove(id, ev) {
    // Which other nodes ride along with the lead:
    //   • part of a multi-selection -> the whole selection
    //   • else Shift -> the subtree flowing out of this node
    let extra;
    if (selected.size > 1 && selected.has(id)) extra = [...selected].filter((x) => x !== id);
    else if (ev.shiftKey) extra = descendantsOf(id);
    else extra = [];
    moveNodes(id, extra, ev);
}

// Drag `id` (the lead, follows the cursor) plus every node in `extra` by the same world
// delta. Used by single drag, shift-subtree drag, multi-select drag, and group-title drag.
export function moveNodes(id, extra, ev) {
    const p = pos.get(id);
    if (!p) return;
    const group = extra.map((gid) => ({ gid, gp: pos.get(gid) })).filter((g) => g.gp && g.gid !== id);
    const starts = group.map((g) => ({ ...g, sx: g.gp.x, sy: g.gp.y }));
    const start = { px: p.x, py: p.y };
    // Track the cursor in WORLD space off the LIVE pan/zoom every move — so a pan happening
    // at the same time as the drag shifts the world consistently and the node follows the
    // cursor instead of drifting the wrong way (the old screen-delta math ignored the pan).
    const rect = $("graph").getBoundingClientRect();
    const toWorld = (e) => ({ x: (e.clientX - rect.left - view.panX) / view.zoom, y: (e.clientY - rect.top - view.panY) / view.zoom });
    const g0 = toWorld(ev);
    // the moved nodes ease left/top to each 20px grid cell instead of teleporting (.snapping CSS)
    const moved = [id, ...starts.map((g) => g.gid)];
    setDraggingNodes(true, moved);   // freeze line routing during the drag (invalidating lines a
                                     // dragged node touches or crosses); re-route once on settle
    for (const mid of moved) nodeEls.get(mid)?.classList.add("snapping");
    // shared drag loop (dragresize.js) — onMove does the world-space + grid-snap work
    beginDrag(ev, {
        onMove: (e) => {
            const w = toWorld(e);
            const dx = w.x - g0.x, dy = w.y - g0.y;
            p.x = snap(start.px + dx);
            p.y = snap(start.py + dy);
            positionNode(id);
            for (const g of starts) { g.gp.x = snap(g.sx + dx); g.gp.y = snap(g.sy + dy); positionNode(g.gid); }
            requestEdges();   // one edge redraw per frame, coalescing this move with others
            groups.renderGroups();   // group boxes hug their members live
            showGuides(moved);   // live alignment guides to whatever the moving cluster lines up with
        },
        onSettle: () => {
            for (const mid of moved) nodeEls.get(mid)?.classList.remove("snapping");
            setDraggingNodes(false);
            flushEdges();   // paint the final positions now, dropping any pending coalesced frame
            groups.absorb([id, ...extra.filter((x) => x !== id)]);   // dropped inside a group box -> join it
            resizeCanvas(); groups.renderGroups(); persist.layout(); renderNodeViews();
            flashGuides(moved);   // keep the resting alignment shown briefly, then fade
        },
    });
}
// Drag a node by a control that ALSO has a click action (collapse caret, title input):
// only begin moving once the cursor passes a small threshold; a plain click (no move)
// falls through to the control's own handler (toggle / focus-to-rename).
export function dragFromHandle(id, ev, div, handle) {
    // shared drag loop with a 4px gate; once crossed, hand off to the real node-move loop
    const stop = beginDrag(ev, {
        threshold: 4,
        onStart: () => {
            stop();   // drop this gate loop; startMove begins its own drag loop from the same ev
            if (handle.tagName === "INPUT") { handle.blur(); window.getSelection()?.removeAllRanges(); }
            // a drag must NOT also fire the control's click (collapse toggle / input focus) — the
            // trailing click fires synchronously on mouseup. Shared suppressor (dragresize.js).
            suppressNextClick(div);
            startMove(id, ev);
        },
    });
}
