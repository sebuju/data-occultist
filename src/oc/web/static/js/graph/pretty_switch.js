// Pretty Studio: node ⇄ pretty view switch + pretty-dirty controls. Pretty is a convenience
// surface in the SAME SPA; switching just swaps which container + topbar tools are visible. The
// controller is imported lazily on first switch. Split out of main.js; armConfirm stays in main
// and is imported back.
import { $, model, setStatus } from "./state.js";
import { floatWins } from "./floatwin.js";
import { stopAllForgePreview } from "./sound_wire.js";
import * as prettyOverrides from "../pretty/overrides.js";
import { armConfirm } from "./main.js";

let prettyActive = false;
let _pretty = null;
let _hiddenNodePanels = [];

// Node-view floating panels belong to the node view: hide them while in pretty, restore the
// ones that were open on return (open state remembered, never reset).
const _NODE_PANELS = ["nodemap", "nodelist", "activity", "inspector", "stats", "dbstruct", "history", "toolbox", "live", "precap"];
function setNodePanelsHidden(hidden) {
    if (hidden) {
        _hiddenNodePanels = [];
        for (const id of _NODE_PANELS) { const w = floatWins().get(id); if (w && w.state.visible) { _hiddenNodePanels.push(id); w.setVisible(false); } }
    } else {
        for (const id of _hiddenNodePanels) floatWins().get(id)?.setVisible(true);
        _hiddenNodePanels = [];
    }
}

export async function setPrettyView(on) {
    if (on === prettyActive) return;
    stopAllForgePreview();   // don't leave a forge loop sounding across a node<->pretty switch
    prettyActive = on;
    document.body.classList.toggle("pretty-mode", on);
    $("vtNode")?.classList.toggle("active", !on);
    $("vtPretty")?.classList.toggle("active", on);
    $("pretty")?.classList.toggle("active", on);
    if (on) {
        setNodePanelsHidden(true);   // node tools go out while pretty is up
        try {
            _pretty = _pretty || await import("../pretty/pretty.js");
            if (!_pretty.isMounted()) await _pretty.mountPretty($("pretty"), $("prettyTools"), model.profile.name);
            else await _pretty.setPrettyGame(model.profile.name);
            _pretty.activatePretty();
        } catch (e) { setStatus(`pretty: ${e.message || e}`); }
    } else {
        if (_pretty) _pretty.deactivatePretty();   // pretty tools go out
        setNodePanelsHidden(false);                // node tools come back as they were
    }
}
$("vtNode")?.addEventListener("click", () => setPrettyView(false));
$("vtPretty")?.addEventListener("click", () => setPrettyView(true));

// loadGame's post-render hook: keep an already-open pretty view pointed at the freshly loaded
// game (mirrors the `if (prettyActive && _pretty) …` check that used to live inline in loadGame).
export function syncPrettyGame(name) {
    if (prettyActive && _pretty) _pretty.setPrettyGame(name);
}

// Show the revert/save-pretty controls only while transient overrides exist.
export function refreshDirtyUI() {
    const bar = $("prettyDirtyBar");
    if (!bar) return;
    const has = prettyOverrides.hasDirty();
    bar.hidden = !has;
    const c = $("prettyDirtyCount");
    if (c) c.textContent = has ? `${prettyOverrides.dirtyCount()} pretty` : "";
}
armConfirm($("prettyRevertBtn"), () => prettyOverrides.revertAll());
armConfirm($("prettySaveBtn"), () => prettyOverrides.commit());
