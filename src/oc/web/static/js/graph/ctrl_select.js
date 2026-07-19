// ONE ctrl/cmd-click resolver for the whole graph (rule 7: one primitive, not a copy per surface).
// Runs in the CAPTURE phase on document, ahead of every node/group bubble handler AND ahead of the
// many node-internal `stopPropagation()` callers (scheme pills, meter bars, table cells, ports,
// toast rows) that exist only to stop a ctrl-click from starting a drag — those calls used to also
// swallow the ctrl-toggle before it ever reached the node div's bubble handler, so some nodes
// silently refused to join the selection. Owning ctrl-click centrally fixes that for good: any
// future node-internal element gets ctrl-select for free, it can never re-swallow it.
//
// Mode lock: node selection (`selected`, state.js) and group selection (`selectedGroups`,
// groups.js) never mix. Whichever was selected FIRST owns every ctrl-click until deselectAll
// clears both:
//   • group-mode (>=1 group ctrl-selected, OR nothing selected yet): ctrl-click on a node, or on
//     any part of a group (title or body), toggles that node's/click's OWNING GROUP — nodes never
//     enter `selected`. A ctrl+title with nothing selected STARTS group-mode (selects the group),
//     it does not fall back to selecting the group's nodes.
//   • node-mode (a node selection is already active): ctrl-click a node toggles the node;
//     ctrl-click a group TITLE toggles all of that group's member NODES (never the group itself).
import { $, view, selected, nodeEls } from "./state.js";
import { selectedNodeId } from "./main.js";
import * as groups from "./groups.js";
import { ctrlToggleNode, ctrlToggleGroupMembers } from "./selection.js";
import { suppressNextClick } from "./dragresize.js";

function toWorld(ev) {
    const r = $("graph").getBoundingClientRect();
    return { x: (ev.clientX - r.left - view.panX) / view.zoom, y: (ev.clientY - r.top - view.panY) / view.zoom };
}

export function wireCtrlSelect() {
    document.addEventListener("mousedown", (ev) => {
        if (!(ev.ctrlKey || ev.metaKey) || ev.button !== 0) return;
        // the cog is a DOM child of .ggroup-title but has its own action (open settings) — it used
        // to shield itself from the title's mousedown via its own stopPropagation; preserve that.
        const titleEl = ev.target.closest(".ggt-cog") ? null : ev.target.closest(".ggroup-title");
        const nodeEl = ev.target.closest(".gnode");
        const groupMode = groups.selectedGroupIds().length > 0;
        const nodeActive = selected.size > 0 || (selectedNodeId && nodeEls.has(selectedNodeId));
        // consume the mousedown AND swallow the trailing click on mouseup — else the control
        // under the cursor (button/checkbox/link/custom-click widget) still fires on a ctrl-select.
        const consume = () => { ev.preventDefault(); ev.stopPropagation(); suppressNextClick(nodeEl || titleEl || $("graph")); };

        if (titleEl) {
            consume();
            const gid = titleEl.dataset.gid;
            // group-mode, or nothing selected yet -> a fresh ctrl+title STARTS group-mode by
            // selecting the group itself (never its nodes). Only an already-active NODE selection
            // makes ctrl+title toggle that group's member nodes instead.
            if (groupMode || !nodeActive) groups.toggleGroupSelected(gid);
            else ctrlToggleGroupMembers(gid);
            return;
        }
        if (nodeEl) {
            consume();
            const id = nodeEl.dataset.id;
            if (groupMode) {
                const g = groups.groupOf(id);
                if (g) groups.toggleGroupSelected(g.id);       // node's owning group, never the node itself
            } else {
                ctrlToggleNode(id);
            }
            return;
        }
        if (groupMode && !ev.target.closest(".ggt-cog")) {
            // group body is pointer-events:none (graph.css), so a ctrl-click over empty group
            // interior falls through to here with no element match — hit-test it in world space.
            const w = toWorld(ev);
            const gid = groups.groupAt(w.x, w.y);
            if (gid) { consume(); groups.toggleGroupSelected(gid); }
        }
        // else: empty canvas, no group under the cursor -> let the ctrl-marquee (canvas_input.js) run
    }, true);
}
