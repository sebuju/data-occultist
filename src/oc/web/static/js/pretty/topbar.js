// The Pretty topbar tools (the placeholder that replaces .topbar-tools in pretty view): a
// view/edit mode switch and toggles for the studio panels (pages / inspector / sources / theme).
// Page management (switch / add / rename / reorder / delete) lives in the pages panel now. Panel
// toggles show only in edit mode.

import { el } from "./widgets/util.js";

export function buildPrettyTools(host, ctx, panels) {
    host.textContent = "";
    const mode = el("div", "pw-modeswitch");
    const bView = el("button", "pw-mode", "view");
    const bEdit = el("button", "pw-mode", "edit");
    bView.addEventListener("click", () => ctx.setMode("view"));
    bEdit.addEventListener("click", () => ctx.setMode("edit"));
    mode.append(bView, bEdit);

    const spacer = el("span", "spacer");
    const editTools = el("div", "pw-edittools");
    const toggles = [
        ["pages", panels.pages], ["elements", panels.elements], ["inspector", panels.inspector], ["sources", panels.sources], ["theme", panels.theme],
    ];
    const toggleBtns = new Map();
    for (const [label, panel] of toggles) {
        const b = el("button", "pw-paneltog", label);
        // Same path as the node-view topbar toggles: open with reset (uniform 300px box, free slot,
        // auto-dock under a panel if it lands below one), so pretty panels behave identically.
        b.addEventListener("click", () => {
            const show = !panel.win.state.visible;
            panel.win.setVisible(show, true);
            if (show) panel.refresh && panel.refresh();
            refresh();
        });
        editTools.appendChild(b);
        toggleBtns.set(panel, b);
    }

    // cue-scope toggle: flip the edit-mode visual cue layer between every widget and the selection.
    const cueTog = el("button", "pw-paneltog pw-cuetog");
    cueTog.title = "visual cues: all widgets / selected only";
    const NEXT_CUE = { all: "selected", selected: "all" };
    cueTog.addEventListener("click", () => { ctx.setCueScope(NEXT_CUE[ctx.cueScope] || "all"); refresh(); });
    editTools.appendChild(cueTog);

    host.append(mode, spacer, editTools);

    function refresh() {
        bView.classList.toggle("active", ctx.mode === "view");
        bEdit.classList.toggle("active", ctx.mode === "edit");
        editTools.hidden = ctx.mode !== "edit";
        for (const [panel, b] of toggleBtns) b.classList.toggle("active", panel.win.state.visible);
        cueTog.textContent = `cues: ${ctx.cueScope}`;
        cueTog.classList.toggle("active", ctx.cueScope === "all");
    }
    refresh();
    return { refresh };
}
