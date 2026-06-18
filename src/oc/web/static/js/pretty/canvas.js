// The page surface: lays out a page's widgets, applies style, evaluates show/enable
// conditions reactively, and — in edit mode — makes each widget draggable, resizable, and
// selectable. A full rebuild happens only on page switch / mode change / structural edit;
// data ticks reconcile inside each widget instance, and conditions toggle a class/hidden flag
// in place (rule 1) — never a rebuild.
//
// Position is resolved through each widget's optional `anchor` (where it's pinned): to the
// canvas or to another widget, at one of nine points (corners/edges/centre). x/y are the
// offset from that anchor point, so a widget anchored to another follows it when it moves or
// resizes. `placeAll()` recomputes every frame's left/top from the anchors — it runs after a
// build, on every drag/resize/nudge, and when the surface resizes, so dependents stay glued.

import { makeDraggable, addResizeGrips, GRID, snap } from "../graph/dragresize.js";
import { applyStyle, mergeStyle } from "./style.js";
import { widgetDef } from "./widgets/index.js";
import { evaluate, tokensIn } from "./expr.js";
import { resolveToken, subKeyForToken } from "./binding.js";
import { keySubscription, el } from "./widgets/util.js";

// nine anchor points: vertical t/m/b × horizontal l/c/r → fraction of the target box.
const FX = { l: 0, c: 0.5, r: 1 };
const FY = { t: 0, m: 0.5, b: 1 };
function anchorFrac(corner) {
  const c = typeof corner === "string" && corner.length === 2 ? corner : "tl";
  return { fx: FX[c[1]] ?? 0, fy: FY[c[0]] ?? 0 };
}

// x/y/w/h are stored as a number in a per-field unit (w.units.{x,y,w,h}, default px). Everything
// inside the canvas works in px, so values convert in/out: % is relative to the anchor target's
// box (the `ref` length), vw/vh (and the dynamic dvw/dvh) to the viewport.
export const POS_UNITS = ["px", "%", "vw", "vh", "dvw", "dvh"];
const r2 = (v) => Math.round(v * 100) / 100;
export const unitOf = (w, k) => (w.units && w.units[k]) || "px";
function lenToPx(val, unit, ref) {
  switch (unit) {
    case "%": return (val / 100) * ref;
    case "vw": case "dvw": return (val / 100) * window.innerWidth;
    case "vh": case "dvh": return (val / 100) * window.innerHeight;
    default: return val;
  }
}
function pxToLen(px, unit, ref) {
  switch (unit) {
    case "%": return ref ? (px / ref) * 100 : px;
    case "vw": case "dvw": return (px / window.innerWidth) * 100;
    case "vh": case "dvh": return (px / window.innerHeight) * 100;
    default: return px;
  }
}

