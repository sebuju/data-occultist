// The page surface: lays out a page's widgets, applies style, evaluates show/enable
// conditions reactively, and — in edit mode — makes each widget draggable, resizable, and
// selectable. A full rebuild happens only on page switch / mode change / structural edit;
// data ticks reconcile inside each widget instance, and conditions toggle a class/hidden flag
// in place (rule 1) — never a rebuild.

import { makeDraggable, addResizeGrips, GRID, snap } from "../graph/dragresize.js";
import { applyStyle, mergeStyle } from "./style.js";
import { widgetDef } from "./widgets/index.js";
import { evaluate, tokensIn } from "./expr.js";
import { resolveToken, subKeyForToken } from "./binding.js";
import { keySubscription, el } from "./widgets/util.js";

// Render `page` into `surface`. Returns a controller with destroy()/updateAll()/select().
export function renderPage(surface, page, ctx) {
  surface.textContent = "";
  applyStyle(surface, mergeStyle(ctx.pretty.theme(), page.style));   // page-level style (theme defaults under it)
  const recs = new Map();   // widget id -> record

  for (const widget of page.widgets) recs.set(widget.id, build(widget));

  function build(widget) {
    const def = widgetDef(widget.type);
    const frame = el("div", `pw pw-t-${widget.type}`);   // type class carries per-type defaults; inline style overrides
    frame.dataset.id = widget.id;
    place(frame, widget);
    applyStyle(frame, mergeStyle(ctx.pretty.theme(), widget.style));
    const host = el("div", "pw-content");
    frame.appendChild(host);
    surface.appendChild(frame);

    let inst = { update() {}, destroy() {} };
    if (def) { try { inst = def.create(host, widget, ctx) || inst; } catch (e) { host.textContent = String(e.message || e); } }

    // reactive conditions
    const condSub = keySubscription(ctx, () => applyConditions(rec));
    const rec = { widget, frame, host, inst, def, condSub };
    wireConditions(rec);
    applyConditions(rec);

    if (ctx.mode === "edit") wireEdit(rec);
    else { frame.classList.remove("pw-edit"); }
    return rec;
  }

  function place(frame, w) {
    frame.style.left = `${w.x || 0}px`;
    frame.style.top = `${w.y || 0}px`;
    frame.style.width = `${w.w || 200}px`;
    frame.style.height = `${w.h || 80}px`;
    frame.style.zIndex = String(w.z || 1);
  }

  function wireConditions(rec) {
    const c = rec.widget.conditions || {};
    const inners = [...tokensIn(c.visible_when || ""), ...tokensIn(c.enabled_when || "")];
    rec.condSub.sync(inners.map(subKeyForToken).filter(Boolean));
  }
  function applyConditions(rec) {
    const c = rec.widget.conditions || {};
    const resolve = (inner) => resolveToken(ctx, inner);
    const visible = evaluate(c.visible_when, resolve, true);
    const enabled = evaluate(c.enabled_when, resolve, true);
    // in edit mode never hide (so you can still select/move a conditionally-hidden widget) —
    // dim it instead so the rule is visible while authoring.
    if (ctx.mode === "edit") {
      rec.frame.hidden = false;
      rec.frame.classList.toggle("pw-cond-hidden", !visible);
      rec.frame.classList.toggle("pw-cond-disabled", !enabled);
    } else {
      rec.frame.hidden = !visible;
      rec.frame.classList.toggle("pw-disabled", !enabled);
    }
  }

  function wireEdit(rec) {
    const { frame, widget } = rec;
    frame.classList.add("pw-edit");
    frame.addEventListener("mousedown", () => ctx.selectWidget(widget.id));
    // hover trashcan -> delete with standard armed two-click confirm (rule 2)
    const del = el("button", "pw-del");
    del.title = "delete widget (click again to confirm)";
    del.innerHTML = `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M3 4.5h10M6.4 4V2.8a.8.8 0 0 1 .8-.8h1.6a.8.8 0 0 1 .8.8V4M4.8 4.5l.5 8a1 1 0 0 0 1 .95h3.4a1 1 0 0 0 1-.95l.5-8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    del.addEventListener("mousedown", (ev) => { ev.stopPropagation(); ev.preventDefault(); });   // don't start a drag/select
    del.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (del.dataset.armed !== "1") { del.dataset.armed = "1"; del.classList.add("armed"); setTimeout(() => { del.dataset.armed = "0"; del.classList.remove("armed"); }, 2500); return; }
      ctx.removeWidget(widget.id);
    });
    frame.appendChild(del);
    let sx = 0, sy = 0, ox = 0, oy = 0;
    makeDraggable(frame, {
      handle: frame, threshold: 3, cursor: "grabbing",
      ignore: "input, select, textarea, button, a, .rz-grip, .rz-reset",
      onStart: (ev) => { sx = ev.clientX; sy = ev.clientY; ox = widget.x || 0; oy = widget.y || 0; ctx.selectWidget(widget.id); },
      onMove: (e) => {
        widget.x = Math.max(0, snap(ox + (e.clientX - sx)));
        widget.y = Math.max(0, snap(oy + (e.clientY - sy)));
        frame.style.left = `${widget.x}px`; frame.style.top = `${widget.y}px`;
      },
      onSettle: () => ctx.requestSave(),
    });
    addResizeGrips(frame, {
      both: true, snap: true,
      left: (v) => { if (v === undefined) return widget.x || 0; widget.x = Math.max(0, v); frame.style.left = `${widget.x}px`; },
      onResize: () => { widget.w = frame.offsetWidth; widget.h = frame.offsetHeight; rec.inst.update && rec.inst.update(); },
      onSettle: () => { widget.w = frame.offsetWidth; widget.h = frame.offsetHeight; ctx.requestSave(); },
    });
  }

  return {
    updateAll() { for (const rec of recs.values()) try { rec.inst.update && rec.inst.update(); } catch { /* guard */ } },
    select(id) {
      for (const rec of recs.values()) rec.frame.classList.toggle("pw-sel", rec.widget.id === id);
    },
    destroy() { for (const rec of recs.values()) { try { rec.inst.destroy && rec.inst.destroy(); } catch { /* */ } rec.condSub.destroy(); } recs.clear(); },
  };
}

export { GRID };
