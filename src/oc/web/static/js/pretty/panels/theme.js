// Theme panel (edit mode): the document-level style defaults every widget inherits. Reuses
// the ONE style editor on the pretty doc's theme object.

import { createFloatWin } from "../../graph/floatwin.js";
import { styleEditor } from "../style_editor.js";

export const themeState = { visible: false, x: null, y: null, w: 280, h: null, collapsed: false };

export function buildTheme(ctx) {
  const win = createFloatWin({ id: "pretty-theme", title: "theme", state: themeState, bothAxes: true,
    onShow: () => refresh() });
  function refresh() {
    styleEditor(win.body, ctx.pretty.theme(), () => { ctx.pretty.save(); ctx.refresh(); });
  }
  return { win, refresh };
}
