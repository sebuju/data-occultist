// Canvas-level pointer input: right-drag pan, left-drag marquee select, click-outside tool
// disarm, group double-click framing, and the right-click add-node context menu. Split out of
// main.js; deselectAll/setMultiSelect/selectionIds stay in main and are imported back.
import { $, model, nodeEls, view, setStatus } from "./state.js";
import * as groups from "./groups.js";
import { clearTools } from "./drawtool.js";
import { startPan, cancelPan, consumePanSuppress, onWheel, panZoomToRect } from "./camera.js";
import { nodeRect } from "./routing.js";
import { iconFor } from "./node_icons.js";
import { openContextMenu } from "../ctxmenu.js";
import { registerKey, SCOPE } from "../inputbus.js";
import {
    createWindowNode, createDatasetNode, createSubsetNode, createProducerNode, createFileSourceNode,
    createTriggerNode, createToastNode, createSoundNode, createActionNode, createRegisterNode,
    createDictionaryNode,
} from "./panels/toolbox.js";
import { deselectAll, setMultiSelect, selectionIds } from "./main.js";

// Rubber-band selection: drag a rectangle on empty canvas to select every node it
// touches. Highlights live; commits on release. A press with no drag clears selection.
function startMarquee(ev) {
    // ctrl/cmd-marquee is ADDITIVE: it toggles every caught node against the EXISTING selection
    // (nodes already selected get removed, fresh ones added) instead of replacing it.
    const additive = ev.ctrlKey || ev.metaKey;
    const base = new Set(selectionIds());
    const box = $("graph").getBoundingClientRect();
    const el = $("marquee");
    const s = { x: ev.clientX, y: ev.clientY };
    // screen point -> world (matches moveNodes' toWorld)
    const toWorld = (cx, cy) => ({ x: (cx - box.left - view.panX) / view.zoom, y: (cy - box.top - view.panY) / view.zoom });
    let moved = false;
    const caught = () => {
        const a = toWorld(s.x, s.y), b = toWorld(_mx, _my);
        const x1 = Math.min(a.x, b.x), y1 = Math.min(a.y, b.y), x2 = Math.max(a.x, b.x), y2 = Math.max(a.y, b.y);
        const hit = [];
        for (const [id] of nodeEls) {
            const r = nodeRect(id);
            if (r && r.x < x2 && r.x + r.w > x1 && r.y < y2 && r.y + r.h > y1) hit.push(id);
        }
        return hit;
    };
    let _mx = s.x, _my = s.y;
    const onMove = (e) => {
        _mx = e.clientX; _my = e.clientY;
        if (!moved && Math.hypot(_mx - s.x, _my - s.y) < 4) return;
        // additive keeps the prior selection on-screen; plain replace clears it on first drag
        if (!moved) { moved = true; el.hidden = false; if (!additive) deselectAll(); }
        const left = Math.min(s.x, _mx) - box.left, top = Math.min(s.y, _my) - box.top;
        el.style.left = `${left}px`; el.style.top = `${top}px`;
        el.style.width = `${Math.abs(_mx - s.x)}px`; el.style.height = `${Math.abs(_my - s.y)}px`;
        const hit = new Set(caught());
        // additive: a node is lit when membership in base XOR the marquee differs (toggle)
        for (const [id, nel] of nodeEls)
            nel.classList.toggle("multisel", additive ? (base.has(id) !== hit.has(id)) : hit.has(id));
    };
    const onUp = () => {
        document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp);
        el.hidden = true;
        if (moved) {
            const hit = new Set(caught());
            setMultiSelect(additive ? [...nodeEls.keys()].filter((id) => base.has(id) !== hit.has(id)) : [...hit]);
        } else if (!additive) deselectAll();   // ctrl-click on empty canvas keeps the selection
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
}