// Render `page` into `surface`. Returns a controller with destroy()/updateAll()/select()/etc.
export function renderPage(surface, page, ctx) {
  surface.textContent = "";
  applyStyle(surface, mergeStyle(ctx.pretty.theme(), page.style));   // page-level style (theme defaults under it)
  const recs = new Map();   // widget id -> record

  for (const widget of page.widgets) recs.set(widget.id, build(widget));
  placeAll();

  // anchored-to-canvas widgets (e.g. pinned to the right/bottom edge) re-place when the
  // surface changes size; cheap, and it keeps edge-pinned widgets where they belong.
  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => placeAll()) : null;
  ro && ro.observe(surface);

  function build(widget) {
    const def = widgetDef(widget.type);
    const frame = el("div", `pw pw-t-${widget.type}`);   // type class carries per-type defaults; inline style overrides
    frame.dataset.id = widget.id;
    frame.style.width = `${widget.w || 200}px`;
    frame.style.height = `${widget.h || 80}px`;
    frame.style.zIndex = String(widget.z || 1);
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

  // ---- anchor-aware layout ----------------------------------------------------------

  // Resolve every widget's absolute box {left, top, w, h} from its anchor chain. The target is
  // the canvas (default) or another widget; the widget's own anchor point is placed at the
  // target's anchor point plus the widget's x/y offset. Memoised with a cycle guard so an
  // anchor loop falls back to the canvas instead of recursing forever.
  function resolveBoxes() {
    const surfW = surface.clientWidth || surface.offsetWidth || 0;
    const surfH = surface.clientHeight || surface.offsetHeight || 0;
    const memo = new Map();
    const box = (id, seen) => {
      if (memo.has(id)) return memo.get(id);
      const rec = recs.get(id);
      if (!rec) return null;
      const w = rec.widget;
      let tbox = { left: 0, top: 0, w: surfW, h: surfH };
      const a = w.anchor;
      if (a && a.to && a.to !== id && recs.has(a.to) && !seen.has(a.to)) {
        const t = box(a.to, new Set(seen).add(id));
        if (t) tbox = t;
      }
      const ww = lenToPx(w.w ?? 200, unitOf(w, "w"), tbox.w);
      const wh = lenToPx(w.h ?? 80, unitOf(w, "h"), tbox.h);
      const { fx, fy } = anchorFrac(a && a.corner);
      const ox = tbox.left + fx * tbox.w, oy = tbox.top + fy * tbox.h;
      const offX = lenToPx(w.x ?? 0, unitOf(w, "x"), tbox.w);
      const offY = lenToPx(w.y ?? 0, unitOf(w, "y"), tbox.h);
      const b = { left: ox - fx * ww + offX, top: oy - fy * wh + offY, w: ww, h: wh };
      memo.set(id, b);
      return b;
    };
    for (const id of recs.keys()) box(id, new Set());
    return memo;
  }
  function placeAll() {
    const boxes = resolveBoxes();
    for (const rec of recs.values()) {
      const b = boxes.get(rec.widget.id);
      if (!b) continue;
      rec.frame.style.left = `${Math.round(b.left)}px`;
      rec.frame.style.top = `${Math.round(b.top)}px`;
      rec.frame.style.width = `${b.w}px`;
      rec.frame.style.height = `${b.h}px`;
      rec.frame.style.zIndex = String(rec.widget.z || 1);
    }
    return boxes;
  }
  // The px size of a widget's anchor target box (the canvas, or another widget) — the reference
  // length a %/offset is measured against. Horizontal fields (x,w) use .w; vertical (y,h) use .h.
  function targetRef(id) {
    const rec = recs.get(id);
    const a = rec && rec.widget.anchor;
    if (a && a.to && a.to !== id && recs.has(a.to)) { const b = resolveBoxes().get(a.to); if (b) return { w: b.w, h: b.h }; }
    return { w: surface.clientWidth || surface.offsetWidth || 0, h: surface.clientHeight || surface.offsetHeight || 0 };
  }
  const refFor = (id, k) => { const r = targetRef(id); return k === "x" || k === "w" ? r.w : r.h; };

  // Re-anchor a widget while keeping it visually in place: solve its x/y offset (in each field's
  // unit) so the new anchor resolves to the same box it currently occupies.
  function reanchor(id, anchor) {
    const rec = recs.get(id);
    if (!rec) return;
    const w = rec.widget;
    const before = resolveBoxes().get(id);
    w.anchor = anchor && anchor.to !== undefined ? { to: anchor.to, corner: anchor.corner || "tl" } : { to: "", corner: "tl" };
    const sx = w.x, sy = w.y; w.x = 0; w.y = 0;
    const base = resolveBoxes().get(id);   // box with zero offset = the anchor-aligned position
    const ref = targetRef(id);
    w.x = before && base ? r2(pxToLen(before.left - base.left, unitOf(w, "x"), ref.w)) : sx;
    w.y = before && base ? r2(pxToLen(before.top - base.top, unitOf(w, "y"), ref.h)) : sy;
    placeAll(); drawAnchorCue();
    ctx.requestSave();
  }

  // ---- anchor cue (selected widget -> its anchor target) -----------------------------
  // When a selected widget is anchored to ANOTHER widget (not the canvas), outline that target
  // and draw a line from the target's anchor point to the widget's anchored corner, so the
  // "pinned to / point to" relationship is visible. Redrawn whenever either box moves.
  let cueId = null, cueSvg = null;
  function ensureCueSvg() {
    if (!cueSvg) {
      cueSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      cueSvg.setAttribute("class", "pw-anchor-cue");
      surface.appendChild(cueSvg);
    }
    return cueSvg;
  }
  function showAnchorCue(id) { cueId = id; drawAnchorCue(); }
  function drawAnchorCue() {
    for (const r of recs.values()) r.frame.classList.remove("pw-anchor-target");
    const rec = cueId && recs.get(cueId);
    const a = rec && rec.widget.anchor;
    if (!rec || !a || !a.to || !recs.has(a.to)) { if (cueSvg) cueSvg.style.display = "none"; return; }
    const boxes = resolveBoxes();
    const sb = boxes.get(cueId), tb = boxes.get(a.to);
    if (!sb || !tb) { if (cueSvg) cueSvg.style.display = "none"; return; }
    const { fx, fy } = anchorFrac(a.corner);
    const P = { x: tb.left + fx * tb.w, y: tb.top + fy * tb.h };   // target's anchor point
    const Q = { x: sb.left + fx * sb.w, y: sb.top + fy * sb.h };   // widget's anchored corner
    recs.get(a.to).frame.classList.add("pw-anchor-target");
    const svg = ensureCueSvg();
    svg.setAttribute("width", surface.scrollWidth); svg.setAttribute("height", surface.scrollHeight);
    svg.style.display = "";
    svg.innerHTML =
      `<line x1="${P.x}" y1="${P.y}" x2="${Q.x}" y2="${Q.y}" class="pw-cue-line"/>` +
      `<circle cx="${P.x}" cy="${P.y}" r="4" class="pw-cue-dot"/>` +
      `<circle cx="${Q.x}" cy="${Q.y}" r="3" class="pw-cue-end"/>`;
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
    // Click selects: shift toggles into the current group; a plain click on an already-selected
    // widget keeps the group (so it can be dragged in tandem), else it becomes the sole selection.
    frame.addEventListener("mousedown", (ev) => {
      if (ev.button !== 0) return;
      if (ev.target.closest(".rz-grip, .rz-reset, .pw-del")) return;
      if (ev.shiftKey) ctx.selectWidget(widget.id, true);
      else if (!ctx.selectionIds().has(widget.id)) ctx.selectWidget(widget.id);
    });
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
    // Drag moves the whole selection in tandem when this widget is part of a multi-selection,
    // else just this one. The delta is snapped (not each absolute position) so the group keeps
    // its relative grid, and clamped so no member crosses the canvas edge.
    let sx = 0, sy = 0, movers = [];
    makeDraggable(frame, {
      handle: frame, threshold: 3, cursor: "grabbing",
      ignore: "input, select, textarea, button, a, .rz-grip, .rz-reset",
      onStart: (ev) => {
        sx = ev.clientX; sy = ev.clientY;
        const sel = ctx.selectionIds();
        const ids = sel.has(widget.id) && sel.size > 1 ? [...sel] : [widget.id];
        // capture each mover's start position IN PX + its unit/ref, so the px delta converts back
        // into whatever unit the field uses (px/%/vw/vh/dvw/dvh).
        movers = ids.map((id) => recs.get(id)).filter(Boolean).map((r) => {
          const w = r.widget, ref = targetRef(w.id);
          return { w, ux: unitOf(w, "x"), uy: unitOf(w, "y"), refW: ref.w, refH: ref.h,
            pxX: lenToPx(w.x ?? 0, unitOf(w, "x"), ref.w), pxY: lenToPx(w.y ?? 0, unitOf(w, "y"), ref.h) };
        });
      },
      onMove: (e) => {
        // snap the DELTA (not each absolute position) so a multi-selection keeps its relative
        // grid. Offsets are anchor-relative and may be negative (e.g. anchored bottom-right), so
        // they're NOT clamped to >= 0 — clamping broke dragging for any non-top-left anchor.
        const dx = snap(e.clientX - sx), dy = snap(e.clientY - sy);
        for (const m of movers) { m.w.x = r2(pxToLen(m.pxX + dx, m.ux, m.refW)); m.w.y = r2(pxToLen(m.pxY + dy, m.uy, m.refH)); }
        placeAll(); drawAnchorCue();
        if (movers[0]) ctx.geomChanged && ctx.geomChanged(movers[0].w.id);
      },
      onSettle: () => ctx.requestSave(),
    });
    addResizeGrips(frame, {
      both: true, snap: true,
      // left-grip moves the left edge: addResizeGrips works in PX, so read/write px here (convert
      // to/from the field's unit). onResize's placeAll, which runs right after with the new width,
      // reconciles anchored positions. Don't placeAll here or it would reset the width
      // addResizeGrips just set, before onResize reads it.
      left: (v) => { const ref = refFor(widget.id, "x"); if (v === undefined) return lenToPx(widget.x ?? 0, unitOf(widget, "x"), ref); widget.x = r2(pxToLen(v, unitOf(widget, "x"), ref)); frame.style.left = `${v}px`; },
      onResize: () => {
        widget.w = r2(pxToLen(frame.offsetWidth, unitOf(widget, "w"), refFor(widget.id, "w")));
        widget.h = r2(pxToLen(frame.offsetHeight, unitOf(widget, "h"), refFor(widget.id, "h")));
        placeAll(); drawAnchorCue(); rec.inst.update && rec.inst.update();
        ctx.geomChanged && ctx.geomChanged(widget.id);
      },
      onSettle: () => ctx.requestSave(),
    });
  }

  return {
    updateAll() { for (const rec of recs.values()) try { rec.inst.update && rec.inst.update(); } catch { /* guard */ } },
    select(sel) {
      const ids = sel instanceof Set ? sel : sel ? new Set([sel]) : new Set();
      for (const rec of recs.values()) rec.frame.classList.toggle("pw-sel", ids.has(rec.widget.id));
    },
    placeAll,
    boxes: () => resolveBoxes(),   // resolved {left,top,w,h} per id — used for marquee hit-testing
    reanchor,
    showAnchorCue,
    // px nudge (WASD) -> back into each field's unit
    nudge(dx, dy, ids) {
      const set = ids instanceof Set ? ids : new Set(ids ? [].concat(ids) : []);
      for (const id of set) {
        const r = recs.get(id); if (!r) continue; const w = r.widget;
        const rx = refFor(id, "x"), ry = refFor(id, "y");
        w.x = r2(pxToLen(lenToPx(w.x ?? 0, unitOf(w, "x"), rx) + dx, unitOf(w, "x"), rx));
        w.y = r2(pxToLen(lenToPx(w.y ?? 0, unitOf(w, "y"), ry) + dy, unitOf(w, "y"), ry));
      }
      placeAll(); drawAnchorCue();
    },
    // inspector geom edits: set a value (in the field's current unit) and re-place
    setGeom(id, patch) {
      const rec = recs.get(id); if (!rec) return; const w = rec.widget;
      for (const k of ["x", "y", "w", "h"]) if (k in patch && Number.isFinite(patch[k])) w[k] = patch[k];
      placeAll(); drawAnchorCue();
      if (("w" in patch) || ("h" in patch)) { try { rec.inst.update && rec.inst.update(); } catch { /* */ } }
    },
    // change a field's unit, preserving its on-screen px so the widget doesn't jump
    setUnit(id, k, unit) {
      const rec = recs.get(id); if (!rec) return; const w = rec.widget;
      const ref = refFor(id, k);
      const def = k === "w" ? 200 : k === "h" ? 80 : 0;
      const curPx = lenToPx(w[k] ?? def, unitOf(w, k), ref);
      w.units = w.units || {}; w.units[k] = unit;
      w[k] = r2(pxToLen(curPx, unit, ref));
      placeAll(); drawAnchorCue();
    },
    geom(id) {
      const r = recs.get(id); if (!r) return null; const w = r.widget;
      return { x: w.x ?? 0, y: w.y ?? 0, w: w.w ?? 200, h: w.h ?? 80,
        units: { x: unitOf(w, "x"), y: unitOf(w, "y"), w: unitOf(w, "w"), h: unitOf(w, "h") } };
    },
    destroy() { ro && ro.disconnect(); for (const rec of recs.values()) { try { rec.inst.destroy && rec.inst.destroy(); } catch { /* */ } rec.condSub.destroy(); } recs.clear(); },
  };
}

export { GRID };
