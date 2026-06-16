// Undo / redo of the profile (full config history, layout excluded).
// Extracted from main.js verbatim.
import { model, setStatus, imageCanvases } from "./state.js";
import { persist } from "./persist.js";
import { render } from "./main.js";
import { refreshImageBoxes, refreshDetect } from "./imaging.js";

// ---- undo / redo (full history of the profile) -----------------------------
// Layout is EXCLUDED from history (snapState strips it) so undo/redo is config-only —
// moving a node never becomes an undo step, and undo never shuffles the canvas.

let history = [];
let hIndex = -1;
let restoring = false;
function snapState() { const { layout, ...rest } = model.profile; return JSON.stringify(rest); }
function pushHistory() {
  if (restoring) return;
  const s = snapState();
  if (hIndex >= 0 && history[hIndex] === s) return;   // no change
  history = history.slice(0, hIndex + 1);
  history.push(s);
  if (history.length > 200) history.shift();
  hIndex = history.length - 1;
}
function resetHistory() { history = [snapState()]; hIndex = 0; }
function applyHistory() {
  restoring = true;
  const layout = model.profile.layout;     // carry layout across the reload (it's not in history)
  model.load(JSON.parse(history[hIndex]));
  model.profile.layout = layout;
  render();
  for (const winId of imageCanvases.keys()) { refreshImageBoxes(winId); refreshDetect(winId); }
  persist.content();
  restoring = false;
}
function undo() { if (hIndex > 0) { hIndex--; applyHistory(); setStatus("undo"); } }
function redo() { if (hIndex < history.length - 1) { hIndex++; applyHistory(); setStatus("redo"); } }

export { history, hIndex, restoring, snapState, pushHistory, resetHistory, applyHistory, undo, redo };
