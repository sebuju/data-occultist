// The Pretty topbar tools (the placeholder that replaces .topbar-tools in pretty view): a
// view/edit mode switch, the page selector + add-page, and toggles for the studio panels
// (palette / inspector / sources / theme). Panel toggles show only in edit mode.

import { el } from "./widgets/util.js";

export function buildPrettyTools(host, ctx, panels) {
  host.textContent = "";
  const mode = el("div", "pw-modeswitch");
  const bView = el("button", "pw-mode", "view");
  const bEdit = el("button", "pw-mode", "edit");
  bView.addEventListener("click", () => ctx.setMode("view"));
  bEdit.addEventListener("click", () => ctx.setMode("edit"));
  mode.append(bView, bEdit);

  const pageSel = el("select", "pw-pagesel");
  pageSel.addEventListener("change", () => ctx.switchPage(pageSel.value));
  const addPage = el("button", "pw-addpage", "+ page");
  addPage.addEventListener("click", () => ctx.addPage());

  const spacer = el("span", "spacer");
  const editTools = el("div", "pw-edittools");
  const toggles = [
    ["inspector", panels.inspector], ["sources", panels.sources], ["theme", panels.theme],
  ];
  const toggleBtns = new Map();
  for (const [label, panel] of toggles) {
    const b = el("button", "pw-paneltog", label);
    b.addEventListener("click", () => { if (panel.win.state.visible) panel.win.setVisible(false); else openPanel(panel); refresh(); });
    editTools.appendChild(b);
    toggleBtns.set(panel, b);
  }

  // Open a panel: expand it if collapsed, then tile it into the first free slot — columns
  // from the RIGHT edge leftward, stacking within a column; if a column is full it tries the
  // next column further from the right. Standard margins respected.
  function openPanel(panel) {
    const GAP = 8;
    const top = (document.querySelector(".topbar")?.offsetHeight || 48) + GAP;
    const vh = window.innerHeight;
    panel.win.state.collapsed = false;
    panel.win.setVisible(true);
    const w = panel.win.el.offsetWidth, h = panel.win.el.offsetHeight || 200;
    const others = [];
    for (const [pn] of toggleBtns) {
      if (pn === panel || !pn.win.state.visible) continue;
      const e = pn.win.el;
      others.push({ l: e.offsetLeft, t: e.offsetTop, r: e.offsetLeft + e.offsetWidth, b: e.offsetTop + e.offsetHeight });
    }
    let spot = null;
    for (let x = window.innerWidth - w - GAP; x >= GAP && !spot; x -= (w + GAP)) {
      const band = others.filter((o) => o.r > x + 2 && o.l < x + w - 2);   // panels sharing this column
      const y = band.length ? Math.max(top, ...band.map((o) => o.b + GAP)) : top;
      if (y + h <= vh - GAP) spot = { x, y };
    }
    if (!spot) spot = { x: Math.max(GAP, window.innerWidth - w - GAP), y: top };
    panel.win.place(spot.x, spot.y);
    panel.refresh && panel.refresh();
  }

  host.append(mode, pageSel, addPage, spacer, editTools);

  function refresh() {
    bView.classList.toggle("active", ctx.mode === "view");
    bEdit.classList.toggle("active", ctx.mode === "edit");
    editTools.hidden = ctx.mode !== "edit";
    addPage.hidden = ctx.mode !== "edit";
    const pages = ctx.pretty.pages();
    pageSel.textContent = "";
    for (const p of pages) { const o = el("option", null, p.title); o.value = p.id; pageSel.appendChild(o); }
    pageSel.value = ctx.currentPageId();
    for (const [panel, b] of toggleBtns) b.classList.toggle("active", panel.win.state.visible);
  }
  refresh();
  return { refresh };
}