export function wireCanvasInput() {
    // Right-drag pans from ANYWHERE over the graph, incl. over inputs/selects/textareas. CAPTURE
    // phase on window so it runs before any descendant's mousedown — a meter bar / group cog /
    // resize grip / form control that stopPropagation()s the press can no longer swallow the pan.
    // Don't preventDefault — a plain right click must still open the native context menu; only an
    // actual drag suppresses it (startPan sets suppressNextMenu, read by the contextmenu handler).
    window.addEventListener("mousedown", (ev) => {
        if (ev.button !== 2) return;
        if (!ev.target.closest("#graph")) return;
        const cleared = clearTools();   // right-click disarms any draw tool
        // a click (not just a drag) that just disarmed a tool must also suppress the upcoming
        // contextmenu — else the native/add-node menu pops up right after, over the canvas.
        startPan(ev, { forceSuppress: cleared });
    }, true);
    $("graph").addEventListener("mousedown", (ev) => {
        // left-drag on empty canvas: rubber-band multi-select (a plain click clears).
        if (ev.button === 0 && !ev.target.closest(".gnode, .ggroup")) startMarquee(ev);
    });
    // Click-outside disarms the draw tool: a left press anywhere NOT inside a drawing surface (its
    // canvas or its own toolbar/compose controls) drops the armed tool. Capture phase so it runs
    // before the canvas's own mousedown (which stops propagation) — a press ON the canvas is inside a
    // toolhost, so it's kept and draws; a press on the surface's buttons (glyph save, item fields) is
    // also inside, so it's kept; anything else clears. Central, tool-agnostic (rule 7).
    document.addEventListener("mousedown", (ev) => {
        if (ev.button !== 0) return;   // right-click is handled on the graph mousedown above
        if (ev.target.closest("[data-toolhost]")) return;
        clearTools();
    }, true);
    // double-click a group's BACKGROUND (or a super group's) → frame it. The group box is
    // pointer-events:none so single clicks/drags fall through to the canvas (pan/marquee); we
    // hit-test the dblclick against the world rects instead. Innermost (smallest) wins, so a
    // group inside a super group frames the group. Node dblclick is handled on the node itself.
    $("graph").addEventListener("dblclick", (ev) => {
        if (ev.target.closest(".gnode")) return;
        // a control living on a group box (title input, group/ungroup + colour buttons) must not
        // double as a canvas zoom target — only an empty box double-click frames the group.
        if (ev.target.closest("button, input, select, textarea, a")) return;
        const box = $("graph").getBoundingClientRect();
        const wx = (ev.clientX - box.left - view.panX) / view.zoom;
        const wy = (ev.clientY - box.top - view.panY) / view.zoom;
        const inside = (b) => wx >= b.x && wx <= b.x + b.w && wy >= b.y && wy <= b.y + b.h;
        let hit = null;
        for (const gb of [...(groups.superGroupBoxes?.() || []), ...groups.groupBoxes(), ...(groups.subGroupBoxes?.() || [])])
            if (inside(gb.box) && (!hit || gb.box.w * gb.box.h < hit.box.w * hit.box.h)) hit = gb;
        if (hit) panZoomToRect(hit.box, { onlyIn: true });
    });
    // Suppress on window (capture) not #graph: a pan tracks via document mousemove, so the
    // release — and thus the native contextmenu — can land on a node panel, modal, or even
    // outside #graph, where a graph-scoped listener would never see it.
    window.addEventListener("contextmenu", (ev) => {
        if (consumePanSuppress()) { ev.preventDefault(); return; }   // a pan-drag just ended
        // Right-click empty canvas → add-node menu (same primitive as pretty's add-widget). The new
        // node spawns at the world point under the cursor. Clicks on nodes/groups/floating panels/
        // form controls fall through to the native menu. Capture phase + the suppress check above run
        // before this, so a pan-drag never opens the menu.
        if (ev.shiftKey) return;   // shift+right-click is reserved -> no add-node menu (native too)
        if (!ev.target.closest("#graph")) return;
        if (ev.target.closest(".gnode, .ggroup, .floatwin, input, select, textarea")) return;
        ev.preventDefault();
        const box = $("graph").getBoundingClientRect();
        const at = { x: (ev.clientX - box.left - view.panX) / view.zoom, y: (ev.clientY - box.top - view.panY) / view.zoom };
        // A menu-created node spawns UNGROUPED. The menu can only open over empty canvas (the early
        // return above skips .gnode/.ggroup, and group boxes are pointer-events:none), so a click never
        // lands on a group MEMBER — the only geometric hit was a group's invisible bbox GAP, which
        // silently absorbed the new node into a group the user didn't aim at. Drag a node into a group
        // to add it (groups.absorb on drop); creation no longer joins by geometry.
        const ready = () => { if (model.profile.name) return true; setStatus("load a game first"); return false; };
        // icons AND tints come from the ONE shared source keyed by type id — the glyph via iconFor and
        // the colour via that type's own node var (--nt-<type>, the same token graph.css maps onto the
        // node's --nt). So a menu row always reads in the exact glyph + colour of the node it mints and
        // can never drift from it (rule 7). Add a node type = add one row here, nothing else.
        const ADD_ITEMS = [
            ["window", "window", createWindowNode],
            ["dataset", "dataset", createDatasetNode],
            ["subset", "subset", createSubsetNode],
            ["producer", "producer", createProducerNode],
            ["filesource", "file source", createFileSourceNode],
            ["trigger", "trigger", createTriggerNode],
            ["toast", "toast", createToastNode],
            ["sound", "sound", createSoundNode],
            ["action", "action", createActionNode],
            ["register", "register", createRegisterNode],
            ["dictionary", "dictionary", createDictionaryNode],
        ];
        openContextMenu(ev.clientX, ev.clientY, ADD_ITEMS.map(([type, title, make]) => ({
            icon: iconFor(type), title, tint: `var(--nt-${type})`,
            onClick: () => ready() && make(at),
        })));
    }, true);
    $("graph").addEventListener("wheel", onWheel, { passive: false });
    // any user action cancels an in-flight smooth pan-to-new-node
    $("graph").addEventListener("pointerdown", cancelPan, true);
    $("graph").addEventListener("wheel", cancelPan, { capture: true, passive: true });
    // Any key cancels an in-flight smooth pan-to-node — top priority + non-consuming so it runs before
    // every other shortcut, exactly as the old window-capture keydown did (now on the central bus).
    registerKey({ combo: "*", scope: SCOPE.ANY, priority: 1000, allowInField: true, run: (ev) => { cancelPan(ev); return false; } });
}
